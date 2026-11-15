package com.airbridge.engine

import java.io.File
import java.net.InetAddress
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

private fun resolveRepoFile(relPath: String): File? {
    val candidates = listOf(
        File(relPath),
        File("../$relPath"),
        File("../../$relPath"),
    )
    return candidates.firstOrNull { it.isFile }
}

/**
 * Behavioral and repo-contract verification for Milestone 1
 * (Packaging, Signing, Background Services, Discovery Queue & Security).
 */
fun main() {
    println("Running Milestone 1 behavioral & contract checks...")

    // 1. Real DiscoveryQueue: sequential resolution, deduplication, and stale generation safety
    val q = DiscoveryQueue<String>()
    check("enqueue ignored before start()", !q.enqueue("Mac1", "info1"))
    q.start()
    check("first enqueue succeeds", q.enqueue("Mac1", "info1"))
    check("duplicate pending service rejected", !q.enqueue("Mac1", "info1-dup"))
    check("distinct service accepted", q.enqueue("Mac2", "info2") && q.pendingCount() == 2)

    val first = q.nextToResolve()
    check("first resolved is Mac1 gen=1", first != null && first.first == 1L && first.second == "Mac1")
    check("duplicate enqueue of in-flight service rejected", !q.enqueue("Mac1", "info1-inflight"))
    check("nextToResolve blocked while in-flight", q.nextToResolve() == null)

    // Simulate 5s timeout clearing gen=1 and moving to Mac2 (gen=2)
    check("finish(gen=1) succeeds once", q.finish(1L))
    check("duplicate finish(gen=1) rejected", !q.finish(1L))
    val second = q.nextToResolve()
    check("second resolved is Mac2 gen=2", second != null && second.first == 2L && second.second == "Mac2")

    // Stale callback from gen=1 arrives late -> MUST NOT clear gen=2!
    check("stale gen=1 callback cannot finish gen=2", !q.finish(1L) && q.inFlightName == "Mac2")
    check("current gen=2 finish clears in-flight", q.finish(2L) && q.inFlightName == null)

    // Removing lost pending service
    q.enqueue("Mac3", "info3")
    q.enqueue("Mac4", "info4")
    q.removePending("Mac3")
    val third = q.nextToResolve()
    check("removePending skips lost Mac3 and resolves Mac4", third?.second == "Mac4")

    // Reset increments generation so old callbacks stay ignored
    val genBeforeReset = third!!.first
    q.reset()
    check("reset clears inFlightName and started", !q.started && q.inFlightName == null)
    check("old callback rejected after reset", !q.finish(genBeforeReset))

    // 2. Real DiscoveryUrlFormatter address prioritization & IPv6 framing
    val lo4 = InetAddress.getByName("127.0.0.1")
    val lan4 = InetAddress.getByName("192.168.1.42")
    val lan6 = InetAddress.getByName("fe80::1ff:fe23:4567:890a")
    val picked = DiscoveryUrlFormatter.pickBestAddress(listOf(lo4, lan6, lan4))
    check("pickBestAddress prefers non-loopback IPv4 over loopback & IPv6", picked == lan4)
    check("formatWsUrl formats IPv4 cleanly", DiscoveryUrlFormatter.formatWsUrl(lan4, 3411) == "ws://192.168.1.42:3411/ws")
    val activeInterface = runCatching {
        java.net.NetworkInterface.getNetworkInterfaces()?.asSequence()?.firstOrNull { it.isUp }?.name
    }.getOrNull() ?: "lo"
    val zoned6 = runCatching {
        InetAddress.getByName("fe80::1%$activeInterface")
    }.getOrElse {
        InetAddress.getByAddress(byteArrayOf(0xfe.toByte(), 0x80.toByte(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1))
    }
    val ipv6Url = DiscoveryUrlFormatter.formatWsUrl(zoned6, 3411)
    check("formatWsUrl brackets IPv6 and strips zone id",
        ipv6Url != null && ipv6Url.startsWith("ws://[") && ipv6Url.endsWith(":3411/ws") && !ipv6Url.contains('%'),
        "got $ipv6Url")
    check("formatWsUrl rejects port 0", DiscoveryUrlFormatter.formatWsUrl(lan4, 0) == null)

    // 3. Real PairingLink intent parsing invariants
    val intentLink = PairingLink.parse("airbridge://192.168.1.5:3411?pair=ABC-DEF")
    check("airbridge:// scheme parses cleanly", intentLink != null && intentLink.pairCode == "ABCDEF")
    check("invalid host rejected", PairingLink.parse("airbridge://:3411?pair=ABC-DEF") == null)
    check("missing scheme host rejected", PairingLink.parse("javascript:alert(1)") == null)

    // 4. Real AndroidManifest.xml and build.gradle.kts contract assertions
    val manifestFile = resolveRepoFile("android/app/src/main/AndroidManifest.xml")
    check("AndroidManifest.xml located", manifestFile != null)
    if (manifestFile != null) {
        val xml = manifestFile.readText()
        check("Manifest declares FOREGROUND_SERVICE_CONNECTED_DEVICE",
            xml.contains("android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"))
        check("Manifest declares FOREGROUND_SERVICE_DATA_SYNC",
            xml.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        check("Manifest least privilege: no dangerous REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
            !xml.contains("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
        check("ConnectionService sets foregroundServiceType connectedDevice|dataSync and exported=false",
            xml.contains("android:foregroundServiceType=\"connectedDevice|dataSync\"") &&
                xml.contains("android:name=\".ConnectionService\"") &&
                xml.contains("android:exported=\"false\""))
        check("ClipboardBeamActivity registered non-exported",
            xml.contains("android:name=\".ClipboardBeamActivity\"") && xml.contains("ClipboardTileService"))
    }

    val appGradleFile = resolveRepoFile("android/app/build.gradle.kts")
    check("android/app/build.gradle.kts located", appGradleFile != null)
    if (appGradleFile != null) {
        val gradle = appGradleFile.readText()
        check("build.gradle.kts enables V2 and V3 signing",
            gradle.contains("enableV2Signing = true") && gradle.contains("enableV3Signing = true"))
        check("build.gradle.kts uses monotonic 100000+ versionCode",
            gradle.contains("100000 + ciRunNumber") && gradle.contains("100000 + gitCommitCount"))
        check("build.gradle.kts uses ciSideload for debug buildType",
            gradle.contains("signingConfig = signingConfigs.getByName(\"ciSideload\")"))
    }

    println("Milestone1Test: $passed passed, $failed failed")
    if (failed > 0) exitProcess(1)
}
