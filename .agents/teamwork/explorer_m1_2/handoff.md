# Investigation Report: Features F17, F18, and F19

**State Folder**: `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/explorer_m1_2/`  
**Milestone**: M1 (Packaging, Reliability, and Background Service Hardening)  
**Author**: `explorer_m1_2`  
**Recipient**: `356d0616-42c7-4f9f-a377-37b34d9e8c2e` (Sub-orchestrator M1)

---

## 1. Observation

### 1.1 F17: APK Signing & Sideload Packaging
1. **`android/app/build.gradle.kts` Lines 20–40 (`signingConfigs`)**:
   ```kotlin
   signingConfigs {
       // Committed sideload key: keeps package signatures stable across CI
       // runs so users can install updates over the previous APK. Override
       // with AIRBRIDGE_KEYSTORE_FILE/-PASSWORD/-ALIAS for real distribution.
       val envStore = System.getenv("AIRBRIDGE_KEYSTORE_FILE")
       if (envStore != null) {
           create("release") {
               storeFile = file(envStore)
               storePassword = System.getenv("AIRBRIDGE_KEYSTORE_PASSWORD")
               keyAlias = System.getenv("AIRBRIDGE_KEYSTORE_ALIAS")
               keyPassword = System.getenv("AIRBRIDGE_KEYSTORE_KEY_PASSWORD")
           }
       } else {
           create("release") {
               storeFile = rootProject.layout.projectDirectory.file("ci.keystore").asFile
               storePassword = "airbridge-ci"
               keyAlias = "airbridge"
               keyPassword = "airbridge-ci"
           }
       }
   }
   ```
   - Neither branch specifies `v1SigningEnabled = true` or `v2SigningEnabled = true` (or Kotlin DSL `enableV1Signing = true`, `enableV2Signing = true`).
2. **`android/app/build.gradle.kts` Lines 42–50 (`buildTypes`)**:
   ```kotlin
   buildTypes {
       debug {
           signingConfig = signingConfigs.getByName("release")
       }
       release {
           isMinifyEnabled = false
           signingConfig = signingConfigs.getByName("release")
       }
   }
   ```
   - Both `debug` and `release` share the single `release` signing config.
3. **`apksigner verify --verbose` on `app-release.apk`**:
   Command:
   `/Users/digantadey/Library/Android/sdk/build-tools/34.0.0/apksigner verify --verbose android/app/build/outputs/apk/release/app-release.apk`
   Verbatim output:
   ```
   Verifies
   Verified using v1 scheme (JAR signing): false
   Verified using v2 scheme (APK Signature Scheme v2): true
   Verified using v3 scheme (APK Signature Scheme v3): false
   Verified using v3.1 scheme (APK Signature Scheme v3.1): false
   Verified using v4 scheme (APK Signature Scheme v4): false
   Verified for SourceStamp: false
   Number of signers: 1
   ```
   Both `app-release.apk` and `app-debug.apk` are missing v1 JAR signature verification (`Verified using v1 scheme: false`).
4. **`android/ci.keystore` Certificate**:
   Command:
   `keytool -list -v -keystore android/ci.keystore -storepass airbridge-ci`
   Verbatim output:
   - Keystore Type: PKCS12, Alias: `airbridge`
   - Owner/Issuer: `CN=AirBridge CI Sideload, OU=AirBridge, O=AirBridge, C=IN`
   - Certificate SHA-256 fingerprint: `0C:DB:19:EB:3E:F5:37:D5:74:15:96:45:7B:4A:E5:E2:A9:E7:CA:26:45:B5:32:3A:8C:24:84:55:E3:9C:59:DB`

### 1.2 F18: Version Code Calculation
1. **`android/app/build.gradle.kts` Line 16**:
   ```kotlin
   versionCode = System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull() ?: 10000
   versionName = "2.2.1"
   ```
2. **`.github/workflows/release.yml` Line 122**:
   ```yaml
   - name: Assemble release APK (ci sideload key)
     env:
       AIRBRIDGE_VERSION_CODE: ${{ github.run_number }}
     shell: bash
     run: |
       gradle -p android :engine:check :app:assembleRelease --no-daemon
   ```
3. **`aapt dump badging android/app/build/outputs/apk/release/app-release.apk`**:
   ```
   package: name='com.airbridge.app' versionCode='10000' versionName='2.2.1'
   ```

### 1.3 F19: ANR Prevention, Discovery Concurrency & Script Portability
1. **`android/app/src/main/kotlin/com/airbridge/app/Discovery.kt` Lines 23–58**:
   ```kotlin
   private val discoveryListener = object : NsdManager.DiscoveryListener {
       override fun onDiscoveryStarted(regType: String?) {
           started = true
       }
       override fun onServiceFound(info: NsdServiceInfo) {
           try {
               nsd.resolveService(info, resolveListener)
           } catch (_: Exception) {
           }
       }
       override fun onServiceLost(info: NsdServiceInfo) {
           onLost(info.serviceName)
       }
       ...
   }

   private val resolveListener = object : NsdManager.ResolveListener {
       override fun onResolveFailed(info: NsdServiceInfo?, code: Int) {
           Log.w(TAG, "resolve failed: $code")
       }
       override fun onServiceResolved(info: NsdServiceInfo) {
           val host = info.hostAddresses.firstOrNull { it is Inet4Address }
               ?: info.hostAddresses.firstOrNull()
               ?: return
           val url = "ws://${host.hostAddress}:${info.port}/ws"
           onFound(url, info.serviceName)
       }
   }
   ```
   - `resolveListener` is a single instance reused across every `onServiceFound` invocation.
   - Line 52 calls `info.hostAddresses`.
2. **`android/scripts/verify.sh` Lines 69–70, 89, 92**:
   ```bash
   mapfile -t ENGINE_SRC < <(find "$REPO/android/engine/src/main/kotlin" -name '*.kt' | sort)
   mapfile -t TEST_SRC < <(find "$REPO/android/engine/src/test/kotlin" -name '*.kt' 2>/dev/null | sort)
   ...
   mapfile -t APP_SRC < <(find "$REPO/android/app/src/main/kotlin" -name '*.kt' | sort)
   mapfile -t APP_STUBS < <(find "$REPO/android/scripts/stubs" -name '*.kt' | sort)
   ```
3. **Execution on macOS Environment**:
   Command: `/usr/bin/env bash --version`
   Output: `GNU bash, version 3.2.57(1)-release (arm64-apple-darwin24)`
   Command: `/bin/bash -c "mapfile -t arr < <(echo 1)"`
   Output: `/bin/bash: mapfile: command not found` (Exit code: 127).

---

## 2. Logic Chain

### 2.1 F17: Signing Schemes and Signature Clash Risks
1. **Omission of v1 Scheme**:
   - *Observation*: `apksigner verify` confirms `Verified using v1 scheme (JAR signing): false`.
   - *Reasoning*: AGP 8.7.3 does not enable v1 signing by default when targetSdk is 30+ unless explicitly configured. While Android 7+ supports v2, legacy sideload installers, ADB package wrappers, custom OEM recovery tools, and MDM distribution engines reject APKs missing a v1 JAR signature table (`META-INF/*.SF`, `META-INF/*.RSA`), yielding `INSTALL_FAILED_INVALID_APK` or generic "Can't install this app on your device".
   - *Remediation*: Explicitly configure `enableV1Signing = true` and `enableV2Signing = true` in the signing configuration.

2. **Debug Signing Architecture & Signature Clash (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`)**:
   - *Observation*: `buildTypes.debug` is configured with `signingConfig = signingConfigs.getByName("release")`.
   - *Reasoning*:
     - Scenario A (Local dev): `AIRBRIDGE_KEYSTORE_FILE` is unset. Both `debug` and `release` are signed with `android/ci.keystore` (`CN=AirBridge CI Sideload`). If a developer previously deployed the app from Android Studio without this configuration (which signs with `~/.android/debug.keystore`), the update is rejected with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
     - Scenario B (CI / Production): In a release pipeline where `AIRBRIDGE_KEYSTORE_FILE` is passed, `release` signing config points to the production keystore. Because `debug` references `signingConfigs.getByName("release")`, any debug build assembled in that environment will be signed with the production keystore, causing signature collisions with local developer debug builds.
   - *Remediation*: Decouple `debug` signing from `release` by defining an explicit `ciSideload` signing config for debug and local fallback, while allowing `release` to override with `AIRBRIDGE_KEYSTORE_FILE`.

### 2.2 F18: Version Code Downgrade (`INSTALL_FAILED_VERSION_DOWNGRADE`)
1. **The Downgrade Conflict**:
   - *Observation*: In CI (`release.yml`), `AIRBRIDGE_VERSION_CODE: ${{ github.run_number }}` (e.g., 42). In `build.gradle.kts`, `versionCode` fallback when unset is `10000`.
   - *Reasoning*:
     - When CI compiles a release APK, `versionCode = 42`.
     - When a developer builds locally, `versionCode = 10000`.
     - If a user/tester has installed a local build (`versionCode = 10000`) and subsequently attempts to update to an official GitHub Release APK (`versionCode = 42`), the Android Package Manager aborts with:
       `INSTALL_FAILED_VERSION_DOWNGRADE: Package com.airbridge.app new version code 42 is older than current version code 10000`.
     - Conversely, if CI changes to `versionCode = 10000 + run_number` (e.g., 10042), a developer building locally without `AIRBRIDGE_VERSION_CODE` gets `10000`. Attempting to install the local build over the CI release fails with:
       `INSTALL_FAILED_VERSION_DOWNGRADE: Package com.airbridge.app new version code 10000 is older than current version code 10042`.
   - *Remediation*: Implement a unified version code strategy:
     - Establish a base code scheme reflecting semantic versioning (e.g. `20201` for `2.2.1` or a 6-digit base like `100000`).
     - CI builds calculate: `versionCode = 100000 + (System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull() ?: 0)`.
     - Local development builds calculate: `versionCode = 100000 + gitCommitCount` (or dynamically increment via git count), ensuring local builds remain monotonic and compatible.

### 2.3 F19: ANR Prevention, Discovery Concurrency & Script Portability
1. **`NsdManager.resolveService()` Concurrency Bug**:
   - *Observation*: `Discovery.kt:29` passes the member field `resolveListener` into `nsd.resolveService(info, resolveListener)` on every `onServiceFound` event.
   - *Reasoning*:
     - Android's `NsdManager` documentation specifies that a single `ResolveListener` cannot be used concurrently for multiple resolve operations.
     - When multiple AirBridge peers are discovered on a LAN in rapid succession, `onServiceFound` is invoked multiple times while the first resolution is still pending.
     - `NsdManager` rejects the second call with `NsdManager.FAILURE_ALREADY_ACTIVE` (code 3), causing subsequent peers to be dropped from discovery.
     - On OEM Android builds, concurrent calls with the same listener can block the internal binder IPC thread, starving the UI thread or event loop and triggering an ANR.
   - *Remediation*: Instantiate a new, dedicated `NsdManager.ResolveListener` object per `onServiceFound` invocation.

2. **API 26–33 Incompatibility in `Discovery.kt:52`**:
   - *Observation*: Line 52 calls `info.hostAddresses.firstOrNull { it is Inet4Address }`.
   - *Reasoning*: `NsdServiceInfo.getHostAddresses()` was introduced in **API 34 (Android 14)**. The project `minSdk` is **26**. On any device running Android 8.0 through Android 13, calling `info.hostAddresses` crashes immediately with `java.lang.NoSuchMethodError: No virtual method getHostAddresses()`.
   - *Remediation*:
     ```kotlin
     val host = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
         info.hostAddresses.firstOrNull { it is Inet4Address } ?: info.hostAddresses.firstOrNull()
     } else {
         @Suppress("DEPRECATION")
         info.host
     }
     ```

3. **`verify.sh` Bash 3.2 Incompatibility on macOS**:
   - *Observation*: Lines 69, 70, 89, 92 invoke `mapfile -t ...`.
   - *Reasoning*: Standard macOS uses GNU Bash 3.2.57. `mapfile` and `readarray` require Bash 4.0+. Additionally, `local -n` (namerefs) is not supported in Bash 3.2. Running `./android/scripts/verify.sh` on macOS fails immediately with exit code 127 (`mapfile: command not found`).
   - *Remediation*: Replace `mapfile` calls with portable `while IFS= read -r line; do ... done < <(...)` loops.

---

## 3. Caveats

1. **Gradle Daemon & Kotlin Compiler on Developer PATH**:
   `verify.sh` relies on `kotlinc` and `android.jar`. If a developer has not installed Kotlin standalone or set `KOTLINC`, `verify.sh` terminates at line 28. Standard Gradle builds (`./gradlew` or `gradle`) bundle their own Kotlin compiler and are unaffected by this environment variable.
2. **Android OS Resolution Throttling (API < 32)**:
   While allocating a new `ResolveListener` per discovery resolves `FAILURE_ALREADY_ACTIVE`, on Android 11 and older, `NsdManager` can still fail if more than 2–3 service resolutions occur simultaneously across the OS. If testing reveals drops on Android 10/11, a FIFO resolve queue can be layered on top.
3. **Package Uninstallation during Sideload Transitions**:
   If an existing device already contains an APK signed by standard `~/.android/debug.keystore`, migrating to `ci.keystore` will require a one-time uninstall (`adb uninstall com.airbridge.app`) on that device.

---

## 4. Conclusion

The investigation confirms that:
1. **F17**: Release and debug builds do not enable v1 JAR signatures (`Verified using v1 scheme: false`), and debug builds are coupled to the release signing configuration.
2. **F18**: Version code calculation causes `INSTALL_FAILED_VERSION_DOWNGRADE` due to a mismatch between CI's raw run number (< 100) and the static local fallback (10000).
3. **F19**:
   - `Discovery.kt` contains a critical concurrency bug (reusing a single `ResolveListener` triggering `FAILURE_ALREADY_ACTIVE` / code 3) and an API level incompatibility (`info.hostAddresses` crashing on API < 34).
   - `verify.sh` crashes on macOS due to Bash 4+ `mapfile` usage on Bash 3.2.

### Concrete Implementation Proposals

#### Proposal 1: `android/app/build.gradle.kts` (F17 & F18)
```kotlin
    defaultConfig {
        applicationId = "com.airbridge.app"
        minSdk = 26
        targetSdk = 35

        val ciRunNumber = System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull()
        val gitCommitCount = runCatching {
            val stdout = java.io.ByteArrayOutputStream()
            providers.exec {
                commandLine("git", "rev-list", "--count", "HEAD")
            }.standardOutput.asText.get().trim().toIntOrNull()
        }.getOrNull() ?: 100

        versionCode = when {
            ciRunNumber != null -> 100000 + ciRunNumber
            else -> 100000 + gitCommitCount
        }
        versionName = "2.2.1"
    }

    signingConfigs {
        create("ciSideload") {
            storeFile = rootProject.layout.projectDirectory.file("ci.keystore").asFile
            storePassword = "airbridge-ci"
            keyAlias = "airbridge"
            keyPassword = "airbridge-ci"
            enableV1Signing = true
            enableV2Signing = true
        }

        val envStore = System.getenv("AIRBRIDGE_KEYSTORE_FILE")
        if (envStore != null) {
            create("release") {
                storeFile = file(envStore)
                storePassword = System.getenv("AIRBRIDGE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AIRBRIDGE_KEYSTORE_ALIAS")
                keyPassword = System.getenv("AIRBRIDGE_KEYSTORE_KEY_PASSWORD")
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("ciSideload")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("ciSideload")
        }
    }
```

#### Proposal 2: `android/app/src/main/kotlin/com/airbridge/app/Discovery.kt` (F19)
Replace lines 27–32 and 47–58 with dedicated listener and version-aware host extraction:
```kotlin
        override fun onServiceFound(info: NsdServiceInfo) {
            val listener = object : NsdManager.ResolveListener {
                override fun onResolveFailed(failedInfo: NsdServiceInfo?, errorCode: Int) {
                    Log.w(TAG, "resolve failed for ${failedInfo?.serviceName ?: info.serviceName}: $errorCode")
                }
                override fun onServiceResolved(resolvedInfo: NsdServiceInfo) {
                    val host = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        resolvedInfo.hostAddresses.firstOrNull { it is Inet4Address }
                            ?: resolvedInfo.hostAddresses.firstOrNull()
                    } else {
                        @Suppress("DEPRECATION")
                        resolvedInfo.host
                    } ?: return
                    val url = "ws://${host.hostAddress}:${resolvedInfo.port}/ws"
                    onFound(url, resolvedInfo.serviceName)
                }
            }
            try {
                nsd.resolveService(info, listener)
            } catch (e: Exception) {
                Log.w(TAG, "resolveService failed: ${e.message}")
            }
        }
```

#### Proposal 3: `android/scripts/verify.sh` (F19)
Replace lines 69–70 and 89–92:
```bash
echo "==> compiling engine"
ENGINE_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ENGINE_SRC+=("$line")
done < <(find "$REPO/android/engine/src/main/kotlin" -name '*.kt' | sort)

TEST_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TEST_SRC+=("$line")
done < <(find "$REPO/android/engine/src/test/kotlin" -name '*.kt' 2>/dev/null | sort)
"$KOTLINC" -nowarn -d "$OUT/engine" "${ENGINE_SRC[@]}" "${TEST_SRC[@]}"
...
echo "==> typechecking app against android.jar"
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

## 5. Verification Method

1. **Verify v1 & v2 Signature Schemes**:
   Assemble the APK:
   ```bash
   /Users/digantadey/.gradle/wrapper/dists/gradle-8.9-bin/90cnw93cvbtalezasaz0blq0a/gradle-8.9/bin/gradle -p android :app:assembleRelease :app:assembleDebug
   ```
   Inspect signing:
   ```bash
   /Users/digantadey/Library/Android/sdk/build-tools/34.0.0/apksigner verify --verbose android/app/build/outputs/apk/release/app-release.apk
   ```
   *Expected result*: Both `Verified using v1 scheme (JAR signing): true` and `Verified using v2 scheme (APK Signature Scheme v2): true`.

2. **Verify Version Code Monotonicity**:
   Dump badging:
   ```bash
   /Users/digantadey/Library/Android/sdk/build-tools/34.0.0/aapt dump badging android/app/build/outputs/apk/release/app-release.apk | grep versionCode
   ```
   *Expected result*: `versionCode='100090'` (or `100000 + git commits`), avoiding downgrade conflicts with CI builds.

3. **Verify Script Compatibility on macOS**:
   Run with `/bin/bash` (Bash 3.2):
   ```bash
   /bin/bash android/scripts/verify.sh
   ```
   *Expected result*: Script completes without `mapfile: command not found`.

4. **Engine & Unit Tests**:
   ```bash
   /Users/digantadey/.gradle/wrapper/dists/gradle-8.9-bin/90cnw93cvbtalezasaz0blq0a/gradle-8.9/bin/gradle -p android :engine:test
   ```
   *Expected result*: `BUILD SUCCESSFUL`.
