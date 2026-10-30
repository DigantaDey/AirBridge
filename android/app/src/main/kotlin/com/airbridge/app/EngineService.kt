package com.airbridge.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.airbridge.engine.AirBridgeEngine
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.EngineConfig
import com.airbridge.engine.EngineListener
import com.airbridge.engine.TransferView

/**
 * Foreground service owning the [AirBridgeEngine]: keeps transfers alive when
 * the UI goes away and hosts the offer notifications (Accept/Decline actions
 * come back through [onStartCommand]).
 */
class EngineService : Service() {

    private lateinit var prefs: Prefs
    private var engine: AirBridgeEngine? = null
    private lateinit var sinks: Sinks
    private val main = Handler(Looper.getMainLooper())
    private var connectedUrl: String? = null
    @Volatile private var lastState: ConnectionState = ConnectionState.DISCONNECTED

    private val engineListener = object : EngineListener {
        override fun onConnectionState(state: ConnectionState) {
            lastState = state
            updateOngoingNotification()
        }
        override fun onIncomingOffer(transfer: TransferView) {
            notifyOffer(transfer)
        }
        override fun onError(code: String, message: String) {
            // Surfaced through the ongoing notification text on failure states.
            updateOngoingNotification()
        }
    }

    override fun onCreate() {
        super.onCreate()
        current = this
        prefs = Prefs(this)
        sinks = Sinks(this)
        ensureChannel()
        startInForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val transferId = intent?.getStringExtra(EXTRA_TRANSFER_ID)
        when (intent?.action) {
            ACTION_ACCEPT -> {
                transferId?.let { id ->
                    engine?.acceptIncomingTransfer(id)
                    cancelOfferNotification(id)
                }
            }
            ACTION_DECLINE -> {
                transferId?.let { id ->
                    engine?.declineIncomingTransfer(id)
                    cancelOfferNotification(id)
                }
            }
            ACTION_CONNECT -> {
                val url = intent.getStringExtra(EXTRA_URL)
                if (!url.isNullOrBlank()) connect(url)
            }
            ACTION_DISCONNECT -> disconnect()
        }
        updateOngoingNotification()
        return START_STICKY
    }

    private fun connect(url: String) {
        if (connectedUrl == url && engine != null) return
        engine?.stop()
        val config = EngineConfig(
            serverUrl = url,
            deviceName = prefs.deviceName,
            deviceId = prefs.deviceId,
            peerId = prefs.peerId,
            visibility = prefs.visibility,
            autoAcceptAll = false,
            trustAllTls = true,
            defaultSinkFactory = sinks.createFactory(),
        )
        engine = AirBridgeEngine(config).also { e ->
            e.addListener(engineListener)
            e.start()
        }
        connectedUrl = url
        prefs.serverUrl = url
        updateOngoingNotification()
    }

    private fun disconnect() {
        engine?.stop()
        engine = null
        connectedUrl = null
        updateOngoingNotification()
    }

    private fun notifyOffer(transfer: TransferView) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val open = PendingIntent.getActivity(
            this, idKey(transfer.transferId).hashCode(),
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val accept = actionPendingIntent(ACTION_ACCEPT, transfer.transferId, 1)
        val decline = actionPendingIntent(ACTION_DECLINE, transfer.transferId, 2)
        val n = Notification.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Incoming transfer from ${transfer.peerName}")
            .setContentText(
                "${transfer.files.size} file(s), " +
                    com.airbridge.engine.formatBytes(transfer.totalBytes),
            )
            .setContentIntent(open)
            .setAutoCancel(true)
            .addAction(
                Notification.Action.Builder(null, "Accept", accept).build(),
            )
            .addAction(
                Notification.Action.Builder(null, "Decline", decline).build(),
            )
            .build()
        nm.notify(idKey(transfer.transferId).hashCode(), n)
    }

    private fun actionPendingIntent(action: String, transferId: String, reqCode: Int): PendingIntent {
        val i = Intent(this, EngineService::class.java)
            .setAction(action)
            .putExtra(EXTRA_TRANSFER_ID, transferId)
        return PendingIntent.getService(
            this, reqCode * 1000 + idKey(transferId).hashCode().and(0xffff),
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun cancelOfferNotification(key: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(key.hashCode())
    }

    private fun startInForeground() {
        val n = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIF_SERVICE_ID, n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIF_SERVICE_ID, n)
        }
    }

    private fun updateOngoingNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        try {
            nm.notify(NOTIF_SERVICE_ID, buildOngoingNotification())
        } catch (_: Exception) {
        }
    }

    private fun buildOngoingNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val subtitle = when (lastState) {
            ConnectionState.CONNECTED -> "Connected to ${connectedUrl ?: "server"}"
            ConnectionState.CONNECTING -> "Connecting…"
            ConnectionState.RECONNECTING -> "Reconnecting…"
            ConnectionState.DISCONNECTED -> "Disconnected"
        }
        return Notification.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("AirBridge")
            .setContentText(subtitle)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun ensureChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_SERVICE, "AirBridge", NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "AirBridge transfer service"
        }
        nm.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        engine?.stop()
        engine = null
        current = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    fun engineOrNull(): AirBridgeEngine? = engine

    companion object {
        const val ACTION_CONNECT = "com.airbridge.app.CONNECT"
        const val ACTION_DISCONNECT = "com.airbridge.app.DISCONNECT"
        const val ACTION_ACCEPT = "com.airbridge.app.ACCEPT"
        const val ACTION_DECLINE = "com.airbridge.app.DECLINE"
        const val EXTRA_URL = "url"
        const val EXTRA_TRANSFER_ID = "transferId"
        private const val CHANNEL_SERVICE = "airbridge_service"
        private const val NOTIF_SERVICE_ID = 41

        @Volatile private var current: EngineService? = null
        fun current(): EngineService? = current

        private fun idKey(s: String): String = s
    }
}
