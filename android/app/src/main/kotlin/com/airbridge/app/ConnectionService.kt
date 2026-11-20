package com.airbridge.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.TransferDirection
import com.airbridge.engine.TransferStatus
import com.airbridge.engine.TransferView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.log
import kotlin.math.pow

/**
 * Pure policy & cumulative duration tracker for transfer-only WakeLock and WifiLock.
 *
 * Ensures CPU partial wake locks and low-latency Wi-Fi locks are held strictly
 * while a transfer is active (`transferActive == true`), never while idle in
 * `connectionContinuity` standby.
 */
class TransferLockPolicy(
    private val clockMs: () -> Long = { SystemClock.elapsedRealtime() },
) {
    private var wakeHeldSinceMs: Long? = null
    private var wifiHeldSinceMs: Long? = null
    private var accumulatedWakeMs: Long = 0L
    private var accumulatedWifiMs: Long = 0L

    val isWakeHeld: Boolean
        @Synchronized get() = wakeHeldSinceMs != null

    val isWifiHeld: Boolean
        @Synchronized get() = wifiHeldSinceMs != null

    @Synchronized
    fun shouldHoldLocks(transferActive: Boolean, @Suppress("UNUSED_PARAMETER") connectionContinuity: Boolean): Boolean =
        transferActive

    @Synchronized
    fun onWakeLockAcquired() {
        if (wakeHeldSinceMs == null) {
            wakeHeldSinceMs = clockMs()
        }
    }

    @Synchronized
    fun onWifiLockAcquired() {
        if (wifiHeldSinceMs == null) {
            wifiHeldSinceMs = clockMs()
        }
    }

    @Synchronized
    fun onLocksReleased() {
        val now = clockMs()
        wakeHeldSinceMs?.let { since ->
            accumulatedWakeMs += (now - since).coerceAtLeast(0L)
            wakeHeldSinceMs = null
        }
        wifiHeldSinceMs?.let { since ->
            accumulatedWifiMs += (now - since).coerceAtLeast(0L)
            wifiHeldSinceMs = null
        }
    }

    @Synchronized
    fun totalWakeLockHeldMs(): Long {
        val active = wakeHeldSinceMs?.let { (clockMs() - it).coerceAtLeast(0L) } ?: 0L
        return accumulatedWakeMs + active
    }

    @Synchronized
    fun totalWifiLockHeldMs(): Long {
        val active = wifiHeldSinceMs?.let { (clockMs() - it).coerceAtLeast(0L) } ?: 0L
        return accumulatedWifiMs + active
    }
}

/** Owns the native encrypted peer independently of any Activity. */
class ConnectionService : Service() {
    private var transferActive = false
    @Volatile private var uiAttached = false
    private var pendingOffers = false
    private var shareUntil = 0L
    private var nativeState = ConnectionState.CONNECTING
    private val offerIds = HashSet<String>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val actions = Executors.newSingleThreadExecutor()
    @Volatile private var engineHost: NativeEngineHost? = null
    /** [com.airbridge.engine.PairingInvitationStore.engineKey] of the running engine; a rescan changes it. */
    private var engineTarget = ""
    @Volatile private var engineGeneration = 0L
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var wifiNetworkCallback: ConnectivityManager.NetworkCallback? = null
    private var networkCallbackPrimed = false
    private var wifiCallbackPrimed = false
    private var defaultNetwork: Network? = null
    private var wifiNetwork: Network? = null
    private var lockRefreshScheduled = false
    private var notificationScheduled = false
    private val notificationRefresh = Runnable {
        notificationScheduled = false
        if (instance === this) runCatching {
            getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun refreshNotification(immediate: Boolean = false) {
        if (immediate) {
            mainHandler.removeCallbacks(notificationRefresh)
            notificationRefresh.run()
        } else if (!notificationScheduled) {
            notificationScheduled = true
            mainHandler.postDelayed(notificationRefresh, 1_000)
        }
    }
    private val lockRefresh = object : Runnable {
        override fun run() {
            lockRefreshScheduled = false
            if (lockPolicy.shouldHoldLocks(transferActive, Prefs(this@ConnectionService).connectionContinuity)) {
                updateTransferWakeLock()
            } else {
                releaseTransferWakeLock()
            }
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
        AndroidDiagnostics.installUncaughtExceptionHandler(this)
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
        val connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val defaultCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val previousNetwork = defaultNetwork
                val changed = previousNetwork != null && previousNetwork != network
                defaultNetwork = network
                AndroidDiagnostics.defaultNetworkPresent = true
                // The first callback after registering only reports the current
                // network; reconnecting then would abort the engine's first dial
                // mid-flight (a silent CANCELLED). Reconnect only on a real switch
                // or when a network comes back after being lost.
                val firstReport = !networkCallbackPrimed
                networkCallbackPrimed = true
                if (!firstReport && (changed || previousNetwork == null || nativeState == ConnectionState.RECONNECTING)) {
                    AndroidDiagnostics.recordNetworkReconnectTrigger()
                    AndroidDiagnostics.recordEvent("network", "Default network available ($network); triggering reconnect")
                    engineHost?.reconnect()
                }
                if (transferActive) updateTransferWakeLock()
            }
            override fun onLost(network: Network) {
                if (defaultNetwork == network) {
                    defaultNetwork = null
                    AndroidDiagnostics.defaultNetworkPresent = false
                }
            }
        }
        try {
            connectivity.registerDefaultNetworkCallback(defaultCallback, mainHandler)
            networkCallback = defaultCallback
        } catch (e: Exception) {
            Log.w("AirBridgeNetwork", "Network recovery callback unavailable: ${e.message}")
        }

        // Also monitor TRANSPORT_WIFI explicitly so non-default Wi-Fi or local-only hotspot
        // transitions trigger immediate engine endpoint re-evaluation even while cellular is default.
        val wifiCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val previousWifi = wifiNetwork
                val changed = previousWifi != null && previousWifi != network
                wifiNetwork = network
                AndroidDiagnostics.wifiNetworkPresent = true
                val firstReport = !wifiCallbackPrimed
                wifiCallbackPrimed = true
                if (!firstReport && (changed || previousWifi == null) && network != defaultNetwork) {
                    AndroidDiagnostics.recordNetworkReconnectTrigger()
                    AndroidDiagnostics.recordEvent("network", "Wi-Fi transport available ($network); triggering reconnect")
                    engineHost?.reconnect()
                }
            }
            override fun onLost(network: Network) {
                if (wifiNetwork == network) {
                    wifiNetwork = null
                    AndroidDiagnostics.wifiNetworkPresent = false
                }
            }
        }
        try {
            val wifiRequest = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build()
            connectivity.registerNetworkCallback(wifiRequest, wifiCallback, mainHandler)
            wifiNetworkCallback = wifiCallback
        } catch (e: Exception) {
            Log.w("AirBridgeNetwork", "Wi-Fi transport callback unavailable: ${e.message}")
        }

        val channel = NotificationChannel(
            CHANNEL_ID,
            "AirBridge connection and transfers",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Keeps AirBridge connected and shows live transfer speed" }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    @Volatile private var foregroundStarted = false

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val fgsType = if (transferActive) {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            }
            startForeground(NOTIFICATION_ID, notification, fgsType)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        foregroundStarted = true
        AndroidDiagnostics.fgsPromoted = true
        AndroidDiagnostics.fgsLastStartError = null
    }

    private fun stopForegroundAndSelf(startId: Int? = null) {
        foregroundStarted = false
        AndroidDiagnostics.fgsPromoted = false
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        if (startId != null) stopSelf(startId) else stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                transferActive = false
                pendingOffers = false
                transferSpeed = null
                releaseTransferWakeLock()
                // If an external or legacy caller started us with startForegroundService(ACTION_STOP),
                // Android requires startForeground() before stopSelf() to avoid ForegroundServiceDidNotStartInTimeException.
                if (!foregroundStarted) {
                    runCatching { startForegroundCompat(buildNotification()) }
                }
                stopForegroundAndSelf(startId)
                return START_NOT_STICKY
            }
            ACTION_SHARE_TEXT -> {
                shareUntil = SystemClock.elapsedRealtime() + 60_000
                mainHandler.postDelayed({ if (shouldStopWhenIdle()) stopForegroundAndSelf() }, 60_100)
            }
            ACTION_UI_ATTACH -> uiAttached = true
            ACTION_UI_DETACH -> uiAttached = false
        }

        updateTransferWakeLock()
        val notification = buildNotification()
        val promoted = runCatching {
            startForegroundCompat(notification)
            true
        }.getOrElse { err ->
            Log.w("AirBridgeService", "startForeground unavailable: ${err.message}")
            AndroidDiagnostics.fgsLastStartError = err.message ?: err.javaClass.simpleName
            AndroidDiagnostics.recordEvent("fgs", "startForeground failed: ${err.message}", "WARN")
            foregroundStarted
        }
        // AND-06: If startForegroundCompat() fails and !foregroundStarted, ALWAYS call
        // stopSelf(startId) and return START_NOT_STICKY so Android never crashes the app
        // with ForegroundServiceDidNotStartInTimeException.
        if (!promoted && !foregroundStarted) {
            releaseTransferWakeLock()
            stopSelf(startId)
            return START_NOT_STICKY
        }

        ensureEngine()
        when (intent?.action) {
            ACTION_ACCEPT -> {
                val id = intent.getStringExtra(EXTRA_TRANSFER_ID).orEmpty()
                getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(id))
                actions.execute { engineHost?.acceptTransfer(id) }
            }
            ACTION_DECLINE -> {
                val id = intent.getStringExtra(EXTRA_TRANSFER_ID).orEmpty()
                getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(id))
                actions.execute { engineHost?.declineTransfer(id) }
            }
            ACTION_SHARE_TEXT -> engineHost?.publishLocalClipboard(intent.getStringExtra(EXTRA_CLIPBOARD_TEXT).orEmpty(), explicit = true)
        }
        if (shouldStopWhenIdle()) {
            stopForegroundAndSelf(startId)
            return START_NOT_STICKY
        }
        return if (Prefs(this).connectionContinuity) START_STICKY else START_NOT_STICKY
    }

    @SuppressLint("InlinedApi")
    override fun onTimeout(startId: Int) {
        Log.w("AirBridgeService", "Foreground service timeout reached (API 34+): startId=$startId")
        AndroidDiagnostics.recordFgsTimeout()
        AndroidDiagnostics.recordEvent("fgs", "Foreground service timeout reached (startId=$startId)", "WARN")
        handleFgsTimeout(startId, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w("AirBridgeService", "Foreground service timeout reached (API 35+): startId=$startId type=$fgsType")
        AndroidDiagnostics.recordFgsTimeout()
        AndroidDiagnostics.recordEvent("fgs", "Foreground service timeout reached (startId=$startId type=$fgsType)", "WARN")
        handleFgsTimeout(startId, fgsType)
    }

    @SuppressLint("InlinedApi")
    private fun handleFgsTimeout(
        startId: Int,
        fgsType: Int = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    ) {
        val prefs = Prefs(this)
        val shouldStayAlive = prefs.connectionContinuity || uiAttached
        val isDataSync = fgsType == 0 ||
            (fgsType and android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) != 0

        // If dataSync timed out while connection continuity is desired (or transfers finished),
        // demote back to FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE without terminating the companion service.
        if (isDataSync && (shouldStayAlive || !transferActive)) {
            Log.i("AirBridgeService", "Demoting dataSync foreground service type on timeout; maintaining connectedDevice")
            transferActive = false
            pendingOffers = false
            transferSpeed = null
            updateTransferWakeLock()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                runCatching {
                    startForeground(
                        NOTIFICATION_ID,
                        buildNotification(),
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                    )
                }.onFailure { err ->
                    Log.w("AirBridgeService", "Failed to demote FGS type to connectedDevice: ${err.message}")
                }
            } else {
                refreshNotification(immediate = true)
            }
            if (shouldStopWhenIdle()) {
                stopForegroundAndSelf(startId)
            }
            return
        }

        Log.w("AirBridgeService", "Stopping service on FGS timeout: startId=$startId fgsType=$fgsType")
        transferActive = false
        pendingOffers = false
        transferSpeed = null
        releaseTransferWakeLock()
        stopForegroundAndSelf(startId)
    }

    /**
     * Android 10+ can suppress clipboard reads while the app is backgrounded.
     * The listener still fires when the OS allows it; failures are swallowed so
     * the foreground service (and the encrypted session) stay alive.
     */
    private fun publishSystemClipboard(clipboard: ClipboardManager) {
        if (isOwnImageSuppressed(SystemClock.elapsedRealtime())) {
            AndroidDiagnostics.recordClipboardImageSuppressedEcho()
            return
        }
        val clip = runCatching { clipboard.primaryClip }.getOrNull()
        val desc = clip?.description
        if (desc != null && (desc.hasMimeType("image/*") || !desc.hasMimeType("text/*"))) {
            return
        }
        ClipboardText.read(this)?.let { publishClipboardChange(this, it) }
    }

    private fun buildNotification(): Notification {
        val builder = Notification.Builder(this, CHANNEL_ID)
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
        val clipboardLine =
            "Native connection active. Incoming clipboard works here; Android may restrict copies from other apps. Use Share → AirBridge when needed."
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
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    0,
                    Intent(this, MainActivity::class.java).setPackage(packageName),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
        if (!transferActive && nativeState == ConnectionState.CONNECTED) {
            val beamPending = PendingIntent.getActivity(
                this,
                BEAM_CLIPBOARD_REQUEST_CODE,
                Intent(this, ClipboardBeamActivity::class.java)
                    .setPackage(packageName)
                    .setAction(ACTION_BEAM_CLIPBOARD)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(Notification.Action.Builder(null, "Beam clipboard", beamPending).build())
        }
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
        val prefs = Prefs(this)
        // AND-07: Hold PARTIAL_WAKE_LOCK and WIFI_MODE_FULL_LOW_LATENCY ONLY while transferActive is true.
        val shouldHold = lockPolicy.shouldHoldLocks(transferActive, prefs.connectionContinuity)
        if (!shouldHold) {
            releaseTransferWakeLock()
            return
        }
        val wakeTimeoutMs = 10 * 60_000L
        var cpuLock = transferWakeLock
        if (cpuLock == null) {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            cpuLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "$packageName:AirBridgeTransfer",
            ).apply {
                setReferenceCounted(false)
            }
            transferWakeLock = cpuLock
        }
        runCatching {
            cpuLock.acquire(wakeTimeoutMs)
            lockPolicy.onWakeLockAcquired()
        }
        if (wifiLock?.isHeld != true) try {
            var lock = wifiLock
            if (lock == null) {
                val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
                val wifiMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    @Suppress("DEPRECATION")
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                @Suppress("DEPRECATION")
                lock = wifiManager.createWifiLock(
                    wifiMode,
                    "$packageName:AirBridgeWifi",
                ).apply {
                    setReferenceCounted(false)
                }
                wifiLock = lock
            }
            lock.acquire()
            lockPolicy.onWifiLockAcquired()
        } catch (e: SecurityException) {
            Log.w("AirBridgePower", "Wi-Fi performance lock unavailable: ${e.message}")
            wifiLock = null
        }
        if (!lockRefreshScheduled) {
            lockRefreshScheduled = true
            mainHandler.postDelayed(lockRefresh, 60_000)
        }
    }

    private fun releaseTransferWakeLock() {
        mainHandler.removeCallbacks(lockRefresh)
        lockRefreshScheduled = false
        val cpuLock = transferWakeLock
        if (cpuLock?.isHeld == true) runCatching { cpuLock.release() }
        transferWakeLock = null

        val lock = wifiLock
        if (lock?.isHeld == true) runCatching { lock.release() }
        wifiLock = null
        lockPolicy.onLocksReleased()
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
            sharedUiState.value = NativeEngineUiState()
        }
        foregroundStarted = false
        AndroidDiagnostics.fgsPromoted = false
        engineGeneration++
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkCallback?.let { callback ->
            runCatching { cm?.unregisterNetworkCallback(callback) }
        }
        networkCallback = null
        wifiNetworkCallback?.let { callback ->
            runCatching { cm?.unregisterNetworkCallback(callback) }
        }
        wifiNetworkCallback = null
        AndroidDiagnostics.defaultNetworkPresent = false
        AndroidDiagnostics.wifiNetworkPresent = false
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
        !Prefs(this).connectionContinuity && SystemClock.elapsedRealtime() >= shareUntil

    private fun ensureEngine() {
        val prefs = Prefs(this)
        val target = prefs.target
        if (target.isEmpty()) return
        // Restart for a new invitation even when the computer's address is
        // unchanged: rescanning the same Mac with a fresh code (or new QR
        // alternates/pin) must be consumed now, not left staged and replayed
        // by some later restart.
        val key = prefs.invitations.engineKey
        if (engineHost != null && engineTarget == key) return
        val old = engineHost
        if (old != null) actions.execute { old.close() }
        engineTarget = key
        nativeState = ConnectionState.CONNECTING
        transferActive = false
        pendingOffers = false
        transferSpeed = null
        updateTransferWakeLock()
        for (id in offerIds) getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(id))
        offerIds.clear()
        val generation = ++engineGeneration
        engineHost = NativeEngineHost(applicationContext, { transfers ->
            mainHandler.post {
                if (instance !== this || engineGeneration != generation) return@post
                val previousActive = transferActive
                transferActive = transfers.any { it.status == TransferStatus.TRANSFERRING || it.status == TransferStatus.CONNECTING }
                pendingOffers = transfers.any { it.status == TransferStatus.PENDING_ACCEPT }
                val active = transfers.firstOrNull { it.status == TransferStatus.TRANSFERRING }
                transferSpeed = active?.let {
                    TransferSpeedSnapshot(
                        it.direction == TransferDirection.OUTGOING,
                        it.speedBytesPerSec,
                        it.transferredBytes,
                        it.totalBytes,
                        it.etaSeconds,
                    )
                }
                for (view in transfers) if (view.status != TransferStatus.PENDING_ACCEPT && offerIds.remove(view.transferId)) {
                    getSystemService(NotificationManager::class.java)?.cancel(offerNotificationId(view.transferId))
                }
                updateTransferWakeLock()
                if (previousActive != transferActive && foregroundStarted) {
                    runCatching { startForegroundCompat(buildNotification()) }
                } else {
                    refreshNotification()
                }
                if (shouldStopWhenIdle()) stopForegroundAndSelf()
            }
        }, { offer ->
            mainHandler.post {
                if (instance !== this || engineGeneration != generation) return@post
                pendingOffers = true
                showIncomingOffer(offer)
            }
        }, { state ->
            mainHandler.post {
                if (instance === this && engineGeneration == generation) {
                    nativeState = state
                    refreshNotification(immediate = true)
                }
            }
        }, { uiSnapshot ->
            if (instance === this && engineGeneration == generation) {
                sharedUiState.value = uiSnapshot
            }
        })
    }

    private fun offerRequestCode(transferId: String, action: String): Int =
        (transferId.hashCode() * 31) xor action.hashCode()

    private fun showIncomingOffer(offer: TransferView) {
        offerIds.add(offer.transferId)
        fun decision(action: String): PendingIntent = PendingIntent.getService(
            this,
            offerRequestCode(offer.transferId, action),
            Intent(this, ConnectionService::class.java)
                .setPackage(packageName)
                .setAction(action)
                .putExtra(EXTRA_TRANSFER_ID, offer.transferId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = Notification.Builder(this, CHANNEL_ID)
        val open = PendingIntent.getActivity(
            this,
            offerRequestCode(offer.transferId, "OPEN"),
            Intent(this, MainActivity::class.java).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
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
        private const val BEAM_CLIPBOARD_REQUEST_CODE = 3420
        const val ACTION_UI_ATTACH = "com.airbridge.app.connection.UI_ATTACH"
        const val ACTION_UI_DETACH = "com.airbridge.app.connection.UI_DETACH"
        const val ACTION_ACCEPT = "com.airbridge.app.connection.ACCEPT"
        const val ACTION_DECLINE = "com.airbridge.app.connection.DECLINE"
        const val ACTION_SHARE_TEXT = "com.airbridge.app.connection.SHARE_TEXT"
        const val ACTION_BEAM_CLIPBOARD = "com.airbridge.app.connection.BEAM_CLIPBOARD"
        const val EXTRA_TRANSFER_ID = "transferId"
        const val EXTRA_CLIPBOARD_TEXT = "clipboardText"
        const val ACTION_START = "com.airbridge.app.connection.START"
        const val ACTION_STOP = "com.airbridge.app.connection.STOP"
        private const val CHANNEL_ID = "airbridge_connection"
        private const val NOTIFICATION_ID = 3411

        @Volatile
        private var instance: ConnectionService? = null

        internal val lockPolicy = TransferLockPolicy()

        private val sharedUiState = MutableStateFlow(NativeEngineUiState())
        val uiState: StateFlow<NativeEngineUiState> = sharedUiState.asStateFlow()

        fun currentHost(): NativeEngineHost? = instance?.engineHost

        fun isForegroundPromoted(): Boolean = instance?.foregroundStarted == true

        fun isUiAttached(): Boolean = instance?.uiAttached == true

        fun currentEngineGeneration(): Long = instance?.engineGeneration ?: 0L

        fun totalWakeLockHeldMs(): Long = lockPolicy.totalWakeLockHeldMs()

        fun totalWifiLockHeldMs(): Long = lockPolicy.totalWifiLockHeldMs()

        fun isWakeLockHeld(): Boolean = lockPolicy.isWakeHeld

        fun isWifiLockHeld(): Boolean = lockPolicy.isWifiHeld

        /**
         * AND-17: In-process UI detach callable directly from `MainActivity.onStop()`
         * without calling `startService(ACTION_UI_DETACH)` while backgrounding.
         */
        fun detachUi() {
            val service = instance ?: return
            service.uiAttached = false
            service.mainHandler.post {
                if (instance === service && service.shouldStopWhenIdle()) {
                    service.stopForegroundAndSelf()
                }
            }
        }

        private const val OWN_WRITE_ECHO_WINDOW_MS = 1_500L
        private const val OWN_IMAGE_ECHO_WINDOW_MS = 4_000L
        private const val DUPLICATE_EVENT_WINDOW_MS = 400L

        @Volatile
        private var lastOwnClipboardText: String? = null
        @Volatile
        private var lastOwnClipboardAt = 0L
        @Volatile
        private var lastOwnClipboardImageAt = 0L
        @Volatile
        private var lastPublishedClipboardText: String? = null
        @Volatile
        private var lastPublishedClipboardAt = 0L

        /** Called before writing an incoming beam into ClipboardManager. */
        fun markOwnClipboardWrite(text: String) {
            lastOwnClipboardText = text
            lastOwnClipboardAt = SystemClock.elapsedRealtime()
        }

        /** Called before/after copying an incoming image into ClipboardManager to block text/URI echo. */
        fun markOwnClipboardImageWrite() {
            lastOwnClipboardImageAt = SystemClock.elapsedRealtime()
        }

        internal fun isOwnImageSuppressed(nowElapsedMs: Long): Boolean {
            val at = lastOwnClipboardImageAt
            return at > 0L && nowElapsedMs - at < OWN_IMAGE_ECHO_WINDOW_MS
        }

        /**
         * Shared by foreground clipboard events and explicit Share / Paste
         * actions. A short window suppresses an incoming-beam echo and a
         * duplicate event; a later re-copy of that text is still forwarded.
         */
        @Synchronized
        fun publishClipboardChange(context: Context, text: String, explicit: Boolean = false): Boolean {
            val service = instance ?: return false
            val host = service.engineHost ?: return false
            if (!explicit && !Prefs(context).connectionContinuity && !service.uiAttached) return false
            if (text.isBlank() || text.length > com.airbridge.engine.Limits.MAX_CLIPBOARD_TEXT) return false
            val now = SystemClock.elapsedRealtime()
            val own = lastOwnClipboardText
            if (!explicit && own != null && own == text && now - lastOwnClipboardAt < OWN_WRITE_ECHO_WINDOW_MS) {
                lastPublishedClipboardText = text
                lastPublishedClipboardAt = now
                return false // an incoming beam, not a new local copy
            }
            if (!explicit && text == lastPublishedClipboardText &&
                now - lastPublishedClipboardAt < DUPLICATE_EVENT_WINDOW_MS
            ) {
                return false
            }
            lastPublishedClipboardText = text
            lastPublishedClipboardAt = now
            host.publishLocalClipboard(text, explicit)
            return true
        }

        fun captureClipboard(context: Context) {
            ClipboardText.read(context)?.let { publishClipboardOrStart(context, it) }
        }

        /**
         * Publish a background clipboard change immediately if the foreground service
         * is live, or start the foreground service with `ACTION_SHARE_TEXT` so the
         * copy is queued and sent as soon as the service connects.
         */
        fun publishClipboardOrStart(context: Context, text: String, explicit: Boolean = false): Boolean {
            if (publishClipboardChange(context, text, explicit)) return true
            if (instance != null && !explicit) return false
            val prefs = Prefs(context)
            if (!explicit && !prefs.connectionContinuity) return false
            if (text.isBlank() || text.length > com.airbridge.engine.Limits.MAX_CLIPBOARD_TEXT) return false
            val now = SystemClock.elapsedRealtime()
            val own = lastOwnClipboardText
            if (!explicit && own != null && own == text && now - lastOwnClipboardAt < OWN_WRITE_ECHO_WINDOW_MS) return false
            return runCatching {
                val intent = Intent(context, ConnectionService::class.java)
                    .setPackage(context.packageName)
                    .setAction(ACTION_SHARE_TEXT)
                    .putExtra(EXTRA_CLIPBOARD_TEXT, text)
                context.startForegroundService(intent)
                true
            }.getOrDefault(false)
        }

        /** Matches the desktop UI's `formatSpeed` so both devices show the same number. */
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
