package com.airbridge.engine

import java.io.BufferedInputStream
import java.io.IOException
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** Protocol, backpressure and ACK regression checks; real JVM sockets, no Android UI. */
fun main() {
    fun frame(fin: Boolean, opcode: Int, bytes: ByteArray): ByteArray {
        val header = if (bytes.size < 126) byteArrayOf(((if (fin) 128 else 0) or opcode).toByte(), bytes.size.toByte())
            else byteArrayOf(((if (fin) 128 else 0) or opcode).toByte(), 126, (bytes.size ushr 8).toByte(), bytes.size.toByte())
        return header + bytes
    }
    fun socketCase(wire: ByteArray, maxBytes: Int = 1024, expectedMessages: Int = 0) {
        val server = ServerSocket(0)
        val done = CountDownLatch(1)
        val serverError = CompletableFuture<Throwable?>()
        val serverThread = thread(isDaemon = true) {
            try {
                server.accept().use { socket ->
                    socket.soTimeout = 3000
                    val input = BufferedInputStream(socket.getInputStream())
                    val headers = StringBuilder()
                    while (!headers.endsWith("\r\n\r\n")) {
                        val b = input.read(); if (b < 0) throw IOException("No upgrade")
                        headers.append(b.toChar())
                    }
                    val key = headers.lines().first { it.startsWith("Sec-WebSocket-Key:") }.substringAfter(':').trim()
                    val accept = Base64Url.encodeStandard(MessageDigest.getInstance("SHA-1")
                        .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                        write(wire); flush()
                    }
                    done.await(3, TimeUnit.SECONDS)
                }
                serverError.complete(null)
            } catch (t: Throwable) { serverError.complete(t) }
        }
        val messages = AtomicInteger()
        val closes = AtomicInteger()
        val client = WebSocketClient("ws://127.0.0.1:${server.localPort}/ws", object : WebSocketClient.Listener {
            override fun onText(text: String) { messages.incrementAndGet() }
            override fun onBinary(bytes: ByteArray) { messages.incrementAndGet() }
            override fun onClosed(reason: String) { closes.incrementAndGet(); done.countDown() }
        }, maxMessageBytes = maxBytes)
        try {
            client.connectBlocking()
            client.readLoop()
            client.close(); client.close()
            check(messages.get() == expectedMessages) { "Unexpected message delivery: ${messages.get()}" }
            check(closes.get() == 1) { "onClosed fired ${closes.get()} times" }
            serverError.get(4, TimeUnit.SECONDS)?.let { throw it }
        } finally { done.countDown(); client.close(); server.close(); serverThread.join(1000) }
    }

    // Signed/overflowed 64-bit frame length used to reach negative allocations.
    socketCase(byteArrayOf(0x82.toByte(), 127, 0x80.toByte(), 0, 0, 0, 0, 0, 0, 0))
    socketCase(frame(false, 2, ByteArray(700)) + frame(true, 0, ByteArray(700)))
    socketCase(frame(false, 2, byteArrayOf(1)) + frame(true, 2, byteArrayOf(2))) // interleaving
    socketCase(frame(false, 9, byteArrayOf(1))) // fragmented control frame
    socketCase(frame(false, 2, byteArrayOf(1)) + frame(true, 9, byteArrayOf(9)) +
        frame(true, 0, byteArrayOf(2)) + frame(true, 8, byteArrayOf()), expectedMessages = 1)

    val queue = OutboundQueue(8)
    queue.put(Outbound(false, ByteArray(8)))
    val entered = CountDownLatch(1)
    val written = CompletableFuture<Boolean>()
    val writer = thread(isDaemon = true) {
        entered.countDown()
        try { queue.put(Outbound(false, ByteArray(8))); written.complete(true) }
        catch (_: IOException) { written.complete(false) }
    }
    entered.await(1, TimeUnit.SECONDS)
    check(!written.isDone) { "Queue ignored its byte budget" }
    check(queue.take()!!.payload.size == 8)
    check(written.get(1, TimeUnit.SECONDS))
    val blocked = CompletableFuture<Boolean>()
    val secondWriter = thread(isDaemon = true) {
        try { queue.put(Outbound(false, ByteArray(8))); blocked.complete(false) }
        catch (_: IOException) { blocked.complete(true) }
    }
    queue.close()
    check(blocked.get(1, TimeUnit.SECONDS)) { "Queue shutdown stranded its producer" }
    check(queue.take() == null)
    writer.join(); secondWriter.join()

    // A later-file ACK must not conjure acknowledgements for earlier files or
    // count the resume prefix as newly transmitted work.
    val engine = AirBridgeEngine(EngineConfig("ws://127.0.0.1:9/ws", "ACK test"))
    try {
        val files = (0..1).map { FileManifestItem(it, "f$it", null, 100L * Limits.CHUNK_SIZE, "x", 100, Limits.CHUNK_SIZE) }
        val session = TransferSession("0123456789abcdef", "1111111111111111", null, "Peer", "macos", "123 · 456",
            TransferDirection.OUTGOING, TransferStatus.TRANSFERRING, files, files.sumOf { it.size }, 0)
        val send = SendState(session, emptyList())
        send.resumeFromChunks = mapOf(0 to 10, 1 to 20)
        val outgoing = engine.javaClass.getDeclaredField("outgoing").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        (outgoing.get(engine) as MutableMap<String, SendState>)[session.transferId] = send
        val ack = engine.javaClass.getDeclaredMethod("handleChunkAck", String::class.java, JsonValue.Obj::class.java).apply { isAccessible = true }
        fun acknowledge(peer: String, index: Int, chunk: Int) = ack.invoke(engine, peer, JsonValue.Obj()
            .put("transferId", session.transferId).put("fileIndex", index).put("ackedChunkIndex", chunk).put("bytesReceivedTotal", Long.MAX_VALUE))
        acknowledge(session.peerId, 1, 29)
        check(send.ackedGlobalChunks == 10)
        check(session.transferredBytes <= session.totalBytes)
        acknowledge(session.peerId, 0, 19)
        check(send.ackedGlobalChunks == 20)
        acknowledge(session.peerId, 1, 999)
        acknowledge("2222222222222222", 1, 99)
        check(send.ackedGlobalChunks == 20) { "Invalid or forged ACK released the window" }
    } finally { engine.stop() }
    println("TRANSPORT: ALL PASS (bounded frames, fragments, exactly-once close, byte queue, per-file ACKs)")
}
