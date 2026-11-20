package com.airbridge.app.ui.screens

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.airbridge.app.HandoffUiState
import com.airbridge.app.NativeFiles
import com.airbridge.app.PeerUiState
import com.airbridge.app.ui.components.HotspotHandoffCard
import com.airbridge.app.ui.components.TransferCard
import com.airbridge.app.ui.connectionLabel
import com.airbridge.app.ui.formatBytes
import com.airbridge.app.ui.theme.AirBridgeColors
import com.airbridge.app.ui.viewmodels.AirBridgeAppUiState
import com.airbridge.engine.ConnectionHelp
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.RecoveryAction
import com.airbridge.engine.TransferStatus
import com.airbridge.engine.TransferView

@Composable
fun TransfersScreen(
    uiState: AirBridgeAppUiState,
    onSelectPeer: (String) -> Unit,
    onSetTrusted: (publicKey: String, trusted: Boolean) -> Unit,
    onPickFiles: () -> Unit,
    onRemoveStagedFile: (Uri) -> Unit,
    onClearStagedFiles: () -> Unit,
    onSendStagedFiles: () -> Unit,
    onAcceptTransfer: (String) -> Unit,
    onDeclineTransfer: (String) -> Unit,
    onCancelTransfer: (String) -> Unit,
    onOpenPairingSheet: () -> Unit,
    onReconnect: () -> Unit,
    onOpenDownloads: (String?) -> Unit,
    onRequestBatteryExemption: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    onStartHotspotHandoff: () -> Unit = {},
    onStopHotspotHandoff: () -> Unit = {},
    onCopyDiagnostics: () -> Unit = {},
    onShareDiagnostics: () -> Unit = {},
    onOpenAppSettings: () -> Unit = {},
) {
    val activeStatuses = setOf(
        TransferStatus.PENDING_ACCEPT,
        TransferStatus.CONNECTING,
        TransferStatus.TRANSFERRING,
    )
    val activeTransfers = uiState.engine.transfers.filter { it.status in activeStatuses }
    val recentTransfers = uiState.engine.transfers.filterNot { it.status in activeStatuses }
    val selectedPeer = uiState.engine.peers.firstOrNull { it.peerId == uiState.selectedPeerId }
    val layoutDirection = LocalLayoutDirection.current
    val listState = rememberLazyListState()

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val isWide = maxWidth >= 840.dp
        if (isWide) {
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(
                        start = contentPadding.calculateStartPadding(layoutDirection) + 24.dp,
                        end = contentPadding.calculateEndPadding(layoutDirection) + 24.dp,
                        top = contentPadding.calculateTopPadding(),
                    ),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Column(
                    modifier = Modifier
                        .weight(0.46f)
                        .verticalScroll(rememberScrollState())
                        .padding(
                            top = 16.dp,
                            bottom = contentPadding.calculateBottomPadding() + 24.dp,
                        ),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    ConnectionStatusCard(
                        uiState = uiState,
                        onOpenPairingSheet = onOpenPairingSheet,
                        onReconnect = onReconnect,
                        onCopyDiagnostics = onCopyDiagnostics,
                        onShareDiagnostics = onShareDiagnostics,
                        onOpenAppSettings = onOpenAppSettings,
                    )
                    if (!uiState.batteryExempt) {
                        BackgroundHealthCard(
                            uiState = uiState,
                            onRequestBatteryExemption = onRequestBatteryExemption,
                        )
                    }
                    if (uiState.engine.handoff.available || uiState.engine.handoff.phase != HandoffUiState.Phase.IDLE) {
                        HotspotHandoffCard(
                            state = uiState.engine.handoff,
                            onStart = onStartHotspotHandoff,
                            onStop = onStopHotspotHandoff,
                        )
                    }
                    PeersSelectorCard(
                        peers = uiState.engine.peers,
                        selectedPeer = selectedPeer,
                        onSelectPeer = onSelectPeer,
                        onSetTrusted = onSetTrusted,
                    )
                    SendFilesCard(
                        selectedPeer = selectedPeer,
                        stagedFiles = uiState.stagedFiles,
                        isSending = uiState.isSending,
                        onPickFiles = onPickFiles,
                        onRemoveStagedFile = onRemoveStagedFile,
                        onClearStagedFiles = onClearStagedFiles,
                        onSendStagedFiles = onSendStagedFiles,
                    )
                }

                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(0.54f),
                    contentPadding = PaddingValues(
                        top = 16.dp,
                        bottom = contentPadding.calculateBottomPadding() + 24.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    transferFeedItems(
                        activeTransfers = activeTransfers,
                        recentTransfers = recentTransfers,
                        onAcceptTransfer = onAcceptTransfer,
                        onDeclineTransfer = onDeclineTransfer,
                        onCancelTransfer = onCancelTransfer,
                        onOpenDownloads = onOpenDownloads,
                    )
                }
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                contentPadding = PaddingValues(
                    start = contentPadding.calculateStartPadding(layoutDirection) + 16.dp,
                    end = contentPadding.calculateEndPadding(layoutDirection) + 16.dp,
                    top = contentPadding.calculateTopPadding() + 16.dp,
                    bottom = contentPadding.calculateBottomPadding() + 16.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                val mediumCardModifier = Modifier.widthIn(max = 760.dp)
                item(key = "status") {
                    ConnectionStatusCard(
                        uiState = uiState,
                        onOpenPairingSheet = onOpenPairingSheet,
                        onReconnect = onReconnect,
                        onCopyDiagnostics = onCopyDiagnostics,
                        onShareDiagnostics = onShareDiagnostics,
                        onOpenAppSettings = onOpenAppSettings,
                        modifier = mediumCardModifier,
                    )
                }
                if (!uiState.batteryExempt) {
                    item(key = "health") {
                        BackgroundHealthCard(
                            uiState = uiState,
                            onRequestBatteryExemption = onRequestBatteryExemption,
                            modifier = mediumCardModifier,
                        )
                    }
                }
                if (uiState.engine.handoff.available || uiState.engine.handoff.phase != HandoffUiState.Phase.IDLE) {
                    item(key = "handoff") {
                        HotspotHandoffCard(
                            state = uiState.engine.handoff,
                            onStart = onStartHotspotHandoff,
                            onStop = onStopHotspotHandoff,
                            modifier = mediumCardModifier,
                        )
                    }
                }
                item(key = "peers") {
                    PeersSelectorCard(
                        peers = uiState.engine.peers,
                        selectedPeer = selectedPeer,
                        onSelectPeer = onSelectPeer,
                        onSetTrusted = onSetTrusted,
                        modifier = mediumCardModifier,
                    )
                }
                item(key = "send") {
                    SendFilesCard(
                        selectedPeer = selectedPeer,
                        stagedFiles = uiState.stagedFiles,
                        isSending = uiState.isSending,
                        onPickFiles = onPickFiles,
                        onRemoveStagedFile = onRemoveStagedFile,
                        onClearStagedFiles = onClearStagedFiles,
                        onSendStagedFiles = onSendStagedFiles,
                        modifier = mediumCardModifier,
                    )
                }
                transferFeedItems(
                    activeTransfers = activeTransfers,
                    recentTransfers = recentTransfers,
                    onAcceptTransfer = onAcceptTransfer,
                    onDeclineTransfer = onDeclineTransfer,
                    onCancelTransfer = onCancelTransfer,
                    onOpenDownloads = onOpenDownloads,
                    itemModifier = mediumCardModifier,
                )
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.transferFeedItems(
    activeTransfers: List<TransferView>,
    recentTransfers: List<TransferView>,
    onAcceptTransfer: (String) -> Unit,
    onDeclineTransfer: (String) -> Unit,
    onCancelTransfer: (String) -> Unit,
    onOpenDownloads: (String?) -> Unit,
    itemModifier: Modifier = Modifier,
) {
    if (activeTransfers.isNotEmpty()) {
        item(key = "active-header") {
            Text(
                text = "Active transfers (${activeTransfers.size})",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = itemModifier.fillMaxWidth(),
            )
        }
        items(activeTransfers, key = { "active-${it.transferId}" }) { transfer ->
            TransferCard(
                transfer = transfer,
                onCancel = onCancelTransfer,
                modifier = itemModifier,
                onAccept = onAcceptTransfer,
                onDecline = onDeclineTransfer,
                onOpenDownloads = onOpenDownloads,
            )
        }
    }

    item(key = "recent-header") {
        Text(
            text = "Recent transfers",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = itemModifier.fillMaxWidth().padding(top = 4.dp),
        )
    }

    if (recentTransfers.isEmpty() && activeTransfers.isEmpty()) {
        item(key = "empty-transfers") {
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                modifier = itemModifier.fillMaxWidth(),
            ) {
                Text(
                    text = "Encrypted transfers run natively in the foreground service, even when you switch apps or lock the screen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
    } else if (recentTransfers.isEmpty()) {
        item(key = "no-recent") {
            Text(
                text = "No completed transfers yet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = itemModifier.fillMaxWidth(),
            )
        }
    } else {
        items(recentTransfers, key = { "recent-${it.transferId}" }) { transfer ->
            TransferCard(
                transfer = transfer,
                onCancel = onCancelTransfer,
                modifier = itemModifier,
                onOpenDownloads = onOpenDownloads,
            )
        }
    }
}

@Composable
private fun ConnectionStatusCard(
    uiState: AirBridgeAppUiState,
    onOpenPairingSheet: () -> Unit,
    onReconnect: () -> Unit,
    onCopyDiagnostics: () -> Unit,
    onShareDiagnostics: () -> Unit,
    onOpenAppSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = uiState.engine.connectionState
    val dotColor = when (state) {
        ConnectionState.CONNECTED -> AirBridgeColors.VerifiedGreen
        ConnectionState.CONNECTING, ConnectionState.RECONNECTING -> AirBridgeColors.WarningAmber
        ConnectionState.DISCONNECTED -> AirBridgeColors.ErrorRed
    }
    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(dotColor),
                    )
                    Column {
                        Text(
                            text = uiState.deviceName,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = connectionLabel(state),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                OutlinedButton(onClick = onOpenPairingSheet) {
                    Icon(
                        imageVector = Icons.Outlined.QrCode2,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Pair")
                }
            }

            if (uiState.configuredTarget.isNotBlank()) {
                Text(
                    text = uiState.configuredTarget,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (!uiState.localNetworkPermissionGranted) {
                Text(
                    text = "Local network access is blocked for AirBridge. Allow Local Network in Android Settings to connect to your computer over Wi-Fi.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                OutlinedButton(onClick = onOpenAppSettings) {
                    Text("Allow Local Network in Settings")
                }
            }

            val help = uiState.engine.connectionHelp
            if (help != null && state != ConnectionState.CONNECTED) {
                // Layer-specific headline + guidance: a TCP timeout says the
                // network/route is wrong (not the code); TLS/pair-code
                // failures say to rescan; rate limits say to wait.
                Text(
                    text = ConnectionHelp.title(help.kind),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.error,
                )
                Text(
                    text = help.userMessage,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                if (help.detail.isNotBlank()) {
                    // Raw per-address outcome, e.g. "10.205.95.167:3000
                    // tcp_timeout via 192.0.0.2": tells which network the
                    // phone actually used, so a screenshot is diagnosable.
                    Text(
                        text = help.detail,
                        style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val label = ConnectionHelp.actionLabel(help.action)
                if (label != null && help.action != RecoveryAction.RETRY) {
                    OutlinedButton(onClick = onOpenPairingSheet) { Text(label) }
                }
            } else if (!uiState.engine.connectionError.isNullOrBlank()) {
                Text(
                    text = uiState.engine.connectionError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            if (state == ConnectionState.CONNECTED && uiState.engine.viaRelay) {
                // Honest about the path: slower than Wi-Fi, but the relay only
                // ever sees ciphertext. AirBridge switches back automatically.
                Text(
                    text = "Via relay: no direct path to the computer right now. Still end-to-end encrypted; switches back to the direct path automatically.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            val progress = uiState.engine.connectionProgress
            if (state != ConnectionState.CONNECTED && !progress.isNullOrBlank()) {
                Text(
                    text = progress,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (state != ConnectionState.CONNECTED) {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    TextButton(
                        onClick = onReconnect,
                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Refresh,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Reconnect now")
                    }
                    TextButton(
                        onClick = onCopyDiagnostics,
                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.ContentCopy,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Copy diagnostics")
                    }
                    TextButton(
                        onClick = onShareDiagnostics,
                        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Share,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Share report")
                    }
                }
            }
        }
    }
}

@Composable
private fun BackgroundHealthCard(
    uiState: AirBridgeAppUiState,
    onRequestBatteryExemption: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (uiState.batteryExempt) return
    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.elevatedCardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!uiState.batteryExempt) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.WarningAmber,
                            contentDescription = null,
                            tint = AirBridgeColors.WarningAmber,
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            text = "Allow unrestricted battery so large background transfers never stall.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    TextButton(onClick = onRequestBatteryExemption) {
                        Text("Allow")
                    }
                }
            }
        }
    }
}

@Composable
private fun PeersSelectorCard(
    peers: List<PeerUiState>,
    selectedPeer: PeerUiState?,
    onSelectPeer: (String) -> Unit,
    onSetTrusted: (publicKey: String, trusted: Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "Online devices (${peers.size})",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            if (peers.isEmpty()) {
                Text(
                    text = "No peer online yet. Keep AirBridge open on your computer on the same Wi-Fi.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyRow(
                    state = rememberLazyListState(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(peers, key = { it.peerId }) { peer ->
                        FilterChip(
                            selected = peer.peerId == selectedPeer?.peerId,
                            onClick = { onSelectPeer(peer.peerId) },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Outlined.Computer,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                            label = { Text(peer.device.name) },
                        )
                    }
                }

                if (selectedPeer != null) {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.weight(1f),
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.VerifiedUser,
                                    contentDescription = null,
                                    tint = if (selectedPeer.trusted) {
                                        MaterialTheme.colorScheme.tertiary
                                    } else {
                                        MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                    modifier = Modifier.size(18.dp),
                                )
                                Column {
                                    Text(
                                        text = (if (selectedPeer.discoveryScope == "paired") "Paired" else "Nearby") +
                                            (if (selectedPeer.verified) " · Verified" else "") + " · E2E encrypted",
                                        style = MaterialTheme.typography.labelLarge,
                                    )
                                    val sas = selectedPeer.sasCode
                                    // A vouched peer was authenticated by the pairing
                                    // code; the SAS is only needed for older devices.
                                    if (!sas.isNullOrBlank() && !selectedPeer.verified) {
                                        Text(
                                            text = "Verification code $sas",
                                            style = MaterialTheme.typography.labelSmall,
                                            fontFamily = FontFamily.Monospace,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = "Trust",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(modifier = Modifier.width(6.dp))
                                Switch(
                                    checked = selectedPeer.trusted,
                                    onCheckedChange = { checked ->
                                        onSetTrusted(selectedPeer.device.publicKey, checked)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SendFilesCard(
    selectedPeer: PeerUiState?,
    stagedFiles: List<NativeFiles.PickedUriMeta>,
    isSending: Boolean,
    onPickFiles: () -> Unit,
    onRemoveStagedFile: (Uri) -> Unit,
    onClearStagedFiles: () -> Unit,
    onSendStagedFiles: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Send files",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (stagedFiles.isNotEmpty()) {
                    TextButton(onClick = onClearStagedFiles) {
                        Text("Clear")
                    }
                }
            }

            if (stagedFiles.isEmpty()) {
                OutlinedButton(
                    onClick = onPickFiles,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Icon(Icons.Outlined.AttachFile, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Choose files from device")
                }
            } else {
                val totalSize = stagedFiles.sumOf { it.size }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    stagedFiles.take(6).forEach { file ->
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = file.name,
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        text = formatBytes(file.size),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                IconButton(onClick = { onRemoveStagedFile(file.uri) }) {
                                    Icon(
                                        imageVector = Icons.Outlined.Close,
                                        contentDescription = "Remove ${file.name}",
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            }
                        }
                    }
                    if (stagedFiles.size > 6) {
                        Text(
                            text = "+ ${stagedFiles.size - 6} more files selected",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    OutlinedButton(
                        onClick = onPickFiles,
                        modifier = Modifier.weight(0.42f),
                    ) {
                        Text("Add more")
                    }
                    Button(
                        onClick = onSendStagedFiles,
                        enabled = selectedPeer != null && !isSending,
                        modifier = Modifier.weight(0.58f),
                    ) {
                        if (isSending) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Starting…")
                        } else {
                            Icon(
                                imageVector = Icons.AutoMirrored.Outlined.Send,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Send ${formatBytes(totalSize)}")
                        }
                    }
                }
            }
        }
    }
}
