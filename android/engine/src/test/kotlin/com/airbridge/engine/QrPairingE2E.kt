package com.airbridge.engine

import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Collections
import kotlin.system.exitProcess

/**
 * Live QR → pending code → native TLS/WSS → welcome/pairing flow against the
 * real desktop server (driven by scripts/test-native-interop.ts together with
 * scripts/e2e-qr-desktop.ts).
 *
 * The server's interfaces are mocked as the reported Mac: en0 10.205.95.167
 * (campus, unreachable from the phone) and en7 10.42.61.23 (on the phone's
 * hotspot). The desktop renders the QR with the campus address FIRST. The
 * phone's network is simulated: the hotspot address routes to the real
 * server; the campus address is blackholed exactly like a SYN sent over
 * cellular from 192.0.0.2.
 *
 *   QrPairingE2EKt <baseDir> <dialAddress>
 */
private const val CAMPUS = "10.205.95.167"
private const val HOTSPOT = "10.42.61.23"
private const val UNCOVERED = "10.42.61.99"

private val phoneOnHotspot = listOf(
    LocalAddress("lo", "127.0.0.1", 8),
    LocalAddress("v4-rmnet_data0", "192.0.0.2", 32),
    LocalAddress("ap0", "10.42.61.1", 24),
)

private fun ok(label: String) = println("  ok: $label")

private fun require(label: String, condition: Boolean, detail: () -> String = { "" }) {
    if (!condition) {
        println("FAIL: $label ${detail()}")
        exitProcess(1)
    }
}

private fun waitUntil(label: String, timeoutMs: Long = 30_000, predicate: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!predicate()) {
        if (System.currentTimeMillis() > deadline) {
            println("TIMEOUT: $label")
            exitProcess(1)
        }
        Thread.sleep(25)
    }
}

private fun readWhenPresent(file: File): String {
    waitUntil("desktop wrote ${file.name}", 60_000) { file.exists() && file.readText().trim().isNotEmpty() }
    return file.readText().trim()
}

/** Phone network model: [reachable] hosts route to the real server, the rest never answer. */
private class PhoneNetwork(private val dialAddress: String, private val reachable: Set<String>) : TcpConnector {
    val dialled: MutableList<String> = Collections.synchronizedList(mutableListOf())
    override fun connect(host: String, port: Int, timeoutMs: Int, register: (Socket) -> Unit): Socket {
        dialled += host
        val socket = Socket()
        register(socket)
        if (host !in reachable) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                if (socket.isClosed) throw IOException("Socket closed")
                Thread.sleep(10)
            }
            socket.close()
            throw SocketTimeoutException("failed to connect to /$host (port $port) from /192.0.0.2 after ${timeoutMs}ms")
        }
        socket.connect(InetSocketAddress(dialAddress, port), timeoutMs)
        return socket
    }
}

private class Recorder : EngineListener {
    @Volatile var welcome: WelcomeInfo? = null
    @Volatile var endpoint: String? = null
    val failures: MutableList<ConnectionDiagnosis> = Collections.synchronizedList(mutableListOf())
    override fun onWelcome(info: WelcomeInfo) { welcome = info }
    override fun onEndpointConnected(host: String) { endpoint = host }
    override fun onConnectionFailure(diagnosis: ConnectionDiagnosis) { failures += diagnosis }
}

/** Mirrors NativeEngineHost: build an engine from a bootstrap plan. */
private fun startEngine(store: PairingInvitationStore, net: PhoneNetwork, peerId: String?): Triple<AirBridgeEngine, Recorder, BootstrapPlan> {
    val plan = store.bootstrap() ?: error("no invitation")
    val recorder = Recorder()
    val engine = AirBridgeEngine(
        EngineConfig(
            serverUrl = plan.link.wsUrl,
            deviceName = "QR Phone",
            model = "Pixel",
            peerId = peerId,
            initialPairCode = plan.pairCode,
            tlsTrustManager = store.tlsTrust(plan.link),
            endpointHosts = { store.candidateHosts() },
            localNetworks = { phoneOnHotspot },
            connectTimeoutMs = 1_500,
            endpointStaggerMs = 300,
            tcpConnector = net,
        ),
    )
    engine.addListener(recorder)
    engine.addListener(object : EngineListener {
        override fun onWelcome(info: WelcomeInfo) {
            store.pairCode = info.pairCode
            store.learn(info.lanUrls)
        }
        override fun onEndpointConnected(host: String) = store.markConnected(host)
        override fun onLanUrlsChanged(lanUrls: List<String>) = store.learn(lanUrls)
    })
    engine.start()
    return Triple(engine, recorder, plan)
}

private fun AirBridgeEngine.pairedDesktop(): Peer? =
    peersSnapshot().firstOrNull { it.discoveryScope == "paired" && it.device.name == "QR Desktop" }

fun main(args: Array<String>) {
    val baseDir = File(args.getOrElse(0) { "/tmp/ab-qr-e2e" })
    val dialAddress = args.getOrElse(1) { "127.0.0.1" }
    println("▸ QR pairing E2E (phone side), real server reached via $dialAddress")
    val net = PhoneNetwork(dialAddress, setOf(HOTSPOT, UNCOVERED))

    // ---- QR #1 -----------------------------------------------------------
    val qr1 = readWhenPresent(File(baseDir, "qr1.txt"))
    val link1 = PairingLink.parse(qr1) ?: error("unparseable QR $qr1")
    require("QR primary is the (unreachable) campus address — worst case", link1.host == CAMPUS) { qr1 }
    require("QR carries the hotspot alternate", HOTSPOT in link1.alternateHosts) { qr1 }
    require("QR carries a TLS pin", link1.tlsPin != null) { qr1 }
    val port = link1.port
    ok("parsed QR: primary=$CAMPUS alt=${link1.alternateHosts} pin=${link1.tlsPin!!.take(8)}…")

    // Yesterday's state on this phone: different (stale) saved code and an
    // endpoint learned on an older network.
    val store = PairingInvitationStore(InMemoryKeyValueStore())
    store.stage(PairingLink.parse("https://$CAMPUS:$port/?pair=HJK234")!!)
    store.bootstrap()
    store.learn(listOf("https://10.205.95.200:$port"))
    store.markConnected(CAMPUS)
    require("stale code differs from the QR", link1.pairCode != "HJK234")

    store.stage(link1)
    require("scan staged the fresh code", store.pendingPairCode == link1.pairCode)
    require("scan cleared stale learned endpoints", store.learnedHosts.isEmpty())
    val (engine1, rec1, plan1) = startEngine(store, net, null)
    require("bootstrap chose the fresh scanned code", plan1.pairCode == link1.pairCode && plan1.freshScan) { plan1.toString() }
    waitUntil("welcome over native TLS/WSS") { rec1.welcome != null }
    val welcome1 = rec1.welcome!!
    require("connected via the hotspot address", rec1.endpoint == HOTSPOT) { "${rec1.endpoint}" }
    require("campus address never dialled first", net.dialled.firstOrNull() == HOTSPOT) { net.dialled.toString() }
    require("welcome pair code is the QR code, not the stale one", welcome1.pairCode == link1.pairCode) { welcome1.pairCode }
    require("welcome advertises both covered addresses",
        welcome1.lanUrls.toSet() == setOf("https://$CAMPUS:$port", "https://$HOTSPOT:$port")) { welcome1.lanUrls.toString() }
    require("no connection failure reported", rec1.failures.isEmpty()) { rec1.failures.toString() }
    waitUntil("desktop visible as a paired peer") { engine1.pairedDesktop() != null }
    require("saved code updated", store.pairCode == link1.pairCode)
    ok("QR → staged code → TLS (QR pin) → welcome → paired with desktop")
    File(baseDir, "k-paired-1.txt").writeText(engine1.myPeerId)

    // ---- Rescan: desktop rotated its room code; same computer, same target --
    val qr2 = readWhenPresent(File(baseDir, "qr2.txt"))
    val link2 = PairingLink.parse(qr2)!!
    require("fresh QR has a new code", link2.pairCode != link1.pairCode)
    require("fresh QR has the same target", link2.baseUrl == link1.baseUrl)
    val keyBefore = store.engineKey
    store.stage(link2)
    require("same-target rescan changes engineKey (service restarts the engine)", store.engineKey != keyBefore)
    engine1.stop()
    val peerId = engine1.myPeerId
    val (engine2, rec2, plan2) = startEngine(store, net, peerId)
    require("rescan bootstrap uses the new code", plan2.pairCode == link2.pairCode)
    waitUntil("welcome after rescan") { rec2.welcome != null }
    require("joined the rotated room", rec2.welcome!!.pairCode == link2.pairCode) { rec2.welcome!!.pairCode }
    waitUntil("desktop paired again after rescan") { engine2.pairedDesktop() != null }
    ok("rescan with a fresh code of the same computer re-pairs")
    File(baseDir, "k-paired-2.txt").writeText(engine2.myPeerId)
    readWhenPresent(File(baseDir, "d-paired-2.txt")) // desktop confirmed before we leave the room

    // Server rate limit is surfaced as its own failure kind.
    repeat(12) { i -> engine2.joinPairCode(if (i % 2 == 0) "ABC234" else link2.pairCode!!) }
    waitUntil("rate limit reported") { rec2.failures.any { it.kind == FailureKind.RATE_LIMITED } }
    require("rate limit guidance says wait", rec2.failures.first { it.kind == FailureKind.RATE_LIMITED }.action == RecoveryAction.WAIT)
    ok("RATE_LIMITED classified")
    engine2.stop()

    val restart = store.bootstrap()!!
    require("restart does not replay a staged code", !restart.freshScan)
    store.pairCode = link2.pairCode!! // (join attempts above changed the saved code)

    // ---- Failure classification on real sockets ---------------------------
    fun expectFailure(label: String, qr: String, kind: FailureKind): ConnectionDiagnosis {
        store.stage(PairingLink.parse(qr)!!)
        val (engine, rec, _) = startEngine(store, net, peerId)
        waitUntil("$label reported", 20_000) { rec.failures.isNotEmpty() }
        engine.stop()
        val d = rec.failures.first()
        require("$label kind", d.kind == kind) { "${d.kind}: ${d.detail}" }
        require("$label never welcomed", rec.welcome == null)
        ok("$label → ${d.kind} / ${d.action}")
        return d
    }

    val wrongPin = qr2.replace(Regex("ca=[A-Za-z0-9_-]{43}"), "ca=" + "A".repeat(43))
    val pinFail = expectFailure("QR pin mismatch", wrongPin, FailureKind.TLS_PIN_MISMATCH)
    require("pin mismatch → forget & rescan", pinFail.action == RecoveryAction.FORGET_AND_RESCAN)

    // Legacy QR (no alternates): only the campus address — the reported bug.
    val timeout = expectFailure("unreachable-only QR", "https://$CAMPUS:$port/?pair=${link2.pairCode}", FailureKind.TCP_TIMEOUT)
    require("timeout guidance: pair code is not the problem", "pair code is not the problem" in timeout.userMessage) { timeout.userMessage }
    require("timeout guidance names the phone's hotspot network", "ap0 10.42.61.0/24" in timeout.userMessage) { timeout.userMessage }
    require("timeout action: fix network", timeout.action == RecoveryAction.FIX_NETWORK)

    // Address the certificate does not cover (stale endpoint after a change).
    val san = expectFailure("uncovered address", "https://$UNCOVERED:$port/?pair=${link2.pairCode}&ca=${link2.tlsPin}", FailureKind.TLS_HOSTNAME)
    require("stale SAN → rescan", san.action == RecoveryAction.RESCAN)

    // ---- Retry after rescanning the current QR -----------------------------
    store.stage(link2)
    val (engine3, rec3, _) = startEngine(store, net, peerId)
    waitUntil("welcome after rescanning following failures") { rec3.welcome != null }
    waitUntil("paired after retry") { engine3.pairedDesktop() != null }
    require("retry connected via hotspot", rec3.endpoint == HOTSPOT)
    ok("rescan after failures recovers")
    engine3.stop()

    File(baseDir, "k-done.txt").writeText("ok")
    println("QR PAIRING E2E: ALL PASS")
    exitProcess(0)
}
