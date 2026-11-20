package com.airbridge.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Dedicated microphone foreground service for active Continuity Mac call audio.
 *
 * Keeping `foregroundServiceType="microphone"` isolated from [ConnectionService]
 * preserves ConnectionService's `connectedDevice|dataSync` contract while
 * granting Android 11+ AudioFlinger microphone eligibility during backgrounded
 * calls whenever the user granted `RECORD_AUDIO` and started Mac call audio.
 */
class CallAudioService : Service() {
    @Volatile private var foregroundStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                onStopRequested?.invoke()
                stopForegroundAndSelf(startId)
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                val hasPerm = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                if (!hasPerm) {
                    val msg = "RECORD_AUDIO permission missing for microphone foreground service."
                    AndroidDiagnostics.callAudioFgsMicPromoted = false
                    AndroidDiagnostics.callAudioFgsMicError = msg
                    AndroidDiagnostics.recordEvent("callAudio", msg, "WARN")
                    stopForegroundAndSelf(startId)
                    return START_NOT_STICKY
                }
                val promoted = runCatching {
                    promoteForeground()
                    true
                }.getOrElse { err ->
                    val detail = err.message ?: err.javaClass.simpleName
                    Log.w(TAG, "Microphone FGS promotion failed: $detail")
                    AndroidDiagnostics.callAudioFgsMicPromoted = false
                    AndroidDiagnostics.callAudioFgsMicError = detail
                    AndroidDiagnostics.recordEvent("callAudio", "Microphone FGS promotion failed: $detail", "WARN")
                    false
                }
                if (!promoted) {
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                return START_NOT_STICKY
            }
            else -> {
                stopForegroundAndSelf(startId)
                return START_NOT_STICKY
            }
        }
    }

    @SuppressLint("InlinedApi")
    override fun onTimeout(startId: Int) {
        Log.w(TAG, "CallAudioService FGS timeout reached (API 34+): startId=$startId")
        AndroidDiagnostics.recordEvent("callAudio", "CallAudioService FGS timeout reached (startId=$startId)", "WARN")
        onStopRequested?.invoke()
        stopForegroundAndSelf(startId)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "CallAudioService FGS timeout reached (API 35+): startId=$startId type=$fgsType")
        AndroidDiagnostics.recordEvent("callAudio", "CallAudioService FGS timeout reached (startId=$startId type=$fgsType)", "WARN")
        onStopRequested?.invoke()
        stopForegroundAndSelf(startId)
    }

    override fun onDestroy() {
        foregroundStarted = false
        AndroidDiagnostics.callAudioFgsMicPromoted = false
        super.onDestroy()
    }

    private fun promoteForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        foregroundStarted = true
        AndroidDiagnostics.callAudioFgsMicPromoted = true
        AndroidDiagnostics.callAudioFgsMicError = null
    }

    private fun stopForegroundAndSelf(startId: Int? = null) {
        if (foregroundStarted) {
            runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        }
        foregroundStarted = false
        AndroidDiagnostics.callAudioFgsMicPromoted = false
        if (startId != null) stopSelf(startId) else stopSelf()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm?.getNotificationChannel(CHANNEL_ID) == null) {
            nm?.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Mac call audio", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while bridging call audio between your phone and paired Mac"
                },
            )
        }
        val openPending = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopPending = PendingIntent.getService(
            this,
            1,
            Intent(this, CallAudioService::class.java).setPackage(packageName).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Mac call audio bridge active")
            .setContentText("Speaking and listening through your paired Mac on speakerphone.")
            .setContentIntent(openPending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_CALL)
            .addAction(Notification.Action.Builder(null, "Switch to phone", stopPending).build())
            .build()
    }

    companion object {
        private const val TAG = "AirBridgeCallAudioSvc"
        private const val CHANNEL_ID = "airbridge_call_audio"
        private const val NOTIFICATION_ID = 0x5CA11
        const val ACTION_START = "com.airbridge.app.CALL_AUDIO_START"
        const val ACTION_STOP = "com.airbridge.app.CALL_AUDIO_STOP"

        @Volatile
        var onStopRequested: (() -> Unit)? = null

        fun start(context: Context): Pair<Boolean, String?> {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                val msg = "Microphone permission required on phone for Mac call audio."
                AndroidDiagnostics.callAudioFgsMicPromoted = false
                AndroidDiagnostics.callAudioFgsMicError = msg
                return false to msg
            }
            val intent = Intent(context, CallAudioService::class.java)
                .setPackage(context.packageName)
                .setAction(ACTION_START)
            return runCatching {
                context.startForegroundService(intent)
                true to null
            }.getOrElse { err ->
                val detail = err.message ?: err.javaClass.simpleName
                AndroidDiagnostics.callAudioFgsMicPromoted = false
                AndroidDiagnostics.callAudioFgsMicError = detail
                AndroidDiagnostics.recordEvent("callAudio", "startForegroundService failed: $detail", "WARN")
                false to detail
            }
        }

        fun stop(context: Context) {
            AndroidDiagnostics.callAudioFgsMicPromoted = false
            runCatching {
                context.stopService(Intent(context, CallAudioService::class.java).setPackage(context.packageName))
            }
        }
    }
}
