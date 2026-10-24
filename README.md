# AirBridge

AirBridge is an open-source encrypted file-transfer prototype for Android and macOS. The current implementation is a browser application backed by a Node.js signaling/transfer service. It is **not yet a native, install-and-open product**.

The interface has been reduced to a focused transfer screen: device/service status, discovered devices, file selection and drag-and-drop, active transfer progress, pairing, settings, and recent transfers. The in-browser virtual-device simulator and clipboard controls are no longer part of the production screen.

## Important: current product limits

This repository does **not** currently provide installable macOS `.app`/`.dmg` or Android `.apk` artifacts. It does not yet meet the requested no-Terminal, no-server, no-certificate end-user setup. Do not present the current browser app as meeting that definition of done.

- The signaling service must be started separately. The current pairing mechanism shares an expiring room/code through that service; it is not local-native discovery.
- Browser WebCrypto and service-worker features require a secure context. `http://<Mac-LAN-IP>` is not a reliable secure context. Setting up trusted HTTPS on both devices remains a browser limitation; **do not bypass certificate warnings or weaken browser security**.
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

For a local browser-only development session, open the local URL printed by the server. Testing with a second physical device requires a network-reachable server and a secure browser context; the current project does not automate certificate provisioning. Never instruct users to ignore certificate warnings.

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
