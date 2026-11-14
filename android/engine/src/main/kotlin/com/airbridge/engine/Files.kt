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
interface FileSource : AutoCloseable {
    override fun close() {}
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
        RandomAccessFile(file, "r").use { handle ->
            handle.seek(start)
            handle.readFully(out)
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

    /** Flush checkpoints and release descriptors without deleting resumable data. */
    fun pause() {}
}

/** Factory the UI supplies when accepting an incoming offer. */
interface FileSinkFactory {
    fun open(transferId: String, meta: FileManifestItem): FileSink
}

/** An already-published, verified file in a resumed multi-file transfer. */
internal class CompletedFileSink(private val receipt: ReceivedFileInfo, private val meta: FileManifestItem) : FileSink {
    override fun resumeFrom() = meta.totalChunks
    override fun hasReceived(chunkIndex: Int) = chunkIndex in 0 until meta.totalChunks
    override fun receivedCount() = meta.totalChunks
    override fun store(chunkIndex: Int, data: ByteArray) {}
    override fun markComplete() {}
    override fun finalizeIfReady(declaredSha256: String?, force: Boolean): FileFinalize? {
        require(declaredSha256 == receipt.sha256) { "Resumed source changed after verification" }
        return FileFinalize(receipt.savedPath, receipt.sha256, true)
    }
    override fun discard() {} // Never delete a previously published file on cancel.
    override fun lastError(): String? = null
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
    private val received = java.util.BitSet()
    private val pendingJournal = ArrayList<Int>()
    private var hasSnapshot = false
    private var complete = false
    private var error: String? = null
    private var raf: RandomAccessFile? = null
    private var finalized = false
    private var paused = false
    @Volatile private var discarded = false
    private var streamDigest: MessageDigest? = MessageDigest.getInstance("SHA-256")
    private var nextHashChunk = 0

    init {
        require(Regex("^[0-9a-f]{16}$").matches(transferId)) { "Invalid transfer ID" }
        require(meta.index in 0 until Limits.MAX_FILES_PER_TRANSFER && meta.size >= 0 &&
            meta.chunkSize in 1..Limits.MAX_CHUNK_SIZE && meta.totalChunks in 1..Limits.MAX_CHUNKS_PER_TRANSFER &&
            meta.size <= meta.chunkSize.toLong() * Limits.MAX_CHUNKS_PER_TRANSFER &&
            meta.totalChunks.toLong() == maxOf(1L, (meta.size + meta.chunkSize - 1) / meta.chunkSize))
        if (!stagingDir.isDirectory && !stagingDir.mkdirs()) throw IOException("Cannot create staging directory")
        if (sidecar.exists()) {
            try {
                val text = sidecar.readText(Charsets.UTF_8)
                val o = JsonValue.parseObject(text)
                require(o.optStr("name") == meta.name && o.optLong("size") == meta.size &&
                    o.optInt("chunkSize") == meta.chunkSize && o.optInt("totalChunks") == meta.totalChunks) {
                    "Receive manifest changed"
                }
                (o.optArr("received") ?: JsonValue.JsonArr()).items.forEach { v ->
                    val index = v.asInt()
                    if (index >= 0 && index < meta.totalChunks) received.set(index)
                }
                complete = o.optBool("complete") ?: false
                hasSnapshot = true
            } catch (_: Exception) {
                received.clear()
            }
        }
        if (hasSnapshot && partFile.exists() && partFile.length() == meta.size) {
            replayJournal()
        } else {
            received.clear()
            hasSnapshot = false
            journalFile.delete()
            sidecar.delete()
        }
        if (!received.isEmpty) streamDigest = null
        if (received.isEmpty && partFile.exists() && partFile.length() == 0L) {
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
                if (index >= 0 && index < meta.totalChunks) received.set(index)
                offset += JOURNAL_ENTRY_BYTES
            }
        } catch (_: Exception) {
            // The atomic sidecar is still a valid, slightly older checkpoint.
        }
    }

    @Synchronized
    override fun resumeFrom(): Int {
        return minOf(meta.totalChunks, received.nextClearBit(0))
    }

    @Synchronized
    override fun hasReceived(chunkIndex: Int): Boolean = received.get(chunkIndex)

    @Synchronized
    override fun receivedCount(): Int = received.cardinality()

    @Synchronized
    override fun store(chunkIndex: Int, data: ByteArray) {
        require(!finalized && !paused && !discarded && chunkIndex in 0 until meta.totalChunks) { "Invalid chunk index" }
        val expected = minOf(meta.chunkSize.toLong(), maxOf(0L, meta.size - chunkIndex * meta.chunkSize.toLong())).toInt()
        require(data.size == expected) { "Chunk length does not match manifest" }
        if (received.get(chunkIndex)) return
        try {
            val handle = raf ?: RandomAccessFile(partFile, "rw").also {
                // Size the part file once, not on every chunk.
                if (it.length() != meta.size) it.setLength(meta.size)
                raf = it
            }
            handle.seek(chunkIndex * meta.chunkSize.toLong())
            handle.write(data)
            if (chunkIndex == nextHashChunk) {
                streamDigest?.update(data)
                nextHashChunk++
            } else streamDigest = null
            received.set(chunkIndex)
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
            .put("name", meta.name).put("size", meta.size)
            .put("chunkSize", meta.chunkSize).put("totalChunks", meta.totalChunks)
            .put("received", JsonValue.JsonArr(received.stream().toArray().map { JsonValue.JsonLong(it.toLong()) }.toMutableList()))
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

    @Synchronized
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

    @Synchronized
    override fun finalizeIfReady(declaredSha256: String?, force: Boolean): FileFinalize? {
        if (finalized || discarded || paused) return null
        val allArrived = received.cardinality() >= meta.totalChunks
        if (!allArrived && !force) return null
        if (!allArrived && force) {
            error = error ?: "Transfer incomplete: some chunks never arrived."
            closeHandle()
            return null
        }
        if (declaredSha256 == null || !Regex("^[0-9a-f]{64}$").matches(declaredSha256)) {
            error = "Missing or invalid SHA-256 digest; file was not published."
            closeHandle()
            return null
        }
        try {
            flushJournal()
            closeHandle()
            val digest = if (streamDigest != null && nextHashChunk == meta.totalChunks) streamDigest!!
                else MessageDigest.getInstance("SHA-256").also { hash ->
                    FileInputStream(partFile).use { fis ->
                        val buf = ByteArray(256 * 1024)
                        while (true) {
                            val n = fis.read(buf)
                            if (n == -1) break
                            hash.update(buf, 0, n)
                        }
                    }
                }
            require(partFile.length() == meta.size) { "File length changed before publication" }
            val hex = digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            if (declaredSha256 != null && declaredSha256 != hex) {
                error = "SHA-256 verification failed; partial file discarded."
                discard()
                return null
            }
            if (discarded) return null
            val verified = true
            error = null
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

    @Synchronized
    override fun pause() {
        paused = true
        try { if (!finalized) flushJournal() } finally { closeHandle() }
    }

    override fun discard() {
        discarded = true
        synchronized(this) {
            closeHandle()
            if (!finalized) partFile.delete()
            sidecar.delete()
            journalFile.delete()
            received.clear()
            pendingJournal.clear()
        }
    }

    @Synchronized
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
