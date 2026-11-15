package com.airbridge.app.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun QrCodeCard(
    payload: String,
    contentDescription: String,
    modifier: Modifier = Modifier,
    size: Dp = 200.dp,
) {
    var qrBitmap by remember(payload) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(payload) {
        qrBitmap = if (payload.isBlank()) {
            null
        } else {
            withContext(Dispatchers.Default) {
                runCatching { encodeQrBitmap(payload, 512) }.getOrNull()
            }
        }
    }

    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        color = Color.White,
        tonalElevation = 0.dp,
        shadowElevation = 2.dp,
    ) {
        Box(
            modifier = Modifier
                .size(size)
                .background(Color.White)
                .padding(12.dp),
            contentAlignment = Alignment.Center,
        ) {
            val bmp = qrBitmap
            if (bmp != null) {
                Image(
                    bitmap = bmp,
                    contentDescription = contentDescription,
                    filterQuality = FilterQuality.None,
                    modifier = Modifier.size(size - 24.dp),
                )
            } else {
                CircularProgressIndicator(
                    modifier = Modifier.size(28.dp),
                    color = Color(0xFF111111),
                    strokeWidth = 2.dp,
                )
            }
        }
    }
}

private fun encodeQrBitmap(content: String, px: Int): ImageBitmap {
    val hints = mapOf(EncodeHintType.MARGIN to 1)
    val matrix = MultiFormatWriter().encode(content, BarcodeFormat.QR_CODE, px, px, hints)
    val w = matrix.width
    val h = matrix.height
    val pixels = IntArray(w * h)
    val black = 0xFF111113.toInt()
    val white = 0xFFFFFFFF.toInt()
    for (y in 0 until h) {
        val offset = y * w
        for (x in 0 until w) {
            pixels[offset + x] = if (matrix.get(x, y)) black else white
        }
    }
    return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply {
        setPixels(pixels, 0, w, 0, 0, w, h)
    }.asImageBitmap()
}
