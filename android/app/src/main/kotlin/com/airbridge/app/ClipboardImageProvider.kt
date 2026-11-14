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
        val name = uri.lastPathSegment ?: throw FileNotFoundException()
        if (!Regex("^[0-9a-f-]{36}\\.(png|jpeg|jpg|webp|gif|bmp)$").matches(name)) throw FileNotFoundException()
        return File(context!!.cacheDir, "clipboard-images/$name")
    }
    override fun getType(uri: Uri): String = "image/" + resolve(uri).extension.let { if (it == "jpg") "jpeg" else it }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw FileNotFoundException("Read-only provider")
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val file = resolve(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            addRow(columns.map { when (it) { OpenableColumns.DISPLAY_NAME -> file.name; OpenableColumns.SIZE -> file.length(); else -> null } })
        }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()

    companion object {
        fun copyImage(context: Context, dataUrl: String) {
            require(com.airbridge.engine.isValidClipboardImageDataUrl(dataUrl))
            val directory = File(context.cacheDir, "clipboard-images").apply { mkdirs() }
            directory.listFiles()?.sortedByDescending { it.lastModified() }?.drop(7)?.forEach { it.delete() }
            val extension = dataUrl.substringAfter("data:image/").substringBefore(';')
            val file = File(directory, "${UUID.randomUUID()}.$extension")
            file.writeBytes(Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT))
            val uri = Uri.Builder().scheme("content").authority("${context.packageName}.clipboard").appendPath(file.name).build()
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newUri(context.contentResolver, "AirBridge image", uri))
        }
    }
}
