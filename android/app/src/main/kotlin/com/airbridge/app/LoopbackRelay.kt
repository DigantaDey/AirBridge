package com.airbridge.app

import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.cert.X509Certificate
import java.util.Collections
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * Loopback pipe between the WebView and the desktop AirBridge server.
 *
 * The app shows the *real* web UI, so the browser APIs it depends on
 * (`crypto.subtle`, `localStorage`, service workers) must live in a secure
 * context. A WebView cannot be talked into trusting the desktop's self-signed
 * certificate for anything beyond the main frame — subresources, `fetch` and
 * `wss` all keep failing — so instead of fighting TLS trust, the shell serves
 * the UI from `http://127.0.0.1:<port>` (which every browser engine treats as
 * trustworthy) and copies the raw bytes over an ordinary socket to the
 * desktop, wrapping them in TLS when the desktop serves HTTPS.
 *
 * The desktop already speaks HTTP and HTTPS on the same port (it sniffs the
 * first byte), so this pipe is transparent: the WebView never learns it is
 * remote, `window.location.host` inside the page is loopback, and the web app's
 * own "localhost → use the LAN address for the QR" behaviour kicks in exactly
 * as it does for the desktop's own browser.
 *
 * Every WebView connection gets its own upstream socket, so HTTP keep-alive and
 * WebSocket upgrades both work without any protocol parsing here.
 */
class LoopbackRelay(
    private val remoteHost: String,
    private val remotePort: Int,
) {
    // TLS is attempted first whatever scheme the QR declared: the desktop serves
    // HTTPS by default, and a plaintext desktop rejects the handshake so the next
    // connection falls back automatically.
    @Volatile private var useTls: Boolean = true
    @Volatile private var running = false
    private var server: ServerSocket? = null
    private val sockets: MutableSet<Socket> = Collections.synchronizedSet(HashSet())

    /** The loopback port the WebView should load, or 0 before [start]. */
    val port: Int get() = server?.localPort ?: 0

    /**
     * Binds loopback and starts accepting. [preferredPort] is reused when it is
     * free so the WebView keeps the same origin — and therefore the web app's
     * `localStorage` (device identity, theme, pair code) — across launches.
     */
    @Throws(IOException::class)
    fun start(preferredPort: Int): Int {
        val socket = bind(preferredPort) ?: bind(0)
            ?: throw IOException("Could not bind the AirBridge loopback port")
        server = socket
        running = true
        thread(name = "airbridge-relay-accept", isDaemon = true) { acceptLoop(socket) }
        Log.i(TAG, "relay 127.0.0.1:${socket.localPort} -> $remoteHost:$remotePort (tls=$useTls)")
        return socket.localPort
    }

    fun stop() {
        running = false
        try {
            server?.close()
        } catch (_: IOException) {
        }
        server = null
        synchronized(sockets) {
            for (socket in sockets.toList()) closeQuietly(socket)
            sockets.clear()
        }
    }

    private fun bind(port: Int): ServerSocket? = try {
        ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), BACKLOG)
        }
    } catch (_: IOException) {
        null
    }

    private fun acceptLoop(serverSocket: ServerSocket) {
        while (running) {
            val client = try {
                serverSocket.accept()
            } catch (_: IOException) {
                break
            }
            thread(name = "airbridge-relay-conn", isDaemon = true) { handle(client) }
        }
    }

    private fun handle(client: Socket) {
        var remote: Socket? = null
        try {
            client.tcpNoDelay = true
            remote = openRemote()
            remote.tcpNoDelay = true
            sockets.add(client)
            sockets.add(remote)
            val target = remote
            // Either direction ending tears both sockets down. A browser closing a
            // keep-alive connection therefore cannot strand the upstream socket
            // (SSLSocket has no usable half-close to propagate it).
            thread(name = "airbridge-relay-up", isDaemon = true) {
                copy(client, target)
                closeQuietly(target)
                closeQuietly(client)
            }
            copy(target, client)
        } catch (e: Exception) {
            Log.w(TAG, "relay connection failed: ${e.message}")
        } finally {
            closeQuietly(remote)
            closeQuietly(client)
            remote?.let { sockets.remove(it) }
            sockets.remove(client)
        }
    }

    /**
     * Opens the upstream socket. TLS is tried first (the desktop's default);
     * when the handshake fails the desktop is running plaintext (`--http`), so
     * the next connection — and this one — go over a bare socket.
     */
    private fun openRemote(): Socket {
        if (useTls) {
            try {
                return openTls()
            } catch (e: Exception) {
                Log.i(TAG, "TLS handshake with $remoteHost failed (${e.message}); using plaintext")
                useTls = false
            }
        }
        return openPlain()
    }

    private fun openPlain(): Socket = Socket().apply {
        connect(InetSocketAddress(remoteHost, remotePort), CONNECT_TIMEOUT_MS)
        soTimeout = 0
    }

    private fun openTls(): Socket {
        val factory = TLS_CONTEXT.socketFactory as SSLSocketFactory
        val socket = factory.createSocket() as SSLSocket
        socket.connect(InetSocketAddress(remoteHost, remotePort), CONNECT_TIMEOUT_MS)
        // The desktop's certificate is self-signed by its own local CA. Payload
        // confidentiality does not depend on it: every control message and chunk
        // is already end-to-end encrypted between the two devices.
        socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = null }
        socket.soTimeout = CONNECT_TIMEOUT_MS
        socket.startHandshake()
        socket.soTimeout = 0
        return socket
    }

    private fun copy(from: Socket, to: Socket) {
        val buffer = ByteArray(BUFFER_BYTES)
        try {
            val input: InputStream = from.getInputStream()
            val output: OutputStream = to.getOutputStream()
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                output.write(buffer, 0, read)
                output.flush()
            }
        } catch (_: IOException) {
            // Either side went away; the caller closes both sockets.
        }
    }

    private fun closeQuietly(socket: Socket?) {
        if (socket == null) return
        try {
            socket.close()
        } catch (_: IOException) {
        }
    }

    private companion object {
        const val TAG = "AirBridgeRelay"
        const val BACKLOG = 32
        const val CONNECT_TIMEOUT_MS = 8_000
        const val BUFFER_BYTES = 64 * 1024

        /** Trust manager for the desktop's self-signed local CA (see openTls). */
        val TLS_CONTEXT: SSLContext by lazy {
            val trustAll = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustAll), null) }
        }
    }
}
