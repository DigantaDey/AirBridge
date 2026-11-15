# Progress Log — teamwork_explorer_survey_3

Last visited: 2026-11-14T17:35:00Z

- [x] Initialized DISPATCH.md, BRIEFING.md, and progress.md
- [x] Inspect AndroidManifest.xml and current service architectures
  - Foreground service declared with `foregroundServiceType="connectedDevice"`.
  - Android 14+ `FOREGROUND_SERVICE_DATA_SYNC` is NOT declared in permissions or service types despite data sync/transfers.
  - POST_NOTIFICATIONS, WAKE_LOCK, high perf WiFi locks present.
  - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS is NOT declared in manifest; runtime intent uses ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS fallback to ACTION_APPLICATION_DETAILS_SETTINGS.
- [x] Inspect background file transfer implementation and foreground service lifecycle
  - Native engine runs independently in background via `NativeEngineHost` and `AirBridgeEngine`.
  - CPU wake lock + Wi-Fi lock kept alive during transfer or if `connectionContinuity` preference is enabled.
- [x] Inspect clipboard sync implementation, limitations on Android 10+ (Q+), and solutions
  - Android 10+ clipboard background access restriction (requires window focus or default IME).
  - Outgoing clipboard from Android: `ClipboardAccessibilityService` uses `TYPE_ACCESSIBILITY_OVERLAY` to briefly capture window focus to read `ClipboardManager`. Requires user to enable Accessibility Service in Settings (faces Android 13+ restricted settings hurdle for sideloaded apps).
  - Incoming clipboard to Android: `setPrimaryClip()` works in background service; Android 13+ shows clipboard visual overlay toast.
  - Fallback sharing via `ShareTextActivity` (`ACTION_SEND`, `ACTION_PROCESS_TEXT`).
- [x] Inspect ANR risks (main thread network/disk I/O) and socket / receiver lifecycle
  - `AirBridgeEngine` handles network I/O, crypto, and disk I/O on dedicated background thread pools.
  - Socket cleanup on disconnect / destroy: `closeQuietly` on socket lists, `cleanupExecutor` pauses sinks without holding monitor.
  - ANR risks: `LoopbackRelay` SSLContext initialization and ServerSocket binding on main thread in `MainActivity.startRelay()`; asset reading synchronously on main thread during `showConnectScreen` and `injectNativeShellShim`.
  - `NsdManager.resolveService()` concurrency bug prior to Android 14 (reusing single ResolveListener causes `FAILURE_ALREADY_ACTIVE`).
- [x] Inspect Gradle build configuration, AGP, Kotlin, wrapper, signing, and "cannot install this app" issue
  - Root causes: signature conflict (`ci.keystore` on both debug/release vs default debug.keystore), version code downgrade (local 10000 vs CI run numbers), missing v1 JAR signature scheme.
- [x] Run Gradle build and tests to verify workspace status
  - Gradle 8.9 `:engine:test` and `:app:assembleDebug` succeed cleanly.
  - All 62 test vectors pass.
- [x] Synthesize findings and write comprehensive handoff.md
