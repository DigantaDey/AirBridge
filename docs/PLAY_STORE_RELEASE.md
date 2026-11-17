# Google Play release gate

This is the release checklist for the **Android App Bundle (AAB)**. It is written for the Play-safe AirBridge 2.4.7 product, not the former sideload workflow.

> This checklist reduces review risk; it cannot guarantee approval. Policies and Play Console questions change, so validate every declaration against the current Console before submitting.

## What changed for the Play build

The release build now has a deliberately smaller, explainable permission surface:

- **No committed release signing key.** `bundleRelease` fails until a private upload key is configured. The old public `android/ci.keystore` has been removed.
- **No Accessibility Service.** AirBridge does not use overlays or global UI events to read another app's clipboard. Use Share / Process Text → AirBridge, the Quick Settings tile, or the in-app Paste button for an intentional clipboard send.
- **No notification-listener service.** The app does not read, mirror or transmit all device notifications.
- **No `READ_CALL_LOG`.** Remote call controls do not need the restricted call-log permission.
- **No Android backup.** Pairing state and TLS pins are not included in Android Auto Backup.
- **Screen casting is per-session and protected-content safe.** It requires both an in-app confirmation and Android's MediaProjection prompt. Low-latency AVC video is end-to-end encrypted. Playback/app audio is off by default and has a separate per-session opt-in; Android Playback Capture and the source app decide whether it is available. AirBridge does not classify apps, bypass protected surfaces, or extract protected audio. When the platform or source blocks capture, the cast is blank or silent and the user is told it cannot be shared.

These choices are intentional product constraints, not hidden fallbacks.

## 1. Create and protect a Play upload key

Do this once on a secure machine. Keep the key and passwords outside the repository and in a password manager / secure secrets store. Enrol in **Play App Signing** and use this as the upload key; Google manages the distribution signing key.

```bash
keytool -genkeypair -v \
  -keystore ~/secure/airbridge-upload.jks \
  -alias airbridge-upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Copy the local template and fill it with the real values. Never commit the resulting file.

```bash
cp android/keystore.properties.example android/keystore.properties
# Edit android/keystore.properties locally.
```

`android/keystore.properties` and `*.jks` / `*.keystore` files are ignored by Git. The same four values can instead be supplied in CI as environment variables:

- `AIRBRIDGE_KEYSTORE_FILE`
- `AIRBRIDGE_KEYSTORE_PASSWORD`
- `AIRBRIDGE_KEYSTORE_ALIAS`
- `AIRBRIDGE_KEYSTORE_KEY_PASSWORD`

Do **not** reuse a debug key or the retired CI key. If an older sideload APK was installed with that key, it cannot update in place to this Play-signed app; uninstall it before installing the Play version.

## 2. Build the signed AAB in Android Studio

1. Open the `android` directory in Android Studio and allow Gradle sync to complete.
2. Confirm `android/keystore.properties` exists locally and points at the private upload key.
3. Select the `release` build variant.
4. Run **Build → Generate Signed Bundle / APK → Android App Bundle**, or the Gradle task `:app:bundleRelease`.
5. Upload `android/app/build/outputs/bundle/release/app-release.aab` to Play Console's **Internal testing** track first.

The build enables R8 and resource shrinking. A release task stops with a clear error if signing is absent. Debug builds remain available for local development and are never release-signed.

## 3. Play Console declarations that require manual work

### App content / privacy policy

Set the public privacy-policy URL to:

```text
https://airbridge.fyi/privacy.html
```

The same link is available in Android under **Settings → Privacy & safety**. Publish that page before the Play submission.

Review the Data safety questionnaire against the submitted AAB and actual server configuration. The current product behavior is:

| Data category | Why it is handled | Where it goes |
|---|---|---|
| Files, photos, videos, audio and documents | User-selected transfer | Only to a paired device selected by the user |
| Clipboard text/images | Explicit send; optional automatic send where Android permits it | Only to paired devices |
| Contacts | Optional Contacts feature after user toggle + Android permission | Only to a paired device while enabled |
| Screen content and optional app playback audio | Per-session user-approved MediaProjection; audio needs its own default-off checkbox | Only to the paired viewer; encrypted AVC/PCM media; platform/source policies can exclude protected content |
| Device/connection identifiers | Pairing, trust pinning and reconnect | Stored locally; peer needs it to connect |

AirBridge has no account, advertising SDK, analytics SDK, notification listener or Accessibility Service. A configured self-hosted relay transports encrypted traffic but should still be described accurately if it is enabled for a release. Do not copy this table blindly if product behavior, relay configuration, telemetry, crash reporting or SDKs change.

### Foreground services

The app declares these foreground-service types, so complete the corresponding Play Console declaration with an honest demo video and user-facing description:

| Type | Legitimate visible use |
|---|---|
| `connectedDevice` | Maintaining an active, user-paired computer connection for incoming transfers and clipboard delivery |
| `dataSync` | A user-approved file transfer with visible transfer progress |
| `mediaProjection` | A user-approved encrypted H.264 screen cast, started only after Android's capture prompt |
| `microphone` | Android Playback Capture only when the user selected optional app audio for that active cast; it is never used for background microphone recording |

The always-on connection service does **not** claim the media-projection type. Stop a recording after each transfer/share in the review video so reviewers can see the stop controls and notifications.

### Permission declarations

Explain each optional permission in both the Play declaration and store listing/support material:

- **Camera:** QR pairing scanner only.
- **Nearby Wi-Fi / Bluetooth / location on Android 12 and lower:** nearby discovery and optional hotspot handoff; never used to derive location.
- **Notifications:** transfer progress and incoming-transfer action notifications.
- **Contacts:** optional phone-on-computer contact search.
- **Phone state / answer calls / call phone:** optional paired-computer call controls. Call audio stays on the phone and AirBridge does not request call logs.
- **Media projection:** per-session, user-approved encrypted screen cast. `RECORD_AUDIO` is requested only when the user selects the optional, default-off permitted app-audio checkbox for that session.

Never state that clipboard sync is guaranteed in the background. Android itself can suppress hidden clipboard reads.

## 4. Listing and review material

Before production, provide a professional, internally consistent listing:

- product name, short description, full description and support email;
- 512 × 512 Play icon, feature graphic, phone and tablet screenshots from the release build;
- a short review video covering pair QR → verify code → select file → receive/accept → stop screen share;
- the privacy-policy URL above;
- clear wording that casting uses user-approved screen capture; app audio is default-off and only platform-permitted playback is shared; protected content is not supported or bypassed;
- clear setup instructions that the desktop companion is required.

Do not use “prototype”, “unlimited background clipboard”, “cast Netflix”, “ChromeCast replacement”, or unqualified “no cloud” claims in the listing. The relay mode and Android privacy limits make those claims misleading.

## 5. Required pre-submit validation

Run all automated checks available in the release environment:

```bash
npm ci
npm run typecheck
npm test
npm run build
gradle -p android :engine:check :app:bundleRelease
npx tsx scripts/test-native-interop.ts
```

Then validate the actual signed AAB in an Internal test on at least one current Android device and one Android 8/9 device where supported:

- pair using QR and compare the verification code;
- send and receive small, empty and large files; verify received SHA-256 results;
- test Share / Process Text → AirBridge, Paste, and the Quick Settings tile;
- deny Camera and Notifications, then verify manual pairing and foreground transfer behavior remain understandable;
- enable Contacts, Calls and Screen sharing one at a time; revoke each permission and verify the feature disappears;
- start then stop a screen share; verify the persistent notification and the two consent steps;
- verify platform/source-blocked protected content is not described as castable, cannot yield audio, and is communicated as unavailable without an alternate capture attempt;
- test connection loss, low battery, app backgrounding, Forget device, certificate/pin mismatch, and app update;
- inspect the merged release manifest and Play pre-launch report for unexpected permissions, exported components and crashes.

See [Android validation](ANDROID_VALIDATION.md) for the lower-level transfer and network checklist.
