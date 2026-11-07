package com.airbridge.app

import android.os.Build
import android.view.WindowInsets

/**
 * System-bar and display-cutout insets in pixels.
 *
 * Android 15 (API 35) enforces edge-to-edge display for apps targeting SDK 35,
 * and WebView children can receive all-zero insets even though the window decor
 * view has the real values. The shell therefore reads insets from the decor view
 * and pads a plain parent FrameLayout around the WebView. On modern APIs the IME
 * is left to the manifest's adjustResize, otherwise the keyboard would be
 * reserved twice; legacy values are only used to position scanner chrome. CSS
 * safe-area variables are zeroed inside the native shell.
 */
data class SystemBarInsets(val left: Int, val top: Int, val right: Int, val bottom: Int)

/** Reads the insets that keep content clear of status/navigation bars and cutouts. */
fun WindowInsets.systemBarInsets(): SystemBarInsets {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val mask = WindowInsets.Type.systemBars() or
            WindowInsets.Type.displayCutout()
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
