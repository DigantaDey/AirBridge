## What changed

<!-- One or two sentences describing the user-visible effect. -->

## Why

<!-- The problem this solves, with a link to the issue if there is one. -->

## Scope check

- [ ] The change is focused; no unrelated refactors or reformatting.
- [ ] No new runtime dependency (or the reason is explained above).
- [ ] The security model is unchanged: no Accessibility service, no notification
      listener, no call-log permission, no plaintext control payloads, no silent
      HTTPS downgrade, no analytics.
- [ ] Any documentation or website text added here matches what the code does
      (no unsupported security or performance claims).
- [ ] Website changes use relative asset paths and were regenerated with
      `npm run website:pages` where applicable.

## Verification

<!-- What you actually ran, and on which platforms/devices. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Android: `gradle -p android :engine:check :app:assembleDebug`
- [ ] Manual test: <!-- phone model + desktop OS, what you did -->
