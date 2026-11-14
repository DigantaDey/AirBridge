# AirBridge 2.2.0 — native Android transfers and background reliability

## Android

- Move encryption, sockets, clipboard delivery and file I/O out of the WebView
  into a foreground-service-owned Kotlin peer. Switching apps, Back or UI
  recreation no longer owns the transfer's lifetime.
- Stream picked URI files natively rather than sending file bytes through
  JavaScript/base64. Use a bounded network queue, contiguous receiver ACKs,
  bitmap resume bookkeeping and streaming SHA-256 to avoid file-sized buffers.
- Resume interrupted send and receive connections to the same peer key and
  exact manifest, with already-published files tracked across multi-file retries.
  Report completion only after receiver verification and publication.
- Keep file hashing/publication and metadata JSON off the network reader.
  Add active-transfer CPU/Wi-Fi locks, native speed/state notifications and
  Accept/Decline actions for incoming offers.
- Publish verified received files into Downloads/AirBridge (Android 10+);
  retain a verified app-specific Downloads fallback on Android 8/9.
- Deliver incoming text/images to Android's system clipboard without the UI.
  Add Share → AirBridge / selected-text → AirBridge for explicit outgoing text
  when Android blocks background clipboard reads. Accessibility remains optional
  and best-effort, not a bypass; sensitive clips are excluded from auto-capture.
- Bundle the UI inside the APK, migrate away from stale WebView service-worker
  origins, and reattach via metadata snapshots instead of a second JS peer.
- Preserve invitation ports (including custom 3411); bare addresses now use the
  actual desktop default 3000. Pin the desktop TLS CA on first use, support
  same-CA leaf renewal, and reject changed identity without HTTP downgrade.

## Cross-platform review fixes

- Generate full-entropy 96-bit AES-GCM chunk nonces; retain wire compatibility.
- Restrict automatic clipboard sharing to paired peers, preserve text whitespace,
  cap retained clipboard content and release evicted transfer Blob URLs without
  dropping active sessions from history.
- Handle partial filesystem writes, orphaned resume metadata, malformed integer
  manifests, stalled/invalid ACKs, fragmented WebSocket bounds, socket cleanup
  and exactly-once close.
- Release completed disk-receiver promise chains. Make relay overload an explicit
  disconnect rather than silent chunk loss; count idle upgraded sockets and reject
  duplicate hello registration.
- Upgrade the vulnerable Vitest dependency chain (`npm audit`: no known findings
  at validation time). Keep desktop macOS/Windows/Linux packaging and the wire
  protocol compatible; align APK and package versions at 2.2.0.

## Validation and limits

Automated coverage includes TypeScript/UI tests, JVM vectors/pairing/disk/transport
checks, Gradle APK packaging in CI, and real Kotlin ↔ Kotlin / TypeScript interop
on HTTP and pinned TLS with a 128 MiB JVM heap. Interop transfers exceed the ACK
window, include empty files and forced send/receive socket drops, verify saved
SHA-256, and prove clipboard traffic can flow during blocked publication.

**No physical Android phone/emulator measurements were made for this change.**
The reported “256kbps” cannot be reproduced without the original device/network;
there is no configured rate limiter, but a particular maximum speed is not
promised. Screen-off, MediaStore, URI-provider and OEM battery behavior still
need the [device acceptance checklist](ANDROID_VALIDATION.md).

Android 10+ can deny automatic clipboard reads even with Accessibility enabled;
use the explicit Share/text action in that case. Force-stop, reboot, the Stop
notification action, revoked grants and aggressive OEM process killing can end
the service. Resume across process death and automatic image capture are not
promised. Update both desktop and APK; rescan the desktop QR if an old stored
address omitted its port. Verify the desktop before forgetting a changed TLS pin.

The committed sideload signing key preserves upgrade compatibility, not publisher
authenticity: use only this project's official release assets/checksums.
