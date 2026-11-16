# Pairing over an Android phone hotspot

Scenario: a MacBook joins the Android phone's hotspot and the phone scans the
Mac's QR code. Reported failure:

```
failed to connect to /10.205.95.167 (port 3000) from /192.0.0.2 … after 10000ms   (TCP connect timeout)
… later: "Socket closed"
status bar: LTE
```

## Root cause

The failure happens at **TCP**, before TLS, the WebSocket upgrade or any
pair-code check. The pair code was never involved.

1. **The phone had no route to the QR address.** `192.0.0.2` is Android's
   464XLAT **CLAT** address on an IPv6-only LTE network. The kernel picked it
   as the source address, so the SYN to `10.205.95.167` left over **mobile
   data**, not over the hotspot downlink (`ap0`/`swlan0`/…). The carrier
   drops traffic to RFC 1918 addresses, so the connection timed out.
   Therefore `10.205.95.167` is **not on the phone's hotspot subnet**. It
   belongs to another Mac interface (campus/office Wi-Fi or Ethernet, a dock,
   a VPN). The hotspot-facing address was a different one, e.g.
   `10.42.61.23` on `en7`.
2. **The QR took an arbitrary first address.** `getLanIpv4Addresses()`
   returned addresses in `os.networkInterfaces()` order, with no notion of
   reachability, and `PairingDock` put `lanUrls[0]` in the QR. The filter
   also let many virtual interfaces and unusable ranges through.
3. **The certificate, mDNS and QR could disagree.** TLS SANs were fixed at
   server start, while `lanUrls` (and so the QR) were recomputed live. A Mac
   that joined the hotspot after AirBridge started advertised an address its
   certificate didn't cover (reproduced: `No subject alternative names
   matching IP address 10.42.61.23`). mDNS announced a stale first address.
4. **A rescanned code could stay unused.** `ConnectionService.ensureEngine()`
   kept the running engine when the target URL was unchanged. A rescan of the
   same Mac with a fresh code was left staged, and could be replayed by a
   later restart.
5. **Every failure looked the same.** `ConnectionHelp` mapped everything to
   one "same Wi-Fi" sentence, and the raw `Socket closed` from our own
   reconnect reached the UI.

Not the cause: the `0.0.0.0:3000` bind (it listens on every interface). The
macOS firewall in stealth mode produces the *same* TCP timeout. The only way
to tell it apart is the subnet check, which the new diagnostics now make.

### Evidence (network-namespace simulation, real server, real Kotlin client)

`scripts/sim/hotspot-netns.sh` builds a Mac namespace, a phone namespace
(`ap0` hotspot plus `rmnet0` with CLAT `192.0.0.2` and a cellular default
route), a carrier that drops private destinations, and a campus LAN.
`scripts/sim/run-scenario.sh` runs the real server in the Mac namespace and
the real Android engine in the phone namespace.

| Scenario | Before the fix | After the fix |
|---|---|---|
| `two-nics`: en0 10.205.95.167/22 (campus), en7 10.42.61.23/24 (hotspot) | QR = 10.205.95.167; route source 192.0.0.2; **connect timed out after 10 s** (the reported log) | QR = `10.205.95.167 … &alt=10.42.61.23&ca=…`; phone ranks 10.42.61.23 on-link via ap0; **connected in ≈0.3 s** |
| `hotspot-only`: en0 10.205.95.167/24 on the hotspot | connected | connected |
| `firewall`: like hotspot-only, inbound 3000 dropped | same 10 s timeout, same generic text | `TCP_TIMEOUT`: "…is on this phone's ap0 network but didn't answer. Most likely the computer's firewall…" |
| hotspot joined after start | `SSLHandshakeException` (stale SANs) | leaf re-issued (same CA, so same QR pin) and `network` pushed to clients |

## Update (v0.0.3 field report): the Mac is *only* on the hotspot and it still times out

The root cause above needs the Mac to be on a second network. A later report
shows otherwise: the Mac is on the phone's hotspot **only**, the pairing panel
lists only `10.205.95.167`, and the app stays on "Reconnecting…" with no error.
So `10.205.95.167` is the address the phone's hotspot gave the Mac (Android
picks random hotspot subnets, including in `10.0.0.0/8`), and choosing a
different address can't fix this case. On a stock phone, Android puts its
hotspot subnet in the `local_network` routing table, which an app's ordinary
sockets use, so the phone should reach the Mac directly. That leaves two
explanations, and only a test on the device can tell them apart:

| Where the SYN goes | What it means | How to tell |
|---|---|---|
| Reaches the Mac, gets no answer | **macOS Application Firewall** drops it. Release binaries are ad-hoc signed, so each update is a new app that needs approval again. | Mac: `sudo tcpdump -ni any tcp port 3000` shows SYNs from the phone's hotspot address |
| Never reaches the Mac (leaves via `192.0.0.2`) | The phone routes it over mobile data | Mac: tcpdump shows nothing; the phone's detail line ends in `via 192.0.0.2` |

Changes from this report:

- **The Mac reports its firewall state.** The server reads `socketfilterfw`
  (no root needed) every 15 s and sends it in `welcome`/`network` and
  `/api/health`. The pairing panel then shows a red notice for "Block all
  incoming connections" or a blocked AirBridge, or an amber notice when this
  build hasn't been approved yet. Both include the exact
  `socketfilterfw --add … --unblockapp …` command.
- **The app no longer hides failures.**
  - A failed attempt now shows its raw per-address result, for example
    `10.205.95.167:3000 tcp_timeout via 192.0.0.2`. This shows which network
    the phone actually used, so a screenshot is enough to tell the two cases
    apart.
  - While an attempt runs, the card says `Trying <addresses>…`, then
    `Reached <host>, waiting for AirBridge on the computer…`.
  - "Socket closed" counts as *cancelled* only when the app closed the socket
    itself. Other closes are shown.
  - The service's first network callback no longer aborts the first dial.
  - If TCP, TLS and the WebSocket upgrade succeed but `welcome` doesn't arrive
    within 15 s, the app reports `NO_WELCOME`. Before, it waited indefinitely
    on "Reconnecting…".

## The fix

**Desktop**
- `src/server/lanAddresses.ts`: a pure, deterministic IPv4 candidate
  selector.
  - Drops loopback, link-local, CLAT `192.0.0.0/24`, `198.18/15`,
    multicast and `/32` addresses.
  - Drops VPN/tunnel, Docker/VM/bridge and AWDL interfaces.
  - Keeps Wi-Fi, Ethernet and tether interfaces. Public and CGNAT addresses
    are kept but ranked lower.
  - The order doesn't depend on OS interface order.
- **One advertised set** = candidates the live certificate covers. The same
  set feeds `welcome` / `network`, `/api/health`, mDNS (per interface) and
  the QR.
  - The generated leaf is re-issued when addresses change (polled every 3 s).
  - A provided certificate is never re-issued; its uncovered addresses are
    withheld and logged.
- QR format (older scanners read only the host and `pair`):
  `https://<primary>:<port>/?pair=CODE&alt=<other advertised IPs>&ca=<SHA-256 of the served CA>`.
  - When the Mac is on more than one network, PairingDock lists each one and
    lets the user pick the primary, which is the address a phone *browser*
    opens.

**Android**
- `PairingLink` parses `alt` and `ca`.
- `EndpointSelector` ranks candidates on-link first, using the phone's own
  interfaces. `rmnet*`, `v4-*`/CLAT and `tun*` interfaces never count as LAN.
- `WebSocketClient` races the candidates at TCP with a 400 ms stagger. TLS,
  the hostname/IP-SAN check and the upgrade then run on the winner only. An
  unreachable address can't win just because it's first, and no address
  skips certificate checks.
- `PinnedTlsTrust` with the QR pin authenticates the **first** connection
  (no trust-on-first-use) and works for every candidate address. TLS is
  never downgraded.
- `PairingInvitationStore` handles invitation state:
  - A scan replaces the whole previous invitation: code, alternates, pin and
    stale learned endpoints.
  - The staged code is consumed exactly once and wins over the saved code.
  - `engineKey` changes on every rescan, so the service restarts the engine.
  - The addresses the Mac reports are learned for reconnects after an
    address change.
- `ConnectionHelp` gives each failure a kind, a phase and a recovery action.
  The UI shows a title, the guidance and one button:

| Kind | Meaning | Action |
|---|---|---|
| `TCP_TIMEOUT` | No answer. Off-link: wrong network or routed over mobile data. On-link: firewall. | Fix network, then rescan |
| `TCP_REFUSED` | Reached the host, but AirBridge isn't running | Retry |
| `NO_ROUTE` / `DNS` | No path, or the name didn't resolve | Fix network / rescan |
| `TLS_UNTRUSTED` / `TLS_HANDSHAKE` | Invalid certificate, or not HTTPS | Rescan |
| `TLS_HOSTNAME` | Certificate doesn't cover the dialled address (stale) | Rescan |
| `TLS_PIN_MISMATCH` | A different identity than the QR or the saved pin | Forget, then rescan |
| `WS_REJECTED` / `WS_CLOSED` | Upgrade refused / connection closed | Retry / none (auto-retry) |
| `PAIR_CODE_INVALID` / `RATE_LIMITED` | Server `error` frames | Rescan / wait |
| `CANCELLED` | We closed it ourselves (reconnect) | Never shown |

The pair code stays a room secret shared by the host desktop and the devices
that join it. It is not made per-member.

## Reverse connections: working without knowing the phone or computer setup

Every field failure so far was the same thing: **phone → computer TCP never
completes**. The causes differ per machine and are mostly invisible to the
app — the macOS Application Firewall (every ad-hoc-signed update is a "new
app" to it), Windows Defender / endpoint security, VPN clients that block LAN
inbound, or a phone that routes the computer's address over mobile data
(`via 192.0.0.2`). Fixing each one needs the user to find a setting.

Outbound from the computer is almost never filtered, and on a phone hotspot
the phone *is* the computer's default gateway. So AirBridge now connects in
**both directions at once** and keeps whichever works first:

```
phone ──TCP──▶ computer:3000          (as before, all advertised addresses, staggered)
phone ◀──TCP── computer → phone:47390 (computer dials the phone)
          └─ the winning socket then runs the SAME steps:
             phone = TLS client, pinned to the QR / saved CA, IP-SAN check
             → HTTP upgrade /ws → hello with the pair code → welcome
```

Only the TCP direction changes; the security model does not:

* The phone is always the TLS **client** and verifies the computer's
  certificate against the QR pin / saved anchor. It only accepts reverse
  sockets while it has such an anchor (`PinnedTlsTrust.isAnchored()`), uses
  `wss://`, and is not connected. Trust-on-first-use is never offered to a
  host that dials in.
* A host that dials in and fails TLS (another computer, an impostor) is
  refused for 60 s. Only LAN and loopback sources are accepted; at most 4
  queued sockets, each discarded after 8 s.
* The room code is still required (hello → welcome), unchanged.
* On the computer, a socket it dialled out is **never** treated as "this
  machine", even if the address looks local: no host-desktop role, no daemon
  routes (`isReversePeer`). Public addresses and the computer's own addresses
  are never dialled.

Where the computer looks for the phone (`src/server/reverseConnect.ts`),
re-read every 10 s and on any network change:

| Source | Covers | How |
|---|---|---|
| default gateway of each real interface | computer on the phone's hotspot | `netstat -rn` (macOS), `ip route` / `/proc/net/route` (Linux), `route print` (Windows); VPN/VM interfaces skipped |
| `_airbridge-rv._tcp` mDNS | phone and computer on the same Wi-Fi | system responder (`dns-sd` / `avahi-browse`), which is exempt from the firewall rules this works around |
| addresses Android peers connected from | reconnect after an update re-arms the firewall | remembered for 24 h |

Each target is dialled every 2.5 s with exponential backoff (cap 10 s) and
skipped while a phone from that address is connected. The phone races the
inbound socket against its own dials, and keeps waiting 3.5 s for the computer
after its own dials have failed. When neither direction works the diagnosis
says so: `10.205.95.167:3000 tcp_timeout via …; computer→phone: no connection`.

Disable with `AIRBRIDGE_REVERSE_CONNECT=0` on the computer.

**What it still cannot fix:** networks that block client-to-client traffic in
both directions (guest Wi-Fi / AP isolation), or a phone and computer that
are not on any common network. Those show `TCP_TIMEOUT` with both directions
listed.

Evidence (network-namespace simulation, real kernel, real server + engine):

| scenario | before | now |
|---|---|---|
| `firewall` (Mac drops inbound :3000) | `TCP_TIMEOUT` | CONNECTED in 5.1 s, computer dialled the phone (its gateway) |
| `hotspot-only` | connected | connected in 0.4 s (forward wins) |
| `two-nics` | connected via hotspot NIC | connected in 0.4 s via hotspot NIC |
| `firewall` with `AIRBRIDGE_SIM_REVERSE=0` | — | `TCP_TIMEOUT`, detail lists `computer→phone: no connection` |

## Tests

| Requirement | Where |
|---|---|
| LAN selection from mocked interfaces (Wi-Fi/hotspot, Ethernet, multiple NICs, VPN, Docker/bridge, loopback, link-local, private/public, IPv6, order changes) | `tests/lan-addresses.test.ts` |
| QR ⊂ advertised ⊂ SANs; unreachable-first can't hide the reachable one; subnet change, late join | `tests/hotspot-pairing-server.test.ts`, `tests/pairing-url.test.ts`, `tests/pairing-dock-endpoints.test.tsx` |
| Phone-side ranking (ap0 vs rmnet/CLAT/tun), invitation staging and precedence, failure classification and guidance, real TCP race | `HotspotPairingTestKt` (`:engine:hotspotPairingTest`, `verify.sh`) |
| QR pin match, mismatch and replacement of a stale anchor | `TlsTrustTestKt` (interop) |
| E2E: QR → pending code → native TLS/WSS → welcome → paired; fresh QR ≠ saved code; same-target rescan; rate limit; pin mismatch; unreachable-only; uncovered address; retry after rescan | `QrPairingE2EKt` + `scripts/e2e-qr-desktop.ts` (in `scripts/test-native-interop.ts`) |
| Reverse connections: gateway/mDNS parsers (macOS, Linux, Windows), dialer safety + backoff, server pipeline with a dialled phone (pinned TLS client, /ws, welcome, never "this machine") | `tests/reverse-connect.test.ts` |
| Reverse race on the phone: forward blackholed → inbound wins; forward wins → inbound cancelled; grace after fast failure; listener gating, reject, unanchored trust refuses | `HotspotPairingTestKt` |
| E2E: forward path blackholed → real desktop dials the real `ReverseListener` → pinned TLS → welcome; wrong pin refused | `ReverseConnectE2EKt` (in `scripts/test-native-interop.ts`) |
| Real-kernel routing | `scripts/sim/run-scenario.sh` (needs root; not in CI) |

## Manual test plan (one Android phone + one MacBook)

Before you start: install the new desktop build and Android APK, and turn off
Wi-Fi on the phone.

1. **Baseline hotspot.** Turn on the phone's hotspot and join it from the
   Mac. Open AirBridge on the Mac.
   - Check that PairingDock shows the hotspot address. On the Mac, run
     `ipconfig getifaddr en0` (or the right `enX`) and
     `route -n get <hotspot gateway>`.
   - Scan the QR. Expect it to connect within ~1 s and show the Mac as
     paired.
2. **Two networks (the reported case).** Keep the Mac on campus/office
   Ethernet or a dock *and* on the hotspot.
   - PairingDock should say "This computer is on 2 networks".
   - Scan without changing the selection. Expect it to connect via the
     hotspot address. `adb logcat -s AirBridgeNative` should show
     `Connected via <hotspot IP>`.
3. **Late join.** Start AirBridge, *then* join the hotspot. Within ~3 s the
   hotspot address appears in PairingDock. Scan it and expect it to connect.
   There should be no certificate error.
4. **Wrong network.** Put the Mac on a Wi-Fi network the phone isn't on and
   scan. Expect "Computer not reachable on this network", the text "…not on
   any network this phone is connected to (phone networks: ap0 …)", and the
   button "Rescan after joining the network". There should be no pair-code
   advice.
5. **Firewall.** On the Mac, open System Settings → Network → Firewall,
   turn it on with "Block all incoming connections", and scan. Expect a
   TCP timeout with "…is on this phone's ap0 network but didn't answer…
   firewall…". Turn the block off and rescan: it should connect.
6. **AirBridge closed.** Quit AirBridge on the Mac. Expect
   "AirBridge isn't running on the computer" and a Retry button.
7. **Fresh code.** Press "Generate a fresh room" on the Mac, then rescan on
   the phone. Expect the phone to show the new code and re-pair, with no app
   restart needed. Force-stop and reopen the app: it should rejoin with the
   new code, not the old one.
8. **Hotspot subnet change.** Turn the hotspot off and on again; the subnet
   or address may change. The app should reconnect automatically via the
   learned address. If it shows "Certificate doesn't cover this address" or
   a timeout, rescanning must recover.
9. **TLS identity.** Delete the Mac's AirBridge TLS directory and restart it,
   so a new CA is generated. Without rescanning, expect "Computer's security
   identity changed" with the button "Forget computer and rescan". Rescan
   the new QR: it should connect.
10. **Rate limit.** Join a code from the pairing sheet 7 times quickly. Expect
    "Too many pairing attempts", with no button.

## Known limitations

* Reverse connections need the phone app running with a pinned computer (after a QR scan or an earlier pairing) and a network that allows computer → phone traffic.

- **CI:** `:app` (Compose) needs Gradle and the Android SDK. Those weren't
  available where this change was developed. The engine,
  `HotspotPairingTestKt`, interop and the QR E2E were run with `kotlinc` and
  a JRE. The app sources were checked by review, plus a stubbed compile of
  `Prefs.kt`. The CI `android` job (`:engine:check :app:assembleDebug` plus
  interop) is the first full compile of the app changes.
- Mac **Internet Sharing** (the phone joins the *Mac's* network through
  `bridge100`) isn't advertised, because `bridgeN` is treated as a VM bridge.
- IPv6-only LANs aren't advertised. The QR, SANs and mDNS stay on IPv4.
