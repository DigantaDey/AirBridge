/**
 * Hotspot handoff ("bandwidth upgrade"): when the phone and the computer
 * share no usable network, the phone starts a private local-only hotspot and
 * hands its credentials to the computer, which joins it; the existing
 * reverse-connect path (the computer dials its new default gateway, i.e. the
 * phone) or the phone's direct probe then brings up a direct LAN link.
 *
 * Delivery of the credentials:
 *   - over the current session when there is one (typically the encrypted
 *     relay: a direct link is much faster than a relay for files), or
 *   - over Bluetooth LE when there is no connection at all: the macOS app runs
 *     a GATT peripheral (scripts/mac_app.swift) and forwards the bytes here.
 *
 * Offer envelope v1 (byte-for-byte mirrored in Handoff.kt):
 *
 *   0x01 ‖ epk (65, uncompressed P-256) ‖ iv (12) ‖ AES-256-GCM(k, iv, payload, aad = 0x01 ‖ epk)
 *   k = HKDF-SHA256(ikm = ECDH-x(epk, K), salt = "airbridge-handoff-v1", info = epk ‖ K, 32)
 *
 * K is the computer's static handoff key, which the phone learned in the
 * code-authenticated (SPAKE2) welcome together with a MAC under the session's
 * vouch key, so a relay or impostor cannot substitute it. Only this computer
 * can read an offer. The payload carries an HMAC keyed from the pairing code,
 * so only a device that knows the code can make the computer switch networks;
 * because the MAC is inside the encryption, an eavesdropper cannot use it to
 * guess the code offline. Freshness: issue time ±10 min plus a nonce cache.
 *
 * Joining a network takes this computer off its current Wi-Fi, so it asks the
 * user first unless they chose "always allow".
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePairCode, type HandoffInfo, type HandoffState } from '../shared/protocol.js';
import { handoffProof } from '../shared/pairingProof.js';
import type { HotspotSecurity, WifiCredentials, WifiJoiner } from './wifiJoin.js';

export type { HotspotSecurity } from './wifiJoin.js';

export const HANDOFF_VERSION = 1;
export const HANDOFF_SALT = 'airbridge-handoff-v1';
export const HANDOFF_AUTH_SALT = 'airbridge-handoff-auth-v1';
export const BEACON_LABEL = 'airbridge-beacon-v1';
/** Rotating Bluetooth tag period. */
export const BEACON_WINDOW_MS = 15 * 60_000;

/** GATT layout of the computer's Bluetooth handoff service. */
export const BLE_UUIDS = {
  service: 'c288bc57-57c6-44cc-9137-a59f85d3bf6f',
  /** read: 0x01 ‖ 8-byte rotating tag (HMAC of the beacon secret and the time window). */
  tag: 'c288bc58-57c6-44cc-9137-a59f85d3bf6f',
  /** write (with response, long writes allowed): offer envelope bytes. */
  offer: 'c288bc59-57c6-44cc-9137-a59f85d3bf6f',
  /** read + notify: UTF-8 JSON {"s": state, "r": reason}. */
  status: 'c288bc5a-57c6-44cc-9137-a59f85d3bf6f',
} as const;

const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const MAX_ENVELOPE_BYTES = 512;

export class HandoffError extends Error {
  constructor(readonly code: 'MALFORMED' | 'NOT_FOR_US' | 'BAD_AUTH' | 'STALE' | 'REPLAY' | 'BAD_CREDENTIALS', message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

// ───────────────────────────── keys ─────────────────────────────

export interface HandoffKeys {
  /** 32-byte P-256 private scalar. */
  privateKey: Uint8Array;
  /** 65-byte uncompressed public key. */
  publicKey: Uint8Array;
  beaconSecret: Uint8Array;
}

export function handoffKeysFromPrivate(privateKey: Uint8Array, beaconSecret: Uint8Array): HandoffKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey));
  return { privateKey, publicKey: new Uint8Array(ecdh.getPublicKey()), beaconSecret };
}

export function generateHandoffKeys(): HandoffKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: new Uint8Array(ecdh.getPrivateKey()), publicKey: new Uint8Array(ecdh.getPublicKey()), beaconSecret: new Uint8Array(crypto.randomBytes(16)) };
}

/** ~/.airbridge/handoff-key.json (0600). Stable so phones paired earlier keep working. */
export function loadOrCreateHandoffKeys(stateDir: string): HandoffKeys {
  const file = path.join(stateDir, 'handoff-key.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: number; d?: string; beacon?: string };
    if (raw.v === 1 && raw.d && raw.beacon) {
      const keys = handoffKeysFromPrivate(fromB64u(raw.d), fromB64u(raw.beacon));
      if (keys.privateKey.length === 32 && keys.beaconSecret.length === 16) return keys;
    }
  } catch {
    // create below
  }
  const keys = generateHandoffKeys();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, d: b64u(keys.privateKey), beacon: b64u(keys.beaconSecret) }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Unwritable state dir: keys for this run only (phones re-learn them on the next join).
  }
  return keys;
}

/** For the code-authenticated welcome. */
export function handoffInfoFor(keys: HandoffKeys, vouchKey: Uint8Array, peerId: string): HandoffInfo {
  const key = b64u(keys.publicKey);
  const beacon = b64u(keys.beaconSecret);
  return { v: 1, key, beacon, proof: handoffProof(vouchKey, { peerId, key, beacon }) };
}

/** 0x01 ‖ first 8 bytes of HMAC(beacon secret, label ‖ window). */
export function beaconTag(beaconSecret: Uint8Array, now = Date.now()): Uint8Array {
  const window = Math.floor(now / BEACON_WINDOW_MS);
  const mac = crypto.createHmac('sha256', Buffer.from(beaconSecret)).update(`${BEACON_LABEL}:${window}`).digest();
  return Uint8Array.from([HANDOFF_VERSION, ...mac.subarray(0, 8)]);
}

// ───────────────────────────── payload ─────────────────────────────

export interface HandoffPayload {
  v: 1;
  ssid: string;
  psk: string;
  sec: HotspotSecurity;
  /** Port of the phone's reverse listener (the computer dials its gateway there). */
  rp: number;
  /** Phone identity key (base64url) or ''. */
  id: string;
  /** Phone display name. */
  name: string;
  /** Issue time, seconds since the epoch. */
  t: number;
  /** base64url 12 random bytes. */
  n: string;
  /** base64url HMAC-SHA256(auth key, fields)[:16]. */
  mac: string;
}

export function handoffAuthKey(pairCode: string): Uint8Array {
  return new Uint8Array(crypto.hkdfSync('sha256', Buffer.from(normalizePairCode(pairCode), 'utf8'), Buffer.from(HANDOFF_AUTH_SALT), Buffer.from('auth'), 32));
}

export function offerMac(authKey: Uint8Array, p: Omit<HandoffPayload, 'mac' | 'v'>): string {
  const msg = `handoff-offer\n${p.ssid}\n${p.psk}\n${p.sec}\n${p.rp}\n${p.id}\n${p.name}\n${p.t}\n${p.n}`;
  return b64u(crypto.createHmac('sha256', Buffer.from(authKey)).update(msg, 'utf8').digest().subarray(0, 16));
}

/** Rejects anything a Wi-Fi tool could misread: lengths, control characters, an open network. */
export function validateCredentials(p: { ssid: unknown; psk: unknown; sec: unknown }): WifiCredentials {
  if (typeof p.ssid !== 'string' || typeof p.psk !== 'string' || typeof p.sec !== 'string') throw new HandoffError('BAD_CREDENTIALS', 'missing hotspot details');
  const ssidBytes = Buffer.byteLength(p.ssid, 'utf8');
  // eslint-disable-next-line no-control-regex
  if (ssidBytes < 1 || ssidBytes > 32 || /[\u0000-\u001f\u007f]/.test(p.ssid)) throw new HandoffError('BAD_CREDENTIALS', 'invalid hotspot name');
  const hex64 = /^[0-9a-fA-F]{64}$/.test(p.psk);
  if (!hex64 && (p.psk.length < 8 || p.psk.length > 63 || !/^[\x20-\x7e]+$/.test(p.psk))) throw new HandoffError('BAD_CREDENTIALS', 'invalid hotspot password');
  if (p.sec !== 'wpa2' && p.sec !== 'wpa3' && p.sec !== 'wpa2-wpa3') throw new HandoffError('BAD_CREDENTIALS', 'unsupported hotspot security (open networks are refused)');
  return { ssid: p.ssid, psk: p.psk, security: p.sec };
}

// ───────────────────────────── envelope ─────────────────────────────

function envelopeKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(shared), Buffer.from(HANDOFF_SALT), Buffer.concat([epk, recipient]), 32));
}

export interface SealOptions {
  /** Tests and vectors only. */
  ephemeralPrivateKey?: Uint8Array;
  iv?: Uint8Array;
  nonce?: Uint8Array;
  issuedAt?: number;
}

/** Phone side; the Android engine has the production implementation (Handoff.kt). */
export function sealOffer(
  recipientKeyB64: string,
  pairCode: string,
  offer: { ssid: string; psk: string; sec: HotspotSecurity; rp: number; id: string; name: string },
  opts: SealOptions = {},
): Uint8Array {
  const recipient = fromB64u(recipientKeyB64);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.ephemeralPrivateKey) ecdh.setPrivateKey(Buffer.from(opts.ephemeralPrivateKey));
  else ecdh.generateKeys();
  const epk = new Uint8Array(ecdh.getPublicKey());
  const shared = new Uint8Array(ecdh.computeSecret(Buffer.from(recipient)));
  const fields = { ...offer, t: opts.issuedAt ?? Math.floor(Date.now() / 1000), n: b64u(opts.nonce ?? crypto.randomBytes(12)) };
  const payload: HandoffPayload = { v: 1, ...fields, mac: offerMac(handoffAuthKey(pairCode), fields) };
  const iv = Buffer.from(opts.iv ?? crypto.randomBytes(12));
  const header = Buffer.concat([Buffer.from([HANDOFF_VERSION]), epk]);
  const cipher = crypto.createCipheriv('aes-256-gcm', envelopeKey(shared, epk, recipient), iv);
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([header, iv, ct]));
}

export interface OpenedOffer {
  payload: HandoffPayload;
  credentials: WifiCredentials;
}

/** Computer side: decrypt, authenticate with one of the room codes, validate. Does not check replays. */
export function openOffer(envelope: Uint8Array, keys: HandoffKeys, pairCodes: readonly string[], now = Date.now()): OpenedOffer {
  if (envelope.length < 1 + 65 + 12 + 16 + 2 || envelope.length > MAX_ENVELOPE_BYTES) throw new HandoffError('MALFORMED', 'offer has the wrong size');
  if (envelope[0] !== HANDOFF_VERSION) throw new HandoffError('MALFORMED', `unsupported offer version ${envelope[0]}`);
  const header = envelope.subarray(0, 66);
  const epk = envelope.subarray(1, 66);
  const iv = envelope.subarray(66, 78);
  const body = envelope.subarray(78);
  let plaintext: Buffer;
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(keys.privateKey));
    const shared = new Uint8Array(ecdh.computeSecret(Buffer.from(epk)));
    const decipher = crypto.createDecipheriv('aes-256-gcm', envelopeKey(shared, epk, keys.publicKey), Buffer.from(iv));
    decipher.setAAD(Buffer.from(header));
    decipher.setAuthTag(Buffer.from(body.subarray(body.length - 16)));
    plaintext = Buffer.concat([decipher.update(Buffer.from(body.subarray(0, body.length - 16))), decipher.final()]);
  } catch {
    throw new HandoffError('NOT_FOR_US', 'offer is not sealed to this computer');
  }
  let payload: HandoffPayload;
  try {
    payload = JSON.parse(plaintext.toString('utf8')) as HandoffPayload;
  } catch {
    throw new HandoffError('MALFORMED', 'offer payload is not JSON');
  }
  if (!payload || payload.v !== 1 || typeof payload.n !== 'string' || typeof payload.mac !== 'string' || !Number.isInteger(payload.t)) {
    throw new HandoffError('MALFORMED', 'offer payload is incomplete');
  }
  const rp = Number(payload.rp);
  if (!Number.isInteger(rp) || rp < 1 || rp > 65535) throw new HandoffError('MALFORMED', 'bad reverse port');
  const fields = {
    ssid: String(payload.ssid), psk: String(payload.psk), sec: payload.sec, rp,
    id: typeof payload.id === 'string' ? payload.id : '',
    name: typeof payload.name === 'string' ? payload.name : '',
    t: payload.t, n: payload.n,
  };
  const presented = Buffer.from(payload.mac, 'base64url');
  const authentic = pairCodes.some((code) => {
    const expected = Buffer.from(offerMac(handoffAuthKey(code), fields), 'base64url');
    return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
  });
  if (!authentic) throw new HandoffError('BAD_AUTH', 'offer was not made with this computer’s pairing code');
  if (Math.abs(now - payload.t * 1000) > MAX_CLOCK_SKEW_MS) throw new HandoffError('STALE', 'offer is too old (or the clocks differ by more than 10 minutes)');
  const credentials = validateCredentials(payload);
  // Display only: cap and strip control characters after authentication.
  // eslint-disable-next-line no-control-regex
  const name = fields.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
  return { payload: { ...payload, ...fields, name }, credentials };
}

// ───────────────────────────── service ─────────────────────────────

export type HandoffPolicy = 'ask' | 'always' | 'off';
export type HandoffVia = 'session' | 'bluetooth';

export interface HandoffOfferView {
  id: string;
  state: HandoffState;
  reason: string;
  deviceName: string;
  ssid: string;
  via: HandoffVia;
  createdAt: string;
  expiresAt: string;
  /** Peer that sent it over the session (status goes back there). */
  peerId: string | null;
}

interface OfferRecord extends HandoffOfferView {
  credentials: WifiCredentials;
  reversePort: number;
  timer?: NodeJS.Timeout;
}

export interface HandoffServiceOptions {
  keys: HandoffKeys;
  /** Codes of the rooms this computer hosts (the offer must be MACed with one). */
  pairCodes: () => string[];
  joiner: WifiJoiner;
  stateDir?: string | null;
  /** Called after joining so reverse-connect dials the phone right away. */
  onJoined?: (offer: HandoffOfferView, reversePort: number) => void;
  log?: (msg: string) => void;
  now?: () => number;
  consentTimeoutMs?: number;
}

const TERMINAL: ReadonlySet<HandoffState> = new Set(['declined', 'expired', 'failed', 'invalid', 'ended']);

export class HandoffService extends EventEmitter {
  private readonly offers = new Map<string, OfferRecord>();
  private readonly seenNonces = new Map<string, number>();
  private policy: HandoffPolicy;
  private keysShared: boolean;
  private active: OfferRecord | null = null;
  private readonly now: () => number;

  constructor(private readonly o: HandoffServiceOptions) {
    super();
    this.now = o.now ?? Date.now;
    const settings = this.loadSettings();
    this.policy = settings.policy;
    this.keysShared = settings.shared;
  }

  getPolicy(): HandoffPolicy {
    return this.policy;
  }

  setPolicy(policy: HandoffPolicy): void {
    this.policy = policy;
    this.saveSettings();
  }

  /**
   * True once a code-authenticated phone has received this computer's handoff
   * keys. Until then nobody could use the Bluetooth path, so the desktop shell
   * doesn't start Bluetooth (and doesn't trigger the OS permission prompt).
   */
  get shared(): boolean {
    return this.keysShared;
  }

  markShared(): void {
    if (this.keysShared) return;
    this.keysShared = true;
    this.saveSettings();
  }

  private saveSettings(): void {
    if (!this.o.stateDir) return;
    try {
      fs.writeFileSync(
        path.join(this.o.stateDir, 'handoff.json'),
        JSON.stringify({ policy: this.policy, shared: this.keysShared }),
        { mode: 0o600 },
      );
    } catch {
      // keep in memory
    }
  }

  private loadSettings(): { policy: HandoffPolicy; shared: boolean } {
    if (!this.o.stateDir) return { policy: 'ask', shared: false };
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.o.stateDir, 'handoff.json'), 'utf8')) as { policy?: string; shared?: unknown };
      return { policy: raw.policy === 'always' || raw.policy === 'off' ? raw.policy : 'ask', shared: raw.shared === true };
    } catch {
      return { policy: 'ask', shared: false };
    }
  }

  beaconTag(): Uint8Array {
    return beaconTag(this.o.keys.beaconSecret, this.now());
  }

  list(): HandoffOfferView[] {
    return [...this.offers.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => this.view(r));
  }

  get(id: string): HandoffOfferView | null {
    const r = this.offers.get(id);
    return r ? this.view(r) : null;
  }

  /** Handles a received envelope. Never throws: problems become an 'invalid' result. */
  submit(envelope: Uint8Array, via: HandoffVia, peerId: string | null = null): HandoffOfferView {
    this.gc();
    const id = crypto.randomBytes(8).toString('hex');
    const nowMs = this.now();
    const base = { id, via, peerId, createdAt: new Date(nowMs).toISOString(), deviceName: '', ssid: '' };
    if (this.policy === 'off') {
      return this.reject(base, 'declined', 'Direct links are turned off on this computer');
    }
    let opened: OpenedOffer;
    try {
      opened = openOffer(envelope, this.o.keys, this.o.pairCodes(), nowMs);
    } catch (err) {
      const reason = err instanceof HandoffError ? err.message : 'unreadable offer';
      this.log(`handoff: rejected offer via ${via}: ${reason}`);
      return this.reject(base, 'invalid', reason);
    }
    if (this.seenNonces.has(opened.payload.n)) {
      return this.reject(base, 'invalid', 'offer was already used');
    }
    this.seenNonces.set(opened.payload.n, nowMs);

    const record: OfferRecord = {
      ...base,
      deviceName: opened.payload.name || 'Your phone',
      ssid: opened.credentials.ssid,
      state: 'pending',
      reason: '',
      expiresAt: new Date(nowMs + (this.o.consentTimeoutMs ?? 2 * 60_000)).toISOString(),
      credentials: opened.credentials,
      reversePort: opened.payload.rp,
    };
    // A newer offer from the same phone replaces an unanswered one.
    for (const other of this.offers.values()) {
      if (other.state === 'pending' && other.deviceName === record.deviceName) this.finish(other, 'expired', 'Replaced by a newer request');
    }
    this.offers.set(id, record);
    this.log(`handoff: ${record.deviceName} offers its hotspot via ${via}`);
    if (this.policy === 'always') {
      void this.join(record);
    } else {
      record.timer = setTimeout(() => {
        if (record.state === 'pending') this.finish(record, 'expired', 'Nobody answered on the computer');
      }, Math.max(0, Date.parse(record.expiresAt) - nowMs));
      record.timer.unref?.();
      this.emit('request', this.view(record));
      this.changed(record);
    }
    return this.view(record);
  }

  /** The user's answer on the computer. `always` also stores the policy. */
  respond(id: string, allow: boolean, always = false): HandoffOfferView | null {
    const record = this.offers.get(id);
    if (!record) return null;
    if (record.state !== 'pending') return this.view(record);
    if (!allow) {
      this.finish(record, 'declined', 'Declined on the computer');
    } else {
      if (always) this.setPolicy('always');
      void this.join(record);
    }
    return this.view(record);
  }

  /** The phone stopped its hotspot or the user ended the link: leave and return to the previous network. */
  async end(id: string, reason = 'Direct link ended'): Promise<HandoffOfferView | null> {
    const record = this.offers.get(id);
    if (!record) return null;
    if (record.state === 'pending') { this.finish(record, 'ended', reason); return this.view(record); }
    if (record.state !== 'joined' && record.state !== 'joining') return this.view(record);
    this.finish(record, 'ended', reason);
    if (this.active === record) {
      this.active = null;
      try {
        const restored = await this.o.joiner.leave(record.credentials.ssid);
        this.log(restored ? `handoff: left ${record.ssid}; back on ${restored}` : `handoff: left ${record.ssid}`);
      } catch (err) {
        this.log(`handoff: leaving ${record.ssid} failed: ${(err as Error).message}`);
      }
    }
    return this.view(record);
  }

  private async join(record: OfferRecord): Promise<void> {
    if (this.active && this.active !== record && this.active.state === 'joined') {
      await this.end(this.active.id, 'Replaced by a newer direct link');
    }
    this.active = record;
    record.state = 'joining';
    record.reason = `Joining ${record.ssid}…`;
    if (record.timer) clearTimeout(record.timer);
    this.changed(record);
    try {
      const result = await this.o.joiner.join(record.credentials);
      if (record.state !== 'joining') return; // ended meanwhile
      record.state = 'joined';
      record.reason = result.address ? `Joined ${record.ssid} (${result.address})` : `Joined ${record.ssid}`;
      this.log(`handoff: joined ${record.ssid}${result.address ? ` as ${result.address}` : ''}`);
      this.changed(record);
      this.o.onJoined?.(this.view(record), record.reversePort);
    } catch (err) {
      if (this.active === record) this.active = null;
      this.finish(record, 'failed', (err as Error).message || 'Could not join the hotspot');
      this.log(`handoff: joining ${record.ssid} failed: ${(err as Error).message}`);
    }
  }

  private reject(base: Pick<OfferRecord, 'id' | 'via' | 'peerId' | 'createdAt' | 'deviceName' | 'ssid'>, state: HandoffState, reason: string): HandoffOfferView {
    const view: HandoffOfferView = { ...base, state, reason, expiresAt: base.createdAt };
    this.emit('status', view);
    return view;
  }

  private finish(record: OfferRecord, state: HandoffState, reason: string): void {
    if (record.timer) clearTimeout(record.timer);
    record.state = state;
    record.reason = reason;
    this.changed(record);
  }

  private changed(record: OfferRecord): void {
    this.emit('status', this.view(record));
  }

  private view(r: OfferRecord): HandoffOfferView {
    return { id: r.id, state: r.state, reason: r.reason, deviceName: r.deviceName, ssid: r.ssid, via: r.via, createdAt: r.createdAt, expiresAt: r.expiresAt, peerId: r.peerId };
  }

  private gc(): void {
    const cutoff = this.now() - 2 * MAX_CLOCK_SKEW_MS;
    for (const [n, t] of this.seenNonces) if (t < cutoff) this.seenNonces.delete(n);
    for (const [id, r] of this.offers) {
      if (TERMINAL.has(r.state) && Date.parse(r.createdAt) < this.now() - 30 * 60_000) this.offers.delete(id);
    }
  }

  private log(msg: string): void {
    this.o.log?.(msg);
  }

  /** Leave a joined hotspot on shutdown. */
  async dispose(): Promise<void> {
    for (const r of this.offers.values()) if (r.timer) clearTimeout(r.timer);
    if (this.active?.state === 'joined') await this.end(this.active.id, 'AirBridge is shutting down');
  }
}

export function isTerminalHandoffState(state: HandoffState): boolean {
  return TERMINAL.has(state);
}
