# Specification Mining Report: Milestone 1 (M1) — Packaging, Reliability & Background Hardening

## Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Foreground Service | Android 14+ FGS Type `dataSync` | FGS type declaration and runtime flag for data/file transfer operations | Manifest: `<service android:foregroundServiceType="connectedDevice\|dataSync" />`<br>Kotlin: `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` (value `1` / `0x01`) | FGS running with dataSync capability | `SecurityException` if `FOREGROUND_SERVICE_DATA_SYNC` missing; `MissingForegroundServiceTypeException` if omitted from manifest | Android SDK 35 `ServiceInfo.java` & `Service.java` |
| 2 | Foreground Service | Android 14+ FGS Type `connectedDevice` | FGS type declaration and runtime flag for continuous LAN/device connectivity | Manifest: `<service android:foregroundServiceType="connectedDevice\|dataSync" />`<br>Kotlin: `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` (value `16` / `0x10`) | FGS running with connectedDevice capability | `SecurityException` if `FOREGROUND_SERVICE_CONNECTED_DEVICE` missing; `MissingForegroundServiceTypeException` if omitted from manifest | Android SDK 35 `ServiceInfo.java` & `Service.java` |
| 3 | Permissions | FGS Permission Declarations | Base and type-specific permissions required on API 34+ | `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`<br>`<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />`<br>`<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` | Granted at install time (normal protection level) | `SecurityException` upon `startForeground()` if type permissions are absent on API 34+ | Android SDK 35 `Manifest.permission` & `AndroidManifest.xml` |
| 4 | Foreground Service | Multi-Version `startForeground()` Invocation | API level branching for `Service.startForeground()` from API 26 through 35+ | Notification ID (`Int`), `Notification`, combined bitmask flags (`Int`) | Service placed in foreground state | `IllegalArgumentException` if flags not a subset of manifest types; `ForegroundServiceStartNotAllowedException` if started from background | Android SDK 35 `Service.java` |
| 5 | Battery Optimization | Ignore Battery Optimizations Permission | System permission allowing app to request exemption from Doze / App Standby | `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` in `AndroidManifest.xml` | Normal permission granted at install time | `SecurityException` thrown when firing `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` if permission is not declared in manifest | Android SDK 35 `Manifest.permission` & `Settings.java` |
| 6 | Battery Optimization | Exemption Status Check | Query whether app is currently whitelisted from battery optimizations | Package name (`String`) via `PowerManager.isIgnoringBatteryOptimizations(packageName)` | `Boolean` (`true` if whitelisted, `false` otherwise) | None (safe API call) | Android SDK 35 `PowerManager.java` |
| 7 | Battery Optimization | Direct Exemption Dialog Intent | System dialog prompting user to exempt AirBridge from battery optimizations | Action: `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`<br>Data: `Uri.parse("package:$packageName")` | System confirmation dialog presented to user | `ActivityNotFoundException` on customized/restricted OEM ROMs; `SecurityException` if permission missing | Android SDK 35 `Settings.java` |
| 8 | Battery Optimization | General Battery Optimization Settings Fallback | Fallback intent opening system battery optimization screen if direct dialog fails | Action: `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` (no package URI) | System battery optimization list screen | `ActivityNotFoundException` if system settings component missing | Android SDK 35 `Settings.java` |
| 9 | Build & Packaging | AGP 8.x Release Signing Config (v1/v2) | Explicit APK Signature Scheme v1 (JAR) and v2 (Full APK) configuration in Gradle Kotlin DSL | `signingConfigs.getByName("release")` or `create("release")`:<br>`enableV1Signing = true`<br>`enableV2Signing = true`<br>(legacy/deprecated: `v1SigningEnabled = true`, `v2SigningEnabled = true`) | Signed APK with both v1 and v2 signature blocks | APK installation rejection on older Android (if v1 missing) or slow verification / failure on newer Android (if v2 missing) | AGP 8.7.3 `ApkSigningConfig.kt` |
| 10 | Build & Packaging | Debug/Release Keystore Alignment | Aligning debug build signing to release keystore to eliminate sideload signature collisions | `buildTypes.debug.signingConfig = signingConfigs.getByName("release")` | Identical signing key for CI and local debug builds | `INSTALL_FAILED_UPDATE_INCOMPATIBLE` when sideloading over existing build signed with different key | `android/app/build.gradle.kts` |
| 11 | Build & Packaging | Local Development `versionCode` Sane Default | Preventing version downgrade installation failures when installing local builds over CI builds | `AIRBRIDGE_VERSION_CODE` env var with high default fallback (e.g. `2000000000` or local timestamp) | `versionCode` integer | `INSTALL_FAILED_VERSION_DOWNGRADE` when installing lower `versionCode` over higher CI build | `android/app/build.gradle.kts` |
| 12 | Service Discovery | NsdManager Dedicated ResolveListener Instance | Eliminating `FAILURE_ALREADY_ACTIVE` by allocating a fresh `ResolveListener` per resolution request | New anonymous `object : NsdManager.ResolveListener` per `nsd.resolveService()` call | Successful invocation and callback delivery | Reusing a listener instance triggers `IllegalArgumentException: listener already in use` or `FAILURE_ALREADY_ACTIVE (3)` | Android SDK 37 sources `NsdManager.java` |
| 13 | Service Discovery | Serial Resolution Queue & Watchdog Timeout | Queuing discovered services and enforcing a 5s watchdog timeout to handle hung resolutions | `ArrayDeque<NsdServiceInfo>` queue; `Handler.postDelayed` 5,000ms watchdog | Serialized resolution ensuring daemon stability | Unresolved hanging requests starve discovery queue without timeout | Android SDK 37 sources `NsdManager.java` & `Discovery.kt` |
| 14 | Script Portability | macOS Bash 3.2 Compatibility in `verify.sh` | Replacing Bash 4+ `mapfile` builtin with POSIX / Bash 3.2 `while IFS= read -r` loop | Shell script `verify.sh` running under `/bin/bash` | Populated array of source files | `mapfile: command not found` on default macOS Bash (version 3.2.57) | `android/scripts/verify.sh` |
| 15 | Background Continuity | WakeLock & WifiLock Lifecycle Management | Maintaining CPU partial wake lock and low-latency Wi-Fi lock with scheduled renewal | `PowerManager.PARTIAL_WAKE_LOCK`, `WifiManager.WIFI_MODE_FULL_LOW_LATENCY` (API 29+) / `WIFI_MODE_FULL_HIGH_PERF` (API < 29) | Unthrottled CPU and Wi-Fi during background file transfer | Socket timeout or transfer suspension when screen turns off | `android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt` |
| 16 | Clipboard Sync | Accessibility Overlay Clipboard Bridge | 1x1 transparent accessibility overlay window to gain focus and read clipboard on Android 10+ | `WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY`, `FLAG_NOT_TOUCHABLE`, `FLAG_NOT_TOUCH_MODAL` | Background clipboard read access | Android 10+ security restriction returns `null` for background `ClipboardManager.getPrimaryClip()` | `ClipboardAccessibilityService.kt` |

---

## Edge Cases

| # | Feature | Input | Observed Behavior |
|---|---------|-------|-------------------|
| 1 | Android 14+ FGS | `startForeground()` called with `FOREGROUND_SERVICE_TYPE_DATA_SYNC` on API 34+ without `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` | Android OS throws `SecurityException: Starting FGS with type dataSync callerApp ... targetSDK 34 requires android.permission.FOREGROUND_SERVICE_DATA_SYNC`. App crashes. |
| 2 | Android 14+ FGS | `startForeground()` called with `FOREGROUND_SERVICE_TYPE_DATA_SYNC` on API 34+ when manifest only declares `foregroundServiceType="connectedDevice"` | Android OS throws `android.app.MissingForegroundServiceTypeException: Starting FGS with type dataSync callerApp ... targetSDK 34 requires that the service be declared with foregroundServiceType=... in the manifest`. App crashes. |
| 3 | Android 14+ FGS | Calling 2-parameter `startForeground(id, notification)` on API 34+ when `<service>` tag has no `foregroundServiceType` attribute | Android OS throws `android.app.MissingForegroundServiceTypeException`. On API 34+, 2-arg `startForeground` defaults to `FOREGROUND_SERVICE_TYPE_MANIFEST`, which requires at least one type in manifest. |
| 4 | Android 14+ FGS | Calling 3-parameter `startForeground(id, notification, flags)` on API < 29 | `NoSuchMethodError` / JVM compilation failure: the 3-parameter overload was added in API 29 (Android 10 Q). Runtime version guard `Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q` is mandatory. |
| 5 | Battery Optimization | Calling `startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS))` without `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` in manifest | Android OS throws `SecurityException: Permission Denial: starting Intent { act=android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS dat=package:... } requires android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. |
| 6 | Battery Optimization | Calling `startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS))` without package data URI (i.e. `intent.data == null`) | Intent fails to resolve target package or throws `ActivityNotFoundException` / logs warning and closes immediately without action. |
| 7 | Battery Optimization | Calling `startActivity()` with `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` on custom OEM ROMs (e.g. certain Xiaomi, Huawei, or Samsung variants) where the specific activity component was removed or restricted | Throws `ActivityNotFoundException`. App crashes unless wrapped in `try-catch` with fallback to `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`. |
| 8 | Battery Optimization | App is already ignoring battery optimizations (`powerManager.isIgnoringBatteryOptimizations(packageName) == true`) | OS dialog is either dismissed immediately or not shown. App should check `isIgnoringBatteryOptimizations` before dispatching intent. |
| 9 | APK Signing | APK signed only with v2 scheme installed on Android 6.0 (API 23) or custom sideload environment requiring JAR signing | Package manager rejects APK because v2 signing was introduced in API 24 (Android 7.0). v1 signing scheme is required for backwards compatibility. |
| 10 | APK Signing | APK built with conflicting `versionCode` (e.g. local build has `versionCode = 10000`, device already has CI build with `versionCode = 10452`) | `adb install` fails with `Failure [INSTALL_FAILED_VERSION_DOWNGRADE]`. |
| 11 | NsdManager Discovery | Multiple services discovered in rapid succession (`onServiceFound` fires for Host A and Host B concurrently) while reusing a single `ResolveListener` member variable | First resolution succeeds or starts; second call immediately hits `mListenerMap.indexOfValue(listener) != -1` inside `NsdManager.putListener()` and throws `IllegalArgumentException: listener already in use`. On older Android, system daemon returns `onResolveFailed(..., FAILURE_ALREADY_ACTIVE = 3)`. Subsequent discovery fails silently. |
| 12 | NsdManager Discovery | Discovered service host goes offline or firewall drops mDNS packets during resolution | `NsdManager` never fires `onServiceResolved` or `onResolveFailed`. Without a watchdog timeout, resolution queue permanently stalls, blocking all future resolutions. |
| 13 | macOS Shell Script | Executing `android/scripts/verify.sh` on macOS with default system shell `/bin/bash` | Fails on line 69 with `verify.sh: line 69: mapfile: command not found` because macOS `/bin/bash` is version 3.2.57(1)-release and `mapfile` requires Bash 4.0+. |

---

## 5-Component Handoff Report

### 1. Observation
1. **Foreground Service Configuration**:
   - In `android/app/src/main/AndroidManifest.xml`:
     - Lines 5-6 declare:
       ```xml
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
       <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
       ```
     - Missing: `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />`.
     - Line 55 declares:
       ```xml
       <service
           android:name=".ConnectionService"
           android:exported="false"
           android:stopWithTask="false"
           android:foregroundServiceType="connectedDevice" />
       ```
     - Missing `dataSync` in `android:foregroundServiceType="connectedDevice|dataSync"`.
   - In `android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt`:
     - Lines 144-152:
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
     - Does not branch on `Build.VERSION_CODES.UPSIDE_DOWN_CAKE` (API 34) and does not specify `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`.
   - From `android.jar` (API 35):
     - `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` = `1` (`0x01`).
     - `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` = `16` (`0x10`).
     - Combined bitmask = `17` (`0x11`).
     - Exception classes verified: `android.app.MissingForegroundServiceTypeException`, `android.app.InvalidForegroundServiceTypeException`, `android.app.ForegroundServiceStartNotAllowedException` (all subclasses of `ForegroundServiceTypeException` / `ServiceStartNotAllowedException` / `IllegalStateException`).

2. **Battery Optimization Specification**:
   - In `android/app/src/main/AndroidManifest.xml`:
     - Permission `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` is completely absent.
   - From `android.jar` (API 35):
     - `Manifest.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` = `"android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"`.
     - `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` = `"android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"`.
     - `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` = `"android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"`.
     - `PowerManager.isIgnoringBatteryOptimizations(String packageName)` exists on `PowerManager`.

3. **APK Signing Specification (AGP 8.7.3 Kotlin DSL)**:
   - In `android/build.gradle.kts`: AGP version is `8.7.3` (`id("com.android.application") version "8.7.3"`).
   - In `android/app/build.gradle.kts`: Lines 20-40 declare `signingConfigs { create("release") { ... } }`, but neither v1 nor v2 signing flags are explicitly enabled.
   - From decompiled `gradle-api-8.7.3.jar` (`com.android.build.api.dsl.ApkSigningConfig`):
     - Property `enableV1Signing: Boolean?` (getter `getEnableV1Signing()`, setter `setEnableV1Signing(Boolean)`).
     - Property `enableV2Signing: Boolean?` (getter `getEnableV2Signing()`, setter `setEnableV2Signing(Boolean)`).
     - Deprecated property `isV1SigningEnabled: Boolean` (getter `isV1SigningEnabled()`, setter `setV1SigningEnabled(boolean)`, JavaBean alias `v1SigningEnabled`).
     - Deprecated property `isV2SigningEnabled: Boolean` (getter `isV2SigningEnabled()`, setter `setV2SigningEnabled(boolean)`, JavaBean alias `v2SigningEnabled`).
   - Line 16 of `android/app/build.gradle.kts`:
     `versionCode = System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull() ?: 10000` causes `INSTALL_FAILED_VERSION_DOWNGRADE` if local builds are installed over CI builds.

4. **NsdManager Resolution API Contract**:
   - In `android/app/src/main/kotlin/com/airbridge/app/Discovery.kt`:
     - Lines 27-31:
       ```kotlin
       override fun onServiceFound(info: NsdServiceInfo) {
           try {
               nsd.resolveService(info, resolveListener)
           } catch (_: Exception) {
           }
       }
       ```
     - Line 47: `private val resolveListener = object : NsdManager.ResolveListener { ... }` is a single instance shared across all discoveries.
   - From Android SDK 37 `NsdManager.java` source:
     - Lines 1002-1015:
       ```java
       private <T> int putListener(Object listener, Executor e, SparseArray<T> map, T value) {
           synchronized (mMapLock) {
               checkListener(listener);
               final int valueIndex = mListenerMap.indexOfValue(listener);
               if (valueIndex != -1) {
                   throw new IllegalArgumentException("listener already in use");
               }
       ...
       ```
     - Lines 1200-1215: Listener is only removed on `RESOLVE_SERVICE_SUCCEEDED` or `RESOLVE_SERVICE_FAILED`.
     - `NsdManager.FAILURE_ALREADY_ACTIVE` = `3`.
     - Concurrent reuse of `resolveListener` throws `IllegalArgumentException: listener already in use` or triggers `onResolveFailed(..., 3)`.

5. **macOS Script Compatibility**:
   - In `android/scripts/verify.sh`: Lines 69, 70, 89, 92 invoke `mapfile -t ... < <(...)`.
   - On macOS darwin24: `/bin/bash` is `GNU bash, version 3.2.57(1)-release`. `mapfile` is Bash 4.0+, causing execution failure.

---

### 2. Logic Chain
1. **Foreground Service**:
   - Target SDK is 35 (`compileSdk = 35`, `targetSdk = 35` in `android/app/build.gradle.kts`).
   - Android 14+ enforces that any foreground service operating data synchronization or hardware connection must declare both permissions and matching manifest service types.
   - For `ConnectionService`, transfers require `dataSync` while live peer connection / clipboard monitoring requires `connectedDevice`.
   - Therefore, manifest must specify `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` and `android:foregroundServiceType="connectedDevice|dataSync"`.
   - In `Service.startForeground()`, passing `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` is only supported when `Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE` (API 34). On API 29-33, `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` should be passed. Below API 29, only the 2-argument `startForeground(id, notification)` exists.

2. **Battery Optimization**:
   - AirBridge relies on persistent background socket continuity and background file transfers.
   - To prevent Android Doze and App Standby from killing sockets or freezing CPU during background operation, the app requests battery optimization exemption.
   - The official system contract requires:
     1) Declaring `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />`.
     2) Checking `powerManager.isIgnoringBatteryOptimizations(packageName)`.
     3) If `false`, launching `Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply { data = Uri.parse("package:$packageName") }`.
     4) Catching `ActivityNotFoundException` and falling back to `Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)`.

3. **APK Signing (AGP 8.x)**:
   - To guarantee that sideloaded APKs install smoothly across all Android versions (API 26 through API 35+) and update cleanly over existing CI builds, both v1 (JAR signature) and v2 (APK Signature Scheme v2) must be explicitly enabled.
   - In AGP 8.7.3 Kotlin DSL, the canonical properties are `enableV1Signing = true` and `enableV2Signing = true` (or `v1SigningEnabled = true` and `v2SigningEnabled = true`).
   - Aligning `buildTypes.debug.signingConfig = signingConfigs.getByName("release")` ensures debug APKs share the same key as CI releases, eliminating signature clash.

4. **NsdManager Resolution**:
   - Reusing a single `ResolveListener` causes fatal `IllegalArgumentException` in `putListener` or `FAILURE_ALREADY_ACTIVE (3)` in the OS daemon.
   - The authoritative Google fix requires:
     1) Instantiating a new `ResolveListener` per resolution request.
     2) Managing a FIFO resolution queue so only one resolution is in-flight at any time.
     3) Attaching a watchdog timer (5 seconds) to prevent unresponsive mDNS broadcasts from freezing the queue.

---

### 3. Caveats
1. **Android 15+ DataSync Timeout**: On Android 15 (API 35), `FOREGROUND_SERVICE_TYPE_DATA_SYNC` services are subject to a system execution timeout of 6 hours (`Service.onTimeout(int, int)`). However, `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` has no execution timeout. Combining both types (`connectedDevice|dataSync`) ensures persistent connectivity is preserved while data transfers are actively classified.
2. **Google Play Policy on Battery Optimization**: Google Play enforces strict policy restrictions on the use of `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. Because AirBridge is distributed via direct sideloading and local GitHub releases, this restriction does not apply; however, users should still be given an explicit in-app UI prompt before triggering the system dialog.
3. **API 34 `registerServiceInfoCallback`**: While Android 14 introduced `NsdManager.registerServiceInfoCallback`, AirBridge supports `minSdk = 26`. The queued `resolveService` pattern with dedicated listener instances provides uniform compatibility from API 26 to API 35+.

---

### 4. Conclusion

#### Exact Manifest Declarations Needed (`AndroidManifest.xml`)
```xml
<!-- Base foreground service permission (API 28+) -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<!-- Android 14+ FGS type permissions (API 34+) -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<!-- Battery optimization exemption request -->
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

<application ...>
    <service
        android:name=".ConnectionService"
        android:exported="false"
        android:stopWithTask="false"
        android:foregroundServiceType="connectedDevice|dataSync" />
</application>
```

#### Exact `Service.startForeground()` Implementation (`ConnectionService.kt`)
```kotlin
val notification = buildNotification()
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) { // API 34+
    startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )
} else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { // API 29-33
    startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
    )
} else { // Below API 29
    startForeground(NOTIFICATION_ID, notification)
}
```

#### Exact Battery Optimization Intent Flow (`SettingsScreen` / `MainActivity`)
```kotlin
fun requestBatteryOptimizationExemption(context: Context) {
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    val packageName = context.packageName
    if (powerManager.isIgnoringBatteryOptimizations(packageName)) return

    try {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // Fallback for OEM ROMs lacking direct request activity
        try {
            val fallbackIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            context.startActivity(fallbackIntent)
        } catch (_: Exception) {
            Log.w("AirBridgePower", "Battery optimization settings could not be opened")
        }
    } catch (e: SecurityException) {
        Log.e("AirBridgePower", "Missing REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission", e)
    }
}
```

#### Exact APK Signing Configuration (`android/app/build.gradle.kts`)
```kotlin
signingConfigs {
    val envStore = System.getenv("AIRBRIDGE_KEYSTORE_FILE")
    if (envStore != null) {
        create("release") {
            storeFile = file(envStore)
            storePassword = System.getenv("AIRBRIDGE_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("AIRBRIDGE_KEYSTORE_ALIAS")
            keyPassword = System.getenv("AIRBRIDGE_KEYSTORE_KEY_PASSWORD")
            enableV1Signing = true
            enableV2Signing = true
            v1SigningEnabled = true
            v2SigningEnabled = true
        }
    } else {
        create("release") {
            storeFile = rootProject.layout.projectDirectory.file("ci.keystore").asFile
            storePassword = "airbridge-ci"
            keyAlias = "airbridge"
            keyPassword = "airbridge-ci"
            enableV1Signing = true
            enableV2Signing = true
            v1SigningEnabled = true
            v2SigningEnabled = true
        }
    }
}
```

#### Exact NsdManager Queued Resolution Pattern (`Discovery.kt`)
```kotlin
class ServerDiscovery(
    context: Context,
    private val onFound: (url: String, serviceName: String) -> Unit,
    private val onLost: (serviceName: String) -> Unit,
) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var started = false

    private val pendingResolutions = ArrayDeque<NsdServiceInfo>()
    private var isResolving = false
    private var resolveTimeoutRunnable: Runnable? = null

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String?) { started = true }
        override fun onServiceFound(info: NsdServiceInfo) {
            mainHandler.post { enqueueResolution(info) }
        }
        override fun onServiceLost(info: NsdServiceInfo) {
            mainHandler.post {
                pendingResolutions.removeAll { it.serviceName == info.serviceName }
                onLost(info.serviceName)
            }
        }
        override fun onDiscoveryStopped(regType: String?) { started = false }
        override fun onStartDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "start discovery failed: $code")
        }
        override fun onStopDiscoveryFailed(regType: String?, code: Int) {
            Log.w(TAG, "stop discovery failed: $code")
        }
    }

    private fun enqueueResolution(info: NsdServiceInfo) {
        pendingResolutions.addLast(info)
        processNextResolution()
    }

    private fun processNextResolution() {
        if (isResolving || pendingResolutions.isEmpty() || !started) return
        val nextService = pendingResolutions.removeFirst()
        isResolving = true

        val timeoutRunnable = Runnable {
            Log.w(TAG, "Resolve timeout (5s) for ${nextService.serviceName}")
            isResolving = false
            processNextResolution()
        }
        resolveTimeoutRunnable = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, 5_000L)

        // Fresh listener instance per request
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo?, code: Int) {
                mainHandler.post {
                    mainHandler.removeCallbacks(timeoutRunnable)
                    Log.w(TAG, "resolve failed for ${info?.serviceName}: $code")
                    isResolving = false
                    processNextResolution()
                }
            }

            override fun onServiceResolved(info: NsdServiceInfo) {
                mainHandler.post {
                    mainHandler.removeCallbacks(timeoutRunnable)
                    isResolving = false
                    val host = info.hostAddresses.firstOrNull { it is Inet4Address }
                        ?: info.hostAddresses.firstOrNull()
                    if (host != null) {
                        val url = "ws://${host.hostAddress}:${info.port}/ws"
                        onFound(url, info.serviceName)
                    }
                    processNextResolution()
                }
            }
        }

        try {
            nsd.resolveService(nextService, listener)
        } catch (e: Exception) {
            Log.w(TAG, "resolveService exception: ${e.message}")
            mainHandler.removeCallbacks(timeoutRunnable)
            isResolving = false
            processNextResolution()
        }
    }

    fun start() {
        if (started) return
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.w(TAG, "discover failed: ${e.message}")
        }
    }

    fun stop() {
        if (!started) return
        resolveTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        pendingResolutions.clear()
        isResolving = false
        try {
            nsd.stopServiceDiscovery(discoveryListener)
        } catch (_: Exception) {
        }
        started = false
    }

    companion object {
        const val SERVICE_TYPE = "_airbridge._tcp."
        private const val TAG = "AirBridgeNsd"
    }
}
```

#### Exact Bash 3.2 Fix (`android/scripts/verify.sh`)
Replace `mapfile -t <VAR> < <(find ...)` with:
```bash
ENGINE_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ENGINE_SRC+=("$line")
done < <(find "$REPO/android/engine/src/main/kotlin" -name '*.kt' | sort)

TEST_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TEST_SRC+=("$line")
done < <(find "$REPO/android/engine/src/test/kotlin" -name '*.kt' 2>/dev/null | sort)

APP_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && APP_SRC+=("$line")
done < <(find "$REPO/android/app/src/main/kotlin" -name '*.kt' | sort)

APP_STUBS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && APP_STUBS+=("$line")
done < <(find "$REPO/android/scripts/stubs" -name '*.kt' | sort)
```

---

### 5. Verification Method

To independently verify the claims and specifications:

1. **Verify Android SDK 35 Symbols and Exceptions**:
   ```bash
   javap -cp /Users/digantadey/Library/Android/sdk/platforms/android-35/android.jar \
     android.content.pm.ServiceInfo | grep -E "FOREGROUND_SERVICE_TYPE_(CONNECTED_DEVICE|DATA_SYNC)"
   # Output confirms:
   #   public static final int FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
   #   public static final int FOREGROUND_SERVICE_TYPE_DATA_SYNC;

   javap -cp /Users/digantadey/Library/Android/sdk/platforms/android-35/android.jar \
     android.app.MissingForegroundServiceTypeException
   # Confirms exception exists on API 34+
   ```

2. **Verify AGP 8.7.3 SigningConfig API**:
   ```bash
   javap -cp /Users/digantadey/.gradle/caches/modules-2/files-2.1/com.android.tools.build/gradle-api/8.7.3/7b90ce26dc62c0748b6de923ed76c50a91ab9b26/gradle-api-8.7.3.jar \
     com.android.build.api.dsl.ApkSigningConfig
   # Confirms enableV1Signing, enableV2Signing, v1SigningEnabled, v2SigningEnabled getters/setters
   ```

3. **Verify NsdManager `putListener` Concurrency Behavior**:
   ```bash
   grep -A 20 "int putListener" /Users/digantadey/Library/Android/sdk/sources/android-37.0/android/net/nsd/NsdManager.java
   # Confirms mListenerMap.indexOfValue(listener) != -1 throws IllegalArgumentException("listener already in use")
   ```

4. **Verify macOS Bash 3.2 Compatibility**:
   ```bash
   /bin/bash -c 'echo $BASH_VERSION'
   # Confirms 3.2.57(1)-release
   ```
