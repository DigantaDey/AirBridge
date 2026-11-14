package com.airbridge.engine

import java.io.File
import java.security.MessageDigest
import java.util.Collections
import kotlin.system.exitProcess

/**
 * Live end-to-end harness against a real AirBridge server.
 *
 *   E2EHarnessKt kk [wsUrl] [baseDir]   — two engines in-process (Kotlin <-> Kotlin)
 *   E2EHarnessKt k  [wsUrl] [baseDir]   — one engine, paired with scripts/e2e-kotlin.ts
 *
 * Exit 0 = all checks passed.
 */
private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

private fun sha256File(f: File): String {
    val d = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { ins ->
        val buf = ByteArray(256 * 1024)
        while (true) {
            val n = ins.read(buf)
            if (n == -1) break
            d.update(buf, 0, n)
        }
    }
    return d.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
}

private fun patternBytes(size: Int, seed: Int = 17): ByteArray =
    ByteArray(size) { i -> ((i * 31 + seed) and 0xff).toByte() }

private fun await(label: String, timeoutMs: Long = 60_000, pred: () -> Boolean) {
    val start = System.currentTimeMillis()
    while (!pred()) {
        if (System.currentTimeMillis() - start > timeoutMs) {
            println("TIMEOUT: $label")
            exitProcess(1)
        }
        Thread.sleep(30)
    }
    println("  ok: $label")
}

private class Listener(
    private val accept: ((TransferView) -> Unit)? = null,
) : EngineListener {
    @Volatile var state = ConnectionState.DISCONNECTED
    val clips: MutableList<String> = Collections.synchronizedList(mutableListOf())
    var progress: ((TransferView) -> Unit)? = null
    override fun onTransferChanged(transfer: TransferView) { progress?.invoke(transfer) }

    override fun onConnectionState(state: ConnectionState) {
        this.state = state
    }
    override fun onIncomingOffer(transfer: TransferView) {
        accept?.invoke(transfer)
    }
    override fun onClipboard(item: ClipboardItem) {
        clips.add(item.text)
    }
}

private fun engine(
    serverUrl: String,
    name: String,
    sinkDir: File?,
    autoAccept: Boolean,
    listener: Listener,
    factory: FileSinkFactory? = null,
): AirBridgeEngine {
    var anchor: ByteArray? = null
    val e = AirBridgeEngine(
        EngineConfig(
            serverUrl = serverUrl,
            deviceName = name,
            autoAcceptAll = autoAccept,
            tlsTrustManager = PinnedTlsTrust({ anchor }, { anchor = it }),
            defaultSinkFactory = factory ?: sinkDir?.let { DirectoryFileSinkFactory(it) },
        ),
    )
    e.addListener(listener)
    e.start()
    e.start() // idempotent: UI remounts must not open duplicate sockets/pumps
    return e
}

private fun singlePeer(e: AirBridgeEngine, label: String): String {
    lateinit var id: String
    await("$label sees exactly one peer") {
        val peers = e.peersSnapshot()
        if (peers.size == 1) {
            id = peers[0].peerId
            true
        } else false
    }
    return id
}

private fun waitTransfer(
    e: AirBridgeEngine,
    direction: TransferDirection,
    label: String,
    timeoutMs: Long = 90_000,
    acceptWhileWaiting: Boolean = false,
): TransferView {
    var out: TransferView? = null
    await(label, timeoutMs) {
        if (acceptWhileWaiting) {
            e.transfersSnapshot()
                .filter { it.direction == TransferDirection.INCOMING && it.status == TransferStatus.PENDING_ACCEPT }
                .forEach { e.acceptIncomingTransfer(it.transferId) }
        }
        out = e.transfersSnapshot().lastOrNull {
            it.direction == direction && it.status == TransferStatus.COMPLETED
        }
        out != null
    }
    return out!!
}

private fun runKk(serverUrl: String, base: File) {
    val dirA = File(base, "kk-a").apply { deleteRecursively(); mkdirs() }
    val dirB = File(base, "kk-b").apply { deleteRecursively(); mkdirs() }
    val results = mutableListOf<String>()

    val listenerA = Listener(accept = { t -> /* A is the accepting side for reverse */ })
    val listenerB = Listener()
    val a = engine(serverUrl, "Kotlin A", dirA, autoAccept = false, listener = listenerA)
    val publishing = java.util.concurrent.CountDownLatch(1)
    val allowPublish = java.util.concurrent.CountDownLatch(1)
    val b = engine(serverUrl, "Kotlin B", dirB, autoAccept = true, listener = listenerB,
        factory = DirectoryFileSinkFactory(dirB) { file, name ->
            if (name == "k2k-big.bin") {
                publishing.countDown()
                check(allowPublish.await(10, java.util.concurrent.TimeUnit.SECONDS)) { "Publishing blocked the reader" }
            }
            file
        })

    try {
        await("both engines connected") {
            listenerA.state == ConnectionState.CONNECTED && listenerB.state == ConnectionState.CONNECTED
        }
        val idOfB = singlePeer(a, "engine A")
        val idOfA = singlePeer(b, "engine B")
        await("SAS derived on both sides") {
            a.sasCodeFor(idOfB) != null && b.sasCodeFor(idOfA) != null
        }
        val sasA = a.sasCodeFor(idOfB)!!
        val sasB = b.sasCodeFor(idOfA)!!
        check(sasA == sasB && !sasA.contains('\u00b7').not()) { "sas format" }
        check(sasA.matches(Regex("""^\d{3} \u00b7 \d{3}$"""))) { "bad SAS: $sasA" }
        results.add("discovery + matching SAS ($sasA)")

        // A -> B: multi-chunk + tiny file
        val bigRaw = patternBytes(32 * 1024 * 1024 + 12345)
        val smallRaw = "tiny!!!".toByteArray()
        val bigSha = sha256Hex(bigRaw)
        a.sendFiles(
            idOfB,
            listOf(
                ByteArrayFileSource("k2k-big.bin", bigRaw),
                ByteArrayFileSource("k2k-small.txt", smallRaw),
                ByteArrayFileSource("empty.txt", ByteArray(0)),
            ),
        )
        check(publishing.await(20, java.util.concurrent.TimeUnit.SECONDS)) { "File never reached publication" }
        a.sendClipboardText(idOfB, "clipboard-during-publish")
        try {
            await("clipboard delivered while a large file is publishing", 5_000) {
                listenerB.clips.contains("clipboard-during-publish")
            }
        } finally { allowPublish.countDown() }
        waitTransfer(a, TransferDirection.OUTGOING, "A outgoing completed")
        val inB = waitTransfer(b, TransferDirection.INCOMING, "B incoming completed")
        check(inB.receivedFiles.size == 3 && inB.receivedFiles.all { it.verified }) {
            "B incoming not fully verified: ${inB.receivedFiles}"
        }
        val savedBig = inB.receivedFiles.first { it.name == "k2k-big.bin" }
        val savedBigFile = File(savedBig.savedPath)
        check(savedBigFile.exists() && savedBigFile.length() == bigRaw.size.toLong()) {
            "big file missing/short"
        }
        check(sha256File(savedBigFile) == bigSha) { "big file sha mismatch on disk" }
        results.add("A -> B: 3 files (including empty) completed + disk sha256 verified")

        // B -> A reverse (A accepts manually)
        val revRaw = patternBytes(512 * 1024, seed = 91)
        val revSha = sha256Hex(revRaw)
        b.sendFiles(idOfA, listOf(ByteArrayFileSource("k2k-reverse.bin", revRaw)))
        // A must accept before B's send can complete — poll/accept first, then
        // wait for B's outgoing leg.
        val inA = waitTransfer(
            a, TransferDirection.INCOMING, "A incoming completed (manual accept)",
            acceptWhileWaiting = true,
        )
        waitTransfer(b, TransferDirection.OUTGOING, "B outgoing completed")
        check(inA.receivedFiles.isNotEmpty() && inA.receivedFiles.all { it.verified }) {
            "reverse not verified: ${inA.receivedFiles}"
        }
        val savedRev = File(inA.receivedFiles.first().savedPath)
        check(savedRev.exists() && sha256File(savedRev) == revSha) { "reverse sha mismatch" }
        results.add("B -> A: reverse transfer verified on disk")

        // Clipboard both directions
        a.sendClipboardText(idOfB, "kotlin-a-clip-987654")
        await("B received A's clipboard", 20_000) { listenerB.clips.contains("kotlin-a-clip-987654") }
        b.sendClipboardText(idOfA, "kotlin-b-clip-123456")
        await("A received B's clipboard", 20_000) { listenerA.clips.contains("kotlin-b-clip-123456") }
        results.add("clipboard beams verified both directions")

        // history present on both sides
        await("history synced on A", 15_000) { a.historySnapshot().isNotEmpty() }
        results.add("history sync present")

        println("\nK<->K E2E PASSED:")
        results.forEach { println("  \u2713 $it") }
    } finally {
        a.stop()
        b.stop()
    }
}

private fun runK(serverUrl: String, base: File) {
    val dirK = File(base, "kts-k").apply { deleteRecursively(); mkdirs() }
    val listener = Listener()
    val k = engine(serverUrl, "Kotlin Bridge", dirK, autoAccept = true, listener = listener)
    var dropped = false
    var droppedOutgoing = false
    listener.progress = { transfer ->
        if (!dropped && transfer.direction == TransferDirection.INCOMING &&
            transfer.status == TransferStatus.TRANSFERRING && transfer.transferredBytes >= 4 * 1024 * 1024 &&
            transfer.transferredBytes < transfer.totalBytes) {
            dropped = true
            k.reconnect() // real socket drop, then automatic same-key resume
        }
        if (!droppedOutgoing && transfer.direction == TransferDirection.OUTGOING &&
            transfer.status == TransferStatus.TRANSFERRING && transfer.transferredBytes >= 4 * 1024 * 1024 &&
            transfer.transferredBytes < transfer.totalBytes) {
            droppedOutgoing = true
            k.reconnect()
        }
    }
    try {
        await("kotlin engine connected", 30_000) { listener.state == ConnectionState.CONNECTED }
        val tsPeer = singlePeer(k, "kotlin side")
        val sas = k.sasCodeFor(tsPeer)
        check(sas != null && sas.matches(Regex("""^\d{3} \u00b7 \d{3}$"""))) { "bad SAS: $sas" }
        val sasTmp = File(base, "kts-sas.txt.tmp")
        sasTmp.writeText(sas!!, Charsets.UTF_8)
        val sasFinal = File(base, "kts-sas.txt")
        sasTmp.renameTo(sasFinal)
        println("  ok: SAS written for TS cross-check ($sas)")

        // Leg 1: TS -> Kotlin
        val incoming = waitTransfer(k, TransferDirection.INCOMING, "K received TS's file")
        check(incoming.receivedFiles.isNotEmpty() && incoming.receivedFiles.all { it.verified }) {
            "incoming from TS not verified"
        }
        check(dropped && incoming.receivedFiles.size == 3) { "multi-file reconnect/resume was not exercised" }
        val f = File(incoming.receivedFiles.first { it.name == "e2e-kts-ts.bin" }.savedPath)
        check(f.exists() && f.length() == 32L * 1024 * 1024 + 1536 + 777) { "incoming file missing or truncated" }
        check(sha256File(f) == sha256Hex(patternBytes(f.length().toInt()))) { "Resumed disk bytes differ" }
        println("  ok: native receiver resumed a multi-file transfer after a real socket drop")

        // Leg 2: Kotlin -> TS
        val raw = patternBytes(20 * 1024 * 1024 + 73)
        k.sendFiles(tsPeer, listOf(ByteArrayFileSource("native-prefix.bin", patternBytes(128 * 1024)),
            ByteArrayFileSource("e2e-kts-k.bin", raw), ByteArrayFileSource("native-empty.bin", ByteArray(0))))
        waitTransfer(k, TransferDirection.OUTGOING, "K's file completed at TS")
        check(droppedOutgoing) { "Native sender socket-drop resume was not exercised" }
        println("  ok: native sender resumed a multi-file transfer after a real socket drop")

        // Leg 3: clipboard both directions
        await("K received TS clipboard", 45_000) { listener.clips.contains("  hello-from-ts-456\n") }
        k.sendClipboardText(tsPeer, "  hello-from-kotlin-123\n")
        await("TS acknowledged K's clipboard", 10_000) {
            File(base, "ts-clipboard-received").exists()
        }

        println("\nK side of K<->TS E2E PASSED (waiting for TS to finish)")
    } finally {
        k.stop()
    }
}

fun main(args: Array<String>) {
    val mode = args.getOrNull(0) ?: "kk"
    val serverUrl = args.getOrNull(1) ?: "ws://127.0.0.1:3411/ws"
    val base = File(args.getOrNull(2) ?: "/tmp/ab-e2e")
    base.mkdirs()
    try {
        when (mode) {
            "kk" -> runKk(serverUrl, base)
            "k" -> runK(serverUrl, base)
            else -> {
                println("unknown mode $mode")
                exitProcess(2)
            }
        }
        exitProcess(0)
    } catch (e: Throwable) {
        System.err.println("E2E FAILED: ${e.message}")
        e.printStackTrace()
        exitProcess(1)
    }
}
