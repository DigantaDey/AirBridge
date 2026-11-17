package com.airbridge.engine

import java.io.File
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.system.exitProcess

/**
 * Kotlin engine ↔ TypeScript hub: secure code exchange and relay fallback,
 * over real sockets and pinned TLS. Driven by scripts/test-native-interop.ts,
 * which runs the hub, a relay and a desktop WarpClient, and checks the
 * desktop side of every step.
 *
 *   args: <wss url> <pair code> <ca pin> <out dir>
 */
private fun require(label: String, ok: Boolean, detail: () -> String = { "" }) {
    if (!ok) throw IllegalStateException("$label ${detail()}")
    println("  ok  $label")
}

private fun waitUntil(label: String, timeoutMs: Long = 20_000, predicate: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!predicate()) {
        if (System.currentTimeMillis() > deadline) throw IllegalStateException("timed out: $label")
        Thread.sleep(25)
    }
}

private fun isLoopbackV6(host: String) = host == "::1" || host == "0:0:0:0:0:0:0:1"

private class PakeRecorder : EngineListener {
    @Volatile var welcome: WelcomeInfo? = null
    @Volatile var relayHost: String? = null
    @Volatile var directHost: String? = null
    val failures = java.util.concurrent.CopyOnWriteArrayList<ConnectionDiagnosis>()
    val handoff = java.util.concurrent.CopyOnWriteArrayList<Triple<String, Handoff.State, String>>()
    override fun onHandoffStatus(id: String, state: Handoff.State, reason: String) {
        handoff += Triple(id, state, reason)
        println("      · handoff $state ${reason.take(60)}")
    }
    override fun onWelcome(info: WelcomeInfo) { welcome = info }
    override fun onRelayConnected(relayHost: String) { this.relayHost = relayHost; directHost = null }
    override fun onEndpointConnected(host: String, viaReverse: Boolean) { directHost = host; relayHost = null }
    override fun onConnectionFailure(diagnosis: ConnectionDiagnosis) {
        failures += diagnosis
        println("      · ${diagnosis.kind}: ${diagnosis.detail}")
    }
}

private fun engine(
    url: String, code: String, pin: String, identity: DeviceIdentity,
    connector: TcpConnector? = null, relay: RelayRoute? = null,
): Pair<AirBridgeEngine, PakeRecorder> {
    var anchor: ByteArray? = null
    val e = AirBridgeEngine(
        EngineConfig(
            serverUrl = url,
            deviceName = "Pixel (Kotlin)",
            model = "Pixel",
            initialPairCode = code,
            tlsTrustManager = PinnedTlsTrust({ anchor }, { anchor = it }, pin),
            reverseListenPort = null,
            deviceIdentity = identity,
            tcpConnector = connector,
            initialRelay = relay,
            relayDelayMs = 300,
            directProbeMs = 1_000,
            connectTimeoutMs = 4_000,
        ),
    )
    val rec = PakeRecorder()
    e.addListener(rec)
    return e to rec
}

fun main(args: Array<String>) {
    try {
        val (url, code, pin, outDir) = args.toList()
        val out = File(outDir).apply { mkdirs() }
        val identity = SoftwareDeviceIdentity(File(out, "kotlin-identity"))

        println("== right code: SPAKE2 join, vouches, TLS pin bound to the code ==")
        val (e, rec) = engine(url, code, pin, identity)
        e.start()
        waitUntil("welcome") { rec.welcome != null }
        val welcome = rec.welcome!!
        require("admitted with the code proven (pake)", welcome.admission == "pake") { "${welcome.admission}" }
        require("relay offer present", welcome.relay != null) { welcome.toString() }
        require("relay route pinned to the vouched TLS anchor", e.relayRoute?.tlsPin == pin) { "${e.relayRoute}" }
        require("handoff key vouched by the code-holding hub", welcome.handoff != null && e.handoffInfo == welcome.handoff) { "${welcome.handoff}" }
        require("connected directly (relay not needed)", rec.directHost != null && !e.connectedViaRelay)
        waitUntil("desktop peer") { e.peersSnapshot().any { it.device.platform == "macos" } }
        val mac = e.peersSnapshot().first { it.device.platform == "macos" }
        require("desktop vouched by the code-holding hub", mac.verified && mac.attestation == "host") { mac.toString() }
        require("desktop identity proven", mac.provenIdentityKey != null)
        waitUntil("SAS") { e.sasCodeFor(mac.peerId) != null }
        e.setTrusted(mac.device.publicKey, true)
        require("trust pins the identity key", e.trustedKeys() == setOf(mac.provenIdentityKey!!)) { e.trustedKeys().toString() }
        val route = e.relayRoute!!
        File(out, "kotlin-result.json").writeText(
            JsonValue.Obj()
                .put("sas", e.sasCodeFor(mac.peerId)!!)
                .put("identityKey", e.myIdentityKey)
                .put("macIdentity", mac.provenIdentityKey!!)
                .put("relayToken", route.token)
                .toJsonString(),
        )
        File(out, "kotlin-ready").writeText("1")
        waitUntil("desktop checked our side", 45_000) { File(out, "desktop-ok").exists() }
        e.stop()

        println("== wrong code: rejected once, then waits for a new code ==")
        val wrong = if (code == "222222") "333333" else "222222"
        val (w, wrec) = engine(url, wrong, pin, identity)
        w.start()
        waitUntil("rejection") { w.pairingError != null }
        Thread.sleep(3_000)
        val rejections = wrec.failures.count { it.kind == FailureKind.PAIR_CODE_INVALID }
        require("one rejection, no retry loop", rejections == 1) { "$rejections rejections" }
        require("never admitted", w.currentAdmission == null && wrec.welcome == null)
        w.joinPairCode(code)
        waitUntil("rejoined with the right code") { w.currentAdmission == "pake" }
        require("same long-term identity across engines", w.myIdentityKey == e.myIdentityKey)
        w.stop()

        println("== relay fallback: direct path blocked ==")
        val directBlocked = AtomicBoolean(true)
        val directDials = AtomicInteger()
        val connector = TcpConnector { host, port, timeoutMs, register ->
            if (isLoopbackV6(host)) {
                directDials.incrementAndGet()
                if (directBlocked.get()) throw ConnectException("Connection timed out (simulated: client isolation)")
            }
            Socket().also { register(it); it.connect(InetSocketAddress(host, port), timeoutMs) }
        }
        val (r, rrec) = engine(url, code, pin, identity, connector, route)
        r.start()
        waitUntil("welcome through the relay", 30_000) { rrec.welcome != null }
        require("connected through the relay", r.connectedViaRelay && rrec.relayHost == route.host) { "${rrec.relayHost}" }
        require("still code-authenticated through the relay", r.currentAdmission == "pake")
        waitUntil("desktop through the relay") { r.peersSnapshot().any { it.device.platform == "macos" && it.verified } }
        val mac2 = r.peersSnapshot().first { it.device.platform == "macos" }
        waitUntil("session through the relay") { r.sasCodeFor(mac2.peerId) != null }
        r.sendClipboardText(mac2.peerId, "hello-through-the-relay-31337")
        waitUntil("desktop received the relayed clipboard", 30_000) { File(out, "desktop-relay-ok").exists() }
        require("end-to-end encrypted beam delivered through the relay", true)

        println("== hotspot handoff offered over the relayed session ==")
        val info = r.handoffInfo
        // Same computer key and tag secret; the proof differs because it binds the peer id.
        require("handoff key known on the relayed connection", info != null && info.key == e.handoffInfo?.key && info.beacon == e.handoffInfo?.beacon)
        val envelope = Handoff.seal(info!!.key, code, Handoff.Offer("AndroidShare_4821", "p4ss-w0rd-xyz", Handoff.Security.WPA2_WPA3, 47390, r.myIdentityKey, "Pixel (Kotlin)"))
        require("sealed offer fits one Bluetooth attribute", envelope.size <= 512) { "${envelope.size} bytes" }
        require("offer sent over the session", r.sendHandoffOffer(envelope))
        waitUntil("computer asks its user", 20_000) { rrec.handoff.any { it.second == Handoff.State.PENDING } }
        waitUntil("computer joined the hotspot", 30_000) { rrec.handoff.any { it.second == Handoff.State.JOINED } }
        val handoffId = rrec.handoff.first { it.second == Handoff.State.JOINED }.first
        require("replayed offer refused", r.sendHandoffOffer(envelope))
        waitUntil("replay rejected", 20_000) { rrec.handoff.any { it.second == Handoff.State.INVALID } }
        require("hotspot end sent", r.sendHandoffEnd(handoffId))
        waitUntil("computer left the hotspot", 20_000) { rrec.handoff.any { it.first == handoffId && it.second == Handoff.State.ENDED } }
        waitUntil("desktop checked the handoff", 20_000) { File(out, "desktop-handoff-ok").exists() }

        println("== direct path returns: leave the relay ==")
        directBlocked.set(false)
        waitUntil("reconnected directly", 30_000) { rrec.directHost != null && rrec.welcome != null && !r.connectedViaRelay && r.currentState == ConnectionState.CONNECTED }
        require("moved back to the direct path", isLoopbackV6(rrec.directHost!!)) { "${rrec.directHost}" }
        r.stop()

        println("== relay with the wrong TLS pin is refused ==")
        val (x, xrec) = engine(url, code, pin, identity,
            TcpConnector { host, port, timeoutMs, register ->
                if (isLoopbackV6(host)) throw ConnectException("Connection timed out (simulated)")
                Socket().also { register(it); it.connect(InetSocketAddress(host, port), timeoutMs) }
            },
            route.copy(tlsPin = "A".repeat(43)))
        x.start()
        waitUntil("failure reported", 30_000) { xrec.failures.isNotEmpty() }
        Thread.sleep(1_500)
        require("no welcome via a relay that ends elsewhere", xrec.welcome == null && !x.connectedViaRelay) {
            xrec.failures.joinToString { it.detail }
        }
        require("classified as a changed TLS identity", xrec.failures.any { it.kind == FailureKind.TLS_PIN_MISMATCH }) {
            xrec.failures.joinToString { it.kind.name }
        }
        x.stop()

        File(out, "kotlin-done").writeText("1")
        println("PAKE + RELAY INTEROP (Kotlin side): ALL PASS")
        exitProcess(0)
    } catch (t: Throwable) {
        System.err.println("PAKE INTEROP FAILED: ${t.message}")
        t.printStackTrace()
        exitProcess(1)
    }
}
