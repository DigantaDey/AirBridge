# AirBridge

AirBridge is an open-source encrypted file-transfer prototype for Android and macOS. The current implementation is a browser application backed by a Node.js signaling/transfer service. It is **not yet a native, install-and-open product**.

The interface is a focused transfer screen: device/service status, discovered devices, file selection and drag-and-drop, an encrypted universal clipboard (text, links, OTP codes, snippets), active transfer progress, pairing, settings, and recent transfers.

## Universal clipboard (copy-paste between devices)

The same E2EE channel that carries files also carries clipboard text (`ECDH-P256` + `AES-256-GCM`; encrypted peer-to-peer between devices):

- **Automatic copy-beam:** With **Auto-beam copied text** enabled (on by default in **Clipboard** or **Settings**), copying text on the Mac running the local AirBridge service automatically beams it to your paired Android device in the background via the local OS clipboard bridge — no need to switch back to the AirBridge browser tab. On Android, copying inside the page, sharing text/links via the Android Share Sheet, or returning to AirBridge with newly copied text (when clipboard permission allows) beams automatically; you can also compose or paste manually in **Clipboard**.
- **Receive text:** Incoming beams write directly to the host OS clipboard on the Mac (even while the browser tab is in the background) and to the browser clipboard on Android (with automatic deferred write on focus/tap if the mobile browser was unfocused, plus a **Copy** toast fallback), and every beam is kept in the Clipboard modal's history with one-click copy and "Open URL" for links.

## Important: current product limits

This repository does **not** currently provide installable macOS `.app`/`.dmg` or Android `.apk` artifacts. It does not yet meet the requested no-Terminal, no-server, no-certificate end-user setup. Do not present the current browser app as meeting that definition of done.

- The signaling service must be started separately. The current pairing mechanism shares an expiring room/code through that service; it is not local-native discovery.
- Browser WebCrypto and service-worker features require a secure context, so the server now serves HTTPS for LAN devices out of the box (see [HTTPS on your local network](#https-on-your-local-network)). A one-time, fingerprint-verified installation of the server's local CA on the phone is still a manual step — that is a browser/OS trust requirement no web app can automate away.
- The receiver asks for consent by default. Trust/auto-accept behavior exists in the current engine, but revocation and trust management still need a dedicated, user-friendly native settings surface.
- Outgoing file reads are chunked, but incoming file data is retained in memory by the browser. Large incoming files can exhaust device memory. Interrupted transfers are not resumable.
- Automated tests below cover protocol and engine behavior, not physical Android ↔ Mac installation or transfer. No physical-device tests, first-run native installation tests, or signed release tests have been performed in this environment.
- The app is not AirDrop-compatible and does not guarantee transfer speeds or discovery across guest/client-isolated networks.

These limitations are intentionally explicit: a monochrome UI is not a substitute for a secure, packaged native networking implementation.

## Running from source (development only)

These commands are for contributors. They are **not end-user installation instructions**.

Requirements: Node.js 20+ and npm.

```sh
git clone https://github.com/DigantaDey/android-to-mac.git
cd android-to-mac
npm ci
npm run dev
```

On the Mac, open `http://localhost:3000` (browsers already treat localhost as a secure context). On a phone on the same Wi-Fi, scan the QR code from the pairing panel — it now points at the **HTTPS** LAN address (e.g. `https://192.168.1.20:3000`). The first time each phone connects it needs the one-time CA step below; after that it connects with no warnings, even when the Mac's Wi-Fi address changes.

## HTTPS on your local network

### Why the phone used to say “Secure connection required”

AirBridge's end-to-end encryption runs on WebCrypto (`crypto.subtle`), which browsers only expose in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): an HTTPS page, or `http://localhost`. A plain `http://<Mac-LAN-IP>:3000` page — what the old QR code opened — is **not** a secure context, so key generation failed and the phone showed “Transfer service unavailable / Secure connection required”. Manually retyping the address as `https://…` failed differently (“SSL received a record that exceeded the maximum permissible length”) because the old server only spoke plaintext HTTP.

### What the server does now

- HTTPS is **on by default** (`AIRBRIDGE_HTTPS=0` or the CLI's `--http` opts out, e.g. behind a TLS-terminating proxy; tests stay HTTP unless they opt in).
- The **same port accepts both HTTP and HTTPS**. Plain HTTP from another device redirects (308) to the identical HTTPS URL, so old QR codes/bookmarks keep working, and `https://<LAN-IP>:3000` typed by hand just works. `http://localhost` on the Mac itself is left alone.
- Certificates are provisioned automatically: the server creates a small local certificate authority in `~/.airbridge/tls` (override with `AIRBRIDGE_TLS_DIR`) and a leaf certificate covering `localhost` and every current LAN IP. If the Mac's LAN IP changes, a fresh leaf is re-issued under the **same** CA, so devices that already trust the CA see no new warnings.
- Prefer your own certificate (mkcert, Let's Encrypt, …)? Set `AIRBRIDGE_TLS_CERT`/`AIRBRIDGE_TLS_KEY` (or `--tls-cert`/`--tls-key` on the CLI) and the generated CA is not used. With mkcert, for example: `mkcert -install && mkcert localhost 127.0.0.1 ::1 $(ipconfig getifaddr en0)`, then point the env vars at the two `.pem` files and install mkcert's `rootCA.pem` on the phone as below.
- Check what is active at any time via `GET /api/health` (`https`, `tlsSource`, `caFingerprintSha256`).

### One-time step on each phone (generated CA)

No public CA will issue a certificate for `192.168.…`, so the phone must learn to trust your Mac's local CA once:

1. Start AirBridge on the Mac. The terminal prints the CA's **SHA-256 fingerprint** and the phone's HTTPS address.
2. On the phone, open `http://<Mac-LAN-IP>:3000/airbridge-ca.crt` (this single download intentionally stays on HTTP — a phone can't fetch a CA it doesn't trust over a connection that already needs that trust).
3. Install it: **Android** — Settings → Security & privacy → More security settings → *Install a certificate* → **CA certificate** (wording varies by vendor), choose the downloaded file. **Compare the fingerprint shown by Android with the one printed on the Mac** and only confirm if they match. Android may warn that network traffic *could* be monitored by this CA — that's the standard warning for any user-installed CA; this one exists only on your Mac.
4. Open (or re-scan) the `https://<Mac-LAN-IP>:3000` address. It now loads with a lock, WebCrypto is available, and pairing works. Repeat only for new phones; if you ever want to revoke it, delete “AirBridge Local CA” from the phone's user credentials and/or delete `~/.airbridge/tls` on the Mac.

If you skip the CA install, the browser will show a one-time “certificate not trusted” interstitial for the HTTPS address instead. Only proceed past it after confirming the certificate fingerprint in the browser's certificate details matches the Mac's output — don't make a habit of bypassing that screen for sites you don't control.

> Note: HTTPS gets the app a secure context; AirBridge's transfers are additionally end-to-end encrypted between the two devices (ECDH-P256 + AES-256-GCM) on top of it. The CLI's one-shot `airbridge send <file>` QR link remains a token-gated plain download (it needs no browser crypto); the same link also works over HTTPS if you change the scheme.

### Checks

```sh
npm run typecheck
npm test
npm run build
```

`npm run build` creates a web client in `dist/client` and compiles the server into `dist/server`. These are development/build outputs, **not installable macOS or Android packages**. `npm start` runs the built Node service; it is not a packaged app launcher.

## Native packaging and release status

- **Locally buildable native packages:** none currently defined.
- **Signed/notarized macOS release:** none. A future macOS app will require Apple Developer signing/notarization credentials for a broadly trusted download.
- **Android release package:** none. A future Android app will require Android packaging/signing configuration and maintainer release credentials for a published release.

No signing credentials are needed for the existing web test/build commands. This repository does not claim a reproducible native release build until the native app targets, offline/bundled dependencies, permissions, update path, and release workflows exist.

## Engineering status

The existing `src/client/engine` and `src/server` contain the browser transfer engine, WebRTC/signaling, encrypted control/data framing, and optional local macOS daemon integration. Reusing parts of that engine may be useful, but its web-runtime assumptions and in-memory receive path mean it cannot simply be wrapped and called a native app. A production implementation still needs native local-network discovery, authenticated pairing integrated with both app identities, streamed native file I/O, clear permission recovery, reconnect/cancel behavior, and reproducible signed/unsigned package pipelines.

License: MIT. See [LICENSE](./LICENSE).
