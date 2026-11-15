package com.airbridge.engine

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.random.Random

private var m2Passed = 0

private fun check(cond: Boolean, msg: String) {
    if (!cond) throw AssertionError("Milestone2Test FAILED: $msg")
    m2Passed++
}

private fun sha256Hex(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(128 * 1024)
    file.inputStream().use { input ->
        while (true) {
            val r = input.read(buf)
            if (r <= 0) break
            md.update(buf, 0, r)
        }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
}

private fun readHttpHeaders(input: InputStream): String {
    val sb = StringBuilder()
    var tail = 0
    while (true) {
        val b = input.read()
        if (b < 0) break
        sb.append(b.toChar())
        tail = ((tail shl 8) or b) and 0xffffffff.toInt()
        if (tail == 0x0d0a0d0a) break
    }
    return sb.toString()
}

private fun acceptWsUpgrade(socket: Socket) {
    val headers = readHttpHeaders(socket.getInputStream())
    val key = headers.lines()
        .firstOrNull { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
        ?.substringAfter(':')
        ?.trim()
        ?: error("Missing Sec-WebSocket-Key")
    val accept = Base64.getEncoder().encodeToString(
        MessageDigest.getInstance("SHA-1")
            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII)),
    )
    socket.getOutputStream().write(
        ("HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n\r\n").toByteArray(Charsets.US_ASCII),
    )
    socket.getOutputStream().flush()
}

private fun readClientFrame(dis: DataInputStream): Pair<Int, ByteArray>? {
    val b0 = try { dis.read() } catch (_: Exception) { -1 }
    if (b0 < 0) return null
    val b1 = dis.read()
    if (b1 < 0) return null
    val opcode = b0 and 0x0f
    val masked = (b1 and 0x80) != 0
    var len = (b1 and 0x7f).toLong()
    if (len == 126L) len = dis.readUnsignedShort().toLong()
    else if (len == 127L) len = dis.readLong()
    val mask = if (masked) ByteArray(4).also { dis.readFully(it) } else null
    val payload = ByteArray(len.toInt())
    dis.readFully(payload)
    if (mask != null) {
        for (i in payload.indices) {
            payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        }
    }
    return opcode to payload
}

private fun writeServerFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
    val hdr = ByteArrayOutputStream(10)
    hdr.write(0x80 or (opcode and 0x0f))
    when {
        payload.size < 126 -> hdr.write(payload.size)
        payload.size <= 0xffff -> {
            hdr.write(126)
            hdr.write((payload.size ushr 8) and 0xff)
            hdr.write(payload.size and 0xff)
        }
        else -> {
            hdr.write(127)
            val l = payload.size.toLong()
            for (shift in 56 downTo 0 step 8) hdr.write(((l ushr shift) and 0xffL).toInt())
        }
    }
    synchronized(out) {
        out.write(hdr.toByteArray())
        out.write(payload)
        out.flush()
    }
}

private fun testLimitsAndBinarySackCodec() {
    check(Limits.CHUNK_SIZE == 1024 * 1024, "Limits.CHUNK_SIZE should be 1 MiB")
    check(Limits.windowChunksFor(1024 * 1024) == 32, "windowChunksFor(1 MiB) should be 32")
    check(Limits.windowChunksFor(256 * 1024) == 128, "windowChunksFor(256 KiB) should be 128")
    check(Limits.windowChunksFor(64 * 1024) == 128, "windowChunksFor(64 KiB) clamped to 128")
    check(Limits.ackIntervalFor(1024 * 1024) == 2, "ackIntervalFor(1 MiB) should be 2")
    check(Limits.ackIntervalFor(256 * 1024) == 8, "ackIntervalFor(256 KiB) should be 8")
    check(Limits.ackIntervalFor(64 * 1024) == 16, "ackIntervalFor(64 KiB) should be 16")

    val target = "bbbbbbbbbbbbbbbb"
    val source = "aaaaaaaaaaaaaaaa"
    val transferId = "0123456789abcdef"
    val routed = Frames.encodeRoutedBinarySack(target, source, transferId, fileIndex = 7, chunkIndex = 12345, bitmask = 0x5a)
    check(routed != null, "valid 16-hex transferId should encode binary SACK")
    check(routed!!.size == Frames.ROUTING_HEADER_LENGTH + Frames.BINARY_SACK_LENGTH, "binary SACK length == 49")
    check((routed[0].toInt() and 0xff) == Frames.FRAME_ROUTED_RELAY, "outer frame type 0x02")
    check((routed[Frames.ROUTING_HEADER_LENGTH].toInt() and 0xff) == Frames.FRAME_BINARY_SACK, "inner frame type 0x03")

    val (decodedSource, sack) = Frames.decodeRoutedBinarySackFrame(routed)
    check(decodedSource == source, "decoded binary SACK sourcePeerId mismatch")
    check(sack.transferId == transferId, "decoded binary SACK transferId mismatch")
    check(sack.fileIndex == 7, "decoded binary SACK fileIndex mismatch")
    check(sack.chunkIndex == 12345, "decoded binary SACK chunkIndex mismatch")
    check(sack.bitmask == 0x5a, "decoded binary SACK bitmask mismatch")

    check(Frames.encodeRoutedBinarySack(target, source, "non-hex-id-12345", 0, 0) == null, "non-hex transferId returns null")
    check(Frames.encodeRoutedBinarySack(target, source, transferId, 0x10000, 0) == null, "overflow fileIndex returns null")

    var malformedCaught = false
    try {
        Frames.decodeRoutedBinarySackFrame(ByteArray(10))
    } catch (_: IllegalArgumentException) {
        malformedCaught = true
    }
    check(malformedCaught, "short binary SACK must throw IllegalArgumentException")
}

private fun testWebSocketBatchedWriteAndLargeMask() {
    val server = ServerSocket(0)
    val receivedPayloads = Collections.synchronizedList(mutableListOf<ByteArray>())
    val done = CountDownLatch(2)
    val serverThread = thread(isDaemon = true) {
        server.accept().use { sock ->
            sock.tcpNoDelay = true
            acceptWsUpgrade(sock)
            val dis = DataInputStream(sock.getInputStream())
            while (true) {
                val frame = readClientFrame(dis) ?: break
                val (opcode, payload) = frame
                if (opcode == 0x2) {
                    receivedPayloads.add(payload)
                    done.countDown()
                } else if (opcode == 0x8) {
                    break
                }
            }
        }
    }

    val largePayload = ByteArray(1024 * 1024 + 97) { ((it * 31) xor (it ushr 5)).toByte() }
    val smallPayload = ByteArray(19) { (it + 1).toByte() }

    val client = WebSocketClient("ws://127.0.0.1:${server.localPort}/ws", object : WebSocketClient.Listener {
        override fun onText(text: String) {}
        override fun onBinary(bytes: ByteArray) {}
        override fun onClosed(reason: String) {}
    })
    client.connectBlocking()
    val readThread = thread(isDaemon = true) { client.readLoop() }
    client.sendBinary(largePayload, flush = false)
    client.sendBinary(smallPayload, flush = false)
    client.flush()
    check(done.await(5, TimeUnit.SECONDS), "batched un-flushed + flush() delivered both frames")
    check(receivedPayloads.size == 2, "exactly 2 frames received")
    check(receivedPayloads[0].contentEquals(largePayload), "1 MiB+97 unrolled XOR binary frame bit-exact")
    check(receivedPayloads[1].contentEquals(smallPayload), "tail batched frame bit-exact")

    client.close()
    server.close()
    readThread.join(1000)
    serverThread.join(1000)
}

private fun readPeerIdAscii(source: ByteArray, offset: Int): String {
    var end = offset + 16
    while (end > offset && source[end - 1].toInt() == 0) end--
    return String(source, offset, end - offset, Charsets.US_ASCII)
}

private fun writePeerIdAscii(target: ByteArray, offset: Int, id: String) {
    val bytes = id.toByteArray(Charsets.US_ASCII)
    val len = minOf(16, bytes.size)
    System.arraycopy(bytes, 0, target, offset, len)
    for (i in len until 16) target[offset + i] = 0
}

private class LoopbackRelay : AutoCloseable {
    private val server = ServerSocket(0)
    private val stopped = AtomicBoolean(false)
    private val clients = ConcurrentHashMap<String, ClientConn>()
    private val acceptThread: Thread
    val port: Int get() = server.localPort
    val binarySacksRelayed = AtomicInteger(0)

    private class ClientConn(
        val peerId: String,
        val device: JsonValue.Obj,
        val sock: Socket,
        val out: OutputStream,
    )

    init {
        acceptThread = thread(isDaemon = true, name = "test-relay-accept") {
            while (!stopped.get()) {
                val sock = try { server.accept() } catch (_: Exception) { break }
                sock.tcpNoDelay = true
                sock.receiveBufferSize = 4 * 1024 * 1024
                sock.sendBufferSize = 4 * 1024 * 1024
                thread(isDaemon = true) { handleClient(sock) }
            }
        }
    }

    private fun peerListFor(recipientId: String): JsonValue.JsonArr {
        val arr = JsonValue.JsonArr()
        for (c in clients.values) {
            if (c.peerId == recipientId) continue
            arr.add(
                JsonValue.Obj()
                    .put("peerId", c.peerId)
                    .put("device", c.device)
                    .put("discoveryScope", "nearby")
                    .put("connectedAt", 1L),
            )
        }
        return arr
    }

    private fun broadcastPeers() {
        for (c in clients.values) {
            val msg = JsonValue.Obj()
                .put("type", "peers")
                .put("peers", peerListFor(c.peerId))
                .toJsonString()
                .toByteArray(Charsets.UTF_8)
            runCatching { writeServerFrame(c.out, 0x1, msg) }
        }
    }

    private fun handleClient(sock: Socket) {
        var registeredId: String? = null
        try {
            acceptWsUpgrade(sock)
            val dis = DataInputStream(sock.getInputStream())
            val out = sock.getOutputStream()
            while (!stopped.get()) {
                val frame = readClientFrame(dis) ?: break
                val (opcode, payload) = frame
                when (opcode) {
                    0x1 -> {
                        val obj = JsonValue.parseObject(String(payload, Charsets.UTF_8))
                        when (obj.optStr("type")) {
                            "hello" -> {
                                val id = obj.optStr("peerId") ?: randomHex(8)
                                val dev = obj.optObj("device") ?: continue
                                registeredId = id
                                clients[id] = ClientConn(id, dev, sock, out)
                                val welcome = JsonValue.Obj()
                                    .put("type", "welcome")
                                    .put("peerId", id)
                                    .put("pairCode", "123456")
                                    .put("lanUrls", JsonValue.JsonArr())
                                    .put("peers", peerListFor(id))
                                    .toJsonString()
                                    .toByteArray(Charsets.UTF_8)
                                writeServerFrame(out, 0x1, welcome)
                                broadcastPeers()
                            }
                            "transfer-control" -> {
                                val from = registeredId ?: continue
                                val to = obj.optStr("to") ?: continue
                                val env = obj.optObj("envelope") ?: continue
                                val dst = clients[to] ?: continue
                                val fwd = JsonValue.Obj()
                                    .put("type", "transfer-control")
                                    .put("from", from)
                                    .put("envelope", env)
                                    .toJsonString()
                                    .toByteArray(Charsets.UTF_8)
                                writeServerFrame(dst.out, 0x1, fwd)
                            }
                        }
                    }
                    0x2 -> {
                        val from = registeredId ?: continue
                        if (payload.size <= Frames.ROUTING_HEADER_LENGTH) continue
                        if ((payload[0].toInt() and 0xff) != Frames.FRAME_ROUTED_RELAY) continue
                        if ((payload[Frames.ROUTING_HEADER_LENGTH].toInt() and 0xff) == Frames.FRAME_BINARY_SACK) {
                            binarySacksRelayed.incrementAndGet()
                        }
                        val targetId = readPeerIdAscii(payload, 1)
                        writePeerIdAscii(payload, 17, from)
                        val dst = clients[targetId] ?: continue
                        writeServerFrame(dst.out, 0x2, payload)
                    }
                    0x9 -> writeServerFrame(out, 0xA, payload)
                    0x8 -> break
                }
            }
        } catch (_: Exception) {
        } finally {
            registeredId?.let { clients.remove(it) }
            runCatching { sock.close() }
            if (!stopped.get()) broadcastPeers()
        }
    }

    override fun close() {
        stopped.set(true)
        runCatching { server.close() }
        for (c in clients.values) runCatching { c.sock.close() }
        clients.clear()
        acceptThread.join(1000)
    }
}

private fun testEndToEndMultiFileTransferAndBinarySack() {
    val tmpDir = Files.createTempDirectory("airbridge-m2-test").toFile()
    val recvDir = File(tmpDir, "recv").apply { mkdirs() }
    val sendDir = File(tmpDir, "send").apply { mkdirs() }
    try {
        // 18 MiB + 0 B + 2.3 MiB = ~20.3 MiB across 22 encrypted chunks (1 MiB chunking + tail)
        val file1 = File(sendDir, "large-video.bin")
        val f1Bytes = ByteArray(18 * 1024 * 1024)
        Random(42).nextBytes(f1Bytes)
        file1.writeBytes(f1Bytes)

        val file2 = File(sendDir, "empty.txt").apply { writeBytes(ByteArray(0)) }

        val file3 = File(sendDir, "odd-tail.bin")
        val f3Bytes = ByteArray(2 * 1024 * 1024 + 313_131)
        Random(99).nextBytes(f3Bytes)
        file3.writeBytes(f3Bytes)

        LoopbackRelay().use { relay ->
            val senderPeerId = "1111111111111111"
            val receiverPeerId = "2222222222222222"
            val senderReady = CountDownLatch(1)
            val receiverReady = CountDownLatch(1)
            val senderDone = CountDownLatch(1)
            val receiverDone = CountDownLatch(1)
            val senderView = AtomicReference<TransferView?>()
            val receiverView = AtomicReference<TransferView?>()
            val errorMsg = AtomicReference<String?>()

            lateinit var receiverEngine: AirBridgeEngine
            val senderEngine = AirBridgeEngine(
                EngineConfig(
                    serverUrl = "ws://127.0.0.1:${relay.port}/ws",
                    deviceName = "Sender Phone",
                    peerId = senderPeerId,
                ),
            )
            receiverEngine = AirBridgeEngine(
                EngineConfig(
                    serverUrl = "ws://127.0.0.1:${relay.port}/ws",
                    deviceName = "Receiver Phone",
                    peerId = receiverPeerId,
                    defaultSinkFactory = DirectoryFileSinkFactory(recvDir),
                ),
            )

            senderEngine.addListener(object : EngineListener {
                override fun onPeersChanged(peers: List<Peer>) {
                    if (peers.any { it.peerId == receiverPeerId }) senderReady.countDown()
                }
                override fun onTransferChanged(transfer: TransferView) {
                    if (transfer.status == TransferStatus.COMPLETED || transfer.status == TransferStatus.ERROR) {
                        senderView.set(transfer)
                        senderDone.countDown()
                    }
                }
                override fun onError(code: String, message: String) {
                    errorMsg.compareAndSet(null, "sender $code: $message")
                }
            })

            receiverEngine.addListener(object : EngineListener {
                override fun onPeersChanged(peers: List<Peer>) {
                    if (peers.any { it.peerId == senderPeerId }) receiverReady.countDown()
                }
                override fun onIncomingOffer(transfer: TransferView) {
                    receiverEngine.acceptIncomingTransfer(transfer.transferId)
                }
                override fun onTransferChanged(transfer: TransferView) {
                    if (transfer.status == TransferStatus.COMPLETED || transfer.status == TransferStatus.ERROR) {
                        receiverView.set(transfer)
                        receiverDone.countDown()
                    }
                }
                override fun onError(code: String, message: String) {
                    errorMsg.compareAndSet(null, "receiver $code: $message")
                }
            })

            senderEngine.start()
            receiverEngine.start()
            try {
                check(senderReady.await(5, TimeUnit.SECONDS), "sender saw receiver peer")
                check(receiverReady.await(5, TimeUnit.SECONDS), "receiver saw sender peer")

                val sources = listOf(
                    FileInputStreamSource(file1),
                    FileInputStreamSource(file2),
                    FileInputStreamSource(file3),
                )
                val t0 = System.nanoTime()
                val transferId = senderEngine.sendFiles(receiverPeerId, sources)
                check(transferId.length == 16, "transferId should be 16 hex chars for binary SACK")

                check(senderDone.await(30, TimeUnit.SECONDS), "sender finished within 30s (error=${errorMsg.get()})")
                check(receiverDone.await(30, TimeUnit.SECONDS), "receiver finished within 30s (error=${errorMsg.get()})")
                val elapsedSec = maxOf(0.001, (System.nanoTime() - t0) / 1_000_000_000.0)

                val sView = senderView.get()
                val rView = receiverView.get()
                check(sView != null && sView.status == TransferStatus.COMPLETED, "sender COMPLETED, got ${sView?.status} err=${sView?.errorMessage}")
                check(rView != null && rView.status == TransferStatus.COMPLETED, "receiver COMPLETED, got ${rView?.status} err=${rView?.errorMessage}")
                check(rView!!.receivedFiles.size == 3, "expected 3 received files")

                val expectedTotal = file1.length() + file2.length() + file3.length()
                val throughputMBps = (expectedTotal / (1024.0 * 1024.0)) / elapsedSec
                println("  Loopback M2 3-file encrypted transfer (${"%.2f".format(expectedTotal / (1024.0 * 1024.0))} MiB) completed in ${"%.3f".format(elapsedSec)}s = ${"%.1f".format(throughputMBps)} MiB/s (${relay.binarySacksRelayed.get()} binary SACKs)")
                check(relay.binarySacksRelayed.get() >= 2, "expected >= 2 0x03 binary SACK frames relayed, got ${relay.binarySacksRelayed.get()}")
                check(throughputMBps >= 5.0, "expected >= 5 MiB/s loopback throughput, got $throughputMBps")

                val recvFilesByIdx = rView.receivedFiles.associateBy { it.index }
                for ((idx, src) in listOf(0 to file1, 1 to file2, 2 to file3)) {
                    val info = recvFilesByIdx[idx]!!
                    check(info.verified, "file $idx verified == true")
                    val outFile = File(info.savedPath!!)
                    check(outFile.length() == src.length(), "file $idx length mismatch")
                    check(sha256Hex(outFile) == sha256Hex(src), "file $idx SHA-256 content mismatch")
                }
            } finally {
                senderEngine.stop()
                receiverEngine.stop()
            }
        }
    } finally {
        tmpDir.deleteRecursively()
    }
}

fun main() {
    testLimitsAndBinarySackCodec()
    testWebSocketBatchedWriteAndLargeMask()
    testEndToEndMultiFileTransferAndBinarySack()
    println("Milestone2Test: $m2Passed passed, 0 failed")
}
