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
 * a sidecar manifest so an interrupted transfer resumes from disk, and
 * verifies SHA-256 on finalize.
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
    private val received = sortedSetOf<Int>()
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
                    received.add(v.asInt())
                }
                complete = o.optBool("complete") ?: false
            } catch (_: Exception) {
                received.clear()
            }
        }
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
            val handle = raf ?: RandomAccessFile(partFile, "rw").also { raf = it }
            handle.setLength(maxOf(handle.length(), meta.size))
            handle.seek(chunkIndex * meta.chunkSize.toLong())
            handle.write(data)
            received.add(chunkIndex)
            persistSidecar()
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
    }

    override fun markComplete() {
        complete = true
        try {
            persistSidecar()
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
        received.clear()
    }

    override fun lastError(): String? = error
}

/** Convenience factory staging into one directory with a final destination hook. */
class DirectoryFileSinkFactory(
    private val stagingDir: File,
    private val finisher: (partFile: File, name: String) -> File = { f, _ -> f },
) : FileSinkFactory {
    override fun open(transferId: String, meta: FileManifestItem): FileSink =
        DirectoryFileSink(stagingDir, meta, transferId, finisher)
}
