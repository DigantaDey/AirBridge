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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableIntStateOf
import com.airbridge.app.CallerIdService
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
    // Prominent disclosure + affirmative consent before any sensitive Android
    // access is requested (Google Play User Data policy).
    var disclosure by rememberSaveable { mutableStateOf<String?>(null) }
    disclosure?.let { kind ->
        SensitiveAccessDisclosure(
            kind = kind,
            onAgree = {
                disclosure = null
                if (kind == DISCLOSURE_ACCESSIBILITY) {
                    onSetAccessibilityOptIn(true)
                    onOpenAccessibilitySettings()
                } else {
                    onOpenNotificationListenerSettings()
                }
            },
            onDismiss = { disclosure = null },
        )
    }

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
                        OutlinedButton(onClick = { disclosure = DISCLOSURE_NOTIFICATIONS }) {
                            Text("Open Settings")
                        }
                    }
                }
                HorizontalDivider()
                SwitchRow(
                    title = "Background clipboard bridge opt-in",
                    subtitle = "Use optional Accessibility service for copies from other apps",
                    checked = uiState.accessibilityOptIn,
                    onCheckedChange = { on -> if (on) disclosure = DISCLOSURE_ACCESSIBILITY else onSetAccessibilityOptIn(false) },
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
                    TextButton(onClick = {
                        if (uiState.accessibilityEnabled) onOpenAccessibilitySettings() else disclosure = DISCLOSURE_ACCESSIBILITY
                    }) {
                        Text("Open Settings")
                    }
                }
            }

            PhoneContinuityCard()

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

private const val DISCLOSURE_ACCESSIBILITY = "accessibility"
private const val DISCLOSURE_NOTIFICATIONS = "notifications"

/**
 * In-app prominent disclosure shown before Android's Accessibility or
 * Notification-access settings: what is read, why, where it goes, and how to
 * stop. Nothing is enabled unless the user taps "Agree".
 */
@Composable
private fun SensitiveAccessDisclosure(kind: String, onAgree: () -> Unit, onDismiss: () -> Unit) {
    val accessibility = kind == DISCLOSURE_ACCESSIBILITY
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (accessibility) "Use Accessibility for the clipboard bridge?" else "Allow notification access?") },
        text = {
            Text(
                if (accessibility) {
                    "AirBridge uses Android's Accessibility service only for its optional clipboard bridge. When it is on, " +
                        "AirBridge is told when you copy or select text in other apps, reads that copied text, and sends it " +
                        "to your own paired computer, end-to-end encrypted.\n\n" +
                        "It does not read what you type, passwords, or the rest of the screen, and it does not perform " +
                        "actions for you. Nothing goes to AirBridge servers or third parties, and nothing is used for ads.\n\n" +
                        "Next, Android Settings opens: turn on \"AirBridge clipboard bridge\". You can turn it off there or " +
                        "here at any time."
                } else {
                    "To show your phone's notifications on your computer, AirBridge needs Notification access. AirBridge " +
                        "then reads the app name, title and text of new notifications and sends them to your own paired " +
                        "computer, end-to-end encrypted.\n\n" +
                        "Ongoing, background-service and private (hidden) notifications are skipped. Nothing goes to " +
                        "AirBridge servers or third parties, and nothing is used for ads.\n\n" +
                        "Next, Android Settings opens: allow AirBridge. Turn it off there or with \"Notification sharing\" " +
                        "here at any time."
                },
                style = MaterialTheme.typography.bodyMedium,
            )
        },
        confirmButton = { TextButton(onClick = onAgree) { Text("Agree") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Not now") } },
    )
}

/**
 * Contacts, calls and screen sharing for the paired computer. Each toggle asks
 * for its Android permission when turned on; the computer only sees a feature
 * once both the toggle and the permission allow it.
 */
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
    val callerIdLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { changed() }
    // Re-read on every recomposition triggered by [tick] (permission results, toggles).
    @Suppress("UNUSED_VARIABLE") val observe = tick
    val contactsGranted = ContinuityPermissions.contactsGranted(context)
    val callsGranted = ContinuityPermissions.callsGranted(context)
    val callerId = ContinuityPermissions.callerIdGranted(context)
    val telephony = ContinuityPermissions.hasTelephony(context)

    SettingsCard(title = "Phone on your computer") {
        SwitchRow(
            title = "Contacts",
            subtitle = when {
                !prefs.contactsOnComputer -> "Browse, search and call your contacts from the computer"
                contactsGranted -> "Your computer can search your contacts while connected"
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
                !prefs.callsFromComputer -> "Answer, decline and place calls from the computer"
                !callsGranted -> "Needs phone permission — tap the switch to allow"
                else -> "On. Call audio stays on the phone or its headset"
            },
            checked = telephony && prefs.callsFromComputer && callsGranted,
            onCheckedChange = { on ->
                prefs.callsFromComputer = on
                if (on && telephony && !callsGranted) callsLauncher.launch(ContinuityPermissions.CALLS)
                changed()
            },
        )
        if (telephony && prefs.callsFromComputer && callsGranted && !callerId && CallerIdService.supported(context)) {
            // Optional: the number of an incoming call, via Android's Caller ID role.
            Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Text(
                    text = "Show who is calling on the computer by choosing AirBridge as the Caller ID app. AirBridge only reads the incoming number — it never blocks, silences or logs calls.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { CallerIdService.requestIntent(context)?.let { callerIdLauncher.launch(it) } }) {
                    Text("Turn on caller ID")
                }
            }
        }
        HorizontalDivider()
        SwitchRow(
            title = "Screen sharing",
            subtitle = "Let the computer ask to view this screen, or cast it from the home tab. You approve every session",
            checked = prefs.screenSharing,
            onCheckedChange = { on ->
                prefs.screenSharing = on
                changed()
            },
        )
        if (prefs.screenSharing && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            HorizontalDivider()
            SwitchRow(
                title = "Include sound",
                subtitle = "Play media audio on the computer while sharing. Android asks for audio-recording access once; AirBridge captures app playback only, never the microphone or calls",
                checked = prefs.screenSound,
                onCheckedChange = { on ->
                    prefs.screenSound = on
                    changed()
                },
            )
        }
    }
}
