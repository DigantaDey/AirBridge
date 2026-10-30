# Distribution

How AirBridge ships to every machine you own — **without ever paying Apple or
Microsoft**, and with Android distributed as a normal sideload APK (a one-time
Google Play developer account, ~$25, is optional and only needed if you also
want the Play Store).

## What ships where

| Platform | Artifact | Produced by | Signing |
|---|---|---|---|
| macOS (Apple silicon) | `AirBridge-darwin-arm64` | macOS CI runner | **ad-hoc** `codesign -s -` |
| macOS (Intel) | `AirBridge-darwin-x64` | macOS CI runner | **ad-hoc** `codesign -s -` |
| Windows x64 | `AirBridge-windows-x64.exe` | Linux CI runner (bun cross-compile) | none (see SmartScreen below) |
| Windows ARM64 | `AirBridge-windows-arm64.exe` | Linux CI runner | none |
| Linux x64 (glibc / static) | `AirBridge-linux-x64`, `…-musl` | Linux CI runner | none |
| Linux ARM64 (glibc / static) | `AirBridge-linux-arm64`, `…-arm64-musl` | Linux CI runner | none |
| Android 8.0+ (API 26) | `AirBridge.apk` | Android CI job (Gradle) | committed sideload key (`android/ci.keystore`) |
| any OS with Node | `npm run build:desktop` | local / CI | same rules apply |

Every release also carries `SHA256SUMS.txt` — that is the integrity story in
lieu of paid code-signing certificates.

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

### Android — sideload APK, Play optional
* Sideload: download `AirBridge.apk` from the release → install (approve
  "install unknown apps" for your browser/file manager once). Updates install
  over the previous version because CI signs with the **same committed
  sideload key** (`android/ci.keystore`, override via
  `AIRBRIDGE_KEYSTORE_*` env vars for your own key).
* Play Store (optional, one-time ~$25 accepted by the project owner): upload
  the same APK as an AAB later; nothing in the app conflicts with Play policy
  (LAN-only transfers, no sensitive permissions).

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
(`AirBridge-<os>-<arch>[-musl][.exe]`, `AirBridge.apk`, `SHA256SUMS.txt`),
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
| macOS | `install.sh` → `~/.local/bin/AirBridge` | `--autostart` → `~/Library/LaunchAgents/com.airbridge.daemon.plist` + `launchctl bootstrap` |
| Linux | `install.sh` → `~/.local/bin/AirBridge` | `--autostart` → `~/.config/autostart/airbridge.desktop` |
| Windows | `install.ps1` → `%LOCALAPPDATA%\AirBridge` | `-Autostart` → `HKCU\…\Run` |
| Android | sideload APK | foreground service keeps transfers alive; enable auto-start in OEM settings if desired |

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
   * **darwin** job: `--only darwin` then `codesign --force -s -`;
   * **android** job: `gradle :app:assembleRelease` (versionCode = run number)
     plus the TypeScript-reference vector tests (`:engine:vectorTest`);
   * **publish** job: downloads all artifacts, writes `SHA256SUMS.txt`,
     `gh release create` with every binary + APK.
3. Users run `install.sh` / `install.ps1` or grab files from the release page.

## Asset names (must stay in sync)

| Where | Name |
|---|---|
| `scripts/build-desktop.mjs` | `AirBridge-darwin-<arch>`, `AirBridge-linux-<arch>[-musl]`, `AirBridge-windows-<arch>.exe` |
| `install.sh` | requests `AirBridge-<os>-<arch>`, `-musl` only on Linux, then falls back to the GitHub API manifest |
| `install.ps1` | requests `AirBridge-windows-<arch>.exe` |
| `src/client/components/DownloadsModal.tsx` | same names as the release assets |

macOS builds were previously emitted as `AirBridge-macos-*` while every
installer asked for `AirBridge-darwin-*` — that mismatch, not just the missing
release, is why `curl … | bash` failed on a Mac.

## Local reproduction

```bash
npm ci
npm run build:desktop            # all 8 desktop targets
bash android/scripts/verify.sh   # engine + vectors + app typecheck (no Gradle)
gradle -p android assembleRelease  # APK, same as CI
```
