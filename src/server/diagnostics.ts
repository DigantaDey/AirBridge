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
import { performance } from 'node:perf_hooks';

export interface LogLine {
  t: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX_LINES = 400;
const ring: LogLine[] = [];
let captureInstalled = false;

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const PAIR_QUERY = /([?&]pair=)[A-Za-z0-9-]{4,12}/gi;
const OTHER_QUERY_SECRET = /([?&](?:token|ca|key)=)(?:[A-Za-z0-9_-]{12,}|(?=[^&\s"']*\d)[A-Za-z0-9_-]{6,})/gi;
const BEAM_TOKEN_RE = /(\/api\/beam\/)[A-Za-z0-9_-]+/gi;
const AUTH_HEADER_RE = /(\b(?:Authorization|X-Sentry-Auth)\s*[:=]\s*)(?:Bearer\s+|Basic\s+|Sentry\s+)?[^\r\n"']+/gi;
const JSON_SECRET_RE = /(["']?(?:pairCode|psk|password|token|secret|ssid)["']?\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi;
const WIFI_INLINE_RE = /\b((?:ssid|psk|password)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PAIR_FIELD_RE = /\b(pair(?:Code|_code)?["']?\s*[:=]\s*["']?)[A-Za-z0-9-]{4,12}/gi;
const HOME_POSIX_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;
const HOME_WIN_RE = /[A-Za-z]:\\Users\\[^\\\s"']+/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const MAC_RE = /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g;

export function redact(text: string): string {
  let out = text.replace(ANSI_RE, '');
  const home = os.homedir();
  if (home && home.length > 1) {
    out = out.split(home).join('~');
  }
  out = out
    .replace(HOME_POSIX_RE, '~')
    .replace(HOME_WIN_RE, '~')
    .replace(PAIR_QUERY, '$1[redacted]')
    .replace(OTHER_QUERY_SECRET, '$1[redacted]')
    .replace(BEAM_TOKEN_RE, '$1[redacted]')
    .replace(AUTH_HEADER_RE, '$1[redacted]')
    .replace(JSON_SECRET_RE, '$1[redacted]$2')
    .replace(WIFI_INLINE_RE, '$1[redacted]')
    .replace(PAIR_FIELD_RE, '$1[redacted]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(MAC_RE, '[redacted-mac]');
  return out;
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
  // Measure elapsed time with a monotonic clock so NTP/manual wall-clock
  // changes are not misreported as event-loop hangs. Keep wall time only for
  // the human-readable diagnostic timestamp.
  let last = performance.now();
  const timer = setInterval(() => {
    const monotonicNow = performance.now();
    const wallNow = Date.now();
    const lag = monotonicNow - last - 1_000;
    last = monotonicNow;
    if (lag > thresholdMs) {
      loopStats.stalls++;
      loopStats.maxStallMs = Math.max(loopStats.maxStallMs, lag);
      loopStats.lastStallAt = new Date(wallNow).toISOString();
      console.error(`[airbridge] ${new Date(wallNow).toISOString()} event loop was blocked for ${(lag / 1000).toFixed(1)}s`);
    }
  }, 1_000);
  timer.unref();
  return loopStats;
}

export function eventLoopStats(): EventLoopStats {
  return { ...loopStats };
}

export interface ClientDiagnosticsSnapshot {
  receivedAt: string;
  payload: Record<string, unknown>;
}

let latestClientDiagnostics: ClientDiagnosticsSnapshot | null = null;

function scrubObjectStrings(val: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof val === 'string') return redact(val).slice(0, 2000);
  if (typeof val === 'number' || typeof val === 'boolean' || val === null) return val;
  if (Array.isArray(val)) return val.slice(0, 100).map((item) => scrubObjectStrings(item, depth + 1));
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>).slice(0, 60)) {
      if (/^(pairCode|psk|password|token|secret|ssid)$/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = scrubObjectStrings(v, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

export function recordClientDiagnostics(raw: unknown): ClientDiagnosticsSnapshot {
  const sanitized = (scrubObjectStrings(raw) ?? {}) as Record<string, unknown>;
  latestClientDiagnostics = {
    receivedAt: new Date().toISOString(),
    payload: sanitized,
  };
  return latestClientDiagnostics;
}

export function getClientDiagnostics(): ClientDiagnosticsSnapshot | null {
  return latestClientDiagnostics;
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
  mdnsLastError?: string | null;
  reverseConnect: unknown;
  relay?: unknown;
  connectedDevices: unknown[];
  signaling?: {
    pakeFailures: number;
    rateLimitedCount: number;
    legacyBlockedCount: number;
    relayDrops: number;
    relayDroppedFrames?: number;
    relayBackpressurePauses?: number;
    relayBackpressureResumes?: number;
    relayMaxBufferedBytes?: number;
    heartbeatTimeouts?: number;
    peekTimeouts: number;
    tlsHandshakeErrors: number;
  };
  localDaemon?: {
    enabled: boolean;
    downloadDir: string;
    writable: boolean;
    freeBytes: number | null;
    activePartials: number;
    orphanedPartialsCleaned: number;
    finalizeCount?: number;
    finalizeRehashCount?: number;
    lastFinalizeDurationMs?: number | null;
    lastError: string | null;
  };
  clipboard?: {
    supported: boolean;
    running: boolean;
    textCaptures: number;
    imageCaptures: number;
    textWrites: number;
    imageWrites: number;
    suppressedEchoes: number;
    corruptedTextBlocked: number;
    errors: number;
    lastError: string | null;
  } | null;
  handoff?: {
    enabled: boolean;
    policy: string;
    shared: boolean;
    unsupportedReason: string | null;
    activeOffers?: number;
    rejectedOffers?: number;
    redactedSsidHits?: number;
    recentFailureReasons: string[];
  };
  shellSubscribers: number;
  update: unknown;
  /** Recent crash summaries (titles are already scrubbed). */
  crashes?: unknown[];
  client?: ClientDiagnosticsSnapshot | null;
}

export function buildDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).map((i) => ({ name, family: i.family, address: i.address, cidr: i.cidr, internal: i.internal })),
  );
  const mem = process.memoryUsage();
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
      memoryMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      externalMb: Math.round((mem.external / 1048576) * 10) / 10,
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    network: {
      port: input.port,
      protocol: input.protocol,
      advertised: input.lanEndpoints,
      uncovered: input.uncoveredLanAddresses,
      interfaces,
      mdnsActive: input.mdnsActive,
      mdnsLastError: input.mdnsLastError ?? null,
      hostFirewall: input.hostFirewall,
      reverseConnect: input.reverseConnect,
      relay: input.relay ?? 'disabled',
    },
    tls: input.tls,
    devices: input.connectedDevices,
    signaling: input.signaling ?? {
      pakeFailures: 0,
      rateLimitedCount: 0,
      legacyBlockedCount: 0,
      relayDrops: 0,
      relayDroppedFrames: 0,
      relayBackpressurePauses: 0,
      relayBackpressureResumes: 0,
      relayMaxBufferedBytes: 0,
      heartbeatTimeouts: 0,
      peekTimeouts: 0,
      tlsHandshakeErrors: 0,
    },
    localDaemon: input.localDaemon ?? null,
    clipboard: input.clipboard
      ? {
          ...input.clipboard,
          lastError: input.clipboard.lastError ? redact(input.clipboard.lastError) : null,
        }
      : null,
    handoff: input.handoff ?? {
      enabled: false,
      policy: 'off',
      shared: false,
      unsupportedReason: null,
      recentFailureReasons: [],
    },
    shell: { subscribers: input.shellSubscribers },
    update: input.update,
    crashes: input.crashes ?? [],
    eventLoop: eventLoopStats(),
    client: input.client !== undefined ? input.client : latestClientDiagnostics,
    logs: recentLogs(200),
  };
}

/** Tests only. */
export function resetDiagnosticsForTests(): void {
  ring.length = 0;
  loopStats.stalls = 0;
  loopStats.maxStallMs = 0;
  loopStats.lastStallAt = null;
  latestClientDiagnostics = null;
}
