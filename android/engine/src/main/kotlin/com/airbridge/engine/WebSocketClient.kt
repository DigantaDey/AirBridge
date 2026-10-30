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

/**
 * Minimal RFC 6455 WebSocket client — text + binary frames, continuation
 * reassembly, ping/pong, client masking, optional plain-TLS with trust-all
 * (the AirBridge threat model authenticates peers via ECDH + the six-digit
 * SAS code; TLS over the LAN protects metadata only, so accepting the
 * server's self-signed certificate is equivalent to the web client's
 * "install our CA" step minus the manual install).
 */
class WebSocketClient(
    url: String,
    private val listener: Listener,
    private val trustAllTls: Boolean = true,
    private val connectTimeoutMs: Int = 10_000,
    private val maxMessageBytes: Int = 34 * 1024 * 1024,
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

    private var socket: Socket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    private val writeLock = Any()
    private val closeLock = Any()
    private var closed = false
    private val random = SecureRandom()

    /** Blocking connect + HTTP upgrade. Throws on any handshake failure. */
    fun connectBlocking() {
        val raw: Socket = if (secure) {
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, if (trustAllTls) arrayOf<TrustManager>(TrustAllManager) else null, null)
            val s = ctx.socketFactory.createSocket() as SSLSocket
            s.useClientMode = true
            s.connect(InetSocketAddress(host, port), connectTimeoutMs)
            s.soTimeout = connectTimeoutMs
            s.startHandshake()
            s.soTimeout = 0
            s
        } else {
            val s = Socket()
            s.connect(InetSocketAddress(host, port), connectTimeoutMs)
            s.soTimeout = connectTimeoutMs
            s
        }
        socket = raw
        raw.tcpNoDelay = true
        val out = BufferedOutputStream(raw.getOutputStream())
        val inp = BufferedInputStream(raw.getInputStream())
        output = out
        input = inp

        val keyBytes = ByteArray(16).also { random.nextBytes(it) }
        val key = Base64Url.encodeStandard(keyBytes)
        val handshake = buildString {
            append("GET ").append(resource).append(" HTTP/1.1\r\n")
            append("Host: ").append(host).append(':').append(port).append("\r\n")
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
        while (true) {
            val line = readLine(inp)
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
        raw.soTimeout = 0
        isOpen = true
    }

    private fun readLine(inp: InputStream): String {
        val sb = StringBuilder()
        while (true) {
            val b = inp.read()
            if (b == -1) throw EOFException("Connection closed during handshake")
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
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
                val b1 = inp.read()
                if (b1 == -1) throw EOFException("remote closed")
                val masked = (b1 and 0x80) != 0
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) {
                    val ext16 = readExact(inp, 2)
                    len = (((ext16[0].toInt() and 0xff) shl 8) or
                        (ext16[1].toInt() and 0xff)).toLong()
                } else if (len == 127L) {
                    val ext = readExact(inp, 8)
                    len = 0
                    for (b in ext) len = (len shl 8) or (b.toLong() and 0xff)
                }
                if (len > maxMessageBytes) throw IOException("frame too large: $len")
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
                    0x9 -> sendFrame(0xA, payload) // ping -> pong
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

    private fun readExact(inp: InputStream, count: Int): ByteArray {
        val buf = ByteArray(count)
        var off = 0
        while (off < count) {
            val n = inp.read(buf, off, count - off)
            if (n == -1) throw EOFException("connection closed mid-frame")
            off += n
        }
        return buf
    }

    fun sendText(text: String) = sendFrame(0x1, text.toByteArray(Charsets.UTF_8))

    fun sendBinary(bytes: ByteArray) = sendFrame(0x2, bytes)

    private fun sendFrame(opcode: Int, payload: ByteArray) {
        val out = output ?: throw IOException("not connected")
        if (!isOpen || closed) throw IOException("socket closed")
        synchronized(writeLock) {
            val maskKey = ByteArray(4).also { random.nextBytes(it) }
            val header = ByteArrayOutputStream(payload.size + 14)
            header.write(0x80 or opcode) // FIN + opcode
            val len = payload.size
            when {
                len < 126 -> header.write(0x80 or len)
                len <= 0xffff -> {
                    header.write(0x80 or 126)
                    header.write((len ushr 8) and 0xff)
                    header.write(len and 0xff)
                }
                else -> {
                    header.write(0x80 or 127)
                    var v = len.toLong()
                    for (shift in 56 downTo 0 step 8) header.write(((v ushr shift) and 0xff).toInt())
                }
            }
            header.write(maskKey)
            val masked = ByteArray(len)
            for (i in 0 until len) masked[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            out.write(header.toByteArray())
            out.write(masked)
            out.flush()
        }
    }

    fun close() = closeInternal(1000, "client close", notify = true)

    private fun closeInternal(code: Int, reason: String, notify: Boolean) {
        val wasOpen: Boolean
        synchronized(closeLock) {
            wasOpen = !closed
            closed = true
        }
        isOpen = false
        try {
            if (wasOpen && output != null) {
                val reasonBytes = reason.toByteArray(Charsets.UTF_8).let { if (it.size > 120) it.copyOf(120) else it }
                val payload = ByteArray(2 + reasonBytes.size)
                payload[0] = ((code ushr 8) and 0xff).toByte()
                payload[1] = (code and 0xff).toByte()
                reasonBytes.copyInto(payload, 2)
                try {
                    sendFrame(0x8, payload)
                } catch (_: Exception) {
                }
            }
        } finally {
            try {
                socket?.close()
            } catch (_: Exception) {
            }
            if (notify) listener.onClosed(reason)
        }
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
