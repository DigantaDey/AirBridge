# Scope: E2E Testing Track

## Architecture
The E2E Testing Track designs and implements a requirement-driven, opaque-box test runner and multi-tier test suite for Project AirBridge.
The test harness interacts with the system strictly via network protocols (HTTP/HTTPS REST APIs, WebSocket control/data framing, ECDH P-256 and AES-256-GCM wire cryptography, binary SACK) and file/manifest verification.

### Subcomponents:
1. **Test Harness (`tests/e2e/harness/`)**:
   - `serverManager.ts`: Ephemeral lifecycle manager for `createAirBridgeServer` on `port: 0`.
   - `opaquePeer.ts`: Simulates native Android and Desktop peers over WebSocket with ECDH/AES-GCM encryption.
   - `wireCrypto.ts`: Crypto utilities for P-256, HKDF-SHA-256, AES-256-GCM, and SAS 6-digit derivation.
   - `frameCodec.ts`: Binary framing codecs for 0x01 chunks, 0x02 routed relays, and binary SACK.
   - `testFixtures.ts`: Synthetic payload generators, stream buffers, and assertion matchers.
   - `manifestAuditor.ts`: Static inspection of AndroidManifest.xml and Gradle build configs.
2. **Tier 1 — Feature Coverage (`tests/e2e/tier1-feature-coverage/`)**:
   - 19 test files covering features F1 through F19 (≥ 95 tests, ≥ 5 per feature).
3. **Tier 2 — Boundary & Corner Cases (`tests/e2e/tier2-boundary-corner/`)**:
   - 7 test files covering extremes, malformed payloads, crypto tampering, rate limits, backpressure, drops, and security boundaries (≥ 95 tests).
4. **Tier 3 — Cross-Feature Interactions (`tests/e2e/tier3-cross-feature/`)**:
   - 5 test files covering pairwise combinations (≥ 20 tests).
5. **Tier 4 — Real-World Application Scenarios (`tests/e2e/tier4-real-world/`)**:
   - 10 test files covering end-to-end user workflows (≥ 10 scenarios).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Jetpack Compose Native UI Contract | StateFlow contract & viewmodel interaction | E2E-M2 | R1, Survey 1 |
| F2 | Connection & Discovery Screen | mDNS, manual connect, QR code scan | E2E-M2 | R1, Survey 1 |
| F3 | Active Transfer Dashboard | Progress, throughput, cancel/pause controls | E2E-M2 | R1, Survey 1 |
| F4 | Incoming Transfer Offer Modal | SAS code verification, offer accept/decline | E2E-M2 | R1, Survey 1 |
| F5 | Pairing Dock & Room Management | Pairing QR, 6-char Crockford code, rotate | E2E-M2 | R1, Survey 1 |
| F6 | Clipboard Center & Compose | Beam text/images, clipboard history | E2E-M2 | R1, Survey 1 |
| F7 | Native Settings Screen | Device name, storage config, battery exemption | E2E-M2 | R1, Survey 1 |
| F8 | High-Throughput Chunk Pipeline | 1MB chunking, pipelining, multi-MB/s transfer | E2E-M2 | R2, Survey 2 |
| F9 | Socket Flush & Masking Optimization | Unaligned masking, zero sync flushes | E2E-M2 | R2, Survey 2 |
| F10 | Decoupled 3-Stage Crypto/IO Pipeline | Decoupled socket/crypto/disk throughput | E2E-M2 | R2, Survey 2 |
| F11 | Direct-to-MediaStore Streaming Sink | Zero-copy MediaStore FileChannel streaming | E2E-M2 | R2, Survey 2 |
| F12 | Compact Binary SACK | 16-byte binary SACK frames replacing JSON | E2E-M2 | R2, Survey 2 |
| F13 | Android 14+ FGS Type DataSync | connectedDevice\|dataSync manifest attributes | E2E-M2 | R3, Survey 3 |
| F14 | Background Continuity & Locks | WakeLock and low-latency Wi-Fi lock | E2E-M2 | R3, Survey 3 |
| F15 | Battery Optimization Exemption | ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS | E2E-M2 | R3, Survey 3 |
| F16 | Bidirectional Clipboard Sync | Background setPrimaryClip, accessibility listener | E2E-M2 | R3, Survey 3 |
| F17 | APK Signing & Sideload Packaging | v1 & v2 signing schemes, keystore config | E2E-M2 | R4, Survey 3 |
| F18 | Version Code & Packaging Conflict Fix | Consistent versionCode between local & CI | E2E-M2 | R4, Survey 3 |
| F19 | ANR Elimination & Discovery Bug Fix | Non-blocking NsdManager, async SSL/asset I/O | E2E-M2 | R4, Survey 3 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E-M1 | Test Runner & Opaque Harness Implementation | `tests/e2e/harness/`: ServerManager, OpaquePeer, WireCrypto, FrameCodec, TestFixtures, ManifestAuditor, npm test scripts in package.json | none | DONE |
| E2E-M2 | Tier 1: Feature Coverage Test Suite (F1-F19) | `tests/e2e/tier1-feature-coverage/`: 19 test files, ≥ 95 tests | E2E-M1 | IN_PROGRESS |
| E2E-M3 | Tier 2: Boundary & Corner Cases Test Suite | `tests/e2e/tier2-boundary-corner/`: 7 test files, ≥ 95 tests | E2E-M1 | IN_PROGRESS |
| E2E-M4 | Tier 3: Cross-Feature Combinations Test Suite | `tests/e2e/tier3-cross-feature/`: 5 test files, ≥ 20 tests | E2E-M1 | IN_PROGRESS |
| E2E-M5 | Tier 4: Real-World Scenarios Test Suite | `tests/e2e/tier4-real-world/`: 10 scenario test files, ≥ 10 scenarios | E2E-M1 | IN_PROGRESS |
| E2E-M6 | Full Suite Verification, Audit & TEST_READY.md | Execute `npm run test:e2e`, verify 100% pass across ≥ 220 tests, publish `TEST_READY.md` | E2E-M1, M2, M3, M4, M5 | PLANNED |

---

## Interface Contracts
### `OpaquePeer` Wire Interface
- `connect(wsUrl: string): Promise<WelcomeMessage>`
- `sendControl(targetPeerId: string, payload: any): Promise<void>`
- `sendChunk(targetPeerId: string, transferId: string, fileIndex: number, chunkIndex: number, plaintext: Uint8Array): Promise<void>`
- `sendBinarySack(targetPeerId: string, transferId: string, fileIndex: number, chunkIndex: number, windowSize: number): Promise<void>`
- `waitForControl(filter: (p: any) => boolean, timeoutMs?: number): Promise<any>`
- `waitForChunk(filter: (c: any) => boolean, timeoutMs?: number): Promise<any>`
- `disconnect(): Promise<void>`
