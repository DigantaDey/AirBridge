import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import {
  type Admission,
  type ClientToServerMessage,
  type DeviceProfile,
  type HandoffInfo,
  type PakeHello,
  type RelayOffer,
  type LanEndpoint,
  type HostFirewallStatus,
  type LocalDaemonStatus,
  type PeerSummary,
  type ServerToClientMessage,
  type VisibilityMode,
  FRAME_ROUTED_RELAY,
  ROUTING_HEADER_LENGTH,
  generatePairCode,
  isValidClipboardImageDataUrl,
  isValidPairCode,
  normalizePairCode,
  overwriteRoutedSourcePeerId,
  unwrapRoutedRelayFrame,
} from '../shared/protocol.js';
import {
  HUB_SPAKE2_IDENTITY,
  JOIN_PROTOCOL_VERSION,
  JOIN_SPAKE2_AAD,
  hubProof,
  identityBindingMessage,
  joinerSpake2Identity,
  nameplateFor,
  passwordScalar,
  peerVouch,
  vouchKeyFrom,
} from '../shared/pairingProof.js';
import { Spake2, constantTimeEqual, type Spake2Result } from '../shared/spake2.js';
import { HostClipboardMonitor, type HostClipboardProvider, type HostClipboardTelemetry } from './hostClipboard.js';
import { isLoopbackAddress } from './tls.js';
import { isReversePeer } from './reverseConnect.js';
import { isRelayedPeer } from './relay.js';

interface ConnectedClient {
  peerId: string;
  ws: WebSocket;
  networkKey: string;
  isLoopback: boolean;
  pairCode: string;
  visibility: VisibilityMode;
  device: DeviceProfile;
  connectedAt: number;
  isAlive: boolean;
  missedPings: number;
  lastBytesWritten: number;
  joinPairAttempts: number[];
  /** Normalized IPv4 of the peer socket (dialled-in phones included). */
  remoteAddress: string;
  admission: Admission;
  /** SPAKE2-derived key used to vouch for peers this client sees (admission 'pake' only). */
  vouchKey?: Uint8Array;
  /** Recent handoff-offer times (rate limit). */
  handoffAttempts?: number[];
  viaReverse: boolean;
  viaRelayed: boolean;
}

interface PendingPake {
  hello: Extract<ClientToServerMessage, { type: 'hello' }>;
  device: DeviceProfile;
  room: string;
  /** No room matched the nameplate: the exchange runs against a random code and always fails. */
  decoy: boolean;
  result: Spake2Result;
}

/** Sliding-window failure counter (per remote address and global). */
export class PakeFailureLimiter {
  private readonly perAddress = new Map<string, number[]>();
  private global: number[] = [];
  constructor(
    private readonly windowMs = 5 * 60_000,
    private readonly maxPerAddress = 8,
    private readonly maxGlobal = 60,
    private readonly now: () => number = Date.now,
  ) {}
  private prune(list: number[]): number[] {
    const cutoff = this.now() - this.windowMs;
    return list.filter((t) => t > cutoff);
  }
  allows(address: string): boolean {
    this.global = this.prune(this.global);
    const mine = this.prune(this.perAddress.get(address) ?? []);
    if (mine.length) this.perAddress.set(address, mine); else this.perAddress.delete(address);
    return mine.length < this.maxPerAddress && this.global.length < this.maxGlobal;
  }
  fail(address: string): void {
    const t = this.now();
    this.global.push(t);
    const mine = this.perAddress.get(address) ?? [];
    mine.push(t);
    this.perAddress.set(address, mine);
    if (this.perAddress.size > 1024) this.perAddress.delete(this.perAddress.keys().next().value!);
  }
  /** Failures inside the window, for diagnostics. */
  recentFailures(): number {
    this.global = this.prune(this.global);
    return this.global.length;
  }
}

function sanitizePakeHello(raw: unknown): PakeHello | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== JOIN_PROTOCOL_VERSION) return null;
  if (typeof p.nameplate !== 'string' || !/^[0-9a-f]{2}$/.test(p.nameplate)) return null;
  if (typeof p.share !== 'string' || p.share.length !== 87) return null;
  return { v: p.v, nameplate: p.nameplate, share: p.share };
}

function normalizeRemote(address: string | undefined): string {
  return (address ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0]!.replace(/^::ffff:/, '');
}

export function ipv6Prefix64(rawIp: string): string | null {
  const clean = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (!net.isIPv6(clean)) return null;
  // Handle embedded IPv4 tail if any (e.g. ::ffff:192.168.1.1)
  if (clean.includes('.')) return null;
  const parts = clean.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const full = [...head, ...new Array<string>(missing).fill('0'), ...tail].map((g) =>
    Number.parseInt(g || '0', 16).toString(16).padStart(4, '0'),
  );
  if (full.length !== 8) return null;
  return full.slice(0, 4).join(':');
}

export function deriveNetworkKey(req: IncomingMessage, relayedPeerId?: string): string {
  // SECURITY: never trust X-Forwarded-For here. AirBridge is not deployed
  // behind a proxy that strips it, so any LAN client could otherwise spoof
  // a victim's subnet (or loopback) and gain "nearby" discovery/relay access
  // to devices it is not on the same network as. The socket address is the
  // only address the kernel actually observed.
  if (isRelayedPeer(req.socket) || relayedPeerId) {
    return `net:relayed:${relayedPeerId ?? crypto.randomBytes(8).toString('hex')}`;
  }
  const rawIp = req.socket.remoteAddress || 'unknown';
  if (isLoopbackAddress(rawIp)) {
    return 'net:loopback';
  }

  const ip = normalizeRemote(rawIp);

  // Group private IPv4 /24 LAN subnets together so devices on the same Wi-Fi router discover each other
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    if (a === 192 && b === 168) {
      return `net:lan-192.168.${c}`;
    }
    if (a === 10) {
      return `net:lan-10.${b}.${c}`;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return `net:lan-172.${b}.${c}`;
    }
  }

  // Group non-loopback IPv6 LAN addresses by /64 prefix
  const v6Prefix = ipv6Prefix64(ip);
  if (v6Prefix) {
    return `net:lan6-${v6Prefix}`;
  }

  // Public IP (e.g., devices behind same home Wi-Fi NAT hitting cloud signaling)
  return 'net:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

const PLATFORMS = new Set(['macos', 'android', 'ios', 'windows', 'linux', 'unknown']);
const FORM_FACTORS = new Set(['laptop', 'phone', 'tablet', 'desktop']);
export const MAX_CLIENTS = 128;
export const MAX_CLIENTS_PER_NETWORK = 32;
export const MAX_RELAY_BUFFERED_BYTES = 64 * 1024 * 1024;
export const RELAY_BACKPRESSURE_HIGH_WATER = 16 * 1024 * 1024;
export const RELAY_BACKPRESSURE_LOW_WATER = 4 * 1024 * 1024;
const JOIN_PAIR_WINDOW_MS = 60_000;
const MAX_JOIN_PAIR_PER_WINDOW = 6; // pair codes are only 30 bits; slow guessing to a crawl

function getWsRawSocket(ws: WebSocket): net.Socket | undefined {
  return (ws as unknown as { _socket?: net.Socket })._socket;
}

function stripControlCharacters(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    out += value[i];
  }
  return out;
}

function boundText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = stripControlCharacters(value).trim().slice(0, max);
  return clean || fallback;
}

/** A device profile is attacker-controlled input: validate before it is stored, broadcast, or fed to ECDH. */
export function sanitizeDeviceProfile(raw: unknown): DeviceProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.publicKey !== 'string' || d.publicKey.length > 128) return null;
  let rawKey: Buffer;
  try { rawKey = Buffer.from(d.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { return null; }
  // Uncompressed P-256 point: 65 bytes, 0x04 prefix, re-encoding must round-trip (canonical base64url).
  if (rawKey.byteLength !== 65 || rawKey[0] !== 0x04) return null;
  const canonical = rawKey.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== d.publicKey) return null;
  return {
    name: boundText(d.name, 80, 'AirBridge Device'),
    platform: (PLATFORMS.has(String(d.platform)) ? d.platform : 'unknown') as DeviceProfile['platform'],
    model: boundText(d.model, 80, 'Device'),
    formFactor: (FORM_FACTORS.has(String(d.formFactor)) ? d.formFactor : 'laptop') as DeviceProfile['formFactor'],
    publicKey: d.publicKey,
    deviceId: typeof d.deviceId === 'string' && /^[0-9a-f]{16}$/.test(d.deviceId) ? d.deviceId : undefined,
    // An identity whose signature does not cover this session key is dropped,
    // never forwarded: peers would otherwise pin a key the device can't prove.
    ...(verifiedIdentity(d.identityKey, d.identitySig, d.publicKey) ?? {}),
  };
}

function decodeB64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const buf = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value ? buf : null;
}

/** Verifies identitySig (ECDSA P-256, raw r‖s) over the binding message for publicKey. */
export function verifiedIdentity(identityKey: unknown, identitySig: unknown, publicKey: string): { identityKey: string; identitySig: string } | null {
  if (typeof identityKey !== 'string' || typeof identitySig !== 'string' || identityKey.length > 128 || identitySig.length > 128) return null;
  const raw = decodeB64Url(identityKey);
  const sig = decodeB64Url(identitySig);
  if (!raw || !sig || raw.byteLength !== 65 || raw[0] !== 0x04 || sig.byteLength !== 64) return null;
  try {
    const key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const ok = crypto.verify('sha256', identityBindingMessage(publicKey), { key, dsaEncoding: 'ieee-p1363' }, sig);
    return ok ? { identityKey, identitySig } : null;
  } catch {
    return null;
  }
}

function generatePeerId(): string {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

let cachedLocalAddresses: { at: number; set: Set<string> } | null = null;
const LOCAL_ADDRESS_CACHE_TTL_MS = 2_000;

export function clearLocalMachineAddressCache(): void {
  cachedLocalAddresses = null;
}

export function isLocalMachineAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (isLoopbackAddress(remoteAddress)) return true;
  const normalized = normalizeRemote(remoteAddress).toLowerCase();
  const now = Date.now();
  if (!cachedLocalAddresses || now - cachedLocalAddresses.at > LOCAL_ADDRESS_CACHE_TTL_MS) {
    const set = new Set<string>();
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces)) {
      if (!list) continue;
      for (const info of list) {
        set.add(normalizeRemote(info.address).toLowerCase());
      }
    }
    cachedLocalAddresses = { at: now, set };
  }
  return cachedLocalAddresses.set.has(normalized);
}

function sanitizePeerId(candidate?: string): string {
  if (candidate && /^[0-9a-f]{16}$/.test(candidate)) {
    return candidate;
  }
  return generatePeerId();
}

export class SignalingHub {
  /**
   * Session QR pair code: the FIRST hello-less client claims it, so the
   * startup QR (which embeds `?pair=<code>`) lands the phone in the same
   * pairing group as whoever opens the page first. Later hello-less clients
   * keep distinct random codes — paired-only isolation is unchanged, and an
   * explicit `?pair=`/`join-pair` is always honored. Scanning the terminal
   * QR requires the same physical access as reading the code on screen.
   */
  private hostPairCode = generatePairCode(crypto.randomBytes(8));
  /** Last pair code per peerId so reconnects rejoin their existing group. */
  private readonly pairCodeByPeer = new Map<string, { pairCode: string; remote: string }>();
  private readonly pakeLimiter = new PakeFailureLimiter();
  private rateLimitedCount = 0;
  private legacyBlockedCount = 0;
  private relayDrops = 0;
  private relayDroppedFrames = 0;
  private relayBackpressurePauses = 0;
  private relayBackpressureResumes = 0;
  private relayMaxBufferedBytes = 0;
  private heartbeatTimeouts = 0;
  private onPakeFailure?: (recentFailures: number) => void;
  private getRelayOffer: () => RelayOffer | null;
  private getHandoffInfo: (vouchKey: Uint8Array, peerId: string) => HandoffInfo | null;
  private onHandoffOffer?: (peerId: string, envelope: Uint8Array) => void;
  private onHandoffEnd?: (peerId: string, id: string) => void;
  private readonly isLocalMachine: (remoteAddress: string | undefined) => boolean;

  public readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly connectionsPerNetwork = new Map<string, number>();
  private readonly pausedRelaySenders = new Map<string, { targetPeerId: string; cleanup: () => void }>();
  private readonly pingTimer: NodeJS.Timeout;
  private readonly clipboardMonitor: HostClipboardMonitor | null;
  private backgroundClipboardActive = false;
  private backgroundClipboardSink: ((text: string) => void) | null = null;
  private backgroundClipboardImageSink: ((imageDataUrl: string, imageName?: string) => void) | null = null;
  private getLanUrls: () => string[];
  private getLanEndpoints: () => LanEndpoint[];
  private getHostFirewall: () => HostFirewallStatus | null;
  private readonly recentRemotes = new Map<string, number>();
  private getTlsPin: () => string | null;
  private readonly serverVersion: string | undefined;
  private getDaemonStatus: () => LocalDaemonStatus;
  private onHostPairCodeChange?: (pairCode: string) => void;

  constructor(opts: {
    getLanUrls: () => string[];
    /** Detailed form of getLanUrls (same order). Defaults to URL-only entries. */
    getLanEndpoints?: () => LanEndpoint[];
    getHostFirewall?: () => HostFirewallStatus | null;
    getTlsPin?: () => string | null;
    /** Build version, sent in welcome (stale UI pages reload on mismatch). */
    serverVersion?: string;
    getDaemonStatus: () => LocalDaemonStatus;
    clipboardProvider?: HostClipboardProvider | null;
    clipboardPollMs?: number;
    onHostPairCodeChange?: (pairCode: string) => void;
    /** Called after each wrong code; the count covers the limiter window (all addresses). */
    onPakeFailure?: (recentFailures: number) => void;
    /** Relay rendezvous handed to code-authenticated devices (null = no relay configured). */
    getRelayOffer?: () => RelayOffer | null;
    /** Hotspot-handoff keys for code-authenticated devices (null = handoff off). */
    getHandoffInfo?: (vouchKey: Uint8Array, peerId: string) => HandoffInfo | null;
    /** A code-authenticated device sent a sealed hotspot offer. */
    onHandoffOffer?: (peerId: string, envelope: Uint8Array) => void;
    onHandoffEnd?: (peerId: string, id: string) => void;
    /** Override "is this socket from the hub computer itself" (tests). */
    isLocalMachine?: (remoteAddress: string | undefined) => boolean;
  }) {
    this.isLocalMachine = opts.isLocalMachine ?? isLocalMachineAddress;
    this.onPakeFailure = opts.onPakeFailure;
    this.getRelayOffer = opts.getRelayOffer ?? (() => null);
    this.getHandoffInfo = opts.getHandoffInfo ?? (() => null);
    this.onHandoffOffer = opts.onHandoffOffer;
    this.onHandoffEnd = opts.onHandoffEnd;
    this.getLanUrls = opts.getLanUrls;
    this.getHostFirewall = opts.getHostFirewall ?? (() => null);
    this.getLanEndpoints =
      opts.getLanEndpoints ??
      (() =>
        this.getLanUrls().map((url) => {
          let address = url;
          try { address = new URL(url).hostname; } catch { /* keep raw */ }
          return { url, address, interface: '', kind: 'other' as const };
        }));
    this.getTlsPin = opts.getTlsPin ?? (() => null);
    this.serverVersion = opts.serverVersion;
    this.getDaemonStatus = opts.getDaemonStatus;
    this.onHostPairCodeChange = opts.onHostPairCodeChange;
    this.clipboardMonitor =
      opts.clipboardProvider && opts.clipboardProvider.isSupported()
        ? new HostClipboardMonitor({
            provider: opts.clipboardProvider,
            pollIntervalMs: opts.clipboardPollMs,
            onClipboardChange: (text) => this.deliverHostClipboard(text),
            onClipboardImageChange: (imageDataUrl, imageName) => this.deliverHostClipboardImage(imageDataUrl, imageName),
          })
        : null;

    // Disable perMessageDeflate: encrypted AES-GCM binary frames are incompressible;
    // skipping zlib cuts CPU load dramatically and maximizes relay throughput.
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024, // 16 MB max frame
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    this.pingTimer = setInterval(() => {
      for (const [peerId, client] of this.clients.entries()) {
        const rawSock = getWsRawSocket(client.ws);
        const bytesWritten = rawSock?.bytesWritten ?? 0;
        if (!client.isAlive) {
          const drainingRelay = (client.ws.bufferedAmount ?? 0) > 0 && bytesWritten > client.lastBytesWritten;
          if (!drainingRelay) {
            client.missedPings += 1;
          }
          client.lastBytesWritten = bytesWritten;
          if (client.missedPings >= 3) {
            this.heartbeatTimeouts += 1;
            this.releaseRelayBackpressureForPeer(peerId);
            client.ws.terminate();
            this.clients.delete(peerId);
            this.broadcastPeerUpdatesFor(client);
            this.syncClipboardWatchState();
            continue;
          }
        } else {
          client.missedPings = 0;
          client.lastBytesWritten = bytesWritten;
        }
        client.isAlive = false;
        try {
          client.ws.ping();
        } catch {
          // ignore
        }
      }
    }, 25_000);
    this.pingTimer.unref();
  }

  /** Pair code embedded in the startup QR (shared by host desktop clients). */
  getDefaultPairCode(): string {
    return this.hostPairCode;
  }

  /**
   * Codes of rooms this hub issued (host room first). A hotspot offer must be
   * authenticated with one of them.
   */
  getRoomCodes(): string[] {
    const codes = new Set<string>([this.hostPairCode]);
    for (const entry of this.pairCodeByPeer.values()) codes.add(entry.pairCode);
    return [...codes];
  }

  /**
   * Whether `code` matches an active room (host room, any currently connected
   * peer's room, or any room authenticated via host/PAKE). Unverified legacy
   * guesses are not treated as active rooms.
   */
  private isKnownActiveRoom(code: string): boolean {
    if (code === this.hostPairCode) return true;
    for (const client of this.clients.values()) {
      if (client.pairCode === code && (client.admission === 'host' || client.admission === 'pake')) {
        return true;
      }
    }
    return false;
  }

  /** Send a control message to one connected peer; false if it is not connected. */
  sendToPeer(peerId: string, msg: ServerToClientMessage): boolean {
    const client = this.clients.get(peerId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
    this.sendJson(client.ws, msg);
    return true;
  }

  /** The daemon's persisted group must also be the startup QR's group. */
  setDefaultPairCode(raw: string): void {
    const code = normalizePairCode(raw);
    if (isValidPairCode(code)) this.hostPairCode = code;
  }

  /** Generate a room code that cannot accidentally merge unrelated active rooms. */
  private generateUnusedPairCode(except?: string): string {
    const occupied = new Set<string>([this.hostPairCode]);
    for (const client of this.clients.values()) {
      if (client.pairCode !== except) occupied.add(client.pairCode);
    }
    // With a 32^6 code space a collision is extraordinarily unlikely; bounded
    // retries keep connection/rotation work predictable even under stress.
    for (let attempt = 0; attempt < 64; attempt++) {
      const candidate = generatePairCode(crypto.randomBytes(8));
      if (!occupied.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique pairing code');
  }

  private rememberPairCode(peerId: string, pairCode: string, remote: string): void {
    if (this.pairCodeByPeer.size >= 512) {
      const oldest = this.pairCodeByPeer.keys().next().value;
      if (oldest !== undefined) this.pairCodeByPeer.delete(oldest);
    }
    this.pairCodeByPeer.set(peerId, { pairCode, remote });
  }

  /**
   * Room a code-authenticated joiner targets. The host room wins, then the
   * most recently joined room; the nameplate is only a hint (8 bits), the
   * SPAKE2 exchange decides.
   */
  private roomForNameplate(nameplate: string): string | null {
    if (nameplateFor(this.hostPairCode) === nameplate) return this.hostPairCode;
    let best: ConnectedClient | null = null;
    for (const client of this.clients.values()) {
      if (nameplateFor(client.pairCode) !== nameplate) continue;
      if (!best || client.connectedAt > best.connectedAt) best = client;
    }
    if (best) return best.pairCode;
    // Rooms that emptied out (everyone reconnecting) are still known to the
    // hub that issued them; newest first.
    const remembered = [...this.pairCodeByPeer.values()].reverse();
    return remembered.find((entry) => nameplateFor(entry.pairCode) === nameplate)?.pairCode ?? null;
  }

  public getStats(): { connectedPeers: number } {
    return { connectedPeers: this.clients.size };
  }

  public getTelemetry(): {
    pakeFailures: number;
    rateLimitedCount: number;
    legacyBlockedCount: number;
    relayDrops: number;
    relayDroppedFrames: number;
    relayBackpressurePauses: number;
    relayBackpressureResumes: number;
    relayMaxBufferedBytes: number;
    heartbeatTimeouts: number;
  } {
    return {
      pakeFailures: this.pakeLimiter.recentFailures(),
      rateLimitedCount: this.rateLimitedCount,
      legacyBlockedCount: this.legacyBlockedCount,
      relayDrops: this.relayDrops,
      relayDroppedFrames: this.relayDroppedFrames,
      relayBackpressurePauses: this.relayBackpressurePauses,
      relayBackpressureResumes: this.relayBackpressureResumes,
      relayMaxBufferedBytes: this.relayMaxBufferedBytes,
      heartbeatTimeouts: this.heartbeatTimeouts,
    };
  }

  public getClipboardTelemetry(): HostClipboardTelemetry | null {
    return this.clipboardMonitor?.getTelemetry() ?? null;
  }

  /** Diagnostics: connected devices without secrets (no pair codes or keys). */
  public describeClients(): {
    name: string;
    formFactor: string;
    platform: string;
    model: string;
    remoteAddress: string;
    loopback: boolean;
    connectedSeconds: number;
    admission: Admission;
    visibility: VisibilityMode;
    viaReverse: boolean;
    viaRelayed: boolean;
    bufferedAmount: number;
  }[] {
    const now = Date.now();
    return [...this.clients.values()].map((c) => ({
      name: c.device.name,
      formFactor: c.device.formFactor,
      model: c.device.model,
      platform: c.device.platform,
      remoteAddress: c.remoteAddress,
      loopback: c.isLoopback,
      connectedSeconds: Math.round((now - c.connectedAt) / 1000),
      admission: c.admission,
      visibility: c.visibility,
      viaReverse: c.viaReverse,
      viaRelayed: c.viaRelayed,
      bufferedAmount: c.ws.bufferedAmount ?? 0,
    }));
  }

  public close(): void {
    clearInterval(this.pingTimer);
    for (const entry of [...this.pausedRelaySenders.values()]) {
      entry.cleanup();
    }
    this.pausedRelaySenders.clear();
    this.clipboardMonitor?.close();
    for (const ws of this.wss.clients) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.wss.close();
  }

  private isHostDesktopClient(client: ConnectedClient): boolean {
    return (
      client.isLoopback &&
      (client.device.platform === 'macos' ||
       client.device.platform === 'windows' ||
       client.device.platform === 'linux' ||
       client.device.formFactor === 'laptop' ||
       client.device.formFactor === 'desktop' ||
       client.device.model === 'AirBridge service') &&
      client.device.platform !== 'android' &&
      client.device.platform !== 'ios'
    );
  }

  private resolveClientDaemonStatus(client: ConnectedClient): LocalDaemonStatus {
    if (!this.isHostDesktopClient(client)) {
      return {
        enabled: false,
        platform: 'remote',
        hostname: '',
        autoSaveToDownloads: false,
        clipboardBridge: false,
      };
    }
    return {
      ...this.getDaemonStatus(),
      clipboardBridge: Boolean(this.clipboardMonitor?.isSupported()),
    };
  }

  public hasHostClipboardBridge(): boolean {
    return Boolean(this.clipboardMonitor?.isSupported());
  }

  /** Keeps the OS clipboard watcher alive for the daemon's headless peer. */
  public setBackgroundClipboardActive(
    active: boolean,
    sink?: (text: string) => void,
    imageSink?: (imageDataUrl: string, imageName?: string) => void,
  ): void {
    this.backgroundClipboardActive = active;
    this.backgroundClipboardSink = active ? sink ?? this.backgroundClipboardSink : null;
    this.backgroundClipboardImageSink = active ? imageSink ?? this.backgroundClipboardImageSink : null;
    this.syncClipboardWatchState();
  }

  /** Writes an incoming beam to the host OS clipboard without echoing it back. */
  public async writeHostClipboard(text: string): Promise<boolean> {
    return (await this.clipboardMonitor?.writeClipboard(text)) ?? false;
  }

  public async writeHostClipboardImage(imageDataUrl: string): Promise<boolean> {
    return (await this.clipboardMonitor?.writeImage(imageDataUrl)) ?? false;
  }

  private syncClipboardWatchState(): void {
    if (!this.clipboardMonitor) return;
    let hasActiveHostClient = false;
    for (const client of this.clients.values()) {
      if (this.isHostDesktopClient(client) && client.ws.readyState === WebSocket.OPEN) {
        hasActiveHostClient = true;
        break;
      }
    }
    this.clipboardMonitor.setShouldWatch(hasActiveHostClient || this.backgroundClipboardActive);
  }

  private deliverHostClipboard(text: string): void {
    if (this.backgroundClipboardActive && this.backgroundClipboardSink) {
      this.backgroundClipboardSink(text);
      return;
    }
    let target: ConnectedClient | null = null;
    for (const client of this.clients.values()) {
      if (this.isHostDesktopClient(client) && client.ws.readyState === WebSocket.OPEN) {
        if (!target || client.connectedAt >= target.connectedAt) {
          target = client;
        }
      }
    }
    if (target) {
      this.sendJson(target.ws, {
        type: 'host-clipboard',
        text,
        contentType: 'text',
        timestamp: Date.now(),
      });
    }
  }

  public deliverHostClipboardImage(imageDataUrl: string, imageName?: string): number {
    if (!isValidClipboardImageDataUrl(imageDataUrl)) return 0;
    if (this.backgroundClipboardActive && this.backgroundClipboardImageSink) {
      this.backgroundClipboardImageSink(imageDataUrl, imageName);
      return 1;
    }
    let target: ConnectedClient | null = null;
    for (const client of this.clients.values()) {
      if (this.isHostDesktopClient(client) && client.ws.readyState === WebSocket.OPEN) {
        if (!target || client.connectedAt >= target.connectedAt) {
          target = client;
        }
      }
    }
    if (target) {
      this.sendJson(target.ws, {
        type: 'host-clipboard',
        imageDataUrl,
        imageName,
        contentType: 'image',
        timestamp: Date.now(),
      });
      return 1;
    }
    return 0;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const relayed = isRelayedPeer(req.socket);
    const reversed = isReversePeer(req.socket);
    const connectionTag = relayed ? generatePeerId() : undefined;
    const networkKey = deriveNetworkKey(req, connectionTag);
    // A phone this server dialled (reverse connection) is never "this machine".
    const isLoopback = !reversed && !relayed && this.isLocalMachine(req.socket.remoteAddress);
    let registeredClient: ConnectedClient | null = null;
    // Count even sockets which have not sent hello; otherwise an idle client
    // can bypass both limits and retain unbounded upgraded connections.
    const perNetwork = this.connectionsPerNetwork.get(networkKey) ?? 0;
    let activeWsCount = 0;
    for (const c of this.wss.clients) {
      if (c !== ws && (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING)) {
        activeWsCount++;
      }
    }
    if (activeWsCount >= MAX_CLIENTS || perNetwork >= MAX_CLIENTS_PER_NETWORK) {
      ws.close(1013, 'Server busy'); return;
    }
    this.connectionsPerNetwork.set(networkKey, perNetwork + 1);
    const helloTimeout = setTimeout(() => { if (!registeredClient) ws.terminate(); }, 10_000);
    helloTimeout.unref();
    ws.once('close', () => {
      clearTimeout(helloTimeout);
      const remaining = (this.connectionsPerNetwork.get(networkKey) ?? 1) - 1;
      if (remaining > 0) this.connectionsPerNetwork.set(networkKey, remaining);
      else this.connectionsPerNetwork.delete(networkKey);
    });

    ws.on('pong', () => {
      if (registeredClient) {
        registeredClient.isAlive = true;
        registeredClient.missedPings = 0;
      }
    });

    const remoteAddress = normalizeRemote(req.socket.remoteAddress);
    let pendingPake: PendingPake | null = null;
    let pakeTimeout: ReturnType<typeof setTimeout> | null = null;
    ws.once('close', () => {
      if (pakeTimeout) clearTimeout(pakeTimeout);
      if (pendingPake && !registeredClient) this.pakeLimiter.fail(remoteAddress);
      pendingPake = null;
    });

    const admit = (
      hello: Extract<ClientToServerMessage, { type: 'hello' }>,
      device: DeviceProfile,
      admission: Admission,
      room: string | undefined,
      vouchKey: Uint8Array | undefined,
      announceHostCode: boolean,
    ): void => {
      let peerId = sanitizePeerId(hello.peerId);
      if (this.clients.has(peerId) && this.clients.get(peerId)?.ws !== ws) {
        peerId = generatePeerId();
      }
      const candidate = { isLoopback, device } as ConnectedClient;
      const pairCode = room ?? (this.isHostDesktopClient(candidate) ? this.hostPairCode : this.generateUnusedPairCode());
      this.rememberPairCode(peerId, pairCode, remoteAddress);

      registeredClient = {
        peerId,
        ws,
        networkKey: relayed ? `net:relayed:${peerId}` : networkKey,
        isLoopback,
        pairCode,
        visibility: hello.visibility === 'paired-only' || hello.visibility === 'hidden' ? hello.visibility : 'nearby',
        device,
        connectedAt: Date.now(),
        isAlive: true,
        missedPings: 0,
        lastBytesWritten: getWsRawSocket(ws)?.bytesWritten ?? 0,
        joinPairAttempts: [],
        remoteAddress,
        admission,
        vouchKey,
        viaReverse: reversed,
        viaRelayed: relayed,
      };
      // Only phone apps run the reverse listener; remember where they were.
      if (!isLoopback && !relayed && registeredClient.remoteAddress && device.platform === 'android') {
        this.recentRemotes.set(registeredClient.remoteAddress, Date.now());
        if (this.recentRemotes.size > 32) this.recentRemotes.delete(this.recentRemotes.keys().next().value!);
      }

      this.clients.set(peerId, registeredClient);
      this.syncClipboardWatchState();
      if (announceHostCode && isLoopback && device.model !== 'AirBridge service') {
        this.onHostPairCodeChange?.(pairCode);
      }

      const tlsPin = this.getTlsPin();
      this.sendJson(ws, {
        type: 'welcome',
        peerId,
        pairCode,
        admission,
        ...(vouchKey ? { hubProof: hubProof(vouchKey, { peerId, pairCode, tlsPin }) } : {}),
        // The relay token is a capability: only for devices that proved the code.
        ...(admission === 'pake' ? { relay: this.getRelayOffer() } : {}),
        ...(admission === 'pake' && vouchKey ? { handoff: this.getHandoffInfo(vouchKey, peerId) } : {}),
        lanUrls: this.getLanUrls(),
        lanEndpoints: this.getLanEndpoints(),
        tlsPin,
        hostFirewall: this.getHostFirewall(),
        ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}),
        localDaemon: this.resolveClientDaemonStatus(registeredClient),
        peers: this.computeVisiblePeers(registeredClient),
      });

      this.broadcastPeerUpdatesFor(registeredClient);
    };

    ws.on('message', (data, isBinary) => {
      if (registeredClient) {
        registeredClient.isAlive = true;
        registeredClient.missedPings = 0;
      }

      if (isBinary) {
        if (!registeredClient) return;
        this.routeBinaryFrame(registeredClient, data);
        return;
      }

      let msg: ClientToServerMessage;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientToServerMessage;
        if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') throw new Error('bad frame');
      } catch {
        this.sendJson(ws, { type: 'error', code: 'BAD_JSON', message: 'Invalid JSON frame' });
        return;
      }

      if (msg.type === 'hello') {
        if (registeredClient || pendingPake) { ws.close(1008, 'Already registered'); return; }
        clearTimeout(helloTimeout);
        const device = sanitizeDeviceProfile(msg.device);
        if (!device) {
          this.sendJson(ws, { type: 'error', code: 'INVALID_DEVICE', message: 'Device profile or public key is invalid.' });
          ws.close(1008, 'Invalid device profile');
          return;
        }
        if (msg.pake !== undefined) {
          // Code-authenticated join: the code itself never crosses the wire.
          const pake = sanitizePakeHello(msg.pake);
          if (!pake) {
            this.pakeLimiter.fail(remoteAddress);
            this.onPakeFailure?.(this.pakeLimiter.recentFailures());
            this.sendJson(ws, { type: 'error', code: 'BAD_PAKE', message: 'Unsupported pairing handshake.' });
            ws.close(1008, 'Bad PAKE');
            return;
          }
          if (!this.pakeLimiter.allows(remoteAddress)) {
            this.rateLimitedCount++;
            this.sendJson(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many wrong pairing codes. Wait a few minutes and try again.' });
            ws.close(1008, 'Rate limited');
            return;
          }
          const matched = this.roomForNameplate(pake.nameplate);
          const room = matched ?? generatePairCode(crypto.randomBytes(8));
          const party = new Spake2(
            'B',
            passwordScalar(room),
            joinerSpake2Identity(device.publicKey, device.identityKey),
            HUB_SPAKE2_IDENTITY,
            JOIN_SPAKE2_AAD,
          );
          let result: Spake2Result;
          try {
            result = party.finish(Buffer.from(pake.share, 'base64url'));
          } catch {
            this.pakeLimiter.fail(remoteAddress);
            this.onPakeFailure?.(this.pakeLimiter.recentFailures());
            this.sendJson(ws, { type: 'error', code: 'BAD_PAKE', message: 'Invalid pairing handshake.' });
            ws.close(1008, 'Bad PAKE');
            return;
          }
          pendingPake = { hello: msg, device, room, decoy: !matched, result };
          // A joiner that sees a bad confirmation hangs up without answering;
          // an abandoned exchange therefore counts as a wrong guess too.
          pakeTimeout = setTimeout(() => {
            if (pendingPake && !registeredClient) { this.pakeLimiter.fail(remoteAddress); ws.terminate(); }
          }, 15_000);
          pakeTimeout.unref();
          this.sendJson(ws, {
            type: 'pake-challenge',
            share: Buffer.from(party.share()).toString('base64url'),
            confirm: Buffer.from(result.confirm).toString('base64url'),
          });
          return;
        }

        const requestedPair = msg.pairCode ? normalizePairCode(msg.pairCode) : '';
        const hasRequestedPair = isValidPairCode(requestedPair);
        if (hasRequestedPair && !isLoopback) {
          if (!this.pakeLimiter.allows(remoteAddress)) {
            this.rateLimitedCount++;
            this.legacyBlockedCount++;
            this.sendJson(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many pairing attempts. Wait a few minutes and try again.' });
            ws.close(1008, 'Rate limited');
            return;
          }
          if (!this.isKnownActiveRoom(requestedPair)) {
            this.pakeLimiter.fail(remoteAddress);
            this.legacyBlockedCount++;
            this.onPakeFailure?.(this.pakeLimiter.recentFailures());
          }
        }
        let room: string | undefined;
        if (hasRequestedPair) {
          room = requestedPair;
        } else {
          // Reconnect continuity without a code: only for this machine or the
          // same source address. Peer ids are visible to nearby devices, so an
          // id alone must never grant membership of someone else's room.
          const remembered = this.pairCodeByPeer.get(sanitizePeerId(msg.peerId));
          if (remembered && (isLoopback || remembered.remote === remoteAddress)) room = remembered.pairCode;
        }
        admit(msg, device, isLoopback ? 'host' : 'legacy', room, undefined, hasRequestedPair);
        return;
      }

      if (msg.type === 'pake-confirm') {
        if (registeredClient || !pendingPake) { ws.close(1008, 'Unexpected confirmation'); return; }
        const pending = pendingPake;
        pendingPake = null;
        if (pakeTimeout) clearTimeout(pakeTimeout);
        let confirm: Buffer | null = null;
        if (typeof msg.confirm === 'string' && /^[A-Za-z0-9_-]{43}$/.test(msg.confirm)) confirm = Buffer.from(msg.confirm, 'base64url');
        const ok = !pending.decoy && confirm !== null && constantTimeEqual(confirm, pending.result.expectedPeerConfirm);
        if (!ok) {
          this.pakeLimiter.fail(remoteAddress);
          this.onPakeFailure?.(this.pakeLimiter.recentFailures());
          this.sendJson(ws, { type: 'error', code: 'PAIR_CODE_MISMATCH', message: 'The pairing code does not match this computer.' });
          ws.close(1008, 'Pairing code mismatch');
          return;
        }
        admit(pending.hello, pending.device, isLoopback ? 'host' : 'pake', pending.room, vouchKeyFrom(pending.result.ke), false);
        return;
      }

      if (!registeredClient) {
        this.sendJson(ws, { type: 'error', code: 'NOT_REGISTERED', message: 'Send hello first' });
        return;
      }

      switch (msg.type) {
        case 'update-profile': {
          const device = sanitizeDeviceProfile(msg.device);
          if (!device) break;
          // Keys are fixed at admission (they are bound into the SPAKE2
          // transcript and the peers' vouches). New keys need a new connection.
          const { publicKey, identityKey, identitySig } = registeredClient.device;
          registeredClient.device = { ...device, publicKey, identityKey, identitySig };
          if (!identityKey) { delete registeredClient.device.identityKey; delete registeredClient.device.identitySig; }
          if (msg.visibility === 'nearby' || msg.visibility === 'paired-only' || msg.visibility === 'hidden') {
            registeredClient.visibility = msg.visibility;
          }
          this.syncClipboardWatchState();
          this.broadcastPeerUpdatesFor(registeredClient);
          break;
        }

        case 'join-pair': {
          const nowMs = Date.now();
          registeredClient.joinPairAttempts = registeredClient.joinPairAttempts.filter((t) => nowMs - t < JOIN_PAIR_WINDOW_MS);
          if (
            registeredClient.joinPairAttempts.length >= MAX_JOIN_PAIR_PER_WINDOW ||
            (!registeredClient.isLoopback && !this.pakeLimiter.allows(registeredClient.remoteAddress))
          ) {
            this.rateLimitedCount++;
            this.legacyBlockedCount++;
            this.sendJson(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many pair attempts. Wait a minute and try again.' });
            return;
          }
          registeredClient.joinPairAttempts.push(nowMs);
          const normalized = normalizePairCode(msg.pairCode);
          if (!isValidPairCode(normalized)) {
            if (!registeredClient.isLoopback) {
              this.pakeLimiter.fail(registeredClient.remoteAddress);
            }
            this.sendJson(ws, {
              type: 'error',
              code: 'INVALID_PAIR_CODE',
              message: 'Pair code must be 6 valid characters.',
            });
            return;
          }
          if (!registeredClient.isLoopback) {
            if (!this.isKnownActiveRoom(normalized)) {
              this.pakeLimiter.fail(registeredClient.remoteAddress);
              this.legacyBlockedCount++;
              this.onPakeFailure?.(this.pakeLimiter.recentFailures());
            }
          }
          const prevPairCode = registeredClient.pairCode;
          registeredClient.pairCode = normalized;
          this.rememberPairCode(registeredClient.peerId, normalized, registeredClient.remoteAddress);
          if (registeredClient.isLoopback && registeredClient.device.model !== 'AirBridge service') {
            this.onHostPairCodeChange?.(normalized);
          }
          this.sendJson(ws, {
            type: 'pair-updated',
            pairCode: normalized,
            peers: this.computeVisiblePeers(registeredClient),
          });
          this.broadcastToPairCode(prevPairCode);
          this.broadcastPeerUpdatesFor(registeredClient);
          break;
        }

        case 'rotate-pair': {
          const prevPairCode = registeredClient.pairCode;
          const fresh = this.generateUnusedPairCode(prevPairCode);

          if (this.isHostDesktopClient(registeredClient)) {
            this.hostPairCode = fresh;
            this.onHostPairCodeChange?.(fresh);
            for (const client of this.clients.values()) {
              if (this.isHostDesktopClient(client) && client.pairCode === prevPairCode) {
                client.pairCode = fresh;
                this.rememberPairCode(client.peerId, fresh, client.remoteAddress);
                this.sendJson(client.ws, {
                  type: 'pair-updated',
                  pairCode: fresh,
                  peers: this.computeVisiblePeers(client),
                });
              }
            }
          } else {
            registeredClient.pairCode = fresh;
            this.rememberPairCode(registeredClient.peerId, fresh, registeredClient.remoteAddress);
            this.sendJson(ws, {
              type: 'pair-updated',
              pairCode: fresh,
              peers: this.computeVisiblePeers(registeredClient),
            });
          }

          this.broadcastToPairCode(prevPairCode);
          this.broadcastPeerUpdatesFor(registeredClient);
          break;
        }

        case 'rtc-signal': {
          if (typeof msg.to !== 'string' || !msg.signal || typeof msg.signal !== 'object' || JSON.stringify(msg.signal).length > 64_000) break;
          const target = this.clients.get(msg.to);
          if (target && this.canCommunicate(registeredClient, target)) {
            this.sendJson(target.ws, {
              type: 'rtc-signal',
              from: registeredClient.peerId,
              signal: msg.signal,
            });
          }
          break;
        }

        case 'transfer-control': {
          // SECURITY: unencrypted control frames may only be ping/pong.
          // Previously ANY payload (transfer-offer, clipboard-beam,
          // history-sync, accept/decline/cancel) was relayed in plaintext,
          // so any peer could inject clipboard text or forge transfer
          // decisions without holding the ECDH session key.
          const env = msg.envelope as { encrypted?: unknown; payload?: { kind?: unknown }; ciphertext?: unknown } | undefined;
          if (!env || typeof env !== 'object') break;
          if (env.encrypted === false) {
            if (env.payload?.kind !== 'ping' && env.payload?.kind !== 'pong') {
              this.sendJson(ws, { type: 'error', code: 'ENCRYPTION_REQUIRED', message: 'Control messages must be end-to-end encrypted.' });
              break;
            }
          } else if (env.encrypted === true) {
            if (typeof env.ciphertext !== 'string' || env.ciphertext.length > 10_000_000) break;
          } else break;
          if (typeof msg.to !== 'string') break;
          const target = this.clients.get(msg.to);
          if (target && this.canCommunicate(registeredClient, target)) {
            this.sendJson(target.ws, {
              type: 'transfer-control',
              from: registeredClient.peerId,
              envelope: msg.envelope,
            });
          }
          break;
        }

        case 'handoff-offer': {
          // Only devices that proved the code got the handoff key; others cannot
          // make a valid offer, but refuse early and rate-limit everyone.
          if (registeredClient.admission !== 'pake' || !this.onHandoffOffer) {
            this.sendJson(ws, { type: 'error', code: 'HANDOFF_UNAVAILABLE', message: 'Direct links need a device paired with the code.' });
            break;
          }
          const now = Date.now();
          const attempts = (registeredClient.handoffAttempts ?? []).filter((t) => now - t < 60_000);
          attempts.push(now);
          registeredClient.handoffAttempts = attempts;
          if (attempts.length > 6) {
            this.sendJson(ws, { type: 'error', code: 'HANDOFF_RATE_LIMITED', message: 'Too many direct-link requests; wait a minute.' });
            break;
          }
          if (typeof msg.envelope !== 'string' || msg.envelope.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(msg.envelope)) {
            this.sendJson(ws, { type: 'error', code: 'BAD_HANDOFF', message: 'Malformed direct-link request.' });
            break;
          }
          this.onHandoffOffer(registeredClient.peerId, new Uint8Array(Buffer.from(msg.envelope, 'base64url')));
          break;
        }

        case 'handoff-end': {
          if (registeredClient.admission === 'pake' && typeof msg.id === 'string' && /^[0-9a-f]{16}$/.test(msg.id)) {
            this.onHandoffEnd?.(registeredClient.peerId, msg.id);
          }
          break;
        }

        case 'set-host-clipboard': {
          if (!this.isHostDesktopClient(registeredClient)) break;
          if (typeof msg.imageDataUrl === 'string' && isValidClipboardImageDataUrl(msg.imageDataUrl)) {
            this.writeHostClipboardImage(msg.imageDataUrl).catch(() => {});
          } else if (
            typeof msg.text === 'string' &&
            msg.text.length > 0 &&
            msg.text.length <= 512_000
          ) {
            this.writeHostClipboard(msg.text).catch(() => {});
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (registeredClient && this.clients.get(registeredClient.peerId)?.ws === ws) {
        this.releaseRelayBackpressureForPeer(registeredClient.peerId);
        this.clients.delete(registeredClient.peerId);
        this.syncClipboardWatchState();
        this.broadcastPeerUpdatesFor(registeredClient);
      }
    });

    ws.on('error', () => {
      // Handled by close
    });
  }

  private releaseRelayBackpressureForPeer(peerId: string): void {
    const senderEntry = this.pausedRelaySenders.get(peerId);
    if (senderEntry) senderEntry.cleanup();
    for (const entry of [...this.pausedRelaySenders.values()]) {
      if (entry.targetPeerId === peerId) entry.cleanup();
    }
  }

  private applyRelayBackpressure(sender: ConnectedClient, target: ConnectedClient): void {
    if (this.pausedRelaySenders.has(sender.peerId)) return;
    const senderSock = getWsRawSocket(sender.ws);
    if (!senderSock || typeof senderSock.pause !== 'function') return;
    if (
      target.ws.readyState !== WebSocket.OPEN ||
      sender.ws.readyState !== WebSocket.OPEN ||
      senderSock.destroyed
    ) {
      return;
    }
    const targetSock = getWsRawSocket(target.ws);

    if (typeof sender.ws.pause === 'function') {
      sender.ws.pause();
    } else {
      senderSock.pause();
    }
    this.relayBackpressurePauses += 1;

    let cleaned = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const checkOrResume = () => {
      if (cleaned) return;
      const buffered = target.ws.bufferedAmount ?? 0;
      if (
        target.ws.readyState !== WebSocket.OPEN ||
        sender.ws.readyState !== WebSocket.OPEN ||
        senderSock.destroyed ||
        buffered <= RELAY_BACKPRESSURE_LOW_WATER
      ) {
        cleanup();
      }
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      targetSock?.removeListener?.('drain', checkOrResume);
      target.ws.removeListener('close', cleanup);
      sender.ws.removeListener('close', cleanup);
      this.pausedRelaySenders.delete(sender.peerId);
      if (!senderSock.destroyed) {
        if (typeof sender.ws.resume === 'function') {
          sender.ws.resume();
        } else if (typeof senderSock.resume === 'function') {
          senderSock.resume();
        }
      }
      this.relayBackpressureResumes += 1;
    };

    this.pausedRelaySenders.set(sender.peerId, { targetPeerId: target.peerId, cleanup });
    targetSock?.on?.('drain', checkOrResume);
    target.ws.once('close', cleanup);
    sender.ws.once('close', cleanup);
    pollTimer = setInterval(checkOrResume, 50);
    pollTimer.unref();
  }

  private routeBinaryFrame(
    sender: ConnectedClient,
    data: Buffer | ArrayBuffer | Buffer[]
  ): void {
    const bytes: Uint8Array = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Buffer.concat(data);
    if (bytes.byteLength < ROUTING_HEADER_LENGTH || bytes[0] !== FRAME_ROUTED_RELAY) {
      return;
    }
    const { targetPeerId } = unwrapRoutedRelayFrame(bytes);
    const target = this.clients.get(targetPeerId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!this.canCommunicate(sender, target)) {
      return;
    }

    const currentBuffered = target.ws.bufferedAmount ?? 0;
    if (currentBuffered > this.relayMaxBufferedBytes) {
      this.relayMaxBufferedBytes = currentBuffered;
    }

    // Hard safety cap preserved to bound memory under runaway slow readers.
    if (target.ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
      this.relayDrops++;
      this.relayDroppedFrames++;
      this.releaseRelayBackpressureForPeer(target.peerId);
      target.ws.terminate();
      return;
    }
    // Stamp authenticated sender peerId in-place so sourcePeerId can never be forged
    overwriteRoutedSourcePeerId(bytes, sender.peerId);

    target.ws.send(bytes, { binary: true });

    const afterSendBuffered = target.ws.bufferedAmount ?? 0;
    if (afterSendBuffered > this.relayMaxBufferedBytes) {
      this.relayMaxBufferedBytes = afterSendBuffered;
    }
    if (afterSendBuffered >= RELAY_BACKPRESSURE_HIGH_WATER) {
      this.applyRelayBackpressure(sender, target);
    }
  }

  private canCommunicate(a: ConnectedClient, b: ConnectedClient): boolean {
    if (a.peerId === b.peerId) return false;
    if (a.visibility === 'hidden' || b.visibility === 'hidden') return false;
    if (a.pairCode === b.pairCode) return true;
    if (a.networkKey === b.networkKey && a.visibility === 'nearby' && b.visibility === 'nearby') {
      return true;
    }
    return false;
  }

  private describePeer(viewer: ConnectedClient, candidate: ConnectedClient, discoveryScope: PeerSummary['discoveryScope']): PeerSummary {
    const summary: PeerSummary = {
      peerId: candidate.peerId,
      device: candidate.device,
      discoveryScope,
      connectedAt: candidate.connectedAt,
      attestation: candidate.admission,
    };
    if (viewer.vouchKey) {
      summary.vouch = peerVouch(viewer.vouchKey, {
        peerId: candidate.peerId,
        publicKey: candidate.device.publicKey,
        identityKey: candidate.device.identityKey,
        attestation: candidate.admission,
      });
    }
    return summary;
  }

  private computeVisiblePeers(viewer: ConnectedClient): PeerSummary[] {
    if (viewer.visibility === 'hidden') return [];
    const peers: PeerSummary[] = [];

    for (const candidate of this.clients.values()) {
      if (candidate.peerId === viewer.peerId) continue;
      if (candidate.visibility === 'hidden') continue;

      if (candidate.pairCode === viewer.pairCode) {
        peers.push(this.describePeer(viewer, candidate, 'paired'));
      } else if (
        candidate.networkKey === viewer.networkKey &&
        viewer.visibility === 'nearby' &&
        candidate.visibility === 'nearby'
      ) {
        peers.push(this.describePeer(viewer, candidate, 'nearby'));
      }
    }

    return peers;
  }

  private broadcastPeerUpdatesFor(changed: ConnectedClient): void {
    for (const client of this.clients.values()) {
      if (
        client.networkKey === changed.networkKey ||
        client.pairCode === changed.pairCode ||
        client.peerId === changed.peerId
      ) {
        if (client.ws.readyState === WebSocket.OPEN) {
          this.sendJson(client.ws, {
            type: 'peers',
            peers: this.computeVisiblePeers(client),
          });
        }
      }
    }
  }

  private broadcastToPairCode(pairCode: string): void {
    for (const client of this.clients.values()) {
      if (client.pairCode === pairCode && client.ws.readyState === WebSocket.OPEN) {
        this.sendJson(client.ws, {
          type: 'peers',
          peers: this.computeVisiblePeers(client),
        });
      }
    }
  }

  /**
   * Tell every connected client that the computer's reachable addresses
   * changed, so an open pairing QR is regenerated and phones learn the new
   * endpoint before their current path disappears.
   */
  /** A registered, open client is connected from this address. */
  hasClientFrom(address: string): boolean {
    const want = normalizeRemote(address);
    for (const client of this.clients.values()) {
      if (client.remoteAddress === want && client.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /** Non-loopback addresses peers connected from within [maxAgeMs] (reverse-dial candidates). */
  recentRemoteAddresses(maxAgeMs = 24 * 60 * 60 * 1000): string[] {
    const cutoff = Date.now() - maxAgeMs;
    return [...this.recentRemotes].filter(([, at]) => at >= cutoff).map(([address]) => address);
  }

  broadcastNetworkUpdate(): void {
    const msg: ServerToClientMessage = {
      type: 'network',
      lanUrls: this.getLanUrls(),
      lanEndpoints: this.getLanEndpoints(),
      tlsPin: this.getTlsPin(),
      hostFirewall: this.getHostFirewall(),
    };
    for (const client of this.clients.values()) this.sendJson(client.ws, msg);
  }

  private sendJson(ws: WebSocket, msg: ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
        this.relayDrops++;
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(msg));
    }
  }
}
