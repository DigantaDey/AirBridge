package com.airbridge.app

import android.accessibilityservice.AccessibilityService
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.inputmethod.InputMethodManager

/**
 * Accessibility Service for reliable background clipboard capture on Android 10+.
 *
 * Android 10+ blocks `ClipboardManager.getPrimaryClip()` for apps that do not
 * hold window focus, even if they run a foreground service or accessibility
 * service. When enabled in Android Settings, this service listens for
 * clipboard changes and copy/selection interactions, and (if direct background
 * read returns null on Android 10+) briefly attaches a 1x1 transparent
 * `TYPE_ACCESSIBILITY_OVERLAY` window solely to read `ClipboardManager` on
 * focus gain before removing the overlay immediately. It never reads or inspects
 * other apps' window content, text fields, or keystrokes.
 */
class ClipboardAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var lastOverlayProbeAt = 0L
    private var overlayView: View? = null
    private var windowManager: WindowManager? = null
    private var clipboardManager: ClipboardManager? = null
    private var clipListener: ClipboardManager.OnPrimaryClipChangedListener? = null

    private val removeOverlayRunnable = Runnable { removeFocusOverlay() }

    private val captureWithOverlay = Runnable {
        captureClipboard(allowOverlay = true, forceOverlay = false)
    }

    private val captureDirectOnly = Runnable {
        captureClipboard(allowOverlay = false, forceOverlay = false)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "clipboard accessibility service connected")
        val prefs = Prefs(this)
        // No implicit opt-in: the clipboard bridge only runs after the user
        // agreed to AirBridge's in-app disclosure (Settings → clipboard bridge).
        if (prefs.connectionContinuity) {
            runCatching {
                val intent = Intent(this, ConnectionService::class.java)
                    .setPackage(packageName)
                    .setAction(ConnectionService.ACTION_START)
                startForegroundService(intent)
            }
        }
        windowManager = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        clipboardManager = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (clipListener == null) {
            val listener = ClipboardManager.OnPrimaryClipChangedListener {
                val p = Prefs(this)
                if (!p.accessibilityClipboardOptIn || !p.connectionContinuity) return@OnPrimaryClipChangedListener
                handler.removeCallbacks(captureWithOverlay)
                handler.removeCallbacks(captureDirectOnly)
                captureClipboard(allowOverlay = true, forceOverlay = true)
            }
            clipListener = listener
            runCatching { clipboardManager?.addPrimaryClipChangedListener(listener) }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.packageName?.toString() == packageName) return
        val prefs = Prefs(this)
        if (!prefs.accessibilityClipboardOptIn || !prefs.connectionContinuity) return

        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_LONG_CLICKED,
            AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED,
            AccessibilityEvent.TYPE_ANNOUNCEMENT -> {
                // Copy actions and confirmation toasts often commit just after the UI event;
                // reschedule instead of dropping newer burst events.
                handler.removeCallbacks(captureWithOverlay)
                handler.postDelayed(captureWithOverlay, COPY_SETTLE_DELAY_MS)
            }
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                // Direct read only when switching windows — never consume overlay cooldown here.
                handler.removeCallbacks(captureDirectOnly)
                handler.postDelayed(captureDirectOnly, WINDOW_SETTLE_DELAY_MS)
            }
            else -> return
        }
    }

    private fun dispatchClipboard(text: String) {
        if (!ConnectionService.publishClipboardChange(this, text)) {
            ConnectionService.publishClipboardOrStart(this, text)
        }
    }

    private fun captureClipboard(allowOverlay: Boolean, forceOverlay: Boolean) {
        val prefs = Prefs(this)
        if (!prefs.accessibilityClipboardOptIn || !prefs.connectionContinuity) return
        val direct = ClipboardText.read(this)
        if (direct != null) {
            dispatchClipboard(direct)
            return
        }
        if (!allowOverlay || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val now = SystemClock.elapsedRealtime()
        if (!forceOverlay && now - lastOverlayProbeAt < OVERLAY_COOLDOWN_MS) return
        if (attachFocusOverlay()) {
            lastOverlayProbeAt = now
        }
    }

    private fun attachFocusOverlay(): Boolean {
        if (overlayView != null) return false
        val wm = windowManager ?: return false
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        if (imm?.isAcceptingText == true) {
            Log.d(TAG, "Input method is currently accepting text; skipping focus overlay to prevent keyboard dismissal")
            return false
        }
        val view = object : View(this) {
            override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
                super.onWindowFocusChanged(hasWindowFocus)
                if (!hasWindowFocus) return
                handler.post {
                    try {
                        val text = ClipboardText.read(this@ClipboardAccessibilityService)
                        if (text != null) {
                            dispatchClipboard(text)
                        }
                    } finally {
                        removeFocusOverlay()
                    }
                }
            }
        }.apply {
            isFocusable = true
            isFocusableInTouchMode = true
            alpha = 0f
        }
        @Suppress("DEPRECATION")
        val params = WindowManager.LayoutParams(
            1,
            1,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSPARENT,
        ).apply {
            gravity = Gravity.CENTER
            x = 0
            y = 0
            title = "AirBridgeClipSync"
        }
        overlayView = view
        val added = runCatching {
            wm.addView(view, params)
            view.requestFocus()
            true
        }.getOrElse {
            overlayView = null
            false
        }
        if (added) {
            handler.removeCallbacks(removeOverlayRunnable)
            handler.postDelayed(removeOverlayRunnable, OVERLAY_TIMEOUT_MS)
        }
        return added
    }

    private fun removeFocusOverlay() {
        handler.removeCallbacks(removeOverlayRunnable)
        val view = overlayView ?: return
        overlayView = null
        val wm = windowManager ?: return
        runCatching { wm.removeViewImmediate(view) }
    }

    override fun onDestroy() {
        clipListener?.let { listener ->
            runCatching { clipboardManager?.removePrimaryClipChangedListener(listener) }
        }
        clipListener = null
        removeFocusOverlay()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onInterrupt() {
        removeFocusOverlay()
    }

    companion object {
        private const val TAG = "AirBridgeA11y"
        private const val COPY_SETTLE_DELAY_MS = 140L
        private const val WINDOW_SETTLE_DELAY_MS = 160L
        private const val OVERLAY_COOLDOWN_MS = 800L
        private const val OVERLAY_TIMEOUT_MS = 250L

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
