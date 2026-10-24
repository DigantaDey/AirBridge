import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
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

interface ConnectedClient {
  peerId: string;
  ws: WebSocket;
  networkKey: string;
  pairCode: string;
  visibility: VisibilityMode;
  device: DeviceProfile;
  connectedAt: number;
  isAlive: boolean;
}

function deriveNetworkKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : forwarded?.[0]) ||
    req.socket.remoteAddress ||
    'unknown';

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

function generatePeerId(): string {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

function sanitizePeerId(candidate?: string): string {
  if (candidate && /^[0-9a-f]{16}$/.test(candidate)) {
    return candidate;
  }
  return generatePeerId();
}

export class SignalingHub {
  public readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly pingTimer: NodeJS.Timeout;
  private getLanUrls: () => string[];
  private getDaemonStatus: () => LocalDaemonStatus;

  constructor(opts: {
    getLanUrls: () => string[];
    getDaemonStatus: () => LocalDaemonStatus;
  }) {
    this.getLanUrls = opts.getLanUrls;
    this.getDaemonStatus = opts.getDaemonStatus;

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

  public getStats(): { connectedPeers: number } {
    return { connectedPeers: this.clients.size };
  }

  public close(): void {
    clearInterval(this.pingTimer);
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

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const networkKey = deriveNetworkKey(req);
    let registeredClient: ConnectedClient | null = null;

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
        const bytes =
          data instanceof Buffer
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(Buffer.concat(data as Buffer[]));
        this.routeBinaryFrame(registeredClient, bytes);
        return;
      }

      let msg: ClientToServerMessage;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientToServerMessage;
      } catch {
        this.sendJson(ws, { type: 'error', code: 'BAD_JSON', message: 'Invalid JSON frame' });
        return;
      }

      if (msg.type === 'hello') {
        let peerId = sanitizePeerId(msg.peerId);
        if (this.clients.has(peerId) && this.clients.get(peerId)?.ws !== ws) {
          peerId = generatePeerId();
        }

        const requestedPair = msg.pairCode ? normalizePairCode(msg.pairCode) : '';
        const pairCode = isValidPairCode(requestedPair)
          ? requestedPair
          : generatePairCode(crypto.randomBytes(8));

        registeredClient = {
          peerId,
          ws,
          networkKey,
          pairCode,
          visibility: msg.visibility ?? 'nearby',
          device: msg.device,
          connectedAt: Date.now(),
          isAlive: true,
        };

        this.clients.set(peerId, registeredClient);

        this.sendJson(ws, {
          type: 'welcome',
          peerId,
          pairCode,
          lanUrls: this.getLanUrls(),
          localDaemon: this.getDaemonStatus(),
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
          registeredClient.device = msg.device;
          registeredClient.visibility = msg.visibility;
          this.broadcastPeerUpdatesFor(registeredClient);
          break;
        }

        case 'join-pair': {
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
      }
    });

    ws.on('close', () => {
      if (registeredClient && this.clients.get(registeredClient.peerId)?.ws === ws) {
        this.clients.delete(registeredClient.peerId);
        this.broadcastPeerUpdatesFor(registeredClient);
      }
    });

    ws.on('error', () => {
      // Handled by close
    });
  }

  private routeBinaryFrame(sender: ConnectedClient, bytes: Uint8Array): void {
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

    // Stamp authenticated sender peerId in-place so sourcePeerId can never be forged
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    overwriteRoutedSourcePeerId(copy, sender.peerId);

    target.ws.send(copy, { binary: true });
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
