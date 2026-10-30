package com.airbridge.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.airbridge.engine.DirectoryFileSinkFactory
import java.io.File

/**
 * Receiver-side publishing: engine chunks stage in the app's private dir
 * (durable + resumable), then the finisher moves the verified file into the
 * user's Downloads/AirBridge folder — MediaStore on Android 10+, direct file
 * IO on 26–28 (permission gated, falls back to app-specific storage).
 */
class Sinks(private val context: Context) {

    fun createFactory(): DirectoryFileSinkFactory {
        val staging = File(context.filesDir, "received").apply { mkdirs() }
        return DirectoryFileSinkFactory(staging) { part, name -> publish(part, name) }
    }

    private fun publish(part: File, name: String): File {
        val safeName = sanitize(name)
        return if (Build.VERSION.SDK_INT >= 29) {
            publishMediaStore(part, safeName)
        } else {
            publishLegacy(part, safeName)
        }
    }

    private fun sanitize(name: String): String =
        name.replace(Regex("[/\\\\:*?\"<>|]"), "_").ifEmpty { "download.bin" }

    private fun publishMediaStore(part: File, name: String): File {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + "/AirBridge",
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri: Uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return publishFallback(part, name)
        try {
            resolver.openOutputStream(uri, "w")?.use { out ->
                part.inputStream().use { input ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n == -1) break
                        out.write(buf, 0, n)
                    }
                }
            } ?: return publishFallback(part, name)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            return publishFallback(part, name)
        }
        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        part.delete()
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        return File(File(dir, "AirBridge").absolutePath + "/" + name)
    }

    private fun publishLegacy(part: File, name: String): File {
        val publicDir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "AirBridge",
        )
        return try {
            publicDir.mkdirs()
            val target = File(publicDir, name)
            part.copyTo(target, overwrite = true)
            part.delete()
            target
        } catch (e: SecurityException) {
            publishFallback(part, name)
        }
    }

    private fun publishFallback(part: File, name: String): File {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(context.filesDir, "downloads")
        dir.mkdirs()
        val target = File(dir, name)
        return try {
            part.copyTo(target, overwrite = true)
            part.delete()
            target
        } catch (e: Exception) {
            part
        }
    }
}
