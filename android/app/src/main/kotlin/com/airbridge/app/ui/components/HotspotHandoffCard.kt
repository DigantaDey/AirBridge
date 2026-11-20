package com.airbridge.app.ui.components

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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
    val context = LocalContext.current
    val activity = context as? Activity
    var showNetworkDetails by rememberSaveable(state.manualHotspot?.ssid) { mutableStateOf(false) }
    var showRationaleDialog by rememberSaveable { mutableStateOf(false) }
    var showSettingsDialog by rememberSaveable { mutableStateOf(false) }

    val sdkInt = Build.VERSION.SDK_INT
    val requiredHotspotPerms = HotspotHandoff.requiredHotspotPermissionsFor(sdkInt)
    val allPermissions = HotspotHandoff.requiredPermissionsFor(sdkInt)

    // Start if required Wi-Fi hotspot permissions are granted; Bluetooth permission is optional.
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val hotspotGranted = requiredHotspotPerms.all { perm ->
            results[perm] == true ||
                ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
        }
        if (hotspotGranted) {
            onStart()
        } else {
            val permanentlyDenied = activity != null && requiredHotspotPerms.any { perm ->
                ContextCompat.checkSelfPermission(context, perm) != PackageManager.PERMISSION_GRANTED &&
                    !ActivityCompat.shouldShowRequestPermissionRationale(activity, perm)
            }
            if (permanentlyDenied) {
                showSettingsDialog = true
            } else {
                onStart()
            }
        }
    }

    fun requestHotspotWithThreeStateFlow() {
        val missingHotspot = requiredHotspotPerms.filter { perm ->
            ContextCompat.checkSelfPermission(context, perm) != PackageManager.PERMISSION_GRANTED
        }
        val missingAll = allPermissions.filter { perm ->
            ContextCompat.checkSelfPermission(context, perm) != PackageManager.PERMISSION_GRANTED
        }
        when {
            missingHotspot.isEmpty() && missingAll.isEmpty() -> {
                onStart()
            }
            activity != null && missingHotspot.any { ActivityCompat.shouldShowRequestPermissionRationale(activity, it) } -> {
                showRationaleDialog = true
            }
            else -> {
                launcher.launch(allPermissions)
            }
        }
    }

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
                Button(onClick = ::requestHotspotWithThreeStateFlow) {
                    Text(if (state.phase == HandoffUiState.Phase.FAILED) "Try again" else "Start hotspot")
                }
            }
        }
    }

    if (showRationaleDialog) {
        AlertDialog(
            onDismissRequest = { showRationaleDialog = false },
            title = { Text("Nearby Wi-Fi permission for hotspot") },
            text = {
                Text(
                    "AirBridge needs Nearby Wi-Fi permission to start a temporary local-only hotspot for your paired computer. Optional Bluetooth access lets a compatible Mac join automatically without typing the Wi-Fi password.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showRationaleDialog = false
                        launcher.launch(allPermissions)
                    },
                ) {
                    Text("Continue")
                }
            },
            dismissButton = {
                TextButton(onClick = { showRationaleDialog = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showSettingsDialog) {
        AlertDialog(
            onDismissRequest = { showSettingsDialog = false },
            title = { Text("Nearby Wi-Fi permission required") },
            text = {
                Text(
                    "Nearby Wi-Fi permission is currently disabled for AirBridge. Open Android Settings to allow Nearby devices so AirBridge can create a temporary hotspot.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showSettingsDialog = false
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.fromParts("package", context.packageName, null)
                        }
                        runCatching { context.startActivity(intent) }
                    },
                ) {
                    Text("Open Settings")
                }
            },
            dismissButton = {
                TextButton(onClick = { showSettingsDialog = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}

private fun securityLabel(security: Handoff.Security): String = when (security) {
    Handoff.Security.WPA2 -> "WPA2"
    Handoff.Security.WPA3 -> "WPA3"
    Handoff.Security.WPA2_WPA3 -> "WPA2/WPA3"
}
