package com.airbridge.app

import android.os.Build
import android.view.WindowInsets

/**
 * System-bar and display-cutout insets in pixels.
 *
 * Android 15 (API 35) enforces edge-to-edge display for apps targeting SDK 35.
 * In addition to Compose's `WindowInsets.safeDrawing`, custom Android Views such
 * as `QrScannerView` read system bar and display cutout insets via this helper
 * to keep camera chrome clear of status/navigation bars and display cutouts.
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
