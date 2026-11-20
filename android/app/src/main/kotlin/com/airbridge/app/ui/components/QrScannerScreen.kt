package com.airbridge.app.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.airbridge.app.QrScannerView
import com.airbridge.app.SystemBarInsets

@Composable
fun QrScannerScreen(
    onCodeScanned: (String) -> Unit,
    onClose: () -> Unit,
    onCameraUnavailable: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val latestOnCode by rememberUpdatedState(onCodeScanned)
    val latestOnClose by rememberUpdatedState(onClose)
    val latestUnavailable by rememberUpdatedState(onCameraUnavailable)
    var scannerRef by remember { mutableStateOf<QrScannerView?>(null) }
    val lifecycleOwner = LocalLifecycleOwner.current
    val density = LocalDensity.current
    val layoutDirection = LocalLayoutDirection.current
    val safeDrawing = WindowInsets.safeDrawing
    val chromeInsets = SystemBarInsets(
        left = safeDrawing.getLeft(density, layoutDirection),
        top = safeDrawing.getTop(density),
        right = safeDrawing.getRight(density, layoutDirection),
        bottom = safeDrawing.getBottom(density),
    )

    BackHandler {
        latestOnClose()
    }

    LaunchedEffect(scannerRef, chromeInsets) {
        scannerRef?.applyChromeInsets(chromeInsets)
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> scannerRef?.resume()
                Lifecycle.Event.ON_PAUSE -> scannerRef?.pause()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            scannerRef?.release()
            scannerRef = null
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                QrScannerView(context).apply {
                    this.onCode = { payload -> latestOnCode(payload) }
                    this.onClose = { latestOnClose() }
                    this.onCameraUnavailable = { latestUnavailable() }
                    applyChromeInsets(chromeInsets)
                    scannerRef = this
                    start()
                }
            },
            update = { view ->
                view.applyChromeInsets(chromeInsets)
            },
        )
    }
}
