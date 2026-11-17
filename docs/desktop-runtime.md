# Desktop runtime: app, updates, notifications, supervision, diagnostics

How the desktop side of AirBridge runs, updates and reports problems. None of it
needs a paid Apple Developer account; the parts that would are listed at the end.

## Pieces

| Piece | What it is |
|---|---|
| **Service** | The single-file binary (`AirBridge-<os>-<arch>`): HTTPS + WebSocket server, pairing, transfers, clipboard. |
| **macOS app** | `AirBridge.app` (`scripts/mac_app.swift`): window and menu bar; supervises the service; shows native notifications; installs updates. Release builds ship the service inside the bundle at `Contents/Resources/airbridge-server`. |
| **Installer** | `install.sh` / `install.ps1`: download, verify, install, and optionally register autostart. |

## Prebuilt macOS app

Release CI runs `scripts/package-mac-app.sh` to build `AirBridge-macOS-arm64.zip` and
`AirBridge-macOS-x64.zip`:

- the Swift shell is compiled per architecture;
- the matching service binary is embedded;
- `Info.plist` carries the release version;
- the bundle is ad-hoc signed inside-out and checked with `codesign --verify --deep --strict`.

The macOS CI job runs the same script, then tests the bundle (`scripts/test-mac-app.sh`, scenarios 8–10).

`install.sh` installs this bundle, so users no longer need Xcode or `swiftc`:

1. It downloads the zip.
2. It requires the zip's SHA-256 to match `SHA256SUMS.txt`.
3. It checks the bundle ID, the code signature, and that the embedded service runs.
4. It swaps the bundle in place.
5. It points `~/.local/bin/AirBridge` at the embedded service with a symlink. The CLI and the app therefore always run the same version.

Per-user settings, such as a non-default port, go in `~/.airbridge/port`, never inside the bundle: editing a signed bundle breaks its seal.

Older releases without a zip fall back to the previous behaviour: a local `swiftc` build, or a shell-script launcher.

## Updates

Desktop binaries update themselves. Updates are off for development builds and for source installs.

### Flow

1. **Check.** About a minute after start, then every 6 hours, the service queries GitHub's `releases/latest`. You can also check from the menu (**Check for Updates…**) or from the page.
2. **Stage.** A strictly newer, non-prerelease version is downloaded in the background:
   - on macOS app installs, the whole `AirBridge-macOS-<arch>.zip`;
   - elsewhere, the platform binary.
3. **Verify.** All of these must pass before anything is installed:
   - **Source:** HTTPS only, from GitHub hosts only. Redirects are checked hop by hop.
   - **Integrity:** the file's SHA-256 must equal its line in that release's `SHA256SUMS.txt`.
   - **Smoke test:** the staged binary must run and report exactly the new version (`--version`).
   - **App bundles:** must also pass `codesign --verify --deep --strict` and carry the new `CFBundleShortVersionString`.
   - **No downgrades:** older or equal versions and prereleases are ignored.
4. **Install.** Only after you click **Restart to update** (page banner) or confirm in the macOS menu:
   - the current build moves to `~/.airbridge/previous/`, or to `<binary>.previous` for bare binaries;
   - the new build is renamed into place;
   - the service restarts.
5. **Restart.**
   - **Supervised** (macOS app, launchd agent, systemd unit): the service exits with status **75** ("restart me").
   - **Unsupervised:** the service starts the new build itself.
   - **App bundle updates:** the app also relaunches from the new bundle.
6. **Rollback.** If the new build starts 3 times without staying up for a minute, the previous build is restored automatically and the failed one is kept as `*.failed`.

Background checks follow the release's **staged rollout** (10% → 50% → 100% over 3 days by default). Manual checks always bypass it. See [Staged rollouts](pairing-and-connectivity.md#staged-rollouts) for operator controls, and [Crash reports](pairing-and-connectivity.md#crash-reports) for what happens when the service crashes.

### Turning updates off

Set `AIRBRIDGE_AUTO_UPDATE=0`. Your package manager or the installer then stays in charge.

### Keyless provenance

Each release also carries **Sigstore build-provenance attestations**. GitHub Actions creates them with OIDC, so no signing keys or repository secrets exist that could leak. They prove a file was built by this repository's release workflow from a specific commit:

```bash
gh attestation verify AirBridge-macOS-arm64.zip -R DigantaDey/AirBridge
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Notifications (macOS)

The service never compiles or launches helpers to show a notification:

1. The app subscribes to a loopback Server-Sent Events stream, `GET /api/local/events`. Only this computer can connect, and the request needs the `X-AirBridge-Shell` header, which web pages cannot send cross-origin.
2. The app posts notifications through **UNUserNotificationCenter**. Clicking a notification opens AirBridge.
   - Hotspot handoff requests arrive as actionable notifications (**Join / Always join paired phones / Not now**). Dismissing leaves the request answerable in the window until it expires. See [Hotspot handoff](pairing-and-connectivity.md#hotspot-handoff).
3. If notification permission is denied, or the app isn't running, the app doesn't subscribe for notifications and the service falls back to `osascript`.

(History: v0.0.5 compiled a Swift helper synchronously inside the service. That froze the service long enough for the watchdog to restart it in a loop.)

## Supervision and login

| Setup | Who restarts the service | At login |
|---|---|---|
| macOS app | the app's supervisor: restarts after exit or crash with backoff; status 75 restarts at once; a busy service is never killed (90 s hang grace) | **Open at Login** menu item, or `install.sh --autostart` → `~/Library/LaunchAgents/com.airbridge.app.plist` (`--background`, `KeepAlive.SuccessfulExit=false`, `ThrottleInterval=10`) |
| macOS, no app | launchd: `com.airbridge.daemon` with `KeepAlive.SuccessfulExit=false` | `install.sh --autostart` |
| Linux | systemd user unit `airbridge.service` (`Restart=on-failure`) | `install.sh --autostart`; falls back to an XDG autostart entry without systemd |
| Windows | the service restarts itself after updates | `install.ps1 -Autostart` (HKCU Run) |

The app is single-instance: a second launch, for example the login item while the app already runs, hands over and exits 0.

## Diagnostics

**Copy diagnostics** is available on the page and in the macOS menu (**Copy Diagnostics**). It copies a JSON report you can paste into an issue:

- version, pid, uptime, and who supervises the service;
- OS and architecture;
- network interfaces, advertised addresses, and addresses the certificate doesn't cover;
- mDNS state, Mac firewall state, and the per-target state of the reverse (Mac → phone) dialer;
- TLS fingerprints;
- connected devices (name, platform, address);
- update state;
- event-loop stalls;
- the last 200 log lines.

**Never included:** pair codes (they are redacted from logs too), keys, and tokens.

Endpoint: `GET /api/diagnostics`. Like `/api/update*` and `/api/local/events`, it is restricted to this computer.

## What still needs Apple's paid program

These are deliberately out of scope:

- **Developer ID signing and notarization.** Without them, a zip downloaded *through a browser* is quarantined, so Gatekeeper asks you to right-click → Open. `curl` and the in-app updater don't set quarantine, so neither path is affected.
- **Firewall permission after updates.** The macOS firewall keys its exceptions to the code signature. Ad-hoc signatures change every build, so with the firewall on, macOS may ask again after an update. AirBridge reports this state in the UI and in diagnostics.
- **`SMAppService` login items.** These need a signed app; the launchd agent above provides the same behaviour.
