package com.airbridge.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Base64
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** Read-only, URI-granted image clipboard. Never exports arbitrary app files. */
class ClipboardImageProvider : ContentProvider() {
    override fun onCreate() = true

    private fun resolve(uri: Uri): File {
        val ctx = context ?: throw FileNotFoundException("Provider context unavailable")
        val name = uri.lastPathSegment ?: throw FileNotFoundException("Missing clipboard image name")
        return resolveExistingFile(ctx.cacheDir, name)
    }

    override fun getType(uri: Uri): String {
        val file = resolve(uri)
        return "image/" + file.extension.let { if (it == "jpg") "jpeg" else it }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw FileNotFoundException("Read-only provider")
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val file = resolve(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            addRow(
                columns.map {
                    when (it) {
                        OpenableColumns.DISPLAY_NAME -> file.name
                        OpenableColumns.SIZE -> file.length()
                        else -> null
                    }
                },
            )
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()

    companion object {
        private val fileNameRegex = Regex("^[0-9a-f-]{36}\\.(png|jpeg|jpg|webp|gif|bmp)$")

        /**
         * Validates that [name] is an allowlisted UUID image filename in `clipboard-images/`
         * and that the backing file currently exists on disk (throwing [FileNotFoundException]
         * if evicted or missing, never returning a 0-byte phantom cursor row).
         */
        internal fun resolveExistingFile(cacheDir: File, name: String?): File {
            if (name == null || !fileNameRegex.matches(name)) {
                throw FileNotFoundException("Invalid clipboard image path")
            }
            val file = File(cacheDir, "clipboard-images/$name")
            if (!file.isFile) {
                throw FileNotFoundException("Clipboard image no longer exists")
            }
            return file
        }

        internal fun extensionForMime(mime: String): String = when (mime.lowercase()) {
            "image/jpeg", "image/jpg" -> "jpg"
            "image/png" -> "png"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            else -> "png"
        }

        internal fun parseImageDataUrl(dataUrl: String): Pair<String, ByteArray>? {
            if (!com.airbridge.engine.isValidClipboardImageDataUrl(dataUrl)) return null
            val mime = dataUrl.substringAfter("data:").substringBefore(';').lowercase()
            val payload = dataUrl.substringAfter(',', "")
            if (payload.isEmpty()) return null
            val bytes = runCatching { java.util.Base64.getDecoder().decode(payload) }
                .getOrElse { Base64.decode(payload, Base64.DEFAULT) }
            if (bytes.isEmpty()) return null
            return extensionForMime(mime) to bytes
        }

        fun copyImage(context: Context, dataUrl: String) {
            val (extension, bytes) = parseImageDataUrl(dataUrl)
                ?: throw IllegalArgumentException("Invalid clipboard image data URL")
            ConnectionService.markOwnClipboardImageWrite()
            val directory = File(context.cacheDir, "clipboard-images").apply { mkdirs() }
            directory.listFiles()?.sortedByDescending { it.lastModified() }?.drop(7)?.forEach { it.delete() }
            val file = File(directory, "${UUID.randomUUID()}.$extension")
            file.writeBytes(bytes)
            val uri = Uri.Builder().scheme("content").authority("${context.packageName}.clipboard").appendPath(file.name).build()
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newUri(context.contentResolver, "AirBridge image", uri))
            ConnectionService.markOwnClipboardImageWrite()
        }
    }
}
