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
        if (!shouldRelay(sbn, notif)) return
        val extras = notif.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return
        // Progress ticks and re-posts of the same content are not new notifications.
        val fingerprint = (title + "\u0000" + text).hashCode()
        synchronized(recent) {
            if (recent[sbn.key] == fingerprint) return
            recent[sbn.key] = fingerprint
        }

        val appName = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrNull() ?: pkg

        NativeEngineHost.instance?.broadcastNotificationBeam(title, text, appName, pkg)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val key = sbn?.key ?: return
        synchronized(recent) { recent.remove(key) }
    }

    /** Last relayed content per notification key (bounded). */
    private val recent = object : LinkedHashMap<String, Int>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?) = size > 200
    }

    companion object {
        private const val TAG = "AirBridgeNotifSharing"

        /**
         * Only conversation-style alerts go to the computer. Skipped: ongoing
         * and foreground-service notifications (media, navigation, downloads,
         * calls), group summaries (duplicates of their children), and anything
         * the app marked VISIBILITY_SECRET (it asked not to be shown off-device
         * or on a lock screen).
         */
        fun shouldRelay(sbn: StatusBarNotification, notif: Notification): Boolean {
            if (sbn.isOngoing) return false
            val flags = notif.flags
            if (flags and Notification.FLAG_ONGOING_EVENT != 0) return false
            if (flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return false
            if (flags and Notification.FLAG_GROUP_SUMMARY != 0) return false
            if (notif.visibility == Notification.VISIBILITY_SECRET) return false
            if (notif.category == Notification.CATEGORY_TRANSPORT || notif.category == Notification.CATEGORY_PROGRESS ||
                notif.category == Notification.CATEGORY_CALL || notif.category == Notification.CATEGORY_SERVICE
            ) return false
            return true
        }

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
