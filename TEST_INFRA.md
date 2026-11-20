# E2E Test Infrastructure: AirBridge Android High-Performance & Store-Ready Modernization

## 1. Test Architecture & Philosophy

The AirBridge End-to-End (E2E) testing suite operates on a **strictly opaque-box, requirement-driven, and network-isolated architecture**. Tests interact exclusively through external public network interfaces—HTTP REST endpoints, WebSocket signaling protocols, binary wire frames, cryptographic handshakes, and compiled Android artifacts/manifests—with **zero internal mock injections** of application business logic.

### Core Testing Methodologies
1. **Category-Partition Testing**: Systematic partitioning of input domains (file sizes, chunk sequences, packet layouts, signaling states) across independent equivalence classes.
2. **Boundary Value Analysis (BVA)**: Exhaustive boundary testing targeting buffer caps, off-by-one indices, zero-length files, 16 MiB payload limits, 256,000-character clipboard bounds, and single-port protocol sniffing boundaries.
3. **Pairwise Combinatorial Testing**: Multi-dimensional interaction testing across concurrent operations (active large file transfers combined with simultaneous bidirectional clipboard storms, dynamic pairing code rotation, and multi-peer mesh relays).
4. **Realistic Application Workloads**: End-to-end user workflows simulating actual device usage patterns (first-time QR setup with CA bootstrapping, large media gallery syncs with mixed photos/videos, Wi-Fi handovers with connection drops, low-storage abort cleanups, and seamless app upgrade continuity).

---

## 2. Feature Inventory & Test Matrix

All features defined in `PROJECT.md` and `SCOPE.md` are mapped across four systematic testing tiers:

| Feature ID | Feature Name | Source | Tier 1 (Coverage) | Tier 2 (Boundary/Corner) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) | Total Tests |
|---|---|---|:---:|:---:|:---:|:---:|:---:|
| **F01** | Jetpack Compose Native UI Contract | R4, Survey 1 | 5 | 5 | ✓ | Scenario 01 | 10+ |
| **F02** | Connection & Discovery Screen | R1, Survey 1 | 5 | 5 | ✓ | Scenario 01, 05 | 11+ |
| **F03** | Active Transfer Dashboard | R1, Survey 1 | 5 | 5 | ✓ | Scenario 02, 04, 06, 09 | 13+ |
| **F04** | Incoming Transfer Offer Modal | R1, Survey 1 | 5 | 5 | ✓ | Scenario 02, 06 | 11+ |
| **F05** | Pairing Dock & Room Management | R1, Survey 1 | 5 | 5 | ✓ | Scenario 01, 05 | 11+ |
| **F06** | Clipboard Center & Compose | R2, Survey 1 | 5 | 5 | ✓ | Scenario 03, 10 | 11+ |
| **F07** | Native Settings Screen & Storage Config | R4, Survey 1 | 5 | 5 | ✓ | Scenario 09, 10 | 11+ |
| **F08** | High-Throughput Chunk Pipeline | R1, Survey 2 | 6 | 5 | ✓ | Scenario 02, 04, 07, 08 | 15+ |
| **F09** | Socket Flush & Masking Optimization | R1, Survey 2 | 6 | 5 | ✓ | Scenario 08 | 12+ |
| **F10** | Decoupled 3-Stage Crypto/IO Pipeline | R1, Survey 2 | 6 | 5 | ✓ | Scenario 02, 08 | 13+ |
| **F11** | Direct-to-MediaStore Streaming Sink | R1, Survey 2 | 5 | 5 | ✓ | Scenario 02, 09 | 12+ |
| **F12** | Compact Binary SACK | R1, Survey 2 | 6 | 5 | ✓ | Scenario 04, 08 | 13+ |
| **F13** | Android 14+ FGS Type DataSync | R2, Survey 3 | 6 | 5 | ✓ | Scenario 07 | 12+ |
| **F14** | Background Continuity & Locks | R2, Survey 3 | 6 | 5 | ✓ | Scenario 03, 04, 07 | 14+ |
| **F15** | Battery Optimization Exemption | R2, Survey 3 | 6 | 5 | ✓ | Scenario 07 | 12+ |
| **F16** | Bidirectional Clipboard Sync | R2, Survey 3 | 6 | 5 | ✓ | Scenario 03, 05 | 13+ |
| **F17** | APK Signing & Sideload Packaging | R5, Survey 3 | 6 | 5 | ✓ | Scenario 01, 10 | 12+ |
| **F18** | Version Code & Packaging Configuration | R5, Survey 3 | 6 | 5 | ✓ | Scenario 10 | 12+ |
| **F19** | ANR Elimination & Non-Blocking Discovery | R1, Survey 3 | 6 | 5 | ✓ | Scenario 01, 05 | 12+ |
| **F20** | Per-Device Pair Code Sync & Notification Isolation | Security & Pairing | 3 | ✓ | ✓ | Scenario 01, 05 | 3+ |
| **F21** | Phone Continuity (Battery, Screen, Calls, Contacts) | Mobile Continuity | 6 | ✓ | ✓ | Scenario 03, 07 | 6+ |

---

## 3. Test Suite Directory Layout

```
tests/e2e/
├── harness/                                            # Core Test Harness Infrastructure (1 suite, 8 tests)
│   ├── index.ts                                        # Public API barrel exports
│   ├── serverManager.ts                                # Ephemeral server lifecycle management (port: 0)
│   ├── opaquePeer.ts                                   # Full opaque WebSocket/REST network client
│   ├── wireCrypto.ts                                   # ECDH P-256, HKDF-SHA-256, AES-256-GCM, SAS auth
│   ├── frameCodec.ts                                   # 0x01 Chunk Frame, 0x02 Relay, 0x03 Compact SACK
│   ├── manifestAuditor.ts                              # AndroidManifest.xml & build.gradle.kts static auditor
│   ├── testFixtures.ts                                 # Synthetic binary generators, bit-exact assertion tools
│   ├── testHelpers.ts                                  # Async timing, buffer comparison, temp folder lifecycle
│   └── harness.test.ts                                 # Self-verification suite for test harness components
│
├── tier1-feature-coverage/                             # Tier 1: Primary Feature Coverage (21 suites, 116 tests)
│   ├── f01_compose_ui_contract.test.ts                 # F01: Compose screen hierarchy, window insets, state contracts
│   ├── f02_discovery_and_connect.test.ts               # F02: mDNS & direct IP connection, pair codes, SAS verification
│   ├── f03_transfer_dashboard.test.ts                  # F03: Transfer item rendering, progress states, throughput metrics
│   ├── f04_transfer_offer_modal.test.ts                # F04: File offer presentation, manifest validation, modal actions
│   ├── f05_pairing_dock_and_rooms.test.ts              # F05: Peer pairing dock, room isolation, multi-peer discovery
│   ├── f06_clipboard_center_and_compose.test.ts        # F06: Clipboard beam card, image preview, manual composition
│   ├── f07_settings_and_folder_config.test.ts          # F07: Destination folder selection, download folder preferences
│   ├── f08_high_throughput_pipeline.test.ts            # F08: 1 MiB chunk streaming, sliding window, memory budget
│   ├── f09_socket_flush_and_masking.test.ts            # F09: TCP socket write batching, client frame masking rules
│   ├── f10_decoupled_crypto_io.test.ts                 # F10: 3-stage pipeline (Net -> Decrypt -> Disk), digest preserving
│   ├── f11_mediastore_streaming_sink.test.ts           # F11: Scoped storage sink, incremental commit, no re-reads
│   ├── f12_compact_binary_sack.test.ts                 # F12: 16-byte binary SACK codec, bitmask derivation, loss tracking
│   ├── f13_fgs_datasync_manifest.test.ts               # F13: Android 14/15 FGS dataSync & connectedDevice lifecycles
│   ├── f14_background_continuity_locks.test.ts         # F14: PARTIAL_WAKE_LOCK, LOW_LATENCY Wi-Fi lock, network callbacks
│   ├── f15_battery_optimization_contract.test.ts       # F15: Settings redirect without prohibited Play Store permission
│   ├── f16_bidirectional_clipboard_sync.test.ts        # F16: End-to-end clipboard sync, echo cancellation, burst dedup
│   ├── f17_apk_signing_schemes.test.ts                 # F17: V1 & V2 APK signing configs, release key configuration
│   ├── f18_version_code_packaging.test.ts              # F18: Semantic versioning, versionCode auto-calculation, min/target SDK
│   ├── f19_anr_and_discovery_fix.test.ts               # F19: Non-blocking discovery queue, UI thread ANR elimination
│   ├── f20_pair_code_synchronization_and_qr.test.ts    # F20: Per-device unique pair code isolation & QR notification gating
│   └── f21_phone_continuity_android.test.ts            # F21: Phone continuity permissions, MediaProjection ordering, Screen/Contacts/Calls
│
├── tier2-boundary-corner/                              # Tier 2: Boundary & Corner Cases (7 suites, 97 tests)
│   ├── file_size_extremes.test.ts                      # 0-byte, 1-byte, multi-GB streams, empty manifest handling
│   ├── malformed_json_and_frames.test.ts               # Truncated frames, malformed JSON, invalid frame types
│   ├── crypto_and_auth_tampering.test.ts               # Corrupted auth tags, IV reuse attacks, forged peer IDs
│   ├── rate_limiting_and_dos.test.ts                   # Join spamming, connection pooling limits (128), oversized frames
│   ├── network_throttling_and_backpressure.test.ts     # Throttled consumers, 64 MiB relay valve, pause/resume flow
│   ├── connection_drop_and_resumption.test.ts          # Sudden TCP termination, reconnect tokens, SACK-based resume
│   └── loopback_and_security_boundary.test.ts          # Remote access restriction on localhost-only APIs, path traversal
│
├── tier3-cross-feature/                                # Tier 3: Cross-Feature Combinations (5 suites, 22 tests)
│   ├── transfer_with_clipboard_concurrency.test.ts     # Active large file transfer concurrent with clipboard beams
│   ├── pair_rotation_during_active_transfer.test.ts    # Changing room/pair code mid-stream without dropping active transfer
│   ├── multi_peer_mesh_relay.test.ts                   # 3+ peers concurrently exchanging independent encrypted files
│   ├── background_drop_and_resume_pipeline.test.ts     # Background daemon handoff, app termination, SACK resumption
│   └── tls_upgrade_and_http_coexistence.test.ts        # Single-port TLS/HTTP sniffing (ClientHello 0x16), WSS + CA trust
│
└── tier4-real-world/                                   # Tier 4: Real-World Scenarios (10 suites, 20 tests)
    ├── scenario_01_qr_pairing_and_ca_trust.test.ts     # First-time setup: QR bootstrap, HTTP CA pin, trusted WSS upgrade
    ├── scenario_02_large_media_gallery_sync.test.ts    # Batch sync: 25 photos + 2 video files transferred atomically
    ├── scenario_03_bidirectional_clipboard_storm.test.ts# Rapid back-and-forth clipboard copies with echo suppression
    ├── scenario_04_interrupted_wifi_handover.test.ts   # Network drop during multi-chunk transfer with lossless resume
    ├── scenario_05_multi_device_room_sharing.test.ts   # Group room: 1 desktop sender broadcasting to multiple Android peers
    ├── scenario_06_decline_and_reoffer_flow.test.ts    # Rejecting an offer followed by clean renegotiation and transfer
    ├── scenario_07_background_transfer_continuity.test.ts # Background daemon processing with system locks and wakeups
    ├── scenario_08_corrupted_chunk_detection.test.ts   # Wire corruption detection via GCM auth tag, chunk re-fetch
    ├── scenario_09_low_storage_graceful_abort.test.ts  # Simulated disk exhaustion, clean partial file purging
    └── scenario_10_app_upgrade_history_sync.test.ts    # Seamless client upgrade, reconnecting to previous room & history
```

---

## 4. Test Execution Commands

### Canonical E2E Command
To run all 44 E2E test suites (263 tests) cleanly:
```bash
npm run test:e2e
```
Or directly using vitest:
```bash
npx vitest run tests/e2e/
```

### Individual Tier Commands
```bash
# Tier 1: Feature Coverage (21 suites, 116 tests)
npm run test:e2e:tier1

# Tier 2: Boundary & Corner Cases (7 suites, 97 tests)
npm run test:e2e:tier2

# Tier 3: Cross-Feature Combinations (5 suites, 22 tests)
npm run test:e2e:tier3

# Tier 4: Real-World Scenarios (10 suites, 20 tests)
npm run test:e2e:tier4
```

### Full Project Test Suite
```bash
# Executes unit, hardening, and E2E suites (105 suites, 714 tests)
npm test
```

Additional production-hardening unit/integration suites (included in `npm test`) and native Android/JVM suites:
- **Node/Web/Build/macOS Hardening (Vitest)**: `tests/build-config-hardening.test.ts`, `tests/install-hardening.test.ts`, `tests/server-production-hardening.test.ts`, `tests/client-hardening.test.ts`, `tests/website-hardening.test.ts`, `tests/mac-supervisor.test.ts` (plus `scripts/test-mac-app.sh` for packaged macOS `.app` verification).
- **Android & JVM Engine Hardening (Gradle)**: `android/app/src/test/kotlin/com/airbridge/app/AndroidHardeningTest.kt`, `android/engine/src/test/kotlin/com/airbridge/engine/ModelTest.kt`, `android/engine/src/test/kotlin/com/airbridge/engine/TlsSanAndTelemetryTest.kt`, and `android/engine/src/test/kotlin/com/airbridge/engine/WebSocketResilienceTest.kt`.

---

## 5. Verification & Integrity Metrics

- **Total E2E Test Suites**: 44 suites (263 passing tests in ~19.23s, exit code 0)
- **Full Vitest Suite (`npm test`)**: 105 suites (714 passing tests, 0 skipped, 0 failing, ~63.13s, exit code 0)
- **Test Integrity**: Every E2E test connects to an ephemeral live network server (`port: 0`), conducts full cryptographic handshakes (ECDH P-256, AES-256-GCM), streams framed binary protocols, and validates byte-for-byte SHA-256 hashes against synthetic buffers. Zero mocks or facade test implementations exist in E2E runs.
