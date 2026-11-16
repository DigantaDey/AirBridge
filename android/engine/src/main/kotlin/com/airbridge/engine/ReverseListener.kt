package com.airbridge.engine

import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * Sockets the *computer* opened to this phone (the "reverse" path).
 *
 * Phone → computer can fail for reasons the phone can't fix or even detect:
 * the computer's inbound firewall (macOS Application Firewall, Windows
 * Defender, a VPN client that blocks LAN inbound), or a phone that routes the
 * computer's address over mobile data. Computer → phone usually still works
 * in those cases, e.g. on the phone's own hotspot the computer can always reach
 * its default gateway (the phone). So the computer also dials the phone, and
 * the phone uses that socket exactly like one it dialled: it is the TLS
 * *client* on it, pins the computer's certificate and checks the IP SAN, then
 * sends the normal WebSocket upgrade and hello. Only the TCP direction changes,
 * not the security model.
 */
interface InboundConnections {
    /** Wait up to [timeoutMs] for a socket from the computer; null on timeout or [cancelled]. */
    fun await(timeoutMs: Long, cancelled: () -> Boolean, register: (Socket) -> Unit): Socket?

    /** The peer at [host] failed TLS (wrong computer / impostor): ignore it for a while. */
    fun reject(host: String)
}

/**
 * Accepts the computer's reverse connections on [port] while [active] (not
 * connected, and the computer's TLS identity is pinned, see
 * [PinnedTlsTrust.isAnchored]). Anything else is closed on accept.
 */
class ReverseListener(
    port: Int = DEFAULT_PORT,
    private val active: () -> Boolean,
    private val acceptFrom: (String) -> Boolean = { host -> LocalNetworks.isLanAddress(host) || host == "127.0.0.1" },
    private val clock: () -> Long = System::currentTimeMillis,
) : InboundConnections, AutoCloseable {
    companion object {
        /** Must match REVERSE_CONNECT_PORT in src/shared/protocol.ts. */
        const val DEFAULT_PORT = 47390
        /** mDNS/NSD service type the phone advertises so a computer on a shared Wi-Fi can find it. */
        const val SERVICE_TYPE = "_airbridge-rv._tcp"
        private const val MAX_QUEUED = 4
        private const val MAX_AGE_MS = 8_000L
        private const val REJECT_MS = 60_000L

        fun normalizeHost(raw: String): String = raw.removePrefix("/").removePrefix("::ffff:")
    }

    private data class Pending(val socket: Socket, val host: String, val at: Long)

    private val server = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(port), 16)
    }
    private val queue = LinkedBlockingDeque<Pending>()
    private val rejected = ConcurrentHashMap<String, Long>()
    @Volatile private var closed = false

    val port: Int get() = server.localPort

    init {
        Thread({ acceptLoop() }, "airbridge-reverse-accept").apply { isDaemon = true; start() }
    }

    private fun acceptLoop() {
        while (!closed) {
            val s = try { server.accept() } catch (_: Exception) { if (closed) return else continue }
            val host = normalizeHost(s.inetAddress?.hostAddress ?: "")
            val blockedUntil = rejected[host] ?: 0L
            if (!active() || !acceptFrom(host) || blockedUntil > clock()) {
                runCatching { s.close() }
                continue
            }
            runCatching { s.tcpNoDelay = true; s.keepAlive = true }
            queue.offerLast(Pending(s, host, clock()))
            while (queue.size > MAX_QUEUED) queue.pollFirst()?.let { runCatching { it.socket.close() } }
        }
    }

    override fun await(timeoutMs: Long, cancelled: () -> Boolean, register: (Socket) -> Unit): Socket? {
        val deadline = clock() + timeoutMs
        while (!closed && !cancelled()) {
            val left = deadline - clock()
            if (left <= 0) return null
            val p = queue.pollFirst(minOf(left, 100L), TimeUnit.MILLISECONDS) ?: continue
            if (p.socket.isClosed || clock() - p.at > MAX_AGE_MS || (rejected[p.host] ?: 0L) > clock()) {
                runCatching { p.socket.close() }
                continue
            }
            register(p.socket)
            if (cancelled()) { runCatching { p.socket.close() }; return null }
            return p.socket
        }
        return null
    }

    override fun reject(host: String) {
        rejected[normalizeHost(host)] = clock() + REJECT_MS
    }

    override fun close() {
        closed = true
        runCatching { server.close() }
        while (true) { val p = queue.pollFirst() ?: break; runCatching { p.socket.close() } }
    }
}

/** Thrown into the race when no reverse connection arrived in time. */
internal class NoInboundConnection : SocketTimeoutException("No connection from the computer")
