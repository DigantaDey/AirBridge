# AirBridge Privacy Policy

_Effective 16 November 2026 · Applies to the AirBridge Android app, the
AirBridge desktop service (macOS, Windows, Linux) and the web interface it
serves._ The public copy of this policy is <https://airbridge.fyi/privacy.html>.

## The short version

AirBridge moves your data **between your own devices** — the Android phone
and the computer you paired with it. It has **no accounts, no cloud, no
advertising, no analytics and no tracking**. Data travels over your local
network (or the phone's own hotspot), end-to-end encrypted between the two
paired devices. The AirBridge project never receives it.

## Who is responsible

AirBridge is an open-source project by Diganta Dey and contributors.
Contact: <hello@airbridge.fyi>.

## What AirBridge handles, and why

All of the following is processed only to provide the feature you turned on,
and only between your paired devices.

| Data | When | Purpose | Leaves your devices? |
| --- | --- | --- | --- |
| Files and photos you choose | You send them | File transfer | No |
| Clipboard text and images | Clipboard sync is on | Copy on one device, paste on the other | No |
| Notification content (app name, title, text) | Notification sharing is on **and** you granted Notification access | Show phone notifications on the computer | No |
| Contacts (name, numbers, emails, photo) | Contacts is on **and** you granted contacts permission | The computer searches/calls your contacts while connected; it does not keep a copy | No |
| Call state and the caller's number | Calls is on **and** you granted phone permission (number: only if you chose AirBridge as Caller ID app) | Answer, decline and place calls from the computer | No |
| Screen image and app audio | Only during a screen-sharing session you approve in Android's system prompt | Show the phone screen (and media sound) on the computer | No |
| Device name, pairing keys, trusted-device list | Always | Find, pair with and verify your devices | No |
| Camera image | Only while the QR scanner is open | Read a pairing QR code; frames are not stored | No |

AirBridge **never**: reads what you type or passwords; reads the rest of the
screen through Accessibility; opens the microphone; records or logs calls;
reads your call log or SMS; sells, shares or uses data for advertising.

### Accessibility service (optional)

The optional "AirBridge clipboard bridge" Accessibility service exists only so
text you copy in other apps can reach your paired computer while AirBridge is
in the background. It is off by default, is enabled only after you agree to an
in-app disclosure and switch it on in Android Settings, does not retrieve
window content, does not perform actions, and can be turned off at any time.

### Screen sharing and audio

Every session needs your approval in Android's own "start recording or
casting" prompt, shows a persistent notification, and can be stopped from the
notification or the app. Sound uses Android's playback-capture API, which
captures only media/game audio that the playing app allows; it cannot capture
the microphone or calls. Apps that protect their content (for example
Netflix, Prime Video, Hotstar) appear black — AirBridge does not bypass this.

## Storage and retention

* Transfer history, clipboard history (last 50 items) and settings stay on the
  device that created them until you clear them or uninstall.
* Pairing keys are stored on-device and are **excluded from Android cloud
  backup and device-to-device transfer**.
* Contacts, call details, notifications and screen frames are not stored by
  the computer; they are shown while connected and discarded.
* Received files are saved where you choose (default `~/Downloads/AirBridge`
  on a computer, Downloads on Android).

## Security

Sessions use per-pair keys, AES-GCM encryption and a six-digit verification
code you can compare on both screens. See [SECURITY.md](../SECURITY.md) for the
threat model and how to report vulnerabilities.

## Network connections the project can see

None by default. The desktop service may contact `api.github.com` to check
for updates, and crash reports are **only** sent if you review and submit them
(as a GitHub issue or to an endpoint you configure). The Android app makes no
connections other than to your paired computer.

## Children

AirBridge is a general-purpose utility not directed at children under 13 and
collects no personal data from anyone.

## Your choices

Every feature above has its own switch in Settings, every Android permission
can be revoked in Android Settings, and uninstalling removes all app data.
Because the project holds no data about you, there is nothing for us to
export or delete — but you can contact us with any question.

## Changes

Changes are published in this file (and on the website) with a new effective
date. Material changes are called out in the release notes.
