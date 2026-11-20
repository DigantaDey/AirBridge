import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { ipv4Scope, isVirtualInterfaceName, type InterfaceMap } from './lanAddresses.js';

/**
 * Reverse connections: the computer dials the phone.
 *
 * Phone → computer fails in configurations the phone cannot fix or even see:
 * the computer's inbound firewall (macOS Application Firewall — and every
 * ad-hoc-signed update is a new app to it — Windows Defender, endpoint
 * security, VPN clients that block LAN inbound) or a phone that routes the
 * computer's address over mobile data. Outbound from the computer is almost
 * never filtered, and on a phone hotspot the phone is the computer's default
 * gateway, so computer → phone works in exactly those cases.
 *
 * The dialled socket is handed to the normal server pipeline (TLS terminate →
 * HTTP → /ws upgrade → hello). The phone is still the TLS client: it pins this
 * computer's certificate and checks the IP SAN, so the security model is the
 * same as for a connection the phone opened; only the TCP direction differs.
 *
 * Targets (all private IPv4, never public):
 *  - default gateways of this computer's real interfaces (phone hotspot),
 *  - phones advertising `_airbridge-rv._tcp` over mDNS (shared Wi-Fi),
 *  - addresses phones recently connected from (re-dial after a firewall
 *    change or an AirBridge update re-arms it).
 */

export const REVERSE_SERVICE_TYPE = '_airbridge-rv._tcp';

/**
 * Sockets this computer opened to a phone (and their TLS wrappers). Their
 * remote address says nothing about locality — a dialled peer must never get
 * the loopback / this-machine privileges (host desktop, daemon routes).
 */
const reversePeerSockets = new WeakSet<object>();

export function markReversePeer(socket: object): void {
  reversePeerSockets.add(socket);
}

export function isReversePeer(socket: object | null | undefined): boolean {
  return !!socket && reversePeerSockets.has(socket);
}

export interface ReverseTarget {
  address: string;
  port: number;
  source: 'gateway' | 'mdns' | 'recent' | 'static';
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isDialableAddress(address: string): boolean {
  const m = IPV4.exec(address);
  if (!m || m.slice(1).some((p) => Number(p) > 255)) return false;
  const scope = ipv4Scope(address);
  return scope === 'private' || scope === 'cgnat';
}

// ---------------------------------------------------------------------------
// Default gateways
// ---------------------------------------------------------------------------

export interface Gateway {
  address: string;
  interface: string;
}

function keepGateway(g: Gateway): boolean {
  return isDialableAddress(g.address) && !isVirtualInterfaceName(g.interface);
}

/** macOS `netstat -rn -f inet`: "default  172.20.10.1  UGScIg  en7". */
export function parseNetstatDefaults(text: string): Gateway[] {
  const out: Gateway[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'default' || cols.length < 4 || !IPV4.test(cols[1]!)) continue;
    // Netif is the 4th column on macOS (Destination Gateway Flags Netif Expire).
    const iface = cols.find((c, i) => i >= 3 && /^[a-z]+\d+$/i.test(c)) ?? cols[3]!;
    out.push({ address: cols[1]!, interface: iface });
  }
  return out.filter(keepGateway);
}

/** Linux `ip -4 route show default`: "default via 10.42.0.1 dev wlan0 proto dhcp metric 600". */
export function parseIpRouteDefaults(text: string): Gateway[] {
  const out: Gateway[] = [];
  for (const line of text.split('\n')) {
    const via = /\bvia\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
    const dev = /\bdev\s+(\S+)/.exec(line);
    if (line.trim().startsWith('default') && via && dev) out.push({ address: via[1]!, interface: dev[1]! });
  }
  return out.filter(keepGateway);
}

/** Linux `/proc/net/route` (gateway in little-endian hex). */
export function parseProcNetRoute(text: string): Gateway[] {
  const out: Gateway[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[1] !== '00000000' || cols[2] === '00000000') continue;
    const n = parseInt(cols[2]!, 16);
    if (!Number.isFinite(n)) continue;
    const address = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
    out.push({ address, interface: cols[0]! });
  }
  return out.filter(keepGateway);
}

/** Windows `route print -4`: "0.0.0.0  0.0.0.0  192.168.43.1  192.168.43.20  35". */
export function parseWindowsRoutePrint(text: string): Gateway[] {
  const out: Gateway[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 4 && cols[0] === '0.0.0.0' && cols[1] === '0.0.0.0' && IPV4.test(cols[2]!)) {
      out.push({ address: cols[2]!, interface: cols[3]! });
    }
  }
  return out.filter(keepGateway);
}

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

export async function readDefaultGateways(platform: NodeJS.Platform = process.platform): Promise<Gateway[]> {
  try {
    if (platform === 'darwin') return parseNetstatDefaults(await run('netstat', ['-rn', '-f', 'inet']));
    if (platform === 'win32') return parseWindowsRoutePrint(await run('route', ['print', '-4']));
    if (platform === 'linux') {
      const viaIp = parseIpRouteDefaults(await run('ip', ['-4', 'route', 'show', 'default']));
      if (viaIp.length) return viaIp;
      return parseProcNetRoute(await fs.promises.readFile('/proc/net/route', 'utf8').catch(() => ''));
    }
  } catch {
    /* fall through */
  }
  return [];
}

// ---------------------------------------------------------------------------
// mDNS: phones advertising _airbridge-rv._tcp (shared Wi-Fi case)
// ---------------------------------------------------------------------------

export interface FoundPhone {
  addresses: string[];
  port: number;
}

/** `a=192.168.1.23,10.0.0.5` from a TXT dump. */
function txtAddresses(text: string): string[] {
  const m = /(?:^|[\s"])a=([0-9.,]+)/.exec(text);
  return m ? m[1]!.split(',').filter((a) => IPV4.test(a)) : [];
}

/** `dns-sd -B _airbridge-rv._tcp local.` → instance names. */
export function parseDnsSdBrowse(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /\sAdd\s+\d+\s+\d+\s+\S+\s+_airbridge-rv\._tcp\.\s+(.+?)\s*$/.exec(line);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/** `dns-sd -L <name> _airbridge-rv._tcp local.` → port + TXT addresses. */
export function parseDnsSdLookup(text: string): FoundPhone | null {
  const reach = /can be reached at\s+\S+?:(\d+)/.exec(text);
  if (!reach) return null;
  return { port: Number(reach[1]), addresses: txtAddresses(text) };
}

/** `avahi-browse -rpt _airbridge-rv._tcp` resolved lines ("=;iface;IPv4;name;type;domain;host;addr;port;txt"). */
export function parseAvahiBrowse(text: string): FoundPhone[] {
  const out: FoundPhone[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('=')) continue;
    const cols = line.split(';');
    if (cols[2] !== 'IPv4' || cols.length < 9) continue;
    const addr = cols[7]!;
    const port = Number(cols[8]);
    const extra = txtAddresses(cols.slice(9).join(';'));
    out.push({ port, addresses: [...new Set([addr, ...extra])].filter((a) => IPV4.test(a)) });
  }
  return out;
}

/** Run a streaming tool for `ms`, then stop it and return what it printed. */
function capture(cmd: string, args: string[], ms: number): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve('');
      return;
    }
    let killEscalation: NodeJS.Timeout | null = null;
    const stopChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      if (!killEscalation) {
        killEscalation = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 500);
        killEscalation.unref();
      }
    };
    child.stdout?.on('data', (c) => {
      out += String(c);
      if (out.length > 64 * 1024) stopChild();
    });
    child.on('error', () => {
      if (killEscalation) clearTimeout(killEscalation);
      resolve(out);
    });
    const timer = setTimeout(() => stopChild(), ms);
    timer.unref();
    child.on('close', () => {
      clearTimeout(timer);
      if (killEscalation) clearTimeout(killEscalation);
      resolve(out);
    });
  });
}

/**
 * Uses the system mDNS daemon (Bonjour `dns-sd` on macOS/Windows, Avahi on
 * Linux) rather than our own socket: the system responder is exempt from the
 * very firewall rules the reverse path exists to work around.
 */
export async function browseReversePhones(platform: NodeJS.Platform = process.platform): Promise<FoundPhone[]> {
  try {
    if (platform === 'linux') return parseAvahiBrowse(await capture('avahi-browse', ['-rpt', REVERSE_SERVICE_TYPE], 3000));
    if (platform === 'darwin' || platform === 'win32') {
      const names = parseDnsSdBrowse(await capture('dns-sd', ['-B', REVERSE_SERVICE_TYPE, 'local.'], 1500)).slice(0, 8);
      const found = await Promise.all(
        names.map(async (name) => parseDnsSdLookup(await capture('dns-sd', ['-L', name, REVERSE_SERVICE_TYPE, 'local.'], 1500))),
      );
      return found.filter((f): f is FoundPhone => !!f);
    }
  } catch {
    /* best effort */
  }
  return [];
}

// ---------------------------------------------------------------------------
// Dialer
// ---------------------------------------------------------------------------

export interface ReverseConnectorOptions {
  /** Current targets (re-read every tick). */
  targets: () => Promise<ReverseTarget[]> | ReverseTarget[];
  /** Addresses of this machine: never dialled (default: none). */
  isLocalAddress?: (address: string) => boolean;
  /** A phone is already connected from this address: don't dial it. */
  isConnectedFrom: (address: string) => boolean;
  /** Hand a connected socket to the server pipeline. */
  inject: (socket: net.Socket) => void;
  intervalMs?: number;
  connectTimeoutMs?: number;
  maxBackoffMs?: number;
  /** A session shorter than this (phone closed it: busy, wrong computer) counts as a failure. */
  minSessionMs?: number;
  /** Idle timeout on an injected reverse socket before it is destroyed (default 60s). */
  idleTimeoutMs?: number;
  connect?: (address: string, port: number, timeoutMs: number) => Promise<net.Socket>;
  now?: () => number;
  log?: (message: string) => void;
}

interface TargetState {
  failures: number;
  nextAt: number;
  live: boolean;
}

export function defaultConnect(address: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export class ReverseConnector {
  private readonly state = new Map<string, TargetState>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly minSessionMs: number;
  private readonly idleTimeoutMs: number;
  private readonly connectFn: NonNullable<ReverseConnectorOptions['connect']>;
  private readonly now: () => number;

  constructor(private readonly opts: ReverseConnectorOptions) {
    this.intervalMs = opts.intervalMs ?? 2_500;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 1_500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.minSessionMs = opts.minSessionMs ?? 10_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    this.connectFn = opts.connect ?? defaultConnect;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Diagnostics: per-target dial state. */
  describe(): { target: string; failures: number; live: boolean; nextInSeconds: number }[] {
    const now = this.now();
    return [...this.state.entries()].map(([target, st]) => ({
      target,
      failures: st.failures,
      live: st.live,
      nextInSeconds: Math.max(0, Math.round((st.nextAt - now) / 1000)),
    }));
  }

  /** Forget backoff (network changed: old failures say nothing about the new network). */
  reset(): void {
    for (const s of this.state.values()) {
      s.failures = 0;
      s.nextAt = 0;
    }
  }

  private backoff(failures: number): number {
    return Math.min(this.maxBackoffMs, this.intervalMs * 2 ** Math.max(0, failures - 1));
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const raw = await Promise.resolve(this.opts.targets()).catch(() => [] as ReverseTarget[]);
      const seen = new Set<string>();
      const dials: Promise<void>[] = [];
      for (const target of raw) {
        // Discovered targets must be private LAN addresses; explicitly
        // configured ('static') ones may also be loopback (tests, tunnels).
        const allowed = isDialableAddress(target.address) || (target.source === 'static' && target.address === '127.0.0.1');
        if (!allowed || !(target.port > 0 && target.port < 65536)) continue;
        if (target.source !== 'static' && this.opts.isLocalAddress?.(target.address)) continue;
        const key = `${target.address}:${target.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const st = this.state.get(key) ?? { failures: 0, nextAt: 0, live: false };
        this.state.set(key, st);
        if (st.live || this.now() < st.nextAt || this.opts.isConnectedFrom(target.address)) continue;
        dials.push(this.dial(target, st));
      }
      for (const key of this.state.keys()) if (!seen.has(key) && !this.state.get(key)!.live) this.state.delete(key);
      await Promise.all(dials);
    } finally {
      this.ticking = false;
    }
  }

  private async dial(target: ReverseTarget, st: TargetState): Promise<void> {
    st.live = true;
    let socket: net.Socket;
    try {
      socket = await this.connectFn(target.address, target.port, this.connectTimeoutMs);
    } catch {
      st.live = false;
      st.failures++;
      st.nextAt = this.now() + this.backoff(st.failures);
      return;
    }
    if (this.stopped) {
      socket.destroy();
      st.live = false;
      return;
    }
    const startedAt = this.now();
    this.opts.log?.(`reverse connection to ${target.address}:${target.port} (${target.source})`);
    let released = false;
    const releaseLive = () => {
      if (released) return;
      released = true;
      st.live = false;
      if (this.now() - startedAt < this.minSessionMs) st.failures++;
      else st.failures = 0;
      st.nextAt = this.now() + (st.failures ? this.backoff(st.failures) : this.intervalMs);
    };
    if (this.idleTimeoutMs > 0 && typeof socket.setTimeout === 'function') {
      socket.setTimeout(this.idleTimeoutMs);
      socket.once('timeout', () => {
        socket.destroy();
        releaseLive();
      });
    }
    socket.once('close', releaseLive);
    socket.once('error', () => {
      socket.destroy();
      releaseLive();
    });
    markReversePeer(socket);
    try {
      this.opts.inject(socket);
    } catch {
      socket.destroy();
      releaseLive();
    }
  }
}

/** Gateways of interfaces this computer actually advertises (not VPN/VM). */
export function gatewayTargets(gateways: Gateway[], port: number, interfaces?: InterfaceMap): ReverseTarget[] {
  const real = interfaces ? new Set(Object.keys(interfaces)) : null;
  return gateways
    .filter((g) => !real || real.has(g.interface) || !/^[a-z]+\d+$/i.test(g.interface))
    .map((g) => ({ address: g.address, port, source: 'gateway' as const }));
}
