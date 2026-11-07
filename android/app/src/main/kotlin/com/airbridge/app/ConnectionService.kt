package com.airbridge.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** Opt-in connection anchor and short-lived transfer CPU wake-lock owner. */
class ConnectionService : Service() {
    private var transferActive = false
    private var transferWakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "AirBridge connection and transfers",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps AirBridge connected and active transfers running while the screen is off" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                transferActive = false
                releaseTransferWakeLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TRANSFER_START -> transferActive = true
            ACTION_TRANSFER_STOP -> transferActive = false
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
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification: Notification = builder
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(if (transferActive) "AirBridge transfer in progress" else "AirBridge is connected")
            .setContentText(
                if (transferActive) {
                    "Keeping the transfer active while the screen is off. Keep AirBridge open until it completes."
                } else {
                    "Connection continuity is enabled. Clipboard access is limited by Android."
                },
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
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

    private fun updateTransferWakeLock() {
        if (!transferActive) {
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
        releaseTransferWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.airbridge.app.connection.START"
        const val ACTION_STOP = "com.airbridge.app.connection.STOP"
        const val ACTION_TRANSFER_START = "com.airbridge.app.connection.TRANSFER_START"
        const val ACTION_TRANSFER_STOP = "com.airbridge.app.connection.TRANSFER_STOP"
        private const val CHANNEL_ID = "airbridge_connection"
        private const val NOTIFICATION_ID = 3411
    }
}
