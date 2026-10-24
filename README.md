# ⚡ AirBridge (`android-to-mac`)

> **The fast, end-to-end encrypted, open-source AirDrop & Universal Clipboard alternative built for people who use an Android phone and a MacBook.**

Apple's AirDrop and Universal Clipboard feel magical inside a walled garden—until your daily driver is an **Android phone** paired with a **MacBook**. Existing workarounds force you to install clunky drivers, upload uncompressed 4K videos to cloud servers, message yourself on WhatsApp/Telegram (destroying image quality), or wrestle with broken MTP cables.

**AirBridge** solves both **Bidirectional File Transfer** and **Universal Clipboard** with zero cloud storage, zero media compression, hardware-grade **ECDH P-256 + AES-256-GCM End-to-End Encryption**, and a hybrid **WebRTC Direct P2P + Binary WebSocket Stream** engine (`Warp Protocol v1`).

---

## ✨ Key Capabilities

- **Bidirectional Android ↔ MacBook AirDrop**: Send RAW photos, 4K 60fps videos, `.apk`s, `.dmg`s, PDFs, or drag entire nested macOS Finder folders directly onto your Android device—and vice versa.
- **Hybrid Dual-Transport (`Warp Protocol v1`)**:
  - **Primary**: Direct peer-to-peer `RTCDataChannel` (`WebRTC` SCTP over LAN Wi-Fi) with `bufferedAmountLowThreshold` flow control—zero server bandwidth, LAN-speed saturation.
  - **Seamless Fallback**: Zero-copy binary WebSocket streaming (`0x02` routed binary frames with `perMessageDeflate: false` and 48-chunk sliding-window receiver ACKs)—succeeds 100% of the time even across corporate firewalls, AP-isolated guest Wi-Fi, or Android 5G ↔ MacBook Ethernet.
- **Zero-Knowledge End-to-End Encryption (E2EE)**:
  - Ephemeral **WebCrypto `ECDH P-256`** key exchange + **`HKDF-SHA256`** key derivation + **`AES-256-GCM`** authenticated encryption on every control offer, thumbnail preview, clipboard snippet, and 64 KB binary file chunk.
  - Human-verifiable **6-Digit SAS Security Code** (`🔐 849 · 210`) displayed identically on both Android and MacBook screens.
  - Per-file **SHA-256 cryptographic integrity verification** upon arrival.
- **Live Encrypted Photo Previews & Trusted Auto-Accept**:
  - Incoming AirDrop prompts display encrypted WebP thumbnails of incoming photos *before* you click Accept—just like native Apple AirDrop.
  - Mark your own Android phone / MacBook as a **Trusted Device** so future drops save automatically without extra taps.
- **Universal Encrypted Clipboard**:
  - Beam 2FA OTPs, URLs, Wi-Fi passwords, or code snippets between Android and MacBook in `< 15 ms` with automatic payload classification (`OTP`, `URL`, `CODE`, `TEXT`).
  - Press **`Cmd + V`** anywhere on AirBridge on your MacBook to immediately stage/beam a clipboard screenshot!
- **Native Android Share Sheet Integration (Zero APK Sideloading)**:
  - Installable Progressive Web App (`manifest.webmanifest` + Service Worker `sw.js`) implementing **Web Share Target Level 2** (`POST /_share-target`). Tap **Share → AirBridge** straight from Google Photos, Gallery, or Files on Android.
- **macOS Terminal CLI & Direct `~/Downloads` Daemon**:
  - Run `npx airbridge daemon --reveal` on your MacBook for local mDNS (`_airbridge._tcp.local`) discovery, automatic direct saving into `~/Downloads/AirBridge`, macOS Notification Center alerts, and Finder reveal.
  - Run `npx airbridge send ./Demo-4K.mp4` to print an instant terminal QR code with resumable HTTP `Range` streaming.

---

## 🏗️ System Architecture & Wire Protocol

```text
┌─────────────────────────────┐                  ┌─────────────────────────────┐
│   Android 15 (Chrome/PWA)   │                  │   MacBook (Browser/Daemon)  │
│  • Share Sheet Interceptor  │                  │  • Drag & Drop Folders      │
│  • ECDH P-256 + AES-256-GCM │                  │  • Cmd+V Screenshot Beam    │
│  • 6-Digit SAS Verification │                  │  • ~/Downloads Direct Save  │
└──────┬───────────────┬──────┘                  └──────┬───────────────┬──────┘
       │               │                                │               │
       │               │  1. Direct LAN UDP/SCTP P2P    │               │
       │               │◄══════ RTCDataChannel ════════►│               │
       │               │   (64KB AES-256-GCM Frames)    │               │
       │                                                                │
       │        2. Signaling + Blind Binary E2EE Relay Fallback         │
       └──────────────►┌────────────────────────────────┐◄──────────────┘
                       │     AirBridge Warp Server      │
                       │  • Nearby Subnet/IP Grouping   │
                       │  • 6-Char Cross-Net Pair Rooms │
                       │  • Zero-Copy 0x02 Binary Relay │
                       │  • mDNS (_airbridge._tcp.local)│
                       └────────────────────────────────┘
```

### Binary Chunk Wire Format (`src/shared/protocol.ts`)

| Offset | Length | Field | Description |
| :--- | :--- | :--- | :--- |
| `0` | `1 B` | `frameType` | `0x01` = Encrypted File Chunk |
| `1..17` | `16 B` | `transferId` | 16-byte ASCII hex transfer identifier |
| `17..21` | `4 B` | `fileIndex` | `Uint32BE` file index within multi-file batch |
| `21..25` | `4 B` | `chunkIndex` | `Uint32BE` 64 KB chunk sequence number |
| `25..37` | `12 B` | `iv` | 96-bit `AES-256-GCM` unique nonce |
| `37..N` | `Var` | `ciphertext` | Encrypted chunk payload + 128-bit GCM auth tag |

When routed through the WebSocket relay across strict NATs (`0x02`), a 33-byte header (`[0x02][targetPeerId:16][sourcePeerId:16]`) wraps the inner `0x01` frame. The server stamps `sourcePeerId` from the authenticated socket and forwards raw `Uint8Array` buffers without JSON serialization or Base64 overhead.

---

## 🚀 Quick Start

### 1. Run Development Server
```bash
git clone https://github.com/DigantaDey/android-to-mac.git
cd android-to-mac
npm install
npm run dev
```
Open `http://localhost:3000` on your MacBook and scan the on-screen QR code with your Android camera (auto-detects your MacBook's Wi-Fi LAN IP!).

### 2. Run MacBook Local Daemon (Auto-Save to `~/Downloads/AirBridge`)
```bash
node ./bin/airbridge.mjs daemon --reveal
```

### 3. Instant CLI File Beam from macOS Terminal
```bash
node ./bin/airbridge.mjs send ./Presentation.pdf ./Footage-4K.mp4
```

### 4. Production Build & Test Suite
```bash
npm run typecheck
npm test
npm run build
npm start
```

---

## 📱 Adding AirBridge to Android's Native Share Sheet

1. Open your AirBridge URL in **Chrome** on your Android phone.
2. Tap **Menu (`⋮`) → Install app** (or **Add to Home screen**).
3. Open **Google Photos** or **Files by Google**, select any uncompressed photos/videos, tap **Share**, and tap **AirBridge**!

---

## 📄 License

Open-source under the [MIT License](./LICENSE).
