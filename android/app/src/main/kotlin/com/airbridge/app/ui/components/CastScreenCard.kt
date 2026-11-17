package com.airbridge.app.ui.components

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cast
import androidx.compose.material.icons.outlined.CastConnected
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.airbridge.app.NativeEngineHost
import com.airbridge.app.PeerUiState
import com.airbridge.app.Prefs
import com.airbridge.app.ScreenShareService

/**
 * "Cast to computer": one tap opens the screen on the paired computer, then
 * Android asks which screen/app to share. Sound comes along on Android 10+
 * when the app being shown allows capture. Hidden until a verified computer
 * that can show screens is connected and Screen sharing is on in Settings.
 */
@Composable
fun CastScreenCard(
    peers: List<PeerUiState>,
    castPeerIds: List<String>,
    selectedPeerId: String?,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val prefs = remember(context) { Prefs(context) }
    val activeSession by ScreenShareService.active.collectAsState()
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(activeSession) { message = null }
    if (!prefs.screenSharing) return
    val targets = peers.filter { it.peerId in castPeerIds }
    val target = targets.firstOrNull { it.peerId == selectedPeerId } ?: targets.firstOrNull()
    if (target == null && activeSession == null) return
    val withSound = prefs.screenSound && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q

    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (activeSession != null) Icons.Outlined.CastConnected else Icons.Outlined.Cast,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    text = if (activeSession != null) "Casting to your computer" else "Cast screen to ${target?.device?.name ?: "computer"}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
            }
            Text(
                text = message ?: if (activeSession != null) {
                    "Everything on screen is visible on the computer. Stop any time here or from the notification."
                } else {
                    "Show this screen on the computer — photos, apps, games${if (withSound) ", with sound" else ""}. " +
                        "Android asks what to share. Protected video (Netflix, Prime Video, Hotstar) appears black."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (activeSession != null) {
                OutlinedButton(onClick = {
                    runCatching {
                        context.startService(
                            Intent(context, ScreenShareService::class.java)
                                .setPackage(context.packageName)
                                .setAction(ScreenShareService.ACTION_STOP),
                        )
                    }
                    message = null
                }) { Text("Stop casting") }
            } else if (target != null) {
                Button(onClick = {
                    val result = NativeEngineHost.instance?.castScreen(target.peerId, withSound)
                    message = when {
                        result == null -> "AirBridge is still starting. Try again in a moment."
                        result.isSuccess -> "Opening on ${target.device.name}… confirm on this phone."
                        else -> result.exceptionOrNull()?.message ?: "Could not start casting."
                    }
                }) { Text("Cast to computer") }
            }
        }
    }
}
