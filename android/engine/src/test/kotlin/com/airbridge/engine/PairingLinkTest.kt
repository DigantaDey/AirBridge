package com.airbridge.engine

import kotlin.system.exitProcess

private var passed = 0
private var failed = 0

private fun check(name: String, ok: Boolean, detail: String = "") {
    if (ok) {
        passed++
    } else {
        failed++
        println("FAIL $name" + if (detail.isNotEmpty()) " -> $detail" else "")
    }
}

private fun expect(raw: String, want: PairingLink?, label: String = raw) {
    val got = PairingLink.parse(raw)
    check(
        label,
        got == want,
        "expected=$want got=$got",
    )
}

/**
 * Pairing-link parsing checks — the QR payload and hand-typed addresses are the
 * only thing standing between "scan the code" and a working phone.
 */
fun main() {
    // The QR the desktop prints today.
    expect(
        "https://192.168.1.5:3411/?pair=ABC-DEF",
        PairingLink("https", "192.168.1.5", 3411, "ABCDEF"),
    )
    expect("https://192.168.1.5:3411", PairingLink("https", "192.168.1.5", 3411, null))
    // Trailing newline / surrounding blank lines from a terminal QR.
    expect(
        "\n  https://airbridge.local:3411/?pair=234-567 \n",
        PairingLink("https", "airbridge.local", 3411, "234567"),
        "trimmed payload",
    )
    // Older builds advertised the websocket endpoint.
    expect(
        "wss://192.168.1.5:3411/ws",
        PairingLink("https", "192.168.1.5", 3411, null),
        "wss endpoint",
    )
    expect("ws://10.0.0.7:3411/ws", PairingLink("http", "10.0.0.7", 3411, null), "ws endpoint")
    // Plain-HTTP desktop (--http / AIRBRIDGE_HTTPS=0).
    expect("http://192.168.0.9:8080/?pair=JKM-NPQ", PairingLink("http", "192.168.0.9", 8080, "JKMNPQ"))
    // Hand-typed forms.
    expect("192.168.1.5:3411", PairingLink("https", "192.168.1.5", 3411, null), "host:port")
    expect("192.168.1.5", PairingLink("https", "192.168.1.5", 3411, null), "host only")
    expect("airbridge.local", PairingLink("https", "airbridge.local", 3411, null), "hostname only")
    expect("airbridge://192.168.1.9:3411?pair=234567", PairingLink("http", "192.168.1.9", 3411, "234567"))
    // Optional bits the parser tolerates.
    expect(
        "https://airbridge.local/?x=1#ignored",
        PairingLink("https", "airbridge.local", 3411, null),
        "fragment without pair",
    )
    expect(
        "https://airbridge.local/#pair=ABC-DEF",
        PairingLink("https", "airbridge.local", 3411, "ABCDEF"),
        "pair in fragment",
    )
    expect(
        "https://user:pass@192.168.1.5:3411/some/path?x=1&pair=AB-CD-EF",
        PairingLink("https", "192.168.1.5", 3411, "ABCDEF"),
        "userinfo, path and extra query",
    )
    expect(
        "https://[fe80::1]:3411/?pair=234567",
        PairingLink("https", "[fe80::1]", 3411, "234567"),
        "ipv6 literal",
    )
    // Codes are normalised like the rest of the protocol (0->2, O->Q, 1->L, I->J).
    expect(
        "https://192.168.1.5/?pair=O1I0AB",
        PairingLink("https", "192.168.1.5", 3411, "QLJ2AB"),
        "normalised pair code",
    )
    // Unusable input.
    expect("", null, "empty")
    expect("   ", null, "blank")
    expect("ftp://192.168.1.5", null, "unsupported scheme")
    expect("javascript:alert(1)", null, "javascript url")
    expect("https://", null, "scheme with no host")
    expect("https://192.168.1.5:99999", null, "port out of range")
    expect(
        "https://192.168.1.5:3411/?pair=SHORT",
        PairingLink("https", "192.168.1.5", 3411, null),
        "short pair code is not trusted",
    )
    expect("https://two words:3411", null, "host with a space")

    // Derived URLs the shell hands to the WebView.
    val link = PairingLink.parse("https://192.168.1.5:3411/?pair=ABC-DEF")!!
    // The default port is dropped so URLs read the way a person would type them.
    check("baseUrl", link.baseUrl == "https://192.168.1.5", link.baseUrl)
    check("wsUrl", link.wsUrl == "wss://192.168.1.5/ws", link.wsUrl)
    check("webUrl keeps code", link.webUrl() == "https://192.168.1.5/?pair=ABCDEF", link.webUrl())
    check("webUrl without code", link.webUrl(null) == "https://192.168.1.5/", link.webUrl(null))
    val customPort = PairingLink.parse("http://192.168.1.5:8080")!!
    check("custom port kept", customPort.baseUrl == "http://192.168.1.5:8080", customPort.baseUrl)
    check("custom port ws", customPort.wsUrl == "ws://192.168.1.5:8080/ws", customPort.wsUrl)
    val defaultPort = PairingLink.parse("https://airbridge.local/?pair=ABC-DEF")!!
    check("default port omitted", defaultPort.baseUrl == "https://airbridge.local", defaultPort.baseUrl)
    check("insecure scheme", !PairingLink.parse("http://192.168.1.5")!!.secure, "secure flag")

    println("PairingLink: $passed passed, $failed failed")
    if (failed > 0) exitProcess(1)
}
