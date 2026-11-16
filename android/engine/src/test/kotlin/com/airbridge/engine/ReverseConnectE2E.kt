package com.airbridge.engine

import java.io.File
import java.io.IOException
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Collections
import kotlin.system.exitProcess

/**
 * Live reverse-connection E2E against the real desktop server (driven by
 * scripts/test-native-interop.ts).
 *
 * Worst case for the forward path: every phone → computer dial is
 * blackholed (macOS firewall / VPN / phone routing via mobile data). The
 * desktop dials the phone's real [ReverseListener]; the engine races that
 * against its own dials and must reach welcome with the QR pair code, while
 * still verifying the computer's certificate against the QR pin.
 *
 *   ReverseConnectE2EKt <baseDir>
 *     reads  <baseDir>/qr.txt          (pairing URL with pin + code)
 *     writes <baseDir>/rv-port.txt     (port the desktop should dial)
 */
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

/** Every forward dial times out, like a SYN dropped by the computer's firewall. */
private object Blackhole : TcpConnector {
    val dialled: MutableList<String> = Collections.synchronizedList(mutableListOf())
    override fun connect(host: String, port: Int, timeoutMs: Int, register: (Socket) -> Unit): Socket {
        dialled += host
        val socket = Socket()
        register(socket)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (socket.isClosed) throw IOException("Socket closed")
            Thread.sleep(10)
        }
        socket.close()
        throw SocketTimeoutException("failed to connect to /$host (port $port) after ${timeoutMs}ms")
    }
}

private class Rec : EngineListener {
    @Volatile var welcome: WelcomeInfo? = null
    @Volatile var endpoint: String? = null
    @Volatile var viaReverse = false
    val failures: MutableList<ConnectionDiagnosis> = Collections.synchronizedList(mutableListOf())
    override fun onWelcome(info: WelcomeInfo) { welcome = info }
    override fun onEndpointConnected(host: String, viaReverse: Boolean) { endpoint = host; this.viaReverse = viaReverse }
    override fun onConnectionFailure(diagnosis: ConnectionDiagnosis) { failures += diagnosis }
}

private fun engineFor(store: PairingInvitationStore, link: PairingLink, rec: Rec): AirBridgeEngine {
    val plan = store.bootstrap() ?: error("no invitation")
    return AirBridgeEngine(
        EngineConfig(
            serverUrl = plan.link.wsUrl,
            deviceName = "Reverse Phone",
            model = "Pixel",
            initialPairCode = plan.pairCode,
            tlsTrustManager = store.tlsTrust(link),
            endpointHosts = { store.candidateHosts() },
            connectTimeoutMs = 1_500,
            endpointStaggerMs = 300,
            tcpConnector = Blackhole,
            reverseListenPort = 0,
        ),
    ).also { it.addListener(rec); it.start() }
}

fun main(args: Array<String>) {
    val baseDir = File(args.getOrElse(0) { "/tmp/ab-reverse-e2e" })
    println("▸ Reverse connection E2E (phone side): forward path blackholed")
    val qrFile = File(baseDir, "qr.txt")
    waitUntil("desktop wrote qr.txt", 60_000) { qrFile.exists() && qrFile.readText().isNotBlank() }
    val link = PairingLink.parse(qrFile.readText().trim()) ?: error("bad QR")
    require("QR carries a TLS pin", link.tlsPin != null)

    // 1. Impostor first: same QR, but a pin that is NOT the computer's. The
    //    computer still dials in, TLS must fail, and the phone must reject it.
    run {
        val badPin = link.tlsPin!!.let { (if (it[0] == 'A') "B" else "A") + it.substring(1) }
        val bad = PairingLink.parse(qrFile.readText().trim().replace(link.tlsPin!!, badPin))!!
        val store = PairingInvitationStore(InMemoryKeyValueStore())
        store.stage(bad)
        val rec = Rec()
        val engine = engineFor(store, bad, rec)
        File(baseDir, "rv-port.txt").writeText("${engine.reversePort}")
        waitUntil("computer dialled in with a pin mismatch", 20_000) {
            rec.failures.any { it.kind == FailureKind.TLS_PIN_MISMATCH }
        }
        require("no welcome with a wrong pin", rec.welcome == null)
        engine.stop()
        ok("pin mismatch over the reverse path is refused (TLS stays pinned)")
    }

    // 2. Correct QR.
    val store = PairingInvitationStore(InMemoryKeyValueStore())
    store.stage(link)
    val rec = Rec()
    val engine = engineFor(store, link, rec)
    val port = engine.reversePort
    require("engine listens for reverse connections", port != null)
    File(baseDir, "rv-port.txt").writeText("$port")
    waitUntil("welcome via the computer's connection", 30_000) { rec.welcome != null }
    require("connected via reverse path", rec.viaReverse) { "endpoint=${rec.endpoint}" }
    require("welcome carries the QR pair code", rec.welcome!!.pairCode == link.pairCode) { rec.welcome!!.pairCode }
    require("phone still tried its own dials", Blackhole.dialled.isNotEmpty())
    ok("forward blackholed → computer dialled in → pinned TLS → welcome (${rec.welcome!!.pairCode})")
    File(baseDir, "k-done.txt").writeText(engine.myPeerId)
    // Stay connected until the desktop has seen us as a LAN (non-host) peer.
    waitUntil("desktop confirmed", 30_000) { File(baseDir, "d-done.txt").exists() }
    engine.stop()
    println("ReverseConnectE2E: ALL PASS")
}
