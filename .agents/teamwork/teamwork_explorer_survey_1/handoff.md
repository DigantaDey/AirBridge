# Survey Report: Android UI Architecture & Jetpack Compose Migration Plan

**Date**: 2026-11-14  
**Author**: Survey Explorer 1  
**Target Repository**: AirBridge (`android/` and `src/client/`)  
**State Folder**: `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_1/`

---

## 1. Observation

### 1.1 Existing Android UI Structure & Lifecycle
The Android user interface is hosted in a single activity in `android/app/`:

* **`android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt`**:
  * Extends standard Android framework `android.app.Activity` (lines 40-984).
  * Lines 229-304: `buildContentView()` instantiates a `root` `FrameLayout` containing a `contentFrame` `FrameLayout` wrapping a `WebView`.
  * Lines 238-284: Configures `WebView` settings:
    * `settings.javaScriptEnabled = true`, `settings.domStorageEnabled = true`, `settings.allowFileAccess = false`, `settings.allowContentAccess = true`.
    * Attaches `ShellWebViewClient` and `ShellChromeClient`.
    * Registers `ShellBridge` under Javascript name `AirBridgeAndroid` via `addJavascriptInterface(bridge, BRIDGE_NAME)`.
  * Lines 48-49 & 511-554: Starts an embedded local HTTP proxy server `LoopbackRelay` on loopback `127.0.0.1:$port` to serve desktop API and web UI assets over HTTP/TLS.
  * Lines 504 & 523: Loads either the local asset `shell/connect.html` via `loadDataWithBaseURL` when unpaired, or `http://127.0.0.1:$port/` when paired.
  * Lines 724-760: Manages `QrScannerView`, an overlay `SurfaceView` attached to `root` using Camera2 and ZXing `MultiFormatReader` for QR code scanning.
  * Lines 156-225: Implements system back interception via `OnBackInvokedDispatcher` / `onBackPressed` by evaluating JS string `window.__airbridgeSystemBack()` with a 250 ms timeout before falling back to `finish()` or `webView.goBack()`.
  * Lines 641-695 & `SystemBarInsets.kt`: Custom edge-to-edge layout math reading `WindowInsets` on the decor view and setting physical padding on `contentFrame`.

* **`android/app/src/main/kotlin/com/airbridge/app/ShareTextActivity.kt`**:
  * An exported activity with `noHistory="true"` handling `android.intent.action.SEND` and `android.intent.action.PROCESS_TEXT` for `text/plain`.
  * Forwards shared text to `ConnectionService` with `ACTION_SHARE_TEXT`.

* **`android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt`**:
  * Android foreground service (`FOREGROUND_SERVICE_CONNECTED_DEVICE`).
  * Owns the native peer lifecycle via `NativeEngineHost`, independent of `MainActivity` and `WebView`.
  * Handles wake locks (`PowerManager.PARTIAL_WAKE_LOCK`), Wi-Fi locks (`WIFI_MODE_FULL_LOW_LATENCY`), network recovery callbacks, notifications (`NotificationManager`), and clipboard changes.

* **`android/app/src/main/kotlin/com/airbridge/app/NativeEngineHost.kt`**:
  * Bridges between Android system services and the pure Kotlin `:engine` module (`com.airbridge.engine.AirBridgeEngine`).
  * Lines 38-43: `snapshotSince(version, clipboardVersion)` serializes engine state (`Snapshot`) to JSON for consumption by JavaScript.
  * Lines 187-235: `command(raw)` parses JSON commands from JavaScript and invokes corresponding engine methods.

* **`android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt`**:
  * Injected at `window.AirBridgeAndroid` with 25 `@JavascriptInterface` annotated methods.
  * Bridges file saving (`beginSave`, `appendSave`, `finishSave`, `abortSave`), clipboard read/write (`copyText`, `readClipboard`), discovery status, battery optimization, and accessibility settings.

* **`android/app/build.gradle.kts`**:
  * Lines 106-121: Registers a Gradle Exec task `prepareWebClient` which executes Node.js on `scripts/build-android-client.mjs`, running Vite to compile the TypeScript/React application (`src/client/`) into `android/app/build/generated/clientAssets/ui`.
  * Adds `android/app/build/generated/clientAssets` to Android asset source sets.

### 1.2 Web Assets & Client UI
Located in `android/app/src/main/assets/` and `src/client/`:

* **`android/app/src/main/assets/shell/connect.html`**:
  * Unpaired screen containing brand header, QR scan button, "Computers on this network" list (populated from `window.AirBridgeAndroid.nearbyHosts()`), manual IP/port address input form, and error banners.
* **`android/app/src/main/assets/shell/native-shell-shim.js`**:
  * Injected on page load to style the web UI with `--ab-safe-top` insets and attach `window.__airbridgeSystemBack` for modal/sheet closure.
* **`src/client/App.tsx` & Components**:
  * React 19 / TypeScript SPA bundled into WebView assets.
  * Main screens: Header, Device Status, Devices List (peers), Send Files (staged files), Active Transfers.
  * Modals/Dialogs:
    * `TransferModal.tsx`: Incoming transfer offer prompt (previews, SAS code, file list, auto-accept toggle, Accept/Decline).
    * `PairingDock.tsx`: QR code display, pair code formatting, manual code join, camera scan button.
    * `ClipboardCenter.tsx`: Clipboard history list, target peer selector, multi-line compose, paste & image beam controls.
    * `DownloadsModal.tsx`: Download platform binaries and APKs.
    * `FolderPickerModal.tsx`: Select received files folder (desktop loopback only).
    * Settings Modal (lines 892-907 of `App.tsx`): Device rename, background connection continuity, dark mode, auto-beam toggle, receive clipboard toggle, battery optimization settings, accessibility service opt-in, paired computer reset.
* **`src/client/engine/nativeClient.ts`**:
  * Implements `AirBridgeClient` interface for the web UI.
  * Lines 72-108: `readSnapshot()` polls `window.AirBridgeAndroid.engineSnapshot` every 250 ms.
  * Lines 110-117: `command()` encodes method calls to `window.AirBridgeAndroid.engineCommand`.

---

## 2. Logic Chain

### 2.1 Existing Bridge Contract & Overhead
The current architecture suffers from an impedance mismatch between native Android and a browser environment:

1. **State Duplication & Polling Overhead**:
   * The native engine (`AirBridgeEngine` in `:engine`) maintains strongly typed Kotlin models (`TransferView`, `Peer`, `DeviceProfile`, `ClipboardItem`).
   * `NativeEngineHost.kt` converts these Kotlin data classes into `org.json.JSONObject` and `org.json.JSONArray`.
   * `NativeClient.ts` polls `engineSnapshot()` every 250 ms over the JavaScript bridge, parses the string back into JavaScript objects via `JSON.parse()`, and checks revision numbers.
   * *Inference*: This polling causes unnecessary CPU wakeups, battery consumption, GC churn, and UI latency.

2. **File Transfer & URI Handling**:
   * In `NativeFiles.kt`, file URIs chosen via Android's `ACTION_OPEN_DOCUMENT` are cached in memory with UUID tokens.
   * The web UI only receives opaque metadata (`sourceId`, `name`, `size`) via `ShellBridge.claimPickedFile`.
   * When sending, the web UI calls `ShellBridge.engineCommand` with `sendFiles`, and the native engine reads bytes directly from `ContentResolver` streams (`UriSource`).
   * *Inference*: File streaming already occurs completely in Kotlin/JVM native code; the WebView is merely acting as a display layer.

3. **Background Transfers & Continuity**:
   * When the user leaves `MainActivity`, `ConnectionService` continues running in the background.
   * Transfer speed is published to notifications (`publishTransferSpeed`) and incoming transfers spawn system notifications with Accept/Decline pending intents (`showIncomingOffer`).
   * *Inference*: The background transfer and foreground service logic is already decoupled from `MainActivity`. Migrating `MainActivity` from `WebView` to Jetpack Compose will not disrupt the background transfer pipeline.

### 2.2 Complete Screen & State Inventory

| Screen / View / Dialogue | Current Implementation | Components & Capabilities | Target Compose Architecture |
|---|---|---|---|
| **Connect Screen (Unpaired)** | `connect.html` & `MainActivity` | mDNS nearby hosts list, manual IP:port input, QR scan launcher, error banner, dark/light theme sync | `ConnectScreen` composable + `ConnectViewModel` |
| **QR Scanner Overlay** | `QrScannerView.kt` (Camera2 + ZXing) | Full-screen camera viewfinder, crop reticle, close button, torch/status | `QrScannerScreen` composable (CameraX `PreviewView` / ZXing analyzer + Canvas reticle) |
| **Main Dashboard (Paired)** | `App.tsx` (React) | Header bar, local device profile, connection status dot, peer list, staging dropzone, active transfers progress list | `DashboardScreen` composable + `DashboardViewModel` |
| **Incoming Transfer Dialogue** | `TransferModal.tsx` | Peer info, SAS code, file list with byte sizes, image previews, auto-accept checkbox, Accept/Decline actions | `IncomingTransferDialog` composable (`AlertDialog` or custom Material3 Card) |
| **Pairing Dialogue / Sheet** | `PairingDock.tsx` | Own QR code display, pair code formatting (ABC-DEF), rotate code, manual room join, camera scan trigger, network details | `PairingSheet` composable (`ModalBottomSheet`) |
| **Clipboard Center** | `ClipboardCenter.tsx` | Target peer selector, text input, image attachment, "Paste from system" button, send button, beam history list with copy/save | `ClipboardCenterSheet` composable (`ModalBottomSheet`) + `ClipboardViewModel` |
| **Recent Transfers (History)** | `App.tsx` (recent-modal) | List of completed, cancelled, declined, or failed transfers with file names, sizes, timestamps, and "Save again" | `TransferHistorySheet` composable (`ModalBottomSheet`) + `HistoryViewModel` |
| **Settings Screen / Sheet** | `App.tsx` (settings-modal) | Device rename input, background continuity toggle, dark appearance toggle, auto-beam toggle, receive clipboard toggle, battery optimization prompt, accessibility service opt-in & status, unpair/forget computer | `SettingsSheet` composable (`ModalBottomSheet` or dedicated `SettingsScreen`) + `SettingsViewModel` |
| **In-App Toast Banner** | `App.tsx` (`utility-toast`) | Transient message banner with title, body, optional action button ("Copy", "Save", "Open"), dismiss | `SnackbarHost` / `Snackbar` with custom Material3 styling |

### 2.3 Detailed JS Bridge Method & Contract Mapping

Every method currently exposed on `window.AirBridgeAndroid` maps directly to native Kotlin functions in ViewModels or Repositories:

| Existing `ShellBridge` Method | Parameters | Return Type | Native Kotlin / Compose Replacement |
|---|---|---|---|
| `nativeEngineVersion()` | none | `Int` (1) | *Obsolete* (entire app is native Kotlin) |
| `engineAttach()` | none | `Boolean` | `ConnectionService.bind()` / ViewModel startup |
| `engineSnapshot(version, clipVer)` | `Long, Long` | `String` (JSON) | Direct Kotlin `StateFlow<ClientUiState>` (Zero JSON serialization) |
| `engineCommand(raw)` | `String` (JSON) | `String` (JSON) | Direct suspend functions on `AirBridgeRepository` / `NativeEngineHost` |
| `claimPickedFile(name, size)` | `String, Long` | `String` (token) | `rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments())` returning `List<Uri>` directly to `SendFiles` state |
| `copyText(text)` | `String` | `Boolean` | Native `ClipboardManager.setPrimaryClip` + `ConnectionService.markOwnClipboardWrite` |
| `readClipboard()` | none | `String` | `ClipboardText.read(context)` |
| `batteryOptimizationExempt()` | none | `Boolean` | `PowerManager.isIgnoringBatteryOptimizations(packageName)` |
| `openBatterySettings()` | none | `Boolean` | `Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)` |
| `beginSave / appendSave / finishSave` | `name, mime, chunk` | `Int / Boolean / String` | Handled natively by `AndroidFileSinkFactory` into MediaStore Downloads |
| `state()` | none | `String` (JSON) | `ConnectUiState` StateFlow (`isPaired`, `target`, `pairCode`, `hasCamera`) |
| `nearbyHosts()` | none | `String` (JSON) | `ServerDiscovery` updating `StateFlow<List<NearbyHost>>` |
| `connect(address)` | `String` | `String` (error or "") | `ConnectViewModel.connect(address: String)` |
| `scanQr()` | none | `Boolean` | Navigate to `QrScannerScreen` route |
| `forgetComputer()` | none | `Boolean` | `SettingsViewModel.forgetComputer()` updating `Prefs` and resetting service |
| `connectionContinuityEnabled()` | none | `Boolean` | Read from `Prefs.connectionContinuity` StateFlow |
| `setConnectionContinuityEnabled(b)` | `Boolean` | `Boolean` | Write to `Prefs.connectionContinuity` & update `ConnectionService` |
| `accessibilityOptInEnabled()` | none | `Boolean` | Read from `Prefs.accessibilityClipboardOptIn` |
| `setAccessibilityOptInEnabled(b)` | `Boolean` | `Boolean` | Write to `Prefs.accessibilityClipboardOptIn` |
| `accessibilityServiceEnabled()` | none | `Boolean` | `ClipboardAccessibilityService.isEnabled(context)` |
| `openAccessibilitySettings()` | none | `Boolean` | `Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)` |
| `setTransferActive(active)` | `Boolean` | `Boolean` | Auto-derived from `transfers.any { it.status == TRANSFERRING }` |
| `updateTransferSpeed(json)` | `String` (JSON) | `Boolean` | Auto-derived from `TransferView.speedBytesPerSec` in `NativeEngineHost` |
| `setDarkTheme(enabled)` | `Boolean` | `Boolean` | Compose `isSystemInDarkTheme()` or custom `ThemeState` StateFlow |

---

## 3. Proposed Native Jetpack Compose Architecture

### 3.1 Architectural Overview
The target architecture follows modern Android Jetpack guidelines: **Single-Activity + Jetpack Compose Material 3 + ViewModels + Coroutines StateFlow**.

```
+------------------------------------------------------------------------+
|                          MainActivity : ComponentActivity              |
|                              (enableEdgeToEdge())                      |
+------------------------------------------------------------------------+
                                   |
                                   v
+------------------------------------------------------------------------+
|                         AirBridgeNavHost (Compose)                     |
|                                                                        |
|  +----------------------------+      +-------------------------------+ |
|  |     ConnectScreen          |      |       DashboardScreen         | |
|  | (mDNS, Manual IP, Reticle) | <==> | (Device, Peers, Send, Active) | |
|  +----------------------------+      +-------------------------------+ |
|                 \                                  /                   |
|                  +---------------+----------------+                    |
|                                  |                                     |
|                                  v                                     |
|               Sheets & Overlays (Material 3 ModalBottomSheet):         |
|               - QrScannerView / ScannerScreen (CameraX + ZXing)        |
|               - IncomingTransferDialog (Accept/Decline + Previews)    |
|               - PairingSheet (QR generation, Pair Code)                |
|               - ClipboardCenterSheet (Compose text/image, History)     |
|               - TransferHistorySheet (Completed / Cancelled)           |
|               - SettingsSheet (Device Name, Toggles, System Settings)  |
+------------------------------------------------------------------------+
                                   |
                                   v
+------------------------------------------------------------------------+
|                         ViewModels (StateFlow)                         |
|  ConnectViewModel | DashboardViewModel | ClipboardViewModel | Settings |
+------------------------------------------------------------------------+
                                   |
                                   v
+------------------------------------------------------------------------+
|                 AirBridgeRepository / NativeEngineHost                 |
|             (Direct Kotlin StateFlow & Suspend Coroutines)             |
+------------------------------------------------------------------------+
                                   |
                                   v
+------------------------------------------------------------------------+
|              ConnectionService (Android Foreground Service)            |
|                        com.airbridge.engine.*                          |
+------------------------------------------------------------------------+
```

### 3.2 UI Models & State Specifications
Kotlin data classes represent UI states cleanly without JSON:

```kotlin
// Connect Screen State
data class ConnectUiState(
    val isPaired: Boolean = false,
    val targetAddress: String = "",
    val nearbyHosts: List<NearbyHost> = emptyList(),
    val isScanningQr: Boolean = false,
    val isConnecting: Boolean = false,
    val errorMessage: String? = null,
    val hasCamera: Boolean = true,
)

// Main Dashboard State
data class DashboardUiState(
    val deviceName: String = "",
    val connectionState: ConnectionState = ConnectionState.CONNECTING,
    val connectionError: String? = null,
    val peers: List<PeerUiModel> = emptyList(),
    val stagedFiles: List<StagedFileItem> = emptyList(),
    val activeTransfers: List<TransferView> = emptyList(),
    val pendingOffer: TransferView? = null,
    val clipboardItemCount: Int = 0,
    val recentTransfersCount: Int = 0,
)

data class PeerUiModel(
    val peerId: String,
    val name: String,
    val platform: String,
    val formFactor: String,
    val discoveryScope: String, // "paired" | "nearby"
    val sasCode: String?,
    val isVerified: Boolean,
)

data class StagedFileItem(
    val uri: Uri,
    val name: String,
    val size: Long,
    val mimeType: String,
)

// Clipboard Center State
data class ClipboardUiState(
    val peers: List<PeerUiModel> = emptyList(),
    val selectedPeerId: String? = null,
    val draftText: String = "",
    val draftImageDataUrl: String? = null,
    val autoSyncEnabled: Boolean = true,
    val receiveEnabled: Boolean = true,
    val items: List<ClipboardItem> = emptyList(),
    val isSending: Boolean = false,
    val errorMessage: String? = null,
)

// Settings State
data class SettingsUiState(
    val deviceName: String = "",
    val connectionContinuity: Boolean = true,
    val darkTheme: Boolean = false,
    val autoClipboardSync: Boolean = true,
    val clipboardReceiveEnabled: Boolean = true,
    val batteryOptimizationExempt: Boolean = false,
    val accessibilityOptIn: Boolean = false,
    val accessibilityServiceEnabled: Boolean = false,
    val pairedTarget: String? = null,
)
```

### 3.3 Theme & Design Tokens
AirBridge uses a high-contrast minimalist monochrome design with emerald accent colors.

* **Colors**:
  * Background Light: `Color(0xFFFFFFFF)`, Background Dark: `Color(0xFF111111)`
  * Surface Subtle Light: `Color(0xFFF7F7F7)`, Surface Subtle Dark: `Color(0xFF202020)`
  * Border Light: `Color(0xFFE5E5E5)`, Border Dark: `Color(0xFF333333)`
  * Text Primary Light: `Color(0xFF111111)`, Text Primary Dark: `Color(0xFFF5F5F5)`
  * Text Muted Light: `Color(0xFF777777)`, Text Muted Dark: `Color(0xFFAAAAAA)`
  * Primary Accent: `Color(0xFF10B981)` (Emerald 500)
  * Secondary Accent: `Color(0xFF38BDF8)` (Sky 400)
  * Danger / Error: `Color(0xFFDC2626)` (Red 600)
* **Typography**: Clean sans-serif utilizing Material 3 Typography (`titleLarge`, `titleMedium`, `bodyMedium`, `labelSmall`). Tabular numbers (`FontFeatureSettings("tnum")`) for file transfer speeds, sizes, and ETA countdowns.
* **Shapes**: `RoundedCornerShape(16.dp)` for cards and buttons; `RoundedCornerShape(24.dp)` for bottom sheets and dialogs.

### 3.4 Camera QR Scanner Implementation in Compose
Instead of embedding legacy View hierarchies, implement the QR scanner with either:
1. **CameraX Analyzer** (`androidx.camera:camera-camera2`, `camera-lifecycle`, `camera-view`):
   * Use `AndroidView(factory = { PreviewView(it) })` to render camera preview.
   * Attach `ImageAnalysis.Builder()` passing YUV frames directly to ZXing `MultiFormatReader` with `HybridBinarizer(PlanarYUVLuminanceSource(...))`.
   * Draw a Compose Canvas overlay with the rounded reticle and scanline animations.
2. **Reusable `AndroidView(factory = { QrScannerView(it) })`**:
   * As an intermediate step, the existing, battle-tested `QrScannerView` (which has zero dependencies beyond framework Camera2 + ZXing core) can be embedded into Compose in 5 lines of code via `AndroidView`.

---

## 4. Dependencies & Migration Plan

### 4.1 Required Dependencies to Add
In `android/build.gradle.kts`:
* Add Kotlin Compose Compiler Plugin:
  ```kotlin
  plugins {
      id("com.android.application") version "8.7.3" apply false
      id("org.jetbrains.kotlin.android") version "2.1.20" apply false
      id("org.jetbrains.kotlin.jvm") version "2.1.20" apply false
      id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
  }
  ```

In `android/app/build.gradle.kts`:
* Enable Compose build feature and plugin:
  ```kotlin
  plugins {
      id("com.android.application")
      id("org.jetbrains.kotlin.android")
      id("org.jetbrains.kotlin.plugin.compose")
  }
  
  android {
      ...
      buildFeatures {
          compose = true
      }
  }
  
  dependencies {
      implementation(project(":engine"))
      implementation("com.google.zxing:core:3.5.3")
      
      // Compose BOM
      val composeBom = platform("androidx.compose:compose-bom:2024.11.00")
      implementation(composeBom)
      androidTestImplementation(composeBom)
      
      // Compose UI & Material 3
      implementation("androidx.compose.ui:ui")
      implementation("androidx.compose.ui:ui-graphics")
      implementation("androidx.compose.ui:ui-tooling-preview")
      debugImplementation("androidx.compose.ui:ui-tooling")
      implementation("androidx.compose.material3:material3")
      implementation("androidx.compose.material:material-icons-extended")
      implementation("androidx.compose.foundation:foundation")
      
      // Integration with Activity & Lifecycle
      implementation("androidx.activity:activity-compose:1.9.3")
      implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
      implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
      
      // Navigation
      implementation("androidx.navigation:navigation-compose:2.8.5")
      
      // Image Loading for Encrypted Previews & Thumbnails
      implementation("io.coil-kt:coil-compose:2.7.0")
      
      // CameraX (for QR Scanner)
      implementation("androidx.camera:camera-camera2:1.4.1")
      implementation("androidx.camera:camera-lifecycle:1.4.1")
      implementation("androidx.camera:camera-view:1.4.1")
  }
  ```

### 4.2 Artifacts to Deprecate and Remove
1. **Gradle Build Tasks**:
   * Delete `prepareWebClient` task and node execution logic in `android/app/build.gradle.kts` (lines 70-121).
   * Remove asset sourceDir pointing to `buildDirectory.dir("generated/clientAssets")`.
2. **Java / Kotlin Classes**:
   * `android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt` -> **Remove entirely**.
   * `android/app/src/main/kotlin/com/airbridge/app/LoopbackRelay.kt` -> **Remove entirely** (no longer needed since no webview requests local HTTP).
   * `android/app/src/main/kotlin/com/airbridge/app/SystemBarInsets.kt` -> **Remove entirely** (replaced by Compose `WindowInsets`).
   * `MainActivity.kt` -> **Refactor**: Replace WebView, WebChromeClient, and FrameLayout with `ComponentActivity.setContent { AirBridgeApp() }`.
3. **Web & Asset Files**:
   * `android/app/src/main/assets/shell/connect.html` -> **Delete**.
   * `android/app/src/main/assets/shell/native-shell-shim.js` -> **Delete**.
4. **Test Clean-up**:
   * `tests/android-shell-layout.test.ts` & `tests/connect-screen.test.ts`: These verify DOM elements in `connect.html` and strings in `MainActivity.kt`. Replace or deprecate them with Compose UI unit / screenshot tests.

---

## 5. Caveats
* **Camera2 vs CameraX**: `QrScannerView.kt` is currently written using pure `android.hardware.camera2` without external dependencies. While it can be embedded directly in Compose via `AndroidView`, migrating to CameraX provides better device compatibility and lifecycle handling across edge devices.
* **Engine Untouched**: The core Kotlin transport engine in `android/engine` (`AirBridgeEngine`, `WebSocketClient`, `Crypto`, `Frames`, `Model`, `Files`, etc.) requires zero modification for the UI migration. It is already high-performance, asynchronous, and pure Kotlin.
* **Image Previews**: Encrypted image drop previews (`previewDataUrl` in `FileManifestItem`) are data URLs (`data:image/...`). Coil Compose natively supports loading data URLs without custom decoders.

---

## 6. Conclusion
The AirBridge Android application's core transport and background connection mechanisms (`android/engine` and `ConnectionService`) are already fully native Kotlin. The WebView interface was acting solely as a remote view and metadata display, introducing:
1. Periodic 250 ms JSON polling overhead across the JS bridge.
2. An embedded local HTTP proxy (`LoopbackRelay`).
3. Complex webview-specific window insets and back button shims.
4. Heavy Node/Vite build steps during Android Gradle builds.

Migrating to Jetpack Compose will completely eliminate all 4 of these bottlenecks. The proposed architecture replaces the WebView with clean, reactive Material 3 Composables, bound directly to `StateFlow` streams from `NativeEngineHost` and `ConnectionService`.

---

## 7. Verification Method

### 7.1 Static Code & Verification Preflight
Verify that engine and stubs compile cleanly:
```bash
npm run verify:android
```
Or directly:
```bash
bash android/scripts/verify.sh
```

### 7.2 Gradle Verification
Verify JVM engine tests and assemble the Android debug APK:
```bash
cd android
./gradlew :engine:check :app:assembleDebug
```
Expected output:
* `:engine:test` and `:engine:check` pass 100% of protocol vectors and transport checks.
* `:app:assembleDebug` builds `app-debug.apk` successfully.

### 7.3 Interoperability Checks
Run the full TypeScript-to-Kotlin protocol interop suite:
```bash
npx tsx scripts/test-native-interop.ts
```
Expected output: All 62 cross-implementation test vectors and live socket transfer tests succeed.
