# Android validation and remaining device checks

## Architecture being validated (2.2.0)

`ConnectionService` owns a single `NativeEngineHost` / Kotlin `AirBridgeEngine`.
The bundled WebView UI attaches a metadata subscriber; suspending, destroying
or recreating it does not stop that engine. Native picker capabilities refer
to ContentResolver streams, not base64/Blob payloads. Incoming files are staged
privately, SHA-256 checked, then published through MediaStore Downloads on
Android 10+ (app-specific Downloads fallback on Android 8/9).

The transfer pipeline has a byte-bounded writer, a 64-chunk receiver ACK window
and ACK every 8 contiguous chunks. No configured kbit/s or KiB/s rate limiter
exists. Hash/publication work is serialized off the network reader/engine
monitor. Senders wait for verified receiver completion, and reconnect retries
bind to the original peer key/manifest, not just a device name.

## Reproducible automated checks

```bash
npm ci
npm run typecheck
npm test
npm audit --audit-level=moderate
npm run build
node scripts/build-desktop.mjs --only linux-x64

# JDK 17 + Gradle 8.14.3 + Android SDK 35 / build-tools 35.0.0
gradle -p android :engine:check :app:assembleDebug
npx tsx scripts/test-native-interop.ts
```

The interop command uses the classpath emitted by `:engine:check` (or
`KOTLIN_ENGINE_CLASSPATH` / `JAVA` overrides). It creates temporary servers,
certificates and downloads, cleans up children, and tests **HTTP and TLS**:

- Kotlin ↔ Kotlin: discovery, matching SAS, manual acceptance, 32 MiB+ file,
  small/empty files, reverse transfer, clipboard both ways and history.
- Kotlin ↔ TypeScript: multi-file transfers of ~32 MiB and ~20 MiB, actual
  socket drops during **native receive and native send**, checkpoint resume,
  exact disk SHA-256 verification and bidirectional clipboard.
- A deliberately blocked file publisher must not delay a clipboard beam.
- JVM heap is capped at **128 MiB** for these tests. The fixtures exceed the
  ACK window, so a short-file false positive cannot hide a window deadlock.
- Generated TLS fixtures test initial chain validation, saved-CA reuse,
  impostor rejection and leaf renewal under the same CA. Real TLS sockets
  also run the transfer scenarios using the pinned trust manager.

Engine checks additionally cover malformed/fragmented WebSocket limits,
exactly-once close, queue shutdown/backpressure, latest-value mailbox bounds/fairness,
per-file ACK/resume accounting,
integrity-before-publication, out-of-order hashing, orphan metadata and paused
file descriptors. SDK-jar compilation (`npm run verify:android`) is useful as a
local preflight, but is **not** a substitute for Gradle APK packaging or Android
runtime testing.

These results are loopback/JVM/desktop regression evidence, **not Android
throughput measurements**. They cannot reproduce the reported “256kbps”
without the original phone/network, nor prove MediaStore, WebView, notification,
URI-provider, screen-off or OEM battery behavior on a physical phone.

## Physical-device acceptance checklist (not yet executed here)

Record Android version, OEM/model, WebView version, desktop OS, Wi-Fi band/link
rate, wired/wireless desktop connection, file size, elapsed time and whether
speed is measured in bytes/s or bits/s. Compare the same file to the previous
APK, not to the JVM loopback test.

- [ ] Upgrade over the previous APK without uninstalling; pair/compare SAS.
      Check default port 3000 and custom ports (including 3411). Check explicit HTTP separately.
- [ ] Send and receive a ≥1 GiB file (and small/empty multi-file batches).
      Verify SHA-256 of the saved bytes on each device, and inspect peak memory.
- [ ] Repeat with Home, app switching, Back, screen locked for several minutes,
      and a WebView renderer restart. The native notification should continue
      reporting progress; returning to the UI should reattach to that transfer.
- [ ] Temporarily interrupt Wi-Fi in each direction, restore within two minutes,
      and verify resumption without a second copy of a previously published file.
- [ ] Accept/decline an incoming offer from its notification while the UI is
      absent. Test notification-permission denial and re-enabling it.
- [ ] Cancel while waiting for acceptance and while chunks are flowing. Ensure
      sockets/URI descriptors/CPU and Wi-Fi locks are released at termination.
- [ ] Test a real Downloads/Files provider and a slower document/cloud provider;
      revoke a grant or remove the source and confirm an explicit error.
- [ ] Check out-of-space, invalid digest and Downloads publication failures:
      no success state or visible corrupt final file; pending rows are cleaned up.
- [ ] Desktop → Android text/image clipboard with the Activity absent. Text →
      desktop from a focused Android app and using Share / selected text →
      AirBridge with automatic clipboard disabled. Preserve text whitespace.
- [ ] On Android 10+, confirm denied background clipboard reads do not crash
      the service; Accessibility is optional and does not scrape window content.
      Sensitive password-manager clips must not be auto-shared.
- [ ] Restart desktop with the same TLS CA, renew its leaf, then change its CA:
      same-CA reconnection succeeds; changed-CA connection fails until explicit
      Forget computer/re-pair after verifying the desktop. No HTTP downgrade.
- [ ] Repeat on Android 8/9 and current Android, plus at least one aggressive
      OEM battery-management build. Document any required battery exemption;
      force-stop/reboot/notification Stop are expected to terminate the service.

## Clipboard constraints

A foreground service grants execution continuity, **not** permission to read
another foreground app's clipboard on Android 10+. Granting Accessibility does
not universally remove that restriction. AirBridge attempts permitted events,
never reads text fields or window contents, and offers explicit Share/Text
Processing actions as the supported fallback. The app cannot truthfully
promise unrestricted automatic clipboard capture on every Android release.
