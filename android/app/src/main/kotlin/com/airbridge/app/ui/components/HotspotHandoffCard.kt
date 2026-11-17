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
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.airbridge.app.HandoffUiState
import com.airbridge.app.HotspotHandoff
import com.airbridge.app.HotspotHandoffGuidance
import com.airbridge.engine.Handoff

/**
 * One-tap private hotspot handoff. A compatible Mac joins automatically over
 * AirBridge's authenticated BLE service; users never pair Bluetooth devices or
 * match Bluetooth names. Explicitly revealed Wi-Fi credentials are the fallback.
 */
@Composable
fun HotspotHandoffCard(
    state: HandoffUiState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!state.available && state.phase == HandoffUiState.Phase.IDLE) return
    var showNetworkDetails by remember(state.manualHotspot?.ssid) { mutableStateOf(false) }
    val permissions = HotspotHandoff.requiredPermissionsFor(android.os.Build.VERSION.SDK_INT)
    // Start regardless of the result: the controller separately checks Wi-Fi
    // permissions and treats Bluetooth permission as an optional convenience.
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
                text = state.message ?: "No shared Wi-Fi? AirBridge creates a temporary password-protected hotspot. The paired computer can join automatically over a live secure session, or a compatible Mac can receive the sealed credentials through AirBridge's private Bluetooth service. No manual Bluetooth pairing or device-name matching is needed; reveal Wi-Fi details only as a fallback.",
                style = MaterialTheme.typography.bodySmall,
                color = if (state.phase == HandoffUiState.Phase.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )

            val network = state.manualHotspot
            if (network != null && state.phase != HandoffUiState.Phase.JOINED) {
                OutlinedButton(onClick = { showNetworkDetails = !showNetworkDetails }) {
                    Text(if (showNetworkDetails) "Hide Wi-Fi details" else "Show Wi-Fi details")
                }
                if (showNetworkDetails) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Wi-Fi network (SSID)", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                        SelectionContainer {
                            Text(network.ssid, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                        }
                        Text("Password · ${securityLabel(network.security)}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                        SelectionContainer {
                            Text(network.password, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                        }
                        Text(
                            HotspotHandoffGuidance.manualConnectionSteps(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "AirBridge seals credentials to the paired computer for automatic handoff. They are shown here only while the temporary hotspot is active; share them manually only with a computer you trust, then stop the hotspot when finished.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

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

private fun securityLabel(security: Handoff.Security): String = when (security) {
    Handoff.Security.WPA2 -> "WPA2"
    Handoff.Security.WPA3 -> "WPA3"
    Handoff.Security.WPA2_WPA3 -> "WPA2/WPA3"
}
