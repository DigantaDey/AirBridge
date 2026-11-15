# Project: AirBridge Android Native Migration & Performance Optimization

## Architecture
AirBridge is a cross-platform local-network file and clipboard synchronization system connecting Android and Desktop clients over LAN with end-to-end encryption (AES-256-GCM, ECDH P-256).

### Subsystems:
1. **Desktop Host (`src/server/*`, `src/client/*`)**:
   - Node.js server on port 3000 multiplexing HTTP, HTTPS, and WebSocket (`/ws`) via `SignalingHub`.
   - mDNS advertiser (`_airbridge._tcp.local`) for automatic zero-configuration LAN discovery.
2. **Android Native Service & Engine (`android/engine/`, `android/app/`)**:
   - `ConnectionService`: Foreground Service managing persistent connection, Wi-Fi locks, wake locks, and clipboard synchronization.
   - `AirBridgeEngine`: Pure Kotlin engine handling ECDH key exchange, AES-256-GCM encryption/decryption, binary frame parsing, socket I/O, and disk file streaming.
   - `NativeEngineHost`: Bridge binding Android lifecycle and permissions to `AirBridgeEngine`.
3. **Android Native UI (`android/app/src/main/kotlin/com/airbridge/app/ui/`)**:
   - Modern Jetpack Compose UI with Material 3 design tokens.
   - Direct `StateFlow` reactive pipelines eliminating WebView, JavaScript bridges, and local HTTP loopback proxies.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Jetpack Compose Native UI | Fully native Compose UI replacing WebView, LoopbackRelay, and ShellBridge | M3 | R1, Survey 1 |
| F2 | Connection & Discovery Screen | Native mDNS peer list, manual IP:port input, and QR code scanner | M3 | R1, Survey 1 |
| F3 | Active Transfer Dashboard | Live transfer list with real-time transfer progress, MB/s speed, pause/cancel | M3 | R1, Survey 1 |
| F4 | Incoming Transfer Offer Modal | File offer details, SAS 4-digit verification code, image preview, auto-accept | M3 | R1, Survey 1 |
| F5 | Pairing Dock & Room Management | Device pairing QR code display, formatted room code ABC-DEF, rotate room | M3 | R1, Survey 1 |
| F6 | Clipboard Center & Compose | View shared clipboard history, manual text/image compose and beam | M3 | R1, Survey 1 |
| F7 | Native Settings Screen | Device name, background continuity, auto-beam, battery exemption, unpair | M3 | R1, Survey 1 |
| F8 | High-Throughput Chunk Pipeline | 1 MiB chunk size, pipelined window (16-32 MB), multi-MB/s sustained throughput | M2 | R2, Survey 2 |
| F9 | Socket Flush & Masking Optimization | Eliminate single-frame sync flush, optimized word-aligned masking / binary frames | M2 | R2, Survey 2 |
| F10 | Decoupled 3-Stage Crypto/IO Pipeline | Decoupled socket reader, multi-threaded crypto executor, sequential disk writer | M2 | R2, Survey 2 |
| F11 | Direct-to-MediaStore Streaming | Direct write to MediaStore.Downloads URI via FileChannel, zero duplicate copy pass | M2 | R2, Survey 2 |
| F12 | Compact Binary SACK | Replace heavy encrypted JSON ACKs with compact 16-byte binary SACK frames | M2 | R2, Survey 2 |
| F13 | Android 14+ FGS Type DataSync | Declare connectedDevice\|dataSync and FOREGROUND_SERVICE_DATA_SYNC permission | M1 | R3, Survey 3 |
| F14 | Background Continuity & Locks | Partial wake lock and low-latency Wi-Fi lock during active transfers/continuity | M1 | R3, Survey 3 |
| F15 | Battery Optimization Exemption | REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission and intent handling | M1 | R3, Survey 3 |
| F16 | Bidirectional Clipboard Sync | Background setPrimaryClip() ingest, Accessibility overlay capture, ShareTextActivity | M1 | R3, Survey 3 |
| F17 | APK Signing & Sideload Packaging | Enable v1 and v2 signing schemes; fix debug/ci keystore update conflict | M1 | R4, Survey 3 |
| F18 | Version Code & Packaging Conflict Fix | Resolve versionCode downgrade conflict between local and CI builds | M1 | R4, Survey 3 |
| F19 | ANR Elimination & Discovery Bug Fix | Fix NsdManager resolveService concurrency bug, eliminate main-thread SSL/asset I/O | M1 | R4, Survey 3 |
| F20 | E2E Integration & Verification | Pass 100% E2E test suite (Tiers 1-4) and Tier 5 adversarial coverage hardening | M4 | AC, Pattern |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Packaging, Reliability & Background Hardening | F13, F14, F15, F16, F17, F18, F19: Manifest FGS types, battery exemption, v1/v2/v3 signing, versioning, discovery fix, clipboard services | none | DONE |
| M2 | High-Speed Transfer Pipeline Engine | F8, F9, F10, F11, F12: 1MB chunking, socket streaming, decoupled 3-stage pipeline, direct MediaStore streaming, binary SACK | M1 | DONE |
| M3 | Native Jetpack Compose UI Migration | F1, F2, F3, F4, F5, F6, F7: Compose BOM, M3 screens, ViewModels, StateFlow, QR scanner, predictive back, deprecate LoopbackRelay & WebView | M1 | DONE |
| M4 | Final Milestone: E2E Validation & Adversarial Hardening | F20: 100% pass of E2E test suite (Tiers 1-4: 42 files / 254 tests) + native interop & Gradle APK verification | M1, M2, M3 | DONE |

---

## Interface Contracts

### 1. `NativeEngineHost` ↔ Jetpack Compose UI (`app/ui/`)
- **StateFlow Streams**:
  - `connectionState: StateFlow<ConnectionState>` (Disconnected, Connecting, Connected(peerName, roomCode, sasCode), Error)
  - `discoveredPeers: StateFlow<List<DiscoveredPeer>>` (id, name, host, port, isPinnedTls)
  - `activeTransfers: StateFlow<List<TransferItem>>` (id, fileName, totalBytes, transferredBytes, speedBytesPerSec, state)
  - `incomingOffers: StateFlow<TransferOffer?>` (id, senderName, fileCount, totalBytes, previewThumbnailUri, sasCode)
  - `clipboardHistory: StateFlow<List<ClipboardItem>>` (id, text, imageUri, timestamp, sourceDevice)
- **User Actions**:
  - `connectToPeer(peer: DiscoveredPeer)` / `connectManual(host: String, port: Int)`
  - `acceptTransfer(offerId: String)` / `rejectTransfer(offerId: String)` / `cancelTransfer(transferId: String)`
  - `sendFiles(uris: List<Uri>, peerId: String)`
  - `beamClipboard(text: String?, imageUri: Uri?)`

### 2. `AirBridgeEngine` ↔ `AndroidFileSinkFactory`
- **Streaming Sink Interface**:
  - `openSink(fileId: String, fileName: String, totalBytes: Long, mimeType: String): FileSink`
  - `FileSink.writeChunk(offset: Long, data: ByteBuffer)`
  - `FileSink.commit(): Uri`
  - `FileSink.abort()`
- **Direct MediaStore Implementation**:
  - Directly allocates `MediaStore.Downloads` URI with `IS_PENDING = 1`
  - Obtains `ParcelFileDescriptor` -> `FileChannel`
  - Writes chunks sequentially at offset with direct byte buffers
  - Updates `IS_PENDING = 0` on completion with zero intermediate copy pass.

### 3. Transport Protocol Framing (`Engine.kt` ↔ `src/server/*`)
- **Control Framing**: WebSocket text frames on `/ws` with ECDH handshake, peer enrollment, and room management.
- **Binary Data Framing**:
  - `0x01` (`FRAME_ENCRYPTED_CHUNK`): 1 MiB chunk payload + 12-byte IV + 16-byte GCM tag + 9-byte header.
  - `0x02` (`FRAME_BINARY_SACK`): 16-byte compact acknowledgment (fileIndex, chunkIndex, windowSize).
  - Pipelined flow control with up to 32 MiB in-flight chunks.

---

## Code Layout
```
android/
├── app/
│   ├── src/main/
│   │   ├── AndroidManifest.xml          # FGS types, permissions, service declarations
│   │   ├── kotlin/com/airbridge/app/
│   │   │   ├── MainActivity.kt          # Compose ComponentActivity & edge-to-edge
│   │   │   ├── ConnectionService.kt     # Foreground Service, locks, notification channels
│   │   │   ├── NativeEngineHost.kt      # StateFlow bridge between Engine & UI
│   │   │   ├── Discovery.kt             # Fixed NsdManager discovery
│   │   │   ├── ClipboardAccessibilityService.kt # Clipboard focus overlay listener
│   │   │   ├── ShareTextActivity.kt     # Share target
│   │   │   └── ui/                      # Jetpack Compose UI
│   │   │       ├── AirBridgeApp.kt      # NavHost & Scaffold
│   │   │       ├── theme/               # M3 Theme, Typography, Colors
│   │   │       ├── screens/             # Connect, Dashboard, Settings, Clipboard, History
│   │   │       ├── components/          # TransferModal, PairingDock, QrScanner
│   │   │       └── viewmodels/          # ConnectViewModel, DashboardViewModel, etc.
│   │   └── res/                         # Drawables, mipmaps, values
│   └── build.gradle.kts                 # Compose dependencies, v1/v2 signing, versionCode
├── engine/
│   ├── src/main/kotlin/com/airbridge/engine/
│   │   ├── Engine.kt                    # Decoupled 3-stage transfer engine
│   │   ├── WebSocketClient.kt           # Optimized socket streaming & masking
│   │   ├── Frames.kt                    # 1MB chunk framing & binary SACK
│   │   ├── Crypto.kt                    # AES-256-GCM hardware crypto pool
│   │   └── Files.kt                     # Direct FileSink & MediaStore streaming
│   └── src/test/kotlin/                 # Unit tests & test vectors
└── ci.keystore                          # Sideload signing keystore
```
