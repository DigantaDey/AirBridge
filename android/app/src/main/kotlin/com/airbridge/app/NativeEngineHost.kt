package com.airbridge.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.airbridge.engine.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class PeerUiState(
    val peerId: String,
    val device: DeviceProfile,
    val discoveryScope: String,
    val connectedAt: Long,
    val sasCode: String?,
    val fingerprintHex: String?,
    val trusted: Boolean,
)

data class NativeEngineUiState(
    val ready: Boolean = false,
    val targetUrl: String = "",
    val deviceId: String = "",
    val myPeerId: String = "",
    val deviceName: String = "",
    val visibility: String = "nearby",
    val autoClipboard: Boolean = true,
    val receiveClipboard: Boolean = true,
    val pairCode: String = "",
    val formattedPairCode: String = "",
    val connectionState: ConnectionState = ConnectionState.DISCONNECTED,
    val connectionError: String? = null,
    /** Classified failure behind [connectionError], with its recovery action. */
    val connectionHelp: ConnectionDiagnosis? = null,
    /** Live progress while not connected, e.g. "Trying 10.205.95.167…". */
    val connectionProgress: String? = null,
    val lanUrls: List<String> = emptyList(),
    val peers: List<PeerUiState> = emptyList(),
    val transfers: List<TransferView> = emptyList(),
    val clipboardItems: List<ClipboardItem> = emptyList(),
    val trustedKeys: Set<String> = emptySet(),
)

/**
 * Service-owned native peer exposing immutable [StateFlow] updates and typed
 * commands directly to Jetpack Compose without WebView or JSON snapshotting.
 */
class NativeEngineHost(
    private val context: Context,
    private val onTransfers: (List<TransferView>) -> Unit,
    private val onOffer: (TransferView) -> Unit,
    private val onConnection: (ConnectionState) -> Unit,
    private val onState: (NativeEngineUiState) -> Unit = {},
) : AutoCloseable {
    private val prefs = Prefs(context)
    private val configuredTarget = prefs.target
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "airbridge-native-commands").apply { isDaemon = true }
    }
    private val stateLock = Any()
    @Volatile private var engine: AirBridgeEngine? = null
    @Volatile private var closed = false
    @Volatile private var connectionError: String? = null
    @Volatile private var connectionGuidance: ConnectionDiagnosis? = null
    @Volatile private var connectionProgress: String? = null

    private val _uiState = MutableStateFlow(
        NativeEngineUiState(
            ready = false,
            targetUrl = configuredTarget,
            deviceId = prefs.deviceId,
            myPeerId = prefs.peerId,
            deviceName = prefs.deviceName,
            visibility = prefs.visibility,
            autoClipboard = prefs.autoClipboard,
            receiveClipboard = prefs.receiveClipboard,
            pairCode = prefs.pairCode,
            formattedPairCode = PairCode.format(prefs.pairCode),
            connectionState = ConnectionState.CONNECTING,
        ),
    )
    val uiState: StateFlow<NativeEngineUiState> = _uiState.asStateFlow()

    private var lanUrls = emptyList<String>()
    private val clips = ArrayDeque<ClipboardItem>()
    private var clipBytes = 0
    private var lastSynced = ""
    private var lastSyncedAt = 0L

    private data class PendingClipboard(
        val text: String,
        val at: Long,
        val explicit: Boolean,
        val deliveredTo: MutableSet<String> = HashSet(),
    )

    private data class ClipboardCapture(
        val text: String,
        val explicit: Boolean,
        val at: Long = SystemClock.elapsedRealtime(),
    )

    private var pendingClipboard: PendingClipboard? = null

    private val snapshotWork = LatestTask<Unit>(worker) {
        if (!closed) {
            emitStateSnapshot()
            flushPendingClipboard()
        }
    }

    private val clipboardWork = LatestTask<ClipboardItem>(worker) { item ->
        // The OS clipboard is a latest value, not an unbounded log: drop superseded items.
        if (!closed && prefs.receiveClipboard) {
            try {
                val image = item.imageDataUrl
                if (image != null) {
                    ClipboardImageProvider.copyImage(context, image)
                } else {
                    ConnectionService.markOwnClipboardWrite(item.text)
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("AirBridge", item.text))
                }
                synchronized(stateLock) {
                    lastSynced = item.text
                    lastSyncedAt = SystemClock.elapsedRealtime()
                }
            } catch (e: Exception) {
                Log.w(TAG, "System clipboard write failed: ${e.message}")
            }
            addClip(item)
        }
    }

    private val captureWork = LatestTask<ClipboardCapture>(worker) { capture ->
        val text = capture.text
        if (!closed && (capture.explicit || prefs.autoClipboard) &&
            text.isNotBlank() && text.length <= Limits.MAX_CLIPBOARD_TEXT
        ) {
            val now = SystemClock.elapsedRealtime()
            val echo = synchronized(stateLock) {
                !capture.explicit && text == lastSynced && now - lastSyncedAt < 1_500
            }
            if (now - capture.at >= 60_000) return@LatestTask
            if (!echo) {
                synchronized(stateLock) { pendingClipboard = PendingClipboard(text, capture.at, capture.explicit) }
                flushPendingClipboard()
            }
        }
    }

    init {
        instance = this
        onState(_uiState.value)
        worker.execute {
            try {
                // connectWithLink stages the QR's code as pendingPairCode.
                // bootstrap() consumes it (exactly once) before falling back to
                // invitation/saved codes via PairingCodeBootstrap.resolve, so a
                // fresh scan always beats a stale persisted code.
                val plan = prefs.invitations.bootstrap() ?: return@execute
                val link = plan.link
                val targetPairCode = plan.pairCode
                val created = AirBridgeEngine(
                    EngineConfig(
                        serverUrl = link.wsUrl,
                        deviceName = prefs.deviceName,
                        model = Build.MODEL,
                        deviceId = prefs.deviceId,
                        peerId = prefs.peerId.ifEmpty { null },
                        initialPairCode = targetPairCode,
                        visibility = prefs.visibility,
                        tlsTrustManager = prefs.tlsTrust(link),
                        defaultSinkFactory = AndroidFileSinkFactory(context),
                        // Primary + QR alternates + addresses the computer
                        // reported last time; ranked on-link-first per attempt.
                        endpointHosts = { prefs.invitations.candidateHosts() },
                    ),
                )
                created.autoClipboardSend = prefs.autoClipboard
                created.clipboardReceiveEnabled = prefs.receiveClipboard
                prefs.trustedKeys.forEach { created.setTrusted(it, true) }
                engine = created
                created.addListener(
                    object : EngineListener {
                        override fun onConnectionState(state: ConnectionState) {
                            refresh()
                            onConnection(state)
                        }

                        override fun onWelcome(info: WelcomeInfo) {
                            if (closed) return
                            connectionError = null
                            connectionGuidance = null
                            connectionProgress = null
                            prefs.peerId = info.peerId
                            prefs.pairCode = info.pairCode
                            synchronized(stateLock) { lanUrls = info.lanUrls }
                            prefs.invitations.learn(info.lanUrls)
                            refresh()
                        }

                        override fun onConnectAttempt(hosts: List<String>) {
                            if (closed) return
                            connectionProgress = "Trying " + hosts.take(3).joinToString(", ") + "…"
                            Log.i(TAG, "Connecting to ${hosts.joinToString()}")
                            refresh()
                        }

                        override fun onEndpointConnected(host: String) {
                            if (closed) return
                            // Keep the previous failure until welcome arrives:
                            // transport-up alone is not "connected".
                            connectionProgress = "Reached $host, waiting for AirBridge on the computer…"
                            prefs.invitations.markConnected(host)
                            Log.i(TAG, "Connected via $host")
                            refresh()
                        }

                        override fun onLanUrlsChanged(lanUrls: List<String>) {
                            if (closed) return
                            synchronized(stateLock) { this@NativeEngineHost.lanUrls = lanUrls }
                            prefs.invitations.learn(lanUrls)
                            refresh()
                        }

                        override fun onConnectionFailure(diagnosis: ConnectionDiagnosis) {
                            if (closed) return
                            connectionError = diagnosis.userMessage
                            connectionGuidance = diagnosis
                            Log.w(TAG, "${diagnosis.kind}: ${diagnosis.detail}")
                            refresh()
                        }

                        override fun onPairCodeChanged(pairCode: String) {
                            if (closed) return
                            prefs.pairCode = pairCode
                            refresh()
                        }

                        override fun onPeersChanged(peers: List<Peer>) {
                            refresh()
                        }

                        override fun onIncomingOffer(transfer: TransferView) {
                            refresh()
                            onOffer(transfer)
                        }

                        override fun onTransferChanged(transfer: TransferView) {
                            refresh()
                            onTransfers(created.transfersSnapshot())
                        }

                        override fun onClipboard(item: ClipboardItem) {
                            clipboardWork.offer(item)
                        }

                        override fun onLocalClipboardBeam(item: ClipboardItem) = addClip(item)

                        override fun onNotification(item: NotificationItem) {
                            if (prefs.notificationSharing) {
                                ConnectionService.postSharedNotification(context, item.title, item.body, item.appName)
                            }
                        }

                        override fun onError(code: String, message: String) {
                            // Classified failures arrive via onConnectionFailure.
                            Log.w(TAG, "$code: $message")
                            refresh()
                        }
                    },
                )
                if (closed) {
                    created.stop()
                    return@execute
                }
                created.start()
                refresh()
            } catch (e: Exception) {
                connectionError = e.message ?: "Native engine startup failed"
                Log.e(TAG, "Native engine startup failed", e)
                refresh()
            }
        }
    }

    private fun addClip(item: ClipboardItem) {
        synchronized(stateLock) {
            if (clips.any { it.beamId == item.beamId }) return
            clips.addFirst(item)
            clipBytes += item.text.length + (item.imageDataUrl?.length ?: 0)
            while (clips.size > 30 || (clipBytes > 8_000_000 && clips.size > 1)) {
                val old = clips.removeLast()
                clipBytes -= old.text.length + (old.imageDataUrl?.length ?: 0)
            }
        }
        refresh()
    }

    fun broadcastNotificationBeam(title: String, body: String, appName: String? = null, packageName: String? = null) {
        if (closed || !prefs.notificationSharing) return
        worker.execute {
            engine?.broadcastNotificationBeam(title, body, appName, packageName)
        }
    }

    fun publishLocalClipboard(text: String, explicit: Boolean = false) {
        if (closed || (!explicit && !prefs.autoClipboard) || text.length > Limits.MAX_CLIPBOARD_TEXT) return
        captureWork.offer(ClipboardCapture(text, explicit))
    }

    private fun flushPendingClipboard() {
        val current = engine ?: return
        val pending = synchronized(stateLock) { pendingClipboard } ?: return
        if (SystemClock.elapsedRealtime() - pending.at > 60_000) {
            synchronized(stateLock) { pendingClipboard = null }
            return
        }
        if (!pending.explicit && !prefs.autoClipboard) {
            synchronized(stateLock) { pendingClipboard = null }
            return
        }
        val targets = current.peersSnapshot().filter { it.discoveryScope == "paired" }
        if (targets.isEmpty() || current.currentState != ConnectionState.CONNECTED) return
        for (peer in targets) {
            if (pending.deliveredTo.contains(peer.device.publicKey)) continue
            try {
                current.sendClipboardText(peer.peerId, pending.text)
                pending.deliveredTo.add(peer.device.publicKey)
            } catch (e: Exception) {
                Log.w(TAG, "Clipboard send deferred: ${e.message}")
            }
        }
        if (targets.all { pending.deliveredTo.contains(it.device.publicKey) }) {
            synchronized(stateLock) {
                lastSynced = pending.text
                lastSyncedAt = SystemClock.elapsedRealtime()
                if (pendingClipboard === pending) pendingClipboard = null
            }
        }
    }

    private fun refresh() {
        if (!closed) snapshotWork.offer(Unit)
    }

    private fun emitStateSnapshot() {
        val current = engine ?: return
        if (closed) return
        val trusted = current.trustedKeys()
        val peerViews = current.peersSnapshot().map { peer ->
            PeerUiState(
                peerId = peer.peerId,
                device = peer.device,
                discoveryScope = peer.discoveryScope,
                connectedAt = peer.connectedAt,
                sasCode = current.sasCodeFor(peer.peerId),
                fingerprintHex = current.fingerprintFor(peer.peerId),
                trusted = trusted.contains(peer.device.publicKey),
            )
        }
        val transfers = current.transfersSnapshot().sortedByDescending { it.startedAt }
        val clipSnapshot: List<ClipboardItem>
        val urlsSnapshot: List<String>
        synchronized(stateLock) {
            clipSnapshot = clips.toList()
            urlsSnapshot = lanUrls
        }
        val code = current.myPairCode
        val next = NativeEngineUiState(
            ready = true,
            targetUrl = configuredTarget,
            deviceId = prefs.deviceId,
            myPeerId = current.myPeerId,
            deviceName = prefs.deviceName,
            visibility = prefs.visibility,
            autoClipboard = prefs.autoClipboard,
            receiveClipboard = prefs.receiveClipboard,
            pairCode = code,
            formattedPairCode = PairCode.format(code),
            connectionState = current.currentState,
            connectionError = connectionError,
            connectionHelp = connectionGuidance,
            connectionProgress = connectionProgress,
            lanUrls = urlsSnapshot,
            peers = peerViews,
            transfers = transfers,
            clipboardItems = clipSnapshot,
            trustedKeys = trusted,
        )
        _uiState.value = next
        onState(next)
    }

    private fun <T> submitSync(block: (AirBridgeEngine) -> T): Result<T> {
        if (closed) return Result.failure(IllegalStateException("Native connection unavailable"))
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        return try {
            val future = worker.submit<Result<T>> {
                if (closed || System.nanoTime() >= deadline) {
                    return@submit Result.failure(IllegalStateException("Operation timed out; try again"))
                }
                val current = engine
                    ?: return@submit Result.failure(IllegalStateException("Native connection is starting. Try again."))
                try {
                    val value = block(current)
                    refresh()
                    Result.success(value)
                } catch (e: Exception) {
                    Result.failure(e)
                }
            }
            val remainingMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1L)
            future.get(remainingMs, TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            Result.failure(IllegalStateException(e.message ?: "Native operation failed", e))
        }
    }

    private fun postAsync(block: (AirBridgeEngine) -> Unit) {
        if (closed) return
        runCatching {
            worker.execute {
                val current = engine ?: return@execute
                if (closed) return@execute
                runCatching { block(current) }
                    .onFailure { Log.w(TAG, "Command failed: ${it.message}") }
                refresh()
            }
        }
    }

    fun acceptTransfer(transferId: String) = postAsync { it.acceptIncomingTransfer(transferId) }
    fun declineTransfer(transferId: String) = postAsync { it.declineIncomingTransfer(transferId) }
    fun cancelTransfer(transferId: String) = postAsync { it.cancelTransfer(transferId) }

    fun renameDevice(name: String) {
        val clean = name.trim().take(80).ifEmpty { return }
        prefs.deviceName = clean
        postAsync { it.updateDeviceName(clean) }
    }

    fun setVisibility(mode: String) {
        val normalized = Prefs.normalizeVisibility(mode)
        prefs.visibility = normalized
        postAsync { it.setVisibility(normalized) }
    }

    fun joinPairCode(code: String): Result<Unit> = submitSync { current ->
        require(current.joinPairCode(code)) { "Enter a valid 6-character pair code" }
    }

    fun rotatePairCode() = postAsync { it.rotatePairCode() }

    fun setTrusted(peerPublicKey: String, trusted: Boolean) = postAsync { current ->
        current.setTrusted(peerPublicKey, trusted)
        prefs.trustedKeys = current.trustedKeys()
    }

    fun setAutoClipboard(enabled: Boolean) {
        prefs.autoClipboard = enabled
        if (!enabled) synchronized(stateLock) { pendingClipboard = null }
        postAsync { it.autoClipboardSend = enabled }
    }

    fun setReceiveClipboard(enabled: Boolean) {
        prefs.receiveClipboard = enabled
        postAsync { it.clipboardReceiveEnabled = enabled }
    }

    fun clearClipboardHistory() {
        synchronized(stateLock) {
            clips.clear()
            clipBytes = 0
        }
        refresh()
    }

    fun sendClipboardText(peerId: String, text: String): Result<ClipboardItem> = submitSync { current ->
        current.sendClipboardText(peerId, text)
    }

    fun sendClipboardImageUri(peerId: String, uri: Uri): Result<ClipboardItem> = submitSync { current ->
        val dataUrl = NativeFiles.clipboardImageDataUrlFromUri(context, uri)
        current.sendClipboardImageDataUrl(peerId, dataUrl)
    }

    fun sendFiles(peerId: String, uris: List<Uri>): Result<TransferView> = submitSync { current ->
        require(uris.size in 1..Limits.MAX_FILES_PER_TRANSFER) { "Select 1–100 files" }
        val sources = uris.map { NativeFiles.openUriSource(context, it) }
        val transferId = current.sendFiles(peerId, sources)
        current.transferView(transferId)
            ?: throw IllegalStateException("Transfer failed to start")
    }

    fun reconnect() {
        engine?.reconnect()
    }

    override fun close() {
        closed = true
        if (instance === this) instance = null
        engine?.stop()
        worker.shutdownNow()
    }

    companion object {
        private const val TAG = "AirBridgeNative"
        @Volatile var instance: NativeEngineHost? = null
            private set
    }
}
