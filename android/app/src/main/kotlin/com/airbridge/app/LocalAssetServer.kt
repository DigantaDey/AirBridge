package com.airbridge.app

import android.content.Context
import android.content.res.AssetManager
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * Tiny loopback HTTP server that serves files from the app's [AssetManager].
 *
 * The QR scanner is a web page (it uses `getUserMedia` + jsQR), and browsers
 * only expose camera capture from a *secure context*. `http://127.0.0.1` counts
 * as secure, `file://` does not, so the scanner is loaded from here rather than
 * straight out of the assets folder.
 *
 * Singleton: [MainActivity] starts it once and [QrScannerActivity] reuses the
 * same loopback server to load the scanner page.
 */
object LocalAssetServer {
    private lateinit var assets: AssetManager
    private var root: String = "scanner"
    private var serverSocket: ServerSocket? = null
    private var running = false

    val port: Int get() = serverSocket?.localPort ?: 0

    fun start(context: Context, root: String = "scanner") {
        assets = context.assets
        this.root = root
        if (serverSocket != null) return
        val socket = ServerSocket(0, 12, InetAddress.getByName("127.0.0.1"))
        serverSocket = socket
        running = true
        val thread = Thread {
            while (running) {
                try {
                    val client = socket.accept()
                    Thread { handle(client) }.start()
                } catch (_: Exception) {
                    break
                }
            }
        }
        thread.isDaemon = true
        thread.name = "airbridge-assets"
        thread.start()
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
    }

    private fun handle(client: Socket) {
        client.use { socket ->
            try {
                val reader = socket.getInputStream().bufferedReader()
                // Drain the request up to the blank line so the client can reuse
                // the connection if it wants (it won't, but it's polite).
                val requestLine = reader.readLine() ?: return@use
                val path = requestLine
                    .substringAfter(' ', "")
                    .substringBefore(' ')
                    .substringAfterLast('/')
                    .ifEmpty { "index.html" }
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                }

                val assetPath = "$root/$path"
                val bytes = try {
                    assets.open(assetPath).use { it.readBytes() }
                } catch (_: Exception) {
                    null
                }

                val body = if (bytes != null) {
                    bytes
                } else {
                    "Not found".toByteArray()
                }
                val status = if (bytes != null) "200 OK" else "404 Not Found"
                val mime = mimeFor(path)
                val head = buildString {
                    append("HTTP/1.1 $status\r\n")
                    append("Content-Type: $mime\r\n")
                    append("Content-Length: ${body.size}\r\n")
                    append("Cache-Control: no-store\r\n")
                    append("Connection: close\r\n")
                    append("\r\n")
                }
                socket.getOutputStream().buffered().use { out ->
                    out.write(head.toByteArray())
                    out.write(body)
                    out.flush()
                }
            } catch (_: Exception) {
                // Client went away mid-request; nothing to do.
            }
        }
    }

    private fun mimeFor(path: String): String = when {
        path.endsWith(".html") -> "text/html; charset=utf-8"
        path.endsWith(".js") -> "application/javascript; charset=utf-8"
        path.endsWith(".css") -> "text/css; charset=utf-8"
        path.endsWith(".json") -> "application/json; charset=utf-8"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
        else -> "application/octet-stream"
    }

    /** Absolute loopback URL for an asset path (e.g. `/scanner/index.html`). */
    fun url(assetPath: String): String = "http://127.0.0.1:$port$assetPath"

    /** Absolute loopback URL of the bundled QR-scanner page. */
    fun scannerUrl(): String = url("/scanner/index.html")

    private val SAFE_NAME_RE = Regex("[\\\\/:*?\"<>|]")

    /** Sanitise an untrusted filename so it can never escape a directory. */
    fun safeName(raw: String): String {
        val base = File(raw).name
        return base.replace(SAFE_NAME_RE, "_").ifEmpty { "airbridge-file" }
    }
}
