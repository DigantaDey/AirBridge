# Security model & audit notes

AirBridge runs on a shared LAN, so every other device on the network must be
treated as a potential attacker until it is *paired* and has completed the
ECDH session. Summary of the audit (and fixes) behind the current code:

## Trust boundaries

- **Nearby discovery is not trust.** Any device on the same /24 can *see*
  device names and public keys. It cannot read transfers: control payloads
  and file chunks are AES-256-GCM encrypted with a key derived via
  ECDH-P256 + HKDF from the two device keys, and the 6-digit SAS code lets
  users compare keys out-of-band before accepting.
- **Consent before content.** Incoming chunks are neither decrypted nor
  stored until the user accepts the transfer (or the sender is a previously
  trusted device). Clipboard beams and transfer decisions must arrive
  encrypted — the server and the client both refuse plaintext control
  payloads other than ping/pong, so a relayed frame cannot forge an
  accept/decline/cancel or inject clipboard text without the session key.
- **The host machine is a separate boundary.** Writing to the host OS
  clipboard, saving straight to disk (`/api/daemon/save`), reading/changing
  the received-files folder (`/api/received-folder*`) and opening folders
  are loopback-only. Folder-open requests may only target paths inside the
  configured received-files folder, and opening uses a fixed argv
  (`open`/`xdg-open`/`explorer.exe`), never a shell.

## Fixed in this audit

1. Plaintext `transfer-control` frames were relayed and accepted for *any*
   payload kind — fixed on server and client (ping/pong only).
2. File chunks were decrypted/stored before the receiver accepted, and a
   hostile manifest could declare an inconsistent chunk count to exhaust
   memory pre-consent — manifests are now validated (`totalChunks` must
   match `size`/`chunkSize`, file/total caps) and chunks are gated on
   acceptance, slot bounds, and exact expected chunk size.
3. Transfer accept/decline/cancel/ack/complete and history-sync were not
   bound to the transfer's peer — any peer guessing a transfer ID could
   affect it. They are now peer-bound.
4. `X-Forwarded-For` was trusted for "same network" grouping, letting a
   client spoof a victim subnet (or loopback). The socket address is now
   authoritative.
5. Device profiles/public keys were unvalidated attacker input — now
   checked (canonical 65-byte P-256 point, bounded/enumerated fields).
6. Pair-code guessing was unthrottled (30-bit code) — join attempts are
   rate-limited per connection; connection counts are capped.
7. CLI beam links were 96-bit, non-expiring bearer tokens — now 256-bit,
   15-minute expiry, with per-address throttling of failed lookups.
8. `/api/health` leaked the host's local download path to the LAN; zip
   entries could contain `../` path segments. Both fixed.

## Native Android and reliability hardening (2.2.0)

- File GCM IVs now use **all 96 bits of fresh cryptographic randomness**.
  The previous layout stored repeating file/chunk coordinates in 64 bits and
  left only 32 random bits for the same position under a reused peer key.
  Wire framing is unchanged; old recordings/vectors can still decrypt.
- Android no longer loads application scripts from the desktop. Its bundled
  UI has a restrictive CSP and only exchanges metadata/capability tokens with
  the foreground service. URI file bytes do not cross the JavaScript bridge.
- Native TLS validates chains and hostnames against the desktop CA (or
  self-signed leaf) **pinned on first use** per host/port. Subsequent identity
  changes fail closed; leaf renewal under the same CA is supported. Unpairing
  explicitly removes that pin. TLS errors never trigger plaintext fallback;
  plaintext transport requires an explicit `http://` invitation.
- Resume consent binds the transfer ID, original peer public key and exact
  manifest. Missing/truncated `.part` files invalidate the resume ledger.
  Private staging is SHA-256 verified before Downloads publication, and
  senders wait for verified receiver completion. Publication/hashing does not
  hold the engine monitor or stop its network reader.
- Queues, message/fragment sizes, histories and concurrent native transfers
  are bounded. Invalid integer/chunk arithmetic is rejected before allocation.
  Relay overload disconnects explicitly instead of silently losing chunks;
  sockets without hello and repeated registrations cannot evade limits.
- Clipboard auto-send targets paired peers only. Native automatic capture
  excludes clips marked sensitive and never scrapes window content. Explicit
  Share/selected-text actions work when the OS denies hidden clipboard reads.

## Known residual risks

- Nearby (unpaired) devices can still *offer* transfers/beams and see
  device names/keys; file offers require consent, while clipboard receive is
  an independent user setting. Use paired-only/hidden visibility on untrusted
  networks. Signaling abuse/DoS is bounded, not eliminated.
- ECDH identity keys are ephemeral and SAS comparison is optional in the UI.
  **First-use TLS pinning is not out-of-band authentication.** A first-contact
  MITM can establish its own pin, and explicit HTTP exposes metadata/pair
  codes. Compare the SAS before trusting a device or accepting content;
  application payload encryption does not authenticate first discovery.
- The browser's local CA bootstrap download is plain HTTP; compare its
  SHA-256 fingerprint with the host terminal output. Native pinning is
  per host/port, so connecting to a different address is a new first use.
- Local processes/apps may reach loopback services; loopback is a host trust
  boundary, not an OS-level access-control mechanism. Only grant the native
  bridge to bundled local documents and do not run untrusted host software.
- The committed Android sideload signing key is public. It preserves update
  compatibility, not publisher authenticity. Obtain APKs/checksums from this
  repository's official releases, or distribute with your own private key.
- Android's background clipboard privacy rules, force-stop and OEM battery
  management cannot be bypassed by Accessibility or a foreground service.
  Process-death resume and automatic image capture are not guaranteed.
