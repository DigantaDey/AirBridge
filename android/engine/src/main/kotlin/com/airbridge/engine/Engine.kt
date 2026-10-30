package com.airbridge.engine

import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
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
    val autoAcceptAll: Boolean = false,
    val trustAllTls: Boolean = true,
    /** Where incoming files are staged when the UI accepts an offer. */
    val defaultSinkFactory: FileSinkFactory? = null,
)

internal data class Outbound(val isText: Boolean, val payload: ByteArray)

internal class SendState(
    val session: TransferSession,
    val inputs: List<FileSource>,
) {
    @Volatile var cancelled = false
    var acceptFuture: CompletableFuture<String> = CompletableFuture()
    var resumeFromChunks: Map<Int, Int> = emptyMap()
    var ackedGlobalChunks = 0
    var globalSentChunks = 0
    var bytesSent = 0L
    var lastSpeedTs = System.currentTimeMillis()
    var lastSpeedBytes = 0L
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
    private var pairCode: String = ""
    private val deviceId: String = config.deviceId ?: AirCrypto.randomHex16()

    private val peers = LinkedHashMap<String, Peer>()
    private val sessions = HashMap<String, PeerCryptoSession>()
    private val sessionKeyFingerprints = HashMap<String, String>()
    private val transfers = LinkedHashMap<String, TransferSession>()
    private val outgoing = HashMap<String, SendState>()
    private val incoming = HashMap<String, RecvState>()
    private val trustedPeerKeys = Collections.synchronizedSet(HashSet<String>())
    private val history = ArrayDeque<JsonValue.Obj>()
    private val seenBeamIds = LinkedHashSet<String>()
    private var lastIncomingClip: Pair<String, String>? = null // (dedupKey, unused-ts-holder)
    private var lastIncomingClipTs = 0L
    var autoClipboardSend = true
    var clipboardReceiveEnabled = true

    @Volatile
    private var connectionState = ConnectionState.DISCONNECTED
    private val stopped = AtomicBoolean(false)

    private var ws: WebSocketClient? = null
    private val outbound = LinkedBlockingQueue<Outbound>()
    private val controlExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "airbridge-control").apply { isDaemon = true }
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
        if (!stopped.compareAndSet(false, true)) return // reuse guard inverted below
        stopped.set(false)
        setConnectionState(ConnectionState.CONNECTING)
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
        if (stopped.get()) return
        // Flush frames queued moments before shutdown (clipboard beams, final
        // ACKs) while the pump and socket are still alive — bounded so a dead
        // link can't hang shutdown. The extra beat lets an in-flight write
        // finish: `outbound.take()` empties the queue before the bytes hit
        // the wire.
        val deadline = System.currentTimeMillis() + 1_500
        while (outbound.isNotEmpty() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(10)
            } catch (_: InterruptedException) {
                break
            }
        }
        try {
            Thread.sleep(100)
        } catch (_: InterruptedException) {
        }
        if (!stopped.compareAndSet(false, true)) return
        setConnectionState(ConnectionState.DISCONNECTED)
        try {
            ws?.close()
        } catch (_: Exception) {
        }
        outbound.offer(Outbound(true, ByteArray(0))) // wake pump to exit
        controlExecutor.shutdownNow()
        sendExecutor.shutdownNow()
        timerExecutor.shutdownNow()
        connectionThread?.interrupt()
        pumpThread?.interrupt()
    }

    private fun setConnectionState(next: ConnectionState) {
        if (connectionState == next) return
        connectionState = next
        emitState(next)
    }

    private fun connectionLoop() {
        var attempt = 0
        while (!stopped.get()) {
            var client: WebSocketClient? = null
            try {
                client = WebSocketClient(
                    normalizeWsUrl(config.serverUrl),
                    object : WebSocketClient.Listener {
                        override fun onText(text: String) {
                            controlExecutor.execute {
                                try {
                                    handleServerJson(text)
                                } catch (e: Exception) {
                                    emitError("BAD_MESSAGE", e.message ?: "bad server message")
                                }
                            }
                        }

                        override fun onBinary(bytes: ByteArray) {
                            try {
                                handleBinaryFrame(bytes)
                            } catch (e: Exception) {
                                // A malformed/undecryptable frame must not kill the socket.
                            }
                        }

                        override fun onClosed(reason: String) {
                            if (!stopped.get()) onDisconnect()
                        }
                    },
                    trustAllTls = config.trustAllTls,
                )
                client.connectBlocking()
                ws = client
                attempt = 0
                setConnectionState(ConnectionState.CONNECTED)
                sendHello(client)
                val reason = client.readLoop()
                if (stopped.get()) break
                onDisconnect()
                setConnectionState(ConnectionState.RECONNECTING)
                attempt++
                Thread.sleep(reconnectDelayMs(attempt))
            } catch (e: Exception) {
                if (stopped.get()) break
                try {
                    client?.close()
                } catch (_: Exception) {
                }
                onDisconnect()
                setConnectionState(ConnectionState.RECONNECTING)
                attempt++
                try {
                    Thread.sleep(reconnectDelayMs(attempt))
                } catch (_: InterruptedException) {
                    break
                }
            }
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
                val item = outbound.take()
                if (stopped.get()) return
                val target = ws ?: continue
                try {
                    if (item.isText) target.sendText(String(item.payload, Charsets.UTF_8))
                    else target.sendBinary(item.payload)
                } catch (e: Exception) {
                    // Socket died mid-write; the connection loop will reconnect.
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
        try {
            client.sendText(hello.toJsonString())
        } catch (_: Exception) {
        }
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
        controlExecutor.execute {
            val deadTransfers: List<TransferView>
            synchronized(lock) {
                peers.clear()
                sessions.clear()
                sessionKeyFingerprints.clear()
                deadTransfers = mutableListOf<TransferView>().apply {
                    for (t in transfers.values) {
                        if (t.status == TransferStatus.PENDING_ACCEPT ||
                            t.status == TransferStatus.TRANSFERRING ||
                            t.status == TransferStatus.CONNECTING
                        ) {
                            t.status = TransferStatus.ERROR
                            t.errorMessage = "Connection lost"
                            t.completedAt = System.currentTimeMillis()
                            add(t.toView())
                        }
                    }
                    // Drop in-flight bookkeeping; partial receives stay on disk for resume.
                    val failedIds = transfers.filterValues {
                        it.status == TransferStatus.ERROR
                    }.keys.toList()
                    for (id in failedIds) {
                        outgoing.remove(id)?.acceptFuture?.completeExceptionally(
                            Exception("Connection lost")
                        )
                        outgoing.remove(id)
                        incoming.remove(id)
                    }
                }
                if (deadTransfers.isNotEmpty()) {
                    for (t in deadTransfers) persistHistoryLocked(t.transferId)
                }
            }
            emitPeers(emptyList())
            for (v in deadTransfers) emitTransfer(v)
        }
    }

    // =========================================================================
    // Outbound JSON / control helpers
    // =========================================================================

    private fun sendServer(obj: JsonValue.Obj) {
        val text = obj.toJsonString()
        outbound.offer(Outbound(true, text.toByteArray(Charsets.UTF_8)))
    }

    private fun sendEncryptedControl(to: String, payload: JsonValue.Obj) {
        val peerSession: PeerCryptoSession?
        synchronized(lock) { peerSession = sessions[to] }
        if (peerSession == null) {
            emitError("NO_SESSION", "No encryption session for $to")
            return
        }
        val env = AirCrypto.encryptControlPayload(
            peerSession.aesKey,
            payload.toJsonString().toByteArray(Charsets.UTF_8),
        )
        val envelope = JsonValue.Obj()
            .put("encrypted", true)
            .put("iv", Base64Url.encode(env.iv))
            .put("ciphertext", Base64Url.encode(env.ciphertext))
        sendServer(
            JsonValue.Obj()
                .put("type", "transfer-control")
                .put("to", to)
                .put("envelope", envelope),
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
            "host-clipboard" -> {
                val textClip = msg.optStr("text") ?: return
                if (!clipboardReceiveEnabled) return
                val item = ClipboardItem(
                    beamId = AirCrypto.randomHex16(),
                    peerId = "",
                    peerName = "Host PC",
                    direction = "incoming",
                    text = textClip,
                    imageDataUrl = null,
                    imageName = null,
                    contentType = classifyTextPayload(textClip),
                    timestamp = msg.optLong("timestamp") ?: System.currentTimeMillis(),
                    sasCode = "··· ···",
                )
                emitClipboard(item)
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
        sessions[peerId]?.let { return it }
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

        val dedupKey = if (hasImage) imageDataUrl.substring(0, minOf(256, imageDataUrl.length))
        else text.trim()
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
        var view: TransferView? = null
        var trusted = false
        synchronized(lock) {
            if (transfers.containsKey(transferId)) return
            val peer = peers[fromPeerId]
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
            view = ts.toView()
            trusted = config.autoAcceptAll ||
                (peer != null && trustedPeerKeys.contains(peer.device.publicKey))
        }
        val offerView = view ?: return
        emitOffer(offerView)

        if (trusted) {
            controlExecutor.execute {
                try {
                    acceptIncomingTransfer(transferId, null)
                } catch (e: Exception) {
                    emitError("AUTO_ACCEPT_FAILED", e.message ?: "auto-accept failed")
                }
            }
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
        val resume = HashMap<Int, Int>()
        var view: TransferView? = null
        synchronized(lock) {
            val session = transfers[transferId] ?: return
            if (session.direction != TransferDirection.INCOMING ||
                session.status != TransferStatus.PENDING_ACCEPT
            ) return
            val sinks = HashMap<Int, FileSink>()
            val recv = try {
                for (meta in session.files) {
                    sinks[meta.index] = factory.open(transferId, meta)
                }
                RecvState(session, sinks)
            } catch (e: Exception) {
                session.status = TransferStatus.ERROR
                session.errorMessage = e.message ?: "cannot open receive storage"
                session.completedAt = System.currentTimeMillis()
                view = session.toView()
                RecvState(session, sinks) // placeholder, immediately discarded below
            }
            if (session.status == TransferStatus.ERROR) {
                incoming.remove(transferId)
                persistHistoryLocked(transferId)
            } else {
                incoming[transferId] = recv
                session.status = TransferStatus.TRANSFERRING
                session.startedAt = System.currentTimeMillis()
                // Seed session accounting from whatever the sink already holds
                // on disk (resumed partials), mirroring prepareDiskReceivers().
                for (meta in session.files) {
                    val sink = sinks[meta.index] ?: continue
                    val bits = recv.chunkReceived[meta.index]
                    for (i in bits.indices) {
                        if (!bits[i] && sink.hasReceived(i)) {
                            bits[i] = true
                            recv.fileReceivedCount[meta.index]++
                            recv.bytesReceived += if (meta.size == 0L) 0L
                            else minOf(
                                meta.chunkSize.toLong(),
                                meta.size - i * meta.chunkSize.toLong(),
                            )
                        }
                    }
                    val r = sink.resumeFrom()
                    if (r > 0) resume[meta.index] = r
                }
                session.transferredBytes = recv.bytesReceived
                view = session.toView()
            }
        }
        view?.let { emitTransfer(it) }
        if (view?.status != TransferStatus.TRANSFERRING) return

        val accept = JsonValue.Obj()
            .put("kind", "transfer-accept")
            .put("transferId", transferId)
            .put("preferredTransport", "ws-relay")
        if (resume.isNotEmpty()) {
            val map = JsonValue.Obj()
            for ((k, v) in resume) map.put(k.toString(), v.toLong())
            accept.put("resumeFromChunks", map)
        }
        val targetPeer = synchronized(lock) { transfers[transferId]?.peerId } ?: return
        sendEncryptedControl(targetPeer, accept)
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
                outgoing.remove(transferId)
                val session = send.session
                session.status = TransferStatus.CANCELLED
                session.completedAt = System.currentTimeMillis()
                peerId = session.peerId
                persistHistoryLocked(transferId)
                view = session.toView()
            } else {
                val session = transfers[transferId] ?: return
                val recv = incoming.remove(transferId)
                recv?.sinks?.values?.forEach { sk -> runCatching { sk.discard() } }
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
                    if (idx != null && value != null) map[idx] = value.toInt()
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
                    recv.sinks.values.forEach { sk -> runCatching { sk.discard() } }
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
            var globalAcked = 0
            for (i in 0 until fileIndex) globalAcked += send.session.files[i].totalChunks
            globalAcked += ackedChunkIndex + 1
            if (globalAcked > send.ackedGlobalChunks) send.ackedGlobalChunks = globalAcked
            payload.optLong("bytesReceivedTotal")?.let {
                if (it > send.session.transferredBytes) send.session.transferredBytes = it
            }
            lock.notifyAll()
        }
    }

    // -------------------------------------------------------------------------
    // Encrypted chunk receive (reader thread)
    // -------------------------------------------------------------------------

    private fun handleBinaryFrame(bytes: ByteArray) {
        if (bytes.size < Frames.ROUTING_HEADER_LENGTH) return
        if ((bytes[0].toInt() and 0xff) != Frames.FRAME_ROUTED_RELAY) return
        val routed = Frames.unwrapRoutedRelayFrame(bytes)
        val inner = routed.payload
        if (inner.size < Frames.CHUNK_HEADER_LENGTH) return
        if ((inner[0].toInt() and 0xff) != Frames.FRAME_ENCRYPTED_CHUNK) return
        val frame = Frames.decodeEncryptedChunkFrame(inner)
        handleEncryptedChunk(routed.sourcePeerId, frame)
    }

    private fun handleEncryptedChunk(fromPeerId: String, frame: Frames.EncryptedChunkFrame) {
        val recv: RecvState
        val session: TransferSession
        val meta: FileManifestItem
        synchronized(lock) {
            val r = incoming[frame.transferId] ?: return
            val s = transfers[frame.transferId] ?: return
            // Nothing is decrypted or stored before the user accepts (TS parity).
            if (s.peerId != fromPeerId || s.status != TransferStatus.TRANSFERRING) return
            val m = s.files.getOrNull(frame.fileIndex) ?: return
            if (frame.chunkIndex < 0 || frame.chunkIndex >= m.totalChunks) return
            recv = r
            session = s
            meta = m
        }
        val cryptoSession = sessionFor(fromPeerId) ?: return

        val plain = try {
            AirCrypto.decryptBinaryChunk(cryptoSession.aesKey, frame.iv, frame.ciphertext)
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
        var newBytes = 0L
        var shouldEmit = false
        var fatalError: String? = null
        synchronized(lock) {
            if (!recv.chunkReceived[frame.fileIndex][frame.chunkIndex]) {
                try {
                    sink.store(frame.chunkIndex, plain)
                } catch (e: Exception) {
                    fatalError = e.message ?: "disk write failed"
                }
                if (fatalError == null) {
                    recv.chunkReceived[frame.fileIndex][frame.chunkIndex] = true
                    newBytes = plain.size.toLong()
                    recv.bytesReceived += newBytes
                    recv.fileReceivedCount[frame.fileIndex]++
                }
            }
            // Speed / ETA smoothing mirrors warpClient.ts (0.65 / 0.35).
            val now = System.currentTimeMillis()
            if (fatalError == null && now - recv.lastSpeedTs >= 150) {
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
        if (fatalError != null) {
            failIncomingTransfer(session, fatalError)
            return
        }

        val isLast = frame.chunkIndex == meta.totalChunks - 1
        if (frame.chunkIndex % Limits.ACK_INTERVAL_CHUNKS == 0 || isLast) {
            sendEncryptedControl(
                fromPeerId,
                JsonValue.Obj()
                    .put("kind", "chunk-ack")
                    .put("transferId", frame.transferId)
                    .put("fileIndex", frame.fileIndex)
                    .put("ackedChunkIndex", frame.chunkIndex)
                    .put("bytesReceivedTotal", synchronized(lock) { recv.bytesReceived }),
            )
        }
        if (shouldEmit) emitTransfer(synchronized(lock) { session.toView() })

        val allArrived = synchronized(lock) {
            recv.fileReceivedCount[frame.fileIndex] >= meta.totalChunks
        }
        if (allArrived) {
            controlExecutor.execute {
                maybeFinalize(frame.transferId, force = false)
            }
        }
    }

    private fun failIncomingTransfer(session: TransferSession, message: String) {
        synchronized(lock) {
            if (session.status != TransferStatus.TRANSFERRING) return
            session.status = TransferStatus.ERROR
            session.errorMessage = message
            session.completedAt = System.currentTimeMillis()
            incoming.remove(session.transferId)
            persistHistoryLocked(session.transferId)
        }
        emitTransfer(synchronized(lock) { session.toView() })
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
            recv.sinks[fileIndex]?.markComplete()
        }
        maybeFinalize(transferId, force = false)
    }

    private fun handleTransferComplete(fromPeerId: String, payload: JsonValue.Obj) {
        val transferId = payload.optStr("transferId") ?: return
        synchronized(lock) {
            val recv = incoming[transferId] ?: return
            val session = transfers[transferId] ?: return
            if (session.peerId != fromPeerId) return
            recv.transferCompleteReceived = true
            if (!recv.forceFallbackScheduled) {
                recv.forceFallbackScheduled = true
                timerExecutor.schedule(
                    {
                        controlExecutor.execute {
                            try {
                                maybeFinalize(transferId, force = true)
                            } catch (_: Exception) {
                            }
                        }
                    },
                    4,
                    TimeUnit.SECONDS,
                )
            }
        }
        maybeFinalize(transferId, force = false)
    }

    private fun maybeFinalize(transferId: String, force: Boolean) {
        var completed = false
        var emitView: TransferView? = null
        var partialError: String? = null
        synchronized(lock) {
            val recv = incoming[transferId] ?: return
            val session = transfers[transferId] ?: return
            if (session.status != TransferStatus.TRANSFERRING) return

            for (meta in session.files) {
                if (recv.finalizedFiles.contains(meta.index)) continue
                val declared = recv.declaredSha[meta.index]
                val signalPresent =
                    recv.fileCompleteSignals.contains(meta.index) || recv.transferCompleteReceived
                val allArrived = meta.size == 0L ||
                    recv.fileReceivedCount[meta.index] >= meta.totalChunks
                if (!signalPresent && !force) continue
                if (!allArrived && !force) continue

                val sink = recv.sinks[meta.index] ?: continue
                val result = sink.finalizeIfReady(declared, force = !allArrived)
                if (result != null) {
                    val verified = if (declared != null) result.sha256 == declared else allArrived
                    session.receivedFiles.add(
                        ReceivedFileInfo(
                            index = meta.index,
                            name = meta.name,
                            size = meta.size,
                            sha256 = result.sha256,
                            verified = verified,
                            savedPath = result.savedPath,
                        ),
                    )
                    session.receivedFiles.sortBy { it.index }
                    recv.finalizedFiles.add(meta.index)
                    emitView = session.toView()
                } else if (force && !allArrived) {
                    partialError = sink.lastError() ?: "Transfer incomplete: some chunks never arrived."
                }
            }

            if (session.receivedFiles.size == session.files.size) {
                completed = true
                session.status = TransferStatus.COMPLETED
                session.completedAt = System.currentTimeMillis()
                session.transferredBytes = session.totalBytes
                session.etaSeconds = 0
                incoming.remove(transferId)
                persistHistoryLocked(transferId)
                emitView = session.toView()
            } else if (force && partialError != null) {
                session.status = TransferStatus.ERROR
                session.errorMessage = partialError
                session.completedAt = System.currentTimeMillis()
                incoming.remove(transferId)
                persistHistoryLocked(transferId)
                emitView = session.toView()
            }
        }
        emitView?.let { emitTransfer(it) }
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
        require(inputs.isNotEmpty()) { "No files selected." }
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

        val session: TransferSession
        val sendState: SendState
        synchronized(lock) {
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
            sendState = SendState(session, inputs)
            transfers[transferId] = session
            outgoing[transferId] = sendState
        }
        val view = synchronized(lock) { session.toView() }
        emitTransfer(view)

        val offer = JsonValue.Obj()
            .put("kind", "transfer-offer")
            .put("transferId", transferId)
            .put("files", JsonValue.JsonArr(manifest.map { it.toJson() }.toMutableList()))
            .put("totalBytes", totalBytes)
            .put("createdAt", System.currentTimeMillis())
        sendEncryptedControl(peerId, offer)

        sendExecutor.execute {
            try {
                val negotiated = sendState.acceptFuture.get() // declined/cancelled/disconnect -> throws
                session.transport = "ws-relay"
                session.status = TransferStatus.TRANSFERRING
                session.startedAt = System.currentTimeMillis()
                emitTransfer(synchronized(lock) { session.toView() })
                streamOutgoingFiles(peer, sendState, negotiated)
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
            }
        }
        return transferId
    }

    private fun streamOutgoingFiles(peer: Peer, sendState: SendState, @Suppress("UNUSED_PARAMETER") negotiated: String) {
        val session = sendState.session
        val inputs = sendState.inputs
        val aesKey = synchronized(lock) { ensureSessionLocked(peer) }.aesKey

        for ((fileIdx, input) in inputs.withIndex()) {
            val meta = session.files[fileIdx]
            val resumeFrom = sendState.resumeFromChunks[fileIdx] ?: 0
            val digest = java.security.MessageDigest.getInstance("SHA-256")

            // Hash the skipped resume prefix so the declared digest still
            // covers the whole file (TS parity).
            for (c in 0 until resumeFrom) {
                if (sendState.cancelled) return
                val start = c * meta.chunkSize.toLong()
                val end = minOf(start + meta.chunkSize, input.size)
                if (input.size > 0) digest.update(input.readRange(start, end))
            }

            var chunkIdx = resumeFrom
            while (chunkIdx < meta.totalChunks) {
                if (sendState.cancelled) return

                // Receiver-ACK window (256 chunks) — waiters released by acks
                // or broken by cancel/disconnect/session failure.
                synchronized(lock) {
                    while (
                        !sendState.cancelled &&
                        session.status == TransferStatus.TRANSFERRING &&
                        sendState.globalSentChunks - sendState.ackedGlobalChunks >= Limits.MAX_UNACKED_CHUNKS
                    ) {
                        lock.wait(250)
                    }
                }
                if (sendState.cancelled || session.status != TransferStatus.TRANSFERRING) return

                val start = chunkIdx * meta.chunkSize.toLong()
                val end = minOf(start + meta.chunkSize, input.size)
                val plain = if (input.size == 0L) ByteArray(0) else input.readRange(start, end)
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
                outbound.offer(Outbound(false, routed))
                sendState.globalSentChunks++
                sendState.bytesSent += plain.size.toLong()

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
                    session.transferredBytes = sendState.bytesSent
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
        sendEncryptedControl(
            peer.peerId,
            JsonValue.Obj().put("kind", "transfer-complete").put("transferId", session.transferId),
        )
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
            require(trimmed.length <= Limits.MAX_CLIPBOARD_TEXT) { "Text too large to beam." }
        }

        val beamId = AirCrypto.randomHex16()
        val contentType = if (image) "image" else classifyTextPayload(trimmed)
        val timestamp = System.currentTimeMillis()
        synchronized(lock) {
            seenBeamIds.add(beamId)
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
            payload.put("text", trimmed)
        }
        sendEncryptedControl(peerId, payload)

        val item = ClipboardItem(
            beamId = beamId,
            peerId = peerId,
            peerName = peer.device.name,
            direction = "outgoing",
            text = trimmed,
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
        sendServer(JsonValue.Obj().put("type", "join-pair").put("pairCode", normalized))
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
