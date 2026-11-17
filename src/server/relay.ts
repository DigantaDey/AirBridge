/**
 * Relay fallback: a dumb TCP rendezvous for when no direct path exists
 * (client isolation, carrier NAT, the phone on mobile data).
 *
 *   phone ──TCP──▶ relay ◀──TCP── computer (standby connections)
 *          └──────── TLS, pinned to the computer's CA ────────┘
 *
 * The relay only splices bytes. TLS runs end to end inside the splice:
 * the phone pins the computer's CA anchor, which it learned from a
 * code-authenticated welcome (SPAKE2 `hubProof` covers `tlsPin`). The
 * operator sees ciphertext and timing, never content, and cannot
 * impersonate either side.
 *
 * Wire protocol (ASCII lines, one per connection, then raw bytes):
 *
 *   computer → relay   AB-RELAY/1 LISTEN <hostKey: 64 hex>\n
 *   relay → computer   OK\n, then `P\n` heartbeats, then GO\n
 *   phone → relay      AB-RELAY/1 DIAL <room: 64 hex>\n
 *   relay → phone      GO\n             (or ERR <code>\n and close)
 *
 * room = hex(SHA-256("airbridge-relay-room-v1:" ‖ hostKey)). Only the
 * computer knows hostKey, so only it can listen on its room; the room id
 * (the welcome's relay `token`) is handed out only to code-admitted
 * devices. Knowing a room lets you open a TLS handshake to that computer
 * and nothing more, the same exposure as being on its Wi-Fi.
 */
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RelayOffer } from '../shared/protocol.js';

export const RELAY_PROTOCOL = 'AB-RELAY/1';
export const DEFAULT_RELAY_PORT = 47391;
/** `~/.airbridge/<this>` holds the relay `host:port` chosen with `airbridge --relay`. */
export const RELAY_ENDPOINT_FILE = 'relay-endpoint';
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_HEADER = 160;

export function relayRoomFor(hostKeyHex: string): string {
  return createHash('sha256').update(`airbridge-relay-room-v1:${hostKeyHex}`).digest('hex');
}

/** `host:port` / `[v6]:port` / `host` (default port). Null when malformed. */
export function parseRelayEndpoint(raw: string | undefined | null): { host: string; port: number; endpoint: string } | null {
  const value = raw?.trim();
  if (!value) return null;
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+))(?::(\d{1,5}))?$/.exec(value);
  if (!match) return null;
  const host = match[1] ?? match[2];
  const port = match[3] ? Number(match[3]) : DEFAULT_RELAY_PORT;
  if (!host || host.length > 253 || port < 1 || port > 65535) return null;
  return { host, port, endpoint: host.includes(':') ? `[${host}]:${port}` : `${host}:${port}` };
}

/** Reads one `\n`-terminated header line, returning it plus any bytes that followed. */
function readHeader(socket: net.Socket, timeoutMs: number): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('header timeout')), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) {
        done(null, { line: buf.subarray(0, nl).toString('latin1').replace(/\r$/, ''), rest: buf.subarray(nl + 1) });
      } else if (buf.length > MAX_HEADER) {
        done(new Error('header too long'));
      }
    };
    const onEnd = () => done(new Error('closed before header'));
    function done(err: Error | null, value?: { line: string; rest: Buffer }) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onEnd);
      socket.off('close', onEnd);
      socket.pause();
      if (err) reject(err);
      else resolve(value!);
    }
    socket.on('data', onData);
    socket.once('error', onEnd);
    socket.once('close', onEnd);
    socket.resume();
  });
}

// ───────────────────────────── relay server ─────────────────────────────

export interface RelayServerOptions {
  port?: number;
  host?: string;
  /** Concurrent connections per source address (all states). Default 64. */
  maxPerAddress?: number;
  /** Concurrent connections overall. Default 4096. */
  maxConnections?: number;
  /** Waiting standby connections per room. Default 8. */
  maxStandbyPerRoom?: number;
  /** How long a dialler waits for a standby connection. Default 8 s. */
  dialWaitMs?: number;
  /** A splice with no traffic either way for this long is closed. Default 15 min. */
  idleMs?: number;
  /** Standby heartbeat (keeps NAT mappings alive). Default 25 s. */
  heartbeatMs?: number;
  headerTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface RelayServer {
  port: number;
  stats(): { rooms: number; standby: number; splices: number; connections: number; bytes: number };
  close(): Promise<void>;
}

interface Standby { socket: net.Socket; heartbeat: NodeJS.Timeout }

export async function startRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const maxPerAddress = opts.maxPerAddress ?? 64;
  const maxConnections = opts.maxConnections ?? 4096;
  const maxStandby = opts.maxStandbyPerRoom ?? 8;
  const dialWaitMs = opts.dialWaitMs ?? 8_000;
  const idleMs = opts.idleMs ?? 15 * 60_000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const headerTimeoutMs = opts.headerTimeoutMs ?? 10_000;
  const log = opts.log ?? (() => {});

  const rooms = new Map<string, Standby[]>();
  const waiters = new Map<string, Array<(s: Standby | null) => void>>();
  const perAddress = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  let splices = 0;
  let bytes = 0;

  const takeStandby = (room: string): Standby | null => {
    const list = rooms.get(room);
    while (list && list.length > 0) {
      const s = list.shift()!;
      clearInterval(s.heartbeat);
      if (!s.socket.destroyed) {
        if (list.length === 0) rooms.delete(room);
        return s;
      }
    }
    rooms.delete(room);
    return null;
  };

  const splice = (a: net.Socket, aRest: Buffer, b: net.Socket) => {
    splices++;
    a.setTimeout(idleMs);
    b.setTimeout(idleMs);
    const end = () => { a.destroy(); b.destroy(); };
    a.on('timeout', end); b.on('timeout', end);
    a.on('close', end); b.on('close', end);
    a.on('error', end); b.on('error', end);
    a.on('data', (c: Buffer) => { bytes += c.length; });
    b.on('data', (c: Buffer) => { bytes += c.length; });
    b.write('GO\n');
    a.write('GO\n');
    if (aRest.length) b.write(aRest);
    a.pipe(b);
    b.pipe(a);
    a.resume();
    b.resume();
    a.once('close', () => { splices--; });
  };

  const server = net.createServer((socket) => {
    const address = (socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
    const count = perAddress.get(address) ?? 0;
    if (count >= maxPerAddress || sockets.size >= maxConnections) {
      socket.end('ERR BUSY\n');
      socket.destroy();
      return;
    }
    perAddress.set(address, count + 1);
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      const n = (perAddress.get(address) ?? 1) - 1;
      if (n <= 0) perAddress.delete(address); else perAddress.set(address, n);
    });

    void readHeader(socket, headerTimeoutMs).then(({ line, rest }) => {
      const [proto, verb, arg] = line.split(' ');
      if (proto !== RELAY_PROTOCOL || !arg || !HEX64.test(arg)) {
        socket.end('ERR PROTOCOL\n');
        return;
      }
      if (verb === 'LISTEN') {
        if (rest.length) { socket.end('ERR PROTOCOL\n'); return; }
        const room = relayRoomFor(arg);
        const queued = waiters.get(room);
        const heartbeat = setInterval(() => socket.write('P\n'), heartbeatMs);
        heartbeat.unref();
        const entry: Standby = { socket, heartbeat };
        socket.write('OK\n');
        if (queued?.length) {
          const next = queued.shift()!;
          if (!queued.length) waiters.delete(room);
          clearInterval(heartbeat);
          next(entry);
          return;
        }
        const list = rooms.get(room) ?? [];
        if (list.length >= maxStandby) {
          // Newest wins: an old standby may be a dead NAT mapping.
          const old = list.shift()!;
          clearInterval(old.heartbeat);
          old.socket.destroy();
        }
        list.push(entry);
        rooms.set(room, list);
        socket.once('close', () => {
          clearInterval(heartbeat);
          const l = rooms.get(room);
          if (!l) return;
          const i = l.indexOf(entry);
          if (i >= 0) l.splice(i, 1);
          if (!l.length) rooms.delete(room);
        });
        return;
      }
      if (verb === 'DIAL') {
        const room = arg;
        const ready = takeStandby(room);
        if (ready) { splice(socket, rest, ready.socket); return; }
        let settled = false;
        const resolve = (s: Standby | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const q = waiters.get(room);
          if (q) { const i = q.indexOf(resolve); if (i >= 0) q.splice(i, 1); if (!q.length) waiters.delete(room); }
          if (!s) { socket.end('ERR NO_HOST\n'); return; }
          if (socket.destroyed) { s.socket.destroy(); return; }
          splice(socket, rest, s.socket);
        };
        const timer = setTimeout(() => resolve(null), dialWaitMs);
        socket.once('close', () => resolve(null));
        const q = waiters.get(room) ?? [];
        if (q.length >= maxStandby * 4) { settled = true; clearTimeout(timer); socket.end('ERR BUSY\n'); return; }
        q.push(resolve);
        waiters.set(room, q);
        return;
      }
      socket.end('ERR PROTOCOL\n');
    }).catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_RELAY_PORT, opts.host ?? '::', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  log(`AirBridge relay listening on ${opts.host ?? '::'}:${port}`);

  return {
    port,
    stats: () => ({
      rooms: rooms.size,
      standby: [...rooms.values()].reduce((n, l) => n + l.length, 0),
      splices,
      connections: sockets.size,
      bytes,
    }),
    close: () => new Promise<void>((resolve) => {
      for (const list of rooms.values()) for (const s of list) clearInterval(s.heartbeat);
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

// ───────────────────────────── computer side ─────────────────────────────

const relayedSockets = new WeakSet<object>();
/** Sockets that arrived through a relay (their remoteAddress is the relay, not the peer). */
export function isRelayedPeer(socket: object | null | undefined): boolean {
  return !!socket && relayedSockets.has(socket);
}
export function markRelayedPeer(socket: object): void {
  relayedSockets.add(socket);
}

export interface RelayAgentOptions {
  endpoint: string;
  hostKey: string;
  /** Receives each spliced socket (TLS ClientHello from the phone comes next). */
  inject: (socket: net.Socket) => void;
  /** Idle standby connections to keep open. Default 2. */
  standby?: number;
  connect?: (host: string, port: number) => net.Socket;
  log?: (line: string) => void;
}

export type RelayAgentState = 'disabled' | 'connecting' | 'ready' | 'error';

/** Keeps [standby] LISTEN connections open and hands every GO'd one to [inject]. */
export class RelayAgent {
  private readonly target: { host: string; port: number; endpoint: string };
  readonly room: string;
  private live = new Set<net.Socket>();
  private stopped = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private ready = 0;
  private lastError: string | null = null;
  private relayed = 0;

  constructor(private readonly opts: RelayAgentOptions) {
    const target = parseRelayEndpoint(opts.endpoint);
    if (!target) throw new Error(`invalid relay endpoint: ${opts.endpoint}`);
    if (!HEX64.test(opts.hostKey)) throw new Error('relay host key must be 64 hex chars');
    this.target = target;
    this.room = relayRoomFor(opts.hostKey);
  }

  get endpoint(): string { return this.target.endpoint; }

  offer(): RelayOffer {
    return { endpoint: this.target.endpoint, token: this.room };
  }

  describe(): { endpoint: string; state: RelayAgentState; standby: number; relayed: number; lastError: string | null } {
    const state: RelayAgentState = this.stopped ? 'disabled' : this.ready > 0 ? 'ready' : this.lastError ? 'error' : 'connecting';
    return { endpoint: this.target.endpoint, state, standby: this.ready, relayed: this.relayed, lastError: this.lastError };
  }

  start(): void {
    this.stopped = false;
    this.fill();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.live) s.destroy();
    this.live.clear();
  }

  private fill(): void {
    if (this.stopped) return;
    const want = this.opts.standby ?? 2;
    while (this.live.size < want) this.open();
  }

  private scheduleRefill(): void {
    if (this.stopped || this.timer) return;
    const delay = this.failures === 0 ? 0 : Math.min(60_000, 1_000 * 2 ** Math.min(this.failures - 1, 6)) * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => { this.timer = null; this.fill(); }, delay);
    this.timer.unref?.();
  }

  private open(): void {
    const socket = (this.opts.connect ?? ((h, p) => net.connect({ host: h, port: p })))(this.target.host, this.target.port);
    this.live.add(socket);
    let handedOff = false;
    let acknowledged = false;
    let buf = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(75_000); // > 2 heartbeats; a silent relay is a dead one
    socket.on('timeout', () => socket.destroy(new Error('relay heartbeat timeout')));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          if (buf.length > MAX_HEADER) socket.destroy(new Error('relay protocol error'));
          return;
        }
        const line = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
        buf = buf.subarray(nl + 1);
        if (line === 'OK') {
          if (!acknowledged) { acknowledged = true; this.ready++; this.failures = 0; this.lastError = null; }
        } else if (line === 'P') {
          // heartbeat
        } else if (line === 'GO') {
          handedOff = true;
          if (acknowledged) this.ready--;
          socket.off('data', onData);
          socket.setTimeout(0);
          socket.pause();
          if (buf.length) socket.unshift(buf);
          this.live.delete(socket);
          this.relayed++;
          markRelayedPeer(socket);
          this.opts.log?.('relay: incoming connection');
          try {
            this.opts.inject(socket);
            // inject() attaches its own reader; an explicitly paused stream
            // stays paused until told otherwise.
            socket.resume();
          } catch {
            socket.destroy();
          }
          this.fill();
          return;
        } else {
          this.lastError = line.startsWith('ERR ') ? line.slice(4) : 'protocol error';
          socket.destroy();
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('connect', () => socket.write(`${RELAY_PROTOCOL} LISTEN ${this.opts.hostKey}\n`));
    socket.on('error', (err) => { if (!handedOff) this.lastError = err.message; });
    socket.once('close', () => {
      if (handedOff) return;
      this.live.delete(socket);
      if (acknowledged) this.ready--;
      else this.failures++;
      this.scheduleRefill();
    });
  }
}

/** The computer's relay host key, created once and kept beside the TLS material. */
export async function loadOrCreateRelayHostKey(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (HEX64.test(existing)) return existing;
  } catch {
    // create below
  }
  const key = randomBytes(32).toString('hex');
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${key}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return key;
}
