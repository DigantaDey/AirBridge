package com.airbridge.app

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * Explicit, user-enabled Accessibility Service opt-in for background clipboard
 * capture on Android.
 *
 * Android 10+ normally hides clipboard changes from apps that are not in the
 * foreground. When the user has opted in inside AirBridge *and* enabled this
 * service in Android's Accessibility settings, copy/selection-like events give
 * the app a chance to attempt a plain-text clipboard read and forward it to the
 * native peer even while AirBridge is not on screen. This remains best effort: the
 * OS or an OEM may still deny the read, and the service never retrieves window
 * content, reads text fields, records keystrokes or performs gestures.
 */
class ClipboardAccessibilityService : AccessibilityService() {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var scheduled = false
    private val capture = Runnable {
        scheduled = false
        val prefs = Prefs(this)
        if (prefs.accessibilityClipboardOptIn && prefs.connectionContinuity) {
            ClipboardText.read(this)?.let { ConnectionService.publishClipboardChange(this, it) }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "clipboard accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || !isRelevantEvent(event.eventType)) return
        val prefs = Prefs(this)
        if (!prefs.accessibilityClipboardOptIn || !prefs.connectionContinuity || scheduled) return
        // Copy menu accessibility events can precede the clipboard commit.
        // Coalesce bursts and read after the commit, rather than on every
        // selection/keystroke. Never inspect the event's text/window contents.
        scheduled = true
        handler.postDelayed(capture, 200)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onInterrupt() {
        // Nothing to clean up: no window content is retained.
    }

    private fun isRelevantEvent(type: Int): Boolean = when (type) {
        AccessibilityEvent.TYPE_VIEW_CLICKED,
        AccessibilityEvent.TYPE_VIEW_LONG_CLICKED,
        AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> true
        else -> false
    }

    companion object {
        private const val TAG = "AirBridgeA11y"

        /** True only when the user has enabled this exact service in Android Settings. */
        fun isEnabled(context: Context): Boolean {
            val component = ComponentName(context, ClipboardAccessibilityService::class.java)
            val expected = setOf(component.flattenToString(), component.flattenToShortString())
            val globallyEnabled = try {
                Settings.Secure.getInt(
                    context.contentResolver,
                    Settings.Secure.ACCESSIBILITY_ENABLED,
                    0,
                ) == 1
            } catch (_: Exception) {
                false
            }
            if (!globallyEnabled) return false
            val enabledServices = try {
                Settings.Secure.getString(
                    context.contentResolver,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                )
            } catch (_: Exception) {
                null
            } ?: return false
            return enabledServices.split(':').any { entry ->
                expected.any { it.equals(entry.trim(), ignoreCase = true) }
            }
        }
    }
}
