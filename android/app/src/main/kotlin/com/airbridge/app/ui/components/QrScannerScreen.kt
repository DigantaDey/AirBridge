package com.airbridge.app.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.airbridge.app.QrScannerView

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

    BackHandler {
        latestOnClose()
    }

    DisposableEffect(Unit) {
        onDispose {
            scannerRef?.release()
            scannerRef = null
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                QrScannerView(context).apply {
                    this.onCode = { payload -> latestOnCode(payload) }
                    this.onClose = { latestOnClose() }
                    this.onCameraUnavailable = { latestUnavailable() }
                    scannerRef = this
                    start()
                }
            },
        )
    }
}
