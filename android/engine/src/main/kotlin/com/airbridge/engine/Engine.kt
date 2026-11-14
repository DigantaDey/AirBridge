package com.airbridge.engine

import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

data class EngineConfig(
    /** ws://host:port/ws or wss://host:port/ws — /ws appended when missing. */
    val serverUrl: String,
    val deviceName: String,
    val model: String = "Android",
    val formFactor: String = "phone",
    val platform: String = "android",
    /** Persistent 16-hex device id (stable across restarts). */
    val deviceId: String? = null,
    /** Persistent 16-hex peer id for reconnect continuity. */
    val peerId: String? = null,
    val visibility: String = "nearby",
    val initialPairCode: String = "",
    val autoAcceptAll: Boolean = false,
    /** Explicit test-only escape hatch. Production uses platform trust or a pinned LAN CA. */
    val trustAllTls: Boolean = false,
    val tlsTrustManager: javax.net.ssl.X509TrustManager? = null,
    /** Where incoming files are staged when the UI accepts an offer. */
    val defaultSinkFactory: FileSinkFactory? = null,
)

private class TransferInterrupted(message: String) : java.io.IOException(message)

// Bind queued bytes to the socket that encrypted/queued them. A reconnect must
// never deliver old controls or chunks before the new connection's hello.
internal data class Outbound(val isText: Boolean, val payload: ByteArray, val connection: WebSocketClient? = null)

private data class IncomingWork(val bytes: Int, val run: () -> Unit)

internal class SendState(
    val session: TransferSession,
    val inputs: List<FileSource>,
    val peerPublicKey: String = "",
) {
    @Volatile var cancelled = false
    var acceptFuture: CompletableFuture<String> = CompletableFuture()
    var resumeFromChunks: Map<Int, Int> = emptyMap()
    val acknowledgedPrefixes = IntArray(session.files.size)
    val sentPrefixes = IntArray(session.files.size)
    var completion = CompletableFuture<Boolean>()
    var ackedGlobalChunks = 0
    var globalSentChunks = 0
    var bytesSent = 0L
    var lastSpeedTs = System.currentTimeMillis()
    var lastSpeedBytes = 0L
    var lastAckNanos = System.nanoTime()
    var connection: WebSocketClient? = null
}

internal class RecvState(
    val session: TransferSession,
    val sinks: Map<Int, FileSink>,
) {
    val declaredSha = HashMap<Int, String?>()
    val fileCompleteSignals = HashSet<Int>()
    val finalizedFiles = HashSet<Int>()
    var transferCompleteReceived = false
    var forceFallbackScheduled = false
    val contiguousChunks = IntArray(session.files.size)
    val lastAckedChunks = IntArray(session.files.size)
    val lastAckNanos = LongArray(session.files.size)
    val chunkReceived: Array<BooleanArray> =
        session.files.map { BooleanArray(it.totalChunks) }.toTypedArray()
    val fileReceivedCount = IntArray(session.files.size)
    var bytesReceived = 0L
    var lastSpeedTs = System.currentTimeMillis()
    var lastSpeedBytes = 0L
}

/** Mutable engine-side transfer record; UI consumes immutable [toView] snapshots. */
class TransferSession internal constructor(
    val transferId: String,
    val peerId: String,
    val peerDeviceId: String?,
    val peerName: String,
    val peerPlatform: String,
    val sasCode: String,
    val direction: TransferDirection,
    var status: String,
    val files: List<FileManifestItem>,
    val totalBytes: Long,
    var startedAt: Long,
) {
    var transferredBytes: Long = 0
    var speedBytesPerSec: Double = 0.0
    var etaSeconds: Long? = null
    var completedAt: Long? = null
    var errorMessage: String? = null
    val receivedFiles: MutableList<ReceivedFileInfo> = mutableListOf()
    var transport: String = "ws-relay"

    internal fun toView(): TransferView = TransferView(
        transferId = transferId,
        peerId = peerId,
        peerName = peerName,
        peerPlatform = peerPlatform,
        sasCode = sasCode,
        direction = direction,
        status = status,
        transport = transport,
        files = files,
        totalBytes = totalBytes,
        transferredBytes = transferredBytes,
        speedBytesPerSec = speedBytesPerSec,
        etaSeconds = etaSeconds,
        startedAt = startedAt,
        completedAt = completedAt,
        receivedFiles = receivedFiles.toList(),
        errorMessage = errorMessage,
    )
}

/**
 * Native AirBridge protocol engine.
 *
 * Wire-compatible with the TypeScript WarpClient: same hello/welcome
 * handshake, ECDH P-256 + HKDF + AES-256-GCM control envelopes, 0x01/0x02
 * binary framing, offer/accept/ACK choreography, resume hints, clipboard
 * beams and history sync. Transport is WebSocket relay only (no WebRTC) —
 * on a LAN the relay runs on the receiver's own machine.
 */
class AirBridgeEngine(private val config: EngineConfig) {

    private val lock = java.lang.Object()
    private val identity = AirCrypto.generateIdentityKeyPair()
    private val listeners = CopyOnWriteArraySet<EngineListener>()

    private var deviceName: String = sanitizeName(config.deviceName)
    private var visibility: String = config.visibility
    private var peerId: String = config.peerId ?: AirCrypto.randomHex16()
    private var pairCode: String = config.initialPairCode
    private val deviceId: String = config.deviceId ?: AirCrypto.randomHex16()

    private val peers = LinkedHashMap<String, Peer>()
    private val sessions = HashMap<String, PeerCryptoSession>()
    private val sessionKeyFingerprints = HashMap<String, String>()
    private val transfers = LinkedHashMap<String, TransferSession>()
    private val outgoing = HashMap<String, SendState>()
    private val incoming = HashMap<String, RecvState>()
    private val acceptedTransferKeys = HashMap<String, String>()
    private val resumeCompletedFiles = HashMap<String, List<ReceivedFileInfo>>()
    private val trustedPeerKeys = Collections.synchronizedSet(HashSet<String>())
    private val history = ArrayDeque<JsonValue.Obj>()
    private val seenBeamIds = LinkedHashSet<String>()
    private var lastIncomingClip: Pair<String, String>? = null // (dedupKey, unused-ts-holder)
    private var lastIncomingClipTs = 0L
    @Volatile var autoClipboardSend = true
    @Volatile var clipboardReceiveEnabled = true

    @Volatile
    private var connectionState = ConnectionState.DISCONNECTED
    private val stopped = AtomicBoolean(false)
    private val started = AtomicBoolean(false)

    @Volatile private var ws: WebSocketClient? = null
    private val outbound = OutboundQueue()
    // Overlap socket/TLS reads with decryption + disk IO without an unbounded
    // executor. All application messages still execute in wire order; RFC 6455
    // ping/pong is handled by the reader, not by a busy storage worker.
    private val inbound = ByteBoundedQueue<IncomingWork>(4 * 1024 * 1024) { it.bytes }
    private var inboundThread: Thread? = null
    private val cleanupExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "airbridge-storage-cleanup").apply { isDaemon = true }
    }
    private val receiveCleanup = HashSet<String>()
    private val finalizing = HashSet<String>()
    private val finalizationRequests = HashMap<String, Boolean>()
    private val finalizeExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "airbridge-finalizer").apply { isDaemon = true }
    }
    private val sendExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "airbridge-sender").apply { isDaemon = true }
    }
    private val timerExecutor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "airbridge-timer").apply { isDaemon = true }
        }
    private var connectionThread: Thread? = null
    private var pumpThread: Thread? = null

    // =========================================================================
    // Listeners & snapshots
    // =========================================================================

    fun addListener(l: EngineListener) { listeners.add(l) }
    fun removeListener(l: EngineListener) { listeners.remove(l) }

    val myPeerId: String get() = synchronized(lock) { peerId }
    val myPairCode: String get() = synchronized(lock) { pairCode }
    val myPublicKeyB64: String get() = identity.publicKeyB64
    fun deviceProfileSnapshot(): DeviceProfile = synchronized(lock) { currentDeviceProfile() }
    fun reconnect() { runCatching { ws?.close() } }
    val currentState: ConnectionState get() = connectionState

    fun peersSnapshot(): List<Peer> = synchronized(lock) { peers.values.toList() }

    fun transfersSnapshot(): List<TransferView> = synchronized(lock) {
        transfers.values.map { it.toView() }
    }

    fun transferView(transferId: String): TransferView? = synchronized(lock) {
        transfers[transferId]?.toView()
    }

    fun sasCodeFor(peerId: String): String? = synchronized(lock) {
        sessions[peerId]?.sasCode
    }

    fun fingerprintFor(peerId: String): String? = synchronized(lock) {
        sessions[peerId]?.fingerprintHex
    }

    fun trustedKeys(): Set<String> = synchronized(lock) { trustedPeerKeys.toSet() }

    private fun emitState(state: ConnectionState) {
        for (l in listeners) l.onConnectionState(state)
    }

    private fun emitTransfer(view: TransferView) {
        for (l in listeners) l.onTransferChanged(view)
    }

    private fun emitPeers(list: List<Peer>) {
        for (l in listeners) l.onPeersChanged(list)
    }

    private fun emitOffer(view: TransferView) {
        for (l in listeners) l.onIncomingOffer(view)
    }

    private fun emitClipboard(item: ClipboardItem) {
        for (l in listeners) l.onClipboard(item)
    }

    private fun emitError(code: String, message: String) {
        for (l in listeners) l.onError(code, message)
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    fun start() {
        if (stopped.get() || !started.compareAndSet(false, true)) return
        setConnectionState(ConnectionState.CONNECTING)
        inboundThread = Thread({
            try {
                while (!stopped.get()) {
                    val work = inbound.take() ?: break
                    try { work.run() }
                    catch (e: Exception) { if (!stopped.get()) emitError("BAD_MESSAGE", e.message ?: "Bad message") }
                }
            } catch (_: InterruptedException) {}
        }, "airbridge-receiver").apply { isDaemon = true; start() }
        connectionThread = Thread({ connectionLoop() }, "airbridge-connection").apply {
            isDaemon = true
            start()
        }
        pumpThread = Thread({ outboundPump() }, "airbridge-writer").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        outbound.close()
        inbound.close()
        try { ws?.close() } catch (_: Exception) {}
        ws = null
        val pausedSinks: List<FileSink>
        synchronized(lock) {
            for (send in outgoing.values) {
                send.cancelled = true
                send.acceptFuture.completeExceptionally(java.io.IOException("Engine stopped"))
                send.completion.completeExceptionally(java.io.IOException("Engine stopped"))
            }
            outgoing.clear()
            pausedSinks = incoming.values.flatMap { it.sinks.values }
            incoming.clear()
            lock.notifyAll()
        }
        sendExecutor.shutdownNow()
        finalizeExecutor.shutdownNow()
        timerExecutor.shutdownNow()
        // File publication can be slow. Cleanup never holds the engine monitor.
        try { cleanupExecutor.execute { pausedSinks.forEach { runCatching { it.pause() } } } }
        catch (_: java.util.concurrent.RejectedExecutionException) {}
        cleanupExecutor.shutdown()
        inboundThread?.interrupt()
        connectionThread?.interrupt()
        pumpThread?.interrupt()
        setConnectionState(ConnectionState.DISCONNECTED)
    }

    private fun setConnectionState(next: ConnectionState) {
        if (connectionState == next) return
        connectionState = next
        emitState(next)
    }

    private fun connectionLoop() {
        var attempt = 0
        while (!stopped.get()) {
            val client = WebSocketClient(
                normalizeWsUrl(config.serverUrl),
                object : WebSocketClient.Listener {
                    override fun onText(text: String) {
                        inbound.put(IncomingWork(text.length * 2) { handleServerJson(text) })
                    }
                    override fun onBinary(bytes: ByteArray) {
                        inbound.put(IncomingWork(bytes.size) { handleBinaryFrame(bytes) })
                    }
                    override fun onClosed(reason: String) {}
                },
                trustAllTls = config.trustAllTls,
                tlsTrustManager = config.tlsTrustManager,
            )
            try {
                // Keep the connecting socket reachable so stop() also cancels
                // DNS/connect/upgrade work instead of leaking a late socket.
                ws = client
                client.connectBlocking()
                if (stopped.get()) break
                sendHello(client)
                attempt = 0
                client.readLoop()
            } catch (e: Exception) {
                if (stopped.get()) break
                emitError("CONNECTION_FAILED", e.message ?: "Connection failed")
            } finally {
                runCatching { client.close() }
                if (ws === client) ws = null
                outbound.clear()
                if (!stopped.get()) {
                    // Disconnect is an ordered barrier: finish already-read disk
                    // writes before checkpointing or processing the next welcome.
                    val drained = CompletableFuture<Unit>()
                    try {
                        inbound.put(IncomingWork(0) {
                            try { onDisconnect() } finally { drained.complete(Unit) }
                        })
                        drained.get()
                    } catch (_: Exception) { if (!stopped.get()) break }
                }
            }
            if (stopped.get()) break
            setConnectionState(ConnectionState.RECONNECTING)
            try { Thread.sleep(reconnectDelayMs(++attempt)) }
            catch (_: InterruptedException) { break }
        }
        setConnectionState(ConnectionState.DISCONNECTED)
    }

    private fun reconnectDelayMs(attempt: Int): Long =
        if (attempt <= 1) 1500L else minOf(10_000L, 1500L * attempt)

    private fun normalizeWsUrl(url: String): String {
        var u = url.trim()
        if (!u.contains("://")) u = "wss://$u"
        u = u.removeSuffix("/")
        return if (u.endsWith("/ws")) u else "$u/ws"
    }

    private fun outboundPump() {
        try {
            while (!stopped.get()) {
                val item = outbound.take() ?: return
                if (stopped.get()) return
                val target = item.connection ?: continue
                if (ws !== target || !target.isOpen) continue
                try {
                    if (item.isText) target.sendText(String(item.payload, Charsets.UTF_8))
                    else target.sendBinary(item.payload)
                } catch (e: Exception) {
                    // Force a blocked reader awake and reconnect after a failed write.
                    runCatching { target.close() }
                }
            }
        } catch (_: InterruptedException) {
        }
    }

    private fun sendHello(client: WebSocketClient) {
        val hello: JsonValue.Obj
        synchronized(lock) {
            hello = JsonValue.Obj()
                .put("type", "hello")
                .put("peerId", peerId)
                .put("device", currentDeviceProfile().toJson())
                .put("visibility", visibility)
            if (pairCode.isNotEmpty()) hello.put("pairCode", pairCode)
        }
        // Bypass the queue: hello must hit the wire before any readLoop output.
        client.sendText(hello.toJsonString())
    }

    private fun currentDeviceProfile(): DeviceProfile = DeviceProfile(
        name = deviceName,
        platform = config.platform,
        model = config.model,
        formFactor = config.formFactor,
        publicKey = identity.publicKeyB64,
        deviceId = deviceId,
    )

    private fun sanitizeName(raw: String): String {
        val clean = raw.map { c -> if (c.code in 0..0x1f || c.code == 0x7f) ' ' else c }
            .joinToString("")
            .trim()
            .take(80)
        return clean.ifEmpty { "AirBridge Device" }
    }

    private fun onDisconnect() {
        val changed = mutableListOf<TransferView>()
        val receives: List<RecvState>
        synchronized(lock) {
            peers.clear()
            sessions.clear()
            sessionKeyFingerprints.clear()
            for (send in outgoing.values) {
                val error = TransferInterrupted("Connection lost; resuming transfer")
                send.acceptFuture.completeExceptionally(error)
                send.completion.completeExceptionally(error)
                send.session.status = TransferStatus.CONNECTING
                send.session.speedBytesPerSec = 0.0
                send.session.etaSeconds = null
                changed.add(send.session.toView())
            }
            receives = incoming.values.toList()
            incoming.clear()
            for (t in transfers.values) {
                if (!isTerminal(t.status) && !outgoing.containsKey(t.transferId)) {
                    t.status = TransferStatus.ERROR
                    t.speedBytesPerSec = 0.0
                    t.errorMessage = "Connection lost. Retry the transfer to reconnect."
                    t.completedAt = System.currentTimeMillis()
                    changed.add(t.toView())
                }
            }
            changed.filter { isTerminal(it.status) }.forEach { persistHistoryLocked(it.transferId) }
            lock.notifyAll()
        }
        // A finalizer may still be publishing. Do not hold the engine monitor
        // while waiting for its sink to flush/close.
        receives.forEach { releaseReceive(it, discard = false) }
        emitPeers(emptyList())
        for (view in changed) emitTransfer(view)
    }

    private fun releaseReceive(recv: RecvState, discard: Boolean) {
        val id = recv.session.transferId
        synchronized(lock) { receiveCleanup.add(id) }
        try {
            cleanupExecutor.execute {
                try { recv.sinks.values.forEach { sink -> runCatching { if (discard) sink.discard() else sink.pause() } } }
                finally { synchronized(lock) { receiveCleanup.remove(id); lock.notifyAll() } }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            synchronized(lock) { receiveCleanup.remove(id) }
        }
    }

    private fun isTerminal(status: String): Boolean = status in setOf(
        TransferStatus.COMPLETED, TransferStatus.ERROR, TransferStatus.CANCELLED, TransferStatus.DECLINED,
    )

    // =========================================================================
    // Outbound JSON / control helpers
    // =========================================================================

    private fun sendServer(obj: JsonValue.Obj, connection: WebSocketClient? = ws) {
        val target = connection?.takeIf { ws === it && !stopped.get() && connectionState == ConnectionState.CONNECTED && it.isOpen }
            ?: throw TransferInterrupted("Connection unavailable; resuming transfer")
        val text = obj.toJsonString()
        outbound.put(Outbound(true, text.toByteArray(Charsets.UTF_8), target))
    }

    private fun sendEncryptedControl(to: String, payload: JsonValue.Obj) {
        val connection = ws
        val peerSession = synchronized(lock) {
            val peer = peers[to] ?: throw TransferInterrupted("No encryption session for $to")
            val id = payload.optStr("transferId")
            val boundKey = outgoing[id]?.peerPublicKey ?: acceptedTransferKeys[id]
            if (boundKey != null && boundKey != peer.device.publicKey) throw TransferInterrupted("Transfer peer identity changed")
            ensureSessionLocked(peer)
        }
        val env = AirCrypto.encryptControlPayload(
            peerSession.aesKey,
            payload.toJsonString().toByteArray(Charsets.UTF_8),
        )
        if (synchronized(lock) { sessions[to] !== peerSession || ws !== connection }) {
            throw TransferInterrupted("Connection or peer identity changed while encrypting control")
        }
        val envelope = JsonValue.Obj()
            .put("encrypted", true)
            .put("iv", Base64Url.encode(env.iv))
            .put("ciphertext", Base64Url.encode(env.ciphertext))
        sendServer(
            JsonValue.Obj()
                .put("type", "transfer-control")
                .put("to", to)
                .put("envelope", envelope),
            connection,
        )
    }

    private fun sendPlaintextControl(to: String, payload: JsonValue.Obj) {
        val envelope = JsonValue.Obj()
            .put("encrypted", false)
            .put("payload", payload)
        sendServer(
            JsonValue.Obj()
                .put("type", "transfer-control")
                .put("to", to)
                .put("envelope", envelope),
        )
    }

    // =========================================================================
    // Server message handling
    // =========================================================================

    private fun handleServerJson(text: String) {
        val msg = try {
            JsonValue.parseObject(text)
        } catch (_: Exception) {
            return
        }
        when (msg.optStr("type")) {
            "welcome" -> {
                val id = msg.optStr("peerId") ?: return
                val code = msg.optStr("pairCode") ?: ""
                val lanUrls = msg.optArr("lanUrls")?.items
                    ?.mapNotNull { it.asStringOrNull() } ?: emptyList()
                synchronized(lock) {
                    peerId = id
                    pairCode = code
                }
                for (l in listeners) l.onWelcome(WelcomeInfo(id, code, lanUrls))
                for (l in listeners) l.onPairCodeChanged(code)
                setConnectionState(ConnectionState.CONNECTED)
                applyPeers(msg.optArr("peers"))
            }
            "pair-updated" -> {
                val code = msg.optStr("pairCode") ?: return
                synchronized(lock) { pairCode = code }
                for (l in listeners) l.onPairCodeChanged(code)
                applyPeers(msg.optArr("peers"))
            }
            "peers" -> applyPeers(msg.optArr("peers"))
            "transfer-control" -> {
                val from = msg.optStr("from") ?: return
                val envelope = msg.optObj("envelope") ?: return
                handleIncomingControl(from, envelope)
            }
            "error" -> emitError(msg.optStr("code") ?: "ERROR", msg.optStr("message") ?: "")
            "rtc-signal" -> { /* relay-only engine */ }
        }
    }

    private fun applyPeers(arr: JsonValue.JsonArr?) {
        val next = mutableListOf<Peer>()
        if (arr != null) {
            for (item in arr.items) {
                val o = item as? JsonValue.Obj ?: continue
                val id = o.optStr("peerId") ?: continue
                val deviceO = o.optObj("device") ?: continue
                val device = DeviceProfile.fromJson(deviceO)
                if (device.publicKey.isEmpty()) continue
                next.add(
                    Peer(
                        peerId = id,
                        device = device,
                        discoveryScope = o.optStr("discoveryScope") ?: "nearby",
                        connectedAt = o.optLong("connectedAt") ?: 0L,
                    ),
                )
            }
        }
        val refreshed = mutableListOf<Peer>()
        synchronized(lock) {
            peers.clear()
            for (p in next) peers[p.peerId] = p
            sessions.keys.retainAll(peers.keys)
            sessionKeyFingerprints.keys.retainAll(peers.keys)
            for (send in outgoing.values) {
                if (peers[send.session.peerId]?.device?.publicKey != send.peerPublicKey) {
                    val error = TransferInterrupted("Receiver disconnected; resuming transfer")
                    send.acceptFuture.completeExceptionally(error)
                    send.completion.completeExceptionally(error)
                }
            }
            lock.notifyAll()
            // Eagerly derive sessions so SAS codes show immediately (matches TS).
            for (p in next) {
                try {
                    ensureSessionLocked(p)
                } catch (e: Exception) {
                    System.err.println("airbridge: session derive failed for ${p.peerId}: $e")
                }
            }
            refreshed.addAll(peers.values)
        }
        emitPeers(refreshed)
        // Post-lock side effects: liveness ping + history reconciliation.
        for (p in refreshed) {
            sendPlaintextControl(
                p.peerId,
                JsonValue.Obj().put("kind", "ping").put("ts", System.currentTimeMillis()),
            )
            sendHistorySync(p.peerId)
        }
    }

    private fun ensureSessionLocked(peer: Peer): PeerCryptoSession {
        val existingFp = sessionKeyFingerprints[peer.peerId]
        val existing = sessions[peer.peerId]
        if (existing != null && existingFp == peer.device.publicKey) return existing
        val session = AirCrypto.derivePeerSession(
            identity.privateKey,
            identity.publicKeyB64,
            peer.device.publicKey,
        )
        sessions[peer.peerId] = session
        sessionKeyFingerprints[peer.peerId] = peer.device.publicKey
        return session
    }

    private fun sessionFor(peerId: String): PeerCryptoSession? = synchronized(lock) {
        peers[peerId]?.let { ensureSessionLocked(it) }
    }

    // =========================================================================
    // Incoming control payloads
    // =========================================================================

    private fun handleIncomingControl(fromPeerId: String, envelope: JsonValue.Obj) {
        val payload: JsonValue.Obj = try {
            if (envelope.optBool("encrypted") == true) {
                val session = sessionFor(fromPeerId) ?: return
                val iv = Base64Url.decode(envelope.optStr("iv") ?: return)
                val ct = Base64Url.decode(envelope.optStr("ciphertext") ?: return)
                val plain = AirCrypto.decryptControlPayload(session.aesKey, iv, ct)
                JsonValue.parseObject(String(plain, Charsets.UTF_8))
            } else {
                val raw = envelope.optObj("payload") ?: return
                // SECURITY: only unauthenticated ping/pong may travel in plaintext.
                val kind = raw.optStr("kind")
                if (kind != "ping" && kind != "pong") return
                raw
            }
        } catch (_: Exception) {
            return
        }

        synchronized(lock) {
            val id = payload.optStr("transferId")
            val key = peers[fromPeerId]?.device?.publicKey
            if (id != null) {
                val send = outgoing[id]
                if (send != null && (send.session.peerId != fromPeerId || send.peerPublicKey != key)) return
                if (acceptedTransferKeys.containsKey(id) && acceptedTransferKeys[id] != key) return
            }
        }
        when (payload.optStr("kind")) {
            "ping" -> sendPlaintextControl(
                fromPeerId,
                JsonValue.Obj().put("kind", "pong").put("ts", payload.optLong("ts") ?: 0L),
            )
            "pong" -> { /* RTT display not part of the native UI yet */ }
            "clipboard-beam" -> handleClipboardBeam(fromPeerId, payload)
            "history-sync" -> handleHistorySync(fromPeerId, payload)
            "transfer-offer" -> handleTransferOffer(fromPeerId, payload)
            "transfer-accept" -> handleTransferAccept(fromPeerId, payload)
            "transfer-decline" -> handleTransferDecline(fromPeerId, payload)
            "transfer-cancel" -> handleTransferCancel(fromPeerId, payload)
            "chunk-ack" -> handleChunkAck(fromPeerId, payload)
            "file-complete" -> handleFileComplete(fromPeerId, payload)
            "transfer-complete" -> handleTransferComplete(fromPeerId, payload)
            "transfer-complete-ack" -> synchronized(lock) {
                outgoing[payload.optStr("transferId")]?.takeIf { it.session.peerId == fromPeerId }
                    ?.completion?.complete(payload.optBool("verified") == true)
            }
        }
    }

    private fun handleClipboardBeam(fromPeerId: String, payload: JsonValue.Obj) {
        if (!clipboardReceiveEnabled) return
        val beamId = payload.optStr("beamId") ?: return
        val text = payload.optStr("text") ?: ""
        val imageDataUrl = payload.optStr("imageDataUrl") ?: ""
        val hasText = text.trim().isNotEmpty()
        val hasImage = isValidClipboardImageDataUrl(imageDataUrl)
        if (!hasText && !hasImage) return
        if (hasText && text.length > Limits.MAX_CLIPBOARD_TEXT) return
        if (hasImage && imageDataUrl.length > Limits.MAX_CLIPBOARD_IMAGE_DATAURL) return

        val dedupKey = if (hasImage) AirCrypto.sha256Hex(imageDataUrl.toByteArray(Charsets.UTF_8))
        else text
        val peer: Peer?
        val session: PeerCryptoSession?
        synchronized(lock) {
            if (seenBeamIds.contains(beamId)) return
            val now = System.currentTimeMillis()
            if (lastIncomingClip != null && lastIncomingClip!!.first == dedupKey &&
                lastIncomingClip!!.second == fromPeerId && now - lastIncomingClipTs < 1_500
            ) return
            seenBeamIds.add(beamId)
            while (seenBeamIds.size > 200) {
                val it = seenBeamIds.iterator()
                it.next()
                it.remove()
            }
            lastIncomingClip = Pair(dedupKey, fromPeerId)
            lastIncomingClipTs = now
            peer = peers[fromPeerId]
            session = sessions[fromPeerId]
        }

        val isImage = hasImage || payload.optStr("contentType") == "image"
        val item = ClipboardItem(
            beamId = beamId,
            peerId = fromPeerId,
            peerName = peer?.device?.name ?: "Paired Device",
            direction = "incoming",
            text = if (hasText) text else imageDataUrl,
            imageDataUrl = if (hasImage) imageDataUrl else null,
            imageName = payload.optStr("imageName"),
            contentType = if (isImage) "image" else (payload.optStr("contentType") ?: "text"),
            timestamp = payload.optLong("timestamp") ?: System.currentTimeMillis(),
            sasCode = session?.sasCode ?: "··· ···",
        )
        emitClipboard(item)
    }

    // -------------------------------------------------------------------------
    // Transfer offer / accept / decline / cancel
    // -------------------------------------------------------------------------

    private fun handleTransferOffer(fromPeerId: String, payload: JsonValue.Obj) {
        val transferId = payload.optStr("transferId") ?: return
        if (!Regex("^[0-9a-f]{16}$").matches(transferId)) return
        if (!isValidFileManifest(payload.optArr("files"), payload.optLong("totalBytes"))) return

        val files = payload.optArr("files")!!.items.map {
            FileManifestItem.fromJson(it.asObj())
        }
        val peer = synchronized(lock) { peers[fromPeerId] } ?: return
        val previous = synchronized(lock) { transfers[transferId] }
        if (previous != null) {
            // Retries must bind to the same encrypted peer key and exact
            // manifest; a nearby device cannot steal a transfer's consent.
            val sameConsent = synchronized(lock) { acceptedTransferKeys[transferId] == peer.device.publicKey }
            if (!sameConsent || previous.direction != TransferDirection.INCOMING || previous.files != files ||
                previous.totalBytes != payload.optLong("totalBytes")) return
            if (previous.status == TransferStatus.COMPLETED || previous.status == TransferStatus.TRANSFERRING) {
                val resume = JsonValue.Obj()
                synchronized(lock) {
                    for (file in files) {
                        val prefix = if (previous.status == TransferStatus.COMPLETED) file.totalChunks
                            else incoming[transferId]?.contiguousChunks?.get(file.index) ?: 0
                        if (prefix > 0) resume.put(file.index.toString(), prefix)
                    }
                }
                sendEncryptedControl(fromPeerId, JsonValue.Obj().put("kind", "transfer-accept")
                    .put("transferId", transferId).put("preferredTransport", "ws-relay").put("resumeFromChunks", resume))
                return
            }
            if (previous.status != TransferStatus.ERROR || previous.errorMessage?.startsWith("Connection lost") != true) return
            // Let any in-progress publication release its staging descriptor
            // before reopening the same journal for a network retry.
            if (synchronized(lock) { finalizing.contains(transferId) || receiveCleanup.contains(transferId) }) {
                timerExecutor.schedule({ handleTransferOffer(fromPeerId, payload) }, 500, TimeUnit.MILLISECONDS)
                return
            }
            synchronized(lock) { resumeCompletedFiles[transferId] = previous.receivedFiles.toList() }
        }
        if (synchronized(lock) { transfers.values.count { !isTerminal(it.status) } } >= 16) {
            sendEncryptedControl(fromPeerId, JsonValue.Obj().put("kind", "transfer-decline")
                .put("transferId", transferId).put("reason", "Too many active transfers"))
            return
        }
        var view: TransferView? = null
        var trusted = false
        synchronized(lock) {
            val crypto = sessions[fromPeerId]
            val ts = TransferSession(
                transferId = transferId,
                peerId = fromPeerId,
                peerDeviceId = peer?.device?.deviceId,
                peerName = peer?.device?.name ?: "Nearby Device",
                peerPlatform = peer?.device?.platform ?: "unknown",
                sasCode = crypto?.sasCode ?: "\u00b7\u00b7 \u00b7\u00b7 \u00b7\u00b7",
                direction = TransferDirection.INCOMING,
                status = TransferStatus.PENDING_ACCEPT,
                files = files,
                totalBytes = payload.optLong("totalBytes") ?: 0L,
                startedAt = System.currentTimeMillis(),
            )
            transfers[transferId] = ts
            acceptedTransferKeys[transferId] = peer.device.publicKey
            view = ts.toView()
            trusted = previous != null || config.autoAcceptAll || trustedPeerKeys.contains(peer.device.publicKey)
        }
        val offerView = view ?: return
        emitOffer(offerView)

        if (trusted) {
            try { acceptIncomingTransfer(transferId, null) }
            catch (e: Exception) { emitError("AUTO_ACCEPT_FAILED", e.message ?: "auto-accept failed") }
        }
    }

    /**
     * Accept an incoming offer. Sinks are opened per file (streaming,
     * resumable); the accept frame carries per-file resume hints exactly like
     * the web client.
     */
    fun acceptIncomingTransfer(transferId: String, factoryOverride: FileSinkFactory? = null) {
        val factory = factoryOverride ?: config.defaultSinkFactory
        if (factory == null) {
            emitError("NO_SINK", "No receive storage configured for $transferId")
            return
        }
        val session = synchronized(lock) {
            val current = transfers[transferId] ?: return
            if (current.direction != TransferDirection.INCOMING || current.status != TransferStatus.PENDING_ACCEPT) return
            current.status = TransferStatus.CONNECTING
            current
        }
        emitTransfer(synchronized(lock) { session.toView() })
        val sinks = HashMap<Int, FileSink>()
        val resume = HashMap<Int, Int>()
        val recv: RecvState
        try {
            val receipts = synchronized(lock) { resumeCompletedFiles[transferId].orEmpty() }
            for (meta in session.files) {
                val completed = receipts.firstOrNull { it.index == meta.index && it.verified }
                sinks[meta.index] = if (completed == null) factory.open(transferId, meta) else CompletedFileSink(completed, meta)
            }
            recv = RecvState(session, sinks)
            for (meta in session.files) {
                val sink = sinks.getValue(meta.index)
                val bits = recv.chunkReceived[meta.index]
                for (i in bits.indices) if (sink.hasReceived(i)) {
                    bits[i] = true
                    recv.fileReceivedCount[meta.index]++
                    recv.bytesReceived += minOf(meta.chunkSize.toLong(), maxOf(0L, meta.size - i * meta.chunkSize.toLong()))
                }
                val prefix = sink.resumeFrom()
                recv.contiguousChunks[meta.index] = prefix
                recv.lastAckedChunks[meta.index] = prefix
                if (prefix > 0) resume[meta.index] = prefix
            }
        } catch (e: Exception) {
            sinks.values.forEach { runCatching { it.pause() } }
            val view = synchronized(lock) {
                if (session.status != TransferStatus.CONNECTING) return
                session.status = TransferStatus.ERROR
                session.errorMessage = e.message ?: "Cannot open receive storage"
                session.completedAt = System.currentTimeMillis()
                persistHistoryLocked(transferId)
                session.toView()
            }
            emitTransfer(view)
            sendEncryptedControl(session.peerId, JsonValue.Obj().put("kind", "transfer-decline")
                .put("transferId", transferId).put("reason", view.errorMessage ?: "Storage unavailable"))
            return
        }
        val accepted = synchronized(lock) {
            if (session.status != TransferStatus.CONNECTING || stopped.get() || ws?.isOpen != true ||
                peers[session.peerId]?.device?.publicKey != acceptedTransferKeys[transferId]) false
            else {
                incoming[transferId] = recv
                resumeCompletedFiles.remove(transferId)
                session.status = TransferStatus.TRANSFERRING
                session.startedAt = System.currentTimeMillis()
                session.transferredBytes = recv.bytesReceived
                recv.lastSpeedBytes = recv.bytesReceived
                true
            }
        }
        if (!accepted) { releaseReceive(recv, discard = session.status == TransferStatus.CANCELLED); return }
        emitTransfer(synchronized(lock) { session.toView() })
        val accept = JsonValue.Obj().put("kind", "transfer-accept").put("transferId", transferId)
            .put("preferredTransport", "ws-relay").put("resumeBytesTotal", recv.bytesReceived)
        if (resume.isNotEmpty()) {
            val map = JsonValue.Obj()
            for ((k, v) in resume) map.put(k.toString(), v)
            accept.put("resumeFromChunks", map)
        }
        sendEncryptedControl(session.peerId, accept)
    }

    fun declineIncomingTransfer(transferId: String) {
        var view: TransferView? = null
        var peerId: String? = null
        synchronized(lock) {
            val session = transfers[transferId] ?: return
            if (session.status != TransferStatus.PENDING_ACCEPT) return
            session.status = TransferStatus.DECLINED
            session.completedAt = System.currentTimeMillis()
            peerId = session.peerId
            incoming.remove(transferId)
            persistHistoryLocked(transferId)
            view = session.toView()
        }
        view?.let { emitTransfer(it) }
        peerId?.let {
            sendEncryptedControl(
                it,
                JsonValue.Obj().put("kind", "transfer-decline").put("transferId", transferId),
            )
        }
    }

    fun cancelTransfer(transferId: String) {
        var view: TransferView? = null
        var peerId: String? = null
        synchronized(lock) {
            val send = outgoing[transferId]
            if (send != null) {
                send.cancelled = true
                send.acceptFuture.completeExceptionally(Exception("Cancelled"))
                send.completion.completeExceptionally(Exception("Cancelled"))
                outgoing.remove(transferId)
                val session = send.session
                session.status = TransferStatus.CANCELLED
                session.completedAt = System.currentTimeMillis()
                peerId = session.peerId
                persistHistoryLocked(transferId)
                view = session.toView()
            } else {
                val session = transfers[transferId] ?: return
                if (isTerminal(session.status)) return
                val recv = incoming.remove(transferId)
                recv?.let { releaseReceive(it, discard = true) }
                session.status = TransferStatus.CANCELLED
                session.completedAt = System.currentTimeMillis()
                peerId = session.peerId
                persistHistoryLocked(transferId)
                view = session.toView()
            }
            lock.notifyAll()
        }
        view?.let { emitTransfer(it) }
        peerId?.let {
            sendEncryptedControl(
                it,
                JsonValue.Obj().put("kind", "transfer-cancel").put("transferId", transferId),
            )
        }
    }

    private fun handleTransferAccept(fromPeerId: String, payload: JsonValue.Obj) {
        synchronized(lock) {
            val send = outgoing[payload.optStr("transferId") ?: return] ?: return
            if (send.session.peerId != fromPeerId) return
            val resume = payload.optObj("resumeFromChunks")
            if (resume != null) {
                val map = HashMap<Int, Int>()
                for ((k, v) in resume.map) {
                    val idx = k.toIntOrNull()
                    val value = v.asLongOrNull()
                    if (idx != null && idx in send.session.files.indices && value != null &&
                        value in 0..send.session.files[idx].totalChunks.toLong()) map[idx] = value.toInt()
                }
                send.resumeFromChunks = map
            }
            send.acceptFuture.complete(payload.optStr("preferredTransport") ?: "ws-relay")
        }
    }

    private fun handleTransferDecline(fromPeerId: String, payload: JsonValue.Obj) {
        val transferId = payload.optStr("transferId") ?: return
        var view: TransferView? = null
        synchronized(lock) {
            val send = outgoing[transferId] ?: return
            // Only the session's own peer may decline it (TS parity).
            if (send.session.peerId != fromPeerId) return
            send.cancelled = true
            val session = send.session
            session.status = TransferStatus.DECLINED
            session.completedAt = System.currentTimeMillis()
            send.acceptFuture.completeExceptionally(Exception("Declined by recipient"))
            send.completion.completeExceptionally(Exception("Declined by recipient"))
            outgoing.remove(transferId)
            persistHistoryLocked(transferId)
            view = session.toView()
            lock.notifyAll()
        }
        view?.let { emitTransfer(it) }
    }

    private fun handleTransferCancel(fromPeerId: String, payload: JsonValue.Obj) {
        val transferId = payload.optStr("transferId") ?: return
        var view: TransferView? = null
        synchronized(lock) {
            val send = outgoing[transferId]
            if (send != null && send.session.peerId == fromPeerId) {
                send.cancelled = true
                send.acceptFuture.completeExceptionally(Exception("Cancelled by peer"))
                send.completion.completeExceptionally(Exception("Cancelled by peer"))
                send.session.status = TransferStatus.CANCELLED
                send.session.completedAt = System.currentTimeMillis()
                outgoing.remove(transferId)
                persistHistoryLocked(transferId)
                view = send.session.toView()
                lock.notifyAll()
            } else {
                val recv = incoming[transferId]
                val session = transfers[transferId]
                if (recv != null && session != null && session.peerId == fromPeerId) {
                    releaseReceive(recv, discard = true)
                    incoming.remove(transferId)
                    session.status = TransferStatus.CANCELLED
                    session.completedAt = System.currentTimeMillis()
                    persistHistoryLocked(transferId)
                    view = session.toView()
                }
            }
        }
        view?.let { emitTransfer(it) }
    }

    private fun handleChunkAck(fromPeerId: String, payload: JsonValue.Obj) {
        synchronized(lock) {
            val transferId = payload.optStr("transferId") ?: return
            val send = outgoing[transferId] ?: return
            if (send.session.peerId != fromPeerId) return
            val fileIndex = payload.optInt("fileIndex") ?: return
            if (fileIndex < 0 || fileIndex >= send.session.files.size) return
            val ackedChunkIndex = payload.optInt("ackedChunkIndex") ?: return
            val meta = send.session.files[fileIndex]
            if (ackedChunkIndex !in 0 until meta.totalChunks) return
            if (ackedChunkIndex + 1 > send.sentPrefixes[fileIndex]) return
            if (ackedChunkIndex + 1 > send.acknowledgedPrefixes[fileIndex]) send.lastAckNanos = System.nanoTime()
            send.acknowledgedPrefixes[fileIndex] = maxOf(send.acknowledgedPrefixes[fileIndex], ackedChunkIndex + 1)
            send.ackedGlobalChunks = send.acknowledgedPrefixes.indices.sumOf { index ->
                maxOf(0, send.acknowledgedPrefixes[index] - (send.resumeFromChunks[index] ?: 0))
            }
            val confirmedBytes = send.session.files.sumOf { file ->
                minOf(file.size, send.acknowledgedPrefixes[file.index].toLong() * file.chunkSize)
            }
            send.session.transferredBytes = maxOf(send.session.transferredBytes, confirmedBytes).coerceAtMost(send.session.totalBytes)
            lock.notifyAll()
        }
    }

    // -------------------------------------------------------------------------
    // Encrypted chunk receive (reader thread)
    // -------------------------------------------------------------------------

    private fun handleBinaryFrame(bytes: ByteArray) {
        if (bytes.size < Frames.ROUTING_HEADER_LENGTH) return
        if ((bytes[0].toInt() and 0xff) != Frames.FRAME_ROUTED_RELAY) return
        val (sourcePeerId, frame) = Frames.decodeRoutedEncryptedChunkFrame(bytes)
        handleEncryptedChunk(sourcePeerId, frame)
    }

    private fun handleEncryptedChunk(fromPeerId: String, frame: Frames.EncryptedChunkFrame) {
        val recv: RecvState
        val session: TransferSession
        val meta: FileManifestItem
        synchronized(lock) {
            val r = incoming[frame.transferId] ?: return
            val s = transfers[frame.transferId] ?: return
            // Nothing is decrypted or stored before the user accepts (TS parity).
            if (s.peerId != fromPeerId || s.status != TransferStatus.TRANSFERRING ||
                acceptedTransferKeys[frame.transferId] != peers[fromPeerId]?.device?.publicKey ||
                !acceptedTransferKeys.containsKey(frame.transferId)) return
            val m = s.files.getOrNull(frame.fileIndex) ?: return
            if (frame.chunkIndex < 0 || frame.chunkIndex >= m.totalChunks) return
            recv = r
            session = s
            meta = m
        }
        val expectedCiphertextSize = minOf(meta.chunkSize.toLong(), maxOf(0L, meta.size - frame.chunkIndex * meta.chunkSize.toLong())) + 16
        if (frame.ciphertextLength.toLong() != expectedCiphertextSize) return
        val cryptoSession = sessionFor(fromPeerId) ?: return

        val plain = try {
            AirCrypto.decryptBinaryChunk(cryptoSession.aesKey, frame.iv, frame.ciphertext, frame.ciphertextOffset, frame.ciphertextLength)
        } catch (_: Exception) {
            return
        }

        val declaredChunkSize = if (meta.chunkSize > 0) meta.chunkSize else Limits.CHUNK_SIZE
        val expectedSize = if (meta.size == 0L) 0
        else minOf(
            declaredChunkSize.toLong(),
            meta.size - frame.chunkIndex * declaredChunkSize.toLong(),
        ).toInt()
        if (plain.size.toLong() != expectedSize.toLong()) return

        val sink = recv.sinks[frame.fileIndex] ?: return
        val duplicate = synchronized(lock) {
            if (incoming[frame.transferId] !== recv || session.status != TransferStatus.TRANSFERRING) return
            recv.chunkReceived[frame.fileIndex][frame.chunkIndex]
        }
        // Only the ordered receiver writes chunks. Do NOT hold the engine
        // monitor across filesystem/provider IO: UI snapshots, cancel, outgoing
        // ACKs and clipboard sends must not wait for flash storage.
        try { if (!duplicate) sink.store(frame.chunkIndex, plain) }
        catch (e: Exception) { failIncomingTransfer(session, e.message ?: "disk write failed"); return }
        var shouldEmit = false
        synchronized(lock) {
            if (incoming[frame.transferId] !== recv || session.status != TransferStatus.TRANSFERRING) return
            if (!duplicate) {
                recv.chunkReceived[frame.fileIndex][frame.chunkIndex] = true
                recv.bytesReceived += plain.size
                recv.fileReceivedCount[frame.fileIndex]++
            }
            // Speed / ETA smoothing mirrors warpClient.ts (0.65 / 0.35).
            val now = System.currentTimeMillis()
            if (now - recv.lastSpeedTs >= 150) {
                val elapsed = (now - recv.lastSpeedTs) / 1000.0
                val instant = (recv.bytesReceived - recv.lastSpeedBytes) / elapsed
                session.speedBytesPerSec =
                    if (session.speedBytesPerSec == 0.0) instant
                    else session.speedBytesPerSec * 0.65 + instant * 0.35
                val remaining = max(0L, session.totalBytes - recv.bytesReceived)
                session.etaSeconds =
                    if (session.speedBytesPerSec > 1024) {
                        (remaining / session.speedBytesPerSec).toLong()
                    } else null
                recv.lastSpeedTs = now
                recv.lastSpeedBytes = recv.bytesReceived
                shouldEmit = true
            }
            session.transferredBytes = recv.bytesReceived
        }
        var contiguous = recv.contiguousChunks[frame.fileIndex]
        while (contiguous < meta.totalChunks && recv.chunkReceived[frame.fileIndex][contiguous]) contiguous++
        recv.contiguousChunks[frame.fileIndex] = contiguous
        val ackNow = System.nanoTime()
        if (contiguous > recv.lastAckedChunks[frame.fileIndex] &&
            (contiguous - recv.lastAckedChunks[frame.fileIndex] >= Limits.ACK_INTERVAL_CHUNKS ||
                contiguous == meta.totalChunks || ackNow - recv.lastAckNanos[frame.fileIndex] >= TimeUnit.MILLISECONDS.toNanos(200))) {
            recv.lastAckedChunks[frame.fileIndex] = contiguous
            recv.lastAckNanos[frame.fileIndex] = ackNow
            sendEncryptedControl(
                fromPeerId,
                JsonValue.Obj()
                    .put("kind", "chunk-ack")
                    .put("transferId", frame.transferId)
                    .put("fileIndex", frame.fileIndex)
                    .put("ackedChunkIndex", contiguous - 1)
                    .put("bytesReceivedTotal", synchronized(lock) { recv.bytesReceived }),
            )
        }
        if (shouldEmit) emitTransfer(synchronized(lock) { session.toView() })

        val allArrived = synchronized(lock) {
            recv.fileReceivedCount[frame.fileIndex] >= meta.totalChunks
        }
        if (allArrived) {
            maybeFinalize(frame.transferId, force = false)
        }
    }

    private fun failIncomingTransfer(session: TransferSession, message: String) {
        synchronized(lock) {
            if (session.status != TransferStatus.TRANSFERRING) return
            session.status = TransferStatus.ERROR
            session.errorMessage = message
            session.completedAt = System.currentTimeMillis()
            incoming.remove(session.transferId)?.let { releaseReceive(it, discard = false) }
            persistHistoryLocked(session.transferId)
        }
        emitTransfer(synchronized(lock) { session.toView() })
        sendEncryptedControl(session.peerId, JsonValue.Obj().put("kind", "transfer-complete-ack")
            .put("transferId", session.transferId).put("verified", false).put("reason", message))
        emitError("RECEIVE_FAILED", message)
    }

    // -------------------------------------------------------------------------
    // Finalization (control thread)
    // -------------------------------------------------------------------------

    private fun handleFileComplete(fromPeerId: String, payload: JsonValue.Obj) {
        val transferId = payload.optStr("transferId") ?: return
        val fileIndex = payload.optInt("fileIndex") ?: return
        synchronized(lock) {
            val recv = incoming[transferId] ?: return
            val session = transfers[transferId] ?: return
            if (session.peerId != fromPeerId) return
            if (fileIndex < 0 || fileIndex >= session.files.size) return
            val sha = payload.optStr("sha256")
            if (sha != null && !Regex("^[0-9a-f]{64}$").matches(sha)) return
            recv.declaredSha[fileIndex] = sha
            recv.fileCompleteSignals.add(fileIndex)
        }
        maybeFinalize(transferId, force = false)
    }

    private fun handleTransferComplete(fromPeerId: String, payload: JsonValue.Obj) {
        val transferId = payload.optStr("transferId") ?: return
        val terminal = synchronized(lock) {
            transfers[transferId]?.takeIf {
                it.direction == TransferDirection.INCOMING && isTerminal(it.status) &&
                    acceptedTransferKeys[transferId] == peers[fromPeerId]?.device?.publicKey &&
                    acceptedTransferKeys.containsKey(transferId)
            }
        }
        if (terminal != null) {
            sendCompletionAck(terminal, fromPeerId)
            return
        }
        synchronized(lock) {
            val recv = incoming[transferId] ?: return
            if (recv.session.peerId != fromPeerId) return
            recv.transferCompleteReceived = true
            if (!recv.forceFallbackScheduled) {
                recv.forceFallbackScheduled = true
                timerExecutor.schedule({ maybeFinalize(transferId, force = true) }, 4, TimeUnit.SECONDS)
            }
        }
        maybeFinalize(transferId, force = false)
    }

    private fun sendCompletionAck(session: TransferSession, toPeerId: String = session.peerId) {
        if (synchronized(lock) { acceptedTransferKeys[session.transferId] != peers[toPeerId]?.device?.publicKey ||
                !acceptedTransferKeys.containsKey(session.transferId) }) return
        sendEncryptedControl(toPeerId, JsonValue.Obj()
            .put("kind", "transfer-complete-ack").put("transferId", session.transferId)
            .put("verified", session.status == TransferStatus.COMPLETED)
            .putOpt("reason", session.errorMessage))
    }

    private fun maybeFinalize(transferId: String, force: Boolean) {
        synchronized(lock) {
            if (stopped.get() || !incoming.containsKey(transferId)) return
            finalizationRequests[transferId] = force || finalizationRequests[transferId] == true
            if (!finalizing.add(transferId)) return
        }
        try {
            finalizeExecutor.execute {
                while (!stopped.get()) {
                    val request = synchronized(lock) {
                        finalizationRequests.remove(transferId).also { if (it == null) finalizing.remove(transferId) }
                    } ?: break
                    try { runReceiveFinalization(transferId, request) }
                    catch (e: Exception) {
                        val session = synchronized(lock) { incoming[transferId]?.session }
                        if (session != null) failIncomingTransfer(session, e.message ?: "Could not save file")
                    }
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            synchronized(lock) { finalizing.remove(transferId); finalizationRequests.remove(transferId) }
        }
    }

    private fun runReceiveFinalization(transferId: String, force: Boolean) {
        val recv = synchronized(lock) { incoming[transferId] } ?: return
        val session = recv.session
        for (meta in session.files) {
            val work = synchronized(lock) {
                if (incoming[transferId] !== recv || session.status != TransferStatus.TRANSFERRING) return
                if (recv.finalizedFiles.contains(meta.index)) return@synchronized null
                val declared = recv.declaredSha[meta.index]
                val allArrived = recv.fileReceivedCount[meta.index] == meta.totalChunks
                if (!allArrived || declared == null) {
                    if (force) session.errorMessage = "Transfer incomplete or missing SHA-256 digest."
                    return@synchronized null
                }
                recv.sinks[meta.index]?.let { it to declared }
            } ?: continue
            // Hashing and publishing a multi-GB file can take minutes. Never
            // hold the engine lock or block the WebSocket reader: ping/pong,
            // other file chunks and clipboard traffic must keep flowing.
            work.first.markComplete()
            val result = work.first.finalizeIfReady(work.second, force = false)
            val view = synchronized(lock) {
                val active = incoming[transferId] === recv && session.status == TransferStatus.TRANSFERRING
                if (!active && session.errorMessage?.startsWith("Connection lost") != true) return
                if (result == null || !result.verified) {
                    session.errorMessage = work.first.lastError() ?: "SHA-256 verification failed."
                } else {
                    session.receivedFiles.add(ReceivedFileInfo(meta.index, meta.name, meta.size,
                        result.sha256, true, result.savedPath))
                    session.receivedFiles.sortBy { it.index }
                    recv.finalizedFiles.add(meta.index)
                }
                session.toView()
            }
            emitTransfer(view)
            if (view.errorMessage != null) break
        }
        var terminal: TransferView? = null
        synchronized(lock) {
            if (incoming[transferId] !== recv || session.status != TransferStatus.TRANSFERRING) return
            if (session.errorMessage != null ||
                (recv.transferCompleteReceived && session.receivedFiles.size == session.files.size)) {
                session.status = if (session.errorMessage == null) TransferStatus.COMPLETED else TransferStatus.ERROR
                session.completedAt = System.currentTimeMillis()
                session.speedBytesPerSec = 0.0
                session.etaSeconds = if (session.errorMessage == null) 0L else null
                if (session.errorMessage == null) session.transferredBytes = session.totalBytes
                incoming.remove(transferId)
                persistHistoryLocked(transferId)
                terminal = session.toView()
            }
        }
        terminal?.let {
            recv.sinks.values.forEach { sink -> runCatching { sink.pause() } }
            sendCompletionAck(session)
            emitTransfer(it)
        }
    }

    // =========================================================================
    // Outgoing files
    // =========================================================================

    /**
     * Stage files for sending to [peerId]. Returns the transferId immediately;
     * progress flows through [EngineListener.onTransferChanged] while the
     * stream runs on the engine's sender thread.
     */
    fun sendFiles(peerId: String, inputs: List<FileSource>): String {
        require(inputs.isNotEmpty() && inputs.size <= Limits.MAX_FILES_PER_TRANSFER) { "Select 1–100 files." }
        require(synchronized(lock) { transfers.values.count { !isTerminal(it.status) } < 16 }) { "Too many active transfers. Wait for one to finish." }
        val peer: Peer
        val cryptoSession: PeerCryptoSession
        synchronized(lock) {
            peer = peers[peerId] ?: throw IllegalStateException("Selected device disconnected.")
            cryptoSession = ensureSessionLocked(peer)
        }

        val transferId = AirCrypto.randomHex16()
        val manifest = ArrayList<FileManifestItem>(inputs.size)
        var totalBytes = 0L
        for ((i, f) in inputs.withIndex()) {
            val totalChunks = max(1L, (f.size + Limits.CHUNK_SIZE - 1) / Limits.CHUNK_SIZE)
            require(totalChunks <= Limits.MAX_CHUNKS_PER_TRANSFER) {
                "File ${f.name} exceeds the per-transfer chunk cap."
            }
            manifest.add(
                FileManifestItem(
                    index = i,
                    name = f.name.take(512),
                    relativePath = f.relativePath,
                    size = f.size,
                    mimeType = f.mimeType.ifEmpty { "application/octet-stream" },
                    totalChunks = totalChunks.toInt(),
                    chunkSize = Limits.CHUNK_SIZE,
                ),
            )
            totalBytes += f.size
        }

        require(isValidFileManifest(JsonValue.JsonArr(manifest.map { it.toJson() }.toMutableList()), totalBytes)) { "Invalid file manifest." }
        val session: TransferSession
        val sendState: SendState
        synchronized(lock) {
            require(transfers.values.count { !isTerminal(it.status) } < 16) { "Too many active transfers. Wait for one to finish." }
            session = TransferSession(
                transferId = transferId,
                peerId = peerId,
                peerDeviceId = peer.device.deviceId,
                peerName = peer.device.name,
                peerPlatform = peer.device.platform,
                sasCode = cryptoSession.sasCode,
                direction = TransferDirection.OUTGOING,
                status = TransferStatus.PENDING_ACCEPT,
                files = manifest,
                totalBytes = totalBytes,
                startedAt = System.currentTimeMillis(),
            )
            sendState = SendState(session, inputs, peer.device.publicKey)
            transfers[transferId] = session
            outgoing[transferId] = sendState
        }
        val view = synchronized(lock) { session.toView() }
        emitTransfer(view)

        sendExecutor.execute {
            try {
                var attempts = 0
                while (!sendState.cancelled && !stopped.get()) {
                    try {
                        val currentPeer = waitForTransferPeer(sendState)
                        synchronized(lock) {
                            sendState.connection = ws
                            sendState.acceptFuture = CompletableFuture()
                            sendState.completion = CompletableFuture()
                            sendState.resumeFromChunks = emptyMap()
                            sendState.acknowledgedPrefixes.fill(0)
                            sendState.sentPrefixes.fill(0)
                            sendState.ackedGlobalChunks = 0
                            sendState.globalSentChunks = 0
                            session.status = if (attempts == 0) TransferStatus.PENDING_ACCEPT else TransferStatus.CONNECTING
                        }
                        sendEncryptedControl(currentPeer.peerId, JsonValue.Obj()
                            .put("kind", "transfer-offer").put("transferId", transferId)
                            .put("files", JsonValue.JsonArr(manifest.map { it.toJson() }.toMutableList()))
                            .put("totalBytes", totalBytes).put("createdAt", System.currentTimeMillis()))
                        sendState.acceptFuture.get(5, TimeUnit.MINUTES)
                        synchronized(lock) {
                            assertTransferPeer(sendState)
                            session.transport = "ws-relay"
                            session.status = TransferStatus.TRANSFERRING
                            session.speedBytesPerSec = 0.0
                            session.etaSeconds = null
                            sendState.bytesSent = session.files.sumOf { file ->
                                minOf(file.size, (sendState.resumeFromChunks[file.index] ?: 0) * file.chunkSize.toLong())
                            }
                            session.transferredBytes = sendState.bytesSent
                            session.files.forEach { file ->
                                val prefix = sendState.resumeFromChunks[file.index] ?: 0
                                sendState.acknowledgedPrefixes[file.index] = prefix
                                sendState.sentPrefixes[file.index] = prefix
                            }
                            sendState.lastAckNanos = System.nanoTime()
                            sendState.lastSpeedBytes = sendState.bytesSent
                            sendState.lastSpeedTs = System.currentTimeMillis()
                        }
                        emitTransfer(synchronized(lock) { session.toView() })
                        streamOutgoingFiles(currentPeer, sendState)
                        break
                    } catch (e: Exception) {
                        val cause = if (e is java.util.concurrent.ExecutionException) e.cause ?: e else e
                        if (cause !is TransferInterrupted || sendState.cancelled || stopped.get() || ++attempts > 5) throw e
                        synchronized(lock) {
                            session.status = TransferStatus.CONNECTING
                            session.speedBytesPerSec = 0.0
                            session.etaSeconds = null
                        }
                        emitTransfer(synchronized(lock) { session.toView() })
                        inputs.forEach { runCatching { it.close() } } // reopen sequential URI streams at resume
                    }
                }
            } catch (e: Exception) {
                synchronized(lock) {
                    if (!sendState.cancelled &&
                        session.status != TransferStatus.DECLINED &&
                        session.status != TransferStatus.CANCELLED
                    ) {
                        session.status = TransferStatus.ERROR
                        session.errorMessage = e.message ?: "Transfer interrupted"
                        session.completedAt = System.currentTimeMillis()
                        outgoing.remove(transferId)
                        persistHistoryLocked(transferId)
                    }
                }
                emitTransfer(synchronized(lock) { session.toView() })
            } finally {
                inputs.forEach { runCatching { it.close() } }
            }
        }
        return transferId
    }

    private fun waitForTransferPeer(send: SendState): Peer {
        val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(2)
        synchronized(lock) {
            while (!send.cancelled && !stopped.get()) {
                val peer = peers[send.session.peerId]
                if (connectionState == ConnectionState.CONNECTED && ws?.isOpen == true && peer?.device?.publicKey == send.peerPublicKey) return peer
                if (peer != null && peer.device.publicKey != send.peerPublicKey) throw java.io.IOException("Receiver identity changed; pair again before retrying")
                if (System.nanoTime() >= deadline) throw java.io.IOException("Receiver did not reconnect within two minutes")
                lock.wait(250)
            }
        }
        throw java.util.concurrent.CancellationException("Transfer cancelled or AirBridge stopped")
    }

    /** Caller holds lock; only resume to the exact key that received the offer. */
    private fun assertTransferPeer(send: SendState) {
        if (send.cancelled || stopped.get()) throw java.util.concurrent.CancellationException("Transfer cancelled")
        if (ws?.isOpen != true || connectionState != ConnectionState.CONNECTED ||
            (send.connection != null && ws !== send.connection) ||
            peers[send.session.peerId]?.device?.publicKey != send.peerPublicKey) {
            throw TransferInterrupted("Connection interrupted; resuming transfer")
        }
    }

    private fun streamOutgoingFiles(peer: Peer, sendState: SendState) {
        val session = sendState.session
        val inputs = sendState.inputs
        val aesKey = synchronized(lock) { ensureSessionLocked(peer) }.aesKey

        for ((fileIdx, input) in inputs.withIndex()) {
            val meta = session.files[fileIdx]
            require(input.size == meta.size) { "Source file size changed during transfer" }
            val resumeFrom = sendState.resumeFromChunks[fileIdx] ?: 0
            val digest = java.security.MessageDigest.getInstance("SHA-256")

            // Hash the skipped resume prefix so the declared digest still
            // covers the whole file (TS parity).
            for (c in 0 until resumeFrom) {
                if (sendState.cancelled) return
                val start = c * meta.chunkSize.toLong()
                val end = minOf(start + meta.chunkSize, meta.size)
                if (meta.size > 0) {
                    val prefix = input.readRange(start, end)
                    require(prefix.size.toLong() == end - start) { "Source file changed or is unreadable" }
                    digest.update(prefix)
                }
                synchronized(lock) { assertTransferPeer(sendState) }
            }

            var chunkIdx = resumeFrom
            while (chunkIdx < meta.totalChunks) {
                if (sendState.cancelled) return

                // Receiver-ACK window (64 chunks) — waiters released by acks
                // or broken by cancel/disconnect/session failure.
                val waitStarted = System.nanoTime()
                synchronized(lock) {
                    while (
                        !sendState.cancelled &&
                        session.status == TransferStatus.TRANSFERRING &&
                        sendState.globalSentChunks - sendState.ackedGlobalChunks >= Limits.MAX_UNACKED_CHUNKS
                    ) {
                        assertTransferPeer(sendState)
                        if (System.nanoTime() - maxOf(waitStarted, sendState.lastAckNanos) > TimeUnit.SECONDS.toNanos(60)) throw TransferInterrupted("Receiver ACK stalled; resuming transfer")
                        lock.wait(250)
                    }
                }
                if (sendState.cancelled) return
                synchronized(lock) { assertTransferPeer(sendState) }

                val start = chunkIdx * meta.chunkSize.toLong()
                val end = minOf(start + meta.chunkSize, meta.size)
                val plain = if (meta.size == 0L) ByteArray(0) else input.readRange(start, end)
                require(plain.size.toLong() == end - start) { "Source file changed or is unreadable." }
                digest.update(plain)
                val (iv, ciphertext) = AirCrypto.encryptBinaryChunk(
                    aesKey,
                    plain,
                    fileIdx,
                    chunkIdx,
                )
                val inner = Frames.encodeEncryptedChunkFrame(
                    Frames.EncryptedChunkFrame(session.transferId, fileIdx, chunkIdx, iv, ciphertext),
                )
                val routed = Frames.wrapRoutedRelayFrame(peer.peerId, myPeerId, inner)
                synchronized(lock) {
                    assertTransferPeer(sendState)
                    // Account before enqueue: a loopback receiver can ACK as
                    // soon as the writer takes the frame. All prefix state is
                    // shared with the ACK worker under this same monitor.
                    sendState.sentPrefixes[fileIdx] = chunkIdx + 1
                    sendState.globalSentChunks++
                    sendState.bytesSent += plain.size.toLong()
                }
                outbound.put(Outbound(false, routed, sendState.connection ?: throw TransferInterrupted("Connection lost")))

                val now = System.currentTimeMillis()
                if (now - sendState.lastSpeedTs >= 150 || chunkIdx == meta.totalChunks - 1) {
                    val elapsed = (now - sendState.lastSpeedTs) / 1000.0
                    if (elapsed > 0) {
                        val instant = (sendState.bytesSent - sendState.lastSpeedBytes) / elapsed
                        session.speedBytesPerSec =
                            if (session.speedBytesPerSec == 0.0) instant
                            else session.speedBytesPerSec * 0.65 + instant * 0.35
                        val remaining = max(0L, session.totalBytes - sendState.bytesSent)
                        session.etaSeconds =
                            if (session.speedBytesPerSec > 1024) {
                                (remaining / session.speedBytesPerSec).toLong()
                            } else null
                    }
                    sendState.lastSpeedTs = now
                    sendState.lastSpeedBytes = sendState.bytesSent
                    emitTransfer(synchronized(lock) { session.toView() })
                }
                chunkIdx++
            }

            val sha = digest.digest().joinToString("") {
                (it.toInt() and 0xff).toString(16).padStart(2, '0')
            }
            sendEncryptedControl(
                peer.peerId,
                JsonValue.Obj()
                    .put("kind", "file-complete")
                    .put("transferId", session.transferId)
                    .put("fileIndex", fileIdx)
                    .put("sha256", sha),
            )
        }

        if (sendState.cancelled) return
        val waitStarted = System.nanoTime()
        synchronized(lock) {
            while (!sendState.cancelled && sendState.ackedGlobalChunks < sendState.globalSentChunks) {
                assertTransferPeer(sendState)
                if (System.nanoTime() - maxOf(waitStarted, sendState.lastAckNanos) > TimeUnit.SECONDS.toNanos(60)) throw TransferInterrupted("Receiver ACK stalled; resuming transfer")
                lock.wait(100)
            }
        }
        if (sendState.cancelled) return
        var verified = false
        for (attempt in 0..2) {
            sendEncryptedControl(peer.peerId,
                JsonValue.Obj().put("kind", "transfer-complete").put("transferId", session.transferId))
            try {
                verified = sendState.completion.get(60, TimeUnit.SECONDS)
                break
            } catch (e: java.util.concurrent.TimeoutException) {
                if (attempt == 2) throw TransferInterrupted("Receiver did not confirm verification; resuming transfer")
            }
        }
        if (!verified) throw java.io.IOException("Receiver failed integrity verification")
        synchronized(lock) {
            session.transferredBytes = session.totalBytes
            session.etaSeconds = 0
            session.status = TransferStatus.COMPLETED
            session.completedAt = System.currentTimeMillis()
            outgoing.remove(session.transferId)
            persistHistoryLocked(session.transferId)
        }
        val done = synchronized(lock) { session.toView() }
        emitTransfer(done)
        sendHistorySync(peer.peerId)
    }

    // =========================================================================
    // Clipboard
    // =========================================================================

    fun sendClipboardText(peerId: String, text: String): ClipboardItem =
        sendClipboardInternal(peerId, text, isImage = false)

    /** [dataUrl] must be a data:image/...;base64,... string (<= ~5MB binary). */
    fun sendClipboardImageDataUrl(peerId: String, dataUrl: String): ClipboardItem =
        sendClipboardInternal(peerId, dataUrl, isImage = true)

    private fun sendClipboardInternal(peerId: String, content: String, isImage: Boolean): ClipboardItem {
        val peer: Peer
        val cryptoSession: PeerCryptoSession
        synchronized(lock) {
            peer = peers[peerId] ?: throw IllegalStateException("Selected peer is no longer online.")
            cryptoSession = ensureSessionLocked(peer)
        }
        val trimmed = content.trim()
        require(trimmed.isNotEmpty()) { "Cannot beam empty content." }
        val image = isImage || isValidClipboardImageDataUrl(trimmed)
        if (image) {
            require(isValidClipboardImageDataUrl(trimmed)) { "Not a valid image data URL." }
        } else {
            require(content.length <= Limits.MAX_CLIPBOARD_TEXT) { "Text too large to beam." }
        }

        val beamId = AirCrypto.randomHex16()
        val contentType = if (image) "image" else classifyTextPayload(trimmed)
        val timestamp = System.currentTimeMillis()
        synchronized(lock) {
            seenBeamIds.add(beamId)
            while (seenBeamIds.size > 200) seenBeamIds.remove(seenBeamIds.first())
        }

        val payload = JsonValue.Obj()
            .put("kind", "clipboard-beam")
            .put("beamId", beamId)
            .put("contentType", contentType)
            .put("timestamp", timestamp)
        if (image) {
            payload
                .put("imageDataUrl", trimmed)
                .put("imageName", "clipboard-image-$timestamp.png")
        } else {
            payload.put("text", content)
        }
        sendEncryptedControl(peerId, payload)

        val item = ClipboardItem(
            beamId = beamId,
            peerId = peerId,
            peerName = peer.device.name,
            direction = "outgoing",
            text = if (image) trimmed else content,
            imageDataUrl = if (image) trimmed else null,
            imageName = if (image) "clipboard-image-$timestamp.png" else null,
            contentType = contentType,
            timestamp = timestamp,
            sasCode = cryptoSession.sasCode,
        )
        for (l in listeners) l.onLocalClipboardBeam(item)
        return item
    }

    // =========================================================================
    // History sync — port of the warpClient reconciliation (terminal transfers,
    // matched by deviceId or platform+name, capped at 50 entries)
    // =========================================================================

    private fun persistHistoryLocked(transferId: String) {
        val session = transfers[transferId] ?: return
        val entry = JsonValue.Obj()
            .put("transferId", transferId)
            .putOpt("peerDeviceId", session.peerDeviceId)
            .put("peerName", session.peerName)
            .put("peerPlatform", session.peerPlatform)
            .put("direction", if (session.direction == TransferDirection.INCOMING) "incoming" else "outgoing")
            .put("status", session.status)
            .put("transport", "ws-relay")
            .put("files", JsonValue.JsonArr(session.files.map { it.toJson() }.toMutableList()))
            .put("totalBytes", session.totalBytes)
            .put("transferredBytes", session.transferredBytes)
            .put("startedAt", session.startedAt)
            .putOpt("completedAt", session.completedAt)
            .put("sasCode", session.sasCode)
        history.removeAll { it.optStr("transferId") == transferId }
        history.addFirst(entry)
        while (history.size > Limits.MAX_HISTORY) history.removeLast()
        val terminalIds = transfers.values.filter { isTerminal(it.status) }.map { it.transferId }
        terminalIds.dropLast(Limits.MAX_HISTORY).forEach {
            transfers.remove(it); acceptedTransferKeys.remove(it); resumeCompletedFiles.remove(it)
        }
    }

    private fun sendHistorySync(toPeerId: String) {
        val peer: Peer?
        val relevant = JsonValue.JsonArr()
        synchronized(lock) {
            peer = peers[toPeerId] ?: return
            for (entry in history) {
                val matches =
                    (peer.device.deviceId != null && entry.optStr("peerDeviceId") == peer.device.deviceId) ||
                        (peer.discoveryScope == "paired" &&
                            (entry.optStr("peerPlatform") == peer.device.platform ||
                                entry.optStr("peerName") == peer.device.name)) ||
                        (entry.optStr("peerName") == peer.device.name &&
                            entry.optStr("peerPlatform") == peer.device.platform)
                if (matches) relevant.add(entry)
            }
        }
        if (relevant.size == 0) return
        sendEncryptedControl(
            toPeerId,
            JsonValue.Obj().put("kind", "history-sync").put("transfers", relevant),
        )
    }

    private fun handleHistorySync(fromPeerId: String, payload: JsonValue.Obj) {
        val arr = payload.optArr("transfers") ?: return
        var changed = false
        synchronized(lock) {
            for (item in arr.items) {
                val o = item as? JsonValue.Obj ?: continue
                val id = o.optStr("transferId") ?: continue
                val status = o.optStr("status") ?: continue
                if (status !in listOf(
                        TransferStatus.COMPLETED, TransferStatus.DECLINED,
                        TransferStatus.CANCELLED, TransferStatus.ERROR,
                    )
                ) continue
                if (history.any { it.optStr("transferId") == id }) continue
                if (transfers.containsKey(id)) continue
                history.addFirst(o)
                changed = true
            }
            while (history.size > Limits.MAX_HISTORY) history.removeLast()
        }
        if (changed) {
            // Persisted in-memory; a richer store can layer on top later.
        }
    }

    fun historySnapshot(): List<JsonValue.Obj> = synchronized(lock) { history.toList() }

    // =========================================================================
    // Settings
    // =========================================================================

    fun updateDeviceName(newName: String) {
        synchronized(lock) { deviceName = sanitizeName(newName) }
        sendUpdateProfile()
    }

    fun setVisibility(mode: String) {
        require(mode == "nearby" || mode == "paired-only" || mode == "hidden") {
            "visibility must be nearby | paired-only | hidden"
        }
        synchronized(lock) { visibility = mode }
        sendUpdateProfile()
    }

    private fun sendUpdateProfile() {
        if (connectionState != ConnectionState.CONNECTED) return
        val device: DeviceProfile
        val vis: String
        synchronized(lock) {
            device = currentDeviceProfile()
            vis = visibility
        }
        sendServer(
            JsonValue.Obj()
                .put("type", "update-profile")
                .put("device", device.toJson())
                .put("visibility", vis),
        )
    }

    fun joinPairCode(rawCode: String): Boolean {
        val normalized = PairCode.normalize(rawCode)
        if (!PairCode.isValid(normalized)) return false
        synchronized(lock) { pairCode = normalized }
        if (connectionState == ConnectionState.CONNECTED) sendServer(JsonValue.Obj().put("type", "join-pair").put("pairCode", normalized))
        return true
    }

    fun rotatePairCode() {
        sendServer(JsonValue.Obj().put("type", "rotate-pair"))
    }

    fun setTrusted(peerPublicKey: String, trusted: Boolean) {
        if (trusted) trustedPeerKeys.add(peerPublicKey) else trustedPeerKeys.remove(peerPublicKey)
    }

    fun isTrusted(peerPublicKey: String): Boolean = trustedPeerKeys.contains(peerPublicKey)
}
