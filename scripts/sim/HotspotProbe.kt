// Phone side of scripts/sim/run-scenario.sh: real engine, real sockets, LocalNetworks.snapshot()
// of the phone namespace (ap0 hotspot + rmnet0 CLAT 192.0.0.2). Starts from a stale saved code.
import com.airbridge.engine.*
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    val store = PairingInvitationStore(InMemoryKeyValueStore())
    // Stale state from an older pairing on another network.
    store.stage(PairingLink.parse("https://10.205.95.167:3000/?pair=HJK234")!!); store.bootstrap()
    val link = PairingLink.parse(args[0]) ?: error("bad QR")
    store.stage(link)
    val locals = LocalNetworks.snapshot()
    println("phone interfaces: $locals")
    println("ranked candidates: ${EndpointSelector.rank(store.candidateHosts(), locals).map { "${it.host}${it.via?.let { v -> " (on-link via ${v.interfaceName})" } ?: " (off-link)"}" }}")
    val plan = store.bootstrap()!!
    println("pair code used: ${plan.pairCode} (fresh scan: ${plan.freshScan})")
    var welcome: WelcomeInfo? = null; var host: String? = null; var reverse = false; var failure: ConnectionDiagnosis? = null
    val t0 = System.currentTimeMillis()
    val engine = AirBridgeEngine(EngineConfig(serverUrl = plan.link.wsUrl, deviceName = "Probe", initialPairCode = plan.pairCode,
        tlsTrustManager = store.tlsTrust(plan.link), endpointHosts = { store.candidateHosts() }, connectTimeoutMs = 4000))
    engine.addListener(object : EngineListener {
        override fun onWelcome(info: WelcomeInfo) { welcome = info }
        override fun onEndpointConnected(h: String, viaReverse: Boolean) { host = h; reverse = viaReverse }
        override fun onConnectionFailure(d: ConnectionDiagnosis) { if (failure == null) failure = d }
    })
    engine.start()
    while (welcome == null && failure == null && System.currentTimeMillis() - t0 < 20_000) Thread.sleep(20)
    val ms = System.currentTimeMillis() - t0
    engine.stop()
    welcome?.let { println("CONNECTED via $host${if (reverse) " (computer dialled the phone)" else ""} in ${ms}ms — TLS (QR pin) + WSS + welcome, pairCode=${it.pairCode}"); exitProcess(0) }
    failure?.let {
        println("FAILED after ${ms}ms: ${it.kind} → action ${it.action}")
        println("  title:   ${ConnectionHelp.title(it.kind)}")
        println("  message: ${it.userMessage}")
        println("  detail:  ${it.detail.replace("\n", "\n           ")}")
        exitProcess(2)
    }
    println("NO RESULT after ${ms}ms"); exitProcess(3)
}
