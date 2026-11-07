package com.airbridge.engine

import java.io.File
import kotlin.system.exitProcess

/** Regression checks for bounded, append-only Android resume metadata. */
fun main() {
    val dir = java.nio.file.Files.createTempDirectory("airbridge-files-test").toFile()
    try {
        val chunkSize = 64
        val totalChunks = 80
        val raw = ByteArray(chunkSize * totalChunks) { i -> ((i * 29 + 11) and 0xff).toByte() }
        val meta = FileManifestItem(
            index = 0,
            name = "journal.bin",
            relativePath = null,
            size = raw.size.toLong(),
            mimeType = "application/octet-stream",
            totalChunks = totalChunks,
            chunkSize = chunkSize,
        )
        val transferId = "abababababababab"
        val firstProcess = DirectoryFileSink(dir, meta, transferId)
        for (i in 0 until 40) {
            firstProcess.store(i, raw.copyOfRange(i * chunkSize, (i + 1) * chunkSize))
        }

        val snapshot = JsonValue.parseObject(File(dir, "$transferId.0.meta").readText())
        check(snapshot.optArr("received")!!.size == 1) {
            "full resume JSON was rewritten instead of journaled"
        }
        check(File(dir, "$transferId.0.journal").length() == 32L * 4L) {
            "journal did not checkpoint exactly one 32-chunk batch"
        }

        // Reopening replays only durable checkpoints; the final seven chunks
        // are safely re-sent rather than risking an incomplete resume.
        val recovered = DirectoryFileSink(dir, meta, transferId)
        check(recovered.receivedCount() == 33) { "expected 33 recovered chunks, got ${recovered.receivedCount()}" }
        check(recovered.resumeFrom() == 33) { "resume did not stop at the contiguous checkpoint" }
        firstProcess.finalizeIfReady(null, force = true) // close the simulated crashed writer

        for (i in 0 until totalChunks) {
            recovered.store(i, raw.copyOfRange(i * chunkSize, (i + 1) * chunkSize))
        }
        recovered.markComplete()
        val result = recovered.finalizeIfReady(null, force = false)
        check(result != null && result.verified) { "journaled file did not finalize" }
        check(File(result!!.savedPath).readBytes().contentEquals(raw)) { "recovered bytes differ" }
        check(!File(dir, "$transferId.0.meta").exists()) { "sidecar survived finalize" }
        check(!File(dir, "$transferId.0.journal").exists()) { "journal survived finalize" }
        println("FILES: ALL PASS (append-only journal + crash resume + verified finalize)")
    } catch (t: Throwable) {
        System.err.println("FILES FAILED: ${t.message}")
        t.printStackTrace()
        exitProcess(1)
    } finally {
        dir.deleteRecursively()
    }
}
