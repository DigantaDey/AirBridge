## 2026-11-14T18:46:46Z

You are a Worker for Milestone E2E-M1 (Test Runner & Opaque Harness Implementation) of Project AirBridge.

## Mandatory Reading
- Original Request path: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md (Read first!)
- Project Scope: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/PROJECT.md
- Test Infra Spec: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/TEST_INFRA.md
- Explorer Architecture Report: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/explorer_e2e_infra_2/handoff.md

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Write Ownership
You exclusively own:
- All files under `/Users/digantadey/AndroidStudioProjects/AirBridge/tests/e2e/harness/`
- Script additions in `/Users/digantadey/AndroidStudioProjects/AirBridge/package.json`

## Objectives
Implement the complete, reusable, opaque-box E2E test harness in `tests/e2e/harness/` and configure test runner scripts:
1. `tests/e2e/harness/serverManager.ts`:
   - `createTestServer(options)` wrapping `createAirBridgeServer` with `port: 0`, `host: '127.0.0.1'`, `mode: 'test'`, `enableMdns: false`.
   - Returns `{ port, wsUrl, httpUrl, server, close }`.
   - Ensures robust cleanup in `close()`.
2. `tests/e2e/harness/wireCrypto.ts`:
   - Standalone ECDH P-256 key generation, HKDF-SHA-256 key derivation, AES-256-GCM encryption/decryption, and SAS 6-digit derivation matching the desktop and Android engine protocols.
3. `tests/e2e/harness/frameCodec.ts`:
   - Encodes and decodes 0x01 encrypted chunk frames, 0x02 routed relay frames, and 0x02 / compact binary SACK frames.
   - Includes tampering methods (corrupt tag, bit flip, bad length) for boundary testing.
4. `tests/e2e/harness/opaquePeer.ts`:
   - Implements `OpaquePeer` network client simulating Android and Desktop peers over WebSocket at `ws://127.0.0.1:<port>/ws`.
   - Handles `hello`, `welcome`, peer registration, ECDH public key exchange, encrypted `transfer-control` envelopes, binary frame relay, and `waitForControl`/`waitForChunk` helper methods.
5. `tests/e2e/harness/testFixtures.ts`:
   - Synthetic files (small, medium, large binary streams), corrupt payloads, assertion utilities.
6. `tests/e2e/harness/manifestAuditor.ts`:
   - Static inspection utilities to parse and verify `android/app/src/main/AndroidManifest.xml` and Gradle configs (FGS types, permissions, signing configs).
7. `tests/e2e/harness/index.ts`:
   - Exports all harness utilities.
8. `tests/e2e/harness/harness.test.ts`:
   - A self-contained test verifying server spin-up on port 0, two `OpaquePeer` instances connecting, ECDH key exchange, SAS verification, encrypted control and binary frame transmission, and clean shutdown.
9. `package.json`:
   - Add `"test:e2e": "vitest run tests/e2e"` and tier-specific scripts (`test:e2e:tier1`, etc.).

## Verification
- Run `npx vitest run tests/e2e/harness/harness.test.ts` and ensure all tests pass cleanly with exit code 0.
- Report all file modifications, test commands, and passing results.

## Output
Write your handoff report to:
`/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/worker_e2e_m1/handoff.md`

Message the sub-orchestrator upon completion.
