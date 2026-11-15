# Dispatch Log

## 2026-11-14T17:37:35Z
You are the Sub-Orchestrator for Milestone 1 (M1) of Project AirBridge: Packaging, Reliability, and Background Service Hardening.

## Inputs & Context
- Original Request path: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md (MANDATORY: Read first)
- Project Scope: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/PROJECT.md
- Survey 3 Report: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_3/handoff.md
- Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
- Your state folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/sub_orch_m1/
- Parent Conversation ID: b1f332cd-d3fc-47c3-8ee9-ce273ea50971

## Milestone Scope & Features
Implement and verify Features F13, F14, F15, F16, F17, F18, F19:
1. **F13 (Android 14+ FGS Type DataSync)**:
   - In `android/app/src/main/AndroidManifest.xml`, declare `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />`.
   - Update `ConnectionService` declaration: `android:foregroundServiceType="connectedDevice|dataSync"`.
   - Update `ConnectionService.kt` to pass `FOREGROUND_SERVICE_TYPE_DATA_SYNC or FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` in `startForeground()` on Android 14+ (Q+ / UPSIDE_DOWN_CAKE+).
2. **F14 (Background Continuity & Locks)**:
   - Verify and harden CPU partial wake lock and low-latency Wi-Fi lock acquisition and refresh loop in `ConnectionService.kt`.
3. **F15 (Battery Optimization)**:
   - Declare `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` in `AndroidManifest.xml`.
   - Verify battery optimization request handling.
4. **F16 (Clipboard Sync Services)**:
   - Ensure background clipboard ingestion via `setPrimaryClip()` and overlay reader in `ClipboardAccessibilityService.kt` are sound.
5. **F17 & F18 (Packaging, Signing & Versioning)**:
   - In `android/app/build.gradle.kts`, configure `signingConfigs.getByName("release")` to explicitly set `v1SigningEnabled = true` and `v2SigningEnabled = true`.
   - Ensure debug builds can be installed and updated without signature clashes (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
   - Fix `versionCode` logic so that local development builds don't fail with `INSTALL_FAILED_VERSION_DOWNGRADE`.
6. **F19 (ANR Prevention & Discovery Concurrency)**:
   - In `android/app/src/main/kotlin/com/airbridge/app/Discovery.kt`, fix the `NsdManager.resolveService()` concurrency bug by instantiating a dedicated `NsdManager.ResolveListener` per service found instead of reusing a single instance.
   - Fix `android/scripts/verify.sh` Bash 3.2 compatibility on macOS (avoid `mapfile` failure).

## Orchestration Procedure
Run the standard iteration cycle or delegate to workers:
- Dispatch Worker (`teamwork_worker`) to implement the changes across `AndroidManifest.xml`, `app/build.gradle.kts`, `ConnectionService.kt`, `Discovery.kt`, and `verify.sh`.
- Dispatch Reviewers (`teamwork_reviewer`) to verify correctness, compilation, tests, and security.
- Dispatch Challenger (`teamwork_challenger`) to stress-test locks, discovery concurrency, and build outputs.
- Dispatch Forensic Auditor (`teamwork_auditor`) for integrity verification.
- Gate check: confirm clean build (`:engine:test`, `:app:assembleDebug`) and all checks pass.
- Write your final handoff.md and send completion message to parent.
