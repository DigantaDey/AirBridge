# BRIEFING — 2026-11-14T17:35:00Z

## Mission
Map and analyze AirBridge Android background execution model, clipboard synchronization architecture, build/packaging setup, reliability (ANR/memory), and installation issues.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
- State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_3/
- Original parent: b1f332cd-d3fc-47c3-8ee9-ce273ea50971
- Milestone: survey_3_background_clipboard_build

## 🔒 Key Constraints
- Read-only investigation — do NOT implement or modify source code
- Files for content delivery, messages for coordination
- Self-contained 5-component handoff.md report
- Keep BRIEFING.md under ~100 lines

## Current Parent
- Conversation ID: b1f332cd-d3fc-47c3-8ee9-ce273ea50971
- Updated: 2026-11-14T17:35:00Z

## Investigation State
- **Explored paths**:
  - `android/app/src/main/AndroidManifest.xml`
  - `android/app/src/main/kotlin/com/airbridge/app/*` (ConnectionService, ClipboardAccessibilityService, ShellBridge, MainActivity, NativeFiles, LoopbackRelay, Discovery, QrScannerView, etc.)
  - `android/engine/src/main/kotlin/com/airbridge/engine/*` (Engine, Model, Frames, WebSocketClient, Crypto, Files, etc.)
  - `android/build.gradle.kts`, `android/app/build.gradle.kts`, `android/engine/build.gradle.kts`
  - `android/ci.keystore`, `android/scripts/verify.sh`
- **Key findings**:
  - Root causes of "Cannot install this app on your device": signature mismatch (hardcoded `ci.keystore` vs debug keystore), version code downgrade (local 10000 vs CI run numbers), missing v1 JAR signature scheme.
  - Background FGS: uses `connectedDevice`, lacks Android 14+ `dataSync` type and `FOREGROUND_SERVICE_DATA_SYNC` permission. Missing `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
  - Clipboard sync: Android 10+ limitation bypassed via `ClipboardAccessibilityService` overlay; hampered by Android 13+ restricted settings. Incoming clipboard works via `setPrimaryClip`.
  - ANR / reliability: Engine offloads all I/O from main thread. Minor ANRs identified in `LoopbackRelay` SSLContext init and asset reading in MainActivity, and `NsdManager` single listener concurrency bug.
  - Verification: Gradle test and build commands verified; macOS zsh script passes all 62 vectors.
- **Unexplored areas**: None remaining within survey 3 scope.

## Key Decisions Made
- Completed full 5-component report at `.agents/teamwork/teamwork_explorer_survey_3/handoff.md`.

## Artifact Index
- /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_3/DISPATCH.md — Original dispatch message
- /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_3/BRIEFING.md — Persistent state
- /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_3/progress.md — Liveness & progress tracker
- /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_3/handoff.md — Final investigation report
