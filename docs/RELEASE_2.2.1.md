# AirBridge 2.2.1 — Android throughput, background and clipboard fixes

Update **both the desktop and Android APK**. The APK uses the same sideload
signing key as earlier releases, so it is intended to install as an upgrade.

## Android transfer pipeline

- Overlap socket/TLS reads, ordered decrypt/storage work and the network writer
  with independent **4 MiB / 128-item bounded queues**. Empty messages cannot
  evade the item limit; a valid oversized clipboard envelope is admitted alone.
- Set socket buffer hints before TCP connect, decrypt routed buffers by range,
  reuse per-thread AES-GCM ciphers and avoid repeated whole-frame copies.
- Move receive storage setup, disk writes, checkpoints and cleanup outside the
  engine-wide monitor, keeping snapshots/cancellation responsive to a slow disk.
- ACK durable contiguous progress every 8 chunks or 200 ms on progress. Allow
  60 seconds without progress while waiting for ACKs, without confusing a slow
  source read with an ACK stall. Never accept ACKs for chunks not yet sent.
- Bind reconnect attempts, consent and completion receipts to the original
  encryption key and exact file manifest. Reject stale socket work and changed
  keys, including devices claiming the same name/device ID.

## Background service and clipboard

- React to default-network changes, discard callbacks from replaced engine
  instances, coalesce notifications and renew active-transfer CPU/Wi-Fi locks
  periodically rather than on every progress event.
- Add **Settings → Background battery access** guidance and an OS battery-settings
  shortcut. Keep **Background clipboard & connection** enabled for idle discovery
  and incoming clipboard when the UI is absent.
- Capture only bounded, non-sensitive plain clipboard text without dereferencing
  URIs. Catch up when AirBridge regains focus and coalesce Accessibility events
  without inspecting window contents/text fields.
- Retain only the latest pending automatic clipboard value, preserve its original
  expiry, retry failed destinations without duplicating successful ones, and
  preserve meaningful whitespace. Record incoming echo state after OS success.
- Stop replaying native clipboard history back into the system clipboard. Explicit
  **Copy**, **Share → AirBridge** and selected-text actions remain available.
- Keep desktop background capture independent of suspended browser tabs; persist
  pairing and send/receive preferences privately, restore the QR pairing code on
  restart, and serialize/coalesce OS writes without duplicate headless writes.

## Cross-platform review fixes

- Require sender SHA-256 for protocol receive completion; reject missing/truncated
  file data, revoke abandoned Blob URLs and stop queued receiver writes before
  cancellation cleanup. Preserve already-existing files during normal browser
  filename selection and publish competing desktop receives exclusively.
- Cap memory-only browser receives and retained file payloads at **128 MiB**;
  larger files need the native app, desktop daemon or a disk-backed browser
  receive folder. Bound pending incoming offers before allocating chunk arrays.
- Treat synced/restored history as display data, not verified receive receipts or
  authority to cancel live storage. Keep each headless client's storage separate
  instead of replacing process-global browser storage.
- Handle Express async errors, malformed upload metadata, CLI byte ranges,
  disappearing sources and aborted downloads. Check browser HTTP/WebSocket
  origins and reject remote daemon uploads before buffering their bodies.
- Bound failed CLI-token lookup state, restrict desktop artifact names, close
  share-target IndexedDB transactions and release temporary download URLs without
  revoking history-owned transfer downloads.

## Validation and remaining limits

Regression coverage includes TypeScript/UI tests, protocol/crypto/queue/file JVM
checks, Android source compilation, production/Linux binary builds and real
Kotlin ↔ Kotlin / TypeScript transfers over **HTTP and pinned TLS**. Interop runs
with a **128 MiB JVM heap**, forced send/receive socket drops, disk SHA-256 checks,
empty/multi-file batches and clipboard delivery during blocked publication.
GitHub CI additionally packages the Android APK and gates the pull request.

**No physical-phone throughput or OEM screen-off measurements were made here.**
There is no configured bandwidth limiter, but maximum device-supported speed is
not guaranteed. Validate on the original phone/network using the
[device checklist](ANDROID_VALIDATION.md).

Android 10+ may deny automatic background clipboard reads **even with
Accessibility enabled**. A foreground service provides execution continuity,
not unrestricted clipboard permission. Use Share/selected text when denied.
Force-stop, reboot, the notification Stop action, revoked URI access and OEM
process killing can end the service; process-death resume is not promised.

Native Android/desktop staging verifies before publication. The browser File
System Access fallback has platform limitations: out-of-order writes need a
post-close read-back hash and remove mismatches best-effort; external processes
can race its filename selection. See [security notes](../SECURITY.md).

Use only official release assets/checksums: the public sideload key preserves
upgrade compatibility, not publisher authenticity.
