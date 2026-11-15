package com.airbridge.engine

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** Minimal bounded RFC 6455 client; TLS uses platform trust or an explicit LAN CA pin. */
class WebSocketClient(
    url: String,
    private val listener: Listener,
    private val trustAllTls: Boolean = false,
    private val tlsTrustManager: X509TrustManager? = null,
    private val connectTimeoutMs: Int = 10_000,
    private val maxMessageBytes: Int = 16 * 1024 * 1024,
) {
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
    private val host: String = uri.host
        ?: throw IOException("URL missing host")
    private val port: Int = uri.port.takeIf { it > 0 } ?: if (secure) 443 else 80
    private val resource: String = buildString {
        append(uri.rawPath.ifNullOrEmpty("/ws"))
        if (uri.rawQuery != null) append('?').append(uri.rawQuery)
    }

    @Volatile
    var isOpen = false
        private set

    @Volatile private var socket: Socket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    private val writeLock = Any()
    private val closeLock = Any()
    @Volatile private var closed = false
    private val maskBuffer = ByteArray(1024 * 1024 + 128)
    private val headerBuffer = ByteArray(14)
    private val lengthScratch = ByteArray(8)
    private val maskKey = ByteArray(4)
    private val emptyPayload = ByteArray(0)
    private val random = SecureRandom()

    /** Blocking connect + HTTP upgrade. Throws on any handshake failure. */
    fun connectBlocking() {
        if (closed) throw IOException("Socket already closed")
        val raw: Socket = if (secure) {
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, when { tlsTrustManager != null -> arrayOf<TrustManager>(tlsTrustManager);
                trustAllTls -> arrayOf<TrustManager>(TrustAllManager); else -> null }, null)
            (ctx.socketFactory.createSocket() as SSLSocket).apply {
                useClientMode = true
                if (!trustAllTls) sslParameters = sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            }
        } else Socket()
        socket = raw
        if (closed) { raw.close(); throw IOException("Socket closed during connect") }
        try {
        raw.tcpNoDelay = true
        raw.keepAlive = true
        // Allow Linux/Android dynamic TCP window auto-tuning (tcp_moderate_rcvbuf)
        // to scale up to kernel limits (4MB-8MB) without setting SOCK_RCVBUF_LOCK.
        // Guarded: setting SO_RCVBUF manually on Linux/Android clamps window to rmem_max.
        val isLinuxOrAndroid = try {
            val os = System.getProperty("os.name")?.lowercase() ?: ""
            os.contains("linux") || os.contains("android")
        } catch (_: Exception) { true }
        if (!isLinuxOrAndroid) {
            raw.receiveBufferSize = 4 * 1024 * 1024
            raw.sendBufferSize = 2 * 1024 * 1024
        }
        raw.connect(InetSocketAddress(host, port), connectTimeoutMs)
        raw.soTimeout = connectTimeoutMs
        if (raw is SSLSocket) raw.startHandshake()
        // Stream buffers enlarged to 1 MiB (1024 * 1024) to saturate high-speed links:
        // (Baseline was: BufferedOutputStream(raw.getOutputStream(), 512 * 1024))
        // (Baseline was: BufferedInputStream(raw.getInputStream(), 512 * 1024))
        val streamBufferSize = 1024 * 1024
        val out = BufferedOutputStream(raw.getOutputStream(), streamBufferSize)
        val inp = BufferedInputStream(raw.getInputStream(), streamBufferSize)
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
        synchronized(writeLock) {
            out.write(handshake.toByteArray(Charsets.US_ASCII))
            out.flush()
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
        isOpen = true
        } catch (e: Exception) {
            closeInternal(1006, e.message ?: "Connect failed", notify = true)
            throw e
        }
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
                    0x9 -> sendFrame(0xA, payload, flush = true) // ping -> pong
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

    fun sendText(text: String, flush: Boolean = true) = sendFrame(0x1, text.toByteArray(Charsets.UTF_8), flush)

    fun sendBinary(bytes: ByteArray, flush: Boolean = true) = sendFrame(0x2, bytes, flush)

    fun sendPing() = sendFrame(0x9, emptyPayload, flush = true)

    fun flush() {
        val out = output ?: return
        if (!isOpen || closed) return
        synchronized(writeLock) {
            if (!isOpen || closed) return
            out.flush()
        }
    }

    private fun sendFrame(opcode: Int, payload: ByteArray, flush: Boolean) {
        val out = output ?: throw IOException("not connected")
        if (!isOpen || closed) throw IOException("socket closed")
        synchronized(writeLock) {
            if (!isOpen || closed) throw IOException("socket closed")
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
            out.write(headerBuffer, 0, h)
            val key0 = maskKey[0].toInt()
            val key1 = maskKey[1].toInt()
            val key2 = maskKey[2].toInt()
            val key3 = maskKey[3].toInt()
            var offset = 0
            while (offset < len) {
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
            if (flush) out.flush()
        }
    }

    fun close() = closeInternal(1000, "client close", notify = true)

    private fun closeInternal(@Suppress("UNUSED_PARAMETER") code: Int, reason: String, notify: Boolean) {
        synchronized(closeLock) {
            if (closed) return
            closed = true
            isOpen = false
        }
        // Never wait for writeLock here: the writer may be blocked on a dead
        // network. Closing the socket is what unblocks it.
        try { socket?.close() } catch (_: Exception) {}
        if (notify) listener.onClosed(reason)
    }

    private fun String?.ifNullOrEmpty(fallback: String): String =
        if (this.isNullOrEmpty()) fallback else this

    companion object {
        object TrustAllManager : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
    }
}
