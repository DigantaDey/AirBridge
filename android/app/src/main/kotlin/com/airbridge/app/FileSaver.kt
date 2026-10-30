package com.airbridge.app

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Writes received files into the user's Downloads folder.
 *
 * On Android 10+ the scoped-storage-friendly path is a [MediaStore.Downloads]
 * insert (no permission needed); on older versions we fall back to the public
 * Downloads directory, which the app is allowed to write because the manifest
 * gates `WRITE_EXTERNAL_STORAGE` at `maxSdkVersion=28`.
 */
object FileSaver {

    fun save(context: Context, name: String, mime: String, bytes: ByteArray): String? {
        val safe = LocalAssetServer.safeName(name)
        return if (Build.VERSION.SDK_INT >= 29) {
            saveViaMediaStore(context, safe, mime, bytes)
        } else {
            saveLegacy(context, safe, bytes)
        }
    }

    private fun saveViaMediaStore(
        context: Context,
        name: String,
        mime: String,
        bytes: ByteArray,
    ): String? {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
            put(
                MediaStore.Downloads.RELATIVE_PATH,
                "${Environment.DIRECTORY_DOWNLOADS}/AirBridge",
            )
        }
        return context.contentResolver.insert(
            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            values,
        )?.let { uri ->
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            uri.toString()
        }
    }

    private fun saveLegacy(context: Context, name: String, bytes: ByteArray): String? {
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        dir.mkdirs()
        val file = File(dir, name)
        file.writeBytes(bytes)
        return file.absolutePath
    }
}
