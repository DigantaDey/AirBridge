package com.airbridge.app

import android.Manifest
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.airbridge.app.ui.AirBridgeApp
import com.airbridge.app.ui.theme.isResolvedDarkTheme
import com.airbridge.app.ui.viewmodels.AirBridgeViewModel
import com.airbridge.engine.PairingLink

/**
 * Pure Jetpack Compose Material 3 Activity.
 *
 * ConnectionService owns the encrypted peer, high-speed transfers, and
 * background clipboard sync independently of Activity lifecycle.
 */
class MainActivity : ComponentActivity() {
    private val viewModel: AirBridgeViewModel by viewModels()
    private var showCameraRationale by mutableStateOf(false)
    private var showCameraSettingsDialog by mutableStateOf(false)
    private var showNotificationRationale by mutableStateOf(false)
    private var showNotificationSettingsDialog by mutableStateOf(false)
    private var requestedNotificationsThisSession = false

    private val pickFilesLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isNotEmpty()) {
            viewModel.stagePickedUris(uris)
        }
    }

    private val pickClipboardImageLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) {
            viewModel.beamImageUri(uri)
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            viewModel.openScanner()
        } else {
            val permanentlyDenied = !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
            if (permanentlyDenied) {
                showCameraSettingsDialog = true
            } else {
                viewModel.notifyMessage(
                    "Camera permission is needed to scan QR codes; you can enter the address manually",
                )
            }
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        viewModel.refreshSystemStatus()
        if (!granted) {
            val permanentlyDenied = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                false
            }
            if (permanentlyDenied) {
                showNotificationSettingsDialog = true
            } else {
                viewModel.notifyMessage(
                    "Notifications help you track transfers and approve offers in the background",
                )
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val initialDark = Prefs(this).themeMode != "light"
        applyEdgeToEdge(initialDark)
        handleIncomingIntent(intent)

        setContent {
            val state by viewModel.uiState.collectAsStateWithLifecycle()
            val darkTheme = isResolvedDarkTheme(state.themeMode)
            DisposableEffect(darkTheme) {
                applyEdgeToEdge(darkTheme)
                onDispose {}
            }

            AirBridgeApp(
                viewModel = viewModel,
                showCameraRationale = showCameraRationale,
                onDismissCameraRationale = { showCameraRationale = false },
                onConfirmCameraRationale = {
                    showCameraRationale = false
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                },
                showCameraSettings = showCameraSettingsDialog,
                onDismissCameraSettings = { showCameraSettingsDialog = false },
                onConfirmCameraSettings = {
                    showCameraSettingsDialog = false
                    openAppSettings()
                },
                showNotificationRationale = showNotificationRationale,
                onDismissNotificationRationale = {
                    showNotificationRationale = false
                    requestedNotificationsThisSession = true
                },
                onConfirmNotificationRationale = {
                    showNotificationRationale = false
                    requestedNotificationsThisSession = true
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
                showNotificationSettings = showNotificationSettingsDialog,
                onDismissNotificationSettings = { showNotificationSettingsDialog = false },
                onConfirmNotificationSettings = {
                    showNotificationSettingsDialog = false
                    openAppSettings()
                },
                onOpenScannerWithPermission = ::openScannerWithPermission,
                onPickFiles = { pickFilesLauncher.launch(arrayOf("*/*")) },
                onPickClipboardImage = {
                    pickClipboardImageLauncher.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                },
                onOpenDownloads = ::openDownloads,
                onRequestBatteryExemption = ::requestBatteryExemption,
                onOpenAccessibilitySettings = ::openAccessibilitySettings,
                onOpenNotificationListenerSettings = {
                    runCatching { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
                },
                onOpenAppSettings = ::openAppSettings,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        if (Prefs(this).target.isNotEmpty()) {
            viewModel.startConnectionService(ConnectionService.ACTION_UI_ATTACH)
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refreshSystemStatus()
        maybeRequestNotificationsPermission()
    }

    override fun onStop() {
        viewModel.startConnectionService(ConnectionService.ACTION_UI_DETACH)
        super.onStop()
    }

    private fun applyEdgeToEdge(darkTheme: Boolean) {
        val style = if (darkTheme) {
            SystemBarStyle.dark(Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        }
        enableEdgeToEdge(
            statusBarStyle = style,
            navigationBarStyle = style,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data ?: return
        if (!data.scheme.equals("airbridge", ignoreCase = true)) return
        val link = PairingLink.parse(data.toString()) ?: return
        viewModel.connectWithLink(link)
    }

    private fun openScannerWithPermission() {
        if (!viewModel.hasCamera) {
            viewModel.notifyMessage("No camera detected on this device; enter your computer's address manually")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            viewModel.openScanner()
            return
        }
        if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            showCameraRationale = true
            return
        }
        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    private fun maybeRequestNotificationsPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (requestedNotificationsThisSession) return
        if (Prefs(this).target.isEmpty()) return
        val permission = Manifest.permission.POST_NOTIFICATIONS
        when {
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED -> {
                return
            }
            shouldShowRequestPermissionRationale(permission) -> {
                showNotificationRationale = true
            }
            else -> {
                requestedNotificationsThisSession = true
                notificationPermissionLauncher.launch(permission)
            }
        }
    }

    private fun openDownloads(@Suppress("UNUSED_PARAMETER") savedPath: String?) {
        val intent = Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)
        val launched = runCatching {
            startActivity(intent)
            true
        }.getOrDefault(false)
        if (!launched) {
            viewModel.notifyMessage("Files are saved in your Downloads/AirBridge folder")
        }
    }

    private fun requestBatteryExemption() {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (power.isIgnoringBatteryOptimizations(packageName)) {
            viewModel.notifyMessage("AirBridge already has unrestricted battery permission")
            viewModel.refreshSystemStatus()
            return
        }
        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        val ok = runCatching {
            startActivity(intent)
            true
        }.recoverCatching {
            openAppSettings()
            true
        }.getOrDefault(false)
        if (!ok) {
            viewModel.notifyMessage("Allow unrestricted battery for AirBridge in Android Settings")
        }
    }

    private fun openAccessibilitySettings() {
        viewModel.setAccessibilityOptIn(true)
        val launched = runCatching {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            true
        }.getOrDefault(false)
        if (!launched) {
            viewModel.notifyMessage("Could not open Android Accessibility Settings")
        }
    }

    private fun openAppSettings() {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:$packageName"),
        )
        runCatching { startActivity(intent) }
    }
}
