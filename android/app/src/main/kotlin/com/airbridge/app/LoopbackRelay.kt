package com.airbridge.app

import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.RejectedExecutionException
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * Bounded loopback proxy for desktop API requests only. UI scripts ship in the
 * APK and file/clipboard traffic goes straight through the service's engine.
 * Honor the pairing's transport exactly; never downgrade TLS after an error.
 */
class LoopbackRelay(
    private val remoteHost: String,
    private val remotePort: Int,
    private val useTls: Boolean,
    trustManager: X509TrustManager,
) {
    private val tlsContext = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }
    @Volatile private var running = false
    private var server: ServerSocket? = null
    private val sockets: MutableSet<Socket> = Collections.synchronizedSet(HashSet())
    private val workers = ThreadPoolExecutor(0, 16, 30, TimeUnit.SECONDS,
        SynchronousQueue(), { r -> Thread(r, "airbridge-relay-conn").apply { isDaemon = true } })

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
        workers.shutdownNow()
        synchronized(sockets) {
            for (socket in sockets.toList()) closeQuietly(socket)
            sockets.clear()
        }
    }

    private fun bind(port: Int): ServerSocket? {
        val socket = ServerSocket()
        return try {
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), BACKLOG)
            socket
        } catch (_: IOException) { closeServer(socket); null }
    }

    private fun closeServer(socket: ServerSocket) { runCatching { socket.close() } }

    private fun acceptLoop(serverSocket: ServerSocket) {
        while (running) {
            val client = try {
                serverSocket.accept()
            } catch (_: IOException) {
                break
            }
            sockets.add(client)
            try { workers.execute { handle(client) } }
            catch (_: RejectedExecutionException) { sockets.remove(client); closeQuietly(client) }
        }
    }

    private fun handle(client: Socket) {
        var remote: Socket? = null
        try {
            if (!running) return
            client.tcpNoDelay = true
            client.keepAlive = true
            remote = openRemote()
            remote.tcpNoDelay = true
            remote.keepAlive = true
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

    private fun openRemote(): Socket = if (useTls) openTls() else openPlain()

    private fun openPlain(): Socket {
        val socket = Socket()
        sockets.add(socket)
        return try {
            if (!running) throw IOException("Relay stopped")
            socket.keepAlive = true
            socket.connect(InetSocketAddress(remoteHost, remotePort), CONNECT_TIMEOUT_MS)
            socket.soTimeout = 0
            socket
        } catch (e: Exception) { sockets.remove(socket); closeQuietly(socket); throw e }
    }

    private fun openTls(): Socket {
        val socket = tlsContext.socketFactory.createSocket() as SSLSocket
        sockets.add(socket)
        return try {
            if (!running) throw IOException("Relay stopped")
            socket.keepAlive = true
            socket.connect(InetSocketAddress(remoteHost, remotePort), CONNECT_TIMEOUT_MS)
            socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            socket.soTimeout = CONNECT_TIMEOUT_MS
            socket.startHandshake()
            socket.soTimeout = 0
            socket
        } catch (e: Exception) { sockets.remove(socket); closeQuietly(socket); throw e }
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

    }
}
