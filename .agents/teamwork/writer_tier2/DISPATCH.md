## 2026-11-14T19:30:09Z
You are a Test Writer for Tier 2: Boundary & Corner Cases of Project AirBridge.

## Mandatory Reading
- Original Request path: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md (Read first!)
- Project Scope: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/PROJECT.md
- Test Infra Spec: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/TEST_INFRA.md
- Test Harness: Inspect `/Users/digantadey/AndroidStudioProjects/AirBridge/tests/e2e/harness/` (specifically `index.ts`, `serverManager.ts`, `opaquePeer.ts`, `wireCrypto.ts`, `frameCodec.ts`, `testFixtures.ts`).

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Write Ownership
You exclusively own all 7 test files under `/Users/digantadey/AndroidStudioProjects/AirBridge/tests/e2e/tier2-boundary-corner/`:
1. `file_size_extremes.test.ts` (0-byte, 1-byte, odd byte sizes, multi-GB manifests, empty file arrays, special Unicode filenames)
2. `malformed_json_and_frames.test.ts` (truncated JSON, malformed syntax, unknown control kinds, invalid message types, missing required headers)
3. `crypto_and_auth_tampering.test.ts` (corrupted auth tags, bit flips in ciphertext, IV reuse, forged sender IDs, public key mismatch, uncompressed vs compressed point rejection)
4. `rate_limiting_and_dos.test.ts` (join-pair rate limits: 6 attempts/60s, max 128 clients, oversized frames exceeding 16MB)
5. `network_throttling_and_backpressure.test.ts` (slow consumers, buffer saturation, 64MB relay threshold socket termination, zero-window flow control)
6. `connection_drop_and_resumption.test.ts` (abrupt socket close during handshake/transfer, reconnection, resume tokens, partial transfer recovery)
7. `loopback_and_security_boundary.test.ts` (remote non-loopback access rejection for /api/received-folder and /api/fs/*, daemon remote rejection, same-origin checks)

## Requirement
The 7 files must contain AT LEAST 95 comprehensive passing test cases in total (~13-14 tests per file).
Use `createTestServer` on port 0, `OpaquePeer`, and wire tampering methods (`corruptAuthTag`, `flipBit`, `truncateFrame`) to exercise failure modes. Ensure all servers and sockets are cleanly closed in `afterEach`/`afterAll`.

## Verification
Run `npx vitest run tests/e2e/tier2-boundary-corner` and ensure all tests pass with exit code 0.

## Output
Write your handoff report to:
`/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/writer_tier2/handoff.md`

Message the sub-orchestrator upon completion.
