package com.airbridge.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.TransferView
import com.airbridge.engine.TransferStatus
import com.airbridge.engine.TransferDirection
import java.util.concurrent.Executors
import java.util.Locale
import kotlin.math.floor
import kotlin.math.log
import kotlin.math.pow

/** Owns the native encrypted peer independently of any Activity or WebView. */
class ConnectionService : Service() {
    private var transferActive = false
    private var uiAttached = false
    private var pendingOffers = false
    private var shareUntil = 0L
    private var nativeState = ConnectionState.CONNECTING
    private val offerIds = HashSet<String>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val actions = Executors.newSingleThreadExecutor()
    @Volatile private var engineHost: NativeEngineHost? = null
    private var engineTarget = ""
    private val lockRefresh = object : Runnable {
        override fun run() {
            if (transferActive) updateTransferWakeLock()
        }
    }
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
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
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
            ACTION_SHARE_TEXT -> {
                shareUntil = android.os.SystemClock.elapsedRealtime() + 30_000
                mainHandler.postDelayed({ if (shouldStopWhenIdle()) stopSelf() }, 30_100)
            }
            ACTION_UI_ATTACH -> uiAttached = true
            ACTION_UI_DETACH -> uiAttached = false
            ACTION_TRANSFER_START -> if (engineHost == null) { transferActive = true; transferSpeed = null }
            ACTION_TRANSFER_STOP -> if (engineHost == null) { transferActive = false; transferSpeed = null }
            ACTION_TRANSFER_PROGRESS -> if (engineHost == null) applyTransferSpeed(intent.getStringExtra(EXTRA_TRANSFER_PROGRESS).orEmpty())
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

        ensureEngine()
        when (intent?.action) {
            ACTION_ACCEPT, ACTION_DECLINE -> {
                val id = intent.getStringExtra(EXTRA_TRANSFER_ID).orEmpty()
                val method = if (intent.action == ACTION_ACCEPT) "accept" else "decline"
                getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(id))
                actions.execute { engineHost?.command(JSONObject().put("method", method).put("transferId", id).toString()) }
            }
            ACTION_SHARE_TEXT -> engineHost?.publishLocalClipboard(intent.getStringExtra(EXTRA_CLIPBOARD_TEXT).orEmpty(), explicit = true)
        }
        if (shouldStopWhenIdle()) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        return if (Prefs(this).connectionContinuity) START_STICKY else START_NOT_STICKY
    }

    /**
     * Android 10+ can suppress clipboard reads while the app is backgrounded.
     * The listener still fires when the OS allows it; failures are swallowed so
     * the foreground service (and the encrypted session) stay alive.
     */
    private fun publishSystemClipboard(clipboard: ClipboardManager) {
        val text = try {
            val clip = clipboard.primaryClip
            if (clip == null || clip.itemCount == 0 || !clip.description.hasMimeType("text/*")) return
            if (clip.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true) return
            clip.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
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
            ?.notify(NOTIFICATION_ID, buildNotification())
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
            !transferActive && nativeState == ConnectionState.CONNECTED -> "AirBridge is connected"
            !transferActive -> "AirBridge is reconnecting"
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
                "Native connection active. Android may block clipboard reads; use Share → AirBridge when needed."
            accessibilityOptIn ->
                "Accessibility opt-in is on. Enable the AirBridge service in Android Settings."
            else ->
                "Native connection active. Incoming clipboard works here; Android may restrict copying from other apps."
        }
        val text = when {
            !transferActive && nativeState != ConnectionState.CONNECTED -> "Waiting for your paired computer on the same network."
            !transferActive -> clipboardLine
            speed == null ->
                "Native transfer continues when you switch apps or turn the screen off."
            else -> {
                val label = if (speed.uploading) "Upload" else "Download"
                val eta = speed.etaSeconds?.let { " · ${it}s left" }.orEmpty()
                "$label ${formatSpeed(speed.speedBytesPerSec)} · $percent%$eta"
            }
        }

        builder
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
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

    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null

    private fun updateTransferWakeLock() {
        val shouldHold = transferActive
        if (!shouldHold) {
            releaseTransferWakeLock()
            return
        }
        if (transferWakeLock?.isHeld == true) transferWakeLock?.acquire(10 * 60_000L)
        if (transferWakeLock?.isHeld != true) {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            transferWakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "$packageName:AirBridgeTransfer",
            ).apply {
                setReferenceCounted(false)
                acquire(10 * 60_000L)
            }
        }
        if (wifiLock?.isHeld != true) try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wifiManager.createWifiLock(
                android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                "$packageName:AirBridgeWifi",
            ).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: SecurityException) {
            Log.w("AirBridgePower", "Wi-Fi performance lock unavailable: ${e.message}")
            wifiLock = null
        }
        mainHandler.removeCallbacks(lockRefresh)
        mainHandler.postDelayed(lockRefresh, 60_000)
    }

    private fun releaseTransferWakeLock() {
        mainHandler.removeCallbacks(lockRefresh)
        val cpuLock = transferWakeLock
        if (cpuLock?.isHeld == true) runCatching { cpuLock.release() }
        transferWakeLock = null

        val lock = wifiLock
        if (lock?.isHeld == true) runCatching { lock.release() }
        wifiLock = null
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        val host = engineHost
        engineHost = null
        // Shutdown is potentially waiting on disk IO. Never block the main
        // thread or retain an Activity while descriptors and sockets close.
        actions.execute { host?.close() }
        actions.shutdown()
        mainHandler.removeCallbacksAndMessages(null)
        for (id in offerIds) getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(id))
        offerIds.clear()
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

    private fun shouldStopWhenIdle(): Boolean = !transferActive && !pendingOffers && !uiAttached &&
        !Prefs(this).connectionContinuity && android.os.SystemClock.elapsedRealtime() >= shareUntil

    private fun ensureEngine() {
        val target = Prefs(this).target
        if (target.isEmpty()) return
        if (engineHost != null && engineTarget == target) return
        val old = engineHost
        if (old != null) actions.execute { old.close() }
        engineTarget = target
        engineHost = NativeEngineHost(applicationContext, { transfers ->
            mainHandler.post {
                if (instance !== this || engineTarget != target) return@post
                transferActive = transfers.any { it.status == TransferStatus.TRANSFERRING || it.status == TransferStatus.CONNECTING }
                pendingOffers = transfers.any { it.status == TransferStatus.PENDING_ACCEPT }
                val active = transfers.firstOrNull { it.status == TransferStatus.TRANSFERRING }
                transferSpeed = active?.let { TransferSpeedSnapshot(it.direction == TransferDirection.OUTGOING,
                    it.speedBytesPerSec, it.transferredBytes, it.totalBytes, it.etaSeconds) }
                for (view in transfers) if (view.status != TransferStatus.PENDING_ACCEPT && offerIds.remove(view.transferId)) {
                    getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(view.transferId))
                }
                updateTransferWakeLock()
                getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification())
                if (shouldStopWhenIdle()) stopSelf()
            }
        }, { offer ->
            mainHandler.post {
                if (instance !== this || engineTarget != target) return@post
                pendingOffers = true
                showIncomingOffer(offer)
            }
        }, { state ->
            mainHandler.post {
                if (instance === this && engineTarget == target) {
                    nativeState = state
                    getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification())
                }
            }
        })
    }

    private fun showIncomingOffer(offer: TransferView) {
        offerIds.add(offer.transferId)
        fun decision(action: String): PendingIntent = PendingIntent.getService(
            this, offer.transferId.hashCode(), Intent(this, ConnectionService::class.java)
                .setAction(action).putExtra(EXTRA_TRANSFER_ID, offer.transferId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
            else @Suppress("DEPRECATION") Notification.Builder(this)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = builder.setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Files from ${offer.peerName}")
            .setContentText("${offer.files.size} file(s) · ${com.airbridge.engine.formatBytes(offer.totalBytes)} · Verify ${offer.sasCode}")
            .setContentIntent(open).setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, "Accept", decision(ACTION_ACCEPT)).build())
            .addAction(Notification.Action.Builder(null, "Decline", decision(ACTION_DECLINE)).build())
            .build()
        getSystemService(NotificationManager::class.java)?.notify(offerNotificationId(offer.transferId), notification)
    }

    private fun offerNotificationId(id: String): Int = id.hashCode() or 0x40000000

    companion object {
        const val ACTION_UI_ATTACH = "com.airbridge.app.connection.UI_ATTACH"
        const val ACTION_UI_DETACH = "com.airbridge.app.connection.UI_DETACH"
        const val ACTION_ACCEPT = "com.airbridge.app.connection.ACCEPT"
        const val ACTION_DECLINE = "com.airbridge.app.connection.DECLINE"
        const val ACTION_SHARE_TEXT = "com.airbridge.app.connection.SHARE_TEXT"
        const val EXTRA_TRANSFER_ID = "transferId"
        const val EXTRA_CLIPBOARD_TEXT = "clipboardText"
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

        fun nativeSnapshot(version: Long, clipboardVersion: Long): String =
            instance?.engineHost?.snapshotSince(version, clipboardVersion) ?: "{\"ready\":false}"
        fun nativeCommand(raw: String): String = instance?.engineHost?.command(raw)
            ?: "{\"ok\":false,\"error\":\"Native connection is starting\"}"

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
            val host = instance?.engineHost ?: return false
            host.publishLocalClipboard(text)
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
