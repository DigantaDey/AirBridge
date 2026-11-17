# Google Play submission notes

Everything a reviewer or the Play Console asks for, in one place. Keep it in
sync with `android/app/src/main/AndroidManifest.xml`; the e2e manifest tests
(`tests/e2e/tier1-feature-coverage/f13*`, `f18*`, `f21*`) guard the parts that
can be checked statically.

## Build requirements (checked)

| Requirement | Status |
| --- | --- |
| Target API level (new apps and updates since 31 Aug 2026: API 36) | `targetSdk = 36`, `compileSdk = 36` (AGP 8.11) |
| Android 16 edge-to-edge (forced at API 36) | `enableEdgeToEdge()` + `WindowInsets.safeDrawing` |
| Predictive back | `android:enableOnBackInvokedCallback="true"`, Compose `BackHandler` only |
| Large screens (API 36 ignores orientation/resizability locks) | No orientation locks; navigation rail at ≥ 600 dp, two-column screens at ≥ 840 dp |
| 16 KB page size | No native libraries |
| App Bundle | `gradle -p android :app:bundleRelease` (see *Signing*) |
| Backup of secrets | `allowBackup="false"` + `data_extraction_rules.xml` exclude everything |

## Signing — never use `android/ci.keystore` for Play

`android/ci.keystore` is committed on purpose so sideloaded APKs update in
place. Its private key is public, so it **must not** be your Play upload key.

1. Create a private upload key once and keep it out of Git:
   `keytool -genkeypair -v -keystore ~/airbridge-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 9125`
2. Enrol in **Play App Signing** (Google holds the app-signing key; you hold
   only the upload key, which can be reset if lost).
3. Build the bundle with the key supplied through the environment (read by
   `android/app/build.gradle.kts`):

   ```sh
   AIRBRIDGE_KEYSTORE_FILE=~/airbridge-upload.jks \
   AIRBRIDGE_KEYSTORE_PASSWORD=… AIRBRIDGE_KEYSTORE_ALIAS=upload \
   AIRBRIDGE_KEYSTORE_KEY_PASSWORD=… \
   gradle -p android :app:bundleRelease
   ```
4. Play-installed and sideloaded copies are signed differently and cannot
   update each other; users switching channels must uninstall first.

## Store listing

* **Privacy policy URL:** <https://airbridge.fyi/privacy.html> (source: [PRIVACY.md](PRIVACY.md)).
* **Category:** Tools. **Contains ads:** No. **In-app purchases:** No.
* **Short description (80):** `Share files, clipboard, notifications, calls and your screen with your computer.`
* Do not use "AirDrop" in the title or description (Apple trademark); say
  "works with Mac, Windows and Linux".

## Data safety form

All data moves only between the user's own devices, end-to-end encrypted, and
is never sent to the developer. Under Play's definitions, transfer to a device
the user controls is not "collection" by the developer and no data is
"shared" with third parties. Recommended answers:

* Does your app collect or share any of the required user data types? **No**
* Is all user data encrypted in transit? **Yes**
* Do you provide a way for users to request data deletion? Not applicable (no
  data collected); uninstall removes all on-device data.

If Play review disagrees and treats on-device processing as collection,
declare these as **collected, not shared, processed ephemerally where noted,
optional, purpose = App functionality**: Personal info → Name/Phone/Email (contacts),
Messages → Other in-app messages (notification text), Photos and videos /
Files and docs (user-chosen transfers), Audio → Other audio (screen-share
sound, ephemeral), Contacts, App activity → Other (call state, ephemeral).

## Permission declarations

| Permission / API | Declaration needed | Justification to paste |
| --- | --- | --- |
| `FOREGROUND_SERVICE_CONNECTED_DEVICE` + `DATA_SYNC` (`ConnectionService`) | FGS declaration | Keeps the encrypted link to the user's paired computer alive and finishes user-started file transfers while the app is in the background. Demo video: start a large transfer, leave the app, transfer completes. |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` (`ScreenShareService`) | FGS declaration | Mirrors the phone screen to the user's paired computer only after the user taps "Cast to computer" (or accepts a request from their computer) and approves Android's capture prompt. Persistent notification with Stop. |
| `RECORD_AUDIO` | Runtime permission (no form) | Required by Android's AudioPlaybackCapture API so screen sharing can include media sound. The microphone is never opened (no `setAudioSource`, no microphone FGS type). Asked only when a session with sound starts. |
| `READ_CONTACTS` | None (not restricted) | Optional; lets the paired computer search and call contacts. Behind a Settings switch. |
| `READ_PHONE_STATE`, `ANSWER_PHONE_CALLS`, `CALL_PHONE` | None (not restricted) | Optional; answer, decline and place calls from the computer. |
| Caller ID role (`CallScreeningService`, `ROLE_CALL_SCREENING`) | None | Shows the incoming number on the computer; the service always allows the call and never blocks, silences or logs. Used **instead of** `READ_CALL_LOG`, which the app does not request. |
| `AccessibilityService` (`ClipboardAccessibilityService`) | **Accessibility API declaration + video** | Not an accessibility tool (`isAccessibilityTool` is not set). Core user-facing feature: optional clipboard bridge so text copied in other apps reaches the paired computer while AirBridge is in the background. Does not retrieve window content (`canRetrieveWindowContent=false`), perform gestures or read input. Enabled only after the in-app disclosure (Settings → "Background clipboard bridge opt-in" → **Agree**) and the user's switch in Android Settings. Video: show disclosure → Agree → Android Settings → copy text in Chrome → appears on the computer. |
| `NotificationListenerService` | None (no form), prominent disclosure required | Optional notification mirroring to the paired computer, after the in-app disclosure. Ongoing, foreground-service, group-summary and `VISIBILITY_SECRET` notifications are skipped. |
| `CAMERA` | None | QR pairing only. |
| `NEARBY_WIFI_DEVICES` / `BLUETOOTH_SCAN` (`neverForLocation`), location ≤ API 32 | None | Local-only hotspot handoff; never used for location. |

### Prominent disclosure (User Data policy)

The Accessibility and Notification-access screens are never opened directly:
`SettingsScreen.SensitiveAccessDisclosure` explains what is read, why, where
it goes (only the paired computer, encrypted, no third parties, no ads), and
how to turn it off, with **Agree** / **Not now**. Declining changes nothing.
The Accessibility service also no longer opts itself in when enabled from
Android Settings without that consent.

### Known review risks

* **Accessibility** is the highest-risk item: reviewers may judge a clipboard
  bridge non-essential. If rejected, ship a Play flavour without
  `ClipboardAccessibilityService` (foreground clipboard sync still works) —
  remove the `<service>` from that flavour's manifest.
* Android 17 Advanced Protection revokes Accessibility from non-tool apps;
  the app degrades to foreground clipboard sync.
* Screen capture of DRM content is black by design; do not describe the
  feature as casting Netflix/Prime/Hotstar.
