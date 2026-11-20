# AirBridge 2.5.1 — discovery, documentation and website release

AirBridge 2.5.1 changes **nothing in the running application**. The server,
clients, Android app and macOS shell are unchanged from 2.5.0 — same protocol,
same permissions, same encryption, same UI. This release publishes the refreshed
project documentation, search-intent website pages and community files, and
aligns every version string so the published artefacts match the site.

If you already run 2.5.0 there is no functional reason to upgrade. Install 2.5.1
only if you want the version that matches the current release notes, or you are
following the install commands on [airbridge.fyi](https://airbridge.fyi/) and
prefer a fresh artefact.

## What changed

### Project documentation

- **README** now opens with what AirBridge is, who it is for, why it differs and
  where to download it: a per-platform download table with checksums, real
  screenshots of a live transfer, the capability list, a supported-platform
  matrix, an honest security summary and a comparison that names where other
  tools are the better choice. All technical sections — architecture, chunk and
  ACK limits, Android background behaviour, environment variables, CLI, build
  instructions and licence — are preserved below it.
- **CONTRIBUTING.md**, **CODE_OF_CONDUCT.md**, a private-vulnerability section in
  **SECURITY.md**, three issue forms and a pull-request template were added so
  external reports arrive with the version, platform and redacted diagnostics
  needed to act on them.

### Website (airbridge.fyi)

- The landing page has a refined title/description, a real 1200 × 630 Open
  Graph image built from a screenshot, `WebSite` / `SoftwareApplication` /
  `FAQPage` structured data, a real-screenshot section and links to the guides.
- New static pages, one per genuine search intent: Android to Mac, Windows and
  Linux file transfer, the Android AirDrop alternative, clipboard sync, screen
  sharing, the open-source alternative, private file transfer, a download page,
  a guides hub, and an honest comparison with LocalSend, KDE Connect, AirDroid,
  LinkMyMac, Quick Share and AirDrop.
- `sitemap.xml` lists every page, `404.html` is `noindex`, favicons and
  apple-touch-icon are complete, and every page carries canonical, Open Graph and
  Twitter card metadata.
- The guide pages are generated from `scripts/site-pages/` with
  `npm run website:pages`; CI fails if the committed HTML is stale.

### Version alignment

- `package.json`, `package-lock.json`, `android/app/build.gradle.kts`
  (`versionName`), the website version pills and the release-facing docs now all
  read 2.5.1, and the generated pages read the version from `package.json` so
  they cannot drift again.

## Verification

Every artefact in this release is published with `SHA256SUMS.txt`. Sigstore
build-provenance attestations are attached to the files:

```bash
sha256sum --check SHA256SUMS.txt
gh attestation verify AirBridge-linux-x64 -R DigantaDey/AirBridge
```

macOS builds are ad-hoc signed (not notarised) and the Windows executable is
unsigned, because vendor certificates are paid subscriptions this project does
not buy; `install.sh` and `install.ps1` verify the checksums before installing
anything.

## Android

The release includes the installable **debug APK** (`AirBridge-android-debug.apk`)
for direct testing and sideloading. No signed Play App Bundle is attached: the
AAB is built only when the private Play upload key is configured, and it is
uploaded to Play rather than offered as a download. See
[PLAY_STORE_RELEASE.md](PLAY_STORE_RELEASE.md).

## Unchanged

- No changes to the transfer protocol, pairing (SPAKE2), key derivation,
  AES-256-GCM framing, WebSocket/WebRTC transport, relay, hotspot handoff,
  clipboard, screen sharing, call audio, contacts or daemon behaviour.
- No new Android permissions, no Accessibility service, no notification listener,
  no analytics or advertising SDK.
- No UI, layout, component or workflow changes in the Android app, the desktop
  app or the macOS menu-bar shell.
- The licence is unchanged: personal use is free, commercial use needs written
  consent.
