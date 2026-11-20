package com.airbridge.engine

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.math.BigInteger
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.X509ExtendedTrustManager
import kotlin.concurrent.thread
import kotlin.system.exitProcess

private var tlsPassed = 0
private var tlsFailed = 0

private fun tCheck(label: String, ok: Boolean, detail: () -> String = { "" }) {
    if (ok) tlsPassed++ else {
        tlsFailed++
        System.err.println("FAIL $label ${detail()}")
    }
}

private fun derTag(tag: Int, content: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(tag)
    val len = content.size
    when {
        len < 0x80 -> out.write(len)
        len <= 0xff -> { out.write(0x81); out.write(len) }
        else -> { out.write(0x82); out.write((len ushr 8) and 0xff); out.write(len and 0xff) }
    }
    out.write(content)
    return out.toByteArray()
}

private fun derSeq(vararg items: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    for (item in items) out.write(item)
    return derTag(0x30, out.toByteArray())
}

private fun derSet(vararg items: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    for (item in items) out.write(item)
    return derTag(0x31, out.toByteArray())
}

private fun derOid(vararg arcs: Int): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(arcs[0] * 40 + arcs[1])
    for (i in 2 until arcs.size) {
        var v = arcs[i]
        val stack = IntArray(5)
        var n = 0
        do {
            stack[n++] = v and 0x7f
            v = v ushr 7
        } while (v > 0)
        for (j in n - 1 downTo 0) {
            out.write(if (j > 0) stack[j] or 0x80 else stack[j])
        }
    }
    return derTag(0x06, out.toByteArray())
}

private fun derUtcTime(date: Date): ByteArray {
    val fmt = SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    return derTag(0x17, fmt.format(date).toByteArray(Charsets.US_ASCII))
}

private data class GeneratedCert(val keyPair: KeyPair, val cert: X509Certificate)

private fun generateSelfSignedCert(ipSans: List<ByteArray>, dnsSans: List<String> = emptyList()): GeneratedCert {
    val kp = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec("secp256r1"))
    }.generateKeyPair()
    val sigAlg = derSeq(derOid(1, 2, 840, 10045, 4, 3, 2)) // ecdsa-with-SHA256
    val cn = derTag(0x0c, "AirBridge Test".toByteArray(Charsets.UTF_8))
    val name = derSeq(derSet(derSeq(derOid(2, 5, 4, 3), cn)))
    val now = System.currentTimeMillis()
    val validity = derSeq(derUtcTime(Date(now - 86_400_000L)), derUtcTime(Date(now + 30L * 86_400_000L)))

    val basicConstraints = derSeq(
        derOid(2, 5, 29, 19),
        byteArrayOf(0x01, 0x01, 0xff.toByte()), // critical = true
        derTag(0x04, derSeq(byteArrayOf(0x01, 0x01, 0xff.toByte()))), // CA = true
    )
    val sanEntries = ByteArrayOutputStream()
    for (dns in dnsSans) sanEntries.write(derTag(0x82, dns.toByteArray(Charsets.US_ASCII)))
    for (ip in ipSans) sanEntries.write(derTag(0x87, ip))
    val sanExt = derSeq(
        derOid(2, 5, 29, 17),
        derTag(0x04, derTag(0x30, sanEntries.toByteArray())),
    )
    val extensions = derTag(0xa3, derSeq(basicConstraints, sanExt))
    val serial = derTag(0x02, BigInteger.valueOf(System.nanoTime() and 0x7fff_ffff_ffffL).toByteArray())
    val tbs = derSeq(
        derTag(0xa0, derTag(0x02, byteArrayOf(2))), // v3
        serial,
        sigAlg,
        name,
        validity,
        name,
        kp.public.encoded,
        extensions,
    )
    val sig = Signature.getInstance("SHA256withECDSA").run {
        initSign(kp.private)
        update(tbs)
        sign()
    }
    val der = derSeq(tbs, sigAlg, derTag(0x03, byteArrayOf(0) + sig))
    val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    return GeneratedCert(kp, cert)
}

private fun startTlsWsServer(bindAddr: InetAddress, gen: GeneratedCert): Pair<SSLServerSocket, Thread> {
    val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null, null)
        setKeyEntry("k", gen.keyPair.private, charArrayOf(), arrayOf(gen.cert))
    }
    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
        init(ks, charArrayOf())
    }
    val ctx = SSLContext.getInstance("TLS").apply {
        init(kmf.keyManagers, null, null)
    }
    val srv = ctx.serverSocketFactory.createServerSocket(0, 16, bindAddr) as SSLServerSocket
    val t = thread(isDaemon = true, name = "tls-san-test-srv") {
        while (!srv.isClosed) {
            val s = runCatching { srv.accept() }.getOrNull() ?: break
            thread(isDaemon = true) {
                runCatching {
                    s.use { sock ->
                        sock.soTimeout = 3_000
                        val inp = sock.getInputStream()
                        val sb = StringBuilder()
                        var tail = 0
                        while (true) {
                            val b = inp.read()
                            if (b < 0) return@runCatching
                            sb.append(b.toChar())
                            tail = ((tail shl 8) or b) and 0xffffffff.toInt()
                            if (tail == 0x0d0a0d0a) break
                        }
                        val key = sb.toString().lines()
                            .firstOrNull { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
                            ?.substringAfter(':')?.trim() ?: return@runCatching
                        val accept = Base64.getEncoder().encodeToString(
                            MessageDigest.getInstance("SHA-1")
                                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII)),
                        )
                        sock.getOutputStream().write(
                            ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n")
                                .toByteArray(Charsets.US_ASCII),
                        )
                        sock.getOutputStream().flush()
                        val dis = DataInputStream(inp)
                        while (dis.read() >= 0) {
                            // keep open until client closes
                        }
                    }
                }
            }
        }
    }
    return srv to t
}

/** Test-only X509ExtendedTrustManager that verifies the anchor pin without JSSE HostnameChecker, isolating WebSocketClient.verifyIpSan. */
private class PinOnlyExtendedTrustManager(private val expectedPin: String) : X509ExtendedTrustManager() {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val last = chain?.lastOrNull() ?: throw java.security.cert.CertificateException("empty chain")
        if (PinnedTlsTrust.pinOf(last.encoded) != expectedPin) throw java.security.cert.CertificateException("pin mismatch")
    }
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = checkServerTrusted(chain, authType)
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = checkServerTrusted(chain, authType)
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

private val silentWsListener = object : WebSocketClient.Listener {
    override fun onText(text: String) {}
    override fun onBinary(bytes: ByteArray) {}
    override fun onClosed(reason: String) {}
}

fun runTlsSanAndTelemetryChecks() {
    tlsPassed = 0
    tlsFailed = 0
    // 1. AND-08: TrustAllManager and trustAllTls are completely absent from runtime classpath.
    val hasTrustAllClass = runCatching {
        Class.forName("com.airbridge.engine.WebSocketClient\$Companion\$TrustAllManager")
    }.isSuccess
    tCheck("AND-08: TrustAllManager absent from runtime classpath", !hasTrustAllClass)
    tCheck(
        "AND-08: EngineConfig has no trustAllTls field",
        EngineConfig::class.java.declaredFields.none { it.name == "trustAllTls" },
    )
    tCheck(
        "AND-08: WebSocketClient has no trustAllTls field",
        WebSocketClient::class.java.declaredFields.none { it.name == "trustAllTls" },
    )

    val v4Bytes = byteArrayOf(127, 0, 0, 1)
    val v6LoopbackBytes = ByteArray(16).also { it[15] = 1 }
    val v6Fe80Bytes = ByteArray(16).also { it[0] = 0xfe.toByte(); it[1] = 0x80.toByte(); it[15] = 1 }

    // 2. AND-08: Default system trust (tlsTrustManager = null) rejects self-signed cert.
    val certV4 = generateSelfSignedCert(listOf(v4Bytes), listOf("localhost"))
    startTlsWsServer(InetAddress.getByAddress(v4Bytes), certV4).let { (srv, srvThread) ->
        try {
            val client = WebSocketClient("wss://127.0.0.1:${srv.localPort}/ws", silentWsListener, connectTimeoutMs = 2_000)
            val err = runCatching { client.connectBlocking() }.exceptionOrNull() as? ConnectFailure
            tCheck("AND-08: wss with null tlsTrustManager rejects self-signed cert", err?.kind == FailureKind.TLS_UNTRUSTED) {
                "got $err"
            }
            tCheck("AND-08: tlsMode reports system", client.tlsMode == "system")
        } finally {
            runCatching { srv.close() }
            srvThread.join(1_000)
        }
    }

    // 3. AND-09: LocalNetworks.ipAddressBytes canonical parsing without DNS.
    tCheck("ipAddressBytes IPv4", LocalNetworks.ipAddressBytes("127.0.0.1").contentEquals(v4Bytes))
    tCheck("ipAddressBytes IPv4 10.42.61.23", LocalNetworks.ipAddressBytes("10.42.61.23").contentEquals(byteArrayOf(10, 42, 61, 23)))
    tCheck("ipAddressBytes ::1", LocalNetworks.ipAddressBytes("::1").contentEquals(v6LoopbackBytes))
    tCheck("ipAddressBytes [::1]", LocalNetworks.ipAddressBytes("[::1]").contentEquals(v6LoopbackBytes))
    tCheck("ipAddressBytes uncompressed ::1", LocalNetworks.ipAddressBytes("0:0:0:0:0:0:0:1").contentEquals(v6LoopbackBytes))
    tCheck("ipAddressBytes zero-padded ::1", LocalNetworks.ipAddressBytes("0000:0000:0000:0000:0000:0000:0000:0001").contentEquals(v6LoopbackBytes))
    tCheck("ipAddressBytes FE80::1 uppercase", LocalNetworks.ipAddressBytes("FE80::1").contentEquals(v6Fe80Bytes))
    tCheck("ipAddressBytes fe80::1%wlan0", LocalNetworks.ipAddressBytes("fe80::1%wlan0").contentEquals(v6Fe80Bytes))
    tCheck("ipAddressBytes [fe80::1%wlan0]", LocalNetworks.ipAddressBytes("[fe80::1%wlan0]").contentEquals(v6Fe80Bytes))
    tCheck("ipAddressBytes :: all-zeros", LocalNetworks.ipAddressBytes("::").contentEquals(ByteArray(16)))
    tCheck("ipAddressBytes ::ffff:127.0.0.1 normalizes to IPv4", LocalNetworks.ipAddressBytes("::ffff:127.0.0.1").contentEquals(v4Bytes))
    tCheck("ipAddressBytes ::ffff:7f00:1 normalizes to IPv4", LocalNetworks.ipAddressBytes("::ffff:7f00:1").contentEquals(v4Bytes))
    tCheck("ipAddressBytes rejects hostname", LocalNetworks.ipAddressBytes("airbridge.local") == null)
    tCheck("ipAddressBytes rejects localhost", LocalNetworks.ipAddressBytes("localhost") == null)
    tCheck("ipAddressBytes rejects short IPv6", LocalNetworks.ipAddressBytes("1:2:3") == null)
    tCheck("ipAddressBytes rejects double ::", LocalNetworks.ipAddressBytes("1::2::3") == null)
    tCheck("ipAddressBytes rejects trailing %", LocalNetworks.ipAddressBytes("fe80::1%") == null)
    tCheck("ipAddressBytes rejects unclosed [", LocalNetworks.ipAddressBytes("[::1") == null)

    // 4. AND-09: WebSocketClient.matchesIpSan against real X509Certificate IPv6 SANs.
    val certV6 = generateSelfSignedCert(listOf(v6LoopbackBytes, v6Fe80Bytes))
    tCheck("matchesIpSan ::1", WebSocketClient.matchesIpSan(certV6.cert, "::1"))
    tCheck("matchesIpSan [::1]", WebSocketClient.matchesIpSan(certV6.cert, "[::1]"))
    tCheck("matchesIpSan 0:0:0:0:0:0:0:1", WebSocketClient.matchesIpSan(certV6.cert, "0:0:0:0:0:0:0:1"))
    tCheck("matchesIpSan fe80::1%wlan0", WebSocketClient.matchesIpSan(certV6.cert, "fe80::1%wlan0"))
    tCheck("matchesIpSan rejects fe80::2", !WebSocketClient.matchesIpSan(certV6.cert, "fe80::2"))
    tCheck("matchesIpSan rejects ::1 on v4-only cert", !WebSocketClient.matchesIpSan(certV4.cert, "::1"))
    tCheck("matchesIpSan ::ffff:127.0.0.1 matches v4 cert", WebSocketClient.matchesIpSan(certV4.cert, "::ffff:127.0.0.1"))
    tCheck("matchesIpSan ignores DNS hostname", WebSocketClient.matchesIpSan(certV4.cert, "airbridge.local"))

    // 5. AND-09: Real SSLServerSocket TLS handshakes over IPv6 loopback [::1] (if OS has ::1).
    val ipv6Available = runCatching {
        ServerSocket(0, 1, InetAddress.getByAddress(v6LoopbackBytes)).use { true }
    }.getOrDefault(false)
    if (ipv6Available) {
        val pinV6 = PinnedTlsTrust.pinOf(certV6.cert.encoded)
        startTlsWsServer(InetAddress.getByAddress(v6LoopbackBytes), certV6).let { (srv, srvThread) ->
            try {
                // 5a: PinnedTlsTrust with matching IPv6 SAN ::1
                val trust = PinnedTlsTrust({ null }, {}, pinV6)
                val client = WebSocketClient(
                    "wss://[::1]:${srv.localPort}/ws",
                    silentWsListener,
                    tlsTrustManager = trust,
                    connectTimeoutMs = 3_000,
                    alternateHosts = listOf("[::1]"),
                )
                client.connectBlocking()
                tCheck("AND-09: IPv6 wss://[::1] connected", client.isOpen)
                tCheck("AND-09: verifiedIpSanHost == ::1", client.verifiedIpSanHost == "::1") { "got ${client.verifiedIpSanHost}" }
                tCheck("AND-09: tlsMode == pinned", client.tlsMode == "pinned")
                tCheck("AND-09: anchorPinPrefix is 12 chars", client.anchorPinPrefix == pinV6.take(12))
                client.close()
            } finally {
                runCatching { srv.close() }
                srvThread.join(1_000)
            }
        }

        // 5b: Missing ::1 IP SAN (cert only has 127.0.0.1 + DNS localhost) -> must fail TLS_HOSTNAME inside verifyIpSan!
        val pinV4 = PinnedTlsTrust.pinOf(certV4.cert.encoded)
        startTlsWsServer(InetAddress.getByAddress(v6LoopbackBytes), certV4).let { (srv, srvThread) ->
            try {
                val client = WebSocketClient(
                    "wss://[::1]:${srv.localPort}/ws",
                    silentWsListener,
                    tlsTrustManager = PinOnlyExtendedTrustManager(pinV4),
                    connectTimeoutMs = 3_000,
                )
                val err = runCatching { client.connectBlocking() }.exceptionOrNull() as? ConnectFailure
                tCheck("AND-09: missing IPv6 SAN rejected as TLS_HOSTNAME", err?.kind == FailureKind.TLS_HOSTNAME) {
                    "got $err"
                }
                tCheck("AND-09: verifiedIpSanHost null on failure", client.verifiedIpSanHost == null)
            } finally {
                runCatching { srv.close() }
                srvThread.join(1_000)
            }
        }
    }

    // 6. AND-14: AirBridgeEngine telemetry snapshot & secret redaction.
    val pinV4 = PinnedTlsTrust.pinOf(certV4.cert.encoded)
    val secretPairCode = "K9M4P7"
    val secretRelayToken = "f".repeat(64)
    startTlsWsServer(InetAddress.getByAddress(v4Bytes), certV4).let { (srv, srvThread) ->
        val reached = CountDownLatch(1)
        val engine = AirBridgeEngine(
            EngineConfig(
                serverUrl = "wss://127.0.0.1:${srv.localPort}/ws",
                deviceName = "Telemetry Test Phone",
                initialPairCode = secretPairCode,
                tlsTrustManager = PinnedTlsTrust({ null }, {}, pinV4),
                initialRelay = RelayRoute("relay.invalid", 443, secretRelayToken, pinV4),
                reverseListenPort = null,
            ),
        )
        engine.addListener(object : EngineListener {
            override fun onEndpointConnected(host: String) { reached.countDown() }
        })
        engine.start()
        try {
            tCheck("AND-14: engine reached wss endpoint", reached.await(5, TimeUnit.SECONDS))
            val snap = engine.diagnosticsSnapshot()
            tCheck("AND-14: snapshot tlsMode == pinned", snap.tlsMode == "pinned")
            tCheck("AND-14: snapshot tlsAnchored == true", snap.tlsAnchored)
            tCheck("AND-14: snapshot verifiedIpSanHost == 127.0.0.1", snap.verifiedIpSanHost == "127.0.0.1") {
                "got ${snap.verifiedIpSanHost}"
            }
            tCheck("AND-14: snapshot anchorPinPrefix == 12 chars", snap.anchorPinPrefix == pinV4.take(12))
            tCheck("AND-14: snapshot wsConnectAttempts >= 1", snap.wsConnectAttempts >= 1)
            tCheck("AND-14: convenience accessors match snapshot",
                engine.tlsMode == "pinned" &&
                    engine.verifiedIpSanHost == "127.0.0.1" &&
                    engine.anchorPinPrefix == pinV4.take(12) &&
                    engine.wsConnectAttempts >= 1L)
            val rendered = snap.toString()
            tCheck("AND-14: snapshot excludes pairCode", !rendered.contains(secretPairCode))
            tCheck("AND-14: snapshot excludes relay token", !rendered.contains(secretRelayToken))
            tCheck("AND-14: snapshot excludes private/public key", !rendered.contains(engine.myPublicKeyB64))
        } finally {
            engine.stop()
            runCatching { srv.close() }
            srvThread.join(1_000)
        }
    }

    // 7. AND-14: Failure telemetry survives ws = null in connectionLoop().
    val closedPort = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
    val failLatch = CountDownLatch(1)
    val failEngine = AirBridgeEngine(
        EngineConfig(
            serverUrl = "wss://127.0.0.1:$closedPort/ws",
            deviceName = "Failed Connect Telemetry",
            initialPairCode = secretPairCode,
            tlsTrustManager = PinnedTlsTrust({ null }, {}, pinV4),
            connectTimeoutMs = 400,
            reverseListenPort = null,
        ),
    )
    failEngine.addListener(object : EngineListener {
        override fun onConnectionFailure(diagnosis: ConnectionDiagnosis) { failLatch.countDown() }
    })
    failEngine.start()
    try {
        tCheck("AND-14: failure callback fired", failLatch.await(5, TimeUnit.SECONDS))
        val snap = failEngine.diagnosticsSnapshot()
        tCheck("AND-14: failed engine keeps wsConnectAttempts >= 1", snap.wsConnectAttempts >= 1)
        tCheck("AND-14: failed engine keeps lastAttempts", snap.lastAttempts.isNotEmpty())
        tCheck("AND-14: failed engine keeps anchorPinPrefix", snap.anchorPinPrefix == pinV4.take(12))
        tCheck("AND-14: failed snapshot excludes pairCode", !snap.toString().contains(secretPairCode))
    } finally {
        failEngine.stop()
    }
    if (tlsFailed > 0) error("TlsSanAndTelemetryTest failed ($tlsFailed checks)")
}

fun main() {
    runTlsSanAndTelemetryChecks()
    println("TlsSanAndTelemetryTest: $tlsPassed passed, $tlsFailed failed")
    if (tlsFailed > 0) exitProcess(1)
}
