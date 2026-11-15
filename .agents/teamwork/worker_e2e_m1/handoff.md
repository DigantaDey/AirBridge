# Milestone E2E-M1 Handoff Report: Test Runner & Opaque Harness Implementation

**Author**: Worker E2E-M1 (`worker_e2e_m1`)  
**Target Milestone**: E2E-M1 (Test Runner & Opaque Harness Implementation)  
**Date**: 2026-11-14T18:53:00Z  
**Recipient**: Sub-Orchestrator E2E Testing (`7f2661f0-ab64-4c17-be3e-8d8702e77744`)  

---

## 1. Observation

1. **Test Infrastructure Requirements**:
   - `TEST_INFRA.md` specifies a 4-tier test architecture covering features F1 through F19 with ≥ 220 tests total.
   - All tests interact strictly through public network interfaces (HTTP REST APIs, WebSocket signaling on `/ws`, binary frame transport, and Android build artifacts/manifests) without internal white-box mocks.
   - Each test scenario provisions ephemeral server instances on OS-assigned ports (`port: 0`) with ephemeral cryptographic identities.

2. **Existing Protocol and Crypto Implementations**:
   - `src/client/engine/crypto.ts`: Implements ECDH P-256 key exchange, HKDF-SHA-256 key derivation with salt `airbridge-salt:${sortedPubs}` and info `'airbridge-warp-e2ee-v1'`, AES-256-GCM encryption/decryption, and 6-digit SAS code derivation from SHA-256 `airbridge-sas-v1:${sortedPubs}` (lines 65–134).
   - `src/shared/protocol.ts`: Implements 0x01 encrypted chunk frame (37-byte header: `0x01`, 16-byte transferId, 4-byte fileIndex, 4-byte chunkIndex, 12-byte IV) and 0x02 routed relay frame (33-byte header: `0x02`, 16-byte targetPeerId, 16-byte sourcePeerId).
   - `android/engine/src/main/kotlin/com/airbridge/engine/Frames.kt`: Kotlin mirror of 0x01 chunk and 0x02 routed relay framing.
   - `PROJECT.md` line 87 & `teamwork_explorer_survey_2/handoff.md` lines 286–295: Define compact 16-byte binary SACK framing (`FRAME_BINARY_SACK`).

3. **Android Configuration**:
   - `android/app/src/main/AndroidManifest.xml`: Declares permissions `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `WAKE_LOCK`, and declares `ConnectionService` with `android:foregroundServiceType="connectedDevice|dataSync"`.
   - `android/app/build.gradle.kts`: Declares `compileSdk = 35`, `minSdk = 26`, `targetSdk = 35`, and `ciSideload` signing config with `enableV1Signing = true` and `enableV2Signing = true`.

4. **Implemented Test Harness Files (`tests/e2e/harness/`)**:
   - `serverManager.ts`: Exports `createTestServer(options)` wrapping `createAirBridgeServer` with `port: 0`, `host: '127.0.0.1'`, `mode: 'test'`, `enableMdns: false`, returning `{ port, wsUrl, httpUrl, server, close }` with idempotent cleanup, plus `closeAllTestServers()`.
   - `wireCrypto.ts`: Standalone implementation of `generateIdentityKeyPair()`, `derivePeerSession()`, `deriveSasCode()`, `encryptControlPayload()`, `decryptControlPayload()`, `encryptBinaryChunk()`, `decryptBinaryChunk()`, `sha256Hex()`, and raw key import/export utilities matching Android and Desktop protocols.
   - `frameCodec.ts`: Encoders and decoders for `0x01` Encrypted Chunk Frames, `0x02` Routed Relay Frames, and 16-byte compact Binary SACK frames, along with tampering methods: `corruptAuthTag()`, `flipBit()`, `truncateFrame()`, `expandFrame()`, `corruptFrameType()`, `corruptIv()`, `tamperTransferId()`, `tamperRoutingTarget()`, and `tamperRoutingSource()`.
   - `opaquePeer.ts`: Full network-level client simulator for Android and Desktop peers over WebSocket at `ws://127.0.0.1:<port>/ws`. Manages connection, `hello`/`welcome` handshake, peer registration, ECDH public key exchange, encrypted `transfer-control` messaging, routed binary chunk streaming, compact binary SACK framing, and resilient event waiters (`waitForPeer`, `waitForControl`, `waitForChunk`, `waitForSack`, `waitForMessage`).
   - `testFixtures.ts`: Synthetic binary buffers (`createSyntheticBuffer`), multi-chunk splitters (`createSyntheticChunks`), async byte streams (`createAsyncByteStream`), protocol manifests (`createSyntheticFileManifest`), corrupt payload generators, and assertion helpers (`assertBuffersEqual`, `waitForCondition`, `isValidSasCode`, `isValidPairCode`).
   - `manifestAuditor.ts`: Static inspection utilities to parse `android/app/src/main/AndroidManifest.xml` and `android/app/build.gradle.kts` to verify FGS types, permissions, SDK targets, and v1/v2 APK signing configurations.
   - `index.ts`: Barrel export of all harness modules.
   - `harness.test.ts`: Self-contained verification suite verifying server spin-up on port 0, two `OpaquePeer` instances connecting, ECDH key agreement, SAS 6-digit verification code parity, encrypted control messages, binary chunk streaming over routed frames, binary SACK transmission, tampering rejection, and manifest/Gradle audits.

5. **Test Execution & Verification Results**:
   - Command: `npx vitest run tests/e2e/harness/harness.test.ts`
     - Output:
       ```
       ✓ tests/e2e/harness/harness.test.ts (7 tests) 321ms
         ✓ AirBridge E2E Harness Self-Verification > allocates ephemeral port 0 and establishes valid endpoints 2ms
         ✓ AirBridge E2E Harness Self-Verification > connects two OpaquePeers, discovers each other, and verifies matching SAS codes 257ms
         ✓ AirBridge E2E Harness Self-Verification > exchanges encrypted transfer-control payloads with zero leakage 7ms
         ✓ AirBridge E2E Harness Self-Verification > streams encrypted binary chunks over routed relay frames with byte-for-byte integrity 16ms
         ✓ AirBridge E2E Harness Self-Verification > transmits and decodes compact 16-byte binary SACK frames 3ms
         ✓ AirBridge E2E Harness Self-Verification > detects tampering: corrupted auth tags and truncated frames fail verification 5ms
         ✓ AirBridge E2E Harness Self-Verification > audits AndroidManifest.xml and build.gradle.kts configurations 8ms

       Test Files  1 passed (1)
            Tests  7 passed (7)
       ```
   - Command: `npm run test:e2e`
     - Output: All 7 harness self-verification tests passed cleanly with status 0.
   - Command: `npm run typecheck`
     - Output: Clean exit code 0, 0 type errors.
   - Regression run: `npx vitest run tests/protocol.test.ts tests/e2e-transfer.test.ts`
     - Output: All 11 tests passed in 6.72s with status 0.

---

## 2. Logic Chain

1. **Opaque-Box Network Testing Guarantee**:
   - *Observation*: The system under test communicates over standard network interfaces: WebSocket signaling (`/ws`), binary frame routing, and HTTP REST endpoints.
   - *Reasoning*: By implementing `OpaquePeer` as a standalone WebSocket client that exchanges genuine serialized JSON envelopes, derives P-256 ECDH keys, and parses binary frames byte-for-byte, the harness tests the application as black-box network actors without internal mock coupling.
   - *Conclusion*: `OpaquePeer` accurately simulates Android and Desktop endpoints for all downstream test tiers (Tiers 1 through 4).

2. **Race-Free Asynchronous Event Handling**:
   - *Observation*: WebSocket messages can arrive before or during test assertions, leading to flakiness if listeners are attached after frames are received.
   - *Reasoning*: `OpaquePeer` buffers decrypted control events (`controlHistory`), binary chunk events (`chunkHistory`), and SACK events (`sackHistory`). When `waitForControl` or `waitForChunk` is called, it first checks the buffered history for existing matches before setting up a timeout listener.
   - *Conclusion*: Flakiness and timing race conditions are eliminated across high-throughput test runs.

3. **Tampering and Boundary Support**:
   - *Observation*: Tier 2 testing requires verifying cryptographic boundary integrity (corrupted tags, bit-flips, bad lengths).
   - *Reasoning*: `frameCodec.ts` provides explicit byte-level mutations (`corruptAuthTag`, `flipBit`, `truncateFrame`, `expandFrame`, `corruptIv`). Testing corrupted tags in `harness.test.ts` confirmed that WebCrypto AES-GCM decryption genuinely throws on modified ciphertexts.
   - *Conclusion*: Boundary and security tests can deterministically exercise cryptographic failure paths.

4. **Static Manifest and Gradle Auditing**:
   - *Observation*: Android-specific OS capabilities (FGS types `connectedDevice|dataSync`, v1/v2 signing schemes, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) cannot be tested via Node.js runtime execution alone.
   - *Reasoning*: `manifestAuditor.ts` directly inspects the source `AndroidManifest.xml` and `build.gradle.kts` files to verify that Android 14+ background transfer requirements and APK signing specifications are strictly adhered to.
   - *Conclusion*: Features F13, F14, F15, F17, and F18 can be verified in automated CI and E2E suites.

---

## 3. Caveats

- **Binary SACK Implementation State**: The current server implementation in Milestone M1 primarily routes binary frames and acknowledges via JSON control messages. Compact 16-byte binary SACK (`FRAME_BINARY_SACK`) is designed in `frameCodec.ts` and verified over routed relay frames, ready for Milestone M2 engine integration.
- **Node.js Environment**: WebCrypto `globalThis.crypto.subtle` is utilized, which requires Node.js >= 18. Both global WebCrypto and `node:crypto.webcrypto` fallbacks are supported.
- **Port 0 Behavior**: Operating system dynamically allocates ephemeral ports in range 1024–65535, ensuring total isolation between parallel test workers.

---

## 4. Conclusion

Milestone E2E-M1 is complete. The reusable, opaque-box E2E test harness is fully implemented, verified, and exported under `tests/e2e/harness/`:
- `serverManager.ts`: Ephemeral test server lifecycle manager.
- `wireCrypto.ts`: ECDH P-256, HKDF-SHA-256, AES-256-GCM, and SAS 6-digit derivation.
- `frameCodec.ts`: Binary chunk (0x01), routed relay (0x02), binary SACK, and byte tampering utilities.
- `opaquePeer.ts`: Full network-level Android/Desktop peer simulator.
- `testFixtures.ts`: Synthetic streams, files, corrupt payloads, and test assertions.
- `manifestAuditor.ts`: Static inspection utilities for AndroidManifest.xml and build.gradle.kts.
- `index.ts`: Barrel export of all harness utilities.
- `harness.test.ts`: Self-verification test suite passing 7/7 tests cleanly.
- `package.json`: E2E test runner scripts configured (`test:e2e`, `test:e2e:tier1`, `test:e2e:tier2`, `test:e2e:tier3`, `test:e2e:tier4`, `test:e2e:watch`).

All test commands pass with status 0, with zero regressions and clean typecheck.

---

## 5. Verification Method

### 5.1 Verification Commands
1. **Run harness self-verification tests**:
   ```bash
   npx vitest run tests/e2e/harness/harness.test.ts
   ```
   *Expected outcome*: 7 passed in < 500ms, exit code 0.

2. **Run E2E test script**:
   ```bash
   npm run test:e2e
   ```
   *Expected outcome*: 7 passed in < 2s, exit code 0.

3. **Run TypeScript typecheck**:
   ```bash
   npm run typecheck
   ```
   *Expected outcome*: Exit code 0, zero diagnostic errors.

4. **Run protocol and E2E transfer regressions**:
   ```bash
   npx vitest run tests/protocol.test.ts tests/e2e-transfer.test.ts
   ```
   *Expected outcome*: 11 passed in < 10s, exit code 0.

### 5.2 Files to Inspect
- `tests/e2e/harness/serverManager.ts`
- `tests/e2e/harness/wireCrypto.ts`
- `tests/e2e/harness/frameCodec.ts`
- `tests/e2e/harness/opaquePeer.ts`
- `tests/e2e/harness/testFixtures.ts`
- `tests/e2e/harness/manifestAuditor.ts`
- `tests/e2e/harness/index.ts`
- `tests/e2e/harness/harness.test.ts`
- `package.json`
