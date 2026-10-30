package com.airbridge.engine

/**
 * Protocol data model — ports of the TypeScript interfaces + validation
 * helpers from src/shared/protocol.ts and src/client/engine/warpClient.ts.
 */

object Limits {
    const val CHUNK_SIZE = 256 * 1024
    const val MIN_CHUNK_SIZE = 16 * 1024
    const val MAX_CHUNK_SIZE = 1024 * 1024
    const val MAX_FILES_PER_TRANSFER = 100
    const val MAX_CHUNKS_PER_TRANSFER = 262_144
    const val MAX_CLIPBOARD_TEXT = 256_000
    const val MAX_CLIPBOARD_IMAGE_DATAURL = 7_000_000
    const val MAX_UNACKED_CHUNKS = 256
    const val ACK_INTERVAL_CHUNKS = 32
    const val MAX_HISTORY = 50
}

data class DeviceProfile(
    val name: String,
    val platform: String,
    val model: String,
    val formFactor: String,
    val publicKey: String,
    val deviceId: String? = null,
) {
    fun toJson(): JsonValue.Obj {
        val o = JsonValue.Obj()
            .put("name", name)
            .put("platform", platform)
            .put("model", model)
            .put("formFactor", formFactor)
            .put("publicKey", publicKey)
        if (deviceId != null) o.put("deviceId", deviceId)
        return o
    }

    companion object {
        fun fromJson(o: JsonValue.Obj): DeviceProfile = DeviceProfile(
            name = o.optStr("name") ?: "AirBridge Device",
            platform = o.optStr("platform") ?: "unknown",
            model = o.optStr("model") ?: "Device",
            formFactor = o.optStr("formFactor") ?: "laptop",
            publicKey = o.optStr("publicKey") ?: "",
            deviceId = o.optStr("deviceId"),
        )
    }
}

data class Peer(
    val peerId: String,
    val device: DeviceProfile,
    val discoveryScope: String,
    val connectedAt: Long,
)

data class FileManifestItem(
    val index: Int,
    val name: String,
    val relativePath: String?,
    val size: Long,
    val mimeType: String,
    val totalChunks: Int,
    val chunkSize: Int,
    val previewDataUrl: String? = null,
) {
    fun toJson(): JsonValue.Obj {
        val o = JsonValue.Obj()
            .put("index", index.toLong())
            .put("name", name)
            .put("size", size)
            .put("mimeType", mimeType)
            .put("totalChunks", totalChunks.toLong())
            .put("chunkSize", chunkSize.toLong())
        if (relativePath != null) o.put("relativePath", relativePath)
        if (previewDataUrl != null) o.put("previewDataUrl", previewDataUrl)
        return o
    }

    companion object {
        fun fromJson(o: JsonValue.Obj): FileManifestItem = FileManifestItem(
            index = o.optInt("index") ?: -1,
            name = o.optStr("name") ?: "",
            relativePath = o.optStr("relativePath"),
            size = o.optLong("size") ?: -1,
            mimeType = o.optStr("mimeType") ?: "application/octet-stream",
            totalChunks = o.optInt("totalChunks") ?: -1,
            chunkSize = o.optInt("chunkSize") ?: -1,
            previewDataUrl = o.optStr("previewDataUrl"),
        )
    }
}

data class ReceivedFileInfo(
    val index: Int,
    val name: String,
    val size: Long,
    val sha256: String,
    val verified: Boolean,
    val savedPath: String,
)

enum class TransferDirection { INCOMING, OUTGOING }

object TransferStatus {
    const val PENDING_ACCEPT = "pending-accept"
    const val CONNECTING = "connecting"
    const val TRANSFERRING = "transferring"
    const val COMPLETED = "completed"
    const val DECLINED = "declined"
    const val CANCELLED = "cancelled"
    const val ERROR = "error"
}

/** Immutable snapshot of one transfer for UI consumption. */
data class TransferView(
    val transferId: String,
    val peerId: String,
    val peerName: String,
    val peerPlatform: String,
    val sasCode: String,
    val direction: TransferDirection,
    val status: String,
    val transport: String,
    val files: List<FileManifestItem>,
    val totalBytes: Long,
    val transferredBytes: Long,
    val speedBytesPerSec: Double,
    val etaSeconds: Long?,
    val startedAt: Long,
    val completedAt: Long?,
    val receivedFiles: List<ReceivedFileInfo>,
    val errorMessage: String?,
)

data class ClipboardItem(
    val beamId: String,
    val peerId: String,
    val peerName: String,
    val direction: String, // "incoming" | "outgoing"
    val text: String,
    val imageDataUrl: String?,
    val imageName: String?,
    val contentType: String,
    val timestamp: Long,
    val sasCode: String,
)

enum class ConnectionState { CONNECTING, CONNECTED, RECONNECTING, DISCONNECTED }

data class WelcomeInfo(
    val peerId: String,
    val pairCode: String,
    val lanUrls: List<String>,
)

interface EngineListener {
    fun onConnectionState(state: ConnectionState) {}
    fun onWelcome(info: WelcomeInfo) {}
    fun onPeersChanged(peers: List<Peer>) {}
    fun onPairCodeChanged(pairCode: String) {}
    /** A new incoming offer awaiting the user's decision (or auto-accepted). */
    fun onIncomingOffer(transfer: TransferView) {}
    /** Any transfer mutation: progress, status, completion. */
    fun onTransferChanged(transfer: TransferView) {}
    fun onClipboard(item: ClipboardItem) {}
    fun onLocalClipboardBeam(item: ClipboardItem) {}
    fun onError(code: String, message: String) {}
}

// ---------------------------------------------------------------------------
// Manifest validation — port of isValidFileManifest (warpClient.ts)
// ---------------------------------------------------------------------------

fun isValidFileManifest(filesValue: JsonValue?, totalBytes: Long?): Boolean {
    val arr = filesValue as? JsonValue.JsonArr ?: return false
    if (totalBytes == null || totalBytes < 0) return false
    if (arr.size == 0 || arr.size > Limits.MAX_FILES_PER_TRANSFER) return false
    var sum = 0L
    var chunks = 0L
    for (i in 0 until arr.size) {
        val f = arr[i] as? JsonValue.Obj ?: return false
        if (f.optLong("index") != i.toLong()) return false
        val name = f.optStr("name") ?: return false
        if (name.isEmpty() || name.length > 512) return false
        val size = f.optLong("size") ?: return false
        if (size < 0) return false
        val chunkSize = f.optLong("chunkSize") ?: return false
        if (chunkSize < Limits.MIN_CHUNK_SIZE || chunkSize > Limits.MAX_CHUNK_SIZE) return false
        val expectedChunks = maxOf(1L, (size + chunkSize - 1) / chunkSize)
        val totalChunks = f.optLong("totalChunks") ?: return false
        if (totalChunks != expectedChunks) return false
        val preview = f.optStr("previewDataUrl")
        if (preview != null &&
            (preview.length > 16_000 || !preview.startsWith("data:image/"))
        ) return false
        sum += size
        chunks += totalChunks
        if (chunks > Limits.MAX_CHUNKS_PER_TRANSFER) return false
    }
    return sum == totalBytes
}

internal fun JsonValue.asLongOrNull(): Long? = when (this) {
    is JsonValue.JsonLong -> value
    is JsonValue.JsonDouble -> value.toLong()
    else -> null
}

// ---------------------------------------------------------------------------
// Clipboard text classification — port of classifyTextPayload (protocol.ts)
// ---------------------------------------------------------------------------

val IMAGE_DATA_URL_REGEX = Regex(
    "^data:image/(png|jpeg|jpg|webp|gif|bmp);base64,"
)

fun isValidClipboardImageDataUrl(dataUrl: String): Boolean =
    dataUrl.isNotEmpty() &&
        dataUrl.length <= Limits.MAX_CLIPBOARD_IMAGE_DATAURL &&
        IMAGE_DATA_URL_REGEX.containsMatchIn(dataUrl) &&
        dataUrl.startsWith("data:image/")

fun classifyTextPayload(text: String): String {
    val trimmed = text.trim()
    if (isValidClipboardImageDataUrl(trimmed)) return "image"
    if (Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(trimmed)) return "url"
    if (Regex("^\\d{4,8}$").matches(trimmed) ||
        Regex("\\b(?:code|otp|pin|verification)\\b.*?\\b\\d{4,8}\\b", RegexOption.IGNORE_CASE)
            .containsMatchIn(trimmed)
    ) return "otp"
    if (trimmed.contains('\n') &&
        trimmed.any { it in "{};()=>[]" } &&
        (Regex("\\b(const|let|function|import|export|class|def|return|curl|npm|brew|adb)\\b")
            .containsMatchIn(trimmed) ||
            trimmed.startsWith("{") ||
            trimmed.startsWith("$ "))
    ) return "code"
    return "text"
}

fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var exp = 0
    while (value >= 1024 && exp < units.size - 1) {
        value /= 1024
        exp++
    }
    val rendered = if (exp == 0) value.toInt().toString()
    else if (value >= 100 || value >= 10) String.format("%.1f", value)
    else String.format("%.2f", value)
    return "$rendered ${units[exp]}"
}
