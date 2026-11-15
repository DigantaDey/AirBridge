# E2E Testing Infrastructure & Harness Design Report

**Author**: Explorer E2E Infra 2 (`explorer_e2e_infra_2`)  
**Target Project**: AirBridge (`/Users/digantadey/AndroidStudioProjects/AirBridge`)  
**Date**: 2026-11-14T18:45:00Z  
**Recipient**: Sub-Orchestrator E2E Testing (`7f2661f0-ab64-4c17-be3e-8d8702e77744`)  
**Purpose**: Architectural survey and technical recommendations to inform the authoring of `TEST_INFRA.md` and test suite implementation across Tiers 1 through 4.

---

## 1. Observation

### 1.1 Repository Structure, Toolchain & Available Test Runners
- **Node.js Environment**: Node.js `v25.6.0`, npm `11.8.0` on macOS Darwin arm64.
- **Root Configuration (`package.json`)**:
  - Module system: `"type": "module"` (native ECMAScript Modules).
  - Main test script: `"test": "vitest run"`.
  - Development tools: `"vitest": "^4.1.12"`, `"tsx": "^4.19.2"`, `"typescript": "^5.7.3"`, `"vite": "^6.1.0"`.
  - Installed binary: `vitest/3.2.7 darwin-arm64 node-v25.6.0`.
- **Existing Test Suite**:
  - `tests/` contains 27 test files covering unit, integration, and UI logic (e.g., `tests/protocol.test.ts`, `tests/e2e-transfer.test.ts`, `tests/background-clipboard-e2e.test.ts`, `tests/app-ui.test.tsx`).
  - Command run result: `npx vitest run tests/protocol.test.ts` passed 4 tests in **809 ms**.
  - Command run result: `npx vitest run tests/e2e-transfer.test.ts` passed 7 tests in **8.38 s** (executing complete discovery, SAS code verification, encrypted clipboard beaming, and multi-chunk file transfers over WebSocket).
- **Node.js Built-in Runner (`node:test`)**:
  - Node.js v25.6.0 includes `node:test` and `node:assert`.
  - Running TypeScript files under `node --test` requires loaders (e.g. `node --import tsx --test`), whereas Vitest natively compiles TypeScript, TSX, ESM, and provides rich assertion matchers (`expect(val).toBe(...)`, `rejects.toThrow()`), snapshot testing, and test filtering out-of-the-box.
- **Android Toolchain & `android/scripts/verify.sh`**:
  - Kotlin compiler: `/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc`.
  - Java runtime: `/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java` (JDK 21).
  - Android SDK platform: `/Users/digantadey/Library/Android/sdk/platforms/android-35/android.jar`.
  - Shell limitation observed: Executing `bash android/scripts/verify.sh` on macOS failed with:
    `verify: kotlinc not found (set KOTLINC=...)` and when provided, line 69 failed with `mapfile: command not found`. macOS default `/bin/bash` is GNU bash version 3.2.57 (which does not support `mapfile`, introduced in bash 4).

### 1.2 Desktop Server Architecture (`src/server/*`)
- **Server Factory (`src/server/index.ts` lines 122–148, 858–868)**:
  - Exported entrypoint: `createAirBridgeServer(options: AirBridgeServerOptions = {}): Promise<AirBridgeServerInstance>`.
  - Ephemeral port support: Setting `port: 0` causes `listeningServer.listen(0, host)` to bind to a free OS-assigned port. The active port is resolved from `listeningServer.address().port` and returned as `instance.port`.
  - Protocol detection / Port unification (lines 807–856): A TCP dispatcher listens on the port. It peeks at `firstChunk[0] === 0x16`. If it matches TLS ClientHello, it wraps the socket with `tlsModule.TLSSocket` using `httpsSecureContext` and emits `'connection'` on `httpServer`. If plaintext, it passes the raw socket. This allows both HTTP and HTTPS to coexist on the exact same port.
  - Teardown mechanics (lines 899–917):
    ```typescript
    async close() {
      mdns?.close();
      backgroundPeer?.stop();
      hub.setBackgroundClipboardActive(false);
      hub.close();
      await receiveStore.dispose();
      httpServer.closeAllConnections?.();
      httpsServer?.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        listeningServer.close(() => resolve());
      });
      if (dispatcher) {
        httpServer.close();
        httpsServer?.close();
      }
    }
    ```
- **Signaling Hub (`src/server/signalingHub.ts`)**:
  - WebSocket Server: Created with `noServer: true`, `perMessageDeflate: false`, and `maxPayload: 16 * 1024 * 1024` (16 MB).
  - Client capacity: `MAX_CLIENTS = 128`, `MAX_CLIENTS_PER_NETWORK = 32`.
  - Relay queue valve: `MAX_RELAY_BUFFERED_BYTES = 64 * 1024 * 1024` (64 MB backpressure ceiling). If `target.ws.bufferedAmount` exceeds 64 MB, the socket is terminated rather than silently dropping frames (line 595).
  - Loopback vs Remote Access Controls:
    - `/api/received-folder`, `/api/fs/list`, `/api/fs/mkdir` require `isLoopbackRequest` (strictly 127.0.0.1 or ::1). Non-loopback requests return `403 Forbidden`.
    - `/api/daemon/*` requires `isLocalMachineRequest` (local network interface addresses). Remote phones/laptops return `403 Forbidden`.
    - Cross-Origin Requests: `/api/*` requires `isSameOriginRequest(req)`; non-matching origin returns `403 Forbidden` (except `/api/beam/*`).

### 1.3 Wire Protocol, Framing & Cryptography Specifications
- **Handshake & Peer Discovery**:
  - Connection over WebSocket: `ws://127.0.0.1:<port>/ws`.
  - Registration: Client sends `hello` JSON:
    ```json
    {
      "type": "hello",
      "peerId": "<16 hex chars>",
      "pairCode": "<6 char code>",
      "visibility": "nearby" | "paired-only" | "hidden",
      "device": {
        "name": "Pixel 8 Pro",
        "platform": "android",
        "model": "Pixel",
        "formFactor": "phone",
        "publicKey": "<canonical base64url uncompressed 65-byte P-256 EC point>",
        "deviceId": "<16 hex chars>"
      }
    }
    ```
  - Server validation (`sanitizeDeviceProfile` lines 86–104): Rejects public keys that are not 65-byte uncompressed P-256 points starting with `0x04` or that fail canonical base64url round-tripping.
  - Server Response: `welcome` JSON with `peerId`, `pairCode`, `lanUrls`, `localDaemon`, and `peers` list.
  - Pairing & Room Management:
    - `join-pair`: Changes room code; rate-limited to 6 attempts per 60 seconds (`MAX_JOIN_PAIR_PER_WINDOW = 6`).
    - `rotate-pair`: Rotates room code to a fresh random 6-character Crockford code.
- **Control Message Framing (`src/shared/protocol.ts` lines 64–139, 166–170)**:
  - Envelope:
    ```json
    {
      "type": "transfer-control",
      "to": "<targetPeerId>",
      "envelope": {
        "encrypted": true,
        "iv": "<base64url-12-byte-nonce>",
        "ciphertext": "<base64url-aes-gcm-ciphertext>"
      }
    }
    ```
  - Unencrypted envelopes are restricted exclusively to `{ kind: 'ping' }` and `{ kind: 'pong' }` (`signalingHub.ts` lines 515–519). All others return `ENCRYPTION_REQUIRED`.
  - Inner Payloads: `transfer-offer`, `transfer-accept`, `transfer-decline`, `transfer-cancel`, `chunk-ack`, `file-complete`, `transfer-complete`, `transfer-complete-ack`, `clipboard-beam`, `history-sync`.
- **Binary Data Framing (`src/shared/protocol.ts` lines 259–370 & `android/engine/src/main/kotlin/com/airbridge/engine/Frames.kt`)**:
  - `FRAME_ENCRYPTED_CHUNK = 0x01` (37-byte header):
    - Byte `0`: `0x01`
    - Bytes `1..16`: `transferId` (16 ASCII hex characters)
    - Bytes `17..20`: `fileIndex` (UInt32 Big-Endian)
    - Bytes `21..24`: `chunkIndex` (UInt32 Big-Endian)
    - Bytes `25..36`: `iv` (12-byte AES-GCM nonce)
    - Bytes `37..N`: AES-256-GCM ciphertext + 16-byte authentication tag.
  - `FRAME_ROUTED_RELAY = 0x02` (33-byte header):
    - Byte `0`: `0x02`
    - Bytes `1..16`: `targetPeerId` (16 ASCII hex characters)
    - Bytes `17..32`: `sourcePeerId` (16 ASCII hex characters)
    - Bytes `33..N`: Inner payload (e.g. `FRAME_ENCRYPTED_CHUNK`).
    - Security stamp: `SignalingHub.routeBinaryFrame` overwrites `sourcePeerId` with the authenticated sender's peerId to prevent identity spoofing (`overwriteRoutedSourcePeerId`).
  - `FRAME_BINARY_SACK` (Planned Milestone M2 feature F12):
    - Compact 16-byte binary frame acknowledging chunk sequence and window size, replacing heavy JSON `chunk-ack` messages.
- **End-to-End Cryptography (`src/client/engine/crypto.ts`)**:
  - Key Exchange: Ephemeral ECDH over NIST curve P-256 (`secp256r1`).
  - Salt: SHA-256 digest of `airbridge-salt:${[myPubKey, peerPubKey].sort().join(':')}`.
  - Key Derivation: HKDF-SHA-256 with salt and info `'airbridge-warp-e2ee-v1'` producing 256-bit AES-GCM key.
  - SAS Code Verification: Derived from SHA-256 of `airbridge-sas-v1:${sortedPubs}`, formatted as `XXX · YYY` (6 digits from `view.getUint32(0, false) % 1_000_000`).

---

## 2. Logic Chain

1. **Test Runner Selection (Vitest)**:
   - *Observation*: Vitest v3.2.7 is already installed in devDependencies; `npx vitest run` executes existing tests in sub-second times; Vitest handles TypeScript/ESM natively without build artifacts.
   - *Reasoning*: Utilizing Vitest maintains zero overhead, aligns with the existing codebase conventions, supports fast execution of concurrent test files, and avoids loader complexity inherent in `node --test --import tsx`.
   - *Conclusion*: Vitest should be designated as the single unified test runner for all E2E test suites (`npm run test:e2e`).

2. **Ephemeral Server Lifecycle & Isolation**:
   - *Observation*: `createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false })` binds to an ephemeral OS-assigned port and provides an explicit `close()` method that shuts down HTTP, HTTPS, WebSockets, and timers.
   - *Reasoning*: By spinning up an ephemeral server per test suite (or per test) on port 0, tests cannot experience port collisions (EADDRINUSE), can run in parallel across CPU threads, and guarantee total isolation without global state bleed.
   - *Conclusion*: The test harness should provide a reusable `ServerManager` fixture that handles asynchronous startup on port 0 and guarantees teardown in `afterAll`/`afterEach`.

3. **Opaque-Box Testing Strategy**:
   - *Observation*: The system under test communicates over standard network interfaces: HTTP/HTTPS REST endpoints and WebSocket framing (Warp v1 protocol with binary chunks and AES-256-GCM / ECDH cryptography).
   - *Reasoning*: Rather than importing internal server classes or mocking private state, an opaque-box harness should simulate clients as actual network peers (`OpaquePeer`) connecting via WebSocket and HTTP. This verifies real wire compatibility, catches serialization bugs, and prevents white-box coupling.
   - *Conclusion*: Build an `OpaquePeer` harness capable of simulating Android native clients, Mac desktop clients, and malicious/adversarial peers directly over TCP/WebSocket.

4. **Structuring the 4-Tier Test Hierarchy (>= 220 tests target)**:
   - *Observation*: Sub-orchestrator briefing specifies: Tier 1 (>=95 tests), Tier 2 (>=95 tests), Tier 3 (>=20 tests), Tier 4 (>=10 scenarios), covering all features F1 through F19.
   - *Reasoning*:
     - **Tier 1 (Feature Coverage)**: Requires testing each individual feature F1-F19 in isolation against its contract and specification (5-6 tests per feature × 19 features = ~100 tests).
     - **Tier 2 (Boundary & Corner Cases)**: Requires testing edge conditions across file sizes (0 bytes, 10 GB), packet corruption, tampered crypto, buffer overflows, rate limits, malformed frames, and network drops (7 suites × ~14 tests = ~98 tests).
     - **Tier 3 (Cross-Feature Combinations)**: Requires testing pairwise interactions where multiple features operate concurrently (e.g., active file transfer + clipboard beaming + pair code rotation) (5 suites × ~4-5 tests = ~22 tests).
     - **Tier 4 (Real-World Scenarios)**: Requires executing complete end-to-end user journeys from clean boot to completion (10 distinct real-world scenarios).
   - *Conclusion*: The test directory should be organized strictly into `tests/e2e/tier1-feature-coverage/`, `tests/e2e/tier2-boundary-corner/`, `tests/e2e/tier3-cross-feature/`, and `tests/e2e/tier4-real-world/`.

---

## 3. Caveats

1. **Android Operating System APIs vs Wire-Level Simulation**:
   - Android-specific OS subsystems (e.g. `MediaStore.Downloads`, `AccessibilityService`, `PowerManager.PARTIAL_WAKE_LOCK`, `WifiManager.WIFI_MODE_FULL_LOW_LATENCY`, and Jetpack Compose composable rendering) cannot run directly in the Node.js test harness without an Android emulator or device.
   - *Resolution*: The E2E test harness verifies all wire protocols, StateFlow interface contracts, binary frame codecs, serialization formats, and REST endpoints. Android Manifest configurations and Gradle build configurations are verified via static structural audits, while Android on-device tests can be executed via Gradle / Android instrumentation when devices are attached.
2. **Bash Compatibility on macOS**:
   - `android/scripts/verify.sh` uses `mapfile`, which is not available in macOS default `/bin/bash` (v3.2). Tests executing shell preflights should invoke `zsh` or ensure bash >= 4 is used, or the script should be refactored to use standard POSIX `read` loops.
3. **Milestone M2 Feature Availability (F12 Compact Binary SACK)**:
   - In the current repository state (Milestone M1), compact binary SACK (`0x02` frame) is planned for Milestone M2. The test harness must support testing both the existing JSON `chunk-ack` framing and the upcoming 16-byte binary SACK framing.

---

## 4. Conclusion & Recommendations

### 4.1 Recommended Test Directory Layout

```
tests/e2e/
├── harness/
│   ├── index.ts                  # Public harness exports
│   ├── serverManager.ts          # Ephemeral AirBridge server lifecycle manager
│   ├── opaquePeer.ts             # Network-level simulated peer (Android & Desktop)
│   ├── wireCrypto.ts             # Standalone ECDH P-256, HKDF, AES-256-GCM, SAS derivation
│   ├── frameCodec.ts             # 0x01 Chunk Frame, 0x02 Routed Relay, 0x02 Binary SACK
│   ├── testFixtures.ts           # Synthetic files, streams, corrupted payloads, and assertions
│   └── manifestAuditor.ts        # AndroidManifest and Gradle build configuration inspectors
│
├── tier1-feature-coverage/       # >= 95 tests (Features F1 through F19)
│   ├── f01_compose_ui_contract.test.ts
│   ├── f02_discovery_and_connect.test.ts
│   ├── f03_transfer_dashboard.test.ts
│   ├── f04_transfer_offer_modal.test.ts
│   ├── f05_pairing_dock_and_rooms.test.ts
│   ├── f06_clipboard_center_and_compose.test.ts
│   ├── f07_settings_and_folder_config.test.ts
│   ├── f08_high_throughput_pipeline.test.ts
│   ├── f09_socket_flush_and_masking.test.ts
│   ├── f10_decoupled_crypto_io.test.ts
│   ├── f11_mediastore_streaming_sink.test.ts
│   ├── f12_compact_binary_sack.test.ts
│   ├── f13_fgs_datasync_manifest.test.ts
│   ├── f14_background_continuity_locks.test.ts
│   ├── f15_battery_optimization_contract.test.ts
│   ├── f16_bidirectional_clipboard_sync.test.ts
│   ├── f17_apk_signing_schemes.test.ts
│   ├── f18_version_code_packaging.test.ts
│   └── f19_anr_and_discovery_fix.test.ts
│
├── tier2-boundary-corner/        # >= 95 tests (Edge cases, limits, and malformations)
│   ├── file_size_extremes.test.ts             # 0-byte files, multi-GB files, empty manifest
│   ├── malformed_json_and_frames.test.ts      # Invalid JSON, truncated frames, bad types
│   ├── crypto_and_auth_tampering.test.ts      # Invalid GCM tag, IV reuse, forged sender IDs
│   ├── rate_limiting_and_dos.test.ts          # Join-pair spam, max client limits, oversized frames
│   ├── network_throttling_and_backpressure.test.ts # Slow consumer, 64MB relay valve trigger
│   ├── connection_drop_and_resumption.test.ts # Mid-chunk drops, reconnects, resume tokens
│   └── loopback_and_security_boundary.test.ts # Remote attempts on /api/received-folder & daemon
│
├── tier3-cross-feature/          # >= 20 tests (Pairwise and complex combinations)
│   ├── transfer_with_clipboard_concurrency.test.ts # Streaming 50MB while beaming text/images
│   ├── pair_rotation_during_active_transfer.test.ts # Room rotate during transfer streaming
│   ├── multi_peer_mesh_relay.test.ts               # 3+ peers cross-transferring in same room
│   ├── background_drop_and_resume_pipeline.test.ts # Transfer drop, app restart, resume from offset
│   └── tls_upgrade_and_http_coexistence.test.ts    # Dual TLS/HTTP on single port with redirects
│
└── tier4-real-world/             # >= 10 scenarios (Complete user journey scenarios)
    ├── scenario_01_qr_pairing_and_ca_trust.test.ts # First-time setup, CA fetch, SAS verify
    ├── scenario_02_large_media_gallery_sync.test.ts # 50 photos + 2 videos multi-file transfer
    ├── scenario_03_bidirectional_clipboard_storm.test.ts # Rapid concurrent copying & echo check
    ├── scenario_04_interrupted_wifi_handover.test.ts # Sudden socket close and seamless resume
    ├── scenario_05_multi_device_room_sharing.test.ts # Laptop + 2 phones collaborative sync
    ├── scenario_06_decline_and_reoffer_flow.test.ts # Offer decline, re-negotiate, accept
    ├── scenario_07_background_transfer_continuity.test.ts # Emulated background lock continuity
    ├── scenario_08_corrupted_chunk_detection.test.ts # Bit-flip in ciphertext, recovery / abort
    ├── scenario_09_low_storage_graceful_abort.test.ts # Simulated disk full, cleanup of .part
    └── scenario_10_app_upgrade_history_sync.test.ts # Reconnect after update, sync transfer log
```

### 4.2 Test Runner Command Configuration

In `package.json`, add the following dedicated npm scripts:
```json
{
  "scripts": {
    "test:e2e": "vitest run tests/e2e",
    "test:e2e:tier1": "vitest run tests/e2e/tier1-feature-coverage",
    "test:e2e:tier2": "vitest run tests/e2e/tier2-boundary-corner",
    "test:e2e:tier3": "vitest run tests/e2e/tier3-cross-feature",
    "test:e2e:tier4": "vitest run tests/e2e/tier4-real-world",
    "test:e2e:watch": "vitest watch tests/e2e"
  }
}
```

Direct CLI invocation commands:
- Run entire E2E test suite: `npx vitest run tests/e2e`
- Run specific tier: `npx vitest run tests/e2e/tier1-feature-coverage`
- Run single test file: `npx vitest run tests/e2e/tier1-feature-coverage/f08_high_throughput_pipeline.test.ts`
- Run with concurrency limit (if testing system load): `npx vitest run tests/e2e --maxConcurrency=4`

### 4.3 Opaque-Box Harness Design Architecture

#### Module 1: `ServerManager` (`tests/e2e/harness/serverManager.ts`)
Encapsulates `createAirBridgeServer` lifecycle:
```typescript
export interface TestServerInstance {
  port: number;
  wsUrl: string;
  httpUrl: string;
  server: AirBridgeServerInstance;
  close: () => Promise<void>;
}

export async function createTestServer(options: Partial<AirBridgeServerOptions> = {}): Promise<TestServerInstance> {
  const server = await createAirBridgeServer({
    port: 0,
    host: '127.0.0.1',
    mode: 'test',
    enableMdns: false,
    https: false,
    hostClipboard: false,
    receivedFolderSettingsPath: null,
    ...options,
  });
  const port = server.port;
  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    server,
    close: () => server.close(),
  };
}
```

#### Module 2: `OpaquePeer` (`tests/e2e/harness/opaquePeer.ts`)
A fully opaque WebSocket network client that simulates either Android or Desktop peers strictly via protocol messages:
- **Properties**: `peerId`, `pairCode`, `discoveredPeers`, `sessionKeys` (Map of peerId to `PeerCryptoSession`).
- **Methods**:
  - `connect(wsUrl: string)`: Opens socket, generates P-256 keys, sends `hello`, awaits `welcome`.
  - `sendControl(targetPeerId: string, payload: ControlPayload)`: Encrypts with derived AES-GCM session key and sends `transfer-control`.
  - `sendChunk(targetPeerId: string, transferId: string, fileIndex: number, chunkIndex: number, plaintext: Uint8Array)`: Encrypts and frames binary chunk inside 0x02 routed relay frame.
  - `sendBinarySack(targetPeerId: string, transferId: string, fileIndex: number, chunkIndex: number, windowSize: number)`: Sends compact binary SACK frame.
  - `waitForControl(predicate: (payload: ControlPayload) => boolean, timeoutMs?: number)`: Resolves when matching decrypted control payload arrives.
  - `waitForChunk(predicate: (frame: DecryptedChunk) => boolean, timeoutMs?: number)`: Resolves when matching decrypted binary chunk arrives.
  - `disconnect()`: Cleanly terminates socket and clears pending listeners.

#### Module 3: `WireCrypto` (`tests/e2e/harness/wireCrypto.ts`)
Provides byte-for-byte compatible ECDH P-256, HKDF-SHA-256, AES-256-GCM, and SAS derivation matching `src/client/engine/crypto.ts` and `android/engine/src/main/kotlin/com/airbridge/engine/Crypto.kt`.

#### Module 4: `FrameCodec` (`tests/e2e/harness/frameCodec.ts`)
Provides encoding, decoding, and byte-level tampering utilities for 0x01 encrypted chunk frames, 0x02 routed relay frames, and 0x02/compact binary SACK frames.

---

## 5. Verification Method

### 5.1 Verification Commands
1. **Validate Test Runner Performance**:
   ```bash
   npx vitest run tests/protocol.test.ts
   npx vitest run tests/e2e-transfer.test.ts
   ```
   *Expected outcome*: `protocol.test.ts` passes 4/4 in < 1s; `e2e-transfer.test.ts` passes 7/7 in < 10s without unhandled rejections or socket leaks.

2. **Verify Ephemeral Port Allocation**:
   ```bash
   node -e "
     import('./src/server/index.js').then(async (m) => {
       const s1 = await m.createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false });
       const s2 = await m.createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false });
       console.log('Server 1 port:', s1.port, 'Server 2 port:', s2.port);
       if (s1.port === s2.port || s1.port === 0 || s2.port === 0) throw new Error('Port collision or invalid port');
       await s1.close();
       await s2.close();
       console.log('Clean shutdown verified');
     });
   "
   ```
   *Expected outcome*: Two distinct non-zero ports logged, cleanly closed.

3. **Verify Full E2E Test Suite Execution (Once Implemented)**:
   ```bash
   npm run test:e2e
   ```
   *Expected outcome*: 100% pass across all test files in `tests/e2e/tier1-feature-coverage/`, `tests/e2e/tier2-boundary-corner/`, `tests/e2e/tier3-cross-feature/`, and `tests/e2e/tier4-real-world/` with total test count >= 220.

### 5.2 Files to Inspect
- `/Users/digantadey/AndroidStudioProjects/AirBridge/package.json` — verify `vitest` dependency and test scripts.
- `/Users/digantadey/AndroidStudioProjects/AirBridge/src/server/index.ts` — verify `createAirBridgeServer` options and `close()` lifecycle.
- `/Users/digantadey/AndroidStudioProjects/AirBridge/src/server/signalingHub.ts` — verify WebSocket signaling, rate limiting, and binary routing.
- `/Users/digantadey/AndroidStudioProjects/AirBridge/src/shared/protocol.ts` — verify frame headers, sizes, and payload types.
- `/Users/digantadey/AndroidStudioProjects/AirBridge/src/client/engine/crypto.ts` — verify ECDH P-256 and AES-256-GCM algorithms.
- `/Users/digantadey/AndroidStudioProjects/AirBridge/android/engine/src/main/kotlin/com/airbridge/engine/Frames.kt` — verify Kotlin binary frame parity.

### 5.3 Invalidation Conditions
- If `createAirBridgeServer({ port: 0 })` fails to release open sockets or background timers upon `close()`, causing hanging processes.
- If WebSocket server limits (`maxPayload = 16MB`, `MAX_RELAY_BUFFERED_BYTES = 64MB`) are altered without updating the corresponding test thresholds.
- If Android or Desktop crypto transitions from NIST P-256 / AES-256-GCM to another algorithm suite.
