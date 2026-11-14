package com.airbridge.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.airbridge.engine.DirectoryFileSink
import com.airbridge.engine.FileManifestItem
import com.airbridge.engine.FileSink
import com.airbridge.engine.FileSinkFactory
import com.airbridge.engine.FileSource
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID

/** URI capabilities stay in native code: file bytes never cross the JS bridge. */
object NativeFiles {
    private data class Pick(val uri: Uri, val name: String, val size: Long, var claimed: Boolean = false)
    private val picks = LinkedHashMap<String, Pick>()

    @Synchronized
    fun remember(context: Context, uris: List<Uri>) {
        for (uri in uris.take(100)) {
            var name = uri.lastPathSegment ?: "file"
            var size = -1L
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    if (!cursor.isNull(0)) name = cursor.getString(0)
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
            picks[UUID.randomUUID().toString()] = Pick(uri, name, size)
        }
        while (picks.size > 200) picks.remove(picks.keys.first())
    }

    @Synchronized
    fun claim(name: String, size: Long): String = picks.entries.firstOrNull {
        !it.value.claimed && it.value.name == name && (it.value.size < 0 || it.value.size == size)
    }?.let { it.value.claimed = true; it.key }.orEmpty()

    @Synchronized
    fun source(context: Context, token: String, declaredSize: Long): FileSource {
        val pick = picks[token] ?: throw IOException("Choose the file again; its URI permission expired.")
        require(declaredSize >= 0 && (pick.size < 0 || declaredSize == pick.size)) { "Source size changed" }
        return UriSource(context.applicationContext, pick.uri, pick.name, declaredSize)
    }

    /** One sequential provider stream, not an O(file size) reopen/skip per chunk. */
    private class UriSource(
        val context: Context, val uri: Uri, override val name: String, override val size: Long,
    ) : FileSource {
        override val mimeType: String = context.contentResolver.getType(uri) ?: "application/octet-stream"
        private var input: InputStream? = null
        private var position = 0L

        @Synchronized
        override fun readRange(start: Long, end: Long): ByteArray {
            require(start >= 0 && end >= start && end <= size && end - start <= 1024 * 1024)
            if (start < position) close()
            val stream = input ?: (context.contentResolver.openInputStream(uri)
                ?: throw IOException("Cannot read $name")).also { input = it; position = 0 }
            while (position < start) {
                val skipped = stream.skip(start - position)
                if (skipped > 0) position += skipped
                else if (stream.read() >= 0) position++ else throw IOException("Source is truncated")
            }
            val bytes = ByteArray((end - start).toInt())
            var offset = 0
            while (offset < bytes.size) {
                val read = stream.read(bytes, offset, bytes.size - offset)
                if (read < 0) throw IOException("Source is truncated")
                if (read > 0) { offset += read; position += read }
            }
            return bytes
        }

        @Synchronized
        override fun close() { input?.close(); input = null; position = 0 }
    }
}

/** Verified private staging -> Android Downloads, without keeping a file-sized Blob in RAM. */
class AndroidFileSinkFactory(private val context: Context) : FileSinkFactory {
    private val staging = File(context.filesDir, "incoming")

    override fun open(transferId: String, meta: FileManifestItem): FileSink =
        DirectoryFileSink(staging, meta, transferId) { part, name -> publish(part, safeName(name), meta.mimeType) }

    private fun safeName(raw: String): String = raw.substringAfterLast('/').substringAfterLast('\\')
        .map { if (it.isISOControl() || it in ":*?\"<>|") '_' else it }.joinToString("")
        .trim().take(120).takeUnless { it.isEmpty() || it == "." || it == ".." } ?: "airbridge-file"

    private fun publish(part: File, name: String, mime: String): File {
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
                resolver.openOutputStream(uri, "w")?.use { out -> part.inputStream().use { it.copyTo(out, 256 * 1024) } }
                    ?: throw IOException("Could not write Downloads")
                if (resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) != 1) {
                    throw IOException("Could not publish Downloads item")
                }
                part.delete()
                // The UI displays a location, never opens this as a JVM file.
                return File("/Download/AirBridge/$name")
            } catch (e: Exception) {
                runCatching { resolver.delete(uri, null, null) }
                throw e
            }
        }
        @Suppress("DEPRECATION")
        val publicDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "AirBridge")
        // Android 8/9 may not have the legacy storage permission. Always retain
        // a verified file in app-specific Downloads rather than failing late.
        val dir = if ((publicDir.isDirectory || publicDir.mkdirs()) && publicDir.canWrite()) publicDir
            else File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir, "AirBridge")
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create Downloads folder")
        val target = uniqueFile(dir, name)
        try {
            part.inputStream().use { input -> target.outputStream().use { input.copyTo(it, 256 * 1024) } }
        } catch (e: Exception) { target.delete(); throw e }
        part.delete()
        return target
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
