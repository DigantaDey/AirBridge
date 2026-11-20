# Contributing to AirBridge

Thanks for taking a look. AirBridge connects Android to macOS, Windows and Linux
without an account, so contributions that keep it **small, honest and local-first**
are the most valuable ones.

This file covers how to build, test and send a change. It is not a gate — a good
bug report from a real phone is as useful as a patch.

## Ways to help

- **Bug reports** — especially Android-to-desktop issues on real hardware. Include
  the version, platform, phone model and the redacted diagnostics bundle
  (Settings → *Copy diagnostics*).
- **Device reports** — OEM background behaviour, battery-optimisation quirks and
  Wi-Fi/relay edge cases. Use the *Device report* issue template.
- **Documentation** — the [guides site](https://airbridge.fyi/guides.html) and
  `docs/` both improve with exact commands and accurate caveats.
- **Code** — see the areas below. Protocol, encryption and permission changes get
  extra review because they touch the security model.
- **Translations and accessibility** — precisely worded UI text that stays
  truthful about platform limits.

Please do **not** open a public issue for a security problem; follow
[SECURITY.md](SECURITY.md) instead.

## Set up

Requirements:

| Tool | Version | Needed for |
| :--- | :--- | :--- |
| Node.js | 20+ (22 recommended) | Server, React client, CLI, tests |
| npm | bundled with Node | `npm ci` |
| JDK | 17 | Android builds |
| Gradle | 8.14.3 (or `./android/gradlew`) | Android builds |
| Android SDK | Platform 35, Build-Tools 35.0.0 | Android builds |

```bash
git clone https://github.com/DigantaDey/AirBridge.git
cd AirBridge
npm ci
npm run dev          # Vite dev server + Node service on port 3000
```

The Play-ready App Bundle additionally needs a private upload key; see
[docs/PLAY_STORE_RELEASE.md](docs/PLAY_STORE_RELEASE.md).

## Before you open a pull request

Run the checks that match what you changed:

```bash
npm run typecheck    # TypeScript
npm run lint         # ESLint + shellcheck
npm test             # Vitest unit/integration suite
npm run build        # client + server bundles
npm run test:e2e     # optional: end-to-end tiers
```

Android changes:

```bash
gradle -p android :engine:check :app:assembleDebug
```

Website changes (the static site in `website/`):

```bash
npm run website:pages   # regenerate guide pages from scripts/site-pages/
python3 -m http.server 8000 --directory website
```

Then check the pages at `http://localhost:8000`, including a narrow window, and
make sure every relative link still resolves. The generated pages must not
contain absolute asset paths (`src="/…"`) — GitHub Pages serves the site from a
subpath, and `.github/workflows/pages.yml` fails the build if one appears.

## What good changes look like

- **Keep the diff focused.** One concern per pull request; do not reformat files
  you are not changing.
- **Do not weaken the security model.** No Accessibility service, no
  notification-listener service, no `READ_CALL_LOG`, no plaintext control
  payloads, no silent HTTPS downgrade, no new analytics.
- **Do not add runtime dependencies** unless the feature genuinely cannot be
  implemented with the current stack (`@noble/curves`, `@noble/hashes`, `ws`,
  `express`, `react`, `qrcode`, `selfsigned`). Website-only additions should stay
  dependency-free static HTML/CSS.
- **Keep claims accurate.** Documentation and marketing text must match what the
  code does. No "unhackable", "military-grade" or invented download counts.
- **Test the failure path.** Resume, cancellation, permission denial and
  disconnect behaviour matter more than the happy path.
- **Respect platform rules.** Android background limits, DRM/`FLAG_SECURE`
  surfaces and OS clipboard restrictions are features, not bugs to bypass.

## Commit and pull request conventions

- Write commit subjects in the imperative mood (`Add relay retry backoff`).
- Explain the *why* and the user-visible effect in the pull request description.
- Say what you ran to verify the change ("`npm test`, `gradle :engine:check`,
  manual transfer on a Pixel 7 / macOS 15").
- Link the issue the change closes, if there is one.
- Draft pull requests are welcome if you want early feedback on an approach.

## Review

Maintainer review focuses on four questions: does it work, does it stay honest,
does it keep the security model intact, and does it keep the code understandable
for the next person. Expect questions rather than silent merges on protocol or
permission changes.

## License

AirBridge is distributed under the AirBridge Fair-Use & Non-Commercial License
(see [LICENSE](LICENSE)). By submitting a contribution you agree that it may be
distributed under those terms.
