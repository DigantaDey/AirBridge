# AirBridge

AirBridge moves files and clipboard text between an Android phone and a Mac over your
local network. The two devices derive their own keys with ECDH P-256 and encrypt file
data and control messages with AES-256-GCM before anything leaves the browser. Between
the two devices, the Node service only forwards ciphertext.

It is not a native app. You start the service on the Mac, open it at
`http://localhost:3000`, and open the same address from the phone. There is no `.dmg`,
no `.apk`, and nothing here speaks Apple's AirDrop protocol, despite the name and the
look of the UI.

It exists because getting a file from an Android phone to a Mac usually means a cloud
account, a cable, or a chat app that recompresses your photos. AirBridge keeps both
devices on the local network and gives them an encrypted channel directly.

This is a working prototype. Moving files around a LAN works; installing it and
forgetting about it does not, mostly because of the one-time certificate step on the
phone (explained below) that no browser-based version can avoid.

## What it does

### Files

Drag files onto the drop area, or use the picker. Up to 100 files per transfer, mixed
types and sizes; files stay staged until you pick a target and hit send.

The receiver gets an offer showing the sender, file list, total size, a six-digit
verification code, and WebP thumbnails for image files under 25 MB. Decline or accept.
Ticking *Auto-accept future drops from <device>* marks the sender as trusted so their
next offers skip the prompt.

During the transfer you get progress, a smoothed speed reading and an ETA. Either side
can cancel. Every file is hashed with SHA-256 as it streams and the receiver compares
that against the hash the sender declared, so a corrupted file shows up as unverified
rather than passing quietly.

Transfer history (last 50) lives in the browser's local storage and is reconciled
between paired devices over the encrypted channel when they reconnect, so a reload on
one side doesn't lose the other side's record.

### Received files

When the service is running on the machine receiving the file, each decrypted chunk is
streamed straight to disk as it arrives — the browser never holds the whole file in
memory, and there is no per-file size cap on the host. A macOS notification is posted
once the file is complete and verified. The default folder is `~/Downloads/AirBridge`;
change it in **Settings → Received files folder**, with `--dir` on the CLI, or with
`AIRBRIDGE_DOWNLOAD_DIR`. The choice is remembered per machine in `~/.airbridge/settings.json`.

Chunks are written to a `.part` file at their declared offset and a small manifest is
persisted beside it, so a transfer that is interrupted (tab closed, network dropped) can
resume from the highest contiguous chunk already on disk instead of starting over. A
re-delivered chunk is a no-op, and a transfer that is cancelled or declines leaves its
partial behind under `~/Downloads/AirBridge/.airbridge-partial/` rather than a corrupt
file.

The folder icon in the header (and next to saved items in **Recent transfers**) opens
that folder in Finder, Explorer, or your Linux file manager. Folder browsing for the
picker, creating a folder, and opening one are all loopback-only, so a phone can't move
your save location or pop windows open on your desktop.

On a phone (or any browser without the local daemon), received chunks are streamed
straight to a file in a directory you pick via the browser's File System Access API —
the same incremental, memory-bounded write, just pointed at the phone's storage instead
of the host's Downloads folder. The file is hash-verified as it closes. If the browser
doesn't support that API, or you cancel the picker, it falls back to reassembling in
browser memory and downloading; multi-file transfers in that fallback are packed into a
zip by a small built-in ZIP writer and downloaded as one archive.

### Clipboard

Text and images, both directions. Text is capped at 256,000 characters and image beams
at roughly 5 MB.

*Auto-beam copied text* is on by default. On the machine running the server it watches
the OS clipboard in the background through `pbpaste`/`pbcopy` on macOS, PowerShell's
`Get-Clipboard`/`Set-Clipboard` on Windows, or `wl-paste`/`xclip`/`xsel` on Linux, so
copying on the Mac beams without switching back to the tab. On Android it hooks the
page's copy event, the Android share sheet (when installed as a PWA), and, if the
browser grants clipboard read, a check when you return to the tab.

Incoming beams are written to the host OS clipboard on the Mac and to the browser
clipboard elsewhere, with a **Copy** toast for browsers that refuse the write. The last
50 beams stay in the Clipboard panel with copy, *Open URL* for links, and *Save* for
images. Beamed text is labelled as a URL, OTP, code or plain text, which drives the
badge and the *Open URL* button for links.

Both directions can be turned off per device: *Auto-beam copied text* and *Receive
clipboard beams*.

### Pairing and discovery

There are two ways to connect:

- **Nearby.** With visibility set to *Nearby* on both devices, each appears in the
  other's list. The server groups clients by their socket address on the same /24; it
  deliberately ignores `X-Forwarded-For`, so a client can't claim someone else's subnet.
- **Pair code.** Across networks, put the same six characters on both sides, or scan
  the QR code, which is just `https://<host>/?pair=ABC-DEF`. Codes use a 32-character
  alphabet with no `0`, `1`, `I`, or `O`; that's 30 bits of entropy, which is why join
  attempts are rate limited per connection rather than trusted.

Visibility is *Nearby*, *Paired only*, or *Hidden*. The pairing code is saved in local
storage, so two devices that have paired tend to find each other again after a reload.

### The rest of the UI

Install it as a PWA and Android registers AirBridge as a share target, so files and
text from other apps can be shared into it. The **Demo phone** button opens a second,
simulated client inside the same browser so you can try the flow without a phone; it is
labelled as a simulation and does not prove anything about real networking. There are
also send/receive chimes (mutable), a dark theme, and a renameable device name.

## What you need

- Node.js 20 or newer and npm on the machine that serves the app. It is built and
  tested on Node 22.
- Both devices on the same Wi-Fi, or both able to reach the same server if they're not.
  Guest networks and networks with client isolation will usually block discovery.
- A phone browser with WebCrypto: any current Chrome, Firefox, or Chromium-based
  browser. The address has to be `https://`, not `http://192.168…`.
- Android is the phone target this was built against. macOS is the main desktop target;
  the server runs on Windows and Linux too, but only macOS gets notifications, and the
  rest of that path is less exercised.

## Running from source

```sh
git clone https://github.com/DigantaDey/AirBridge.git
cd AirBridge
npm ci
npm run dev
```

Open `http://localhost:3000` on the Mac. The terminal prints the address to use on the
phone, the location of the generated certificate authority, and its SHA-256
fingerprint:

```
⚡ AirBridge Warp Server listening on port 3000
💻 On this Mac:        http://localhost:3000  (secure as-is)
📱 On your phone:      https://192.168.1.20:3000
🔐 HTTPS uses a locally generated certificate authority (/Users/you/.airbridge/tls).
   CA SHA-256 fingerprint: C0:A5:18:…:B4:54
   First time on a phone: install the CA from http://192.168.1.20:3000/airbridge-ca.crt
```

`npm run dev` runs the TypeScript server directly through `tsx` and mounts Vite in
middleware mode, so the client hot-reloads. For a production-style run:

```sh
npm run build   # dist/client + dist/server
npm start       # serves the built app
```

## The HTTPS step on the phone

This is the part everyone trips over, and it isn't avoidable in a browser.

AirBridge's encryption runs on the Web Crypto API, and browsers only expose
`crypto.subtle` in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
HTTPS, or `http://localhost`. A plain `http://192.168.1.20:3000` page is not one, so key
generation fails and the phone reports that a secure connection is required. No public
CA will issue a certificate for a private LAN address either.

So the server creates its own small certificate authority on first run:

1. Start AirBridge on the Mac and note the fingerprint in the terminal.
2. On the phone, open `http://<mac-ip>:3000/airbridge-ca.crt`. That single download
   stays on HTTP on purpose — the phone can't fetch a CA over a connection that
   already needs that CA to be trusted.
3. Install it as a **CA certificate** (Android: Settings → Security & privacy → More
   security settings → Install a certificate; wording varies by vendor). Compare the
   fingerprint Android shows with the one on the Mac before confirming.
4. Open `https://<mac-ip>:3000`. It loads with a lock and pairing works.

Repeat that only for new phones. The leaf certificate covers `localhost` and the
current LAN addresses, and if the Mac's IP changes the leaf is re-issued under the
**same** CA, so already-trusting devices don't see a new warning.

Details worth knowing:

- One port serves both HTTP and HTTPS. Plain HTTP from another device is redirected
  (308) to the same URL over HTTPS, so an old bookmark still works. Loopback stays on
  HTTP because `http://localhost` is already a secure context.
- The CA lives in `~/.airbridge/tls` (`AIRBRIDGE_TLS_DIR` moves it). Delete the
  directory and remove the certificate from the phone to revoke it.
- Prefer your own certificate? Point `AIRBRIDGE_TLS_CERT` and `AIRBRIDGE_TLS_KEY` at a
  PEM pair, or pass `--tls-cert`/`--tls-key`. With mkcert:
  `mkcert -install && mkcert localhost 127.0.0.1 ::1 $(ipconfig getifaddr en0)`, then
  install mkcert's `rootCA.pem` on the phone.
- `GET /api/health` reports `https`, `tlsSource` and `caFingerprintSha256`, which is the
  quick way to see what the server is actually serving.
- If the phone shows a certificate warning instead of the app, check the fingerprint in
  the browser's certificate details against the Mac's output before continuing. Don't
  train yourself to click through that screen.

HTTPS gives the page a secure context. It is separate from the end-to-end encryption
between the two devices, which happens on top of it.

## Using it

Open AirBridge on both devices. If they're on the same network and both set to
*Nearby*, each should appear in the other's list within a second or two. Otherwise scan
the QR from the other device, or type the same six-character code into both.

Before sending a file, compare the six-digit code under the device name on both
screens. It's derived from both public keys, so matching codes mean there's no
machine-in-the-middle. Then select a target, stage files, and send.

For clipboard, hit **Clipboard** on a device card to send text or an image to that
device, or just copy something and let auto-beam do it.

## Command line

The CLI is `bin/airbridge.mjs`. It isn't published to npm yet, so run it from the
checkout rather than through `npx`:

```sh
node bin/airbridge.mjs                       # daemon mode
node bin/airbridge.mjs daemon --dir ~/Inbox --reveal
node bin/airbridge.mjs send ./Slides.pdf ~/Movies/clip.mp4
```

`npm run cli -- daemon` does the same thing if you prefer npm scripts.

Daemon mode starts the server, enables direct-to-disk saving, and prints a QR code for
the phone. `--reveal` also pops each received file open in Finder.

`send` is a one-shot beam: it starts a throwaway server on a random port, serves the
listed files, and prints a QR code you scan with the Android camera. The link contains a
256-bit token and expires after 15 minutes. Downloads support HTTP range requests, so a
client that retries can pick up where it stopped instead of starting over.

One rough edge: the QR points straight at the file when you send a single file, but a
multi-file send points at a JSON manifest with per-file URLs rather than a download
page. It works, it just isn't a nice experience yet.

Because these links are plain token-gated downloads, they stay on HTTP even when TLS is
enabled. No browser crypto is involved, and a certificate warning would only get in the
way.

| Flag | Meaning |
| --- | --- |
| `-p`, `--port <n>` | Port to listen on (default 3000, or `PORT`) |
| `-d`, `--dir <path>` | Received-files folder (default `~/Downloads/AirBridge`) |
| `--reveal` | Reveal received files in Finder |
| `--http` | Plain HTTP only (not recommended; phones will block WebCrypto) |
| `--tls-cert <pem>`, `--tls-key <pem>` | Use your own certificate instead of the generated CA |
| `--tls-dir <path>` | Where the generated CA lives (default `~/.airbridge/tls`) |
| `-h`, `--help` | Help |

The in-app "How it works" panel still says `npx airbridge …`; that only works once the
package is on npm.

## Configuration

Environment variables, all optional:

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `AIRBRIDGE_HTTPS` | on | `0` disables TLS (only sensible behind a TLS-terminating proxy) |
| `AIRBRIDGE_TLS_CERT`, `AIRBRIDGE_TLS_KEY` | — | PEM certificate and key (both required); turns HTTPS on and skips the generated CA |
| `AIRBRIDGE_TLS_DIR` | `~/.airbridge/tls` | Where the generated CA and leaf are stored |
| `AIRBRIDGE_DOWNLOAD_DIR` | `~/Downloads/AirBridge` | Received-files folder |
| `AIRBRIDGE_LOCAL_DAEMON` | on outside tests | `0` disables direct-to-disk saving |
| `AIRBRIDGE_CLIPBOARD_WATCH` | on outside tests | `0` disables the host OS clipboard bridge |
| `NODE_ENV` | unset | `production` serves the built client from `dist/client` |

The server's own endpoints, for debugging or scripting: `GET /api/health`,
`GET /api/received-folder` and `PUT /api/received-folder`,
`POST /api/received-folder/open`, `GET /api/fs/list`, `POST /api/fs/mkdir`,
`POST /api/daemon/save`, `GET /api/beam/:token[/file/:index]`, and the `/ws` signaling
socket. The folder and filesystem routes answer only on loopback; the daemon
routes answer from this machine (loopback or one of its own interfaces, so the host
browser works over the LAN IP too). From anywhere else they return 403.

## If something's wrong

- **"Secure connection required" / key generation fails.** The phone is on HTTP. Use
  the `https://` address and install the CA as described above.
- **No devices in the list.** Both sides need the same server and both need visibility
  set to *Nearby*, or a shared pair code. Guest Wi-Fi and client-isolated networks block
  this; use a phone hotspot if you're stuck.
- **Transfers stall on a large file.** On the machine running the server, chunks stream
  to disk as they arrive, so size is bounded by disk, not RAM. A phone does the same via
  the File System Access API. Only when that API is unavailable does the browser fall back
  to reassembling the file in memory first — try smaller batches, or send from the CLI
  where no per-chunk browser buffer is involved.
- **Both pages still have to stay open.** The host daemon writes chunks to disk in the
  background as they arrive and a re-established transfer resumes from its partial, but
  the receiving browser must stay connected to decrypt and forward chunks. A backgrounded
  mobile tab can have its socket throttled, and there is no cross-reload recovery of an
  in-flight offer.

## How transfers actually work

Signaling and relay run over a WebSocket at `/ws`. Control messages are JSON with
AES-GCM–encrypted payloads; the only unencrypted control messages the server accepts or
forwards are `ping` and `pong`. File data travels in two binary frame types:

- `0x01` — an encrypted chunk: frame type, 16-character transfer ID, file index, chunk
  index, 12-byte IV, ciphertext. That's a 37-byte header.
- `0x02` — a routed relay frame: recipient peer ID, sender peer ID, then the inner
  frame. The server overwrites the sender ID in place and forwards it; it can't read
  the chunk inside.

A WebRTC data channel is attempted when both browsers support it, and chunks use it
once it's open. Otherwise they go through the relay. Both paths carry the same
encrypted frames, and a chunk that exceeds the data channel's negotiated maximum
message size is relayed instead of tearing the channel down. ICE uses
`stun:stun.l.google.com:19302`; on a LAN the host candidates usually suffice, but the
STUN request is still made.

Tuning, for anyone reading the engine:

- 256 KiB chunks by default. The manifest declares its chunk size (16 KiB to 1 MiB
  accepted), so 64 KiB peers from older builds still work.
- Up to 8 reads and AES-GCM encrypts in flight ahead of the socket, while the network
  write loop drains in order.
- The sender may run 256 chunks ahead of ACKs. The receiver ACKs every 32 chunks plus
  the last chunk of each file, fire-and-forget.
- Socket backpressure is applied above 16 MiB buffered and released at 4 MiB.
- Manifests are validated before acceptance: 100 files maximum, `totalChunks` must
  match `size` and `chunkSize`, and a transfer is capped at 262,144 chunks (64 GiB at
  256 KiB).
- On loopback, the test suite moves a 16 MiB file end to end, hash included, in about
  0.4 s on a development machine. That number says more about the pipeline than about
  your Wi-Fi; the link is the limit in practice.

Received files are only decrypted after you accept the offer. Chunks for a transfer
that hasn't been accepted are neither decrypted nor stored.

## Security model

The server sees device names, public keys and ciphertext. It does not have the session
keys, so it can't read files or clipboard text, and it refuses to relay plaintext
control payloads other than ping/pong, so a hostile peer can't forge an accept, a cancel,
or inject clipboard text without the session key.

Transfers are peer-bound on both ends, so guessing a transfer ID gets you nothing. File
manifests are validated, pair-code joins are rate limited, connection counts are capped
(128 total, 32 per network), and CLI beam tokens are 256-bit with a 15-minute expiry and
per-address throttling of failed lookups.

There is one deliberate plaintext hop. When the Mac's own browser receives a text beam
and the host clipboard bridge is on, it asks the local service over loopback to put that
text on the system clipboard. The text is already decrypted at that point; it stays on
that machine and is never sent to a remote peer. Image beams skip that path.

Identity keys are generated fresh per page load. The six-digit code is what binds a
transfer to the device you think you're talking to, which is why the UI puts it next to
the device name and in the accept dialog. Trust is stored against the peer's public
key, so because keys rotate on reload you will often have to trust the same device
again after a restart; the trust list can also collect stale keys. That's a known rough
edge, not a security feature.

[SECURITY.md](SECURITY.md) has the audit notes, the list of issues that were fixed
(plaintext control injection, pre-consent chunk storage, forged `X-Forwarded-For`,
unvalidated profiles, and so on), and the residual risks.

## What's missing

These are real gaps, not TODO padding:

- **No installable packages.** No `.dmg`, `.app`, `.apk`, or signed release. Building
  those needs native app targets, signing identities and an update path that don't
  exist in this repository yet.
- **The service is a separate process.** Pairing goes through it; it is not native
  local discovery. The mDNS packet the server sends (`_airbridge._tcp.local`) is a
  Bonjour announcement only — browsers can't browse mDNS, so the app doesn't use it for
  discovery.
- **Both devices must reach the same server.** The relay can carry a transfer when a
  direct WebRTC path fails, but AirBridge doesn't ship a hosted relay or tunnel, so
  "across networks" means you've made the server reachable somehow.
- **The phone certificate install is manual.** That's a browser/OS trust requirement no
  web app can automate away.
- **The phone's disk path depends on the browser.** The host streams received chunks
  straight to disk, and a phone does the same through the File System Access API — but
  that API is Chromium-only and requires you to pick a directory once per transfer. On a
  browser without it (or if you cancel the picker), the phone falls back to reassembling
  the file in browser memory before downloading, so a many-gigabyte file sent *to* such
  a browser can still exhaust it. Sending *from* a phone is unaffected.
- **A hash mismatch doesn't block the write.** The per-file hash is checked and shown as
  a shield icon in the transfer list, but the file is still handed to the save path. If
  integrity matters for what you're moving, look for that icon (its tooltip carries the
  hash) rather than assuming a completed transfer was verified.
- **Trust management is thin.** There's a trust toggle on each device card, no list of
  trusted devices with revocation, and, as noted above, trust doesn't survive key
  rotation cleanly.
- **Tests are headless.** They cover the protocol, crypto, TLS bootstrap, CLI, and UI
  behaviour in jsdom, plus in-process transfers through the real relay. No test here
  touches a physical Android phone, an iPhone, or a signed build.
- **Not AirDrop-compatible.** iOS/iPadOS isn't a target: the UI detects it, but
  clipboard writes there rely on a Copy-button fallback when the browser refuses.
- **The macOS LaunchAgent is a template.** `macos/com.airbridge.daemon.plist` hardcodes
  `/usr/local/bin/node` and a relative script path, so fix both before loading it at
  login. `macos/AirBridgeQuickSend.workflow.sh` is the script behind the Finder Quick
  Action ("Beam to Android").

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest: 9 files, 47 tests
npm run build       # vite client + tsc server
```

Layout:

- `src/client` — React UI (`App.tsx`, `components/`) and the transfer engine
  (`engine/warpClient.ts`, `crypto.ts`).
- `src/server` — Express + `ws` server, signaling hub, TLS bootstrap, host clipboard
  bridge, CLI beam sessions, macOS daemon helpers, mDNS announcement.
- `src/shared` — protocol types, frame codecs, pair codes, ZIP writer.
- `bin/airbridge.mjs` — CLI entry point (daemon and one-shot send).
- `tests/` — protocol, crypto, end-to-end relay transfers, TLS/HTTPS, security and
  received-folder behaviour, CLI/daemon, transfer speed, ZIP, and UI tests.
- `public/` — PWA manifest with the share target, service worker, icon.

`npm run build` writes `dist/client` and `dist/server`; those are build outputs, not
installable packages.

## License

MIT. See [LICENSE](LICENSE).

## Project website

The standalone static site lives in `website/`. It is separate from the AirBridge
service and can be published on GitHub Pages. See [website/README.md](website/README.md)
for local preview, Pages deployment, and custom-domain setup.
