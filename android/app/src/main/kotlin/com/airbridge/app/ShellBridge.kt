package com.airbridge.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * `window.AirBridgeAndroid` — the only bridge between the web UI and Android.
 *
 * The shell renders the untouched web app, so this exists purely for the four
 * things a WebView cannot do on its own:
 *
 *   1. clipboard read/write (WebView never shows the permission prompt),
 *   2. saving received files (`<a download>` of a `blob:` URL is a no-op),
 *   3. scanning a pairing QR with the camera,
 *   4. leaving/joining a computer from the unpaired connect screen.
 *
 * Everything here is called from a WebView Javascript thread, so it must not
 * touch Android UI directly; UI work is posted to the main thread.
 */
class ShellBridge(private val activity: MainActivity) {

    private val lock = Any()
    private val saves = HashMap<Int, SaveSession>()
    private var nextHandle = 1

    // ---------------------------------------------------------------- clipboard

    @JavascriptInterface
    fun copyText(text: String): Boolean {
        return try {
            val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(ClipData.newPlainText("AirBridge", text))
            true
        } catch (e: Exception) {
            Log.w(TAG, "clipboard write failed: ${e.message}")
            false
        }
    }

    @JavascriptInterface
    fun readClipboard(): String {
        return try {
            val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = manager.primaryClip ?: return ""
            if (clip.itemCount == 0) return ""
            clip.getItemAt(0)?.coerceToText(activity)?.toString().orEmpty()
        } catch (e: Exception) {
            Log.w(TAG, "clipboard read failed: ${e.message}")
            ""
        }
    }

    // ------------------------------------------------------------------ saving

    /** Opens a download in the public Downloads folder; -1 when it cannot start. */
    @JavascriptInterface
    fun beginSave(name: String, mimeType: String): Int {
        val safeName = sanitizeFileName(name)
        if (safeName.isEmpty()) return -1
        val mime = mimeType.ifBlank { "application/octet-stream" }
        return try {
            val session = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                openMediaStore(safeName, mime)
            } else {
                openLegacy(safeName)
            }
            synchronized(lock) {
                val handle = nextHandle++
                saves[handle] = session
                handle
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not start download for $safeName: ${e.message}")
            try {
                synchronized(lock) {
                    val handle = nextHandle++
                    saves[handle] = openAppPrivate(safeName)
                    handle
                }
            } catch (fallback: Exception) {
                Log.w(TAG, "app-private fallback failed: ${fallback.message}")
                -1
            }
        }
    }

    /** Writes one base64 chunk; false ends the download (the caller aborts). */
    @JavascriptInterface
    fun appendSave(handle: Int, base64Chunk: String): Boolean {
        val session = synchronized(lock) { saves[handle] } ?: return false
        return try {
            val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
            synchronized(session) {
                session.stream.write(bytes)
                session.stream.flush()
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "write failed for ${session.name}: ${e.message}")
            abortSave(handle)
            false
        }
    }

    /** Finalises the download and returns where it landed ('' on failure). */
    @JavascriptInterface
    fun finishSave(handle: Int): String {
        val session = synchronized(lock) { saves.remove(handle) } ?: return ""
        return try {
            session.stream.flush()
            session.stream.close()
            if (session.pendingUri != null) {
                val resolver = activity.contentResolver
                resolver.update(
                    session.pendingUri,
                    ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                    null,
                    null,
                )
            }
            val location = session.location
            activity.runOnUiThread { activity.onFileSaved(session.name, location) }
            location
        } catch (e: Exception) {
            Log.w(TAG, "could not finish ${session.name}: ${e.message}")
            ""
        }
    }

    @JavascriptInterface
    fun abortSave(handle: Int) {
        val session = synchronized(lock) { saves.remove(handle) } ?: return
        try {
            session.stream.close()
        } catch (_: Exception) {
        }
        try {
            when {
                session.pendingUri != null -> activity.contentResolver.delete(session.pendingUri, null, null)
                session.file != null -> session.file.delete()
            }
        } catch (_: Exception) {
        }
    }

    /**
     * Fetches a download the page linked to on the relay origin (the in-app
     * Download centre's local artifacts, for instance) and writes it through the
     * same save path. Runs on a worker thread: HttpURLConnection to loopback is
     * permitted by the network security config.
     */
    fun downloadFromRelay(url: String, suggestedName: String, mimeType: String) {
        Thread {
            var handle = -1
            try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 10_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = true
                try {
                    if (connection.responseCode !in 200..299) {
                        Log.w(TAG, "download failed: HTTP ${connection.responseCode} for $url")
                        return@Thread
                    }
                    val name = suggestedName.ifEmpty { "airbridge-file" }
                    val mime = connection.contentType?.substringBefore(';')?.trim()
                        ?.takeIf { it.isNotEmpty() && it != "application/octet-stream" }
                        ?: mimeType.ifBlank { "application/octet-stream" }
                    handle = beginSave(name, mime)
                    if (handle < 0) return@Thread
                    connection.inputStream.use { input ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            val chunk = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
                            if (!appendSave(handle, chunk)) throw IOException("write failed")
                        }
                    }
                    finishSave(handle)
                    handle = -1
                } finally {
                    connection.disconnect()
                }
            } catch (e: Exception) {
                Log.w(TAG, "download failed for $url: ${e.message}")
            } finally {
                if (handle >= 0) abortSave(handle)
            }
        }.also { it.isDaemon = true }.start()
    }

    // ------------------------------------------------- connect screen (unpaired)

    /** JSON describing the shell so the connect page can render itself. */
    @JavascriptInterface
    fun state(): String {
        val info = JSONObject()
        val link = activity.currentLink()
        info.put("paired", link != null)
        info.put("address", activity.preferredAddress())
        info.put("pairCode", activity.currentPairCode())
        info.put("camera", activity.hasCamera())
        return info.toString()
    }

    /** JSON array of `{name, address}` for computers found over mDNS. */
    @JavascriptInterface
    fun nearbyHosts(): String {
        val array = JSONArray()
        for (host in activity.nearbyHosts()) {
            array.put(JSONObject().put("name", host.name).put("address", host.address))
        }
        return array.toString()
    }

    /** Starts using a computer; returns '' on success or a human-readable error. */
    @JavascriptInterface
    fun connect(address: String): String {
        val error = activity.connectToAddress(address)
        return error ?: ""
    }

    /** Opens the camera scanner. False when this device has no camera. */
    @JavascriptInterface
    fun scanQr(): Boolean {
        if (!activity.hasCamera()) return false
        activity.runOnUiThread { activity.openScanner() }
        return true
    }

    /** Unpairs and returns to the connect screen. */
    @JavascriptInterface
    fun forgetComputer(): Boolean {
        activity.runOnUiThread { activity.forgetComputer() }
        return true
    }

    // ------------------------------------------------------------------ helpers

    private fun openMediaStore(name: String, mimeType: String): SaveSession {
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AirBridge")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("MediaStore refused the download")
        val stream = try {
            resolver.openOutputStream(uri) ?: throw IOException("MediaStore gave no stream")
        } catch (e: Exception) {
            // Do not leave a pending row behind when the write could not start.
            try {
                resolver.delete(uri, null, null)
            } catch (_: Exception) {
            }
            throw e
        }
        return SaveSession(
            name = name,
            stream = stream,
            pendingUri = uri,
            file = null,
            location = "${Environment.DIRECTORY_DOWNLOADS}/AirBridge/$name",
        )
    }

    /** Android 8/9: write straight into the public Downloads folder. */
    @Suppress("DEPRECATION")
    private fun openLegacy(name: String): SaveSession {
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val dir = File(downloads, "AirBridge")
        if (!dir.exists() && !dir.mkdirs()) throw IOException("cannot create $dir")
        val file = uniqueFile(dir, name)
        return SaveSession(name, FileOutputStream(file), null, file, "Downloads/AirBridge/${file.name}")
    }

    /** Last resort: app-specific storage, which needs no permission on any version. */
    private fun openAppPrivate(name: String): SaveSession {
        val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "AirBridge")
        if (!dir.exists() && !dir.mkdirs()) throw IOException("cannot create $dir")
        val file = uniqueFile(dir, name)
        return SaveSession(name, FileOutputStream(file), null, file, file.absolutePath)
    }

    private fun uniqueFile(dir: File, name: String): File {
        var candidate = File(dir, name)
        if (!candidate.exists()) return candidate
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        var index = 1
        while (candidate.exists() && index < 1000) {
            candidate = File(dir, "$stem ($index)$extension")
            index++
        }
        return candidate
    }

    private fun sanitizeFileName(raw: String): String {
        val base = raw.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base.map { if (it.isISOControl() || it == ':' || it == '*' || it == '?' || it == '"' || it == '<' || it == '>' || it == '|') '_' else it }
            .joinToString("")
            .trim()
        return when {
            cleaned.isEmpty() || cleaned == "." || cleaned == ".." -> "airbridge-file"
            cleaned.length > 120 -> cleaned.take(120)
            else -> cleaned
        }
    }

    private class SaveSession(
        val name: String,
        val stream: OutputStream,
        val pendingUri: Uri?,
        val file: File?,
        val location: String,
    )

    private companion object {
        const val TAG = "AirBridgeBridge"
    }
}
