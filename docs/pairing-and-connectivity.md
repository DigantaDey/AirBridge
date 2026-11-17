# Pairing and connectivity

How a phone and a computer find each other, prove they belong together, and
stay connected when there is no shared network. Plus how crashes and
updates are handled without risking every install at once.

| Piece | What it gives you | Where |
| :--- | :--- | :--- |
| [Secure code exchange](#secure-code-exchange-spake2) | The pairing code is never sent, not even hashed. A wrong guess teaches an attacker nothing. | `src/shared/spake2.ts`, `src/shared/pairingProof.ts`, `Spake2.kt`, `PairingProof.kt` |
| [Relay fallback](#relay-fallback) | Works when the phone can't reach the computer at all (different networks, client isolation, CGNAT). The relay only ever sees ciphertext. | `src/server/relay.ts`, `RelayRoute` in `Engine.kt` |
| [Hotspot handoff](#hotspot-handoff) | One tap on the phone. The computer joins the phone's hotspot for a direct link, even with no network and no session at all (Bluetooth). | `src/server/handoff.ts`, `wifiJoin.ts`, `Handoff.kt`, `HotspotHandoff.kt`, `mac_app.swift` |
| [Crash reports](#crash-reports) | Crashes are recorded locally, scrubbed, and sent only when you click. | `src/server/crashReports.ts` |
| [Staged rollouts](#staged-rollouts) | Each update reaches 10% → 50% → 100% of computers over 3 days. It can be paused, accelerated or forced. | `src/server/rollout.ts`, `scripts/rollout.mjs` |

Each protocol exists in TypeScript and Kotlin. Both sides are checked
against the same fixed vectors (`android/engine/src/test/resources/vectors.json`, 140 checks), so a
change on one side that breaks the other fails CI. The live interop test
(`scripts/test-native-interop.ts`) drives the real Kotlin engine against the
real server for every flow below.

---

## Secure code exchange (SPAKE2)

The 6-character pairing code is a room secret: whoever proves they know it
joins the computer's room. Before, the phone sent it to the server in its
hello. Now neither side ever transmits it.

**Protocol.** SPAKE2 (RFC 9382) on P-256 with SHA-256, HKDF and HMAC.

1. The phone (A) sends `hello {pake: {v: 1, nameplate, share}}`.
   - `nameplate` is one byte of `SHA-256("airbridge-nameplate-v1:" + code)`. It only picks which room code to try, so it reveals ~8 bits and no more.
   - `share = X·G + w·M`, where `w = HKDF(code)` reduced mod n.
2. The computer (B) replies `pake-challenge {share: Y·G + w·N}`. Both derive `Ke ‖ Ka = SHA-256(transcript)`.
3. The phone sends `pake-confirm` (an HMAC under `Ka`). The computer checks it and only then admits the phone.
   - The welcome carries `hubProof`, which binds the peer id, the code and the computer's TLS pin under a vouch key derived from `Ke`. The phone checks it, so a fake server can't claim success.
4. Identities are bound into the transcript:
   - joiner: `airbridge-joiner-v1\n{session key}\n{long-term identity key}`
   - hub: `airbridge-hub-v1`

   A relay or impostor can't splice sessions.

**What it stops.**

- *Passive eavesdroppers* (including on a hotspot, or anyone reading TLS-terminated logs): the transcript contains no code-derived value that can be tested offline.
- *Active guessing*: each attempt tests one code. Attempts are rate-limited to 8 per address and 60 overall per 5 minutes; after 20 wrong codes the computer logs a warning to rotate the code. An unknown nameplate still gets a well-formed decoy challenge, so it isn't an oracle.
- *A phone that doesn't know the code*: never admitted. Clients that only know the legacy plaintext hello still work and are labelled `admission: 'code'`. Only `pake` sessions receive the relay route and handoff keys.

Device verification builds on it. The code-holding computer vouches for each
admitted device's keys (`peerVouch`), so paired devices show
**Verified** without comparing six digits by hand. The SAS stays available.

---

## Relay fallback

When no direct path exists, the phone dials a relay that splices it to the
computer. TLS runs **end to end through the relay** and is pinned to the
computer's identity, which the code-holding computer vouched for in the
welcome. The relay forwards bytes it cannot read or alter.

```
computer ──► relay:47391   "AB-RELAY/1 LISTEN <hostKey>"  (heartbeat every 25 s)
phone    ──► relay:47391   "AB-RELAY/1 DIAL <SHA-256(room-v1:hostKey)>"
relay    ──► both          "GO", then raw bytes in both directions
```

- The phone races the relay 2.5 s after starting direct attempts; whichever completes the TLS handshake with the pinned identity wins. It switches back to direct automatically.
- `ERR NO_HOST | BUSY | PROTOCOL` replies are classified in the app's connection help.
- The relay limits connections per address and in total, and drops sockets that don't send a valid header in time.

**Run a relay** (any always-on box with a public port):

```bash
airbridge relay --listen 0.0.0.0:47391
```

**Point a computer at it** (saved for the login item):

```bash
airbridge --relay relay.example.com:47391     # or AIRBRIDGE_RELAY=host:port
airbridge --relay off                         # remove it
```

---

## Hotspot handoff

Phone and computer share no usable network: a café with client isolation,
different networks, or no Wi-Fi at all. On the phone, tap **Use this
phone's hotspot**. The computer asks you, joins the phone's hotspot itself,
and the session moves to that direct link.

### Flow

1. **Pairing (once).** In a code-authenticated welcome the computer gives
   the phone `handoff = {key, beacon, proof}`:
   - `key`: a static P-256 handoff key (`~/.airbridge/handoff-key.json`, mode 0600).
   - `beacon`: a 16-byte Bluetooth tag secret.
   - `proof`: `HMAC(vouchKey, "handoff\n{peerId}\n{key}\n{beacon}")`.

   The phone keeps them only if the proof verifies. Neither the relay nor a
   network attacker can substitute their own key.
2. **Phone.** It starts an Android *local-only hotspot*: random name and
   password, WPA2/WPA3, no internet sharing. It seals an offer to `key`:
   - `0x01 ‖ ephemeral P-256 key ‖ IV ‖ AES-256-GCM(JSON)`, with key `HKDF(ECDH, salt "airbridge-handoff-v1", info epk ‖ key)`.
   - The JSON holds the name, password, security, reverse port, device name, timestamp and nonce, plus an HMAC under a key derived from the pairing code. Only someone holding the room code can produce a valid offer.
   - The envelope is under 400 bytes, so it fits one Bluetooth attribute.
3. **Delivery**, in order of preference:
   - *Over the session* (Wi-Fi or relay): `handoff-offer` is rate-limited to 6 per minute and only accepted from code-authenticated devices.
   - *Over Bluetooth LE*, when there's no session or no reply within 6 s. Phones without concurrent hotspot + Wi-Fi drop their own Wi-Fi when the hotspot starts. The phone scans for the AirBridge GATT service and reads the **tag**, `0x01 ‖ HMAC(beacon, window)[:8]`, which rotates every 15 minutes. It writes only to a computer whose tag proves the paired secret, then follows the status characteristic.

   | GATT | UUID | |
   | :--- | :--- | :--- |
   | service | `c288bc57-57c6-44cc-9137-a59f85d3bf6f` | advertised, no device name |
   | tag | `…bc58…` | read |
   | offer | `…bc59…` | write (long writes reassembled) |
   | status | `…bc5a…` | read + notify, `{"s": state, "r": reason}` |
4. **Computer.** It opens and checks the offer:
   - must be addressed to this computer, MAC-valid, and within ±10 minutes;
   - nonce not seen before (replays are refused);
   - name 1–32 bytes, password 8–63 printable characters or 64 hex. Open networks are refused.

   Then it applies the policy:
   - **Ask first** (default): the web UI shows *Join / Always for paired phones / Not now*. The macOS app shows the same choices as notification buttons. Unanswered requests expire after 2 minutes.
   - **Join automatically**
   - **Never join**
5. **Join.**
   - macOS: `networksetup -setairportnetwork`.
   - Linux: a dedicated NetworkManager profile, `AirBridge handoff`.
   - Windows: a temporary `netsh wlan` profile that is never auto-connected and deleted immediately.

   AirBridge retries while the new hotspot isn't visible yet and waits for an
   IPv4 address. The computer then dials the phone's reverse listener on
   the hotspot gateway, so the session goes direct without any address
   discovery. The password never appears in logs, errors or the UI.
6. **End.** Stop the hotspot on the phone, or press *Leave hotspot* on the
   computer. The computer rejoins its previous network.

### Platform notes

- **Android 8+.** Needs *Nearby devices* (Android 13+) or Location (8–12;
  Android requires Location to be on to start a hotspot), plus Bluetooth scan/connect
  (12+). Neither permission is used to derive location (`neverForLocation`).
- **macOS app.**
  - The Bluetooth path runs in the menu-bar app, which acts as a CoreBluetooth peripheral that only shuttles opaque sealed bytes to the service.
  - It starts Bluetooth only once a phone actually holds this computer's keys, so there's no Bluetooth prompt before the feature can be used.
  - Every bundle carries `NSBluetoothAlwaysUsageDescription`. A bundle without it skips Bluetooth rather than being terminated by macOS.
- **Linux / Windows.** The session path works. The Bluetooth path needs the macOS app, so without a session, join the hotspot by hand; the phone shows its name.
- **Turn it off:** `AIRBRIDGE_HANDOFF=0`, or choose *Phone hotspots → Never join*.

### What an attacker can and can't do

| Attacker | Outcome |
| :--- | :--- |
| Nearby device advertising the AirBridge service | Fails the tag check; the phone never writes to it. Even if it did, the envelope is sealed to the real computer's key. |
| Bluetooth sniffer | Sees an encrypted envelope and status JSON (no password). |
| Relay or network MITM | Can't substitute the handoff key (welcome proof), can't read offers, can't replay them (nonce cache, timestamp). |
| Someone without the pairing code | Can't create an offer the computer accepts (inner MAC). |
| Tracking by advertisement | Only the fixed service UUID is advertised, not a name. The tag requires a connection and changes every 15 min. |

---

## Crash reports

- **Captured:**
  - uncaught exceptions;
  - unhandled rejections;
  - abnormal exits (`kill -9`, OOM, power loss), detected on the next start from a run marker.
- **Stored** under `~/.airbridge/crashes`: mode 0600, at most 20 reports, kept 30 days, duplicates within 10 minutes merged.
- **Scrubbed before storing:** IP and MAC addresses, e-mail addresses, home paths, user and host names, pairing codes, keys and tokens are removed. Stack frames keep only file names.
- **Sent only on click.** The web UI shows *Review report* (exactly what would be sent), *Send* and *Dismiss*.
  - With a DSN set (`AIRBRIDGE_CRASH_DSN` or `~/.airbridge/crash-dsn`), the report goes as a Sentry envelope.
  - Otherwise AirBridge opens a prefilled GitHub issue for you to review and submit.

## Staged rollouts

Each release carries a `rollout.json` asset:

```json
{ "version": "0.0.6", "publishedAt": "…", "stages": [{"afterHours": 0, "percent": 10}, {"afterHours": 24, "percent": 50}, {"afterHours": 72, "percent": 100}] }
```

- **Who gets it:** each install is eligible when `uint32(SHA-256("airbridge-rollout-v1:{installId}:{version}")) mod 10000 < percent × 100`. The draw is stable per install and independent per version, so the same computers aren't always first.
- **Who doesn't:** background checks outside the current stage report *rolling out* and wait. **Check for updates** and *Get it now* always bypass the rollout.
- **After a rollback:** a version that was rolled back after failed starts is not retried until a newer version ships, or the operator forces it.
- **Missing file:** a release with no `rollout.json` is offered to everyone, as before.

Operator controls (via `gh`; they take effect at each computer's next 6-hourly check):

```bash
node scripts/rollout.mjs status v0.0.6
node scripts/rollout.mjs halt v0.0.6          # stop offering it
node scripts/rollout.mjs resume v0.0.6
node scripts/rollout.mjs set v0.0.6 100       # everyone now
node scripts/rollout.mjs require v0.0.6 0.0.6 # force it on older installs (security fix)
```

The release workflow writes `rollout.json` automatically. Set the repository variable
`AIRBRIDGE_ROLLOUT_STAGES` (e.g. `0:5,12:25,48:100`) to change the default
schedule.

---

## Testing

| Layer | Command |
| :--- | :--- |
| TS unit + integration (PAKE, relay, handoff, crash, rollout, UI) | `npx vitest run` |
| Cross-language vectors + Kotlin unit suites | `bash android/scripts/verify.sh` |
| Real Kotlin engine ↔ real server (PAKE, relay, handoff over the relayed session, replay refusal, end) | `KOTLIN_ENGINE_CLASSPATH=… npx tsx scripts/test-native-interop.ts` |
| Android app compile + macOS Swift shell | CI (`android`, `macos-app` jobs) |

CI can't cover these, so test them by hand on real devices:

- the Android local-only hotspot;
- Bluetooth GATT between a phone and a Mac;
- the OS Wi-Fi join on each desktop OS.

**Manual handoff check** (one phone, one Mac with the AirBridge app):

1. Pair with the code or QR.
2. Turn off the Mac's Wi-Fi network (keep Wi-Fi on) and disconnect the phone.
3. On the phone, tap **Start hotspot**. The Mac shows *“Pixel offers its hotspot”*.
4. Choose **Join**. Within ~15 s the Mac is on the hotspot and the phone reads *Direct link*. Send a file to confirm.
5. Tap **Stop hotspot**. The Mac rejoins its previous network.

Repeat with the phone first connected through the relay (the session path),
and with Bluetooth off on the phone (the phone shows the hotspot name for a
manual join).
