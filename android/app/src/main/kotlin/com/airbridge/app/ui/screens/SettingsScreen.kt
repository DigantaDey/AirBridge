package com.airbridge.app.ui.screens

import android.app.Activity
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Share
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
import com.airbridge.app.BuildConfig
import com.airbridge.app.ContinuityPermissions
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
    contentPadding: PaddingValues = PaddingValues(0.dp),
    onSetContactsOnComputer: (Boolean) -> Unit = {},
    onSetCallsFromComputer: (Boolean) -> Unit = {},
    onSetScreenSharing: (Boolean) -> Unit = {},
    onCopyDiagnostics: () -> Unit = {},
    onShareDiagnostics: () -> Unit = {},
    onOpenWebsite: () -> Unit = {},
    onOpenGitHub: () -> Unit = {},
) {
    var renameDialogOpen by rememberSaveable { mutableStateOf(false) }
    var forgetDialogOpen by rememberSaveable { mutableStateOf(false) }

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val isWide = maxWidth >= 840.dp
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(contentPadding)
                .padding(horizontal = if (isWide) 24.dp else 16.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (isWide) {
                Row(
                    modifier = Modifier.widthIn(max = 1120.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        DeviceVisibilityCard(
                            uiState = uiState,
                            onOpenRename = { renameDialogOpen = true },
                            onSetVisibility = onSetVisibility,
                        )
                        AppearanceCard(uiState = uiState, onSetThemeMode = onSetThemeMode)
                        ClipboardSyncCard(
                            uiState = uiState,
                            onSetAutoClipboard = onSetAutoClipboard,
                            onSetReceiveClipboard = onSetReceiveClipboard,
                        )
                        PhoneContinuityCard(
                            uiState = uiState,
                            onSetContactsOnComputer = onSetContactsOnComputer,
                            onSetCallsFromComputer = onSetCallsFromComputer,
                            onSetScreenSharing = onSetScreenSharing,
                            onOpenAppSettings = onOpenAppSettings,
                        )
                    }
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        BackgroundPerformanceCard(
                            uiState = uiState,
                            onSetConnectionContinuity = onSetConnectionContinuity,
                            onRequestBatteryExemption = onRequestBatteryExemption,
                            onOpenAppSettings = onOpenAppSettings,
                        )
                        PairedComputerCard(
                            uiState = uiState,
                            onOpenPairingSheet = onOpenPairingSheet,
                            onOpenForget = { forgetDialogOpen = true },
                        )
                        DiagnosticsSettingsCard(
                            uiState = uiState,
                            onCopyDiagnostics = onCopyDiagnostics,
                            onShareDiagnostics = onShareDiagnostics,
                            onOpenAppSettings = onOpenAppSettings,
                        )
                        PrivacySafetyCard(onOpenPrivacyPolicy = onOpenPrivacyPolicy)
                        AboutAirBridgeCard(
                            onOpenWebsite = onOpenWebsite,
                            onOpenGitHub = onOpenGitHub,
                            onOpenPrivacyPolicy = onOpenPrivacyPolicy,
                        )
                    }
                }
            } else {
                Column(
                    modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    DeviceVisibilityCard(
                        uiState = uiState,
                        onOpenRename = { renameDialogOpen = true },
                        onSetVisibility = onSetVisibility,
                    )
                    AppearanceCard(uiState = uiState, onSetThemeMode = onSetThemeMode)
                    ClipboardSyncCard(
                        uiState = uiState,
                        onSetAutoClipboard = onSetAutoClipboard,
                        onSetReceiveClipboard = onSetReceiveClipboard,
                    )
                    PhoneContinuityCard(
                        uiState = uiState,
                        onSetContactsOnComputer = onSetContactsOnComputer,
                        onSetCallsFromComputer = onSetCallsFromComputer,
                        onSetScreenSharing = onSetScreenSharing,
                        onOpenAppSettings = onOpenAppSettings,
                    )
                    PrivacySafetyCard(onOpenPrivacyPolicy = onOpenPrivacyPolicy)
                    BackgroundPerformanceCard(
                        uiState = uiState,
                        onSetConnectionContinuity = onSetConnectionContinuity,
                        onRequestBatteryExemption = onRequestBatteryExemption,
                        onOpenAppSettings = onOpenAppSettings,
                    )
                    PairedComputerCard(
                        uiState = uiState,
                        onOpenPairingSheet = onOpenPairingSheet,
                        onOpenForget = { forgetDialogOpen = true },
                    )
                    DiagnosticsSettingsCard(
                        uiState = uiState,
                        onCopyDiagnostics = onCopyDiagnostics,
                        onShareDiagnostics = onShareDiagnostics,
                        onOpenAppSettings = onOpenAppSettings,
                    )
                    AboutAirBridgeCard(
                        onOpenWebsite = onOpenWebsite,
                        onOpenGitHub = onOpenGitHub,
                        onOpenPrivacyPolicy = onOpenPrivacyPolicy,
                    )
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
                TextButton(onClick = { renameDialogOpen = false }) { Text("Cancel") }
            },
        )
    }

    if (forgetDialogOpen) {
        AlertDialog(
            onDismissRequest = { forgetDialogOpen = false },
            title = { Text("Forget paired computer?") },
            text = {
                Text("This stops the background connection and clears the saved computer address. You can pair again by QR code.")
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
                TextButton(onClick = { forgetDialogOpen = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun DeviceVisibilityCard(
    uiState: AirBridgeAppUiState,
    onOpenRename: () -> Unit,
    onSetVisibility: (String) -> Unit,
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
            IconButton(onClick = onOpenRename) {
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
}

@Composable
private fun AppearanceCard(
    uiState: AirBridgeAppUiState,
    onSetThemeMode: (String) -> Unit,
) {
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
}

@Composable
private fun ClipboardSyncCard(
    uiState: AirBridgeAppUiState,
    onSetAutoClipboard: (Boolean) -> Unit,
    onSetReceiveClipboard: (Boolean) -> Unit,
) {
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
}

@Composable
private fun PrivacySafetyCard(onOpenPrivacyPolicy: () -> Unit) {
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
            Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun AboutAirBridgeCard(
    onOpenWebsite: () -> Unit,
    onOpenGitHub: () -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
) {
    SettingsCard(title = "About AirBridge") {
        Text(
            text = "Version ${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            text = "Private, end-to-end encrypted multi-GB file transfers, bidirectional text & photo clipboard sync, persistent contacts, two-way Mac call audio bridge, and H.264 screen sharing between Android and your computer.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "Created by Diganta Dey · Local-first, zero cloud accounts · ECDH P-256 + AES-256-GCM",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(onClick = onOpenWebsite) {
                Text("Website")
                Spacer(Modifier.width(4.dp))
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(15.dp))
            }
            TextButton(onClick = onOpenGitHub) {
                Text("GitHub")
                Spacer(Modifier.width(4.dp))
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(15.dp))
            }
            TextButton(onClick = onOpenPrivacyPolicy) {
                Text("Privacy policy")
                Spacer(Modifier.width(4.dp))
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(15.dp))
            }
        }
    }
}

@Composable
private fun BackgroundPerformanceCard(
    uiState: AirBridgeAppUiState,
    onSetConnectionContinuity: (Boolean) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
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
        if (!uiState.localNetworkPermissionGranted) {
            HorizontalDivider()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Local network access blocked",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Text(
                        text = "Android blocked local network access for AirBridge. Allow Local Network in App Settings so your phone can reach your computer over Wi-Fi.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onOpenAppSettings) {
                    Text("Open Settings")
                }
            }
        }
    }
}

@Composable
private fun PairedComputerCard(
    uiState: AirBridgeAppUiState,
    onOpenPairingSheet: () -> Unit,
    onOpenForget: () -> Unit,
) {
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
                onClick = onOpenForget,
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

@Composable
private fun DiagnosticsSettingsCard(
    uiState: AirBridgeAppUiState,
    onCopyDiagnostics: () -> Unit,
    onShareDiagnostics: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    SettingsCard(title = "Diagnostics & error report") {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Outlined.BugReport,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = "Export a redacted diagnostic snapshot (connection attempts, TLS pin status, NSD discovery, FGS & power locks, permissions, and recent logs). Pairing codes, Wi-Fi passwords, tokens, and keys are automatically scrubbed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (!uiState.localNetworkPermissionGranted) {
            TextButton(onClick = onOpenAppSettings) {
                Text("Allow Local Network permission in Settings")
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            OutlinedButton(
                onClick = onCopyDiagnostics,
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Outlined.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Copy diagnostics")
            }
            OutlinedButton(
                onClick = onShareDiagnostics,
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Outlined.Share, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Share report")
            }
        }
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

/**
 * Each optional phone feature asks for the smallest matching Android permission
 * using the full 3-state permission workflow (granted -> rationale dialog ->
 * system contract -> Settings redirect on permanent denial) and reads live
 * ViewModel state refreshed in `MainActivity.onResume()`.
 */
@Composable
private fun PhoneContinuityCard(
    uiState: AirBridgeAppUiState,
    onSetContactsOnComputer: (Boolean) -> Unit,
    onSetCallsFromComputer: (Boolean) -> Unit,
    onSetScreenSharing: (Boolean) -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    val context = LocalContext.current
    val activity = context as? Activity
    var showContactsRationale by rememberSaveable { mutableStateOf(false) }
    var showContactsSettings by rememberSaveable { mutableStateOf(false) }
    var showCallsRationale by rememberSaveable { mutableStateOf(false) }
    var showCallsSettings by rememberSaveable { mutableStateOf(false) }
    var showCallAudioRationale by rememberSaveable { mutableStateOf(false) }
    var showCallAudioSettings by rememberSaveable { mutableStateOf(false) }

    val contactsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val granted = ContinuityPermissions.CONTACTS.all { perm ->
            results[perm] == true ||
                ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
        }
        onSetContactsOnComputer(granted)
        if (!granted && activity != null) {
            val permanentlyDenied = ContinuityPermissions.CONTACTS.any { perm ->
                ContextCompat.checkSelfPermission(context, perm) != PackageManager.PERMISSION_GRANTED &&
                    !ActivityCompat.shouldShowRequestPermissionRationale(activity, perm)
            }
            if (permanentlyDenied) {
                showContactsSettings = true
            }
        }
    }

    val callsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val granted = ContinuityPermissions.CALLS.all { perm ->
            results[perm] == true ||
                ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
        }
        onSetCallsFromComputer(granted)
        if (!granted && activity != null) {
            val permanentlyDenied = ContinuityPermissions.CALLS.any { perm ->
                ContextCompat.checkSelfPermission(context, perm) != PackageManager.PERMISSION_GRANTED &&
                    !ActivityCompat.shouldShowRequestPermissionRationale(activity, perm)
            }
            if (permanentlyDenied) {
                showCallsSettings = true
            }
        }
    }

    val callAudioMicLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val micGranted = granted || ContinuityPermissions.callAudioGranted(context)
        if (micGranted) {
            onSetCallsFromComputer(true)
        } else if (activity != null &&
            !ActivityCompat.shouldShowRequestPermissionRationale(activity, ContinuityPermissions.CALL_AUDIO)
        ) {
            showCallAudioSettings = true
        }
    }

    val contactsGranted = uiState.contactsPermissionGranted
    val callsGranted = uiState.callsPermissionGranted
    val callAudioGranted = uiState.callAudioPermissionGranted
    val telephony = uiState.hasTelephony

    SettingsCard(title = "Phone on your computer") {
        SwitchRow(
            title = "Contacts",
            subtitle = when {
                !uiState.contactsOnComputer -> "Browse and search contacts from this paired computer"
                contactsGranted -> "Your paired computer can search contacts while connected"
                else -> "Needs contacts permission — tap the switch to allow"
            },
            checked = uiState.contactsOnComputer && contactsGranted,
            onCheckedChange = { on ->
                if (!on) {
                    onSetContactsOnComputer(false)
                } else if (contactsGranted) {
                    onSetContactsOnComputer(true)
                } else if (activity != null && ContinuityPermissions.CONTACTS.any {
                        ActivityCompat.shouldShowRequestPermissionRationale(activity, it)
                    }
                ) {
                    showContactsRationale = true
                } else {
                    onSetContactsOnComputer(true)
                    contactsLauncher.launch(ContinuityPermissions.CONTACTS)
                }
            },
        )
        HorizontalDivider()
        SwitchRow(
            title = "Calls",
            subtitle = when {
                !telephony -> "This device has no phone service"
                !uiState.callsFromComputer -> "Answer, decline and place calls from the paired computer"
                !callsGranted -> "Needs phone permission — tap the switch to allow"
                callAudioGranted -> "On. Answer, place calls, and route two-way call audio to your paired computer"
                else -> "On. Call controls active — allow microphone below to speak and hear calls on your computer"
            },
            checked = telephony && uiState.callsFromComputer && callsGranted,
            onCheckedChange = { on ->
                if (!on || !telephony) {
                    onSetCallsFromComputer(false)
                } else if (callsGranted) {
                    onSetCallsFromComputer(true)
                } else if (activity != null && ContinuityPermissions.CALLS.any {
                        ActivityCompat.shouldShowRequestPermissionRationale(activity, it)
                    }
                ) {
                    showCallsRationale = true
                } else {
                    onSetCallsFromComputer(true)
                    callsLauncher.launch(ContinuityPermissions.CALLS)
                }
            },
        )
        if (telephony && uiState.callsFromComputer && callsGranted && !callAudioGranted) {
            OutlinedButton(
                onClick = {
                    if (activity != null &&
                        ActivityCompat.shouldShowRequestPermissionRationale(activity, ContinuityPermissions.CALL_AUDIO)
                    ) {
                        showCallAudioRationale = true
                    } else {
                        callAudioMicLauncher.launch(ContinuityPermissions.CALL_AUDIO)
                    }
                },
                shape = RoundedCornerShape(10.dp),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                modifier = Modifier.padding(bottom = 8.dp),
            ) {
                Text("Allow microphone for Mac call audio")
            }
        }
        HorizontalDivider()
        SwitchRow(
            title = "Screen sharing",
            subtitle = "Let the paired computer request a screen share. You approve every session; app audio is optional and off by default.",
            checked = uiState.screenSharing,
            onCheckedChange = onSetScreenSharing,
        )
    }

    if (showContactsRationale) {
        AlertDialog(
            onDismissRequest = { showContactsRationale = false },
            title = { Text("Contacts access for your computer") },
            text = {
                Text(
                    "AirBridge uses Contacts permission only when your paired computer searches or views your phone contacts over an end-to-end encrypted session.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showContactsRationale = false
                        onSetContactsOnComputer(true)
                        contactsLauncher.launch(ContinuityPermissions.CONTACTS)
                    },
                ) {
                    Text("Continue")
                }
            },
            dismissButton = {
                TextButton(onClick = { showContactsRationale = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showContactsSettings) {
        AlertDialog(
            onDismissRequest = { showContactsSettings = false },
            title = { Text("Contacts permission required") },
            text = {
                Text(
                    "Contacts permission is currently disabled in Android Settings. Open Settings to allow Contacts if you want your paired computer to search your address book.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showContactsSettings = false
                        onOpenAppSettings()
                    },
                ) {
                    Text("Open Settings")
                }
            },
            dismissButton = {
                TextButton(onClick = { showContactsSettings = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showCallsRationale) {
        AlertDialog(
            onDismissRequest = { showCallsRationale = false },
            title = { Text("Phone permission for call controls") },
            text = {
                Text(
                    "AirBridge uses Phone permissions so your paired computer can show incoming call state and answer, decline, or place calls. Two-way call audio can optionally be bridged to your paired computer when microphone permission is allowed.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showCallsRationale = false
                        onSetCallsFromComputer(true)
                        callsLauncher.launch(ContinuityPermissions.CALLS)
                    },
                ) {
                    Text("Continue")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCallsRationale = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showCallsSettings) {
        AlertDialog(
            onDismissRequest = { showCallsSettings = false },
            title = { Text("Phone permission required") },
            text = {
                Text(
                    "Phone permissions are currently disabled in Android Settings. Open Settings to allow Phone access if you want to answer or place calls from your paired computer.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showCallsSettings = false
                        onOpenAppSettings()
                    },
                ) {
                    Text("Open Settings")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCallsSettings = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showCallAudioRationale) {
        AlertDialog(
            onDismissRequest = { showCallAudioRationale = false },
            title = { Text("Microphone permission for Mac call audio") },
            text = {
                Text(
                    "AirBridge uses the microphone permission to bridge two-way speakerphone-assisted audio between this phone and your paired computer while Mac call audio is active.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showCallAudioRationale = false
                        callAudioMicLauncher.launch(ContinuityPermissions.CALL_AUDIO)
                    },
                ) {
                    Text("Continue")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCallAudioRationale = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    if (showCallAudioSettings) {
        AlertDialog(
            onDismissRequest = { showCallAudioSettings = false },
            title = { Text("Microphone permission required") },
            text = {
                Text(
                    "Microphone permission is disabled in Android Settings. Open Settings to allow Microphone access if you want to speak and hear phone calls from your paired computer.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showCallAudioSettings = false
                        onOpenAppSettings()
                    },
                ) {
                    Text("Open Settings")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCallAudioSettings = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}
