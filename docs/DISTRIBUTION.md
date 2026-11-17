# Distribution

How AirBridge ships to every machine you own — with signed desktop artifacts
and an Android App Bundle prepared for **Google Play App Signing**. See the
[Play Store release gate](PLAY_STORE_RELEASE.md) before producing an AAB.

## What ships where

| Platform | Artifact | Produced by | Signing |
|---|---|---|---|
| macOS (Apple silicon) | `AirBridge-darwin-arm64` | macOS CI runner | **ad-hoc** `codesign -s -` |
| macOS (Intel) | `AirBridge-darwin-x64` | macOS CI runner | **ad-hoc** `codesign -s -` |
| macOS app (Apple silicon / Intel) | `AirBridge-macOS-arm64.zip`, `AirBridge-macOS-x64.zip` (Swift shell + embedded service) | macOS CI runner (`scripts/package-mac-app.sh`) | **ad-hoc**, bundle sealed and verified |
| Windows x64 | `AirBridge-windows-x64.exe` | Linux CI runner (bun cross-compile) | none (see SmartScreen below) |
| Windows ARM64 | `AirBridge-windows-arm64.exe` | Linux CI runner | none |
| Linux x64 (glibc / static) | `AirBridge-linux-x64`, `…-musl` | Linux CI runner | none |
| Linux ARM64 (glibc / static) | `AirBridge-linux-arm64`, `…-arm64-musl` | Linux CI runner | none |
| Android 8.0+ (API 26) | `app-release.aab` | `:app:bundleRelease` | private Play upload key + Play App Signing |
| any OS with Node | `npm run build:desktop` | local / CI | same rules apply |

Every release also carries `SHA256SUMS.txt` and keyless **Sigstore
build-provenance attestations** (`gh attestation verify <file> -R DigantaDey/AirBridge`)
— that is the integrity story in lieu of paid code-signing certificates. The
desktop self-updater enforces the checksums before installing anything; see
[desktop-runtime.md](desktop-runtime.md).

## Why no Apple or Microsoft money is needed

### macOS — ad-hoc signatures, curl downloads
* Compiling and running a CLI/app on macOS is free; only **Developer ID +
  notarization** ($99/yr) removes Gatekeeper's prompts for *downloaded* apps.
* AirBridge's release binaries are signed **ad-hoc** (`codesign -s -`) on a
  macOS runner. Ad-hoc is enough for Apple silicon, which refuses to execute
  entirely unsigned arm64 code.
* The installer and binaries are fetched with `curl`, which does **not** apply
  the quarantine attribute — Gatekeeper never triggers for terminal-installed
  files. (If you download through a browser instead: right-click → Open, or
  `xattr -d com.apple.quarantine AirBridge`.)
* Result: zero dollars, zero accounts.

### Windows — portable EXE via curl
* SmartScreen warnings come from an **unrecognized publisher**; removing them
  costs an Authenticode certificate (hundreds of dollars/yr) or a
  reputation built over time.
* `install.ps1` downloads with inbox **curl.exe**, which does not set
  Mark-of-the-Web, so double-clicking the already-on-disk EXE does not raise
  the SmartScreen sheet.
* Integrity is provided by `SHA256SUMS.txt` on the release page.
* Later, if you ever want a real signature for free: **SignPath.io** offers
  free code-signing for open-source projects (Certificate Vigilance /
  OSS community plan) — wire it into `release.yml` when desired.

### Linux
* No gatekeepers at all: tarball + `install.sh`, AppImage, or Flathub when the
  desktop build is ready. The `-musl` binaries run on any distro.

### Android — Google Play App Bundle
* The Android release is an **AAB**, signed locally or in CI with a private upload key and uploaded to Google Play. Google Play App Signing manages the installation signing key and delivery splits.
* `:app:bundleRelease` fails closed if `android/keystore.properties` or the four `AIRBRIDGE_KEYSTORE_*` variables are missing. The old committed sideload key was removed because it could not establish publisher authenticity.
* The Play submission requires a current privacy-policy URL, Data safety answers and foreground-service declarations. AirBridge’s detailed manual steps, permissions and review checklist live in [PLAY_STORE_RELEASE.md](PLAY_STORE_RELEASE.md).
* Current Android scope deliberately excludes Accessibility and notification-listener services, and does not request `READ_CALL_LOG`. Clipboard sends from other apps use Android Share / Process Text, the Quick Settings tile or the in-app Paste action.

## In-app Download center

The web UI served by every build has a **Downloads** panel (`GET /api/downloads`):

* lists all platform artifacts — the visitor's own platform is highlighted via
  user-agent;
* files that sit **next to the running binary** (or in `$AIRBRIDGE_ARTIFACTS_DIR`)
  are served from that machine over the LAN at `/downloads/<name>` — a phone
  installs the APK with zero internet access;
* everything else deep-links to `releases/latest/download/<asset>` plus
  `SHA256SUMS.txt`.

Security properties of the endpoint: exact-name whitelist only
(`AirBridge-<os>-<arch>[-musl][.exe]`, `SHA256SUMS.txt`),
basename-only resolution inside fixed search dirs (no traversal, no listing),
`Content-Disposition: attachment`, `Cache-Control: no-store`, and its own
`default-src 'none'` CSP. The app itself ships a strict global CSP +
`Permissions-Policy` + `Cross-Origin-Resource-Policy` in production builds
(dev mode is exempt so Vite keeps working).

## Truly cross-platform CLI (design decision)

Prebuilt binaries cover the mainstream matrix — but **any other device must
still work**. Wherever a Node 20+ runtime exists (FreeBSD, NAS boxes, exotic
arches, CI containers), `npx airbridge` starts the full server, and the
single-file binaries print the same thing from a terminal:

* the startup banner shows a **pairing QR** encoding
  `https://<lan>:<port>/?pair=<session-code>`;
* the **first** client to connect claims the session code; later hello-less
  clients get distinct codes (paired-only isolation is unchanged — an
  explicit `?pair=`/join is always honored, reconnects rejoin their previous
  group);
* scanning the QR requires the same physical access as reading the code on
  screen, so the trust model is unchanged;
* the CA-install hint is printed next to the QR for first-time HTTPS on a
  phone (fingerprint printed out-of-band for verification).

## Installer behavior (all no-admin)

| OS | Install | Autostart |
|---|---|---|
| macOS | `install.sh` → prebuilt `~/Applications/AirBridge.app` (checksum + signature verified) and `~/.local/bin/AirBridge` → symlink to its embedded service; older releases: local `swiftc` build or browser launcher | `--autostart` → `~/Library/LaunchAgents/com.airbridge.app.plist` (the app, `--background`, restarted after crashes); without the native app `com.airbridge.daemon.plist` (`KeepAlive.SuccessfulExit=false`) |
| Linux | `install.sh` → `~/.local/bin/AirBridge` | `--autostart` → systemd user unit `airbridge.service` (`Restart=on-failure`), else `~/.config/autostart/airbridge.desktop` |
| Windows | `install.ps1` → `%LOCALAPPDATA%\AirBridge` | `-Autostart` → `HKCU\…\Run` |
| Android | Google Play-signed app with bundled UI + native engine | foreground connection service after pairing; active transfers do not depend on the screen; no boot auto-start |

Nothing writes outside the user's home/profile; no `sudo`, no UAC, no admin.

## Release flow

A release **must** exist: `install.sh` and `install.ps1` resolve
`releases/latest/download/…`, so with zero published releases every download
404s. Cut one with either path:

* **no checkout** — Actions → **Release** → *Run workflow* → version
  (`1.2.0`, a `v` prefix is added automatically); or
* **from git** — `git tag v1.2.0 && git push origin v1.2.0`.

1. Push a tag `v*` (or dispatch the workflow).
2. `.github/workflows/release.yml`:
   * **linux-windows** job: `build-desktop.mjs --only linux` and
     `--only windows --skip-client` (bun cross-compiles from Linux);
   * **darwin** job: `--only darwin` then `codesign --force -s -`, then
     `scripts/package-mac-app.sh` for both architectures (prebuilt app zips);
   * **android** job: Node 22 + `npm ci`, a private upload key stored in GitHub
     Actions secrets, then `gradle :engine:check :app:bundleRelease`. The job
     fails early if a signing secret is absent. `preBuild` embeds the UI in the
     Android bundle; engine checks cover vectors, pairing, disk integrity and
     transport regressions;
   * **publish** job: downloads the desktop artifacts, writes
     `SHA256SUMS.txt`, attests build provenance (Sigstore, keyless), and
     publishes desktop binaries. The Play AAB remains a short-lived private
     Actions artifact; download it only to upload it to Play Console, never as
     a directly installable GitHub Release asset.
3. Users run `install.sh` / `install.ps1` or grab files from the release page.

## Asset names (must stay in sync)

| Where | Name |
|---|---|
| `scripts/build-desktop.mjs` | `AirBridge-darwin-<arch>`, `AirBridge-linux-<arch>[-musl]`, `AirBridge-windows-<arch>.exe` |
| `install.sh` | requests `AirBridge-<os>-<arch>`, `-musl` only on Linux, then falls back to the GitHub API manifest; macOS also `AirBridge-macOS-<arch>.zip` |
| `src/server/updater.ts` (`assetNameFor`) | same names; the macOS app updates from `AirBridge-macOS-<arch>.zip` |
| `install.ps1` | requests `AirBridge-windows-<arch>.exe` |
| `src/client/components/DownloadsModal.tsx` | desktop release assets; Android goes to Google Play |

macOS builds were previously emitted as `AirBridge-macos-*` while every
installer asked for `AirBridge-darwin-*` — that mismatch, not just the missing
release, is why `curl … | bash` failed on a Mac.

## Local reproduction

```bash
npm ci
npm run build:desktop              # all 8 desktop targets (network needed)
bash android/scripts/verify.sh     # optional SDK-jar preflight, NOT an APK build
gradle -p android :engine:check :app:assembleDebug
npx tsx scripts/test-native-interop.ts  # after engine:check writes its classpath
gradle -p android :engine:check :app:bundleRelease  # signed Play AAB (private upload key required)
```


Android builds require JDK 17, Gradle 8.14.3, platform SDK 35, build-tools
35.0.0 and the npm dependencies. Generated Vite assets live under
`android/app/build/generated/clientAssets/ui` and are not committed. A missing
bundle fails visibly instead of silently loading old desktop JavaScript.

For Android OS restrictions, Downloads behavior and device-only checks, see
[Android validation](ANDROID_VALIDATION.md) and the README's background section.
