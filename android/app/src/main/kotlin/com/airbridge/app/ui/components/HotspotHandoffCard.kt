package com.airbridge.app.ui.components

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.WifiTethering
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.airbridge.app.HandoffUiState
import com.airbridge.app.HotspotHandoff

/**
 * "Use this phone's hotspot": one tap starts a private hotspot and the paired
 * computer joins it by itself (after approval on the computer). Shown only
 * once a code-authenticated pairing provided the computer's handoff keys.
 */
@Composable
fun HotspotHandoffCard(
    state: HandoffUiState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!state.available && state.phase == HandoffUiState.Phase.IDLE) return
    val permissions = HotspotHandoff.requiredPermissionsFor(android.os.Build.VERSION.SDK_INT)
    // Start regardless of the result: the controller explains what's missing.
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onStart() }

    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.WifiTethering, contentDescription = null, modifier = Modifier.size(20.dp))
                Text(
                    text = if (state.phase == HandoffUiState.Phase.JOINED) "Direct link on this phone's hotspot" else "Use this phone's hotspot",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                if (state.phase == HandoffUiState.Phase.STARTING || state.phase == HandoffUiState.Phase.OFFERING || state.phase == HandoffUiState.Phase.WAITING) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                }
            }
            Text(
                text = state.message ?: "No shared Wi-Fi? The computer joins a private hotspot from this phone, handed over securely (sealed to the paired computer, sent over the connection or Bluetooth). You approve it on the computer.",
                style = MaterialTheme.typography.bodySmall,
                color = if (state.phase == HandoffUiState.Phase.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (state.active) {
                OutlinedButton(onClick = onStop) { Text("Stop hotspot") }
            } else {
                Button(onClick = { launcher.launch(permissions) }) {
                    Text(if (state.phase == HandoffUiState.Phase.FAILED) "Try again" else "Start hotspot")
                }
            }
        }
    }
}
