package com.airbridge.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.airbridge.engine.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Service-owned native peer. The WebView only polls immutable metadata and
 * submits user decisions; neither encryption, socket IO nor file IO needs a
 * browser timer, Activity, JavaScript callback or base64 file bridge.
 */
class NativeEngineHost(
    private val context: Context,
    private val onTransfers: (List<TransferView>) -> Unit,
    private val onOffer: (TransferView) -> Unit,
    private val onConnection: (ConnectionState) -> Unit,
) : AutoCloseable {
    private val prefs = Prefs(context)
    private val configuredTarget = prefs.target
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "airbridge-native-commands").apply { isDaemon = true } }
    private val stateLock = Any()
    @Volatile private var engine: AirBridgeEngine? = null
    @Volatile private var closed = false
    private data class Snapshot(val version: Long, val clipboardVersion: Long, val json: String, val clips: String)
    @Volatile private var snapshot = Snapshot(0, 0, "{\"ready\":false}", "[]")
    private var revision = 0L
    private var clipboardRevision = 0L
    private var clipboardJson = "[]"
    @Volatile private var connectionError: String? = null

    fun snapshotSince(version: Long, clipboardVersion: Long): String {
        val state = snapshot
        if (state.version == version) return ""
        return if (state.clipboardVersion == clipboardVersion) state.json
            else state.json.dropLast(1) + ",\"clipboardItems\":" + state.clips + "}"
    }
    private var lanUrls = emptyList<String>()
    private val clips = ArrayDeque<ClipboardItem>()
    private var clipBytes = 0
    private var lastSynced = ""
    private var lastSyncedAt = 0L
    private data class PendingClipboard(val text: String, val at: Long, val explicit: Boolean,
        val deliveredTo: MutableSet<String> = HashSet())
    private data class ClipboardCapture(val text: String, val explicit: Boolean,
        val at: Long = android.os.SystemClock.elapsedRealtime())
    private var pendingClipboard: PendingClipboard? = null

    private val snapshotWork = LatestTask<Unit>(worker) {
        if (!closed) { buildSnapshot(); flushPendingClipboard() }
    }
    private val clipboardWork = LatestTask<ClipboardItem>(worker) { item ->
        // The OS clipboard is a latest value, not a reliable event log. If it
        // is slow to write, superseded images must not pile up in the heap.
        if (!closed && prefs.receiveClipboard) {
            try {
                val image = item.imageDataUrl
                if (image != null) ClipboardImageProvider.copyImage(context, image)
                else {
                    ConnectionService.markOwnClipboardWrite(item.text)
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("AirBridge", item.text))
                }
                synchronized(stateLock) { lastSynced = item.text; lastSyncedAt = android.os.SystemClock.elapsedRealtime() }
            } catch (e: Exception) { Log.w(TAG, "System clipboard write failed: ${e.message}") }
            addClip(item)
        }
    }

    private val captureWork = LatestTask<ClipboardCapture>(worker) { capture ->
        val text = capture.text
        if (!closed && (capture.explicit || prefs.autoClipboard) && text.isNotBlank() && text.length <= Limits.MAX_CLIPBOARD_TEXT) {
            val now = android.os.SystemClock.elapsedRealtime()
            val echo = synchronized(stateLock) { !capture.explicit && text == lastSynced && now - lastSyncedAt < 1_500 }
            if (now - capture.at >= 60_000) return@LatestTask
            if (!echo) {
                synchronized(stateLock) { pendingClipboard = PendingClipboard(text, capture.at, capture.explicit) }
                flushPendingClipboard()
            }
        }
    }

    init {
        worker.execute {
            try {
                val link = prefs.pairingLink() ?: return@execute
                val created = AirBridgeEngine(EngineConfig(
                    serverUrl = link.wsUrl, deviceName = prefs.deviceName, model = Build.MODEL,
                    deviceId = prefs.deviceId, peerId = prefs.peerId.ifEmpty { null },
                    initialPairCode = prefs.pairCode, visibility = prefs.visibility,
                    tlsTrustManager = prefs.tlsTrust(link),
                    defaultSinkFactory = AndroidFileSinkFactory(context),
                ))
                created.autoClipboardSend = prefs.autoClipboard
                created.clipboardReceiveEnabled = prefs.receiveClipboard
                prefs.trustedKeys.forEach { created.setTrusted(it, true) }
                engine = created
                created.addListener(object : EngineListener {
                    override fun onConnectionState(state: ConnectionState) { refresh(); onConnection(state) }
                    override fun onWelcome(info: WelcomeInfo) {
                        if (closed || prefs.target != configuredTarget) return
                        connectionError = null
                        prefs.peerId = info.peerId
                        prefs.pairCode = info.pairCode
                        synchronized(stateLock) { lanUrls = info.lanUrls }
                        refresh()
                    }
                    override fun onPairCodeChanged(pairCode: String) {
                        if (closed || prefs.target != configuredTarget) return
                        prefs.pairCode = pairCode; refresh()
                    }
                    override fun onPeersChanged(peers: List<Peer>) {
                        // Snapshot work also retries pending clipboard sends,
                        // without queuing one worker for every peer update.
                        refresh()
                    }
                    override fun onIncomingOffer(transfer: TransferView) { refresh(); onOffer(transfer) }
                    override fun onTransferChanged(transfer: TransferView) { refresh(); onTransfers(created.transfersSnapshot()) }
                    override fun onClipboard(item: ClipboardItem) { clipboardWork.offer(item) }
                    override fun onLocalClipboardBeam(item: ClipboardItem) = addClip(item)
                    override fun onError(code: String, message: String) {
                        if (code == "CONNECTION_FAILED") connectionError = message
                        Log.w(TAG, "$code: $message"); refresh()
                    }
                })
                if (closed) { created.stop(); return@execute }
                created.start()
                refresh()
            } catch (e: Exception) { Log.e(TAG, "Native engine startup failed", e) }
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
            clipboardRevision++
            clipboardJson = JSONArray().also { array -> clips.forEach { array.put(clipJson(it)) } }.toString()
        }
        refresh()
    }

    /** A real native clipboard event, including the opt-in accessibility path. */
    fun publishLocalClipboard(text: String, explicit: Boolean = false) {
        if (closed || (!explicit && !prefs.autoClipboard) || text.length > Limits.MAX_CLIPBOARD_TEXT) return
        captureWork.offer(ClipboardCapture(text, explicit))
    }

    private fun flushPendingClipboard() {
        val current = engine ?: return
        val pending = synchronized(stateLock) { pendingClipboard } ?: return
        if (android.os.SystemClock.elapsedRealtime() - pending.at > 60_000) {
            synchronized(stateLock) { pendingClipboard = null }; return
        }
        if (!pending.explicit && !prefs.autoClipboard) {
            synchronized(stateLock) { pendingClipboard = null }; return
        }
        // Clipboard contents must not leak to arbitrary nearby LAN devices.
        val targets = current.peersSnapshot().filter { it.discoveryScope == "paired" }
        if (targets.isEmpty() || current.currentState != ConnectionState.CONNECTED) return
        for (peer in targets) {
            if (pending.deliveredTo.contains(peer.device.publicKey)) continue
            try {
                current.sendClipboardText(peer.peerId, pending.text)
                pending.deliveredTo.add(peer.device.publicKey)
            } catch (e: Exception) { Log.w(TAG, "Clipboard send deferred: ${e.message}") }
        }
        if (targets.all { pending.deliveredTo.contains(it.device.publicKey) }) synchronized(stateLock) {
            lastSynced = pending.text
            lastSyncedAt = android.os.SystemClock.elapsedRealtime()
            if (pendingClipboard === pending) pendingClipboard = null
        }
    }

    /** Commands are small, bounded and executed away from Android's main thread. */
    fun command(raw: String): String {
        if (closed || raw.length > 7_100_000) return failure("Native connection unavailable")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        val task = try {
            worker.submit<String> {
                if (closed || System.nanoTime() >= deadline) return@submit failure("Native operation timed out; try again")
                val current = engine ?: return@submit failure("Native connection is starting. Try again.")
                try {
                    val command = JSONObject(raw)
                    val id = command.optString("transferId")
                    val result: Any? = when (command.getString("method")) {
                        "accept" -> { current.acceptIncomingTransfer(id); null }
                        "decline" -> { current.declineIncomingTransfer(id); null }
                        "cancel" -> { current.cancelTransfer(id); null }
                        "rename" -> { prefs.deviceName = command.getString("name").take(80); current.updateDeviceName(prefs.deviceName); null }
                        "visibility" -> { current.setVisibility(command.getString("value")); prefs.visibility = command.getString("value"); null }
                        "pair" -> { require(current.joinPairCode(command.getString("value"))) { "Invalid pair code" }; null }
                        "rotatePair" -> { current.rotatePairCode(); null }
                        "trust" -> { current.setTrusted(command.getString("key"), command.getBoolean("value")); prefs.trustedKeys = current.trustedKeys(); null }
                        "autoClipboard" -> {
                            prefs.autoClipboard = command.getBoolean("value"); current.autoClipboardSend = prefs.autoClipboard
                            if (!prefs.autoClipboard) synchronized(stateLock) { pendingClipboard = null }
                            null
                        }
                        "receiveClipboard" -> { prefs.receiveClipboard = command.getBoolean("value"); current.clipboardReceiveEnabled = prefs.receiveClipboard; null }
                        "markClipboard" -> { synchronized(stateLock) { lastSynced = command.getString("text"); lastSyncedAt = android.os.SystemClock.elapsedRealtime() }; null }
                        "detectedClipboard" -> { publishLocalClipboard(command.getString("text")); JSONArray() }
                        "clipboard" -> clipJson(current.sendClipboardText(command.getString("peerId"), command.getString("text")))
                        "clipboardImage" -> clipJson(current.sendClipboardImageDataUrl(command.getString("peerId"), command.getString("dataUrl")))
                        "sendFiles" -> {
                            val files = command.getJSONArray("files")
                            require(files.length() in 1..100) { "Select 1–100 files" }
                            val sources = (0 until files.length()).map { index ->
                                val f = files.getJSONObject(index)
                                NativeFiles.source(context, f.getString("sourceId"), f.getLong("size"))
                            }
                            val transferId = current.sendFiles(command.getString("peerId"), sources)
                            transferJson(current.transferView(transferId)!!)
                        }
                        else -> throw IllegalArgumentException("Unknown native command")
                    }
                    refresh()
                    JSONObject().put("ok", true).put("result", result ?: JSONObject.NULL).toString()
                } catch (e: Exception) { failure(e.message ?: "Native operation failed") }
            }
        } catch (e: Exception) { return failure(e.message ?: "Native service stopped") }
        return try { task.get(10, TimeUnit.SECONDS) }
        catch (e: Exception) { task.cancel(false); failure(e.message ?: "Native operation timed out") }
    }

    private fun enqueue(task: () -> Unit) {
        if (closed) return
        try { worker.execute { if (!closed) task() } }
        catch (_: java.util.concurrent.RejectedExecutionException) { /* service is stopping */ }
    }

    /** Coalesce replaceable metadata off the network reader, with bounded work. */
    private fun refresh() { if (!closed) snapshotWork.offer(Unit) }

    /** Build a consistent, bounded metadata snapshot; no file payloads or Blobs. */
    private fun buildSnapshot() {
        val current = engine ?: return
        if (closed) return
        val peers = current.peersSnapshot()
        val transfers = current.transfersSnapshot().sortedByDescending { it.startedAt }
        val security = JSONObject()
        val peersJson = JSONArray()
        for (peer in peers) {
            peersJson.put(JSONObject().put("peerId", peer.peerId).put("device", JSONObject(peer.device.toJson().toJsonString()))
                .put("discoveryScope", peer.discoveryScope).put("connectedAt", peer.connectedAt))
            security.put(peer.peerId, JSONObject().put("sasCode", current.sasCodeFor(peer.peerId) ?: "··· ···")
                .put("fingerprintHex", current.fingerprintFor(peer.peerId) ?: "").put("rtcConnected", false).put("rttMs", JSONObject.NULL))
        }
        val state = JSONObject().put("ready", true)
            .put("connectionState", current.currentState.name.lowercase(java.util.Locale.ROOT))
            .put("connectionError", connectionError ?: JSONObject.NULL)
            .put("peerId", current.myPeerId).put("pairCode", current.myPairCode)
            .put("formattedPairCode", PairCode.format(current.myPairCode)).put("visibility", prefs.visibility)
            .put("myDevice", JSONObject(current.deviceProfileSnapshot().toJson().toJsonString()))
            .put("peers", peersJson).put("peerSecurity", security)
            .put("transfers", JSONArray().also { array -> transfers.forEach { array.put(transferJson(it)) } })
            .put("localDaemon", JSONObject().put("enabled", false).put("platform", "android").put("hostname", "")
                .put("autoSaveToDownloads", true).put("clipboardBridge", true))
            .put("trustedPeerKeys", JSONArray(current.trustedKeys().toList()))
            .put("autoClipboardSync", prefs.autoClipboard).put("clipboardReceiveEnabled", prefs.receiveClipboard)
        synchronized(stateLock) {
            state.put("lanUrls", JSONArray(lanUrls))
            revision++
            state.put("revision", revision).put("clipboardRevision", clipboardRevision)
            snapshot = Snapshot(revision, clipboardRevision, state.toString(), clipboardJson)
        }
    }

    fun reconnect() { engine?.reconnect() }

    override fun close() {
        closed = true
        // Stop first to release ACK waiters and a blocked native command. Engine
        // stop closes sockets and file descriptors; no WebView is referenced.
        engine?.stop()
        worker.shutdownNow()
    }

    companion object {
        private const val TAG = "AirBridgeNative"
        private fun failure(message: String) = JSONObject().put("ok", false).put("error", message).toString()
        private fun clipJson(item: ClipboardItem) = JSONObject()
            .put("beamId", item.beamId).put("peerId", item.peerId).put("peerName", item.peerName)
            .put("direction", item.direction).put("text", if (item.imageDataUrl != null) "" else item.text).put("contentType", item.contentType)
            .put("timestamp", item.timestamp).put("sasCode", item.sasCode)
            .put("imageDataUrl", item.imageDataUrl).put("imageName", item.imageName)

        private fun transferJson(view: TransferView): JSONObject = JSONObject()
            .put("transferId", view.transferId).put("peerId", view.peerId).put("peerName", view.peerName)
            .put("peerPlatform", view.peerPlatform).put("sasCode", view.sasCode)
            .put("direction", if (view.direction == TransferDirection.INCOMING) "incoming" else "outgoing")
            .put("status", view.status).put("transport", view.transport)
            .put("files", JSONArray().also { a -> view.files.forEach { a.put(JSONObject(it.toJson().toJsonString())) } })
            .put("totalBytes", view.totalBytes).put("transferredBytes", view.transferredBytes)
            .put("speedBytesPerSec", view.speedBytesPerSec).put("etaSeconds", view.etaSeconds ?: JSONObject.NULL)
            .put("startedAt", view.startedAt).put("completedAt", view.completedAt).put("errorMessage", view.errorMessage)
            .put("receivedFiles", JSONArray().also { a -> view.receivedFiles.forEach { f ->
                a.put(JSONObject().put("index", f.index).put("name", f.name).put("size", f.size)
                    .put("mimeType", view.files[f.index].mimeType).put("chunks", JSONArray())
                    .put("sha256", f.sha256).put("verified", f.verified).put("savedToDiskPath", f.savedPath))
            } })
    }
}
