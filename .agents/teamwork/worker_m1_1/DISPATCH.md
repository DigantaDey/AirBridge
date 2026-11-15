## 2026-11-14T18:36:26Z

You are the Worker agent for Milestone 1 (M1) of Project AirBridge.

## Inputs & Context
- MANDATORY FIRST STEP: Read the original user request at:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md`
- Read the project plan at:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/PROJECT.md`
- Read the scope document at:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/sub_orch_m1/SCOPE.md`
- Read the findings and proposals from the 3 investigation reports:
  - `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/explorer_m1_1/handoff.md`
  - `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/explorer_m1_2/handoff.md`
  - `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/spec_miner_m1_1/handoff.md`
- Your state folder:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/worker_m1_1/`
- Working directory:
  `/Users/digantadey/AndroidStudioProjects/AirBridge`

## Write Ownership
You exclusively own and may edit the following files:
- `android/app/src/main/AndroidManifest.xml`
- `android/app/build.gradle.kts`
- `android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt`
- `android/app/src/main/kotlin/com/airbridge/app/Discovery.kt`
- `android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt`
- `android/scripts/verify.sh`
- Any unit tests under `android/engine/src/test/` or `android/app/src/test/`

DO NOT edit files owned by other milestones.

## MANDATORY INTEGRITY WARNING
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Implementation Tasks (Features F13 to F19)

1. **F13 (Android 14+ FGS Type DataSync & ConnectedDevice)**:
   - In `android/app/src/main/AndroidManifest.xml`:
     - Add `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />`.
     - Update `ConnectionService` declaration to `android:foregroundServiceType="connectedDevice|dataSync"`.
   - In `android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt`:
     - In `startForeground()` calls, branch for Android 14+ (`Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE` / API 34) passing `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`. On API 29–33 pass `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`. On API < 29 pass 2-parameter `startForeground(NOTIFICATION_ID, notification)`.

2. **F14 (Background Continuity & Locks)**:
   - In `ConnectionService.kt`:
     - Fix premature lock release: In `ensureEngine()`, remove the unconditional `releaseTransferWakeLock()`. Instead, ensure `updateTransferWakeLock()` is called so idle continuity locks are held when `prefs.connectionContinuity` is true.
     - Eliminate wake lock allocation churn: In `updateTransferWakeLock()` / `lockRefresh`, reuse the existing `transferWakeLock` instance when possible by re-arming with `acquire(timeoutMs)` rather than constantly re-allocating `powerManager.newWakeLock()`.
     - In `networkCallback.onAvailable()`, call `updateTransferWakeLock()` when `transferActive || prefs.connectionContinuity` to maintain lock continuity across network switches.

3. **F15 (Battery Optimization)**:
   - In `android/app/src/main/AndroidManifest.xml`:
     - Add `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />`.
   - In `android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt`:
     - Update `openBatterySettings()`: Attempt direct 1-tap system dialog via `Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply { data = Uri.parse("package:${activity.packageName}") }`.
     - Catch `ActivityNotFoundException` and fallback to `Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)`.

4. **F16 (Clipboard Sync Services)**:
   - Review and verify clipboard background ingestion via `setPrimaryClip()` and `ClipboardAccessibilityService.kt`. Ensure echo suppression and `EXTRA_IS_SENSITIVE` checks remain solid.

5. **F17 & F18 (Packaging, Signing & Versioning)**:
   - In `android/app/build.gradle.kts`:
     - In `signingConfigs`: Configure `enableV1Signing = true` and `enableV2Signing = true` (and `v1SigningEnabled = true`, `v2SigningEnabled = true`).
     - Decouple `ciSideload` signing config from production release override, and configure `buildTypes.debug.signingConfig = signingConfigs.getByName("ciSideload")` so debug builds and sideload builds share `ci.keystore` and never clash with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
     - Implement monotonic `versionCode` logic that prevents `INSTALL_FAILED_VERSION_DOWNGRADE` (e.g., base `100000 + (System.getenv("AIRBRIDGE_VERSION_CODE")?.toIntOrNull() ?: gitCommitCount)`).

6. **F19 (ANR Prevention, Discovery Concurrency & Verify Script)**:
   - In `android/app/src/main/kotlin/com/airbridge/app/Discovery.kt`:
     - Fix the `NsdManager.resolveService()` concurrency bug: Never reuse a single `ResolveListener`. Allocate a fresh `ResolveListener` per resolution request.
     - Implement a FIFO pending resolution queue with a 5-second watchdog timer to prevent hung resolutions from stalling the queue.
     - Handle API compatibility: Check `Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE` before calling `info.hostAddresses`. On API 26–33, fallback to `info.host`.
   - In `android/scripts/verify.sh`:
     - Replace Bash 4+ `mapfile -t ... < <(...)` with portable `while IFS= read -r line; do ... done < <(...)` loops to guarantee execution on macOS Bash 3.2.

## Verification & Deliverables
After implementing:
1. Run Gradle unit tests:
   `gradle -p android :engine:test` (or using the local gradle wrapper)
2. Build debug and release APKs:
   `gradle -p android :app:assembleDebug :app:assembleRelease`
3. Verify APK signatures using `apksigner`:
   `/Users/digantadey/Library/Android/sdk/build-tools/34.0.0/apksigner verify --verbose android/app/build/outputs/apk/release/app-release.apk`
   Confirm both `v1 scheme (JAR signing): true` and `v2 scheme: true`.
4. Run `/bin/bash android/scripts/verify.sh` to confirm bash 3.2 compatibility.
5. Write your handoff report to:
   `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/worker_m1_1/handoff.md`
   Follow the Handoff Protocol (Observation, Logic Chain, Caveats, Conclusion, Verification Method).
6. Send a message to me (`356d0616-42c7-4f9f-a377-37b34d9e8c2e`) notifying completion.
