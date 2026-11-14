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

    // Empty frames are bounded by count; an oversized, valid clipboard
    // envelope is admitted alone and cannot disable byte backpressure.
    val tiny = ByteBoundedQueue<ByteArray>(8, maxItems = 2, timeoutMs = 40) { it.size }
    tiny.put(ByteArray(0)); tiny.put(ByteArray(0))
    check(runCatching { tiny.put(ByteArray(0)) }.exceptionOrNull() is IOException) { "Empty frames bypassed the item cap" }
    tiny.clear()
    val oversized = ByteArray(16)
    tiny.put(oversized)
    check(runCatching { tiny.put(ByteArray(0)) }.exceptionOrNull() is IOException) { "Oversized frame shared its budget" }
    check(tiny.take() === oversized)
    tiny.put(byteArrayOf(1)); tiny.put(byteArrayOf(2))
    check(tiny.take()!!.single() == 1.toByte() && tiny.take()!!.single() == 2.toByte()) { "Queue reordered messages" }
    tiny.close()
    check(runCatching { tiny.put(ByteArray(0)) }.exceptionOrNull() is IOException)

    // Range decryption reuses the routed socket buffer and a failed GCM tag
    // must not poison the per-thread cipher for the next operation.
    val rawKey = ByteArray(32) { it.toByte() }
    val key = javax.crypto.spec.SecretKeySpec(rawKey, "AES")
    val plaintext = ByteArray(123) { (it * 3).toByte() }
    val (iv, ciphertext) = AirCrypto.encryptBinaryChunk(key, plaintext, 0, 0)
    val routed = Frames.wrapRoutedRelayFrame("1111111111111111", "2222222222222222",
        Frames.encodeEncryptedChunkFrame(Frames.EncryptedChunkFrame("abababababababab", 0, 0, iv, ciphertext)))
    val (_, decoded) = Frames.decodeRoutedEncryptedChunkFrame(routed)
    check(decoded.ciphertext === routed) { "Decoder copied the entire file chunk" }
    check(AirCrypto.decryptBinaryChunk(key, decoded.iv, decoded.ciphertext, decoded.ciphertextOffset, decoded.ciphertextLength).contentEquals(plaintext))
    val badTag = ciphertext.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
    check(runCatching { AirCrypto.decryptBinaryChunk(key, iv, badTag) }.isFailure)
    check(AirCrypto.decryptBinaryChunk(key, iv, ciphertext).contentEquals(plaintext))

    // A blocked system clipboard/snapshot consumer must retain only the latest
    // pending state, and yield to already queued commands between deliveries.
    val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
    val first = CountDownLatch(1)
    val release = CountDownLatch(1)
    val latest = CompletableFuture<Int>()
    val consumed = java.util.Collections.synchronizedList(mutableListOf<Int>())
    val command = CompletableFuture<Boolean>()
    val mailbox = LatestTask<Int>(executor) { value ->
        consumed.add(value)
        if (value == 1) { first.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
        else { check(command.isDone) { "Snapshot work starved commands" }; latest.complete(value) }
    }
    try {
        mailbox.offer(1)
        check(first.await(1, TimeUnit.SECONDS))
        for (value in 2..10_000) mailbox.offer(value)
        executor.execute { command.complete(true) }
        release.countDown()
        check(latest.get(2, TimeUnit.SECONDS) == 10_000)
        check(consumed.toList() == listOf(1, 10_000)) { "Mailbox retained superseded values" }
    } finally { release.countDown(); executor.shutdownNow() }
    mailbox.offer(10_001) // shutdown rejection must neither throw nor strand a worker

    // A later-file ACK must not conjure acknowledgements for earlier files or
    // count the resume prefix as newly transmitted work.
    val engine = AirBridgeEngine(EngineConfig("ws://127.0.0.1:9/ws", "ACK test"))
    try {
        val files = (0..1).map { FileManifestItem(it, "f$it", null, 100L * Limits.CHUNK_SIZE, "x", 100, Limits.CHUNK_SIZE) }
        val session = TransferSession("0123456789abcdef", "1111111111111111", null, "Peer", "macos", "123 · 456",
            TransferDirection.OUTGOING, TransferStatus.TRANSFERRING, files, files.sumOf { it.size }, 0)
        val send = SendState(session, emptyList())
        send.resumeFromChunks = mapOf(0 to 10, 1 to 20)
        send.sentPrefixes[0] = 20
        send.sentPrefixes[1] = 30
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
        acknowledge(session.peerId, 0, 50) // valid index, but never sent
        acknowledge(session.peerId, 1, 50)
        acknowledge("2222222222222222", 1, 29)
        check(send.ackedGlobalChunks == 20) { "Invalid or forged ACK released the window" }
    } finally { engine.stop() }
    // Relay IDs and claimed device IDs/names are not transfer authentication.
    // Exercise real ECDH/AES envelopes from two identities with the same profile.
    val identityEngine = AirBridgeEngine(EngineConfig("ws://127.0.0.1:9/ws", "Identity test"))
    try {
        val original = AirCrypto.generateIdentityKeyPair()
        val impostor = AirCrypto.generateIdentityKeyPair()
        val id = "3333333333333333"
        val meta = FileManifestItem(0, "empty.bin", "original/empty.bin", 0, "x", 1, Limits.CHUNK_SIZE)
        val transfer = TransferSession("cdcdcdcdcdcdcdcd", id, "same-device", "Same name", "macos", "123 · 456",
            TransferDirection.OUTGOING, TransferStatus.TRANSFERRING, listOf(meta), 0, 0)
        val send = SendState(transfer, emptyList(), original.publicKeyB64)
        fun map(field: String): MutableMap<String, Any> {
            val f = identityEngine.javaClass.getDeclaredField(field).apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST")
            return f.get(identityEngine) as MutableMap<String, Any>
        }
        map("outgoing")[transfer.transferId] = send
        map("transfers")[transfer.transferId] = transfer
        val control = identityEngine.javaClass.getDeclaredMethod("handleIncomingControl", String::class.java, JsonValue.Obj::class.java).apply { isAccessible = true }
        fun deliver(kind: String, identity: IdentityKeys, customize: (JsonValue.Obj) -> Unit = {}) {
            map("peers")[id] = Peer(id, DeviceProfile("Same name", "macos", "Mac", "laptop", identity.publicKeyB64, "same-device"), "paired", 0)
            val crypto = AirCrypto.derivePeerSession(identity.privateKey, identity.publicKeyB64, identityEngine.myPublicKeyB64)
            val payload = JsonValue.Obj().put("kind", kind).put("transferId", transfer.transferId).put("verified", true)
            customize(payload)
            val encrypted = AirCrypto.encryptControlPayload(crypto.aesKey, payload.toJsonString().toByteArray(Charsets.UTF_8))
            control.invoke(identityEngine, id, JsonValue.Obj().put("encrypted", true)
                .put("iv", Base64Url.encode(encrypted.iv)).put("ciphertext", Base64Url.encode(encrypted.ciphertext)))
        }
        deliver("transfer-complete-ack", impostor)
        deliver("transfer-cancel", impostor)
        check(!send.completion.isDone && !send.cancelled) { "Changed key inherited the original transfer" }
        deliver("transfer-complete-ack", original)
        check(send.completion.get(1, TimeUnit.SECONDS))

        map("outgoing").clear()
        val received = TransferSession(transfer.transferId, id, "same-device", "Same name", "macos", "123 · 456",
            TransferDirection.INCOMING, TransferStatus.COMPLETED, listOf(meta), 0, 0)
        map("transfers")[received.transferId] = received
        map("acceptedTransferKeys")[received.transferId] = original.publicKeyB64
        deliver("transfer-complete", impostor) // must not even attempt an outbound receipt
        deliver("transfer-offer", original) { payload ->
            payload.put("totalBytes", 0L).put("files", JsonValue.JsonArr(mutableListOf(meta.copy(relativePath = "changed/empty.bin").toJson())))
        }
        val legitimate = runCatching { deliver("transfer-complete", original) }.exceptionOrNull()
        check(legitimate?.cause?.message?.contains("Connection unavailable") == true) {
            "The legitimate receipt should reach the intentionally disconnected socket, not be rejected as an impostor"
        }
    } finally { identityEngine.stop() }

    // Slow flash/provider IO must not hold the engine-wide monitor: users
    // can inspect progress and cancel without waiting for a blocked write.
    val blockedEngine = AirBridgeEngine(EngineConfig("ws://127.0.0.1:9/ws", "Slow disk test"))
    val diskEntered = CountDownLatch(1)
    val diskRelease = CountDownLatch(1)
    val discarded = CompletableFuture<Boolean>()
    val diskWorker = java.util.concurrent.Executors.newSingleThreadExecutor()
    val observer = java.util.concurrent.Executors.newSingleThreadExecutor()
    try {
        val meta = FileManifestItem(0, "slow.bin", null, plaintext.size.toLong(), "x", 1, Limits.CHUNK_SIZE)
        val transfer = TransferSession("abababababababab", "2222222222222222", null, "Peer", "macos", "123 · 456",
            TransferDirection.INCOMING, TransferStatus.TRANSFERRING, listOf(meta), meta.size, 0)
        val sink = object : FileSink {
            override fun resumeFrom() = 0
            override fun hasReceived(chunkIndex: Int) = false
            override fun receivedCount() = 0
            override fun store(chunkIndex: Int, data: ByteArray) { diskEntered.countDown(); check(diskRelease.await(3, TimeUnit.SECONDS)) }
            override fun markComplete() {}
            override fun finalizeIfReady(declaredSha256: String?, force: Boolean): FileFinalize? = null
            override fun discard() { discarded.complete(true) }
            override fun lastError(): String? = null
        }
        fun install(field: String, id: String, value: Any) {
            val f = blockedEngine.javaClass.getDeclaredField(field).apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST")
            (f.get(blockedEngine) as MutableMap<String, Any>)[id] = value
        }
        install("incoming", transfer.transferId, RecvState(transfer, mapOf(0 to sink)))
        install("transfers", transfer.transferId, transfer)
        install("sessions", transfer.peerId, PeerCryptoSession(key, rawKey, "123 · 456", "test"))
        install("peers", transfer.peerId, Peer(transfer.peerId, DeviceProfile("Peer", "macos", "Mac", "laptop", "test-key"), "paired", 0))
        install("sessionKeyFingerprints", transfer.peerId, "test-key")
        install("acceptedTransferKeys", transfer.transferId, "test-key")
        val receive = blockedEngine.javaClass.getDeclaredMethod("handleBinaryFrame", ByteArray::class.java).apply { isAccessible = true }
        val stored = diskWorker.submit { receive.invoke(blockedEngine, routed) }
        check(diskEntered.await(1, TimeUnit.SECONDS))
        check(observer.submit<TransferView?> { blockedEngine.transferView(transfer.transferId) }.get(1, TimeUnit.SECONDS)?.status == TransferStatus.TRANSFERRING)
        observer.submit { runCatching { blockedEngine.cancelTransfer(transfer.transferId) } }.get(1, TimeUnit.SECONDS)
        check(blockedEngine.transferView(transfer.transferId)?.status == TransferStatus.CANCELLED)
        check(discarded.get(1, TimeUnit.SECONDS))
        diskRelease.countDown()
        stored.get(1, TimeUnit.SECONDS)
    } finally { diskRelease.countDown(); blockedEngine.stop(); diskWorker.shutdownNow(); observer.shutdownNow() }
    println("TRANSPORT: ALL PASS (bounded frames, fragments, exactly-once close, byte/item queues, range crypto, nonblocking cancel, bounded latest-state work, per-file ACKs, consent/receipt identity)")
}
