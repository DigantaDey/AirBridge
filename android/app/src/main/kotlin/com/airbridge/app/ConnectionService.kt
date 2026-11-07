package com.airbridge.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.Locale
import kotlin.math.floor
import kotlin.math.log
import kotlin.math.pow

/** Background clipboard/connection anchor and short-lived transfer wake-lock owner. */
class ConnectionService : Service() {
    private var transferActive = false
    private var transferWakeLock: PowerManager.WakeLock? = null
    private var transferSpeed: TransferSpeedSnapshot? = null
    private var clipboardListener: ClipboardManager.OnPrimaryClipChangedListener? = null

    private data class TransferSpeedSnapshot(
        val uploading: Boolean,
        val speedBytesPerSec: Double,
        val transferredBytes: Long,
        val totalBytes: Long,
        val etaSeconds: Long?,
    )

    override fun onCreate() {
        super.onCreate()
        instance = this
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val listener = ClipboardManager.OnPrimaryClipChangedListener {
            publishSystemClipboard(clipboard)
        }
        try {
            clipboard.addPrimaryClipChangedListener(listener)
            clipboardListener = listener
        } catch (e: Exception) {
            Log.w("AirBridgeClip", "could not watch clipboard: ${e.message}")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "AirBridge connection and transfers",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps AirBridge connected and shows live transfer speed" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                transferActive = false
                transferSpeed = null
                releaseTransferWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TRANSFER_START -> {
                transferActive = true
                transferSpeed = null
            }
            ACTION_TRANSFER_STOP -> {
                transferActive = false
                transferSpeed = null
            }
            ACTION_TRANSFER_PROGRESS ->
                applyTransferSpeed(intent?.getStringExtra(EXTRA_TRANSFER_PROGRESS).orEmpty())
            null -> {
                // A sticky restart is only useful for the explicitly opted-in
                // connection service; transfers themselves resume from the
                // receiver's durable chunks after the app reconnects.
                if (!Prefs(this).connectionContinuity) {
                    releaseTransferWakeLock()
                    stopSelf()
                    return START_NOT_STICKY
                }
            }
        }

        updateTransferWakeLock()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        if (!transferActive && !Prefs(this).connectionContinuity) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    /**
     * Android 10+ can suppress clipboard reads while the app is backgrounded.
     * The listener still fires when the OS allows it; failures are swallowed so
     * the foreground service (and the encrypted session) stay alive.
     */
    private fun publishSystemClipboard(clipboard: ClipboardManager) {
        val text = try {
            val clip = clipboard.primaryClip
            if (clip == null || clip.itemCount == 0) return
            clip.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
        } catch (e: SecurityException) {
            return
        } catch (e: Exception) {
            return
        }
        if (text.isEmpty() || text.length > 256_000) return
        publishClipboardChange(this, text)
    }

    /** Refreshes the foreground notification from the WebView's live rate. */
    private fun applyTransferSpeed(payloadJson: String) {
        transferSpeed = parseTransferSpeed(payloadJson)
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification())
    }

    private fun parseTransferSpeed(payloadJson: String): TransferSpeedSnapshot? {
        if (payloadJson.isEmpty()) return null
        return try {
            val json = JSONObject(payloadJson)
            if (!json.optBoolean("active", false)) return null
            val speed = json.optDouble("speedBytesPerSec", 0.0).let {
                if (it.isNaN() || it.isInfinite() || it < 0.0) 0.0 else it
            }
            val total = json.optLong("totalBytes", 0L).coerceAtLeast(0L)
            val transferred = json.optLong("transferredBytes", 0L)
                .coerceAtLeast(0L)
                .coerceAtMost(if (total > 0L) total else Long.MAX_VALUE)
            val eta = if (json.has("etaSeconds") && !json.isNull("etaSeconds")) {
                json.optLong("etaSeconds", -1L).takeIf { it > 0L }
            } else {
                null
            }
            TransferSpeedSnapshot(
                uploading = json.optString("direction") == "upload",
                speedBytesPerSec = speed,
                transferredBytes = transferred,
                totalBytes = total,
                etaSeconds = eta,
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val speed = transferSpeed
        val percent = speed?.let {
            if (it.totalBytes > 0L) {
                (it.transferredBytes * 100.0 / it.totalBytes).toInt().coerceIn(0, 100)
            } else {
                0
            }
        } ?: 0
        val title = when {
            !transferActive -> "AirBridge is connected"
            speed == null -> "AirBridge transfer in progress"
            speed.uploading -> "AirBridge upload in progress"
            else -> "AirBridge download in progress"
        }
        val prefs = Prefs(this)
        val accessibilityOptIn = prefs.accessibilityClipboardOptIn
        val accessibilityEnabled = accessibilityOptIn &&
            ClipboardAccessibilityService.isEnabled(this)
        val clipboardLine = when {
            accessibilityEnabled ->
                "Background clipboard is on with your Accessibility Service opt-in."
            accessibilityOptIn ->
                "Accessibility opt-in is on. Enable the AirBridge service in Android Settings."
            else ->
                "Background clipboard is on. Hidden clipboard reads may pause; opt in to Accessibility assistance in Settings."
        }
        val text = when {
            !transferActive -> clipboardLine
            speed == null ->
                "Keeping the transfer active while the screen is off. Keep AirBridge open until it completes."
            else -> {
                val label = if (speed.uploading) "Upload" else "Download"
                val eta = speed.etaSeconds?.let { " · ${it}s left" }.orEmpty()
                "$label ${formatSpeed(speed.speedBytesPerSec)} · $percent%$eta"
            }
        }

        builder
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
        if (transferActive) {
            if (speed == null) {
                builder.setProgress(0, 0, true)
            } else {
                builder.setProgress(100, percent, false)
            }
        }
        return builder.build()
    }

    private fun updateTransferWakeLock() {
        val continuity = Prefs(this).connectionContinuity
        if (!transferActive && !continuity) {
            releaseTransferWakeLock()
            return
        }
        if (transferWakeLock?.isHeld == true) return
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        transferWakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "$packageName:AirBridgeTransfer",
        ).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseTransferWakeLock() {
        val lock = transferWakeLock ?: return
        if (lock.isHeld) lock.release()
        transferWakeLock = null
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        clipboardListener?.let { listener ->
            try {
                (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                    .removePrimaryClipChangedListener(listener)
            } catch (_: Exception) {
                // ignore
            }
        }
        clipboardListener = null
        releaseTransferWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.airbridge.app.connection.START"
        const val ACTION_STOP = "com.airbridge.app.connection.STOP"
        const val ACTION_TRANSFER_START = "com.airbridge.app.connection.TRANSFER_START"
        const val ACTION_TRANSFER_STOP = "com.airbridge.app.connection.TRANSFER_STOP"
        const val ACTION_TRANSFER_PROGRESS = "com.airbridge.app.connection.TRANSFER_PROGRESS"
        const val EXTRA_TRANSFER_PROGRESS = "com.airbridge.app.connection.TRANSFER_PROGRESS_JSON"
        private const val CHANNEL_ID = "airbridge_connection"
        private const val NOTIFICATION_ID = 3411

        @Volatile
        private var instance: ConnectionService? = null

        private const val OWN_WRITE_ECHO_WINDOW_MS = 1_500L
        private const val DUPLICATE_EVENT_WINDOW_MS = 400L

        @Volatile
        private var lastOwnClipboardText: String? = null
        @Volatile
        private var lastOwnClipboardAt = 0L
        @Volatile
        private var lastPublishedClipboardText: String? = null
        @Volatile
        private var lastPublishedClipboardAt = 0L

        /** Called by ShellBridge.copyText before it writes an incoming beam. */
        fun markOwnClipboardWrite(text: String) {
            lastOwnClipboardText = text.trim()
            lastOwnClipboardAt = System.currentTimeMillis()
        }

        /**
         * Shared by the foreground-service listener and the optional
         * Accessibility Service. A short window suppresses an incoming-beam
         * echo and duplicate notifications for the same clipboard change; a
         * later re-copy of that text is still forwarded.
         */
        @Synchronized
        fun publishClipboardChange(context: Context, text: String): Boolean {
            if (!Prefs(context).connectionContinuity) {
                lastOwnClipboardText = null
                return false
            }
            val trimmed = text.trim()
            if (trimmed.isEmpty() || trimmed.length > 256_000) return false
            val now = System.currentTimeMillis()
            val own = lastOwnClipboardText
            if (own != null && own == trimmed && now - lastOwnClipboardAt < OWN_WRITE_ECHO_WINDOW_MS) {
                lastOwnClipboardText = null
                lastPublishedClipboardText = trimmed
                lastPublishedClipboardAt = now
                return false // an incoming beam, not a new local copy
            }
            if (trimmed == lastPublishedClipboardText &&
                now - lastPublishedClipboardAt < DUPLICATE_EVENT_WINDOW_MS
            ) {
                return false
            }
            lastPublishedClipboardText = trimmed
            lastPublishedClipboardAt = now
            MainActivity.publishLocalClipboard(trimmed)
            return true
        }

        /**
         * Called from the WebView bridge. Updating an already-foreground
         * service through its live instance avoids Android's background
         * `startService` restrictions when the phone screen is off.
         */
        fun publishTransferSpeed(payloadJson: String): Boolean {
            val service = instance ?: return false
            Handler(Looper.getMainLooper()).post {
                if (instance === service) service.applyTransferSpeed(payloadJson)
            }
            return true
        }

        /** Matches the web UI's `formatSpeed` so both devices show the same number. */
        private fun formatSpeed(bytesPerSec: Double): String {
            if (bytesPerSec.isNaN() || bytesPerSec.isInfinite() || bytesPerSec <= 0.0) {
                return "0 B/s"
            }
            val units = arrayOf("B", "KB", "MB", "GB", "TB")
            val exponent = floor(log(bytesPerSec, 1024.0)).toInt()
                .coerceIn(0, units.lastIndex)
            val value = bytesPerSec / 1024.0.pow(exponent)
            val number = when {
                value >= 100.0 || exponent == 0 -> String.format(Locale.US, "%.0f", value)
                value >= 10.0 -> String.format(Locale.US, "%.1f", value)
                else -> String.format(Locale.US, "%.2f", value)
            }
            return "$number ${units[exponent]}/s"
        }
    }
}
