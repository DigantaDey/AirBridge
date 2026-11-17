package com.airbridge.app.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.OpenInNew
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.airbridge.app.ContinuityPermissions
import com.airbridge.app.NativeEngineHost
import com.airbridge.app.Prefs
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
    onSetConnectionContinuity: (Boolean) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onOpenPairingSheet: () -> Unit,
    onForgetComputer: () -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
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
            modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SettingsCard(title = "Device & visibility") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(uiState.deviceName, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
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
                Text("Who can see this device", style = MaterialTheme.typography.labelLarge)
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf("dark" to "Dark", "system" to "System", "light" to "Light").forEach { (mode, label) ->
                        FilterChip(
                            selected = uiState.themeMode == mode,
                            onClick = { onSetThemeMode(mode) },
                            label = { Text(label) },
                        )
                    }
                }
            }

            SettingsCard(title = "Clipboard sync") {
                SwitchRow(
                    title = "Auto-send clipboard updates",
                    subtitle = "Send new copies when Android allows access",
                    checked = uiState.autoClipboard,
                    onCheckedChange = onSetAutoClipboard,
                )
                HorizontalDivider()
                SwitchRow(
                    title = "Receive clipboard from computer",
                    subtitle = "Update Android's clipboard when your paired computer copies text or images",
                    checked = uiState.receiveClipboard,
                    onCheckedChange = onSetReceiveClipboard,
                )
                Text(
                    text = "Android may block hidden clipboard reads. To send from another app reliably, choose Share or Process text → AirBridge, use the Quick Settings tile, or tap Paste in the Clipboard tab.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            PhoneContinuityCard()

            SettingsCard(title = "Privacy & safety") {
                Text(
                    text = "AirBridge has no account, ads, analytics, Accessibility Service, or notification listener. Files, clipboard items, contacts and screen frames are sent only to the paired device you select.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "Screen sharing requires approval every time. App audio is off by default and, if enabled for a session, only Android-permitted playback audio is sent. Protected or opted-out content is not shared.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = onOpenPrivacyPolicy) {
                    Text("Read privacy policy")
                    Spacer(Modifier.width(6.dp))
                    Icon(Icons.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                }
            }

            SettingsCard(title = "Background & performance") {
                SwitchRow(
                    title = "Keep connection active in background",
                    subtitle = "Keep the foreground connection service ready for transfers and incoming clipboard",
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
                            tint = if (uiState.batteryExempt) AirBridgeColors.VerifiedGreen else AirBridgeColors.WarningAmber,
                            modifier = Modifier.size(18.dp),
                        )
                        Column {
                            Text("Battery optimization", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                            Text(
                                if (uiState.batteryExempt) "Unrestricted (better background reliability)" else "Optimized (the OS may pause background work)",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    TextButton(onClick = if (uiState.batteryExempt) onOpenAppSettings else onRequestBatteryExemption) {
                        Text(if (uiState.batteryExempt) "App info" else "Allow")
                    }
                }
            }

            SettingsCard(title = "Paired computer") {
                if (uiState.configuredTarget.isNotBlank()) {
                    Text(uiState.configuredTarget, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                }
                if (uiState.engine.lanUrls.isNotEmpty()) {
                    Text(
                        text = "LAN: ${uiState.engine.lanUrls.joinToString(", ")}",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = onOpenPairingSheet, modifier = Modifier.weight(1f)) {
                        Icon(Icons.Outlined.QrCode2, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Pair / code")
                    }
                    OutlinedButton(
                        onClick = { forgetDialogOpen = true },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(Icons.Outlined.LinkOff, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
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
                TextButton(onClick = { onRenameDevice(draftName); renameDialogOpen = false }, enabled = draftName.isNotBlank()) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renameDialogOpen = false }) { Text("Cancel") } },
        )
    }

    if (forgetDialogOpen) {
        AlertDialog(
            onDismissRequest = { forgetDialogOpen = false },
            title = { Text("Forget paired computer?") },
            text = { Text("This stops the background connection and clears the saved computer address. You can pair again by QR code.") },
            confirmButton = {
                TextButton(onClick = { forgetDialogOpen = false; onForgetComputer() }) {
                    Text("Forget", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { forgetDialogOpen = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable () -> Unit) {
    ElevatedCard(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

/** Each optional phone feature asks for the smallest matching Android permission. */
@Composable
private fun PhoneContinuityCard() {
    val context = LocalContext.current
    val prefs = remember(context) { Prefs(context) }
    var tick by remember { mutableIntStateOf(0) }
    fun changed() {
        tick++
        NativeEngineHost.instance?.refreshContinuity()
    }
    val contactsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { changed() }
    val callsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { changed() }
    @Suppress("UNUSED_VARIABLE") val observe = tick
    val contactsGranted = ContinuityPermissions.contactsGranted(context)
    val callsGranted = ContinuityPermissions.callsGranted(context)
    val telephony = ContinuityPermissions.hasTelephony(context)

    SettingsCard(title = "Phone on your computer") {
        SwitchRow(
            title = "Contacts",
            subtitle = when {
                !prefs.contactsOnComputer -> "Browse and search contacts from this paired computer"
                contactsGranted -> "Your paired computer can search contacts while connected"
                else -> "Needs contacts permission — tap the switch to allow"
            },
            checked = prefs.contactsOnComputer && contactsGranted,
            onCheckedChange = { on ->
                prefs.contactsOnComputer = on
                if (on && !contactsGranted) contactsLauncher.launch(ContinuityPermissions.CONTACTS)
                changed()
            },
        )
        HorizontalDivider()
        SwitchRow(
            title = "Calls",
            subtitle = when {
                !telephony -> "This device has no phone service"
                !prefs.callsFromComputer -> "Answer, decline and place calls from the paired computer"
                !callsGranted -> "Needs phone permission — tap the switch to allow"
                else -> "On. Call audio always stays on the phone or its headset"
            },
            checked = telephony && prefs.callsFromComputer && callsGranted,
            onCheckedChange = { on ->
                prefs.callsFromComputer = on
                if (on && telephony && !callsGranted) callsLauncher.launch(ContinuityPermissions.CALLS)
                changed()
            },
        )
        HorizontalDivider()
        SwitchRow(
            title = "Screen sharing",
            subtitle = "Let the paired computer request a screen share. You approve every session; app audio is optional and off by default.",
            checked = prefs.screenSharing,
            onCheckedChange = { on -> prefs.screenSharing = on; changed() },
        )
    }
}
