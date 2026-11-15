package com.airbridge.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object AirBridgeColors {
    val VerifiedGreen = Color(0xFF22C55E)
    val VerifiedGreenDark = Color(0xFF16A34A)
    val WarningAmber = Color(0xFFF59E0B)
    val TransferCyan = Color(0xFF38BDF8)
    val ErrorRed = Color(0xFFEF4444)
}

private val AirBridgeDarkScheme = darkColorScheme(
    primary = Color(0xFFF4F4F5),
    onPrimary = Color(0xFF09090B),
    primaryContainer = Color(0xFF27272A),
    onPrimaryContainer = Color(0xFFFAFAFA),
    secondary = Color(0xFFD4D4D8),
    onSecondary = Color(0xFF18181B),
    secondaryContainer = Color(0xFF1F1F23),
    onSecondaryContainer = Color(0xFFE4E4E7),
    tertiary = AirBridgeColors.VerifiedGreen,
    onTertiary = Color(0xFF052E16),
    tertiaryContainer = Color(0xFF14532D),
    onTertiaryContainer = Color(0xFFDCFCE7),
    background = Color(0xFF0A0A0C),
    onBackground = Color(0xFFFAFAFA),
    surface = Color(0xFF111114),
    onSurface = Color(0xFFFAFAFA),
    surfaceVariant = Color(0xFF1C1C21),
    onSurfaceVariant = Color(0xFFA1A1AA),
    outline = Color(0xFF3F3F46),
    outlineVariant = Color(0xFF27272A),
    error = Color(0xFFF87171),
    onError = Color(0xFF450A0A),
    errorContainer = Color(0xFF7F1D1D),
    onErrorContainer = Color(0xFFFEE2E2),
)

private val AirBridgeLightScheme = lightColorScheme(
    primary = Color(0xFF111113),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFE4E4E7),
    onPrimaryContainer = Color(0xFF09090B),
    secondary = Color(0xFF3F3F46),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFF4F4F5),
    onSecondaryContainer = Color(0xFF18181B),
    tertiary = AirBridgeColors.VerifiedGreenDark,
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFDCFCE7),
    onTertiaryContainer = Color(0xFF052E16),
    background = Color(0xFFFAFAFA),
    onBackground = Color(0xFF09090B),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF09090B),
    surfaceVariant = Color(0xFFF4F4F5),
    onSurfaceVariant = Color(0xFF52525B),
    outline = Color(0xFFD4D4D8),
    outlineVariant = Color(0xFFE4E4E7),
    error = Color(0xFFDC2626),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
)

@Composable
fun isResolvedDarkTheme(themeMode: String): Boolean = when (themeMode) {
    "light" -> false
    "dark" -> true
    else -> isSystemInDarkTheme()
}

@Composable
fun AirBridgeTheme(
    themeMode: String = "dark",
    content: @Composable () -> Unit,
) {
    val dark = isResolvedDarkTheme(themeMode)
    MaterialTheme(
        colorScheme = if (dark) AirBridgeDarkScheme else AirBridgeLightScheme,
        typography = Typography(),
        content = content,
    )
}
