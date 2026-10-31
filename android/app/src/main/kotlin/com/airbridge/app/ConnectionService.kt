package com.airbridge.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

/** Opt-in process-lifetime anchor while AirBridge is connected. */
class ConnectionService : Service() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "AirBridge connection",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps the AirBridge connection available while you switch apps" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification: Notification = builder
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("AirBridge is connected")
            .setContentText("Connection continuity is enabled. Clipboard access is limited by Android.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.airbridge.app.connection.START"
        const val ACTION_STOP = "com.airbridge.app.connection.STOP"
        private const val CHANNEL_ID = "airbridge_connection"
        private const val NOTIFICATION_ID = 3411
    }
}
