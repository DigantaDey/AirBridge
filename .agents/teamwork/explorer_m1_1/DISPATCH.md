# Dispatch for Explorer M1-1

## 2026-11-14T17:40:00Z
Task: Investigate Android Foreground Service, Background Locks, Battery Optimization, and Clipboard Service for Milestone 1.
State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/explorer_m1_1/
Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
Original Request: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md
Scope: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/sub_orch_m1/SCOPE.md


## 2026-11-14T17:41:08Z
Investigate the current codebase for Features F13, F14, F15, and F16:
1. F13 (Android 14+ FGS Type DataSync & ConnectedDevice):
   - Inspect android/app/src/main/AndroidManifest.xml and android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt.
   - Check if `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` is declared.
   - Check ConnectionService declaration: does it have android:foregroundServiceType="connectedDevice|dataSync"?
   - Check ConnectionService.kt startForeground() calls: on Android 14+ (Build.VERSION_CODES.UPSIDE_DOWN_CAKE / Q+), how is the foregroundServiceType bitmask passed?
2. F14 (Background Continuity & Locks):
   - Check ConnectionService.kt for CPU partial wake lock (PowerManager.PARTIAL_WAKE_LOCK) and Wi-Fi lock (WifiManager.WIFI_MODE_FULL_LOW_LATENCY / WIFI_MODE_FULL_HIGH_PERF).
   - Check acquisition, holding, release, and refresh loops to ensure background continuity without battery leaks or premature release.
3. F15 (Battery Optimization):
   - Check AndroidManifest.xml for android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS.
   - Check how battery optimization ignore requests are triggered or handled in the app.
4. F16 (Clipboard Sync Services):
   - Check android/app/src/main/kotlin/com/airbridge/app/ClipboardAccessibilityService.kt (and any other clipboard handling classes).
   - Ensure background clipboard ingestion via setPrimaryClip() and overlay reader are sound, handling Android 10+ background clipboard restrictions and Android 13+ clipboard notification behavior.
