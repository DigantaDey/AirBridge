import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import {
  type ClientToServerMessage,
  type DeviceProfile,
  type LocalDaemonStatus,
  type PeerSummary,
  type ServerToClientMessage,
  type VisibilityMode,
  FRAME_ROUTED_RELAY,
  ROUTING_HEADER_LENGTH,
  generatePairCode,
  isValidPairCode,
  normalizePairCode,
  overwriteRoutedSourcePeerId,
  unwrapRoutedRelayFrame,
} from '../shared/protocol.js';
import { HostClipboardMonitor, type HostClipboardProvider } from './hostClipboard.js';
import { isLoopbackAddress } from './tls.js';

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
  joinPairAttempts: number[];
}

function deriveNetworkKey(req: IncomingMessage): string {
  // SECURITY: never trust X-Forwarded-For here. AirBridge is not deployed
  // behind a proxy that strips it, so any LAN client could otherwise spoof
  // a victim's subnet (or loopback) and gain "nearby" discovery/relay access
  // to devices it is not on the same network as. The socket address is the
  // only address the kernel actually observed.
  const rawIp = req.socket.remoteAddress || 'unknown';

  const ip = rawIp.replace(/^::ffff:/, '');

  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
    return 'net:loopback';
  }

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

  // Public IP (e.g., devices behind same home Wi-Fi NAT hitting cloud signaling)
  return 'net:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

const PLATFORMS = new Set(['macos', 'android', 'ios', 'windows', 'linux', 'unknown']);
const FORM_FACTORS = new Set(['laptop', 'phone', 'tablet', 'desktop']);
export const MAX_CLIENTS = 128;
export const MAX_CLIENTS_PER_NETWORK = 32;
const JOIN_PAIR_WINDOW_MS = 60_000;
const MAX_JOIN_PAIR_PER_WINDOW = 6; // pair codes are only 30 bits; slow guessing to a crawl

function boundText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
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
  };
}

function generatePeerId(): string {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

export function isLocalMachineAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (isLoopbackAddress(remoteAddress)) return true;
  const normalized = remoteAddress.replace(/^::ffff:/, '');
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.address === normalized) return true;
    }
  }
  return false;
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
  private readonly defaultPairCode = generatePairCode(crypto.randomBytes(8));
  private defaultPairCodeClaimed = false;
  /** Last pair code per peerId so reconnects rejoin their existing group. */
  private readonly pairCodeByPeer = new Map<string, string>();

  public readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly pingTimer: NodeJS.Timeout;
  private readonly clipboardMonitor: HostClipboardMonitor | null;
  private getLanUrls: () => string[];
  private getDaemonStatus: () => LocalDaemonStatus;

  constructor(opts: {
    getLanUrls: () => string[];
    getDaemonStatus: () => LocalDaemonStatus;
    clipboardProvider?: HostClipboardProvider | null;
    clipboardPollMs?: number;
  }) {
    this.getLanUrls = opts.getLanUrls;
    this.getDaemonStatus = opts.getDaemonStatus;
    this.clipboardMonitor =
      opts.clipboardProvider && opts.clipboardProvider.isSupported()
        ? new HostClipboardMonitor({
            provider: opts.clipboardProvider,
            pollIntervalMs: opts.clipboardPollMs,
            onClipboardChange: (text) => this.deliverHostClipboard(text),
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
        if (!client.isAlive) {
          client.ws.terminate();
          this.clients.delete(peerId);
          this.broadcastPeerUpdatesFor(client);
          this.syncClipboardWatchState();
          continue;
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

  /** Pair code embedded in the startup QR (claimed by the first client). */
  getDefaultPairCode(): string {
    return this.defaultPairCode;
  }

  private rememberPairCode(peerId: string, pairCode: string): void {
    if (this.pairCodeByPeer.size >= 512) {
      const oldest = this.pairCodeByPeer.keys().next().value;
      if (oldest !== undefined) this.pairCodeByPeer.delete(oldest);
    }
    this.pairCodeByPeer.set(peerId, pairCode);
  }

  public getStats(): { connectedPeers: number } {
    return { connectedPeers: this.clients.size };
  }

  public close(): void {
    clearInterval(this.pingTimer);
    this.clipboardMonitor?.close();
    for (const client of this.clients.values()) {
      try {
        client.ws.close();
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

  private syncClipboardWatchState(): void {
    if (!this.clipboardMonitor) return;
    let hasActiveHostClient = false;
    for (const client of this.clients.values()) {
      if (this.isHostDesktopClient(client) && client.ws.readyState === WebSocket.OPEN) {
        hasActiveHostClient = true;
        break;
      }
    }
    this.clipboardMonitor.setShouldWatch(hasActiveHostClient);
  }

  private deliverHostClipboard(text: string): void {
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
        timestamp: Date.now(),
      });
    }
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const networkKey = deriveNetworkKey(req);
    const isLoopback = isLocalMachineAddress(req.socket.remoteAddress);
    let registeredClient: ConnectedClient | null = null;
    if (this.clients.size >= MAX_CLIENTS) { ws.close(1013, 'Server busy'); return; }
    let perNetwork = 0;
    for (const c of this.clients.values()) if (c.networkKey === networkKey) perNetwork++;
    if (perNetwork >= MAX_CLIENTS_PER_NETWORK) { ws.close(1013, 'Too many connections from this network'); return; }

    ws.on('pong', () => {
      if (registeredClient) {
        registeredClient.isAlive = true;
      }
    });

    ws.on('message', (data, isBinary) => {
      if (registeredClient) {
        registeredClient.isAlive = true;
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
        const device = sanitizeDeviceProfile(msg.device);
        if (!device) {
          this.sendJson(ws, { type: 'error', code: 'INVALID_DEVICE', message: 'Device profile or public key is invalid.' });
          ws.close(1008, 'Invalid device profile');
          return;
        }
        (msg as { device: DeviceProfile }).device = device;
        let peerId = sanitizePeerId(msg.peerId);
        if (this.clients.has(peerId) && this.clients.get(peerId)?.ws !== ws) {
          peerId = generatePeerId();
        }

        const requestedPair = msg.pairCode ? normalizePairCode(msg.pairCode) : '';
        let pairCode: string;
        if (isValidPairCode(requestedPair)) {
          pairCode = requestedPair;
        } else if (this.pairCodeByPeer.has(peerId)) {
          // Reconnect: rejoin the group this peerId last belonged to.
          pairCode = this.pairCodeByPeer.get(peerId)!;
        } else if (!this.defaultPairCodeClaimed) {
          pairCode = this.defaultPairCode;
          this.defaultPairCodeClaimed = true;
        } else {
          pairCode = generatePairCode(crypto.randomBytes(8));
        }
        this.rememberPairCode(peerId, pairCode);

        registeredClient = {
          peerId,
          ws,
          networkKey,
          isLoopback,
          pairCode,
          visibility: msg.visibility === 'paired-only' || msg.visibility === 'hidden' ? msg.visibility : 'nearby',
          device: msg.device,
          connectedAt: Date.now(),
          isAlive: true,
          joinPairAttempts: [],
        };

        this.clients.set(peerId, registeredClient);
        this.syncClipboardWatchState();

        this.sendJson(ws, {
          type: 'welcome',
          peerId,
          pairCode,
          lanUrls: this.getLanUrls(),
          localDaemon: this.resolveClientDaemonStatus(registeredClient),
          peers: this.computeVisiblePeers(registeredClient),
        });

        this.broadcastPeerUpdatesFor(registeredClient);
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
          registeredClient.device = device;
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
          if (registeredClient.joinPairAttempts.length >= MAX_JOIN_PAIR_PER_WINDOW) {
            this.sendJson(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many pair attempts. Wait a minute and try again.' });
            return;
          }
          registeredClient.joinPairAttempts.push(nowMs);
          const normalized = normalizePairCode(msg.pairCode);
          if (!isValidPairCode(normalized)) {
            this.sendJson(ws, {
              type: 'error',
              code: 'INVALID_PAIR_CODE',
              message: 'Pair code must be 6 valid characters.',
            });
            return;
          }
          const prevPairCode = registeredClient.pairCode;
          registeredClient.pairCode = normalized;
          this.rememberPairCode(registeredClient.peerId, normalized);
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
          const fresh = generatePairCode(crypto.randomBytes(8));
          registeredClient.pairCode = fresh;
          this.rememberPairCode(registeredClient.peerId, fresh);
          this.sendJson(ws, {
            type: 'pair-updated',
            pairCode: fresh,
            peers: this.computeVisiblePeers(registeredClient),
          });
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

        case 'set-host-clipboard': {
          if (
            this.isHostDesktopClient(registeredClient) &&
            typeof msg.text === 'string' &&
            msg.text.length > 0 &&
            msg.text.length <= 512_000
          ) {
            this.clipboardMonitor?.writeClipboard(msg.text).catch(() => {});
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (registeredClient && this.clients.get(registeredClient.peerId)?.ws === ws) {
        this.clients.delete(registeredClient.peerId);
        this.syncClipboardWatchState();
        this.broadcastPeerUpdatesFor(registeredClient);
      }
    });

    ws.on('error', () => {
      // Handled by close
    });
  }

  private routeBinaryFrame(
    sender: ConnectedClient,
    data: Buffer | ArrayBuffer | Buffer[]
  ): void {
    // `ws` hands us a freshly-allocated Buffer per message, so we can stamp
    // the authenticated sender id into it and forward the very same buffer —
    // the old path allocated + memcpy'd every relayed frame (256 KiB chunks
    // at full link speed), burning relay CPU on pure copying.
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

    // Do not let a fast sender grow the relay queue without bound. Senders
    // self-throttle at a 16 MiB socket buffer, so this 64 MiB valve should
    // never trip in honest use — it only stops a runaway queue.
    if (target.ws.bufferedAmount > 64 * 1024 * 1024) return;
    // Stamp authenticated sender peerId in-place so sourcePeerId can never be forged
    overwriteRoutedSourcePeerId(bytes, sender.peerId);

    target.ws.send(bytes, { binary: true });
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

  private computeVisiblePeers(viewer: ConnectedClient): PeerSummary[] {
    if (viewer.visibility === 'hidden') return [];
    const peers: PeerSummary[] = [];

    for (const candidate of this.clients.values()) {
      if (candidate.peerId === viewer.peerId) continue;
      if (candidate.visibility === 'hidden') continue;

      if (candidate.pairCode === viewer.pairCode) {
        peers.push({
          peerId: candidate.peerId,
          device: candidate.device,
          discoveryScope: 'paired',
          connectedAt: candidate.connectedAt,
        });
      } else if (
        candidate.networkKey === viewer.networkKey &&
        viewer.visibility === 'nearby' &&
        candidate.visibility === 'nearby'
      ) {
        peers.push({
          peerId: candidate.peerId,
          device: candidate.device,
          discoveryScope: 'nearby',
          connectedAt: candidate.connectedAt,
        });
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

  private sendJson(ws: WebSocket, msg: ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
