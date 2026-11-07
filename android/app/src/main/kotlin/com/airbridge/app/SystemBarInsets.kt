package com.airbridge.app

import android.os.Build
import android.view.WindowInsets

/**
 * System-bar, display-cutout and IME insets in pixels.
 *
 * Android 15 (API 35) enforces edge-to-edge display for apps targeting SDK 35,
 * and WebView children can receive all-zero insets even though the window decor
 * view has the real values. Both the WebView and the QR scanner therefore read
 * insets from the decor view and apply them manually; CSS safe-area variables
 * are zeroed inside the native shell so the padding is never doubled.
 */
data class SystemBarInsets(val left: Int, val top: Int, val right: Int, val bottom: Int)

/** Reads the insets that keep content clear of status/navigation bars, cutouts and the keyboard. */
fun WindowInsets.systemBarInsets(): SystemBarInsets {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val mask = WindowInsets.Type.systemBars() or
            WindowInsets.Type.displayCutout() or
            WindowInsets.Type.ime()
        val bars = getInsets(mask)
        return SystemBarInsets(bars.left, bars.top, bars.right, bars.bottom)
    }
    @Suppress("DEPRECATION")
    val legacy = SystemBarInsets(
        systemWindowInsetLeft,
        systemWindowInsetTop,
        systemWindowInsetRight,
        systemWindowInsetBottom,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val cutout = displayCutout ?: return legacy
        return SystemBarInsets(
            maxOf(legacy.left, cutout.safeInsetLeft),
            maxOf(legacy.top, cutout.safeInsetTop),
            maxOf(legacy.right, cutout.safeInsetRight),
            maxOf(legacy.bottom, cutout.safeInsetBottom),
        )
    }
    return legacy
}
