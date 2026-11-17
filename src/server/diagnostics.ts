/**
 * Runtime diagnostics for "Copy diagnostics" (desktop UI, macOS app menu):
 * a bounded in-memory log ring, event-loop stall statistics and a structured
 * report of everything that matters when a connection fails.
 *
 * The report is served on loopback only and never includes secrets (pair
 * codes, keys, tokens); device names and LAN addresses are included because
 * they are what a connection problem is about.
 */
import os from 'node:os';
import util from 'node:util';

export interface LogLine {
  t: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX_LINES = 400;
const ring: LogLine[] = [];
let captureInstalled = false;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
// Six-character pair codes in URLs/text (`pair=ABC234`) are secrets.
const PAIR = /([?&]pair=)[A-Za-z0-9-]{4,12}/g;

export function redact(text: string): string {
  return text.replace(ANSI, '').replace(PAIR, '$1[redacted]');
}

export function recordLog(level: LogLine['level'], msg: string): void {
  const clean = redact(msg);
  // Skip the terminal QR art.
  if (/^[\s▄▀█]+$/.test(clean)) return;
  ring.push({ t: new Date().toISOString(), level, msg: clean.length > 2000 ? `${clean.slice(0, 2000)}…` : clean });
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
}

export function recentLogs(limit = 200): LogLine[] {
  return ring.slice(-limit);
}

/** Mirror console output into the ring (output is still written as before). */
export function installLogCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;
  const wrap = (level: LogLine['level'], original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      try { recordLog(level, util.format(...args)); } catch { /* never break logging */ }
      original(...args);
    };
  console.log = wrap('info', console.log.bind(console));
  console.info = wrap('info', console.info.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
}

export interface EventLoopStats {
  stalls: number;
  maxStallMs: number;
  lastStallAt: string | null;
}

const loopStats: EventLoopStats = { stalls: 0, maxStallMs: 0, lastStallAt: null };
let monitorStarted = false;

/** Log (and count) event-loop stalls longer than `thresholdMs`. */
export function startEventLoopMonitor(thresholdMs = 2_000): EventLoopStats {
  if (monitorStarted) return loopStats;
  monitorStarted = true;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 1_000;
    last = now;
    if (lag > thresholdMs) {
      loopStats.stalls++;
      loopStats.maxStallMs = Math.max(loopStats.maxStallMs, lag);
      loopStats.lastStallAt = new Date(now).toISOString();
      console.error(`[airbridge] ${new Date(now).toISOString()} event loop was blocked for ${(lag / 1000).toFixed(1)}s`);
    }
  }, 1_000);
  timer.unref();
  return loopStats;
}

export function eventLoopStats(): EventLoopStats {
  return { ...loopStats };
}

export interface DiagnosticsInput {
  version: string;
  port: number;
  protocol: 'http' | 'https';
  startedAt: number;
  lanEndpoints: unknown[];
  uncoveredLanAddresses: string[];
  tls: { source?: string; caFingerprintSha256?: string; leafFingerprintSha256?: string; hosts?: string[]; pinPresent: boolean } | null;
  hostFirewall: unknown;
  mdnsActive: boolean | null;
  reverseConnect: unknown;
  connectedDevices: unknown[];
  shellSubscribers: number;
  update: unknown;
}

export function buildDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).map((i) => ({ name, family: i.family, address: i.address, cidr: i.cidr, internal: i.internal })),
  );
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: input.version,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - input.startedAt) / 1000),
      supervisedBy: process.env.AIRBRIDGE_SUPERVISED || null,
      appBundle: process.env.AIRBRIDGE_APP_BUNDLE ? true : false,
      runtime: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : `node ${process.version}`,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    network: {
      port: input.port,
      protocol: input.protocol,
      advertised: input.lanEndpoints,
      uncovered: input.uncoveredLanAddresses,
      interfaces,
      mdnsActive: input.mdnsActive,
      hostFirewall: input.hostFirewall,
      reverseConnect: input.reverseConnect,
    },
    tls: input.tls,
    devices: input.connectedDevices,
    shell: { subscribers: input.shellSubscribers },
    update: input.update,
    eventLoop: eventLoopStats(),
    logs: recentLogs(200),
  };
}

/** Tests only. */
export function resetDiagnosticsForTests(): void {
  ring.length = 0;
  loopStats.stalls = 0;
  loopStats.maxStallMs = 0;
  loopStats.lastStallAt = null;
}
