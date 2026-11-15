package com.airbridge.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.airbridge.app.ui.formatBytes
import com.airbridge.app.ui.formatEta
import com.airbridge.app.ui.formatSpeed
import com.airbridge.app.ui.formatTimestamp
import com.airbridge.app.ui.theme.AirBridgeColors
import com.airbridge.app.ui.transferStatusLabel
import com.airbridge.engine.TransferDirection
import com.airbridge.engine.TransferStatus
import com.airbridge.engine.TransferView

@Composable
fun TransferCard(
    transfer: TransferView,
    onCancel: (String) -> Unit,
    modifier: Modifier = Modifier,
    onAccept: ((String) -> Unit)? = null,
    onDecline: ((String) -> Unit)? = null,
    onOpenDownloads: ((String?) -> Unit)? = null,
) {
    val incoming = transfer.direction == TransferDirection.INCOMING
    val active = transfer.status == TransferStatus.TRANSFERRING || transfer.status == TransferStatus.CONNECTING
    val pending = transfer.status == TransferStatus.PENDING_ACCEPT
    val completed = transfer.status == TransferStatus.COMPLETED
    val failed = transfer.status == TransferStatus.ERROR
    val fraction = if (transfer.totalBytes > 0L) {
        (transfer.transferredBytes.toFloat() / transfer.totalBytes.toFloat()).coerceIn(0f, 1f)
    } else if (completed) {
        1f
    } else {
        0f
    }

    ElevatedCard(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.elevatedCardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(
                        imageVector = if (incoming) Icons.Outlined.ArrowDownward else Icons.Outlined.ArrowUpward,
                        contentDescription = if (incoming) "Incoming transfer" else "Outgoing transfer",
                        tint = when {
                            completed -> MaterialTheme.colorScheme.tertiary
                            failed -> MaterialTheme.colorScheme.error
                            active -> AirBridgeColors.TransferCyan
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Column {
                        Text(
                            text = if (incoming) "From ${transfer.peerName}" else "To ${transfer.peerName}",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val fileSummary = when (transfer.files.size) {
                            0 -> formatBytes(transfer.totalBytes)
                            1 -> "${transfer.files[0].name} · ${formatBytes(transfer.totalBytes)}"
                            else -> "${transfer.files.size} files (${transfer.files[0].name}, …) · ${formatBytes(transfer.totalBytes)}"
                        }
                        Text(
                            text = fileSummary,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                if (active) {
                    IconButton(onClick = { onCancel(transfer.transferId) }) {
                        Icon(Icons.Outlined.Close, contentDescription = "Cancel transfer")
                    }
                } else {
                    Text(
                        text = formatTimestamp(transfer.completedAt ?: transfer.startedAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // Status / Speed Pill Row
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Surface(
                    modifier = Modifier.align(Alignment.CenterVertically),
                    shape = RoundedCornerShape(999.dp),
                    color = when {
                        completed -> MaterialTheme.colorScheme.tertiaryContainer
                        failed -> MaterialTheme.colorScheme.errorContainer
                        else -> MaterialTheme.colorScheme.surfaceVariant
                    },
                ) {
                    val speedText = if (transfer.status == TransferStatus.TRANSFERRING && transfer.speedBytesPerSec > 0.0) {
                        val verb = if (incoming) "Download" else "Upload"
                        val eta = formatEta(transfer.etaSeconds)
                        if (eta.isNotEmpty()) "$verb ${formatSpeed(transfer.speedBytesPerSec)} · $eta"
                        else "$verb ${formatSpeed(transfer.speedBytesPerSec)}"
                    } else {
                        transferStatusLabel(transfer.status)
                    }
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (completed) {
                            Icon(
                                imageVector = Icons.Outlined.CheckCircle,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onTertiaryContainer,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                        } else if (failed) {
                            Icon(
                                imageVector = Icons.Outlined.ErrorOutline,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                        }
                        Text(
                            text = speedText,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Medium,
                            color = when {
                                completed -> MaterialTheme.colorScheme.onTertiaryContainer
                                failed -> MaterialTheme.colorScheme.onErrorContainer
                                else -> MaterialTheme.colorScheme.onSurface
                            },
                        )
                    }
                }

                if (transfer.sasCode.isNotBlank()) {
                    Text(
                        text = "SAS ${transfer.sasCode}",
                        style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                }
            }

            if (active || pending) {
                LinearProgressIndicator(
                    progress = { fraction },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "${formatBytes(transfer.transferredBytes)} of ${formatBytes(transfer.totalBytes)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "${(fraction * 100).toInt()}%",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }

            if (pending && onAccept != null && onDecline != null) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(
                        onClick = { onDecline(transfer.transferId) },
                        modifier = Modifier.weight(1f),
                    ) {
                        Text("Decline")
                    }
                    OutlinedButton(
                        onClick = { onAccept(transfer.transferId) },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.tertiary,
                        ),
                    ) {
                        Text("Accept")
                    }
                }
            }

            if (failed && !transfer.errorMessage.isNullOrBlank()) {
                Text(
                    text = transfer.errorMessage!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            if (completed && incoming && transfer.receivedFiles.isNotEmpty()) {
                val verifiedCount = transfer.receivedFiles.count { it.verified }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Saved to Downloads · $verifiedCount/${transfer.receivedFiles.size} SHA-256 verified",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    if (onOpenDownloads != null) {
                        TextButton(
                            onClick = { onOpenDownloads(transfer.receivedFiles.firstOrNull()?.savedPath) },
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.FolderOpen,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Open")
                        }
                    }
                }
            }
        }
    }
}
