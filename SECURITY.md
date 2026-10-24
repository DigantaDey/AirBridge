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

## Known residual risks

- Nearby (unpaired) devices can still *offer* transfers/beams and see
  device names/keys; offers require receiver consent, but spam/DoS at the
  signalling layer is only rate-limited, not eliminated. Use
  paired-only/hidden visibility on untrusted networks.
- Identity keys are ephemeral and SAS comparison is optional in the UI
  flow; a first-contact MITM on a hostile network is detectable via the
  SAS/fingerprint but not prevented. Verify the code before trusting a
  device for auto-accept.
- The local CA bootstrap download is plain HTTP by necessity; always
  compare its SHA-256 fingerprint with the host terminal output.
