package com.airbridge.app.ui.components

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.airbridge.app.AndroidDiagnostics
import com.airbridge.app.ui.formatTimestamp
import com.airbridge.engine.ClipboardItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Thread-safe bounded LRU cache for decoded clipboard thumbnail bitmaps.
 *
 * Implemented with pure JVM `LinkedHashMap(accessOrder = true)` so both
 * runtime Compose scrolling and JVM unit tests verify LRU eviction deterministically.
 */
class ThumbnailLruCache<K : Any, V : Any>(
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
) {
    init {
        require(maxEntries >= 1) { "maxEntries must be >= 1" }
    }

    private val map = object : LinkedHashMap<K, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean =
            size > maxEntries
    }

    @Synchronized
    fun get(key: K): V? = map[key]

    @Synchronized
    fun put(key: K, value: V) {
        map[key] = value
    }

    @Synchronized
    fun size(): Int = map.size

    @Synchronized
    fun clear() = map.clear()

    companion object {
        const val DEFAULT_MAX_ENTRIES = 24
    }
}

private val clipboardThumbnailCache = ThumbnailLruCache<String, ImageBitmap>(maxEntries = 24)

@Composable
fun ClipboardItemCard(
    item: ClipboardItem,
    onCopy: (ClipboardItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val incoming = item.direction == "incoming"
    val dataUrl = item.imageDataUrl
    val cacheKey = remember(item.beamId, dataUrl) {
        if (dataUrl == null) null else "${item.beamId}:${dataUrl.length}:${dataUrl.hashCode()}"
    }
    var previewBitmap by remember(cacheKey) {
        mutableStateOf(cacheKey?.let { clipboardThumbnailCache.get(it) })
    }
    LaunchedEffect(cacheKey, dataUrl) {
        if (dataUrl == null || cacheKey == null) {
            previewBitmap = null
        } else {
            val cached = clipboardThumbnailCache.get(cacheKey)
            if (cached != null) {
                AndroidDiagnostics.recordBitmapCacheHit()
                previewBitmap = cached
            } else {
                AndroidDiagnostics.recordBitmapCacheMiss()
                val decoded = withContext(Dispatchers.Default) {
                    decodeThumbnailBitmap(dataUrl, maxDim = 900)
                }
                if (decoded != null) {
                    clipboardThumbnailCache.put(cacheKey, decoded)
                }
                previewBitmap = decoded
            }
        }
    }

    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.elevatedCardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(
                        imageVector = if (incoming) Icons.Outlined.ArrowDownward else Icons.Outlined.ArrowUpward,
                        contentDescription = if (incoming) "Received clipboard" else "Sent clipboard",
                        tint = if (incoming) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = if (incoming) "From ${item.peerName}" else "To ${item.peerName}",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (item.sasCode.isNotBlank()) {
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = item.sasCode,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = formatTimestamp(item.timestamp),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    IconButton(onClick = { onCopy(item) }) {
                        Icon(
                            imageVector = Icons.Outlined.ContentCopy,
                            contentDescription = "Copy to clipboard",
                        )
                    }
                }
            }

            if (previewBitmap != null) {
                Image(
                    bitmap = previewBitmap!!,
                    contentDescription = item.imageName ?: "Clipboard image",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 220.dp)
                        .clip(RoundedCornerShape(10.dp)),
                )
            } else if (item.imageDataUrl != null) {
                Text(
                    text = item.imageName ?: "Image clipboard beam",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    text = item.text,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun decodeThumbnailBitmap(dataUrl: String, maxDim: Int): ImageBitmap? {
    val comma = dataUrl.indexOf(',')
    if (comma <= 0) return null
    val raw = runCatching { Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT) }.getOrNull()
        ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) {
        sample *= 2
    }
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(raw, 0, raw.size, opts)?.asImageBitmap()
}
