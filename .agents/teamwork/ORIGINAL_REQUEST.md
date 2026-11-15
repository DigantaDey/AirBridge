# Original User Request

## Initial Request — 2026-11-14T16:36:09Z

Convert the AirBridge Android app from a WebView-based interface into a fully native Android application, eliminating throughput and background transfer bottlenecks to achieve multi-MB/s file transfer speeds and uninterrupted background file transfer and clipboard synchronization.

Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
Integrity mode: development

## Verification Resources
- Local workspace environment at `/Users/digantadey/AndroidStudioProjects/AirBridge` containing the desktop server/client (`src/server/*`, `src/client/*`), Android project (`android/`), and Gradle build setup.
- Android tools (adb, Android SDK) and local build/test commands.

## Requirements

### R1. Native Android Application UI
Replace the existing WebView-based user interface in the Android app with a fully native Android UI (e.g. Jetpack Compose) for connection status, device discovery, file transfers, and settings.

### R2. High-Speed Local File Transfer Pipeline
Optimize the local file transfer engine and transport pipeline to achieve sustained multi-MB/s transfer speeds instead of KB/s, eliminating bottlenecks in frame serialization, socket streaming, buffer sizes, and flow control.

### R3. Uninterrupted Background File Transfer and Clipboard Synchronization
Ensure file transfers and clipboard synchronization continue uninterrupted when the Android app is placed in the background or when switching to other apps, utilizing appropriate foreground services, notification channels, accessibility services, and battery optimization configurations.

### R4. Project Reliability, Memory Optimization, and Clean Builds
Diagnose and eliminate memory bottlenecks, potential ANRs, and application update/installation issues ("cannot install this app on your device"), ensuring the Android application builds, signs, installs, and runs reliably.

## Acceptance Criteria

### Transfer Performance
- [ ] File transfer throughput achieves multi-megabyte per second (several MB/s) sustained transfer speeds over local connection.
- [ ] Transfer pipeline avoids buffer starvation, heap thrashing, and OutOfMemory errors during large file transfers.

### Native UI & User Experience
- [ ] Android application UI runs entirely as a native Android UI without using a WebView for the core interface.
- [ ] UI displays live connection status, real-time transfer progress, and settings with responsive rendering and no dropped frames or ANRs.

### Background Operation
- [ ] Active file transfers complete successfully while the application is backgrounded or when switching to another application.
- [ ] Clipboard updates synchronize bidirectionally between the Android device and desktop client while the Android app is running in the background.

### Build and Installation
- [ ] Android APK compiles cleanly via Gradle and installs or updates successfully on target Android devices without signature or package conflicts.
- [ ] Entire project passes verification tests without unhandled runtime exceptions or socket leaks.
