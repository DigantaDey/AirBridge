# Handoff Report — Investigation of Features F13, F14, F15, and F16

**Report Path**: `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/explorer_m1_1/handoff.md`  
**Date**: 2026-11-14T17:45:00Z  
**Author**: Explorer M1-1 (Archetype: Teamwork explorer)  
**Parent Agent**: `356d0616-42c7-4f9f-a377-37b34d9e8c2e`  
**Milestone**: M1 (Packaging, Reliability, and Background Service Hardening)

---

## 1. Observation

### 1.1 F13: Android 14+ FGS Type DataSync & ConnectedDevice
- **Manifest Permissions**: In `android/app/src/main/AndroidManifest.xml` (lines 4–12):
  ```xml
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
  <uses-permission android:name="android.permission.WAKE_LOCK" />
  <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
  <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  ```
  *Finding*: `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` is **MISSING**.
- **Manifest Service Declaration**: In `android/app/src/main/AndroidManifest.xml` (lines 51–55):
  ```xml
  <service
      android:name=".ConnectionService"
      android:exported="false"
      android:stopWithTask="false"
      android:foregroundServiceType="connectedDevice" />
  ```
  *Finding*: `android:foregroundServiceType` is declared solely as `"connectedDevice"`. It lacks `"connectedDevice|dataSync"`.
- **FGS Launch Bitmask**: In `android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt` (lines 144–152):
  ```kotlin
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
          NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      )
  } else {
      startForeground(NOTIFICATION_ID, notification)
  }
  ```
  *Finding*: On Android 10+ (API 29+ / `Build.VERSION_CODES.Q`), `startForeground()` passes exclusively `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`. `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` is never passed, even during active file transfers.

### 1.2 F14: Background Continuity & Locks
- **Wake Lock Configuration**: In `ConnectionService.kt` (lines 283–300):
  ```kotlin
  val prefs = Prefs(this)
  val shouldHold = transferActive || prefs.connectionContinuity
  if (!shouldHold) {
      releaseTransferWakeLock()
      return
  }
  val wakeTimeoutMs = if (transferActive) 10 * 60_000L else 3 * 60_000L
  if (transferWakeLock?.isHeld != true) {
      val powerManager = getSystemService(POWER_SERVICE) as PowerManager
      transferWakeLock = powerManager.newWakeLock(
          PowerManager.PARTIAL_WAKE_LOCK,
          "$packageName:AirBridgeTransfer",
      ).apply {
          setReferenceCounted(false)
          acquire(wakeTimeoutMs)
      }
  }
  ```
  *Finding*: WakeLock tag is `"$packageName:AirBridgeTransfer"`. Timeouts are 10 minutes during transfers, 3 minutes for idle continuity. Reference counting is disabled (`setReferenceCounted(false)`).
- **Wi-Fi Lock Configuration**: In `ConnectionService.kt` (lines 301–320):
  ```kotlin
  if (wifiLock?.isHeld != true) try {
      val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
      val wifiMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
      } else {
          @Suppress("DEPRECATION")
          android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
      }
      @Suppress("DEPRECATION")
      wifiLock = wifiManager.createWifiLock(
          wifiMode,
          "$packageName:AirBridgeWifi",
      ).apply {
          setReferenceCounted(false)
          acquire()
      }
  } catch (e: SecurityException) {
      Log.w("AirBridgePower", "Wi-Fi performance lock unavailable: ${e.message}")
      wifiLock = null
  }
  ```
  *Finding*: Wi-Fi lock uses `WIFI_MODE_FULL_LOW_LATENCY` on API 29+ and `WIFI_MODE_FULL_HIGH_PERF` on older APIs. Held until released.
- **Refresh Loop**: In `ConnectionService.kt` (lines 61–71, 321–325):
  ```kotlin
  private val lockRefresh = object : Runnable {
      override fun run() {
          lockRefreshScheduled = false
          val continuity = Prefs(this@ConnectionService).connectionContinuity
          if (transferActive || continuity) {
              val timeoutMs = if (transferActive) 10 * 60_000L else 3 * 60_000L
              transferWakeLock?.takeIf { it.isHeld }?.let { runCatching { it.acquire(timeoutMs) } }
              updateTransferWakeLock()
          }
      }
  }
  ```
  *Finding*: Refresh interval is 60s for `transferActive` and 120s for continuity.
- **Critical Lock Bugs Identified**:
  1. **Premature Release in `ensureEngine()` (Line 384)**:
     In `onStartCommand()`, line 142 calls `updateTransferWakeLock()`, properly acquiring locks if `connectionContinuity == true`.
     At line 154, `ensureEngine()` is invoked.
     At line 384 inside `ensureEngine()`:
     ```kotlin
     releaseTransferWakeLock()
     ```
     `releaseTransferWakeLock()` is called unconditionally!
     Because `NativeEngineHost` only notifies transfer callbacks when transfer states mutate (`onTransferChanged`), if no file transfer is running, `updateTransferWakeLock()` is NEVER called again. As a result, locks are acquired at line 142 and destroyed 12 lines later at line 384, leaving the service without locks during idle continuity!
  2. **WakeLock Object Allocation Churn**:
     In `lockRefresh`: `transferWakeLock?.takeIf { it.isHeld }?.let { runCatching { it.acquire(timeoutMs) } }`. If the wake lock timed out or was not held, this block is skipped. Then `updateTransferWakeLock()` sees `transferWakeLock?.isHeld != true` and calls `powerManager.newWakeLock(...)`, instantiating a brand-new `WakeLock` instance and binder token on every cycle.
  3. **Network Recovery Callback Gap (Line 103)**:
     ```kotlin
     if (transferActive) updateTransferWakeLock()
     ```
     When network reconnects, if `connectionContinuity` is true but no transfer is active, `updateTransferWakeLock()` is not called.

### 1.3 F15: Battery Optimization
- **Manifest Permission**: In `AndroidManifest.xml`:
  `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` is **MISSING**.
- **Current Invocation Pattern**: In `android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt` (lines 84–97):
  ```kotlin
  @JavascriptInterface
  fun batteryOptimizationExempt(): Boolean =
      (activity.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager)
          .isIgnoringBatteryOptimizations(activity.packageName)

  @JavascriptInterface
  fun openBatterySettings(): Boolean {
      activity.runOnUiThread {
          try { activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
          catch (_: Exception) { runCatching {
              activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
          } }
      }
      return true
  }
  ```
  *Finding*: The app currently launches `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` (a system list of all installed apps) rather than `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with data URI `package:<packageName>`. The direct 1-tap dialog requires the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission, which is currently absent.

### 1.4 F16: Clipboard Sync Services
- **Background Ingestion (Desktop -> Android)**: In `android/app/src/main/kotlin/com/airbridge/app/NativeEngineHost.kt` (lines 58–74):
  ```kotlin
  private val clipboardWork = LatestTask<ClipboardItem>(worker) { item ->
      if (!closed && prefs.receiveClipboard) {
          try {
              val image = item.imageDataUrl
              if (image != null) ClipboardImageProvider.copyImage(context, image)
              else {
                  ConnectionService.markOwnClipboardWrite(item.text)
                  (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                      .setPrimaryClip(ClipData.newPlainText("AirBridge", item.text))
              }
              synchronized(stateLock) { lastSynced = item.text; lastSyncedAt = android.os.SystemClock.elapsedRealtime() }
          } catch (e: Exception) { Log.w(TAG, "System clipboard write failed: ${e.message}") }
          addClip(item)
      }
  }
  ```
  *Finding*: Ingestion uses `ClipboardManager.setPrimaryClip()` directly on a background executor. In Android 10+, `setPrimaryClip()` is allowed from background services.
- **Echo Suppression**: In `ConnectionService.kt` (lines 481–513):
  `markOwnClipboardWrite()` records the written string and elapsed realtime. `publishClipboardChange()` ignores clipboard changes matching `lastOwnClipboardText` within `OWN_WRITE_ECHO_WINDOW_MS = 1_500L`, plus duplicate checks within `DUPLICATE_EVENT_WINDOW_MS = 400L`.
- **Background Read Workaround (Android -> Desktop)**: In `android/app/src/main/kotlin/com/airbridge/app/ClipboardAccessibilityService.kt`:
  - Declared with `BIND_ACCESSIBILITY_SERVICE` in `AndroidManifest.xml` (lines 62–75).
  - Configured with `canRetrieveWindowContent="false"` in `accessibility_service_config.xml`.
  - When direct `ClipboardText.read(this)` returns null (due to Android 10+ background read restriction), attaches a 1x1 transparent `TYPE_ACCESSIBILITY_OVERLAY` view with `FLAG_ALT_FOCUSABLE_IM` (lines 111–156).
  - When `onWindowFocusChanged(hasWindowFocus = true)` fires on the overlay, reads `ClipboardText.read()` with window focus, dispatches to `publishClipboardChange()`, and immediately calls `removeFocusOverlay()`.
  - Guarded by `OVERLAY_TIMEOUT_MS = 250L` and `OVERLAY_COOLDOWN_MS = 1_200L`.
- **Sensitive Clipboard Privacy (Android 13+)**: In `android/app/src/main/kotlin/com/airbridge/app/ClipboardText.kt` (lines 8–18):
  ```kotlin
  object ClipboardText {
      fun read(context: Context): String? = try {
          val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          val clip = manager.primaryClip
          if (clip == null || clip.itemCount == 0 || !clip.description.hasMimeType("text/*") ||
              clip.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true) null
          else clip.getItemAt(0)?.text?.takeIf { it.isNotBlank() && it.length <= Limits.MAX_CLIPBOARD_TEXT }?.toString()
      } catch (_: Exception) {
          null
      }
  }
  ```
  *Finding*: Reads inspect `ClipDescription.EXTRA_IS_SENSITIVE` (`"android.content.extra.IS_SENSITIVE"`, introduced in Android 13). If true, it returns `null`, preventing passwords and sensitive data from leaking to paired devices.
- **Explicit Zero-Permission Fallback**: In `android/app/src/main/kotlin/com/airbridge/app/ShareTextActivity.kt` (lines 10–33):
  Responds to `Intent.ACTION_SEND` and `Intent.ACTION_PROCESS_TEXT`, sending text to `ConnectionService` with `ACTION_SHARE_TEXT` and `explicit = true`.

---

## 2. Logic Chain

### 2.1 F13: Android 14+ FGS Type DataSync & ConnectedDevice
1. *From Observation 1.1*: `AndroidManifest.xml` declares only `android:foregroundServiceType="connectedDevice"`, and requests only `FOREGROUND_SERVICE_CONNECTED_DEVICE`. `FOREGROUND_SERVICE_DATA_SYNC` is absent from `<uses-permission>` and `<service>`.
2. *From Android SDK 34 Contract*: Android 14 (API 34) enforces granular Foreground Service Types. Any service performing file transfer operations (upload/download) must declare `dataSync` in `<service android:foregroundServiceType="...">` and request `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />`.
3. *Runtime Impact*: Calling `startForeground(id, notification, FOREGROUND_SERVICE_TYPE_DATA_SYNC)` without the declared permission and manifest type crashes with `SecurityException` / `IllegalArgumentException`. If `dataSync` is not passed or declared, Android 14+ watchdog policies flag prolonged background transfers.
4. *Conclusion for F13*: Both permissions (`FOREGROUND_SERVICE_CONNECTED_DEVICE` and `FOREGROUND_SERVICE_DATA_SYNC`) and manifest types (`connectedDevice|dataSync`) must be declared. In `ConnectionService.kt`, line 148 should pass `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` on API 29+.

### 2.2 F14: Background Continuity & Locks
1. *From Observation 1.2 (Premature Release)*: In `ConnectionService.kt`, `onStartCommand()` acquires wake and Wi-Fi locks at line 142. But at line 154, `ensureEngine()` unconditionally executes `releaseTransferWakeLock()` at line 384. Because `engineHost` callbacks only invoke `updateTransferWakeLock()` upon transfer mutations (`onTransferChanged`), an idle service with `connectionContinuity == true` has its locks destroyed immediately upon startup.
2. *From Observation 1.2 (Allocation Churn)*: In `lockRefresh`, `transferWakeLock?.takeIf { it.isHeld }?.let { it.acquire(timeoutMs) }` skips unheld locks, causing `updateTransferWakeLock()` to allocate a new `WakeLock` instance repeatedly. Calling `acquire(wakeTimeoutMs)` on an existing `WakeLock` instance with `setReferenceCounted(false)` properly re-arms the lock without re-allocating binder tokens.
3. *From Observation 1.2 (Network Reconnect)*: `onAvailable` in `ConnectivityManager.NetworkCallback` only invokes `updateTransferWakeLock()` if `transferActive == true`. It should check `transferActive || Prefs(this).connectionContinuity`.
4. *Conclusion for F14*: 
   - Remove the unconditional `releaseTransferWakeLock()` in `ensureEngine()`, or re-evaluate `updateTransferWakeLock()` in `ensureEngine()`.
   - Maintain a persistent `transferWakeLock` instance, re-arming it with `acquire(wakeTimeoutMs)` rather than allocating a new object when `isHeld == false`.
   - Update `onAvailable` to re-arm locks on network recovery if `connectionContinuity` is true.

### 2.3 F15: Battery Optimization Exemption
1. *From Observation 1.3*: `AndroidManifest.xml` does not declare `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
2. *From Android API Contract*: `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with data URI `package:<packageName>` opens a direct, 1-tap confirmation dialog allowing the app to bypass Doze mode restrictions. However, calling this intent without declaring `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` fails with a `SecurityException`.
3. *Current Behavior*: Currently, the app falls back to `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`, which forces the user to navigate the full list of all system apps.
4. *Conclusion for F15*: Declare `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` in `AndroidManifest.xml`, and update battery settings invocation to attempt `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` first, falling back to `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` if denied or restricted by device policy.

### 2.4 F16: Clipboard Sync Services
1. *From Observation 1.4 (Background Ingestion)*: Incoming clipboard data from the desktop writes cleanly via `ClipboardManager.setPrimaryClip()`. This API is permitted in the background on Android 10, 11, 12, 13, 14, and 15. Echo suppression is handled via `OWN_WRITE_ECHO_WINDOW_MS = 1_500L`.
2. *From Observation 1.4 (Background Read Restraint)*: Android 10+ restricts `getPrimaryClip()` to apps with window focus. `ClipboardAccessibilityService` circumvents this via a transient 1x1 transparent `TYPE_ACCESSIBILITY_OVERLAY` view with `FLAG_ALT_FOCUSABLE_IM`, removing it immediately upon reading.
3. *From Android 13+ Platform Changes*: Sideloaded APKs encounter Android 13+ "Restricted settings", disabling accessibility services by default until the user explicitly permits restricted settings in App Info. Furthermore, Android 13+ displays a native clipboard overlay on every `setPrimaryClip()` write.
4. *Conclusion for F16*: 
   - The underlying mechanics of `ClipboardAccessibilityService`, `setPrimaryClip()`, and echo suppression are sound.
   - `ClipboardText.read()` already respects `ClipDescription.EXTRA_IS_SENSITIVE`.
   - The upcoming Jetpack Compose Settings screen (M3) should clearly indicate whether `ClipboardAccessibilityService.isEnabled(context)` is active and guide the user through the Android 13+ restricted settings unlock flow if needed.
   - `ShareTextActivity` remains the zero-permission fallback for instant beam of selected text.

---

## 3. Caveats

1. **Read-Only Scope**: In compliance with the Teamwork explorer instructions, no source or manifest files were altered during this investigation.
2. **Device Hardware Testing**: Observations and logic chains were verified by static analysis against Android 14/15 SDK contracts and clean Gradle builds. Runtime testing across various OEM-customized battery managers (e.g. Xiaomi MIUI / Samsung OneUI) requires physical device verification.
3. **Google Play Store Policy for Accessibility**: If AirBridge is ever published to the Google Play Store (rather than distributed via sideloading/GitHub Releases), Google Play policy prohibits using Accessibility Services for clipboard synchronization. The app's architecture already isolates this feature behind an explicit user opt-in and provides `ShareTextActivity` as the standard alternative.

---

## 4. Conclusion

| Feature | Assessment | Required Code Changes |
|---------|------------|------------------------|
| **F13: FGS Type DataSync** | **Gaps Found** | 1. Add `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` to `AndroidManifest.xml`.<br>2. Change `<service android:name=".ConnectionService" android:foregroundServiceType="connectedDevice|dataSync" />` in `AndroidManifest.xml`.<br>3. In `ConnectionService.kt:148`, pass `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` to `startForeground()`. |
| **F14: Continuity & Locks** | **Bugs Found** | 1. Fix premature lock release: In `ConnectionService.kt:384`, do not unconditionally call `releaseTransferWakeLock()`, or re-evaluate `updateTransferWakeLock()` immediately.<br>2. Eliminate WakeLock allocation churn in `lockRefresh` / `updateTransferWakeLock()`.<br>3. In `networkCallback.onAvailable()`, call `updateTransferWakeLock()` when `transferActive || prefs.connectionContinuity`. |
| **F15: Battery Optimization** | **Gap Found** | 1. Declare `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` in `AndroidManifest.xml`.<br>2. Update intent launcher to use `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with `package:${packageName}` URI for direct 1-tap system prompt, with fallback to `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`. |
| **F16: Clipboard Sync** | **Sound / Minor Polish** | 1. Background ingestion (`setPrimaryClip`), echo suppression, and `ShareTextActivity` are sound.<br>2. Overlay reader handles Android 10+ background restrictions cleanly.<br>3. Ensure M3 Compose UI displays clear accessibility enablement status and explains the Android 13+ restricted settings bypass. |

---

## 5. Verification Method

To independently verify the codebase observations and compile integrity:

### 1. Verify Manifest Declarations
```bash
grep -n "FOREGROUND_SERVICE" /Users/digantadey/AndroidStudioProjects/AirBridge/android/app/src/main/AndroidManifest.xml
grep -n "BATTERY" /Users/digantadey/AndroidStudioProjects/AirBridge/android/app/src/main/AndroidManifest.xml
grep -n -C 5 "ConnectionService" /Users/digantadey/AndroidStudioProjects/AirBridge/android/app/src/main/AndroidManifest.xml
```
*Expected*: Confirms `FOREGROUND_SERVICE_DATA_SYNC` and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` are missing, and `foregroundServiceType` is only `connectedDevice`.

### 2. Verify `ConnectionService.kt` Foreground Service Launch
```bash
grep -n -C 8 "startForeground(" /Users/digantadey/AndroidStudioProjects/AirBridge/android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt
```
*Expected*: Confirms line 148 passes only `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`.

### 3. Verify Engine Unit Tests
```bash
cd /Users/digantadey/AndroidStudioProjects/AirBridge/android
/Users/digantadey/.gradle/wrapper/dists/gradle-8.9-bin/90cnw93cvbtalezasaz0blq0a/gradle-8.9/bin/gradle :engine:test
```
*Expected*: `BUILD SUCCESSFUL`, all test cases pass.

### 4. Verify App Compilation
```bash
cd /Users/digantadey/AndroidStudioProjects/AirBridge/android
/Users/digantadey/.gradle/wrapper/dists/gradle-8.9-bin/90cnw93cvbtalezasaz0blq0a/gradle-8.9/bin/gradle :app:assembleDebug
```
*Expected*: `BUILD SUCCESSFUL`, `app-debug.apk` is generated.
