package com.airbridge.app

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Android NotificationListenerService for optional bidirectional notification sharing.
 * When enabled by the user in Android Settings, this service reads outgoing app notifications
 * and relays them over the encrypted control channel to paired AirBridge devices.
 */
class NotificationSharingService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        val prefs = Prefs(this)
        if (!prefs.notificationSharing || !prefs.connectionContinuity) return

        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return // Ignore AirBridge's own notifications

        val notif = sbn.notification ?: return
        val extras = notif.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return

        val appName = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrNull() ?: pkg

        NativeEngineHost.instance?.broadcastNotificationBeam(title, text, appName, pkg)
    }

    companion object {
        private const val TAG = "AirBridgeNotifSharing"

        /** Returns true if the user has granted Notification Listener Access to AirBridge in Android Settings. */
        fun isEnabled(context: Context): Boolean {
            val component = ComponentName(context, NotificationSharingService::class.java)
            val flat = component.flattenToString()
            val shortFlat = component.flattenToShortString()
            val enabled = try {
                Settings.Secure.getString(
                    context.contentResolver,
                    "enabled_notification_listeners",
                )
            } catch (e: Exception) {
                null
            } ?: return false

            return enabled.split(':').any { entry ->
                val trimmed = entry.trim()
                trimmed.equals(flat, ignoreCase = true) || trimmed.equals(shortFlat, ignoreCase = true)
            }
        }
    }
}
