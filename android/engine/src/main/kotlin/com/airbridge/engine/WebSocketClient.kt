package com.airbridge.engine

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Opens a TCP connection to one host. [register] must be called with the socket
 * BEFORE blocking in connect so [WebSocketClient.close] can abort it.
 */
fun interface TcpConnector {
    fun connect(host: String, port: Int, timeoutMs: Int, register: (Socket) -> Unit): Socket
}

/** Minimal bounded RFC 6455 client; TLS uses platform trust or an explicit LAN CA pin. */
class WebSocketClient(
    url: String,
    private val listener: Listener,
    private val tlsTrustManager: X509TrustManager? = null,
    private val connectTimeoutMs: Int = 10_000,
    private val maxMessageBytes: Int = 16 * 1024 * 1024,
    /**
     * Other addresses of the same server (same scheme and port), already
     * ranked. The URL's host is tried first; the next candidate starts after
     * [staggerMs] or as soon as the previous one fails, and the first TCP
     * connection wins. TLS + hostname verification then run against the
     * winning address only — an unreachable address can never "win" just by
     * being first, and no address is ever trusted without a valid certificate.
     */
    private val alternateHosts: List<String> = emptyList(),
    private val staggerMs: Long = 400,
    private val tcpConnector: TcpConnector = DEFAULT_TCP_CONNECTOR,
    private val routeProbe: (host: String, port: Int) -> String? = { h, p -> RouteProbe.sourceAddressFor(h, p) },
    /**
     * Reverse path: sockets the computer opened to this phone race the forward
     * dials (see [InboundConnections]). TLS, the IP-SAN check and the upgrade
     * then run on the winner exactly as for a dialled socket.
     */
    private val inbound: InboundConnections? = null,
    /** After every forward dial failed, how long to keep waiting for the computer to dial in. */
    private val reverseGraceMs: Long = 3_500,
    /**
     * Relay fallback: joins the race [RelayDial.delayMs] after it starts, so a
     * working direct path always wins. TLS then runs end to end through the
     * relay and must terminate at [RelayDial.expectedPin].
     */
    private val relay: RelayDial? = null,
    private val writeTimeoutMs: Long = 30_000L,
    private val dnsTimeoutMs: Long = 5_000L,
    private val dnsResolver: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
    private val onWriteStall: (() -> Unit)? = null,
    private val onDnsMeasured: ((Long) -> Unit)? = null,
    private val relayTimeoutMs: Long = (relay?.delayMs ?: 0L) + connectTimeoutMs.toLong() + 13_500L,
) {
    /**
     * A relay rendezvous the code-authenticated computer offered, plus the TLS
     * anchor it proved on that connection. Without a pinned anchor there is no
     * relay: the operator must never be able to stand in for the computer.
     */
    data class RelayDial(
        val route: RelayRoute,
        val expectedPin: String,
        val delayMs: Long = 2_500,
        /** TLS name for the relayed handshake (every AirBridge leaf covers it). */
        val tlsHostname: String = "airbridge.local",
    )
    interface Listener {
        fun onText(text: String)
        fun onBinary(bytes: ByteArray)
        /** Called exactly once when the connection is gone (after onClosed there is no more traffic). */
        fun onClosed(reason: String)
    }

    private val uri = URI(url)
    private val secure = when (uri.scheme) {
        "wss" -> true
        "ws" -> false
        else -> throw IOException("Unsupported scheme: ${uri.scheme}")
    }
    private val primaryHost: String = uri.host?.removePrefix("[")?.removeSuffix("]")
        ?: throw IOException("URL missing host")
    private val port: Int = uri.port.takeIf { it > 0 } ?: if (secure) 443 else 80
    private val resource: String = buildString {
        append(uri.rawPath.ifNullOrEmpty("/ws"))
        if (uri.rawQuery != null) append('?').append(uri.rawQuery)
    }
    private val candidates: List<String> =
        (listOf(primaryHost) + alternateHosts.map { it.trim().removePrefix("[").removeSuffix("]") })
            .filter { it.isNotBlank() }
            .distinctBy { it.lowercase() }

    val tlsMode: String = when {
        !secure -> "none"
        tlsTrustManager is PinnedTlsTrust -> "pinned"
        tlsTrustManager != null -> "custom"
        else -> "system"
    }

    @Volatile
    var isOpen = false
        private set

    /** The candidate address the connection was established to (null until connected). */
    @Volatile
    var connectedHost: String? = null
        private set

    /** The verified IP-literal SAN host if the last TLS handshake verified an IP SAN. */
    @Volatile
    var verifiedIpSanHost: String? = null
        private set

    /** True when the connection is a socket the computer opened to this phone. */
    @Volatile
    var connectedViaReverse = false
        private set

    /**
     * base64url SHA-256 of the TLS chain's last certificate on this connection
     * (the QR `ca=` format); null for plain ws://. The engine compares it with
     * the pin the code-authenticated hub vouched for.
     */
    @Volatile
    var tlsAnchorPin: String? = null
        private set

    val anchorPinPrefix: String?
        get() = (tlsAnchorPin ?: (tlsTrustManager as? PinnedTlsTrust)?.anchorPinPrefix())?.take(12)

    /** True when the connection runs through [relay] (TLS still ends at the computer). */
    @Volatile
    var connectedViaRelay = false
        private set

    /** Per-candidate outcomes of the last [connectBlocking] (for diagnostics). */
    @Volatile
    var attempts: List<EndpointAttempt> = emptyList()
        private set

    @Volatile
    var lastDnsMs: Long? = null
        internal set

    @Volatile
    var dialAttemptCount: Int = 0
        private set

    private val writeStalls = AtomicLong(0)
    val writeStallCount: Long get() = writeStalls.get()

    val activeDialThreads: Int get() = activeDialTasks.get()

    fun diagnosticsSnapshot(): WebSocketDiagnosticsSnapshot = WebSocketDiagnosticsSnapshot(
        tlsMode = tlsMode,
        verifiedIpSanHost = verifiedIpSanHost,
        anchorPinPrefix = anchorPinPrefix,
        connectedHost = connectedHost,
        connectedViaReverse = connectedViaReverse,
        connectedViaRelay = connectedViaRelay,
        dialAttemptCount = dialAttemptCount,
        lastDnsMs = lastDnsMs,
        writeStallCount = writeStallCount,
        activeDialThreads = activeDialThreads,
        attempts = attempts,
    )

    @Volatile private var rawTcpSocket: Socket? = null
    @Volatile private var socket: Socket? = null
    @Volatile private var activeResultsQueue: LinkedBlockingQueue<TcpResult>? = null
    private val inFlight = java.util.Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    private var input: InputStream? = null
    private var output: OutputStream? = null
    private val writeLock = ReentrantLock(true)
    private val closeLock = Any()
    @Volatile private var closed = false
    private val pendingPong = AtomicReference<ByteArray?>(null)
    private val pendingPing = AtomicBoolean(false)
    private val controlScheduled = AtomicBoolean(false)
    private val controlRetryScheduled = AtomicBoolean(false)
    @Volatile private var controlRetryFuture: ScheduledFuture<*>? = null
    @Volatile private var activeWriteStartedNanos: Long = 0L
    private val writeWatchdogLock = Any()
    private var writeWatchdog: ScheduledFuture<*>? = null
    private val maskBuffer = ByteArray(1024 * 1024 + 128)
    private val headerBuffer = ByteArray(14)
    private val lengthScratch = ByteArray(8)
    private val maskKey = ByteArray(4)
    private val emptyPayload = ByteArray(0)
    private val random = SecureRandom()

    private data class TcpResult(
        val host: String,
        val socket: Socket?,
        val error: Throwable?,
        val reverse: Boolean = false,
        val relayed: Boolean = false,
        val candidateIndex: Int = -1,
    )

    private data class TcpWinner(val host: String, val socket: Socket, val reverse: Boolean, val relayed: Boolean = false)

    private class RelayUnavailable(message: String) : IOException(message)

    private fun dialHost(host: String, port: Int, timeoutMs: Int, register: (Socket) -> Unit): Socket {
        return if (tcpConnector === DEFAULT_TCP_CONNECTOR) {
            connectWithBoundedDns(
                host = host,
                port = port,
                timeoutMs = timeoutMs,
                dnsTimeoutMs = dnsTimeoutMs,
                dnsResolver = dnsResolver,
                onDns = { ms ->
                    lastDnsMs = ms
                    onDnsMeasured?.invoke(ms)
                },
                register = register,
            )
        } else {
            tcpConnector.connect(host, port, timeoutMs, register)
        }
    }

    /** TCP to the relay, `DIAL <room>`, wait for `GO`. The socket is then a raw pipe to the computer. */
    private fun dialRelay(dial: RelayDial, register: (Socket) -> Unit): Socket {
        val s = dialHost(dial.route.host, dial.route.port, connectTimeoutMs, register)
        try {
            s.soTimeout = 12_000
            s.tcpNoDelay = true
            val out = s.getOutputStream()
            out.write("AB-RELAY/1 DIAL ${dial.route.token}\n".toByteArray(Charsets.US_ASCII))
            out.flush()
            val inp = s.getInputStream()
            val line = StringBuilder()
            while (true) {
                val b = inp.read()
                if (b == -1) throw RelayUnavailable("relay closed the connection")
                if (b == '\n'.code) break
                line.append(b.toChar())
                if (line.length > 160) throw RelayUnavailable("relay protocol error")
            }
            val reply = line.toString().trimEnd('\r')
            if (reply != "GO") {
                throw RelayUnavailable(when (reply) {
                    "ERR NO_HOST" -> "the computer is not connected to the relay"
                    "ERR BUSY" -> "relay busy"
                    else -> "relay refused: $reply"
                })
            }
            s.soTimeout = 0
            return s
        } catch (e: Throwable) {
            runCatching { s.close() }
            throw e
        }
    }

    /**
     * Races [candidates] at the TCP layer, plus (with [inbound]) a socket the
     * computer opens to this phone. Returns the winner or throws
     * [ConnectFailure] (phase TCP).
     */
    private fun connectTcp(): TcpWinner {
        val results = LinkedBlockingQueue<TcpResult>()
        activeResultsQueue = results
        val failures = ArrayList<EndpointAttempt>()
        val raceDone = AtomicBoolean(false)
        val raceLock = Any()
        val futures = ArrayList<Future<*>>()
        val completedCandidates = BooleanArray(candidates.size)
        var started = 0
        var finished = 0
        var inboundPending = false
        var reverseNote: String? = null
        var relayPending = false
        var relayNote: String? = null

        val register: (Socket) -> Unit = { s ->
            var keep = false
            synchronized(raceLock) {
                if (!raceDone.get() && !closed) {
                    inFlight.add(s)
                    keep = true
                }
            }
            if (!keep) runCatching { s.close() }
        }

        fun submitResult(result: TcpResult) {
            var handedOff = false
            synchronized(raceLock) {
                if (!raceDone.get() && !closed) {
                    results.offer(result)
                    handedOff = true
                }
            }
            if (!handedOff) result.socket?.let { runCatching { it.close() } }
        }

        fun submitDial(task: () -> Unit): Future<*>? = try {
            dialExecutor.submit {
                activeDialTasks.incrementAndGet()
                try {
                    task()
                } finally {
                    activeDialTasks.decrementAndGet()
                }
            }
        } catch (_: RejectedExecutionException) {
            null
        }

        fun cleanupRace(winnerSocket: Socket?) {
            synchronized(raceLock) { raceDone.set(true) }
            futures.forEach { it.cancel(true) }
            synchronized(raceLock) {
                for (other in inFlight) if (other !== winnerSocket) runCatching { other.close() }
                inFlight.clear()
            }
            while (true) {
                val late = results.poll() ?: break
                if (late.socket !== winnerSocket) runCatching { late.socket?.close() }
            }
        }

        fun startNext() {
            val idx = started++
            val host = candidates[idx]
            dialAttemptCount++
            val f = submitDial {
                try {
                    submitResult(TcpResult(host, dialHost(host, port, connectTimeoutMs, register), null, candidateIndex = idx))
                } catch (e: Throwable) {
                    submitResult(TcpResult(host, null, e, candidateIndex = idx))
                }
            }
            if (f != null) futures.add(f)
            else submitResult(TcpResult(host, null, IOException("Dial executor busy"), candidateIndex = idx))
        }

        val source = inbound
        if (source != null) {
            inboundPending = true
            dialAttemptCount++
            val f = submitDial {
                try {
                    val s = source.await(connectTimeoutMs.toLong() + reverseGraceMs + 1_000, { closed || raceDone.get() }, register)
                    if (s == null) submitResult(TcpResult("", null, NoInboundConnection(), reverse = true))
                    else submitResult(TcpResult(ReverseListener.normalizeHost(s.inetAddress.hostAddress), s, null, reverse = true))
                } catch (e: Throwable) {
                    submitResult(TcpResult("", null, e, reverse = true))
                }
            }
            if (f != null) futures.add(f)
            else {
                inboundPending = false
                reverseNote = "dial executor busy"
            }
        }

        val relayDial = relay
        if (relayDial != null) {
            relayPending = true
            dialAttemptCount++
            val f = submitDial {
                try {
                    val until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(relayDial.delayMs)
                    while (System.nanoTime() < until && !closed && !raceDone.get()) {
                        val sleepMs = TimeUnit.NANOSECONDS.toMillis(until - System.nanoTime()).coerceIn(1L, 25L)
                        Thread.sleep(sleepMs)
                    }
                    if (closed || raceDone.get()) {
                        submitResult(TcpResult("", null, NoInboundConnection(), relayed = true))
                    } else {
                        submitResult(TcpResult(relayDial.tlsHostname, dialRelay(relayDial, register), null, relayed = true))
                    }
                } catch (e: Throwable) {
                    submitResult(TcpResult("", null, e, relayed = true))
                }
            }
            if (f != null) futures.add(f)
            else {
                relayPending = false
                relayNote = "dial executor busy"
            }
        }

        fun allFailed(last: Throwable?): Nothing {
            cleanupRace(null)
            attempts = failures.toList()
            val kind = summarize(failures)
            val reverse = (if (source != null) "; computer→phone: ${reverseNote ?: "no connection"}" else "") +
                (if (relayDial != null) "; relay ${relayDial.route.host}: ${relayNote ?: "no connection"}" else "")
            throw ConnectFailure(
                ConnectPhase.TCP, kind, primaryHost, failures.toList(),
                failures.joinToString("; ") { "${it.host}:${it.port} ${it.kind.name.lowercase()}" + (it.routeSource?.let { r -> " via $r" } ?: "") } + reverse,
                last,
            )
        }

        val startedAtNanos = System.nanoTime()
        var nextStaggerAtNanos = startedAtNanos + TimeUnit.MILLISECONDS.toNanos(staggerMs)
        val forwardHardDeadlineNanos = startedAtNanos + TimeUnit.MILLISECONDS.toNanos(
            maxOf(0, candidates.size - 1) * staggerMs + connectTimeoutMs.toLong() + 2_000L,
        )
        val relayDeadlineNanos = if (relayDial != null) {
            startedAtNanos + TimeUnit.MILLISECONDS.toNanos(relayTimeoutMs.coerceAtLeast(1L))
        } else 0L
        var reverseDeadlineNanos = 0L

        startNext()
        var lastError: Throwable? = null
        try {
            while (true) {
                if (closed) {
                    cleanupRace(null)
                    attempts = failures.toList()
                    throw ConnectFailure(ConnectPhase.TCP, FailureKind.CANCELLED, primaryHost, failures.toList(), "Socket closed during connect")
                }

                val now = System.nanoTime()
                while (started < candidates.size && now >= nextStaggerAtNanos) {
                    startNext()
                    nextStaggerAtNanos = now + TimeUnit.MILLISECONDS.toNanos(staggerMs)
                }
                if (finished < candidates.size && now >= forwardHardDeadlineNanos) {
                    for (i in candidates.indices) {
                        if (!completedCandidates[i]) {
                            completedCandidates[i] = true
                            val err = SocketTimeoutException("Connect timed out")
                            lastError = lastError ?: err
                            val route = routeProbe(candidates[i], port)
                            failures += EndpointAttempt(candidates[i], port, FailureKind.TCP_TIMEOUT, "Connect timed out", route)
                            finished++
                        }
                    }
                    started = candidates.size
                    if (finished == candidates.size && reverseDeadlineNanos == 0L) {
                        reverseDeadlineNanos = now + TimeUnit.MILLISECONDS.toNanos(reverseGraceMs)
                    }
                }
                val forwardDone = finished == candidates.size
                if (relayPending && now >= relayDeadlineNanos) {
                    relayPending = false
                    relayNote = relayNote ?: "relay timed out"
                }
                if (forwardDone && inboundPending && now >= reverseDeadlineNanos) {
                    inboundPending = false
                }
                if (forwardDone && !inboundPending && !relayPending) allFailed(lastError)

                var nextWakeNanos = Long.MAX_VALUE
                if (started < candidates.size) nextWakeNanos = minOf(nextWakeNanos, nextStaggerAtNanos)
                if (!forwardDone) nextWakeNanos = minOf(nextWakeNanos, forwardHardDeadlineNanos)
                if (relayPending) nextWakeNanos = minOf(nextWakeNanos, relayDeadlineNanos)
                if (forwardDone && inboundPending) nextWakeNanos = minOf(nextWakeNanos, reverseDeadlineNanos)
                val waitNanos = if (nextWakeNanos == Long.MAX_VALUE) 1_000_000L else maxOf(1_000_000L, nextWakeNanos - System.nanoTime())

                val result = results.poll(waitNanos, TimeUnit.NANOSECONDS) ?: continue
                if (result.socket != null && !closed) {
                    cleanupRace(result.socket)
                    attempts = failures.toList()
                    return TcpWinner(result.host, result.socket, result.reverse, result.relayed)
                }
                result.socket?.let { runCatching { it.close() } }
                if (result.relayed) {
                    relayPending = false
                    if (result.error !is NoInboundConnection) relayNote = result.error?.message
                } else if (result.reverse) {
                    inboundPending = false
                    if (result.error !is NoInboundConnection) reverseNote = result.error?.message
                } else {
                    val idx = result.candidateIndex
                    if (idx in completedCandidates.indices && completedCandidates[idx]) continue
                    if (idx in completedCandidates.indices) completedCandidates[idx] = true
                    val error = result.error ?: IOException("Socket closed during connect")
                    lastError = error
                    val kind = ConnectionHelp.classify(error, ConnectPhase.TCP, closedLocally = closed)
                    val route = if (kind == FailureKind.TCP_TIMEOUT || kind == FailureKind.NO_ROUTE) routeProbe(result.host, port) else null
                    failures += EndpointAttempt(result.host, port, kind, error.message ?: error.javaClass.simpleName, route)
                    finished++
                    if (finished == candidates.size && reverseDeadlineNanos == 0L) {
                        reverseDeadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(reverseGraceMs)
                    }
                    if (started < candidates.size) {
                        startNext()
                        nextStaggerAtNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(staggerMs)
                    }
                }
                if (finished == candidates.size && !inboundPending && !relayPending) allFailed(lastError)
            }
        } finally {
            activeResultsQueue = null
            if (!raceDone.get()) cleanupRace(null)
        }
    }

    /**
     * One kind for a multi-address failure. "Refused" wins because it proves
     * some address was reachable (AirBridge not running there); then timeout
     * (the hotspot/route case), then no-route.
     */
    private fun summarize(failures: List<EndpointAttempt>): FailureKind {
        if (closed) return FailureKind.CANCELLED
        val kinds = failures.map { it.kind }.toSet()
        return listOf(
            FailureKind.TCP_REFUSED, FailureKind.TCP_TIMEOUT, FailureKind.NO_ROUTE,
            FailureKind.DNS, FailureKind.CANCELLED,
        ).firstOrNull { it in kinds } ?: FailureKind.UNKNOWN
    }

    /** Blocking connect + HTTP upgrade. Throws [ConnectFailure] (with phase and kind) on any failure. */
    fun connectBlocking() {
        if (closed) throw ConnectFailure(ConnectPhase.TCP, FailureKind.CANCELLED, primaryHost, emptyList(), "Socket already closed")
        var phase = ConnectPhase.TCP
        var host = primaryHost
        var viaReverse = false
        try {
            val (winner, plain, reverse, relayed) = connectTcp()
            host = winner
            viaReverse = reverse
            connectedViaReverse = reverse
            connectedViaRelay = relayed
            if (relayed && (!secure || tlsTrustManager == null)) {
                runCatching { plain.close() }
                throw SSLPeerUnverifiedException("Relay connections require a pinned computer identity")
            }
            phase = ConnectPhase.TLS
            val tlsPeerHost = host.removePrefix("[").removeSuffix("]").substringBefore('%')
            val raw: Socket = if (secure) {
                val ctx = SSLContext.getInstance("TLS")
                ctx.init(null, tlsTrustManager?.let { arrayOf<TrustManager>(it) }, null)
                plain.soTimeout = connectTimeoutMs
                (ctx.socketFactory.createSocket(plain, tlsPeerHost, port, true) as SSLSocket).apply {
                    useClientMode = true
                    sslParameters = sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                }
            } else plain
            rawTcpSocket = plain
            socket = raw
            if (closed) { raw.close(); throw IOException("Socket closed during connect") }
            raw.soTimeout = connectTimeoutMs
            if (raw is SSLSocket) {
                raw.startHandshake()
                verifyIpSan(raw, tlsPeerHost)
                tlsAnchorPin = runCatching { PinnedTlsTrust.pinOf(raw.session.peerCertificates.last().encoded) }.getOrNull()
                if (relayed && tlsAnchorPin != relay?.expectedPin) {
                    throw SSLPeerUnverifiedException("Relayed TLS identity changed: the relay did not lead to the paired computer")
                }
            }
            phase = ConnectPhase.UPGRADE
            val out = BufferedOutputStream(raw.getOutputStream(), 512 * 1024)
            val inp = BufferedInputStream(raw.getInputStream(), 512 * 1024)
            output = out
            input = inp

            val keyBytes = ByteArray(16).also { random.nextBytes(it) }
            val key = Base64Url.encodeStandard(keyBytes)
            val handshake = buildString {
                append("GET ").append(resource).append(" HTTP/1.1\r\n")
                append("Host: ").append(if (host.contains(':')) "[$host]" else host).append(':').append(port).append("\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Key: ").append(key).append("\r\n")
                append("Sec-WebSocket-Version: 13\r\n")
                append("\r\n")
            }
            writeLock.lock()
            try {
                withWriteWatchdog {
                    out.write(handshake.toByteArray(Charsets.US_ASCII))
                    out.flush()
                }
            } finally {
                writeLock.unlock()
            }

            // Read status line + headers
            val statusLine = readLine(inp)
            if (statusLine.isEmpty()) throw EOFException("Empty handshake response")
            val status = statusLine.split(" ")
            val code = status.getOrNull(1)?.toIntOrNull() ?: 0
            if (code != 101) throw IOException("WebSocket upgrade rejected: $statusLine")
            var acceptHeader = ""
            var sawUpgrade = false
            var headerBytes = 0
            while (true) {
                val line = readLine(inp)
                headerBytes += line.length
                if (headerBytes > 64 * 1024) throw IOException("Upgrade headers too large")
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) {
                    val name = line.substring(0, idx).trim().lowercase()
                    val value = line.substring(idx + 1).trim()
                    if (name == "sec-websocket-accept") acceptHeader = value
                    if (name == "upgrade" && value.equals("websocket", ignoreCase = true)) sawUpgrade = true
                }
            }
            if (!sawUpgrade || acceptHeader.isEmpty()) throw IOException("Malformed WebSocket handshake")
            val expected = expectedAccept(key)
            if (acceptHeader != expected) throw IOException("Bad Sec-WebSocket-Accept")
            raw.soTimeout = 75_000
            if (closed) throw IOException("Socket closed during upgrade")
            connectedHost = host
            isOpen = true
        } catch (e: Exception) {
            val cancelled = closed
            // A dialled-in peer that fails TLS is not our computer: stop
            // accepting it for a while so it can't starve the real one.
            if (viaReverse && phase != ConnectPhase.TCP && !cancelled) inbound?.reject(host)
            closeInternal(1006, e.message ?: "Connect failed", notify = true)
            if (e is ConnectFailure) throw e
            val kind = ConnectionHelp.classify(e, phase, closedLocally = cancelled)
            val detail = e.message ?: e.javaClass.simpleName
            val combinedAttempts = attempts + EndpointAttempt(host, port, kind, detail)
            attempts = combinedAttempts
            throw ConnectFailure(
                phase, kind, host,
                combinedAttempts,
                "${phase.name} ${kind.name.lowercase()} at $host:$port: $detail", e,
            )
        }
    }

    /**
     * Defense in depth: for IP-literal endpoints require an exact IP SAN, even
     * on platforms whose TLS stack skips endpoint identification for plain
     * X509TrustManagers. A stale leaf that does not list the dialled address
     * fails here as TLS_HOSTNAME instead of silently succeeding.
     */
    private fun verifyIpSan(ssl: SSLSocket, host: String) {
        LocalNetworks.ipAddressBytes(host) ?: return
        val leaf = ssl.session.peerCertificates.firstOrNull() as? X509Certificate
            ?: throw SSLPeerUnverifiedException("No server certificate")
        if (!matchesIpSan(leaf, host)) {
            throw SSLPeerUnverifiedException("No subject alternative name for $host in the server certificate")
        }
        verifiedIpSanHost = host.removePrefix("[").removeSuffix("]").substringBefore('%')
    }

    private fun readLine(inp: InputStream): String {
        val sb = StringBuilder()
        while (true) {
            val b = inp.read()
            if (b == -1) throw EOFException("Connection closed during handshake")
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
            if (sb.length > 16 * 1024) throw IOException("Upgrade line too long")
        }
        return sb.toString()
    }

    private fun expectedAccept(key: String): String {
        val guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        val digest = MessageDigest.getInstance("SHA-1")
            .digest((key + guid).toByteArray(Charsets.US_ASCII))
        return Base64Url.encodeStandard(digest)
    }

    /**
     * Blocking receive loop; invokes listener callbacks on the calling
     * thread until the connection closes. Returns the close reason.
     */
    fun readLoop(): String {
        val inp = input ?: return "not connected"
        var fragmentOp = -1
        var fragments = ByteArrayOutputStream()
        try {
            while (true) {
                val b0 = inp.read()
                if (b0 == -1) throw EOFException("remote closed")
                val fin = (b0 and 0x80) != 0
                val opcode = b0 and 0x0f
                if (b0 and 0x70 != 0) throw IOException("Unexpected WebSocket extensions")
                val b1 = inp.read()
                if (b1 == -1) throw EOFException("remote closed")
                val masked = (b1 and 0x80) != 0
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) {
                    readExactInto(inp, lengthScratch, 2)
                    len = (((lengthScratch[0].toInt() and 0xff) shl 8) or
                        (lengthScratch[1].toInt() and 0xff)).toLong()
                } else if (len == 127L) {
                    readExactInto(inp, lengthScratch, 8)
                    len = 0
                    for (idx in 0 until 8) len = (len shl 8) or (lengthScratch[idx].toLong() and 0xff)
                }
                if (len < 0 || len > maxMessageBytes) throw IOException("frame too large: $len")
                if (masked) throw IOException("Server frames must not be masked")
                if (opcode >= 8 && (!fin || len > 125)) throw IOException("Invalid control frame")
                if (opcode == 0 && fragments.size().toLong() + len > maxMessageBytes) {
                    throw IOException("Fragmented message too large")
                }
                if (opcode in 1..2 && fragmentOp != -1) throw IOException("Interleaved data fragments")
                val maskKey = if (masked) readExact(inp, 4) else null
                val payload = if (len > 0) readExact(inp, len.toInt()) else ByteArray(0)
                if (maskKey != null) {
                    for (i in payload.indices) {
                        payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
                    }
                }

                when (opcode) {
                    0x0 -> { // continuation
                        if (fragmentOp == -1) throw IOException("unexpected continuation")
                        fragments.write(payload)
                        if (fin) {
                            deliver(fragmentOp, fragments.toByteArray())
                            fragmentOp = -1
                            fragments = ByteArrayOutputStream()
                        }
                    }
                    0x1, 0x2 -> {
                        if (!fin) {
                            fragmentOp = opcode
                            fragments = ByteArrayOutputStream(payload.size)
                            fragments.write(payload)
                        } else {
                            deliver(opcode, payload)
                        }
                    }
                    0x8 -> { // close
                        closeInternal(1000, "remote close", notify = true)
                        return "remote closed"
                    }
                    0x9 -> enqueuePong(payload)
                    0xA -> { /* pong */ }
                    else -> throw IOException("unknown opcode $opcode")
                }
            }
        } catch (e: Exception) {
            closeInternal(1006, e.message ?: "read error", notify = true)
            return "read error: ${e.message}"
        }
        return "closed"
    }

    private fun deliver(opcode: Int, payload: ByteArray) {
        when (opcode) {
            0x1 -> listener.onText(String(payload, Charsets.UTF_8))
            0x2 -> listener.onBinary(payload)
        }
    }

    private fun readExactInto(inp: InputStream, buf: ByteArray, count: Int) {
        var off = 0
        while (off < count) {
            val n = inp.read(buf, off, count - off)
            if (n == -1) throw EOFException("connection closed mid-frame")
            off += n
        }
    }

    private fun readExact(inp: InputStream, count: Int): ByteArray {
        val buf = ByteArray(count)
        readExactInto(inp, buf, count)
        return buf
    }

    private fun enqueuePong(payload: ByteArray) {
        if (!isOpen || closed) return
        pendingPong.set(payload)
        scheduleControlDrain(0L)
    }

    fun sendText(text: String, flush: Boolean = true) = sendFrame(0x1, text.toByteArray(Charsets.UTF_8), flush)

    fun sendBinary(bytes: ByteArray, flush: Boolean = true) = sendFrame(0x2, bytes, flush)

    fun sendPing() {
        if (output == null || !isOpen || closed) throw IOException("socket closed")
        pendingPing.set(true)
        scheduleControlDrain(0L)
    }

    private fun scheduleControlDrain(delayMs: Long) {
        if (!isOpen || closed) return
        if (delayMs <= 0L) {
            if (!controlScheduled.compareAndSet(false, true)) return
            try {
                controlScheduler.execute {
                    controlScheduled.set(false)
                    drainControlFrames()
                }
            } catch (_: RejectedExecutionException) {
                controlScheduled.set(false)
            }
        } else {
            if (!controlRetryScheduled.compareAndSet(false, true)) return
            try {
                val f = controlScheduler.schedule({
                    controlRetryScheduled.set(false)
                    drainControlFrames()
                }, delayMs, TimeUnit.MILLISECONDS)
                controlRetryFuture = f
                if (closed) {
                    f.cancel(false)
                    controlRetryScheduled.set(false)
                }
            } catch (_: RejectedExecutionException) {
                controlRetryScheduled.set(false)
            }
        }
    }

    private fun drainControlFrames() {
        val out = output ?: return
        if (!isOpen || closed) return
        val acquired = try {
            writeLock.tryLock(25, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            return
        }
        if (!acquired) {
            if (isOpen && !closed && (pendingPong.get() != null || pendingPing.get())) {
                scheduleControlDrain(150L)
            }
            return
        }
        try {
            if (!isOpen || closed) return
            pendingPong.getAndSet(null)?.let { writeFrameLocked(out, 0xA, it, flush = true) }
            if (pendingPing.getAndSet(false)) writeFrameLocked(out, 0x9, emptyPayload, flush = true)
        } catch (e: Exception) {
            closeInternal(1006, e.message ?: "control write error", notify = true)
            return
        } finally {
            writeLock.unlock()
        }
        if (isOpen && !closed && (pendingPong.get() != null || pendingPing.get())) {
            scheduleControlDrain(0L)
        }
    }

    /** Flush any queued Pong/Ping between outbound transfer batches so heartbeats never starve. */
    fun drainPendingControlIfAny() {
        if (!isOpen || closed) return
        if (pendingPong.get() != null || pendingPing.get()) {
            drainControlFrames()
        }
    }

    private fun armWriteWatchdogIfNeeded() {
        if (writeTimeoutMs <= 0L || closed) return
        synchronized(writeWatchdogLock) {
            if (writeWatchdog != null || closed) return
            writeWatchdog = runCatching {
                controlScheduler.schedule({ checkWriteStall() }, writeTimeoutMs, TimeUnit.MILLISECONDS)
            }.getOrNull()
        }
    }

    private fun checkWriteStall() {
        val started = activeWriteStartedNanos
        if (closed || started == 0L) {
            synchronized(writeWatchdogLock) { writeWatchdog = null }
            return
        }
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        if (elapsedMs < writeTimeoutMs) {
            val remaining = maxOf(10L, writeTimeoutMs - elapsedMs)
            synchronized(writeWatchdogLock) {
                writeWatchdog = if (!closed) {
                    runCatching { controlScheduler.schedule({ checkWriteStall() }, remaining, TimeUnit.MILLISECONDS) }.getOrNull()
                } else null
            }
            return
        }
        synchronized(writeWatchdogLock) { writeWatchdog = null }
        writeStalls.incrementAndGet()
        runCatching { onWriteStall?.invoke() }
        val tcp = rawTcpSocket
        val sock = socket
        if (tcp != null && tcp !== sock) runCatching { tcp.close() }
        closeInternal(1006, "write stalled after ${elapsedMs}ms", notify = true)
    }

    private inline fun <T> withWriteWatchdog(block: () -> T): T {
        activeWriteStartedNanos = System.nanoTime()
        armWriteWatchdogIfNeeded()
        try {
            return block()
        } finally {
            activeWriteStartedNanos = 0L
        }
    }

    fun flush() {
        val out = output ?: return
        if (!isOpen || closed) return
        writeLock.lock()
        try {
            if (!isOpen || closed) return
            withWriteWatchdog { out.flush() }
        } finally {
            writeLock.unlock()
        }
    }

    private fun sendFrame(opcode: Int, payload: ByteArray, flush: Boolean) {
        val out = output ?: throw IOException("not connected")
        if (!isOpen || closed) throw IOException("socket closed")
        writeLock.lock()
        try {
            if (!isOpen || closed) throw IOException("socket closed")
            writeFrameLocked(out, opcode, payload, flush)
        } finally {
            writeLock.unlock()
        }
    }

    private fun writeFrameLocked(out: OutputStream, opcode: Int, payload: ByteArray, flush: Boolean) {
        random.nextBytes(maskKey)
        var h = 0
        headerBuffer[h++] = (0x80 or opcode).toByte()
        val len = payload.size
        when {
            len < 126 -> headerBuffer[h++] = (0x80 or len).toByte()
            len <= 0xffff -> {
                headerBuffer[h++] = (0x80 or 126).toByte()
                headerBuffer[h++] = ((len ushr 8) and 0xff).toByte()
                headerBuffer[h++] = (len and 0xff).toByte()
            }
            else -> {
                headerBuffer[h++] = (0x80 or 127).toByte()
                for (shift in 56 downTo 0 step 8) {
                    headerBuffer[h++] = ((len.toLong() ushr shift) and 0xff).toByte()
                }
            }
        }
        System.arraycopy(maskKey, 0, headerBuffer, h, 4)
        h += 4
        withWriteWatchdog {
            out.write(headerBuffer, 0, h)
            val key0 = maskKey[0].toInt()
            val key1 = maskKey[1].toInt()
            val key2 = maskKey[2].toInt()
            val key3 = maskKey[3].toInt()
            var offset = 0
            while (offset < len) {
                activeWriteStartedNanos = System.nanoTime()
                val count = minOf(maskBuffer.size, len - offset)
                if ((offset and 3) == 0) {
                    var i = 0
                    val limit8 = count and -8
                    while (i < limit8) {
                        val p = offset + i
                        maskBuffer[i] = (payload[p].toInt() xor key0).toByte()
                        maskBuffer[i + 1] = (payload[p + 1].toInt() xor key1).toByte()
                        maskBuffer[i + 2] = (payload[p + 2].toInt() xor key2).toByte()
                        maskBuffer[i + 3] = (payload[p + 3].toInt() xor key3).toByte()
                        maskBuffer[i + 4] = (payload[p + 4].toInt() xor key0).toByte()
                        maskBuffer[i + 5] = (payload[p + 5].toInt() xor key1).toByte()
                        maskBuffer[i + 6] = (payload[p + 6].toInt() xor key2).toByte()
                        maskBuffer[i + 7] = (payload[p + 7].toInt() xor key3).toByte()
                        i += 8
                    }
                    val limit4 = count and -4
                    while (i < limit4) {
                        val p = offset + i
                        maskBuffer[i] = (payload[p].toInt() xor key0).toByte()
                        maskBuffer[i + 1] = (payload[p + 1].toInt() xor key1).toByte()
                        maskBuffer[i + 2] = (payload[p + 2].toInt() xor key2).toByte()
                        maskBuffer[i + 3] = (payload[p + 3].toInt() xor key3).toByte()
                        i += 4
                    }
                    while (i < count) {
                        maskBuffer[i] = (payload[offset + i].toInt() xor maskKey[(offset + i) and 3].toInt()).toByte()
                        i++
                    }
                } else {
                    for (i in 0 until count) maskBuffer[i] =
                        (payload[offset + i].toInt() xor maskKey[(offset + i) and 3].toInt()).toByte()
                }
                out.write(maskBuffer, 0, count)
                offset += count
            }
            if (flush) {
                activeWriteStartedNanos = System.nanoTime()
                out.flush()
            }
        }
    }

    /** True once [close] was called by the owner (reconnect/stop), as opposed to a remote/network close. */
    @Volatile
    var closedByClient = false
        private set

    fun close() {
        if (!closed) closedByClient = true
        closeInternal(1000, "client close", notify = true)
    }

    private fun closeInternal(@Suppress("UNUSED_PARAMETER") code: Int, reason: String, notify: Boolean) {
        synchronized(closeLock) {
            if (closed) return
            closed = true
            isOpen = false
        }
        pendingPong.set(null)
        pendingPing.set(false)
        controlRetryFuture?.cancel(false)
        controlRetryFuture = null
        controlRetryScheduled.set(false)
        synchronized(writeWatchdogLock) {
            writeWatchdog?.cancel(false)
            writeWatchdog = null
        }
        // Never wait for writeLock here: the writer may be blocked on a dead
        // network. Closing the socket is what unblocks it.
        val tcp = rawTcpSocket
        val sock = socket
        if (tcp != null && tcp !== sock) runCatching { tcp.close() }
        try { sock?.close() } catch (_: Exception) {}
        for (pending in inFlight) runCatching { pending.close() }
        inFlight.clear()
        activeResultsQueue?.offer(TcpResult("", null, IOException(reason)))
        if (notify) listener.onClosed(reason)
    }

    private fun String?.ifNullOrEmpty(fallback: String): String =
        if (this.isNullOrEmpty()) fallback else this

    companion object {
        const val MAX_DIAL_THREADS = 16
        const val MAX_DNS_THREADS = 8

        private val activeDialTasks = AtomicInteger(0)

        fun activeDialThreadCount(): Int = activeDialTasks.get()

        private fun daemonFactory(prefix: String): ThreadFactory {
            val nextId = AtomicInteger(1)
            return ThreadFactory { r ->
                Thread(r, "$prefix-${nextId.getAndIncrement()}").apply { isDaemon = true }
            }
        }

        private val dialExecutor: ThreadPoolExecutor = ThreadPoolExecutor(
            MAX_DIAL_THREADS,
            MAX_DIAL_THREADS,
            30L,
            TimeUnit.SECONDS,
            LinkedBlockingQueue(128),
            daemonFactory("airbridge-dial"),
        ).apply { allowCoreThreadTimeOut(true) }

        private val dnsExecutor: ThreadPoolExecutor = ThreadPoolExecutor(
            MAX_DNS_THREADS,
            MAX_DNS_THREADS,
            30L,
            TimeUnit.SECONDS,
            LinkedBlockingQueue(64),
            daemonFactory("airbridge-dns"),
        ).apply { allowCoreThreadTimeOut(true) }

        private val controlScheduler: ScheduledThreadPoolExecutor = ScheduledThreadPoolExecutor(
            2,
            daemonFactory("airbridge-ws-ctrl"),
        ).apply { removeOnCancelPolicy = true }

        private fun isLinuxOrAndroid(): Boolean = try {
            val os = System.getProperty("os.name")?.lowercase() ?: ""
            os.contains("linux") || os.contains("android")
        } catch (_: Exception) { true }

        internal fun matchesIpSan(leaf: X509Certificate, host: String): Boolean {
            val targetBytes = LocalNetworks.ipAddressBytes(host) ?: return true
            return runCatching {
                leaf.subjectAlternativeNames?.any { entry ->
                    if ((entry.getOrNull(0) as? Int) != 7) return@any false
                    val sanBytes = when (val v = entry.getOrNull(1)) {
                        is String -> LocalNetworks.ipAddressBytes(v)
                        is ByteArray -> when (v.size) {
                            4 -> v
                            16 -> if ((0..9).all { v[it] == 0.toByte() } && v[10] == 0xff.toByte() && v[11] == 0xff.toByte()) {
                                v.copyOfRange(12, 16)
                            } else v
                            else -> null
                        }
                        else -> null
                    }
                    sanBytes != null && targetBytes.contentEquals(sanBytes)
                } == true
            }.getOrDefault(false)
        }

        private fun resolveAddresses(
            host: String,
            timeoutMs: Int,
            dnsTimeoutMs: Long,
            dnsResolver: (String) -> Array<InetAddress>,
            onDns: (Long) -> Unit,
        ): Array<InetAddress> {
            val literalBytes = LocalNetworks.ipAddressBytes(host)
            if (literalBytes != null) {
                val stripped = host.trim().removePrefix("[").removeSuffix("]")
                val addr = runCatching { InetAddress.getByName(stripped) }
                    .getOrElse { InetAddress.getByAddress(literalBytes) }
                return arrayOf(addr)
            }
            val effectiveTimeoutMs = minOf(timeoutMs.toLong(), dnsTimeoutMs).coerceAtLeast(1L)
            val t0 = System.nanoTime()
            val future = try {
                dnsExecutor.submit(Callable { dnsResolver(host) })
            } catch (_: RejectedExecutionException) {
                throw UnknownHostException("DNS resolver busy for $host")
            }
            try {
                val addrs = future.get(effectiveTimeoutMs, TimeUnit.MILLISECONDS)
                if (addrs.isEmpty()) throw UnknownHostException("No addresses for $host")
                return addrs
            } catch (_: TimeoutException) {
                future.cancel(true)
                throw UnknownHostException("DNS lookup exceeded ${effectiveTimeoutMs}ms for $host")
            } catch (_: InterruptedException) {
                future.cancel(true)
                Thread.currentThread().interrupt()
                throw UnknownHostException("DNS lookup interrupted for $host")
            } catch (e: ExecutionException) {
                val cause = e.cause
                if (cause is UnknownHostException) throw cause
                throw UnknownHostException("DNS lookup failed for $host: ${cause?.message ?: e.message}")
            } finally {
                onDns(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0))
            }
        }

        internal fun connectWithBoundedDns(
            host: String,
            port: Int,
            timeoutMs: Int,
            dnsTimeoutMs: Long,
            dnsResolver: (String) -> Array<InetAddress>,
            onDns: (Long) -> Unit,
            register: (Socket) -> Unit,
        ): Socket {
            val addrs = resolveAddresses(host, timeoutMs, dnsTimeoutMs, dnsResolver, onDns)
            val startNanos = System.nanoTime()
            var lastErr: Exception? = null
            val linuxOrAndroid = isLinuxOrAndroid()
            for (i in addrs.indices) {
                val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos)
                val remainingMs = (timeoutMs.toLong() - elapsedMs).toInt()
                if (i > 0 && remainingMs <= 0) break
                val perAddrTimeout = if (addrs.size == 1) maxOf(500, remainingMs)
                else maxOf(500, remainingMs / (addrs.size - i))
                val s = Socket()
                register(s)
                s.tcpNoDelay = true
                s.keepAlive = true
                // Allow Linux/Android dynamic TCP window auto-tuning (tcp_moderate_rcvbuf)
                // to scale up to kernel limits (4MB-8MB) without setting SOCK_RCVBUF_LOCK.
                // Guarded: setting SO_RCVBUF manually on Linux/Android clamps window to rmem_max.
                if (!linuxOrAndroid) {
                    s.receiveBufferSize = 4 * 1024 * 1024
                    s.sendBufferSize = 2 * 1024 * 1024
                }
                try {
                    s.connect(InetSocketAddress(addrs[i], port), perAddrTimeout)
                    return s
                } catch (e: Exception) {
                    runCatching { s.close() }
                    lastErr = e
                    if (Thread.currentThread().isInterrupted) break
                }
            }
            throw lastErr ?: SocketTimeoutException("Connect timed out")
        }

        val DEFAULT_TCP_CONNECTOR = TcpConnector { host, port, timeoutMs, register ->
            connectWithBoundedDns(
                host = host,
                port = port,
                timeoutMs = timeoutMs,
                dnsTimeoutMs = 5_000L,
                dnsResolver = { InetAddress.getAllByName(it) },
                onDns = {},
                register = register,
            )
        }
    }
}
