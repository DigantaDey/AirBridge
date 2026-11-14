# AirBridge

<p align="center">
  <a href="https://airbridge.fyi/">
    <img src="public/icon.svg" width="96" height="96" alt="AirBridge Logo">
  </a>
</p>

<h3 align="center">AirBridge</h3>

<p align="center">
  <strong>Fast, Zero-Trust Encrypted File Transfer & Universal Clipboard Sync between Android, macOS, Windows, and Linux.</strong>
</p>

<p align="center">
  <a href="https://airbridge.fyi/"><strong>🌐 Official Website: airbridge.fyi</strong></a>
</p>

<p align="center">
  <a href="https://github.com/DigantaDey/AirBridge/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/DigantaDey/AirBridge/ci.yml?branch=main&label=CI&style=flat-square" alt="CI Status"></a>
  <a href="https://github.com/DigantaDey/AirBridge/releases/latest"><img src="https://img.shields.io/github/v/release/DigantaDey/AirBridge?style=flat-square&color=blue" alt="Latest Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/DigantaDey/AirBridge?style=flat-square" alt="License"></a>
  <a href="https://airbridge.fyi/"><img src="https://img.shields.io/badge/website-airbridge.fyi-emerald?style=flat-square" alt="Website"></a>
</p>

---

## Overview

**AirBridge** bridges the gap between Apple's ecosystem and Android. It delivers an AirDrop-like experience over your local Wi-Fi network without relying on cloud accounts, third-party servers, cables, or media-compressing chat apps.

With **End-to-End Encryption (E2EE)** powered by ECDH P-256 key exchange and AES-256-GCM chunk encryption, your files and clipboard content stay strictly private. AirBridge streams encrypted data directly between devices on your local area network (LAN), without a configured transfer-rate limiter. Actual throughput depends on Wi-Fi, storage, encryption hardware, and whether the desktop is wired to the router. See the protocol safety limits below.

Whether you are dropping large video files or syncing clipboard snippets between your Mac and Android phone, AirBridge provides a unified, edge-to-edge native-web UI that behaves seamlessly across mobile, tablet, and desktop form factors.

---

## 🚀 Quick Install

Installing AirBridge requires **no paid developer accounts, app store logins, or cloud subscriptions**.

### macOS & Linux
```bash
curl -fsSL https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.sh | bash
```
> *On macOS, this creates `AirBridge.app` in `~/Applications` and places the executable in `~/.local/bin`.*

### Windows (PowerShell)
```powershell
powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.ps1 -UseBasicParsing | iex"
```

### Android
Download and install `AirBridge.apk` from the [Latest Release](https://github.com/DigantaDey/AirBridge/releases/latest).

---

## ✨ Features

### 📁 High-Speed Direct-to-Disk File Transfers
* **Native Direct-to-Disk Streaming**: Android and the desktop daemon stream multi-gigabyte files without file-sized RAM buffers. Browser-only receivers use the File System Access API when available and otherwise need enough memory for the received file.
* **Resume Interrupted Connections**: Append-only journals checkpoint private `.part` files. Both engines can resume a network interruption within a running session, reusing consent only for the same encrypted peer key and manifest. A force-stop/process death or changed identity requires a new send; final SHA-256 is always checked.
* **SHA-256 Pre-Save Verification**: Every file is hashed with SHA-256 as it streams. The receiving device compares the computed hash against the declared hash **before** saving or publishing the file, preventing corrupted files from reaching your Downloads folder.
* **Batch Operations**: Send up to 100 mixed-type files per transfer session. Image transfers automatically generate WebP previews for immediate inspection.

### 📋 Background Universal Clipboard Sync
* **Bidirectional Text & Manual Images**: Text syncs with paired devices when the OS permits clipboard capture. Image beams are supported in the UI, and incoming images can be placed on Android’s system clipboard. Desktop OS clipboard automation currently handles text, not image capture.
* **Headless Background Peer**: Desktop daemons maintain encrypted ECDH sessions in the background so clipboard syncing works even when browser tabs are closed.
* **Native Android Foreground Service**: Owns Kotlin encryption, WebSockets, URI sources, disk writes, incoming clipboard delivery, and transfer notifications independently of the Activity/WebView. Active transfers hold CPU/Wi-Fi performance locks; no file payloads cross the JavaScript bridge.
* **Honest Clipboard Fallback**: Android 10+ restricts background clipboard reads. Optional Accessibility capture is best-effort, **not** a permission bypass. Use **Share → AirBridge** or selected text → **AirBridge** to send from another app without reopening the AirBridge screen.

### 🔒 Zero-Trust End-to-End Encryption (E2EE)
* **Ephemeral ECDH P-256 Key Exchange**: Devices generate fresh keypairs per session to establish shared secrets.
* **AES-256-GCM Payload Encryption**: Control messages and 256 KiB binary file frames are encrypted on the sender before leaving the device and decrypted only after consent on the receiver.
* **6-Digit Verification Codes**: SAS (Short Authentication String) derivation lets users visually verify key integrity and prevent man-in-the-middle attacks.

### 📱 Adaptive Edge-to-Edge Native UI
* **Dynamic Safe-Area Handling**: Automatically calculates status bar, display cutout, and navigation bar insets, ensuring zero overlap with device status bars.
* **No Sideways Panning / Webpage Bounce**: Touch-action constraints (`pan-y`) and native overscroll mode (`OVER_SCROLL_NEVER`) eliminate horizontal page sliding for a 100% native app feel.
* **Light & Dark Studio Themes**: Automatically matches OS appearance settings with responsive layouts for phones, foldables, tablets, and desktop displays.

---

## 📊 Feature Comparison

| Feature / Capability | **AirBridge** | **Apple AirDrop** | **LocalSend** | **KDE Connect / NearDrop** | **PairDrop / Snapdrop** | **Quick Share** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Android <-> macOS Support** | **Full (Native APK + macOS App)** | ❌ Apple Only | ⚠️ Separate UI Apps | ⚠️ Partial / Unofficial | 🌐 Browser Only | ❌ Windows/Android Only |
| **End-to-End Encryption (E2EE)** | **ECDH P-256 + AES-256-GCM** | 🔒 Proprietary | 🔒 TLS (P2P) | 🔒 TLS | 🔒 WebRTC / TLS | 🔒 Proprietary |
| **Universal Background Clipboard** | **Daemon + native service; Android capture restrictions apply** | ⚠️ Apple Devices Only | ❌ Manual Send | ⚠️ Requires Config | ❌ Manual | ❌ No |
| **Direct-to-Disk Chunked Streaming** | **Yes (`.part` Resume Journal)** | ⚠️ Memory Bounded | ⚠️ In-Memory Buffering | ⚠️ Memory Bounded | ❌ In-Memory Assembly | ⚠️ Variable |
| **SHA-256 Pre-Save Verification** | **Yes (Verified before rename)** | ❌ No | ❌ Post-Transfer | ❌ No | ❌ No | ❌ No |
| **No Cloud / 100% Offline LAN** | **Yes** | ⚠️ Needs Apple ID | **Yes** | **Yes** | ⚠️ Needs WebRTC STUN | ⚠️ Needs Google Acc |
| **CLI / Daemon Execution Mode** | **Yes (`npx airbridge` / Binary)** | ❌ No | ❌ No | ⚠️ Partial | ❌ No | ❌ No |

---

## 🛠️ Architecture & Technical Specs

AirBridge operates over a dual-layer network pipeline:

```
┌─────────────────┐       WebSocket (/ws) / WebRTC DataChannel      ┌─────────────────┐
│  Android App /  │ ═══════════════════════════════════════════════ │   macOS / PC    │
│  Browser Peer   │   ECDH P-256 Key Exchange + AES-256-GCM Payload │  Daemon / Host  │
└─────────────────┘                                                 └─────────────────┘
```

1. **Signaling & Relay**: WebSockets at `/ws` carry JSON control messages and binary payload frames (`0x01` encrypted chunk, `0x02` routed relay frame). WebRTC DataChannels are established whenever P2P ICE candidate gathering succeeds.
2. **Native Android Ownership**: The APK bundles its own UI; a metadata-only bridge attaches it to the service-owned Kotlin engine. File bytes go from ContentResolver streams to encrypted sockets, or from verified private staging to Downloads/AirBridge. A bounded loopback proxy serves desktop API requests only. Android pins the desktop’s local TLS CA on first use, validates subsequent chains/hostnames, and never silently downgrades HTTPS to HTTP. Compare the E2EE verification code on first contact. Explicit `http://` links remain available for intentionally plaintext servers.
3. **Chunked Pipeline Tuning**:
   - **Chunk Size**: 256 KiB default (supports 16 KiB to 1 MiB bounds).
   - **Pipelining**: Browser senders pipeline up to 8 read/encrypt operations; Kotlin uses a native sequential provider stream and a separate writer. Neither inserts a fixed-rate sleep between chunks.
   - **Flow Control**: Browser socket watermarks are 4 MiB / 1 MiB; Kotlin’s outgoing queue is byte-bounded at 4 MiB (one oversized clipboard envelope may be admitted alone).
   - **ACK Windows**: 64 in-flight chunks, ACK every 8 contiguous stored chunks; sender waits for receiver SHA-256/publication confirmation before declaring success.
   - **Safety Limits**: Up to 100 files and 262,144 chunks in a manifest (64 GiB total at the default 256 KiB chunk size). These are allocation/validation limits, not a bandwidth cap. Frames/messages are bounded at 16 MiB; clipboard text at 256,000 characters and image data at about 5 MiB binary.

---

## Android background behavior

1. Update both the APK and desktop to the current release, pair using the desktop QR, and compare the six-digit verification code.
2. Keep **Settings → Connection continuity** enabled for idle discovery and incoming clipboard. Allow notifications to accept/decline offers without reopening the screen. An already-active transfer continues even if idle continuity is disabled.
3. Switching apps, Back, or a WebView renderer restart does not own/stop the native transfer. The foreground notification shows its state and speed. Android force-stop, the notification’s Stop action, reboot, revoked URI access, or aggressive OEM battery management can still terminate the service; no app can promise to survive those actions. This release does not auto-start at boot.
4. **Android → desktop clipboard**: ordinary hidden clipboard reads may be blocked even with Accessibility enabled. Share text to AirBridge, or select text and choose AirBridge, for an explicit background send. Password-manager clips marked sensitive are excluded from automatic capture. **Desktop → Android** clipboard delivery is service-owned and does not need this screen open.
5. Verified incoming files appear in **Downloads/AirBridge** on Android 10+. Android 8/9 falls back to app-specific Downloads when public-storage permission is unavailable; uninstalling removes app-specific files.
6. If the desktop’s pinned TLS identity changes, verify the desktop, choose **Forget computer**, and scan its new QR. A TLS error is not permission to downgrade the connection. Plaintext desktops require an explicit `http://host:port` invitation.

There is no 256 kbit/s or 256 KiB/s speed limiter. To diagnose a slow phone, compare the same large file in each direction, note **B/s versus bit/s**, test strong 5 GHz/6 GHz Wi-Fi with a wired desktop, and compare foreground versus screen-off behavior. Automated JVM/desktop tests do **not** establish real-phone throughput or OEM background behavior; see the [device validation checklist](docs/ANDROID_VALIDATION.md).

---

## 🔧 Configuration & Environment Variables

AirBridge daemons and CLI sessions can be customized via environment flags:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the AirBridge HTTP/HTTPS signaling server |
| `AIRBRIDGE_DOWNLOAD_DIR` | `~/Downloads/AirBridge` | Destination folder for received files |
| `AIRBRIDGE_HTTPS` | `1` | Enforces TLS/HTTPS (set to `0` behind reverse proxies) |
| `AIRBRIDGE_TLS_CERT` / `AIRBRIDGE_TLS_KEY` | `null` | Path to custom PEM certificate and private key |
| `AIRBRIDGE_BACKGROUND_CLIPBOARD` | `1` | Enables/disables the headless encrypted background clipboard peer |

### Command Line Interface (CLI)

```bash
# Start background daemon with custom download directory
npx airbridge daemon --dir ~/Inbox --reveal

# One-shot terminal file send (generates pairing QR in terminal)
npx airbridge send ./Presentation.pdf ./Archive.zip
```

---

## 💻 Local Development & Testing

AirBridge is built with TypeScript, React, Vite, Express, and Kotlin.

```bash
# Clone repository
git clone https://github.com/DigantaDey/AirBridge.git
cd AirBridge

# Install dependencies
npm ci

# Start development server with Vite hot reloading
npm run dev

# Run full unit test suite (Vitest + JSDOM)
npm test

# Run TypeScript typechecking
npm run typecheck

# Build client and server bundles
npm run build

# Android: Node dependencies above, JDK 17, Gradle 8.14.3 and Android SDK 35
# are required for the actual APK build. Bundled UI is generated by preBuild.
gradle -p android :engine:check :app:assembleDebug
npx tsx scripts/test-native-interop.ts  # HTTP/TLS Kotlin ↔ Kotlin/TS, 128 MiB JVM
```

---

## 📄 License

This project is licensed under the **AirBridge Fair-Use & Non-Commercial License**.
- **Individual / Personal Use**: Free for personal, individual non-commercial use on personal devices.
- **Commercial / Enterprise / Organizational Use**: Any commercial, corporate, enterprise, or monetized usage requires explicit prior written consent from the author ([Diganta Dey](https://github.com/DigantaDey)).

See [LICENSE](LICENSE) for full legal terms.

<p align="center">
  Developed with ❤️ by <a href="https://github.com/DigantaDey">Diganta Dey</a> • <a href="https://airbridge.fyi/"><strong>airbridge.fyi</strong></a>
</p>
