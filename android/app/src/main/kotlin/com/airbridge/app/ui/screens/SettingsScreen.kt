package com.airbridge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessibilityNew
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.airbridge.app.ui.theme.AirBridgeColors
import com.airbridge.app.ui.viewmodels.AirBridgeAppUiState

@Composable
fun SettingsScreen(
    uiState: AirBridgeAppUiState,
    onRenameDevice: (String) -> Unit,
    onSetVisibility: (String) -> Unit,
    onSetThemeMode: (String) -> Unit,
    onSetAutoClipboard: (Boolean) -> Unit,
    onSetReceiveClipboard: (Boolean) -> Unit,
    onSetNotificationSharing: (Boolean) -> Unit = {},
    onSetConnectionContinuity: (Boolean) -> Unit,
    onSetAccessibilityOptIn: (Boolean) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onOpenNotificationListenerSettings: () -> Unit = {},
    onOpenAppSettings: () -> Unit,
    onOpenPairingSheet: () -> Unit,
    onForgetComputer: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var renameDialogOpen by rememberSaveable { mutableStateOf(false) }
    var forgetDialogOpen by rememberSaveable { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 760.dp)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsCard(title = "Device & Visibility") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = uiState.deviceName,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium,
                        )
                        if (uiState.engine.deviceId.isNotBlank()) {
                            Text(
                                text = "ID ${uiState.engine.deviceId.take(12)}",
                                style = MaterialTheme.typography.labelSmall,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    IconButton(onClick = { renameDialogOpen = true }) {
                        Icon(Icons.Outlined.Edit, contentDescription = "Rename device")
                    }
                }

                HorizontalDivider()

                Text(
                    text = "Who can see this device",
                    style = MaterialTheme.typography.labelLarge,
                )
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    FilterChip(
                        selected = uiState.visibility == "nearby",
                        onClick = { onSetVisibility("nearby") },
                        label = { Text("Everyone nearby") },
                    )
                    FilterChip(
                        selected = uiState.visibility == "paired-only",
                        onClick = { onSetVisibility("paired-only") },
                        label = { Text("Paired only") },
                    )
                }
            }

            SettingsCard(title = "Appearance") {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    listOf("dark" to "Dark", "system" to "System", "light" to "Light").forEach { (mode, label) ->
                        FilterChip(
                            selected = uiState.themeMode == mode,
                            onClick = { onSetThemeMode(mode) },
                            label = { Text(label) },
                        )
                    }
                }
            }

            SettingsCard(title = "Clipboard Sync") {
                SwitchRow(
                    title = "Auto-send clipboard updates",
                    subtitle = "Automatically beam new copies when allowed by Android",
                    checked = uiState.autoClipboard,
                    onCheckedChange = onSetAutoClipboard,
                )
                HorizontalDivider()
                SwitchRow(
                    title = "Receive clipboard from computer",
                    subtitle = "Update Android's clipboard when your computer copies text or images",
                    checked = uiState.receiveClipboard,
                    onCheckedChange = onSetReceiveClipboard,
                )
                HorizontalDivider()
                SwitchRow(
                    title = "Notification sharing",
                    subtitle = "Sync notifications bidirectionally between phone and computer",
                    checked = uiState.notificationSharing,
                    onCheckedChange = onSetNotificationSharing,
                )
                if (uiState.notificationSharing) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Notification Listener Access",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedButton(onClick = onOpenNotificationListenerSettings) {
                            Text("Open Settings")
                        }
                    }
                }
                HorizontalDivider()
                SwitchRow(
                    title = "Background clipboard bridge opt-in",
                    subtitle = "Use optional Accessibility service for copies from other apps",
                    checked = uiState.accessibilityOptIn,
                    onCheckedChange = onSetAccessibilityOptIn,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.AccessibilityNew,
                            contentDescription = null,
                            tint = if (uiState.accessibilityEnabled) {
                                AirBridgeColors.VerifiedGreen
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            text = if (uiState.accessibilityEnabled) {
                                "Accessibility service is active"
                            } else {
                                "Accessibility service is off in Android Settings"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = onOpenAccessibilitySettings) {
                        Text("Open Settings")
                    }
                }
            }

            SettingsCard(title = "Background & Performance") {
                SwitchRow(
                    title = "Keep connection active in background",
                    subtitle = "Hold a persistent foreground service so transfers continue seamlessly",
                    checked = uiState.connectionContinuity,
                    onCheckedChange = onSetConnectionContinuity,
                )
                HorizontalDivider()
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.BatteryChargingFull,
                            contentDescription = null,
                            tint = if (uiState.batteryExempt) {
                                AirBridgeColors.VerifiedGreen
                            } else {
                                AirBridgeColors.WarningAmber
                            },
                            modifier = Modifier.size(18.dp),
                        )
                        Column {
                            Text(
                                text = "Battery optimization",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                text = if (uiState.batteryExempt) {
                                    "Unrestricted (full Wi-Fi throughput in background)"
                                } else {
                                    "Optimized (OS may throttle background transfers)"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (uiState.batteryExempt) {
                        TextButton(onClick = onOpenAppSettings) {
                            Text("App Info")
                        }
                    } else {
                        TextButton(onClick = onRequestBatteryExemption) {
                            Text("Allow")
                        }
                    }
                }
            }

            SettingsCard(title = "Paired Computer") {
                if (uiState.configuredTarget.isNotBlank()) {
                    Text(
                        text = uiState.configuredTarget,
                        style = MaterialTheme.typography.bodyMedium,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                if (uiState.engine.lanUrls.isNotEmpty()) {
                    Text(
                        text = "LAN: ${uiState.engine.lanUrls.joinToString(", ")}",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    OutlinedButton(
                        onClick = onOpenPairingSheet,
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(Icons.Outlined.QrCode2, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Pair / Code")
                    }
                    OutlinedButton(
                        onClick = { forgetDialogOpen = true },
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(Icons.Outlined.LinkOff, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Forget")
                    }
                }
            }
        }
    }

    if (renameDialogOpen) {
        var draftName by rememberSaveable(uiState.deviceName) { mutableStateOf(uiState.deviceName) }
        AlertDialog(
            onDismissRequest = { renameDialogOpen = false },
            title = { Text("Rename device") },
            text = {
                OutlinedTextField(
                    value = draftName,
                    onValueChange = { draftName = it.take(80) },
                    label = { Text("Device name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onRenameDevice(draftName)
                        renameDialogOpen = false
                    },
                    enabled = draftName.isNotBlank(),
                ) {
                    Text("Save")
                }
            },
            dismissButton = {
                TextButton(onClick = { renameDialogOpen = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (forgetDialogOpen) {
        AlertDialog(
            onDismissRequest = { forgetDialogOpen = false },
            title = { Text("Forget paired computer?") },
            text = {
                Text("This stops the background service and clears the saved computer address. You can re-pair anytime via QR code.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        forgetDialogOpen = false
                        onForgetComputer()
                    },
                ) {
                    Text("Forget", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { forgetDialogOpen = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
private fun SettingsCard(
    title: String,
    content: @Composable () -> Unit,
) {
    ElevatedCard(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            content()
        }
    }
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
        )
    }
}
