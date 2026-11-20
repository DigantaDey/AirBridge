package com.airbridge.app.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Devices
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.airbridge.app.NativeEngineUiState
import com.airbridge.app.PeerUiState
import com.airbridge.app.ui.components.PairingSheet
import com.airbridge.app.ui.components.QrScannerScreen
import com.airbridge.app.ui.components.TransferOfferDialog
import com.airbridge.app.ui.screens.ClipboardScreen
import com.airbridge.app.ui.screens.ConnectScreen
import com.airbridge.app.ui.screens.SettingsScreen
import com.airbridge.app.ui.screens.TransfersScreen
import com.airbridge.app.ui.theme.AirBridgeColors
import com.airbridge.app.ui.theme.AirBridgeTheme
import com.airbridge.app.ui.viewmodels.AirBridgeAppUiState
import com.airbridge.app.ui.viewmodels.AirBridgeViewModel
import com.airbridge.app.ui.viewmodels.NearbyHost
import com.airbridge.engine.ClipboardItem
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.DeviceProfile
import com.airbridge.engine.TransferDirection
import com.airbridge.engine.TransferStatus

@Preview(name = "Phone", device = Devices.PHONE, showBackground = true)
@Preview(name = "Foldable", device = Devices.FOLDABLE, showBackground = true)
@Preview(name = "Tablet", device = Devices.TABLET, showBackground = true)
@Preview(name = "Desktop", device = Devices.DESKTOP, showBackground = true)
annotation class FormFactorPreviews

enum class AirBridgeDestination(val label: String, val icon: ImageVector) {
    TRANSFERS("Transfers", Icons.Outlined.SwapHoriz),
    CLIPBOARD("Clipboard", Icons.Outlined.ContentPaste),
    SETTINGS("Settings", Icons.Outlined.Settings),
}

@Composable
fun AirBridgeApp(
    viewModel: AirBridgeViewModel,
    showCameraRationale: Boolean = false,
    onDismissCameraRationale: () -> Unit = {},
    onConfirmCameraRationale: () -> Unit = {},
    showCameraSettings: Boolean = false,
    onDismissCameraSettings: () -> Unit = {},
    onConfirmCameraSettings: () -> Unit = {},
    showNotificationRationale: Boolean = false,
    onDismissNotificationRationale: () -> Unit = {},
    onConfirmNotificationRationale: () -> Unit = {},
    showNotificationSettings: Boolean = false,
    onDismissNotificationSettings: () -> Unit = {},
    onConfirmNotificationSettings: () -> Unit = {},
    onOpenScannerWithPermission: () -> Unit,
    onPickFiles: () -> Unit,
    onPickClipboardImage: () -> Unit,
    onOpenDownloads: (String?) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
    onOpenWebsite: () -> Unit = {},
    onOpenGitHub: () -> Unit = {},
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    var destinationName by rememberSaveable { mutableStateOf(AirBridgeDestination.TRANSFERS.name) }
    val destination = remember(destinationName) {
        runCatching { AirBridgeDestination.valueOf(destinationName) }
            .getOrDefault(AirBridgeDestination.TRANSFERS)
    }

    LaunchedEffect(viewModel) {
        viewModel.events.collect { message ->
            if (message.isNotBlank()) {
                snackbarHostState.showSnackbar(message)
            }
        }
    }

    AirBridgeTheme(themeMode = uiState.themeMode) {
        AirBridgeContent(
            uiState = uiState,
            destination = destination,
            snackbarHostState = snackbarHostState,
            onSelectDestination = { destinationName = it.name },
            onOpenScanner = onOpenScannerWithPermission,
            onCloseScanner = { viewModel.closeScanner() },
            onCodeScanned = { payload ->
                if (!viewModel.handleScannedQr(payload)) {
                    viewModel.closeScanner()
                }
            },
            onCameraUnavailable = {
                viewModel.closeScanner()
                viewModel.notifyMessage("Camera unavailable; enter your computer's address manually")
            },
            onConnectAddress = { viewModel.connectToAddress(it) },
            onConnectNearby = { host -> viewModel.connectToAddress(host.address) },
            onRefreshDiscovery = { viewModel.refreshDiscovery() },
            onInputChanged = { viewModel.clearConnectError() },
            onSelectPeer = { viewModel.selectPeer(it) },
            onSetTrusted = { key, trusted -> viewModel.setTrusted(key, trusted) },
            onPickFiles = onPickFiles,
            onRemoveStagedFile = { viewModel.removeStagedFile(it) },
            onClearStagedFiles = { viewModel.clearStagedFiles() },
            onSendStagedFiles = { viewModel.sendStagedFiles() },
            onAcceptTransfer = { id -> viewModel.acceptTransfer(id) },
            onAcceptOfferWithTrust = { id, senderKey, trust ->
                if (trust && senderKey != null) viewModel.setTrusted(senderKey, true)
                viewModel.acceptTransfer(id)
            },
            onDeclineTransfer = { id -> viewModel.declineTransfer(id) },
            onCancelTransfer = { id -> viewModel.cancelTransfer(id) },
            onOpenPairingSheet = { viewModel.setPairingSheetOpen(true) },
            onClosePairingSheet = { viewModel.setPairingSheetOpen(false) },
            onJoinPairCode = { code, onDone -> viewModel.joinPairCode(code, onDone) },
            onRotatePairCode = { viewModel.rotatePairCode() },
            onCopiedNotice = { viewModel.notifyMessage("Pair code copied") },
            onReconnect = { viewModel.reconnect() },
            onStartHotspotHandoff = { viewModel.startHotspotHandoff() },
            onStopHotspotHandoff = { viewModel.stopHotspotHandoff() },
            onOpenDownloads = onOpenDownloads,
            onRequestBatteryExemption = onRequestBatteryExemption,
            onOpenAppSettings = onOpenAppSettings,
            onOpenPrivacyPolicy = onOpenPrivacyPolicy,
            onOpenWebsite = onOpenWebsite,
            onOpenGitHub = onOpenGitHub,
            onBeamText = { text, onSent -> viewModel.beamText(text, onSent) },
            onPickClipboardImage = onPickClipboardImage,
            onBeamSystemClipboard = { viewModel.beamSystemClipboardNow() },
            onCopyClipboardItem = { viewModel.copyClipboardItem(it) },
            onClearClipboardHistory = { viewModel.clearClipboardHistory() },
            onRenameDevice = { viewModel.renameDevice(it) },
            onSetVisibility = { viewModel.setVisibility(it) },
            onSetThemeMode = { viewModel.setThemeMode(it) },
            onSetAutoClipboard = { viewModel.setAutoClipboard(it) },
            onSetReceiveClipboard = { viewModel.setReceiveClipboard(it) },
            onSetConnectionContinuity = { viewModel.setConnectionContinuity(it) },
            onSetContactsOnComputer = { viewModel.setContactsOnComputer(it) },
            onSetCallsFromComputer = { viewModel.setCallsFromComputer(it) },
            onSetScreenSharing = { viewModel.setScreenSharing(it) },
            onCopyDiagnostics = { viewModel.copyDiagnosticsReport() },
            onShareDiagnostics = { viewModel.shareDiagnosticsReport() },
            onConfirmDeepLink = { viewModel.confirmPendingDeepLink() },
            onDismissDeepLink = { viewModel.dismissPendingDeepLink() },
            onForgetComputer = { viewModel.forgetComputer() },
        )

        if (showCameraRationale) {
            AlertDialog(
                onDismissRequest = onDismissCameraRationale,
                title = { Text("Camera access for QR pairing") },
                text = {
                    Text("AirBridge uses the camera only when you open the QR scanner to pair with your computer.")
                },
                confirmButton = {
                    TextButton(onClick = onConfirmCameraRationale) {
                        Text("Allow camera")
                    }
                },
                dismissButton = {
                    TextButton(onClick = onDismissCameraRationale) {
                        Text("Enter address manually")
                    }
                },
            )
        }

        if (showCameraSettings) {
            AlertDialog(
                onDismissRequest = onDismissCameraSettings,
                title = { Text("Camera permission required") },
                text = {
                    Text("Camera access is currently disabled. Please enable Camera in Android Settings to scan QR pairing codes, or enter the computer address manually.")
                },
                confirmButton = {
                    TextButton(onClick = onConfirmCameraSettings) {
                        Text("Open Settings")
                    }
                },
                dismissButton = {
                    TextButton(onClick = onDismissCameraSettings) {
                        Text("Enter address manually")
                    }
                },
            )
        }

        if (showNotificationRationale) {
            AlertDialog(
                onDismissRequest = onDismissNotificationRationale,
                title = { Text("Enable notifications") },
                text = {
                    Text("AirBridge needs notification permission to display transfer progress and incoming file offers while running in the background.")
                },
                confirmButton = {
                    TextButton(onClick = onConfirmNotificationRationale) {
                        Text("Continue")
                    }
                },
                dismissButton = {
                    TextButton(onClick = onDismissNotificationRationale) {
                        Text("Not now")
                    }
                },
            )
        }

        if (showNotificationSettings) {
            AlertDialog(
                onDismissRequest = onDismissNotificationSettings,
                title = { Text("Notification permission required") },
                text = {
                    Text("Notifications are currently disabled. Please enable Notifications in Android Settings to monitor transfer progress and receive background offers.")
                },
                confirmButton = {
                    TextButton(onClick = onConfirmNotificationSettings) {
                        Text("Open Settings")
                    }
                },
                dismissButton = {
                    TextButton(onClick = onDismissNotificationSettings) {
                        Text("Cancel")
                    }
                },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AirBridgeContent(
    uiState: AirBridgeAppUiState,
    destination: AirBridgeDestination,
    snackbarHostState: SnackbarHostState,
    onSelectDestination: (AirBridgeDestination) -> Unit,
    onOpenScanner: () -> Unit,
    onCloseScanner: () -> Unit,
    onCodeScanned: (String) -> Unit,
    onCameraUnavailable: () -> Unit,
    onConnectAddress: (String) -> Unit,
    onConnectNearby: (NearbyHost) -> Unit,
    onRefreshDiscovery: () -> Unit,
    onInputChanged: () -> Unit,
    onSelectPeer: (String) -> Unit,
    onSetTrusted: (String, Boolean) -> Unit,
    onPickFiles: () -> Unit,
    onRemoveStagedFile: (Uri) -> Unit,
    onClearStagedFiles: () -> Unit,
    onSendStagedFiles: () -> Unit,
    onAcceptTransfer: (String) -> Unit,
    onAcceptOfferWithTrust: (transferId: String, senderPublicKey: String?, trustSender: Boolean) -> Unit,
    onDeclineTransfer: (String) -> Unit,
    onCancelTransfer: (String) -> Unit,
    onOpenPairingSheet: () -> Unit,
    onClosePairingSheet: () -> Unit,
    onJoinPairCode: (String, () -> Unit) -> Unit,
    onRotatePairCode: () -> Unit,
    onCopiedNotice: () -> Unit,
    onReconnect: () -> Unit,
    onStartHotspotHandoff: () -> Unit = {},
    onStopHotspotHandoff: () -> Unit = {},
    onOpenDownloads: (String?) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
    onOpenWebsite: () -> Unit = {},
    onOpenGitHub: () -> Unit = {},
    onBeamText: (String, () -> Unit) -> Unit,
    onPickClipboardImage: () -> Unit,
    onBeamSystemClipboard: () -> Unit,
    onCopyClipboardItem: (ClipboardItem) -> Unit,
    onClearClipboardHistory: () -> Unit,
    onRenameDevice: (String) -> Unit,
    onSetVisibility: (String) -> Unit,
    onSetThemeMode: (String) -> Unit,
    onSetAutoClipboard: (Boolean) -> Unit,
    onSetReceiveClipboard: (Boolean) -> Unit,
    onSetConnectionContinuity: (Boolean) -> Unit,
    onSetContactsOnComputer: (Boolean) -> Unit = {},
    onSetCallsFromComputer: (Boolean) -> Unit = {},
    onSetScreenSharing: (Boolean) -> Unit = {},
    onCopyDiagnostics: () -> Unit = {},
    onShareDiagnostics: () -> Unit = {},
    onConfirmDeepLink: () -> Unit = {},
    onDismissDeepLink: () -> Unit = {},
    onForgetComputer: () -> Unit,
) {
    if (uiState.scannerOpen) {
        QrScannerScreen(
            onCodeScanned = onCodeScanned,
            onClose = onCloseScanner,
            onCameraUnavailable = onCameraUnavailable,
        )
        return
    }

    val pendingOffer = uiState.engine.transfers.firstOrNull {
        it.direction == TransferDirection.INCOMING && it.status == TransferStatus.PENDING_ACCEPT
    }

    BackHandler(enabled = !uiState.isPaired && uiState.connectError != null) {
        onInputChanged()
    }
    BackHandler(
        enabled = uiState.isPaired &&
            pendingOffer == null &&
            !uiState.pairingSheetOpen &&
            destination != AirBridgeDestination.TRANSFERS,
    ) {
        onSelectDestination(AirBridgeDestination.TRANSFERS)
    }

    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        // Use NavigationRail on medium/expanded widths (>= 600.dp) AND on compact-height
        // landscape phones (maxHeight < 480.dp) so vertical space is preserved for content.
        val useRail = uiState.isPaired && (maxWidth >= 600.dp || maxHeight < 480.dp)

        Scaffold(
            modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
            contentWindowInsets = WindowInsets.safeDrawing,
            snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
            topBar = {
                TopAppBar(
                    scrollBehavior = scrollBehavior,
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background,
                    ),
                    title = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = "AirBridge",
                                fontWeight = FontWeight.Bold,
                            )
                            if (uiState.isPaired) {
                                val dotColor = when (uiState.engine.connectionState) {
                                    ConnectionState.CONNECTED -> AirBridgeColors.VerifiedGreen
                                    ConnectionState.CONNECTING, ConnectionState.RECONNECTING -> AirBridgeColors.WarningAmber
                                    ConnectionState.DISCONNECTED -> AirBridgeColors.ErrorRed
                                }
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(dotColor),
                                )
                            }
                        }
                    },
                    actions = {
                        if (uiState.isPaired) {
                            IconButton(onClick = onOpenPairingSheet) {
                                Icon(
                                    imageVector = Icons.Outlined.QrCode2,
                                    contentDescription = "Pair another device",
                                )
                            }
                        }
                    },
                )
            },
            bottomBar = {
                if (uiState.isPaired && !useRail) {
                    NavigationBar {
                        AirBridgeDestination.entries.forEach { dest ->
                            NavigationBarItem(
                                selected = destination == dest,
                                onClick = { onSelectDestination(dest) },
                                icon = { Icon(dest.icon, contentDescription = null) },
                                label = { Text(dest.label) },
                            )
                        }
                    }
                }
            },
        ) { innerPadding ->
            if (!uiState.isPaired) {
                ConnectScreen(
                    uiState = uiState,
                    onConnectAddress = onConnectAddress,
                    onConnectNearby = onConnectNearby,
                    onOpenScanner = onOpenScanner,
                    onRefreshDiscovery = onRefreshDiscovery,
                    onInputChanged = onInputChanged,
                    modifier = Modifier
                        .padding(innerPadding)
                        .consumeWindowInsets(innerPadding),
                )
            } else {
                val activeBody: @Composable (Modifier, PaddingValues) -> Unit = { bodyMod, bodyPadding ->
                    when (destination) {
                        AirBridgeDestination.TRANSFERS -> TransfersScreen(
                            uiState = uiState,
                            onSelectPeer = onSelectPeer,
                            onSetTrusted = onSetTrusted,
                            onPickFiles = onPickFiles,
                            onRemoveStagedFile = onRemoveStagedFile,
                            onClearStagedFiles = onClearStagedFiles,
                            onSendStagedFiles = onSendStagedFiles,
                            onAcceptTransfer = onAcceptTransfer,
                            onDeclineTransfer = onDeclineTransfer,
                            onCancelTransfer = onCancelTransfer,
                            onOpenPairingSheet = onOpenPairingSheet,
                            onReconnect = onReconnect,
                            onStartHotspotHandoff = onStartHotspotHandoff,
                            onStopHotspotHandoff = onStopHotspotHandoff,
                            onOpenDownloads = onOpenDownloads,
                            onRequestBatteryExemption = onRequestBatteryExemption,
                            onCopyDiagnostics = onCopyDiagnostics,
                            onShareDiagnostics = onShareDiagnostics,
                            onOpenAppSettings = onOpenAppSettings,
                            modifier = bodyMod,
                            contentPadding = bodyPadding,
                        )

                        AirBridgeDestination.CLIPBOARD -> ClipboardScreen(
                            uiState = uiState,
                            onSelectPeer = onSelectPeer,
                            onBeamText = onBeamText,
                            onPickImage = onPickClipboardImage,
                            onBeamSystemClipboard = onBeamSystemClipboard,
                            onCopyClipboardItem = onCopyClipboardItem,
                            onClearHistory = onClearClipboardHistory,
                            modifier = bodyMod,
                            contentPadding = bodyPadding,
                        )

                        AirBridgeDestination.SETTINGS -> SettingsScreen(
                            uiState = uiState,
                            onRenameDevice = onRenameDevice,
                            onSetVisibility = onSetVisibility,
                            onSetThemeMode = onSetThemeMode,
                            onSetAutoClipboard = onSetAutoClipboard,
                            onSetReceiveClipboard = onSetReceiveClipboard,
                            onSetConnectionContinuity = onSetConnectionContinuity,
                            onRequestBatteryExemption = onRequestBatteryExemption,
                            onOpenAppSettings = onOpenAppSettings,
                            onOpenPrivacyPolicy = onOpenPrivacyPolicy,
                            onOpenWebsite = onOpenWebsite,
                            onOpenGitHub = onOpenGitHub,
                            onOpenPairingSheet = onOpenPairingSheet,
                            onForgetComputer = onForgetComputer,
                            onSetContactsOnComputer = onSetContactsOnComputer,
                            onSetCallsFromComputer = onSetCallsFromComputer,
                            onSetScreenSharing = onSetScreenSharing,
                            onCopyDiagnostics = onCopyDiagnostics,
                            onShareDiagnostics = onShareDiagnostics,
                            modifier = bodyMod,
                            contentPadding = bodyPadding,
                        )
                    }
                }

                if (useRail) {
                    Row(
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        NavigationRail(
                            modifier = Modifier
                                .fillMaxHeight()
                                .padding(top = innerPadding.calculateTopPadding()),
                        ) {
                            Spacer(modifier = Modifier.weight(0.05f))
                            AirBridgeDestination.entries.forEach { dest ->
                                NavigationRailItem(
                                    selected = destination == dest,
                                    onClick = { onSelectDestination(dest) },
                                    icon = { Icon(dest.icon, contentDescription = null) },
                                    label = { Text(dest.label) },
                                )
                            }
                            Spacer(modifier = Modifier.weight(1f))
                        }
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .consumeWindowInsets(innerPadding),
                        ) {
                            activeBody(Modifier.fillMaxSize(), innerPadding)
                        }
                    }
                } else {
                    activeBody(
                        Modifier
                            .fillMaxSize()
                            .consumeWindowInsets(innerPadding),
                        innerPadding,
                    )
                }
            }
        }
    }

    val pendingLink = uiState.pendingDeepLink
    if (pendingLink != null) {
        AlertDialog(
            onDismissRequest = onDismissDeepLink,
            title = { Text("Switch paired computer?") },
            text = {
                Text(
                    buildString {
                        append("An external link asked AirBridge to connect to ")
                        append("${pendingLink.host}:${pendingLink.port}")
                        if (uiState.configuredTarget.isNotBlank()) {
                            append(", replacing your current paired computer (${uiState.configuredTarget})")
                        }
                        append(". Only continue if you initiated this pairing link.")
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(onClick = onConfirmDeepLink) {
                    Text(
                        text = "Switch to ${pendingLink.host}:${pendingLink.port}",
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = onDismissDeepLink) {
                    Text("Keep current computer")
                }
            },
        )
    }

    if (pendingOffer != null) {
        val senderPeer = uiState.engine.peers.firstOrNull { it.peerId == pendingOffer.peerId }
        val senderKey = senderPeer?.device?.publicKey
        val trusted = senderKey != null && senderKey in uiState.engine.trustedKeys
        TransferOfferDialog(
            offer = pendingOffer,
            senderPublicKey = senderKey,
            isCurrentlyTrusted = trusted,
            onAccept = { trust ->
                onAcceptOfferWithTrust(pendingOffer.transferId, senderKey, trust)
            },
            onDecline = { onDeclineTransfer(pendingOffer.transferId) },
        )
    }

    if (uiState.pairingSheetOpen) {
        PairingSheet(
            targetUrl = uiState.configuredTarget,
            pairCode = uiState.engine.pairCode,
            formattedPairCode = uiState.engine.formattedPairCode,
            hasCamera = uiState.hasCamera,
            onDismiss = onClosePairingSheet,
            onJoinPairCode = { code -> onJoinPairCode(code) {} },
            onRotatePairCode = onRotatePairCode,
            onOpenScanner = onOpenScanner,
            onCopiedNotice = onCopiedNotice,
        )
    }
}

@FormFactorPreviews
@Composable
private fun AirBridgeConnectPreview() {
    AirBridgeTheme(themeMode = "dark") {
        AirBridgeContent(
            uiState = AirBridgeAppUiState(
                isPaired = false,
                deviceName = "Pixel 9",
                nearbyHosts = listOf(NearbyHost("MacBook Pro", "https://192.168.1.14:3000")),
            ),
            destination = AirBridgeDestination.TRANSFERS,
            snackbarHostState = remember { SnackbarHostState() },
            onSelectDestination = {},
            onOpenScanner = {},
            onCloseScanner = {},
            onCodeScanned = {},
            onCameraUnavailable = {},
            onConnectAddress = {},
            onConnectNearby = {},
            onRefreshDiscovery = {},
            onInputChanged = {},
            onSelectPeer = {},
            onSetTrusted = { _, _ -> },
            onPickFiles = {},
            onRemoveStagedFile = {},
            onClearStagedFiles = {},
            onSendStagedFiles = {},
            onAcceptTransfer = {},
            onAcceptOfferWithTrust = { _, _, _ -> },
            onDeclineTransfer = {},
            onCancelTransfer = {},
            onOpenPairingSheet = {},
            onClosePairingSheet = {},
            onJoinPairCode = { _, _ -> },
            onRotatePairCode = {},
            onCopiedNotice = {},
            onReconnect = {},
            onOpenDownloads = {},
            onRequestBatteryExemption = {},
            onOpenAppSettings = {},
            onOpenPrivacyPolicy = {},
            onBeamText = { _, _ -> },
            onPickClipboardImage = {},
            onBeamSystemClipboard = {},
            onCopyClipboardItem = {},
            onClearClipboardHistory = {},
            onRenameDevice = {},
            onSetVisibility = {},
            onSetThemeMode = {},
            onSetAutoClipboard = {},
            onSetReceiveClipboard = {},
            onSetConnectionContinuity = {},
            onForgetComputer = {},
        )
    }
}

@FormFactorPreviews
@Composable
private fun AirBridgeTabletPairedPreview() {
    AirBridgeTheme(themeMode = "dark") {
        AirBridgeContent(
            uiState = AirBridgeAppUiState(
                isPaired = true,
                configuredTarget = "https://192.168.1.14:3000",
                deviceName = "Pixel Tablet",
                batteryExempt = true,
                selectedPeerId = "peer-1",
                engine = NativeEngineUiState(
                    ready = true,
                    connectionState = ConnectionState.CONNECTED,
                    peers = listOf(
                        PeerUiState(
                            peerId = "peer-1",
                            device = DeviceProfile("MacBook Pro", "macOS", "MacBookPro18,1", "laptop", "pub-key"),
                            discoveryScope = "paired",
                            connectedAt = 0L,
                            sasCode = "481-920",
                            fingerprintHex = null,
                            trusted = true,
                        ),
                    ),
                ),
            ),
            destination = AirBridgeDestination.TRANSFERS,
            snackbarHostState = remember { SnackbarHostState() },
            onSelectDestination = {},
            onOpenScanner = {},
            onCloseScanner = {},
            onCodeScanned = {},
            onCameraUnavailable = {},
            onConnectAddress = {},
            onConnectNearby = {},
            onRefreshDiscovery = {},
            onInputChanged = {},
            onSelectPeer = {},
            onSetTrusted = { _, _ -> },
            onPickFiles = {},
            onRemoveStagedFile = {},
            onClearStagedFiles = {},
            onSendStagedFiles = {},
            onAcceptTransfer = {},
            onAcceptOfferWithTrust = { _, _, _ -> },
            onDeclineTransfer = {},
            onCancelTransfer = {},
            onOpenPairingSheet = {},
            onClosePairingSheet = {},
            onJoinPairCode = { _, _ -> },
            onRotatePairCode = {},
            onCopiedNotice = {},
            onReconnect = {},
            onOpenDownloads = {},
            onRequestBatteryExemption = {},
            onOpenAppSettings = {},
            onOpenPrivacyPolicy = {},
            onBeamText = { _, _ -> },
            onPickClipboardImage = {},
            onBeamSystemClipboard = {},
            onCopyClipboardItem = {},
            onClearClipboardHistory = {},
            onRenameDevice = {},
            onSetVisibility = {},
            onSetThemeMode = {},
            onSetAutoClipboard = {},
            onSetReceiveClipboard = {},
            onSetConnectionContinuity = {},
            onForgetComputer = {},
        )
    }
}
