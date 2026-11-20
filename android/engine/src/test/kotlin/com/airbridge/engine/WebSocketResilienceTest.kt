package com.airbridge.engine

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.FilterOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.system.exitProcess

private var resPassed = 0
private var resFailed = 0

private fun rCheck(label: String, ok: Boolean, detail: () -> String = { "" }) {
    if (ok) resPassed++ else {
        resFailed++
        System.err.println("FAIL $label ${detail()}")
    }
}

private fun acceptUpgrade(socket: Socket) {
    val inp = socket.getInputStream()
    val sb = StringBuilder()
    var tail = 0
    while (true) {
        val b = inp.read()
        if (b < 0) throw IOException("EOF during upgrade")
        sb.append(b.toChar())
        tail = ((tail shl 8) or b) and 0xffffffff.toInt()
        if (tail == 0x0d0a0d0a) break
    }
    val key = sb.toString().lines()
        .firstOrNull { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
        ?.substringAfter(':')?.trim() ?: error("Missing Sec-WebSocket-Key")
    val accept = Base64.getEncoder().encodeToString(
        MessageDigest.getInstance("SHA-1")
            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII)),
    )
    socket.getOutputStream().write(
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n")
            .toByteArray(Charsets.US_ASCII),
    )
    socket.getOutputStream().flush()
}

private fun sendUnmaskedServerFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
    val hdr = ByteArrayOutputStream(10)
    hdr.write(0x80 or (opcode and 0x0f))
    when {
        payload.size < 126 -> hdr.write(payload.size)
        else -> {
            hdr.write(126)
            hdr.write((payload.size ushr 8) and 0xff)
            hdr.write(payload.size and 0xff)
        }
    }
    out.write(hdr.toByteArray())
    out.write(payload)
    out.flush()
}

private fun readMaskedClientFrame(dis: DataInputStream): Pair<Int, ByteArray>? {
    val b0 = try { dis.read() } catch (_: Exception) { -1 }
    if (b0 < 0) return null
    val b1 = dis.read()
    if (b1 < 0) return null
    val opcode = b0 and 0x0f
    val masked = (b1 and 0x80) != 0
    var len = (b1 and 0x7f).toLong()
    if (len == 126L) len = dis.readUnsignedShort().toLong()
    val mask = if (masked) ByteArray(4).also { dis.readFully(it) } else null
    val payload = ByteArray(len.toInt())
    dis.readFully(payload)
    if (mask != null) {
        for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
    }
    return opcode to payload
}

private fun testStalledWriterDoesNotDeadlockReadLoopAndTripsWatchdog() {
    val server = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
    val upgradedLatch = CountDownLatch(1)
    val serverSockRef = AtomicReference<Socket?>(null)
    val serverThread = thread(isDaemon = true, name = "stall-test-srv") {
        runCatching {
            val s = server.accept()
            serverSockRef.set(s)
            acceptUpgrade(s)
            upgradedLatch.countDown()
        }
    }

    val writerBlockedLatch = CountDownLatch(1)
    val unblockLatch = CountDownLatch(1)
    val upgradePassed = AtomicBoolean(false)

    val stallingConnector = TcpConnector { _, _, timeoutMs, register ->
        val raw = Socket()
        val wrapped = object : Socket() {
            private lateinit var realIn: InputStream
            private lateinit var realOut: OutputStream
            private val wrappedOut = object : FilterOutputStream(OutputStream.nullOutputStream()) {
                override fun write(b: ByteArray, off: Int, len: Int) {
                    val text = if (!upgradePassed.get() && len > 0) String(b, off, len, Charsets.US_ASCII) else ""
                    if (!upgradePassed.get() && text.startsWith("GET ")) {
                        realOut.write(b, off, len)
                        upgradePassed.set(true)
                        return
                    }
                    writerBlockedLatch.countDown()
                    unblockLatch.await(10, TimeUnit.SECONDS)
                    throw IOException("Socket closed during stalled write")
                }

                override fun write(b: Int) {
                    write(byteArrayOf(b.toByte()), 0, 1)
                }

                override fun flush() {
                    if (upgradePassed.get()) realOut.flush()
                }
            }

            fun initStreams() {
                realIn = raw.getInputStream()
                realOut = raw.getOutputStream()
            }

            override fun getInputStream(): InputStream = realIn
            override fun getOutputStream(): OutputStream = wrappedOut
            override fun setSoTimeout(timeout: Int) { raw.soTimeout = timeout }
            override fun getSoTimeout(): Int = raw.soTimeout
            override fun setTcpNoDelay(on: Boolean) { raw.tcpNoDelay = on }
            override fun setKeepAlive(on: Boolean) { raw.keepAlive = on }
            override fun isClosed(): Boolean = raw.isClosed
            override fun close() {
                unblockLatch.countDown()
                raw.close()
            }
        }
        register(wrapped)
        raw.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), server.localPort), timeoutMs)
        wrapped.initStreams()
        wrapped
    }

    val aliveReceived = CountDownLatch(1)
    val onClosedLatch = CountDownLatch(1)
    val stallCallbacks = AtomicInteger(0)
    val client = WebSocketClient(
        url = "ws://127.0.0.1:${server.localPort}/ws",
        listener = object : WebSocketClient.Listener {
            override fun onText(text: String) {
                if (text == "alive") aliveReceived.countDown()
            }
            override fun onBinary(bytes: ByteArray) {}
            override fun onClosed(reason: String) { onClosedLatch.countDown() }
        },
        tcpConnector = stallingConnector,
        writeTimeoutMs = 350L,
        onWriteStall = { stallCallbacks.incrementAndGet() },
    )

    try {
        client.connectBlocking()
        rCheck("stalled-writer: upgraded", upgradedLatch.await(2, TimeUnit.SECONDS))
        val readThread = thread(isDaemon = true, name = "stall-test-read") { client.readLoop() }
        val writerThread = thread(isDaemon = true, name = "stall-test-write") {
            runCatching { client.sendBinary(ByteArray(64 * 1024)) }
        }
        rCheck("stalled-writer: writer blocked inside write()", writerBlockedLatch.await(2, TimeUnit.SECONDS))

        // While writerThread holds writeLock and is blocked in write(), server sends 0x9 Ping + 0x1 Text("alive").
        val srvSock = serverSockRef.get()!!
        val srvOut = srvSock.getOutputStream()
        sendUnmaskedServerFrame(srvOut, 0x9, "ping".toByteArray(Charsets.US_ASCII))
        sendUnmaskedServerFrame(srvOut, 0x1, "alive".toByteArray(Charsets.UTF_8))

        rCheck("stalled-writer: readLoop did NOT deadlock on Ping", aliveReceived.await(1, TimeUnit.SECONDS))
        rCheck("stalled-writer: watchdog closed stalled socket", onClosedLatch.await(3, TimeUnit.SECONDS))

        writerThread.join(2_000)
        readThread.join(2_000)
        rCheck("stalled-writer: writerThread terminated", !writerThread.isAlive)
        rCheck("stalled-writer: readThread terminated", !readThread.isAlive)
        rCheck("stalled-writer: writeStallCount >= 1", client.writeStallCount >= 1L)
        rCheck("stalled-writer: onWriteStall callback fired", stallCallbacks.get() >= 1)
        rCheck("stalled-writer: !closedByClient", !client.closedByClient)
        rCheck("stalled-writer: !isOpen", !client.isOpen)
    } finally {
        unblockLatch.countDown()
        client.close()
        runCatching { serverSockRef.get()?.close() }
        runCatching { server.close() }
        serverThread.join(1_000)
    }
}

private fun testUnstalledPongAndSendPing() {
    val server = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
    val pongEchoOk = CountDownLatch(1)
    val pingRecvOk = CountDownLatch(1)
    val srvThread = thread(isDaemon = true, name = "pong-test-srv") {
        runCatching {
            server.accept().use { sock ->
                sock.soTimeout = 3_000
                acceptUpgrade(sock)
                val out = sock.getOutputStream()
                sendUnmaskedServerFrame(out, 0x9, "echo-42".toByteArray(Charsets.US_ASCII))
                val dis = DataInputStream(sock.getInputStream())
                while (true) {
                    val (op, payload) = readMaskedClientFrame(dis) ?: break
                    if (op == 0xA && String(payload, Charsets.US_ASCII) == "echo-42") pongEchoOk.countDown()
                    if (op == 0x9) pingRecvOk.countDown()
                    if (op == 0x8) break
                }
            }
        }
    }
    val client = WebSocketClient(
        "ws://127.0.0.1:${server.localPort}/ws",
        object : WebSocketClient.Listener {
            override fun onText(text: String) {}
            override fun onBinary(bytes: ByteArray) {}
            override fun onClosed(reason: String) {}
        },
    )
    try {
        client.connectBlocking()
        val rt = thread(isDaemon = true) { client.readLoop() }
        rCheck("pong: server received async 0xA Pong echo", pongEchoOk.await(2, TimeUnit.SECONDS))
        client.sendPing()
        rCheck("pong: server received async 0x9 Ping", pingRecvOk.await(2, TimeUnit.SECONDS))
        client.close()
        rt.join(1_000)
    } finally {
        client.close()
        runCatching { server.close() }
        srvThread.join(1_000)
    }
}

private fun testConnectCancellationNoThreadLeak() {
    val blackholeConnector = TcpConnector { _, _, timeoutMs, register ->
        val s = Socket()
        register(s)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.toLong())
        while (System.nanoTime() < deadline) {
            if (s.isClosed) throw IOException("Socket closed")
            Thread.sleep(15)
        }
        s.close()
        throw SocketTimeoutException("Connect timed out")
    }
    val blackholeInbound = object : InboundConnections {
        override fun await(timeoutMs: Long, cancelled: () -> Boolean, register: (Socket) -> Unit): Socket? {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (System.nanoTime() < deadline && !cancelled()) Thread.sleep(15)
            return null
        }
        override fun reject(host: String) {}
    }
    val fakePin = "A".repeat(43)
    val fakeRelay = WebSocketClient.RelayDial(RelayRoute("relay.invalid", 443, "a".repeat(64)), fakePin, delayMs = 20L)

    for (cycle in 0 until 20) {
        val client = WebSocketClient(
            url = "wss://10.255.255.1:3000/ws",
            listener = object : WebSocketClient.Listener {
                override fun onText(text: String) {}
                override fun onBinary(bytes: ByteArray) {}
                override fun onClosed(reason: String) {}
            },
            tlsTrustManager = PinnedTlsTrust({ null }, {}, fakePin),
            connectTimeoutMs = 5_000,
            alternateHosts = listOf("10.255.255.2", "10.255.255.3", "10.255.255.4"),
            staggerMs = 20L,
            tcpConnector = blackholeConnector,
            routeProbe = { _, _ -> null },
            inbound = blackholeInbound,
            relay = fakeRelay,
        )
        val err = AtomicReference<Throwable?>()
        val t0 = System.nanoTime()
        val t = thread { err.set(runCatching { client.connectBlocking() }.exceptionOrNull()) }
        Thread.sleep(25)
        client.close()
        t.join(1_500)
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0)
        val cf = err.get() as? ConnectFailure
        rCheck("cancel cycle $cycle unblocked quickly (${elapsedMs}ms)", !t.isAlive && elapsedMs < 1_000L)
        rCheck("cancel cycle $cycle kind == CANCELLED", cf?.kind == FailureKind.CANCELLED) { "got $cf" }
    }

    val settleDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1_500L)
    while (WebSocketClient.activeDialThreadCount() > 0 && System.nanoTime() < settleDeadline) {
        Thread.sleep(20)
    }
    rCheck(
        "cancel: activeDialThreadCount() == 0",
        WebSocketClient.activeDialThreadCount() == 0,
    ) { "active=${WebSocketClient.activeDialThreadCount()}" }

    val threadNames = Thread.getAllStackTraces().keys.map { it.name }
    val reaperCount = threadNames.count { it == "airbridge-dial-reaper" }
    val poolThreadCount = threadNames.count { it.startsWith("airbridge-dial") || it.startsWith("airbridge-dns") }
    rCheck("cancel: zero airbridge-dial-reaper threads", reaperCount == 0) { "reaperCount=$reaperCount" }
    rCheck(
        "cancel: bounded dial+dns thread count ($poolThreadCount <= ${WebSocketClient.MAX_DIAL_THREADS + WebSocketClient.MAX_DNS_THREADS})",
        poolThreadCount <= WebSocketClient.MAX_DIAL_THREADS + WebSocketClient.MAX_DNS_THREADS,
    )
}

private fun testBoundedDnsTimeoutAndRelayDeadline() {
    // 1. Stalled DNS throws FailureKind.DNS within dnsTimeoutMs and records lastDnsMs.
    val t0 = System.nanoTime()
    val dnsClient = WebSocketClient(
        url = "ws://stalled-dns.invalid:3000/ws",
        listener = object : WebSocketClient.Listener {
            override fun onText(text: String) {}
            override fun onBinary(bytes: ByteArray) {}
            override fun onClosed(reason: String) {}
        },
        connectTimeoutMs = 5_000,
        dnsTimeoutMs = 200L,
        dnsResolver = {
            Thread.sleep(10_000)
            emptyArray()
        },
    )
    val err = runCatching { dnsClient.connectBlocking() }.exceptionOrNull() as? ConnectFailure
    val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0)
    rCheck("dns timeout failed fast (${elapsedMs}ms < 1500ms)", elapsedMs < 1_500L)
    rCheck("dns timeout classified as FailureKind.DNS", err?.kind == FailureKind.DNS) { "got $err" }
    rCheck("dns timeout recorded lastDnsMs", dnsClient.lastDnsMs != null)

    // 2. ConnectionHelp classifies UnknownHostException containing "timed out" as DNS.
    rCheck(
        "ConnectionHelp UnknownHostException beats 'timed out'",
        ConnectionHelp.classify(UnknownHostException("DNS lookup timed out"), ConnectPhase.TCP) == FailureKind.DNS,
    )

    // 3. RouteProbe never runs blocking DNS for hostnames.
    val rpStart = System.nanoTime()
    val rpResult = RouteProbe.sourceAddressFor("nonexistent.invalid", 3000)
    val rpMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - rpStart)
    rCheck("RouteProbe skips DNS hostname immediately", rpResult == null && rpMs < 100L) { "rpMs=$rpMs rpResult=$rpResult" }

    // 4. Stalled relay deadline terminates cleanly instead of spinning/hanging.
    val stallingConnector = TcpConnector { _, _, timeoutMs, register ->
        val s = Socket()
        register(s)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(30_000L)
        while (System.nanoTime() < deadline) {
            if (s.isClosed) throw IOException("Socket closed")
            Thread.sleep(15)
        }
        throw SocketTimeoutException("Connect timed out")
    }
    val noInbound = object : InboundConnections {
        override fun await(timeoutMs: Long, cancelled: () -> Boolean, register: (Socket) -> Unit): Socket? = null
        override fun reject(host: String) {}
    }
    val fakePin = "B".repeat(43)
    val relayClient = WebSocketClient(
        url = "wss://10.255.255.1:3000/ws",
        listener = object : WebSocketClient.Listener {
            override fun onText(text: String) {}
            override fun onBinary(bytes: ByteArray) {}
            override fun onClosed(reason: String) {}
        },
        tlsTrustManager = PinnedTlsTrust({ null }, {}, fakePin),
        connectTimeoutMs = 150,
        reverseGraceMs = 50L,
        tcpConnector = stallingConnector,
        routeProbe = { _, _ -> null },
        inbound = noInbound,
        relay = WebSocketClient.RelayDial(RelayRoute("relay.invalid", 443, "b".repeat(64)), fakePin, delayMs = 20L),
        relayTimeoutMs = 250L,
    )
    val rStart = System.nanoTime()
    val rErr = runCatching { relayClient.connectBlocking() }.exceptionOrNull() as? ConnectFailure
    val rElapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - rStart)
    rCheck("stalled relay deadline terminates cleanly (${rElapsed}ms < 3000ms)", rElapsed < 3_000L && rErr != null) {
        "rElapsed=$rElapsed rErr=$rErr"
    }
}

fun runWebSocketResilienceChecks() {
    resPassed = 0
    resFailed = 0
    testStalledWriterDoesNotDeadlockReadLoopAndTripsWatchdog()
    testUnstalledPongAndSendPing()
    testConnectCancellationNoThreadLeak()
    testBoundedDnsTimeoutAndRelayDeadline()
    if (resFailed > 0) error("WebSocketResilienceTest failed ($resFailed checks)")
}

fun main() {
    runWebSocketResilienceChecks()
    println("WebSocketResilienceTest: $resPassed passed, $resFailed failed")
    if (resFailed > 0) exitProcess(1)
}
