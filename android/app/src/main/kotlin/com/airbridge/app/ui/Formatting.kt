package com.airbridge.app.ui

import com.airbridge.engine.ConnectionState
import com.airbridge.engine.TransferStatus
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.floor
import kotlin.math.log
import kotlin.math.pow

fun formatBytes(bytes: Long): String {
    if (bytes <= 0L) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    val exp = floor(log(bytes.toDouble(), 1024.0)).toInt().coerceIn(0, units.lastIndex)
    val value = bytes.toDouble() / 1024.0.pow(exp)
    val decimals = if (exp >= 2) 2 else if (exp == 1) 1 else 0
    return String.format(Locale.US, "%.${decimals}f %s", value, units[exp])
}

fun formatSpeed(bytesPerSec: Double): String {
    if (!bytesPerSec.isFinite() || bytesPerSec <= 0.0) return "0 B/s"
    val units = arrayOf("B/s", "KB/s", "MB/s", "GB/s")
    val exp = floor(log(bytesPerSec, 1024.0)).toInt().coerceIn(0, units.lastIndex)
    val value = bytesPerSec / 1024.0.pow(exp)
    val decimals = if (value >= 100 || exp == 0) 0 else if (value >= 10) 1 else 2
    return String.format(Locale.US, "%.${decimals}f %s", value, units[exp])
}

fun formatEta(etaSeconds: Long?): String {
    if (etaSeconds == null || etaSeconds <= 0L) return ""
    val m = etaSeconds / 60
    val s = etaSeconds % 60
    return when {
        m >= 60 -> "${m / 60}h ${m % 60}m left"
        m > 0 -> "${m}m ${s}s left"
        else -> "${s}s left"
    }
}

fun formatTimestamp(epochMs: Long): String =
    DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(epochMs))

fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.CONNECTED -> "Transfer service connected"
    ConnectionState.CONNECTING -> "Connecting to computer…"
    ConnectionState.RECONNECTING -> "Reconnecting…"
    ConnectionState.DISCONNECTED -> "Disconnected"
}

fun transferStatusLabel(status: String): String = when (status) {
    TransferStatus.PENDING_ACCEPT -> "Awaiting approval"
    TransferStatus.CONNECTING -> "Connecting…"
    TransferStatus.TRANSFERRING -> "Transferring"
    TransferStatus.COMPLETED -> "Completed"
    TransferStatus.DECLINED -> "Declined"
    TransferStatus.CANCELLED -> "Cancelled"
    TransferStatus.ERROR -> "Failed"
    else -> status
}
