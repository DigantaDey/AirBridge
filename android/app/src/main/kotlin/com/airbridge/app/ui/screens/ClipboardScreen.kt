package com.airbridge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AccessibilityNew
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.airbridge.app.PeerUiState
import com.airbridge.app.ui.components.ClipboardItemCard
import com.airbridge.app.ui.theme.AirBridgeColors
import com.airbridge.app.ui.viewmodels.AirBridgeAppUiState
import com.airbridge.engine.ClipboardItem

@Composable
fun ClipboardScreen(
    uiState: AirBridgeAppUiState,
    onSelectPeer: (String) -> Unit,
    onBeamText: (text: String, onSent: () -> Unit) -> Unit,
    onPickImage: () -> Unit,
    onBeamSystemClipboard: () -> Unit,
    onCopyClipboardItem: (ClipboardItem) -> Unit,
    onClearHistory: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by rememberSaveable { mutableStateOf("") }
    val selectedPeer = uiState.engine.peers.firstOrNull { it.peerId == uiState.selectedPeerId }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        val isWide = maxWidth >= 840.dp
        if (isWide) {
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 24.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Column(
                    modifier = Modifier
                        .weight(0.45f)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    BeamComposeCard(
                        peers = uiState.engine.peers,
                        selectedPeer = selectedPeer,
                        draft = draft,
                        onDraftChange = { draft = it },
                        onSelectPeer = onSelectPeer,
                        onBeamText = {
                            onBeamText(draft) { draft = "" }
                        },
                        onPickImage = onPickImage,
                        onBeamSystemClipboard = onBeamSystemClipboard,
                    )
                    BackgroundClipboardCard(
                        accessibilityEnabled = uiState.accessibilityEnabled,
                        onOpenAccessibilitySettings = onOpenAccessibilitySettings,
                    )
                }

                LazyColumn(
                    modifier = Modifier.weight(0.55f),
                    contentPadding = PaddingValues(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    clipboardFeedItems(
                        items = uiState.engine.clipboardItems,
                        onCopyClipboardItem = onCopyClipboardItem,
                        onClearHistory = onClearHistory,
                    )
                }
            }
        } else {
            val mediumCardModifier = Modifier.widthIn(max = 760.dp)
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                item(key = "compose") {
                    BeamComposeCard(
                        peers = uiState.engine.peers,
                        selectedPeer = selectedPeer,
                        draft = draft,
                        onDraftChange = { draft = it },
                        onSelectPeer = onSelectPeer,
                        onBeamText = {
                            onBeamText(draft) { draft = "" }
                        },
                        onPickImage = onPickImage,
                        onBeamSystemClipboard = onBeamSystemClipboard,
                        modifier = mediumCardModifier,
                    )
                }
                item(key = "sync-status") {
                    BackgroundClipboardCard(
                        accessibilityEnabled = uiState.accessibilityEnabled,
                        onOpenAccessibilitySettings = onOpenAccessibilitySettings,
                        modifier = mediumCardModifier,
                    )
                }
                clipboardFeedItems(
                    items = uiState.engine.clipboardItems,
                    onCopyClipboardItem = onCopyClipboardItem,
                    onClearHistory = onClearHistory,
                    itemModifier = mediumCardModifier,
                )
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.clipboardFeedItems(
    items: List<ClipboardItem>,
    onCopyClipboardItem: (ClipboardItem) -> Unit,
    onClearHistory: () -> Unit,
    itemModifier: Modifier = Modifier,
) {
    item(key = "clip-header") {
        Row(
            modifier = itemModifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Clipboard feed (${items.size})",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            if (items.isNotEmpty()) {
                TextButton(onClick = onClearHistory) {
                    Text("Clear")
                }
            }
        }
    }
    if (items.isEmpty()) {
        item(key = "clip-empty") {
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                modifier = itemModifier.fillMaxWidth(),
            ) {
                Text(
                    text = "Text or images copied on your computer appear here and update Android's clipboard automatically.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
    } else {
        items(items, key = { it.beamId }) { item ->
            ClipboardItemCard(
                item = item,
                onCopy = onCopyClipboardItem,
                modifier = itemModifier,
            )
        }
    }
}

@Composable
private fun BeamComposeCard(
    peers: List<PeerUiState>,
    selectedPeer: PeerUiState?,
    draft: String,
    onDraftChange: (String) -> Unit,
    onSelectPeer: (String) -> Unit,
    onBeamText: () -> Unit,
    onPickImage: () -> Unit,
    onBeamSystemClipboard: () -> Unit,
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
            Text(
                text = "Beam clipboard",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            if (peers.size > 1) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
            }

            OutlinedTextField(
                value = draft,
                onValueChange = onDraftChange,
                label = {
                    Text(
                        if (selectedPeer != null) {
                            "Send text to ${selectedPeer.device.name}"
                        } else {
                            "Connect a computer to send text"
                        },
                    )
                },
                minLines = 3,
                maxLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = onBeamText,
                    enabled = draft.isNotBlank() && selectedPeer != null,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Beam")
                }
                OutlinedButton(
                    onClick = onPickImage,
                    enabled = selectedPeer != null,
                ) {
                    Icon(Icons.Outlined.Image, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Image")
                }
                OutlinedButton(
                    onClick = onBeamSystemClipboard,
                    enabled = selectedPeer != null,
                ) {
                    Icon(Icons.Outlined.ContentPaste, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Paste")
                }
            }
        }
    }
}

@Composable
private fun BackgroundClipboardCard(
    accessibilityEnabled: Boolean,
    onOpenAccessibilitySettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
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
                        tint = if (accessibilityEnabled) {
                            AirBridgeColors.VerifiedGreen
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    Text(
                        text = if (accessibilityEnabled) {
                            "Background clipboard bridge active"
                        } else {
                            "Background clipboard sync"
                        },
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Medium,
                    )
                }
                if (!accessibilityEnabled) {
                    TextButton(onClick = onOpenAccessibilitySettings) {
                        Text("Enable")
                    }
                }
            }
            Text(
                text = if (accessibilityEnabled) {
                    "Copies made in other apps are synced automatically. You can also use Share → AirBridge, the notification action, or the Quick Settings tile."
                } else {
                    "Android 10+ blocks background apps from reading the clipboard. Enable the AirBridge Accessibility bridge for automatic background copy sync, or use Share → AirBridge and the notification Beam action."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
