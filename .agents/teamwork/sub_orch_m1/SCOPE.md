# Scope: Milestone 1 (M1) - Packaging, Reliability, and Background Service Hardening

## Architecture
- Target components:
  - `android/app/src/main/AndroidManifest.xml`: Permissions (`FOREGROUND_SERVICE_DATA_SYNC`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), Service type declarations (`connectedDevice|dataSync`).
  - `android/app/build.gradle.kts`: Release signing configs (`v1SigningEnabled`, `v2SigningEnabled`), debug signing / installation compatibility, `versionCode` logic for local development.
  - `android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt`: Android 14+ FGS dataSync/connectedDevice type in `startForeground()`, Partial wake lock & Wi-Fi lock acquisition and refresh loop hardening.
  - `android/app/src/main/kotlin/com/airbridge/app/ClipboardAccessibilityService.kt`: Background clipboard ingestion & overlay reader verification.
  - `android/app/src/main/kotlin/com/airbridge/app/Discovery.kt`: NsdManager `ResolveListener` concurrency fix (dedicated listener per service found).
  - `android/scripts/verify.sh`: macOS Bash 3.2 compatibility (remove or replace `mapfile`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F13 | Android 14+ FGS Type DataSync | Permission declaration, manifest type, and startForeground() flags | M1 | PROJECT.md / Survey 3 |
| F14 | Background Continuity & Locks | CPU wake lock & Wi-Fi lock refresh loop hardening | M1 | PROJECT.md / Survey 3 |
| F15 | Battery Optimization | Request ignore battery optimizations permission and intent flow | M1 | PROJECT.md / Survey 3 |
| F16 | Clipboard Sync Services | Clipboard ingestion & overlay reader accessibility service | M1 | PROJECT.md / Survey 3 |
| F17 | Packaging & Signing | Explicit v1/v2 signing configs in release, debug signature clash prevention | M1 | PROJECT.md / Survey 3 |
| F18 | Versioning Logic | Dynamic or sane versionCode logic to prevent downgrade failures | M1 | PROJECT.md / Survey 3 |
| F19 | ANR Prevention & Concurrency | NsdManager resolveService concurrency fix, verify.sh bash 3.2 fix | M1 | PROJECT.md / Survey 3 |

## Interface Contracts & Constraints
- Android SDK 34 (Android 14) compatibility: `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` requires API 34+ check / flags.
- NsdManager resolution: ResolveListener must not be reused concurrently; one new instance per `onServiceFound`.
- verify.sh: Must execute cleanly on macOS bash (version 3.2.x) without `mapfile` or bash 4+ built-ins.
- Gradle build: `:engine:test` and `:app:assembleDebug` must pass cleanly.
