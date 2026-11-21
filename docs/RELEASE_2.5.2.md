# AirBridge 2.5.2

## Updated branding

- New AirBridge logo throughout the app, Android launcher, macOS app, website and social previews.
- Matching favicon and installed web app colours.

## Release fixes

- Android CI and local builds now use the same commit-based version code. CI checks out full history; shallow local clones fail with instructions instead of producing an incorrect code.
- Fixed broken documentation links in release notes, including the published v2.5.1 notes.
- Added regression checks for brand assets, Android packaging, release links and licence wording.

## Website and documentation

- Updated download and discovery pages for 2.5.2, with simpler wording and clearer platform limits.
- Corrected the homepage licence description: AirBridge uses the Fair-Use & Non-Commercial License, not MIT or Apache. Commercial or organisational use needs prior written consent.
- Google Play Store app is coming soon. The GitHub APK remains an installable testing/sideload build; a Play listing is not available yet.

## Installation notes

macOS builds are ad-hoc signed, not notarised. Windows executables are unsigned. Verify downloads using SHA256SUMS.txt and GitHub attestations. No third-party security audit is claimed.

A signed Play App Bundle is built only when private signing credentials are configured. See [the Play release checklist](https://github.com/DigantaDey/AirBridge/blob/v2.5.2/docs/PLAY_STORE_RELEASE.md).
