package com.airbridge.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.compose.runtime.Immutable
import com.airbridge.engine.DirectoryFileSink
import com.airbridge.engine.FileFinalize
import com.airbridge.engine.FileManifestItem
import com.airbridge.engine.FileSink
import com.airbridge.engine.FileSinkFactory
import com.airbridge.engine.FileSource
import com.airbridge.engine.JsonValue
import com.airbridge.engine.Limits
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.BitSet

/** URI capabilities stay in native code: file bytes never cross UI/VM state boundaries. */
object NativeFiles {
    @Immutable
    data class PickedUriMeta(
        val uri: Uri,
        val name: String,
        val size: Long,
        val mimeType: String,
    )

    fun inspectUri(context: Context, uri: Uri): PickedUriMeta {
        val resolver = context.contentResolver
        var name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                if (!cursor.isNull(0)) name = cursor.getString(0).takeIf { it.isNotBlank() } ?: name
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
        if (size < 0L) {
            size = runCatching {
                resolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
            }.getOrNull()?.takeIf { it >= 0L } ?: -1L
        }
        if (size < 0L) {
            // Last resort for virtual / non-statable streams: count bytes once so readRange bounds stay exact.
            var total = 0L
            resolver.openInputStream(uri)?.use { inp ->
                val skipBuf = ByteArray(32 * 1024)
                while (true) {
                    val r = inp.read(skipBuf)
                    if (r < 0) break
                    total += r
                }
            }
            size = total
        }
        val mime = resolver.getType(uri)?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        return PickedUriMeta(uri, name, maxOf(0L, size), mime)
    }

    fun openUriSource(context: Context, uri: Uri): FileSource {
        val meta = inspectUri(context, uri)
        return UriSource(context.applicationContext, meta.uri, meta.name, meta.size)
    }

    fun clipboardImageDataUrlFromUri(context: Context, uri: Uri): String {
        val resolver = context.contentResolver
        val rawMime = resolver.getType(uri)?.lowercase(java.util.Locale.ROOT).orEmpty()
        val mime = when {
            rawMime == "image/jpg" -> "image/jpeg"
            rawMime in setOf("image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp") -> rawMime
            else -> "image/png"
        }
        val maxRawBytes = ((Limits.MAX_CLIPBOARD_IMAGE_DATAURL - 64) * 3L / 4L).toInt()
        val bytes = resolver.openInputStream(uri)?.use { inp ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(32 * 1024)
            var total = 0
            while (true) {
                val r = inp.read(buf)
                if (r < 0) break
                total += r
                require(total <= maxRawBytes) { "Image exceeds maximum 5 MB clipboard limit" }
                out.write(buf, 0, r)
            }
            out.toByteArray()
        } ?: throw IOException("Could not open selected image")
        val dataUrl = "data:$mime;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        require(com.airbridge.engine.isValidClipboardImageDataUrl(dataUrl)) {
            "Selected image exceeds size or format limits"
        }
        return dataUrl
    }

    /** Direct FileChannel pread for seekable URIs, falling back to buffered stream for pipe providers. */
    private class UriSource(
        val context: Context, val uri: Uri, override val name: String, override val size: Long,
    ) : FileSource {
        override val mimeType: String = context.contentResolver.getType(uri) ?: "application/octet-stream"
        private var pfd: ParcelFileDescriptor? = null
        private var pfdStream: FileInputStream? = null
        private var channel: FileChannel? = null
        private var channelDisabled = false
        private var input: InputStream? = null
        private var position = 0L

        @Synchronized
        override fun readRange(start: Long, end: Long): ByteArray {
            require(start >= 0 && end >= start && end <= size && end - start <= Limits.MAX_CHUNK_SIZE)
            val len = (end - start).toInt()
            if (len == 0) return ByteArray(0)

            if (!channelDisabled) {
                try {
                    val ch = channel ?: context.contentResolver.openFileDescriptor(uri, "r")?.let { desc ->
                        val fis = FileInputStream(desc.fileDescriptor)
                        val c = fis.channel
                        pfd = desc
                        pfdStream = fis
                        channel = c
                        c
                    } ?: throw IOException("No descriptor")
                    val bytes = ByteArray(len)
                    val buf = ByteBuffer.wrap(bytes)
                    var pos = start
                    while (buf.hasRemaining()) {
                        val n = ch.read(buf, pos)
                        if (n < 0) throw IOException("Source is truncated")
                        pos += n
                    }
                    return bytes
                } catch (_: Exception) {
                    closeChannelOnly()
                    channelDisabled = true
                }
            }

            if (start < position) closeStreamOnly()
            val stream = input ?: BufferedInputStream(
                context.contentResolver.openInputStream(uri)
                    ?: throw IOException("Cannot read $name"),
                512 * 1024,
            ).also { input = it; position = 0 }
            while (position < start) {
                val skipped = stream.skip(start - position)
                if (skipped > 0) position += skipped
                else if (stream.read() >= 0) position++ else throw IOException("Source is truncated")
            }
            val bytes = ByteArray(len)
            var offset = 0
            while (offset < len) {
                val read = stream.read(bytes, offset, len - offset)
                if (read < 0) throw IOException("Source is truncated")
                if (read > 0) { offset += read; position += read }
            }
            return bytes
        }

        private fun closeChannelOnly() {
            runCatching { channel?.close() }
            runCatching { pfdStream?.close() }
            runCatching { pfd?.close() }
            channel = null
            pfdStream = null
            pfd = null
        }

        private fun closeStreamOnly() {
            runCatching { input?.close() }
            input = null
            position = 0
        }

        @Synchronized
        override fun close() {
            closeChannelOnly()
            closeStreamOnly()
        }
    }
}

/**
 * Direct-to-Downloads streaming sink on Android 10+ (zero post-transfer copy!),
 * falling back transparently to private staging + copy if an OEM MediaStore
 * provider rejects direct "rw" FileChannel access or on Android 8/9.
 */
class AndroidFileSinkFactory(private val context: Context) : FileSinkFactory {
    private val staging = File(context.filesDir, "incoming")
    private val mediaMetaDir = File(context.filesDir, "incoming_ms")

    override fun open(transferId: String, meta: FileManifestItem): FileSink {
        val cleanName = safeName(meta.name)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                AndroidDiagnostics.storageSinkType = "mediastore"
                return MediaStoreFileSink(context.applicationContext, mediaMetaDir, meta, transferId, cleanName)
            } catch (_: Exception) {
                // OEM provider refused "rw" MediaStore fd; fall back cleanly to staged publish.
            }
        }
        AndroidDiagnostics.storageSinkType = "staging"
        return DirectoryFileSink.withLocationFinisher(staging, meta, transferId) { part, _ ->
            publishLegacyOrFallback(part, cleanName, meta.mimeType)
        }
    }

    private fun safeName(raw: String): String = raw.substringAfterLast('/').substringAfterLast('\\')
        .map { if (it.isISOControl() || it in ":*?\"<>|") '_' else it }.joinToString("")
        .trim().take(120).takeUnless { it.isEmpty() || it == "." || it == ".." } ?: "airbridge-file"

    private fun publishLegacyOrFallback(part: File, name: String, mime: String): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AirBridge")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("Could not open Downloads")
            try {
                resolver.openOutputStream(uri, "w")?.use { out -> part.inputStream().use { it.copyTo(out, 512 * 1024) } }
                    ?: throw IOException("Could not write Downloads")
                if (resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) != 1) {
                    throw IOException("Could not publish Downloads item")
                }
                part.delete()
                return uri.toString()
            } catch (e: Exception) {
                AndroidDiagnostics.storageLastError = e.message
                runCatching { resolver.delete(uri, null, null) }
                throw e
            }
        }
        // Android 8/9 cannot use scoped MediaStore Downloads. Keep the file in
        // AirBridge's app-specific external Downloads directory instead of
        // writing the shared public Downloads folder through deprecated legacy
        // storage APIs. No storage permission is required and uninstall removes
        // these files, so the UI must expose the resulting location clearly.
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir, "AirBridge")
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create AirBridge downloads folder")
        val target = uniqueFile(dir, name)
        try {
            part.inputStream().use { input -> target.outputStream().use { input.copyTo(it, 512 * 1024) } }
        } catch (e: Exception) {
            AndroidDiagnostics.storageLastError = e.message
            target.delete()
            throw e
        }
        part.delete()
        return target.absolutePath
    }

    private fun uniqueFile(dir: File, name: String): File {
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        for (index in 0..10_000) {
            val candidate = File(dir, if (index == 0) name else "$stem ($index)$ext")
            if (candidate.createNewFile()) return candidate
        }
        throw IOException("Too many files with this name")
    }
}

/**
 * Resumable MediaStore sink (API 29+): streams incoming chunks directly into a
 * pending `MediaStore.Downloads` entry (`IS_PENDING = 1`), tracks durability in a
 * compact sidecar + append-only 4B journal, verifies SHA-256 *before* clearing
 * `IS_PENDING = 0`, and deletes the pending MediaStore row on mismatch/cancel.
 */
@android.annotation.TargetApi(Build.VERSION_CODES.Q)
private class MediaStoreFileSink(
    context: Context,
    metaDir: File,
    private val meta: FileManifestItem,
    private val transferId: String,
    private val cleanName: String,
) : FileSink {
    private val resolver = context.contentResolver
    private val sidecar = File(metaDir, "$transferId.${meta.index}.meta")
    private val journalFile = File(metaDir, "$transferId.${meta.index}.journal")
    private val received = BitSet()
    private val pendingJournal = ArrayList<Int>()
    private var mediaUri: Uri
    private var pfd: ParcelFileDescriptor? = null
    private var fos: FileOutputStream? = null
    private var channel: FileChannel? = null
    private var journalOut: FileOutputStream? = null
    private var journalAligned = false
    private var hasSnapshot = false
    private var complete = false
    private var finalized = false
    private var paused = false
    @Volatile private var discarded = false
    private var error: String? = null
    private var streamDigest: MessageDigest? = MessageDigest.getInstance("SHA-256")
    private var nextHashChunk = 0
    private val pendingHashChunks = HashMap<Int, ByteArray>()

    init {
        require(Regex("^[0-9a-f]{16}$").matches(transferId)) { "Invalid transfer ID" }
        require(meta.index in 0 until Limits.MAX_FILES_PER_TRANSFER && meta.size >= 0 &&
            meta.chunkSize in 1..Limits.MAX_CHUNK_SIZE && meta.totalChunks in 1..Limits.MAX_CHUNKS_PER_TRANSFER &&
            meta.size <= meta.chunkSize.toLong() * Limits.MAX_CHUNKS_PER_TRANSFER &&
            meta.totalChunks.toLong() == maxOf(1L, (meta.size + meta.chunkSize - 1) / meta.chunkSize))
        if (!metaDir.isDirectory && !metaDir.mkdirs()) throw IOException("Cannot create metadata directory")

        var restoredUri: Uri? = null
        if (sidecar.exists()) {
            try {
                val o = JsonValue.parseObject(sidecar.readText(Charsets.UTF_8))
                require(o.optStr("name") == meta.name && o.optLong("size") == meta.size &&
                    o.optInt("chunkSize") == meta.chunkSize && o.optInt("totalChunks") == meta.totalChunks)
                val uriStr = o.optStr("mediaUri")
                if (!uriStr.isNullOrEmpty()) {
                    restoredUri = Uri.parse(uriStr)
                    (o.optArr("received") ?: JsonValue.JsonArr()).items.forEach { v ->
                        val idx = v.asInt()
                        if (idx in 0 until meta.totalChunks) received.set(idx)
                    }
                    complete = o.optBool("complete") ?: false
                    hasSnapshot = true
                }
            } catch (_: Exception) {
                restoredUri = null
                received.clear()
            }
        }

        if (restoredUri != null && hasSnapshot) {
            val opened = runCatching { openDescriptor(restoredUri) }.getOrNull()
            if (opened != null) {
                mediaUri = restoredUri
                pfd = opened.first; fos = opened.second; channel = opened.third
                replayJournal()
                if (!received.isEmpty) streamDigest = null
            } else {
                received.clear()
                hasSnapshot = false
                journalFile.delete()
                sidecar.delete()
                mediaUri = createPendingRowAndOpen()
            }
        } else {
            mediaUri = createPendingRowAndOpen()
        }
    }

    private fun openDescriptor(uri: Uri): Triple<ParcelFileDescriptor, FileOutputStream, FileChannel> {
        val desc = resolver.openFileDescriptor(uri, "rw") ?: throw IOException("Unable to open MediaStore rw descriptor")
        return try {
            val stream = FileOutputStream(desc.fileDescriptor)
            val ch = stream.channel
            Triple(desc, stream, ch)
        } catch (e: Exception) {
            runCatching { desc.close() }
            throw e
        }
    }

    private fun createPendingRowAndOpen(): Uri {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, cleanName)
            put(MediaStore.MediaColumns.MIME_TYPE, meta.mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AirBridge")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("Could not insert pending Downloads entry")
        try {
            val opened = openDescriptor(uri)
            pfd = opened.first; fos = opened.second; channel = opened.third
            return uri
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
    }

    private fun replayJournal() {
        try {
            if (!journalFile.exists()) return
            val aligned = journalFile.length() - journalFile.length() % JOURNAL_ENTRY_BYTES
            if (aligned != journalFile.length()) {
                RandomAccessFile(journalFile, "rw").use { it.setLength(aligned) }
            }
            val bytes = journalFile.readBytes()
            var offset = 0
            while (offset + JOURNAL_ENTRY_BYTES <= bytes.size) {
                val index = ((bytes[offset].toInt() and 0xff) shl 24) or
                    ((bytes[offset + 1].toInt() and 0xff) shl 16) or
                    ((bytes[offset + 2].toInt() and 0xff) shl 8) or
                    (bytes[offset + 3].toInt() and 0xff)
                if (index in 0 until meta.totalChunks) received.set(index)
                offset += JOURNAL_ENTRY_BYTES
            }
        } catch (_: Exception) {}
    }

    @Synchronized override fun resumeFrom(): Int = minOf(meta.totalChunks, received.nextClearBit(0))
    @Synchronized override fun hasReceived(chunkIndex: Int): Boolean = received.get(chunkIndex)
    @Synchronized override fun receivedCount(): Int = received.cardinality()

    @Synchronized
    override fun store(chunkIndex: Int, data: ByteArray) {
        require(!finalized && !paused && !discarded && chunkIndex in 0 until meta.totalChunks) { "Invalid chunk index" }
        val expected = minOf(meta.chunkSize.toLong(), maxOf(0L, meta.size - chunkIndex * meta.chunkSize.toLong())).toInt()
        require(data.size == expected) { "Chunk length does not match manifest" }
        if (received.get(chunkIndex)) return
        try {
            val ch = channel ?: openDescriptor(mediaUri).let { pfd = it.first; fos = it.second; channel = it.third; it.third }
            val buf = ByteBuffer.wrap(data)
            var pos = chunkIndex * meta.chunkSize.toLong()
            while (buf.hasRemaining()) {
                pos += ch.write(buf, pos)
            }
            if (streamDigest != null) {
                if (chunkIndex == nextHashChunk) {
                    streamDigest?.update(data)
                    nextHashChunk++
                    while (pendingHashChunks.containsKey(nextHashChunk)) {
                        val nextData = pendingHashChunks.remove(nextHashChunk) ?: break
                        streamDigest?.update(nextData)
                        nextHashChunk++
                    }
                } else if (chunkIndex > nextHashChunk && pendingHashChunks.size < 64) {
                    pendingHashChunks[chunkIndex] = data
                } else {
                    streamDigest = null
                    pendingHashChunks.clear()
                }
            }
            received.set(chunkIndex)
            pendingJournal.add(chunkIndex)
            if (!hasSnapshot) {
                persistSidecar()
                pendingJournal.clear()
                closeJournal()
                journalFile.delete()
            } else if (pendingJournal.size >= JOURNAL_FLUSH_CHUNKS || chunkIndex == meta.totalChunks - 1) {
                flushJournal()
            }
        } catch (e: Exception) {
            error = e.message ?: "MediaStore write failed"
            AndroidDiagnostics.storageLastError = error
            throw IOException("MediaStore write failed: ${e.message}", e)
        }
    }

    private fun persistSidecar() {
        val o = JsonValue.Obj()
            .put("name", meta.name).put("size", meta.size)
            .put("chunkSize", meta.chunkSize).put("totalChunks", meta.totalChunks)
            .put("mediaUri", mediaUri.toString())
            .put("received", JsonValue.JsonArr(received.stream().toArray().map { JsonValue.JsonLong(it.toLong()) }.toMutableList()))
            .put("complete", complete)
        val tmp = File(sidecar.parentFile, sidecar.name + ".tmp")
        tmp.writeText(o.toJsonString(), Charsets.UTF_8)
        if (!tmp.renameTo(sidecar)) {
            sidecar.writeText(o.toJsonString(), Charsets.UTF_8)
            tmp.delete()
        }
        hasSnapshot = true
    }

    private fun flushJournal() {
        if (pendingJournal.isEmpty()) return
        if (!journalAligned) {
            closeJournal()
            if (journalFile.exists() && journalFile.length() % JOURNAL_ENTRY_BYTES != 0L) {
                RandomAccessFile(journalFile, "rw").use { it.setLength(it.length() - it.length() % JOURNAL_ENTRY_BYTES) }
            }
            journalAligned = true
        }
        val bytes = ByteArray(pendingJournal.size * JOURNAL_ENTRY_BYTES)
        pendingJournal.forEachIndexed { i, idx ->
            val o = i * JOURNAL_ENTRY_BYTES
            bytes[o] = (idx ushr 24).toByte(); bytes[o + 1] = (idx ushr 16).toByte()
            bytes[o + 2] = (idx ushr 8).toByte(); bytes[o + 3] = idx.toByte()
        }
        val out = journalOut ?: FileOutputStream(journalFile, true).also { journalOut = it }
        out.write(bytes)
        pendingJournal.clear()
    }

    @Synchronized
    override fun markComplete() {
        complete = true
        runCatching {
            persistSidecar()
            pendingJournal.clear()
            closeJournal()
            journalFile.delete()
        }
    }

    @Synchronized
    override fun finalizeIfReady(declaredSha256: String?, force: Boolean): FileFinalize? {
        if (finalized || discarded || paused) return null
        val allArrived = received.cardinality() >= meta.totalChunks
        if (!allArrived && !force) return null
        if (!allArrived && force) {
            error = error ?: "Transfer incomplete: some chunks never arrived."
            AndroidDiagnostics.storageLastError = error
            closeHandle()
            return null
        }
        if (declaredSha256 == null || !Regex("^[0-9a-f]{64}$").matches(declaredSha256)) {
            error = "Missing or invalid SHA-256 digest; file was not published."
            AndroidDiagnostics.storageLastError = error
            closeHandle()
            return null
        }
        try {
            flushJournal()
            closeHandle()
            val hex = if (streamDigest != null && nextHashChunk == meta.totalChunks) {
                // Fast check size via read descriptor before hashing
                resolver.openFileDescriptor(mediaUri, "r")?.use { desc ->
                    if (meta.size > 0L && desc.statSize >= 0L && desc.statSize != meta.size) {
                        throw IOException("MediaStore file length mismatch (${desc.statSize} != ${meta.size})")
                    }
                }
                streamDigest!!.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            } else {
                val hash = MessageDigest.getInstance("SHA-256")
                var totalRead = 0L
                resolver.openInputStream(mediaUri)?.use { inp ->
                    val buf = ByteArray(512 * 1024)
                    while (true) {
                        val n = inp.read(buf)
                        if (n == -1) break
                        hash.update(buf, 0, n)
                        totalRead += n
                    }
                } ?: throw IOException("Unable to verify MediaStore file")
                if (totalRead != meta.size) throw IOException("MediaStore file length mismatch ($totalRead != ${meta.size})")
                hash.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            }
            if (declaredSha256 != hex) {
                error = "SHA-256 verification failed; partial file discarded."
                AndroidDiagnostics.storageLastError = error
                discard()
                return null
            }
            if (discarded) return null
            if (resolver.update(mediaUri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) != 1) {
                throw IOException("Could not publish Downloads item")
            }
            sidecar.delete()
            journalFile.delete()
            error = null
            finalized = true
            return FileFinalize(mediaUri.toString(), hex, true)
        } catch (e: Exception) {
            error = e.message ?: "MediaStore finalize failed"
            AndroidDiagnostics.storageLastError = error
            return null
        }
    }

    private fun closeJournal() {
        runCatching { journalOut?.close() }
        journalOut = null
        journalAligned = false
    }

    private fun closeHandle() {
        closeJournal()
        pendingHashChunks.clear()
        runCatching { channel?.close() }
        runCatching { fos?.close() }
        runCatching { pfd?.close() }
        channel = null; fos = null; pfd = null
    }

    @Synchronized
    override fun pause() {
        paused = true
        try { if (!finalized) flushJournal() } finally { closeHandle() }
    }

    override fun discard() {
        discarded = true
        synchronized(this) {
            closeHandle()
            if (!finalized) runCatching { resolver.delete(mediaUri, null, null) }
            sidecar.delete()
            journalFile.delete()
            received.clear()
            pendingJournal.clear()
        }
    }

    @Synchronized override fun lastError(): String? = error

    private companion object {
        const val JOURNAL_ENTRY_BYTES = 4
        const val JOURNAL_FLUSH_CHUNKS = 32
    }
}
