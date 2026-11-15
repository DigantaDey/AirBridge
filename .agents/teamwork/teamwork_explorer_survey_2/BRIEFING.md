# BRIEFING — 2026-11-14T17:16:00Z

## Mission
Map and analyze networking protocols, file transfer pipeline, and performance bottlenecks between Desktop and Android.

## 🔒 My Identity
- Archetype: explorer
- Roles: networking investigator, performance analyst
- Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
- State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/
- Original parent: b1f332cd-d3fc-47c3-8ee9-ce273ea50971
- Milestone: Survey & Investigation

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Scope limited to analysis and proposal, no source code modification
- Detailed report in handoff.md; regular heartbeat updates in progress.md

## Current Parent
- Conversation ID: b1f332cd-d3fc-47c3-8ee9-ce273ea50971
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `src/shared/protocol.ts` (data models, binary codecs 0x01/0x02, base64url, control payloads)
  - `src/server/signalingHub.ts` & `src/server/index.ts` (WebSocket server, binary relay, port multiplexer, daemon receive routes)
  - `src/client/engine/warpClient.ts` (Desktop WebCrypto producer/consumer, flow control, chunk stream receivers)
  - `src/client/engine/nativeShell.ts` & `nativeClient.ts` (bridge contracts, polling snapshots, base64 file saves)
  - `android/engine/src/main/kotlin/com/airbridge/engine/*` (Frames, Model, WebSocketClient, Engine, Files, Crypto, ByteBoundedQueue)
  - `android/app/src/main/kotlin/com/airbridge/app/*` (MainActivity, LoopbackRelay, ShellBridge, NativeEngineHost, ConnectionService, NativeFiles)
  - Test suites (`tests/transfer-speed.test.ts`, `tests/file-integrity.test.ts`, `TransportTest.kt`)
- **Key findings**:
  1. Desktop supports WebRTC DataChannels + ws-relay, but Android has no WebRTC support, forcing all Android traffic over WebSocket relay through SignalingHub.
  2. Legacy WebView bridge suffered severe bottleneck: converting 256KB chunks to Base64 strings in JS, passing across `@JavascriptInterface` to Kotlin, decoding Base64, and writing to disk.
  3. Native Kotlin Engine has multiple critical throughput chokepoints:
     - WebSocket RFC 6455 client-to-server 4-byte masking using `SecureRandom` + byte-by-byte XOR per frame.
     - Synchronous `out.flush()` after every 256KB chunk frame in `WebSocketClient`.
     - Inbound reading, AES-256-GCM decryption, and disk writes serialized on single worker thread (`airbridge-receiver`).
     - Heavyweight ACK mechanism: JSON building -> UTF-8 -> AES-256-GCM -> Base64Url -> outer JSON -> UTF-8 -> WebSocket text frame.
     - Android `AndroidFileSinkFactory` performs duplicate copying: writes to internal `.part` file, then synchronously copies the entire file into MediaStore Downloads (`copyTo(256KB)`).
     - Browser receiver accumulates chunks in RAM (`fileChunks[fileIndex][chunkIndex]`), causing OOM on multi-GB transfers.
- **Unexplored areas**: None, full data path mapped.

## Key Decisions Made
- Formulated concrete high-speed transport architecture: direct raw TCP data socket / NIO channel, 1MB chunk size, pooled direct ByteBuffers, decoupled 3-stage worker pipeline, binary SACK framing, and direct-to-MediaStore streaming.

## Artifact Index
- /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/handoff.md — Final handoff report
- /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/progress.md — Liveness heartbeat and progress
