package com.airbridge.engine

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * Pluggable file IO for transfers.
 *
 * Sending side: [FileSource] abstracts any byte range read (app uses
 * content:// URIs; tests use memory/temp files).
 *
 * Receiving side: [FileSink] streams chunks to durable storage as they
 * arrive (never buffering the whole file), tracks received chunk indexes in
 * a sidecar manifest and append-only journal so an interrupted transfer
 * resumes from disk without per-chunk JSON rewrites, and verifies SHA-256
 * on finalize.
 */
interface FileSource {
    val name: String
    val size: Long
    val mimeType: String
    val relativePath: String? get() = null

    /** Return the bytes in [start, end). May return fewer only at EOF. */
    fun readRange(start: Long, end: Long): ByteArray
}

class ByteArrayFileSource(
    override val name: String,
    private val data: ByteArray,
    override val mimeType: String = "application/octet-stream",
    override val relativePath: String? = null,
) : FileSource {
    override val size: Long get() = data.size.toLong()
    override fun readRange(start: Long, end: Long): ByteArray =
        data.copyOfRange(start.toInt(), end.toInt())
}

class FileInputStreamSource(
    private val file: File,
    override val mimeType: String = "application/octet-stream",
) : FileSource {
    override val name: String get() = file.name
    override val size: Long get() = file.length()
    override fun readRange(start: Long, end: Long): ByteArray {
        val len = (end - start).toInt()
        val out = ByteArray(len)
        FileInputStream(file).use { fis ->
            fis.skip(start)
            var off = 0
            while (off < len) {
                val n = fis.read(out, off, len - off)
                if (n == -1) break
                off += n
            }
        }
        return out
    }
}

data class FileFinalize(
    val savedPath: String,
    val sha256: String,
    val verified: Boolean,
)

interface FileSink {
    /** Highest contiguous chunk index already durable (resume hint for the sender). */
    fun resumeFrom(): Int

    fun hasReceived(chunkIndex: Int): Boolean

    fun receivedCount(): Int

    /** Persist one decrypted chunk (no-op if already received). */
    fun store(chunkIndex: Int, data: ByteArray)

    /** The sender declared this file complete. */
    fun markComplete()

    /**
     * Finalize when every chunk has arrived (or when [force] is set for an
     * incomplete transfer). Returns null when nothing can be finalized yet.
     */
    fun finalizeIfReady(declaredSha256: String?, force: Boolean): FileFinalize?

    /** Cancel/decline: drop partial state. */
    fun discard()

    fun lastError(): String?
}

/** Factory the UI supplies when accepting an incoming offer. */
interface FileSinkFactory {
    fun open(transferId: String, meta: FileManifestItem): FileSink
}

/**
 * Disk-backed sink: `<transfer>.<index>.part` + a small JSON sidecar with
 * the received-chunk set, mirroring the host daemon's partialReceive design.
 *
 * @param finisher called on successful finalize to move the part file to its
 *   final location; returns the final path. Default keeps it in place.
 */
class DirectoryFileSink(
    stagingDir: File,
    private val meta: FileManifestItem,
    private val transferId: String,
    private val finisher: (partFile: File, name: String) -> File = { f, _ -> f },
) : FileSink {
    private val partFile = File(stagingDir, "$transferId.${meta.index}.part")
    private val sidecar = File(stagingDir, "$transferId.${meta.index}.meta")
    private val journalFile = File(stagingDir, "$transferId.${meta.index}.journal")
    private val received = sortedSetOf<Int>()
    private val pendingJournal = ArrayList<Int>()
    private var hasSnapshot = false
    private var complete = false
    private var error: String? = null
    private var raf: RandomAccessFile? = null
    private var finalized = false

    init {
        stagingDir.mkdirs()
        if (sidecar.exists()) {
            try {
                val text = sidecar.readText(Charsets.UTF_8)
                val o = JsonValue.parseObject(text)
                (o.optArr("received") ?: JsonValue.JsonArr()).items.forEach { v ->
                    val index = v.asInt()
                    if (index >= 0 && index < meta.totalChunks) received.add(index)
                }
                complete = o.optBool("complete") ?: false
                hasSnapshot = true
            } catch (_: Exception) {
                received.clear()
            }
        }
        if (hasSnapshot) replayJournal() else journalFile.delete()
        if (received.isEmpty() && partFile.exists() && partFile.length() == 0L) {
            partFile.delete()
        }
        if (partFile.exists()) {
            try {
                raf = RandomAccessFile(partFile, "rw")
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    /** Fixed-width indexes make resume metadata linear in the number of chunks. */
    private fun replayJournal() {
        try {
            if (!journalFile.exists()) return
            val alignedLength = journalFile.length() - journalFile.length() % JOURNAL_ENTRY_BYTES
            if (alignedLength != journalFile.length()) {
                RandomAccessFile(journalFile, "rw").use { it.setLength(alignedLength) }
            }
            val bytes = journalFile.readBytes()
            var offset = 0
            while (offset + JOURNAL_ENTRY_BYTES <= bytes.size) {
                val index = ((bytes[offset].toInt() and 0xff) shl 24) or
                    ((bytes[offset + 1].toInt() and 0xff) shl 16) or
                    ((bytes[offset + 2].toInt() and 0xff) shl 8) or
                    (bytes[offset + 3].toInt() and 0xff)
                if (index >= 0 && index < meta.totalChunks) received.add(index)
                offset += JOURNAL_ENTRY_BYTES
            }
        } catch (_: Exception) {
            // The atomic sidecar is still a valid, slightly older checkpoint.
        }
    }

    override fun resumeFrom(): Int {
        var contiguous = 0
        while (received.contains(contiguous)) contiguous++
        return contiguous
    }

    override fun hasReceived(chunkIndex: Int): Boolean = received.contains(chunkIndex)

    override fun receivedCount(): Int = received.size

    override fun store(chunkIndex: Int, data: ByteArray) {
        if (received.contains(chunkIndex)) return
        try {
            val handle = raf ?: RandomAccessFile(partFile, "rw").also {
                // Size the part file once, not on every chunk.
                if (it.length() != meta.size) it.setLength(meta.size)
                raf = it
            }
            handle.seek(chunkIndex * meta.chunkSize.toLong())
            handle.write(data)
            received.add(chunkIndex)
            pendingJournal.add(chunkIndex)
            if (!hasSnapshot) {
                // Anchor one atomic snapshot per file, then append fixed-width
                // indexes in bounded batches instead of rewriting JSON per chunk.
                persistSidecar()
                pendingJournal.clear()
                journalFile.delete()
            } else if (pendingJournal.size >= JOURNAL_FLUSH_CHUNKS || chunkIndex == meta.totalChunks - 1) {
                flushJournal()
            }
        } catch (e: Exception) {
            error = e.message ?: "write failed"
            throw IOException("disk write failed: ${e.message}", e)
        }
    }

    private fun persistSidecar() {
        val o = JsonValue.Obj()
            .put("received", JsonValue.JsonArr(received.map { JsonValue.JsonLong(it.toLong()) }.toMutableList()))
            .put("complete", complete)
        val tmp = File(sidecar.parentFile, sidecar.name + ".tmp")
        tmp.writeText(o.toJsonString(), Charsets.UTF_8)
        if (!tmp.renameTo(sidecar)) {
            sidecar.writeText(o.toJsonString(), Charsets.UTF_8)
            tmp.delete()
        }
        hasSnapshot = true
    }

    private fun flushJournal() {
        if (pendingJournal.isEmpty()) return
        if (journalFile.exists() && journalFile.length() % JOURNAL_ENTRY_BYTES != 0L) {
            RandomAccessFile(journalFile, "rw").use {
                it.setLength(it.length() - it.length() % JOURNAL_ENTRY_BYTES)
            }
        }
        val bytes = ByteArray(pendingJournal.size * JOURNAL_ENTRY_BYTES)
        pendingJournal.forEachIndexed { i, index ->
            val offset = i * JOURNAL_ENTRY_BYTES
            bytes[offset] = (index ushr 24).toByte()
            bytes[offset + 1] = (index ushr 16).toByte()
            bytes[offset + 2] = (index ushr 8).toByte()
            bytes[offset + 3] = index.toByte()
        }
        FileOutputStream(journalFile, true).use { it.write(bytes) }
        pendingJournal.clear()
    }

    override fun markComplete() {
        complete = true
        try {
            // A completion snapshot is written only once per file. It also
            // compacts the journal; replay remains idempotent if deletion is
            // interrupted after the atomic rename.
            persistSidecar()
            pendingJournal.clear()
            journalFile.delete()
        } catch (_: Exception) {
        }
    }

    override fun finalizeIfReady(declaredSha256: String?, force: Boolean): FileFinalize? {
        if (finalized) return null
        val allArrived = received.size >= meta.totalChunks
        if (!allArrived && !force) return null
        if (!allArrived && force) {
            error = error ?: "Transfer incomplete: some chunks never arrived."
            closeHandle()
            return null
        }
        try {
            flushJournal()
            closeHandle()
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(partFile).use { fis ->
                val buf = ByteArray(256 * 1024)
                while (true) {
                    val n = fis.read(buf)
                    if (n == -1) break
                    digest.update(buf, 0, n)
                }
            }
            val hex = digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            val verified = declaredSha256 == null || declaredSha256 == hex
            val finalTarget = finisher(partFile, meta.name)
            sidecar.delete()
            journalFile.delete()
            finalized = true
            return FileFinalize(finalTarget.absolutePath, hex, verified)
        } catch (e: Exception) {
            error = e.message ?: "finalize failed"
            return null
        }
    }

    private fun closeHandle() {
        try {
            raf?.close()
        } catch (_: Exception) {
        }
        raf = null
    }

    override fun discard() {
        closeHandle()
        partFile.delete()
        sidecar.delete()
        journalFile.delete()
        received.clear()
        pendingJournal.clear()
    }

    override fun lastError(): String? = error

    private companion object {
        const val JOURNAL_ENTRY_BYTES = 4
        const val JOURNAL_FLUSH_CHUNKS = 32
    }
}

/** Convenience factory staging into one directory with a final destination hook. */
class DirectoryFileSinkFactory(
    private val stagingDir: File,
    private val finisher: (partFile: File, name: String) -> File = { f, _ -> f },
) : FileSinkFactory {
    override fun open(transferId: String, meta: FileManifestItem): FileSink =
        DirectoryFileSink(stagingDir, meta, transferId, finisher)
}
