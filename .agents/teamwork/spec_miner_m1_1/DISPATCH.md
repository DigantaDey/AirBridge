## 2026-11-14T17:42:09Z
You are a Spec Miner agent for Milestone 1 (M1) of Project AirBridge.

## Inputs & Context
- MANDATORY FIRST STEP: Read the original user request at:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md`
- Read the project plan at:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/PROJECT.md`
- Read the scope document at:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/sub_orch_m1/SCOPE.md`
- Your state folder:
  `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/spec_miner_m1_1/`
- Working directory:
  `/Users/digantadey/AndroidStudioProjects/AirBridge`

## Objective
Extract authoritative requirements and exact specifications for:
1. **Android 14+ Foreground Service Types & Permissions**:
   - What exact permissions are needed for `foregroundServiceType="connectedDevice|dataSync"` on API 34+?
     (e.g., `android.permission.FOREGROUND_SERVICE`, `android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE`, `android.permission.FOREGROUND_SERVICE_DATA_SYNC`).
   - What exact code is required in Kotlin for `Service.startForeground()` across Android versions:
     - Android 14+ (`Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE` or API 34): `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`.
     - Android 10-13 (`Build.VERSION_CODES.Q` to 33): `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`.
     - Below Q (API < 29): `startForeground(id, notification)`.
2. **Battery Optimization**:
   - Exact permission `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />` and `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent contract.
3. **APK Signing Specification (AGP 8.x / Kotlin DSL)**:
   - Exact syntax for `v1SigningEnabled = true` and `v2SigningEnabled = true` in `signingConfigs.getByName("release")` or `create("release")` in `build.gradle.kts`.
4. **NsdManager Resolution API Contract**:
   - Why `NsdManager.resolveService()` fails with `FAILURE_ALREADY_ACTIVE` if a single `ResolveListener` is reused concurrently, and the exact Google recommended pattern (creating a fresh listener per resolution request, with timeouts or queuing).

## Deliverable
Write your specification report to:
`/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/spec_miner_m1_1/handoff.md`
Then notify me with `send_message`. Do NOT modify code.
