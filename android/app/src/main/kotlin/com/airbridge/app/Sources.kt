package com.airbridge.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.airbridge.engine.FileSource

/** Sends a document chosen via ACTION_OPEN_DOCUMENT without copying it first. */
class ContentUriFileSource(
    private val context: Context,
    private val uri: Uri,
    override val name: String,
    override val size: Long,
    override val mimeType: String = "application/octet-stream",
) : FileSource {

    override fun readRange(start: Long, end: Long): ByteArray {
        val len = (end - start).toInt()
        val out = ByteArray(len)
        var filled = 0
        context.contentResolver.openInputStream(uri)?.use { ins ->
            var skipped = 0L
            while (skipped < start) {
                val n = ins.skip(start - skipped)
                if (n <= 0) break
                skipped += n
            }
            while (filled < len) {
                val n = ins.read(out, filled, len - filled)
                if (n == -1) break
                filled += n
            }
        } ?: return ByteArray(0)
        return if (filled == len) out else out.copyOf(filled)
    }

    companion object {
        fun resolve(context: Context, uri: Uri): ContentUriFileSource? {
            var name = uri.lastPathSegment ?: "file"
            var size = -1L
            context.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null, null, null,
            )?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
            if (size < 0) {
                // Fall back to a full streaming length probe.
                size = context.contentResolver.openInputStream(uri)?.use { it.available().toLong() } ?: 0L
            }
            if (size <= 0 && name.isEmpty()) return null
            return ContentUriFileSource(context, uri, name.ifEmpty { "file" }, size)
        }
    }
}
