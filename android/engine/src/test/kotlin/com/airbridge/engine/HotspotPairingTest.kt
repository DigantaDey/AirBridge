package com.airbridge.engine

import java.io.EOFException
import java.io.IOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.util.Base64
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import kotlin.system.exitProcess

/**
 * Deterministic hotspot-pairing checks (no network beyond loopback):
 * phone-side endpoint ranking, QR alternates/pin parsing, invitation staging,
 * failure classification + guidance, and the real WebSocketClient TCP race
 * against fake servers with a simulated "blackholed" address.
 *
 * Topology used throughout (the reported failure):
 *   phone hotspot ap0 10.42.61.1/24, cellular CLAT v4-rmnet_data0 192.0.0.2
 *   Mac en0 10.205.95.167 (campus — NOT reachable from the phone)
 *   Mac en7 10.42.61.23   (joined the phone's hotspot)
 */
private var passed = 0
private var failed = 0

private fun check(label: String, condition: Boolean, detail: () -> String = { "" }) {
    if (condition) passed++ else { failed++; println("FAIL: $label ${detail()}") }
}

private fun <T> eq(label: String, actual: T, expected: T) = check(label, actual == expected) { "expected <$expected> got <$actual>" }

private const val CAMPUS = "10.205.95.167"
private const val HOTSPOT = "10.42.61.23"
private val PIN = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() })

private val hotspotPhone = listOf(
    LocalAddress("lo", "127.0.0.1", 8),
    LocalAddress("v4-rmnet_data0", "192.0.0.2", 32),
    LocalAddress("ap0", "10.42.61.1", 24),
)

fun main() {
    networkRanking()
    pairingLinkAlternates()
    invitationStaging()
    classificationAndGuidance()
    tcpRace()
    welcomeTimeout()
    reversePath()
    println("HotspotPairing: $passed passed, $failed failed")
    if (failed > 0) exitProcess(1)
}

private fun networkRanking() {
    // CLAT / cellular / loopback / VPN are never "LAN".
    check("CLAT is not LAN", !LocalAddress("v4-rmnet_data0", "192.0.0.2", 29).isLan)
    check("rmnet is not LAN", !LocalAddress("rmnet_data1", "10.120.4.9", 30).isLan)
    check("tun VPN is not LAN", !LocalAddress("tun0", "10.8.0.2", 24).isLan)
    check("hotspot ap0 is LAN", LocalAddress("ap0", "10.42.61.1", 24).isLan)
    check("Samsung swlan0 is LAN", LocalAddress("swlan0", "192.168.43.1", 24).isLan)
    check("Wi-Fi wlan0 is LAN", LocalAddress("wlan0", "192.168.1.20", 24).isLan)
    check("USB tether rndis0 is LAN", LocalAddress("rndis0", "192.168.42.129", 24).isLan)

    // The reported failure: QR primary was the campus address.
    eq("hotspot address ranked first although listed second",
        EndpointSelector.order(listOf(CAMPUS, HOTSPOT), hotspotPhone), listOf(HOTSPOT, CAMPUS))
    eq("ranking independent of phone interface order",
        EndpointSelector.order(listOf(CAMPUS, HOTSPOT), hotspotPhone.reversed()), listOf(HOTSPOT, CAMPUS))
    eq("ranking independent of desktop order",
        EndpointSelector.order(listOf(HOTSPOT, CAMPUS), hotspotPhone), listOf(HOTSPOT, CAMPUS))
    eq("via interface recorded", EndpointSelector.rank(listOf(CAMPUS, HOTSPOT), hotspotPhone).first().via?.interfaceName, "ap0")

    // Phone as a Wi-Fi client on the campus network: campus address wins.
    val campusPhone = listOf(LocalAddress("wlan0", "10.205.92.50", 22), LocalAddress("v4-rmnet_data0", "192.0.0.2", 32))
    eq("campus Wi-Fi phone prefers campus address",
        EndpointSelector.order(listOf(HOTSPOT, CAMPUS), campusPhone), listOf(CAMPUS, HOTSPOT))

    // VPN covering 10/8 must not make an off-link address look on-link.
    val vpnPhone = hotspotPhone + LocalAddress("tun0", "10.8.0.2", 8)
    eq("tun 10/8 does not capture campus address", EndpointSelector.order(listOf(CAMPUS, HOTSPOT), vpnPhone), listOf(HOTSPOT, CAMPUS))

    // Most specific matching network wins.
    val nested = listOf(LocalAddress("wlan0", "10.0.0.5", 8), LocalAddress("ap0", "10.42.61.1", 24))
    eq("most specific prefix", EndpointSelector.rank(listOf(HOTSPOT), nested).first().via?.interfaceName, "ap0")

    // No usable LAN: explain instead of blaming the code.
    val cellularOnly = listOf(LocalAddress("v4-rmnet_data0", "192.0.0.2", 32))
    val hint = EndpointSelector.offLinkHint(listOf(CAMPUS), cellularOnly) ?: ""
    check("off-link hint names address and mobile data", CAMPUS in hint && "mobile data only" in hint) { hint }
    check("no hint when on-link", EndpointSelector.offLinkHint(listOf(CAMPUS, HOTSPOT), hotspotPhone) == null)

    // Regression: hotspot re-enabled with a new subnet; old QR addresses are stale.
    val newSubnet = listOf(LocalAddress("ap0", "10.42.99.1", 24), LocalAddress("v4-rmnet_data0", "192.0.0.2", 32))
    val stale = EndpointSelector.offLinkHint(listOf(HOTSPOT), newSubnet) ?: ""
    check("subnet change explained", "ap0 10.42.99.0/24" in stale && HOTSPOT in stale) { stale }
    eq("new hotspot address (learned) ranks first after subnet change",
        EndpointSelector.order(listOf(HOTSPOT, "10.42.99.17"), newSubnet), listOf("10.42.99.17", HOTSPOT))

    eq("ipv4 parse", LocalNetworks.ipv4ToInt("10.42.61.23"), (10 shl 24) or (42 shl 16) or (61 shl 8) or 23)
    eq("ipv4 reject", LocalNetworks.ipv4ToInt("10.42.61.256"), null)
    check("CLAT range not a LAN address", !LocalNetworks.isLanAddress("192.0.0.4"))
}

private fun pairingLinkAlternates() {
    val link = PairingLink.parse("https://$CAMPUS:3000/?pair=ABC234&alt=$HOTSPOT,bad_host!,$CAMPUS&ca=$PIN")!!
    eq("primary host", link.host, CAMPUS)
    eq("alternates filtered + deduped", link.alternateHosts, listOf(HOTSPOT))
    eq("candidates", link.candidateHosts, listOf(CAMPUS, HOTSPOT))
    eq("pin parsed", link.tlsPin, PIN)
    eq("pair code", link.pairCode, "ABC234")
    eq("http drops pin", PairingLink.parse("http://$CAMPUS:3000/?pair=ABC234&ca=$PIN")?.tlsPin, null)
    eq("short pin rejected", PairingLink.parse("https://$CAMPUS:3000/?pair=ABC234&ca=abc")?.tlsPin, null)
    eq("legacy QR still parses", PairingLink.parse("https://$CAMPUS:3000/?pair=ABC234")?.alternateHosts, emptyList<String>())
}

private fun invitationStaging() {
    val kv = InMemoryKeyValueStore()
    val store = PairingInvitationStore(kv)
    // Yesterday: paired via the campus address with code HJK234, learned addresses.
    store.stage(PairingLink.parse("https://$CAMPUS:3000/?pair=HJK234")!!)
    val first = store.bootstrap()!!
    eq("first bootstrap uses its scan", first.pairCode, "HJK234")
    store.learn(listOf("https://$CAMPUS:3000", "https://172.20.0.4:3000", "http://9.9.9.9:3000", "https://8.8.8.8:4000"))
    eq("learn keeps same scheme+port only", store.learnedHosts, listOf(CAMPUS, "172.20.0.4"))
    store.markConnected(CAMPUS)
    eq("persisted code", store.pairCode, "HJK234")

    // Today: rescan the SAME computer (same primary) with a fresh code + alternates + pin.
    val keyBefore = store.engineKey
    store.stage(PairingLink.parse("https://$CAMPUS:3000/?pair=NEW567&alt=$HOTSPOT&ca=$PIN")!!)
    check("rescan of same target changes engineKey (service restarts engine)", store.engineKey != keyBefore)
    eq("target unchanged", store.target, "https://$CAMPUS:3000")
    eq("staged code", store.pendingPairCode, "NEW567")
    eq("stale learned endpoints cleared by new scan", store.learnedHosts, emptyList<String>())
    eq("candidates from the new QR only", store.candidateHosts(), listOf(CAMPUS, HOTSPOT))
    val plan = store.bootstrap()!!
    eq("fresh scanned code beats stale saved code", plan.pairCode, "NEW567")
    check("fresh scan flagged", plan.freshScan)
    eq("plan link carries pin", plan.link.tlsPin, PIN)
    eq("plan link has no code (not replayable)", plan.link.pairCode, null)
    eq("staged code consumed", store.pendingPairCode, "")
    val restart = store.bootstrap()!!
    eq("restart reuses saved code", restart.pairCode, "NEW567")
    check("restart is not a fresh scan", !restart.freshScan)

    // Connected over the hotspot; computer reports its addresses.
    store.markConnected(HOTSPOT)
    eq("last working address first", store.candidateHosts(), listOf(HOTSPOT, CAMPUS))
    store.learn(listOf("https://$HOTSPOT:3000", "https://10.42.61.40:3000"))
    eq("learned address appended", store.candidateHosts(), listOf(HOTSPOT, CAMPUS, "10.42.61.40"))

    // Manual address: obsolete staged invitation must be cleared, not replayed.
    store.stage(PairingLink.parse("https://$CAMPUS:3000/?pair=ZZZ999")!!)
    store.stage(PairingLink.parse("$HOTSPOT:3000")!!)
    eq("manual address clears staged QR code", store.pendingPairCode, "")
    eq("manual address clears QR pin", store.link()?.tlsPin, null)
    eq("manual address clears QR alternates", store.link()?.alternateHosts, emptyList<String>())
    eq("manual address falls back to saved code", store.bootstrap()?.pairCode, "NEW567")
    eq("TLS anchor key keeps on-disk format", PairingInvitationStore.tlsAnchorKey(store.link()!!), "tlsAnchor:$HOTSPOT:3000")

    store.forget()
    eq("forget clears target", store.target, "")
    eq("forget clears code", store.pairCode, "")
    check("forget leaves no bootstrap", store.bootstrap() == null)
}

private fun classificationAndGuidance() {
    val tcp = ConnectPhase.TCP
    eq("timeout", ConnectionHelp.classify(SocketTimeoutException("Connect timed out"), tcp), FailureKind.TCP_TIMEOUT)
    eq("android ETIMEDOUT", ConnectionHelp.classify(ConnectException("failed to connect to /$CAMPUS (port 3000) from /192.0.0.2 after 10000ms: isConnected failed: ETIMEDOUT (Connection timed out)"), tcp), FailureKind.TCP_TIMEOUT)
    eq("refused", ConnectionHelp.classify(ConnectException("Connection refused"), tcp), FailureKind.TCP_REFUSED)
    eq("no route", ConnectionHelp.classify(NoRouteToHostException("No route to host"), tcp), FailureKind.NO_ROUTE)
    eq("ENETUNREACH", ConnectionHelp.classify(ConnectException("Network is unreachable"), tcp), FailureKind.NO_ROUTE)
    eq("dns", ConnectionHelp.classify(UnknownHostException("mac.local"), tcp), FailureKind.DNS)
    eq("locally closed", ConnectionHelp.classify(IOException("Socket closed"), tcp, closedLocally = true), FailureKind.CANCELLED)
    // A close we did not initiate must stay visible (it was silently dropped as CANCELLED).
    check("foreign close is visible", ConnectionHelp.classify(IOException("Socket closed"), tcp) != FailureKind.CANCELLED)

    val tls = ConnectPhase.TLS
    eq("stale SAN", ConnectionHelp.classify(SSLHandshakeException("No subject alternative names matching IP address $HOTSPOT found"), tls), FailureKind.TLS_HOSTNAME)
    eq("pin mismatch", ConnectionHelp.classify(SSLHandshakeException("handshake").apply { initCause(CertificateException("The computer's TLS certificate does not match the QR code you scanned")) }, tls), FailureKind.TLS_PIN_MISMATCH)
    eq("TOFU identity changed", ConnectionHelp.classify(SSLHandshakeException("x").apply { initCause(CertificateException("AirBridge TLS identity changed or expired.")) }, tls), FailureKind.TLS_PIN_MISMATCH)
    eq("untrusted", ConnectionHelp.classify(SSLHandshakeException("PKIX path building failed").apply { initCause(CertificateException("Invalid AirBridge TLS certificate")) }, tls), FailureKind.TLS_UNTRUSTED)
    eq("plaintext server", ConnectionHelp.classify(SSLException("Unsupported or unrecognized SSL message"), tls), FailureKind.TLS_HANDSHAKE)
    eq("upgrade rejected", ConnectionHelp.classify(IOException("WebSocket upgrade rejected: HTTP/1.1 403 Forbidden"), ConnectPhase.UPGRADE), FailureKind.WS_REJECTED)
    eq("open close", ConnectionHelp.classify(EOFException("remote closed"), ConnectPhase.OPEN), FailureKind.WS_CLOSED)

    val attempts = listOf(
        EndpointAttempt(CAMPUS, 3000, FailureKind.TCP_TIMEOUT, "Connect timed out", "192.0.0.2"),
    )
    val failure = ConnectFailure(ConnectPhase.TCP, FailureKind.TCP_TIMEOUT, CAMPUS, attempts, "timeout")
    val d = ConnectionHelp.fromFailure(failure, listOf(LocalAddress("v4-rmnet_data0", "192.0.0.2", 32)))
    check("timeout guidance says code is not the problem", "pair code is not the problem" in d.userMessage) { d.userMessage }
    check("timeout guidance mentions hotspot", "hotspot" in d.userMessage) { d.userMessage }
    check("timeout guidance mentions firewall", "firewall" in d.userMessage) { d.userMessage }
    check("timeout detail shows CLAT route", "via 192.0.0.2" in d.detail) { d.detail }
    eq("timeout action", d.action, RecoveryAction.FIX_NETWORK)
    check("timeout is reachability", d.isReachability)
    val cellularOnly = ConnectionHelp.guidance(FailureKind.TCP_TIMEOUT, listOf(CAMPUS), listOf(LocalAddress("v4-rmnet_data0", "192.0.0.2", 32)), attempts)
    check("cellular-only phone told the address is not on its networks", "mobile data only" in cellularOnly && CAMPUS in cellularOnly) { cellularOnly }

    // Firewall on the computer: address IS on the phone's hotspot subnet but silent.
    val firewall = ConnectionHelp.guidance(FailureKind.TCP_TIMEOUT, listOf(HOTSPOT), hotspotPhone,
        listOf(EndpointAttempt(HOTSPOT, 3000, FailureKind.TCP_TIMEOUT, "Connect timed out", "10.42.61.1")))
    check("on-link timeout blames the firewall, not the network", "firewall" in firewall && "ap0" in firewall && "Connect the computer to this phone's hotspot" !in firewall) { firewall }

    val refused = ConnectionHelp.guidance(FailureKind.TCP_REFUSED, listOf(HOTSPOT), hotspotPhone, emptyList())
    check("refused guidance: AirBridge running", "running" in refused) { refused }
    eq("refused action", ConnectionHelp.actionFor(FailureKind.TCP_REFUSED), RecoveryAction.RETRY)
    eq("pin mismatch action", ConnectionHelp.actionFor(FailureKind.TLS_PIN_MISMATCH), RecoveryAction.FORGET_AND_RESCAN)
    eq("stale SAN action", ConnectionHelp.actionFor(FailureKind.TLS_HOSTNAME), RecoveryAction.RESCAN)
    check("TLS failure is not reachability", ConnectionDiagnosis(FailureKind.TLS_UNTRUSTED, "", "").isReachability.not())

    val invalid = ConnectionHelp.forServerError("INVALID_PAIR_CODE", "Pair code must be 6 valid characters.")!!
    eq("invalid code kind", invalid.kind, FailureKind.PAIR_CODE_INVALID)
    eq("invalid code action", invalid.action, RecoveryAction.RESCAN)
    val limited = ConnectionHelp.forServerError("RATE_LIMITED", "Too many")!!
    eq("rate limit kind", limited.kind, FailureKind.RATE_LIMITED)
    eq("rate limit action", limited.action, RecoveryAction.WAIT)
    check("rate limit says wait", "Wait" in limited.userMessage)
    check("unrelated server error not surfaced", ConnectionHelp.forServerError("NOT_REGISTERED", "x") == null)

    for (kind in FailureKind.values()) {
        check("title for $kind", ConnectionHelp.title(kind).isNotBlank())
        check("guidance for $kind", ConnectionHelp.guidance(kind, listOf(HOTSPOT), hotspotPhone, emptyList()).isNotBlank())
        ConnectionHelp.actionFor(kind)
    }
}

/** Minimal RFC 6455 server: answers one upgrade (or a fixed status line) per connection. */
private class FakeWsServer(private val status: String? = null) : AutoCloseable {
    val server = ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress())
    val hostHeaders = java.util.Collections.synchronizedList(mutableListOf<String>())
    private val clients = java.util.Collections.synchronizedList(mutableListOf<Socket>())
    init {
        Thread({
            while (!server.isClosed) {
                val s = runCatching { server.accept() }.getOrNull() ?: break
                clients += s
                Thread({ serve(s) }, "fake-ws").apply { isDaemon = true; start() }
            }
        }, "fake-ws-accept").apply { isDaemon = true; start() }
    }
    val port get() = server.localPort
    private fun serve(s: Socket) = runCatching {
        val inp = s.getInputStream()
        val lines = ArrayList<String>()
        val sb = StringBuilder()
        while (true) {
            val b = inp.read()
            if (b < 0) return@runCatching
            if (b == '\n'.code) { val l = sb.toString().trimEnd('\r'); sb.clear(); if (l.isEmpty()) break; lines += l } else sb.append(b.toChar())
        }
        lines.firstOrNull { it.startsWith("Host:", true) }?.let { hostHeaders += it.substringAfter(':').trim() }
        val out = s.getOutputStream()
        if (status != null) { out.write("$status\r\nContent-Length: 0\r\n\r\n".toByteArray()); out.flush(); return@runCatching }
        val key = lines.first { it.startsWith("Sec-WebSocket-Key:", true) }.substringAfter(':').trim()
        val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
        out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
        out.flush()
    }
    override fun close() { server.close(); clients.forEach { runCatching { it.close() } } }
}

/**
 * Simulated network: [blackholed] hosts never answer (like the campus address
 * routed over cellular); [routes] maps a logical address to a loopback port.
 */
private class SimulatedNetwork(val routes: Map<String, Int>, val blackholed: Set<String>) : TcpConnector {
    val dialled = java.util.Collections.synchronizedList(mutableListOf<String>())
    override fun connect(host: String, port: Int, timeoutMs: Int, register: (Socket) -> Unit): Socket {
        dialled += host
        val s = Socket()
        register(s)
        if (host in blackholed) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                if (s.isClosed) throw IOException("Socket closed")
                Thread.sleep(10)
            }
            s.close()
            throw SocketTimeoutException("Connect timed out")
        }
        val target = routes[host] ?: throw NoRouteToHostException("No route to host $host")
        s.connect(InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), target), timeoutMs)
        return s
    }
}

private val silentListener = object : WebSocketClient.Listener {
    override fun onText(text: String) {}
    override fun onBinary(bytes: ByteArray) {}
    override fun onClosed(reason: String) {}
}

private fun tcpRace() {
    FakeWsServer().use { ws ->
        // 1. Unreachable campus address first in the QR; the hotspot address wins the race.
        val net = SimulatedNetwork(mapOf(HOTSPOT to ws.port), setOf(CAMPUS))
        val client = WebSocketClient("ws://$CAMPUS:3000/ws", silentListener, connectTimeoutMs = 3_000,
            alternateHosts = listOf(HOTSPOT), staggerMs = 200, tcpConnector = net, routeProbe = { _, _ -> "192.0.0.2" })
        val t0 = System.currentTimeMillis()
        client.connectBlocking()
        val elapsed = System.currentTimeMillis() - t0
        eq("race winner is the reachable address", client.connectedHost, HOTSPOT)
        check("race does not wait for the unreachable timeout", elapsed < 2_000) { "${elapsed}ms" }
        check("Host header uses the winning address", ws.hostHeaders.lastOrNull() == "$HOTSPOT:3000") { ws.hostHeaders.toString() }
        check("client is open", client.isOpen)
        client.close()
        check("owner close is recorded", client.closedByClient)

        // 2. Ranked order (hotspot first) connects without even waiting for the stagger.
        val ranked = EndpointSelector.order(listOf(CAMPUS, HOTSPOT), hotspotPhone)
        val net2 = SimulatedNetwork(mapOf(HOTSPOT to ws.port), setOf(CAMPUS))
        val c2 = WebSocketClient("ws://${ranked[0]}:3000/ws", silentListener, connectTimeoutMs = 3_000,
            alternateHosts = ranked.drop(1), staggerMs = 400, tcpConnector = net2)
        val t1 = System.currentTimeMillis()
        c2.connectBlocking()
        check("ranked hotspot connects immediately", System.currentTimeMillis() - t1 < 380 && net2.dialled == listOf(HOTSPOT)) { net2.dialled.toString() }
        c2.close()
    }

    // 3. Every address blackholed (Mac not on the hotspot, or a dropping firewall).
    run {
        val net = SimulatedNetwork(emptyMap(), setOf(CAMPUS, HOTSPOT))
        val client = WebSocketClient("ws://$CAMPUS:3000/ws", silentListener, connectTimeoutMs = 800,
            alternateHosts = listOf(HOTSPOT), staggerMs = 100, tcpConnector = net, routeProbe = { _, _ -> "192.0.0.2" })
        val t0 = System.currentTimeMillis()
        val e = runCatching { client.connectBlocking() }.exceptionOrNull()
        val elapsed = System.currentTimeMillis() - t0
        check("all-timeout throws ConnectFailure", e is ConnectFailure) { e.toString() }
        val f = e as ConnectFailure
        eq("all-timeout phase", f.phase, ConnectPhase.TCP)
        eq("all-timeout kind", f.kind, FailureKind.TCP_TIMEOUT)
        eq("both candidates attempted", f.attempts.map { it.host }.toSet(), setOf(CAMPUS, HOTSPOT))
        check("route source recorded", f.attempts.all { it.routeSource == "192.0.0.2" })
        check("candidates dialled in parallel", elapsed < 1_500) { "${elapsed}ms" }
        val d = ConnectionHelp.fromFailure(f, listOf(LocalAddress("v4-rmnet_data0", "192.0.0.2", 32)))
        check("diagnosis says not the pair code", "pair code is not the problem" in d.userMessage)
    }

    // 4. Refused (AirBridge not running) beats timeout in the summary.
    run {
        val closedPort = ServerSocket(0).use { it.localPort }
        val net = SimulatedNetwork(mapOf(HOTSPOT to closedPort), setOf(CAMPUS))
        val client = WebSocketClient("ws://$CAMPUS:3000/ws", silentListener, connectTimeoutMs = 600,
            alternateHosts = listOf(HOTSPOT), staggerMs = 50, tcpConnector = net, routeProbe = { _, _ -> null })
        val f = runCatching { client.connectBlocking() }.exceptionOrNull() as? ConnectFailure
        eq("refused summarised", f?.kind, FailureKind.TCP_REFUSED)
        eq("refused action", f?.let { ConnectionHelp.fromFailure(it).action }, RecoveryAction.RETRY)
    }

    // 5. TCP ok, upgrade rejected.
    FakeWsServer("HTTP/1.1 403 Forbidden").use { ws ->
        val client = WebSocketClient("ws://$HOTSPOT:3000/ws", silentListener, connectTimeoutMs = 2_000,
            tcpConnector = SimulatedNetwork(mapOf(HOTSPOT to ws.port), emptySet()))
        val f = runCatching { client.connectBlocking() }.exceptionOrNull() as? ConnectFailure
        eq("upgrade rejected phase", f?.phase, ConnectPhase.UPGRADE)
        eq("upgrade rejected kind", f?.kind, FailureKind.WS_REJECTED)
    }

    // 6. wss:// against a plain-HTTP listener: a TLS failure, not "unreachable".
    FakeWsServer("HTTP/1.1 400 Bad Request").use { ws ->
        val client = WebSocketClient("wss://$HOTSPOT:3000/ws", silentListener, connectTimeoutMs = 2_000,
            tlsTrustManager = PinnedTlsTrust({ null }, {}, PIN),
            tcpConnector = SimulatedNetwork(mapOf(HOTSPOT to ws.port), emptySet()))
        val f = runCatching { client.connectBlocking() }.exceptionOrNull() as? ConnectFailure
        eq("plaintext listener phase", f?.phase, ConnectPhase.TLS)
        eq("plaintext listener kind", f?.kind, FailureKind.TLS_HANDSHAKE)
    }

    // 7. Owner cancels while dialling: CANCELLED, never a user-visible error.
    run {
        val net = SimulatedNetwork(emptyMap(), setOf(CAMPUS))
        val client = WebSocketClient("ws://$CAMPUS:3000/ws", silentListener, connectTimeoutMs = 5_000,
            tcpConnector = net, routeProbe = { _, _ -> null })
        val error = AtomicReference<Throwable?>()
        val t = Thread { error.set(runCatching { client.connectBlocking() }.exceptionOrNull()) }.apply { start() }
        Thread.sleep(150)
        client.close()
        t.join(2_000)
        check("cancel unblocks connect promptly", !t.isAlive)
        eq("cancel kind", (error.get() as? ConnectFailure)?.kind, FailureKind.CANCELLED)
    }
}

/**
 * Transport up (TCP + upgrade) but the server never answers hello: the engine
 * must report NO_WELCOME with the reached host instead of sitting on
 * "Reconnecting…" forever with no error, and must announce each attempt.
 */
private fun welcomeTimeout() {
    FakeWsServer().use { server ->
        val failures = java.util.concurrent.LinkedBlockingQueue<ConnectionDiagnosis>()
        val attempts = java.util.Collections.synchronizedList(mutableListOf<List<String>>())
        val reached = java.util.Collections.synchronizedList(mutableListOf<String>())
        val engine = AirBridgeEngine(
            EngineConfig(
                serverUrl = "ws://127.0.0.1:${server.port}/ws",
                deviceName = "Silent server probe",
                welcomeTimeoutMs = 600,
            ),
        )
        engine.addListener(object : EngineListener {
            override fun onConnectionFailure(diagnosis: ConnectionDiagnosis) { failures.put(diagnosis) }
            override fun onConnectAttempt(hosts: List<String>) { attempts += hosts }
            override fun onEndpointConnected(host: String) { reached += host }
        })
        val started = System.currentTimeMillis()
        engine.start()
        try {
            val d = failures.poll(10, java.util.concurrent.TimeUnit.SECONDS)
            val elapsed = System.currentTimeMillis() - started
            check("no-welcome reported", d != null) { "no failure within 10s" }
            if (d != null) {
                eq("no-welcome kind", d.kind, FailureKind.NO_WELCOME)
                eq("no-welcome action", ConnectionHelp.actionFor(d.kind), RecoveryAction.RETRY)
                check("no-welcome names host", "127.0.0.1" in d.userMessage && "127.0.0.1" in d.detail) { d.userMessage + " / " + d.detail }
                check("no-welcome not a pair-code hint", "pair code" !in d.userMessage.lowercase()) { d.userMessage }
                check("no-welcome after timeout", elapsed in 500..8000) { "elapsed=$elapsed" }
            }
            check("attempt announced", attempts.firstOrNull()?.firstOrNull() == "127.0.0.1") { attempts.toString() }
            check("transport reached", reached.firstOrNull() == "127.0.0.1") { reached.toString() }
            eq("still not connected", engine.currentState == ConnectionState.CONNECTED, false)
            // Retries keep going (and keep reporting) rather than hanging.
            val again = failures.poll(10, java.util.concurrent.TimeUnit.SECONDS)
            eq("retry reports again", again?.kind, FailureKind.NO_WELCOME)
        } finally {
            engine.stop()
        }
    }
}

/** Hands out sockets "the computer opened" (here: pre-dialled to the fake server) after [delayMs]. */
private class FakeInbound(private val make: () -> Socket?, private val delayMs: Long = 0) : InboundConnections {
    val rejected = java.util.Collections.synchronizedList(mutableListOf<String>())
    @Volatile var served = 0
    override fun await(timeoutMs: Long, cancelled: () -> Boolean, register: (Socket) -> Unit): Socket? {
        val until = System.currentTimeMillis() + minOf(delayMs, timeoutMs)
        while (System.currentTimeMillis() < until) { if (cancelled()) return null; Thread.sleep(10) }
        if (delayMs > timeoutMs || cancelled()) return null
        val s = make() ?: return null
        register(s); served++
        return s
    }
    override fun reject(host: String) { rejected += host }
}

/**
 * Reverse path: the computer dials the phone when every phone → computer dial
 * is blocked (inbound firewall, VPN, routing). The phone races its own dials
 * against an inbound socket; whichever wins runs the same TLS/upgrade.
 */
private fun reversePath() {
    FakeWsServer().use { server ->
        val dialToServer = { Socket().apply { connect(InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), server.port), 2_000) } }
        // 1. Firewalled computer: forward blackholed, inbound arrives after 300 ms → wins.
        run {
            val net = SimulatedNetwork(routes = emptyMap(), blackholed = setOf(CAMPUS, HOTSPOT))
            val inbound = FakeInbound(dialToServer, delayMs = 300)
            val ws = WebSocketClient("ws://$CAMPUS:${server.port}/ws", silentListener, connectTimeoutMs = 2_000,
                alternateHosts = listOf(HOTSPOT), staggerMs = 100, tcpConnector = net, routeProbe = { _, _ -> null }, inbound = inbound)
            val started = System.currentTimeMillis()
            ws.connectBlocking()
            val elapsed = System.currentTimeMillis() - started
            check("reverse: connected despite blocked forward path", ws.isOpen)
            check("reverse: flagged as computer-dialled", ws.connectedViaReverse)
            eq("reverse: host is the dialling computer", ws.connectedHost, "127.0.0.1")
            check("reverse: no wait for forward timeouts", elapsed < 1_500) { "elapsed=$elapsed" }
            ws.close()
        }
        // 2. Forward works: it wins, the inbound waiter is cancelled and never consumes a socket.
        run {
            val net = SimulatedNetwork(routes = mapOf(HOTSPOT to server.port), blackholed = emptySet())
            val inbound = FakeInbound(dialToServer, delayMs = 1_500)
            val ws = WebSocketClient("ws://$HOTSPOT:${server.port}/ws", silentListener, connectTimeoutMs = 2_000,
                tcpConnector = net, routeProbe = { _, _ -> null }, inbound = inbound)
            ws.connectBlocking()
            check("forward wins when it works", ws.isOpen && !ws.connectedViaReverse)
            Thread.sleep(1_700)
            eq("cancelled inbound waiter took no socket", inbound.served, 0)
            ws.close()
        }
        // 3. Forward fails fast (no route); computer dials in within the grace window → still connects.
        run {
            val net = SimulatedNetwork(routes = emptyMap(), blackholed = emptySet()) // every host: NoRouteToHost
            val inbound = FakeInbound(dialToServer, delayMs = 800)
            val ws = WebSocketClient("ws://$CAMPUS:${server.port}/ws", silentListener, connectTimeoutMs = 300,
                tcpConnector = net, routeProbe = { _, _ -> null }, inbound = inbound, reverseGraceMs = 2_000)
            ws.connectBlocking()
            check("grace: inbound after forward failure still wins", ws.isOpen && ws.connectedViaReverse)
            ws.close()
        }
        // 4. Nothing dials in: failure names both directions.
        run {
            val net = SimulatedNetwork(routes = emptyMap(), blackholed = setOf(CAMPUS))
            val inbound = FakeInbound({ null }, delayMs = 60_000)
            val ws = WebSocketClient("ws://$CAMPUS:${server.port}/ws", silentListener, connectTimeoutMs = 300,
                tcpConnector = net, routeProbe = { _, _ -> null }, inbound = inbound, reverseGraceMs = 300)
            val f = runCatching { ws.connectBlocking() }.exceptionOrNull() as? ConnectFailure
            check("no inbound: fails", f != null)
            eq("no inbound: kind from the forward attempt", f?.kind, FailureKind.TCP_TIMEOUT)
            check("no inbound: detail mentions computer→phone", f?.message?.contains("computer→phone: no connection") == true) { "${f?.message}" }
        }
    }

    // 5. Listener gate: inactive (unpinned trust / connected) → closed on accept.
    val gate = java.util.concurrent.atomic.AtomicBoolean(false)
    ReverseListener(0, active = { gate.get() }).use { listener ->
        val refused = Socket("127.0.0.1", listener.port).use { s -> s.soTimeout = 2_000; runCatching { s.getInputStream().read() }.getOrNull() }
        eq("inactive listener closes the socket", refused, -1)
        gate.set(true)
        val client = Socket("127.0.0.1", listener.port)
        val accepted = listener.await(2_000, { false }) {}
        check("active listener hands the socket over", accepted != null && accepted.isConnected)
        listener.reject("127.0.0.1")
        val again = Socket("127.0.0.1", listener.port).use { s -> s.soTimeout = 2_000; runCatching { s.getInputStream().read() }.getOrNull() }
        eq("rejected peer (failed TLS) is refused", again, -1)
        accepted?.close(); client.close()
    }

    // 6. Trust gate: TOFU without a pin or saved anchor must never accept reverse sockets.
    val unanchored = PinnedTlsTrust({ null }, {}, null)
    check("unanchored trust is not anchored", !unanchored.isAnchored())
    check("QR pin anchors", PinnedTlsTrust({ null }, {}, "A".repeat(43)).isAnchored())
    check("saved anchor anchors", PinnedTlsTrust({ ByteArray(1) }, {}, null).isAnchored())
    val engine = AirBridgeEngine(EngineConfig(serverUrl = "wss://$CAMPUS:3000/ws", deviceName = "gate", tlsTrustManager = unanchored,
        reverseListenPort = 0, connectTimeoutMs = 300, tcpConnector = SimulatedNetwork(emptyMap(), setOf(CAMPUS))))
    engine.start()
    try {
        val port = engine.reversePort
        check("engine bound a reverse port", port != null)
        if (port != null) {
            val r = Socket("127.0.0.1", port).use { s -> s.soTimeout = 2_000; runCatching { s.getInputStream().read() }.getOrNull() }
            eq("unpinned engine refuses reverse sockets", r, -1)
        }
    } finally { engine.stop() }
}
