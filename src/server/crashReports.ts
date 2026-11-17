/**
 * Crash reporting that respects the user: reports are written locally,
 * scrubbed of anything personal, shown in full before anything is sent, and
 * sent only when the user says so.
 *
 * Captured: uncaught exceptions and unhandled rejections in the service,
 * plus runs that ended without a clean shutdown (native crash, OOM, killed
 * by the watchdog), detected from a run marker at the next start.
 *
 * Destinations, in order:
 *   1. A Sentry-compatible endpoint (Sentry, self-hosted GlitchTip …) when
 *      AIRBRIDGE_CRASH_DSN or ~/.airbridge/crash-dsn is set.
 *   2. Otherwise a prefilled GitHub issue the user reviews and submits.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CrashKind = 'uncaught-exception' | 'unhandled-rejection' | 'abnormal-exit';

export interface CrashReport {
  id: string;
  createdAt: string;
  kind: CrashKind;
  version: string;
  name: string;
  message: string;
  stack: string;
  /** Groups the same bug across machines: hash of the error type + top frames. */
  fingerprint: string;
  platform: string;
  arch: string;
  osRelease: string;
  runtime: string;
  uptimeSeconds: number | null;
  supervisedBy: string | null;
  logTail: string[];
  sent?: { at: string; via: 'sentry' | 'github'; ref: string };
}

export interface CrashSummary {
  id: string;
  createdAt: string;
  kind: CrashKind;
  version: string;
  title: string;
  sent: boolean;
}

// ───────────────────────────── scrubbing ─────────────────────────────

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b|::(?:[0-9a-fA-F]{1,4}:?){1,7}/g;
const MAC = /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LONG_HEX = /\b[0-9a-fA-F]{24,}\b/g;
// Keys and tokens: long, and (unlike long identifiers in stacks) contain digits.
const LONG_B64 = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}={0,2}/g;
const PAIR = /\b(pair(?:Code|_code)?["']?\s*[:=]\s*["']?)[A-Za-z0-9-]{4,12}/gi;
const QUERY_SECRET = /([?&](?:pair|token|ca|key)=)[^&\s"']+/gi;
const LOCAL_HOST = /\b[\w-]+\.local\b/g;

export interface ScrubContext {
  home?: string;
  username?: string;
  hostname?: string;
}

/** Removes paths to the home folder, user/host names, addresses, codes, keys and tokens. */
export function scrub(text: string, ctx: ScrubContext = defaultScrubContext()): string {
  let out = text;
  if (ctx.home && ctx.home.length > 1) out = out.split(ctx.home).join('~');
  out = out
    .replace(QUERY_SECRET, '$1<redacted>')
    .replace(PAIR, '$1<redacted>')
    .replace(EMAIL, '<email>')
    .replace(MAC, '<mac>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, (m) => (m.includes('::') || m.split(':').length > 3 ? '<ip6>' : m))
    .replace(LONG_HEX, '<hex>')
    .replace(LONG_B64, '<key>')
    .replace(LOCAL_HOST, '<host>.local');
  for (const name of [ctx.hostname, ctx.username]) {
    if (name && name.length >= 3) {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g'), '<name>');
    }
  }
  return out;
}

function defaultScrubContext(): ScrubContext {
  let username: string | undefined;
  try { username = os.userInfo().username; } catch { /* no passwd entry */ }
  return { home: os.homedir(), username, hostname: os.hostname().replace(/\.local$/i, '') };
}

/** Stable across machines: error type plus the top frames' function and file names (no line numbers). */
export function fingerprintOf(name: string, stack: string): string {
  const frames = stack.split('\n')
    .filter((l) => /^\s*at /.test(l))
    .slice(0, 5)
    .map((l) => l.trim()
      .replace(/\(.*[\\/]([^\\/]+?)(?::\d+)*\)$/, '($1)')
      .replace(/ [^ ]*[\\/]([^\\/ ]+?)(?::\d+)*$/, ' $1')
      .replace(/:\d+/g, ''));
  return createHash('sha256').update([name, ...frames].join('\n')).digest('hex').slice(0, 16);
}

// ───────────────────────────── building ─────────────────────────────

export interface CrashContext {
  version: string;
  startedAt?: number;
  logTail?: string[];
}

let reportSeq = 0;

export function buildCrashReport(err: unknown, kind: CrashKind, ctx: CrashContext): CrashReport {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeString(err));
  const name = e.name || 'Error';
  const rawStack = typeof e.stack === 'string' ? e.stack : `${name}: ${e.message}`;
  const scrubCtx = defaultScrubContext();
  const stack = scrub(rawStack, scrubCtx).split('\n').slice(0, 60).join('\n');
  return {
    // Sorts chronologically, also for several reports in the same millisecond.
    id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(++reportSeq % 10_000).padStart(4, '0')}-${randomBytes(3).toString('hex')}`,
    createdAt: new Date().toISOString(),
    kind,
    version: ctx.version,
    name: scrub(name, scrubCtx).slice(0, 120),
    message: scrub(e.message ?? '', scrubCtx).slice(0, 1000),
    stack,
    fingerprint: fingerprintOf(name, rawStack),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    runtime: typeof (globalThis as { Bun?: { version?: string } }).Bun !== 'undefined'
      ? `bun ${(globalThis as { Bun?: { version?: string } }).Bun?.version ?? ''}`.trim()
      : `node ${process.version}`,
    uptimeSeconds: ctx.startedAt ? Math.round((Date.now() - ctx.startedAt) / 1000) : null,
    supervisedBy: process.env.AIRBRIDGE_SUPERVISED || null,
    logTail: (ctx.logTail ?? []).slice(-80).map((l) => scrub(l, scrubCtx).slice(0, 500)),
  };
}

function safeString(value: unknown): string {
  try { return JSON.stringify(value)?.slice(0, 500) ?? String(value); } catch { return String(value); }
}

// ───────────────────────────── storage ─────────────────────────────

export class CrashStore {
  private readonly recentFingerprints = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly limits: { maxReports?: number; maxAgeDays?: number; dedupeMs?: number } = {},
  ) {}

  /** Synchronous so it works from an uncaughtException handler right before exit. */
  recordSync(report: CrashReport): boolean {
    const now = Date.now();
    const last = this.recentFingerprints.get(report.fingerprint);
    if (last && now - last < (this.limits.dedupeMs ?? 10 * 60_000)) return false; // a burst of the same bug
    this.recentFingerprints.set(report.fingerprint, now);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, `${report.id}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      this.prune();
      return true;
    } catch {
      return false;
    }
  }

  private files(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((f) => /^[\w-]+\.json$/.test(f)).sort();
    } catch {
      return [];
    }
  }

  prune(): void {
    const maxReports = this.limits.maxReports ?? 20;
    const cutoff = Date.now() - (this.limits.maxAgeDays ?? 30) * 86_400_000;
    const files = this.files();
    files.forEach((f, i) => {
      const full = path.join(this.dir, f);
      let old = false;
      try { old = fs.statSync(full).mtimeMs < cutoff; } catch { /* gone */ }
      if (old || i < files.length - maxReports) fs.rmSync(full, { force: true });
    });
  }

  get(id: string): CrashReport | null {
    if (!/^[\w-]{8,80}$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as CrashReport;
    } catch {
      return null;
    }
  }

  list(): CrashSummary[] {
    return this.files().reverse().map((f) => this.get(f.slice(0, -5))).filter((r): r is CrashReport => r !== null).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      kind: r.kind,
      version: r.version,
      title: crashTitle(r),
      sent: Boolean(r.sent),
    }));
  }

  markSent(id: string, sent: NonNullable<CrashReport['sent']>): void {
    const r = this.get(id);
    if (!r) return;
    r.sent = sent;
    try { fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(r, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}

export function crashTitle(r: CrashReport): string {
  if (r.kind === 'abnormal-exit') return `AirBridge ${r.version} stopped unexpectedly`;
  return `${r.name}: ${r.message}`.slice(0, 140);
}

// ─────────────────────── unclean-shutdown detection ───────────────────────

const RUN_MARKER = 'run-marker.json';

interface RunMarker { pid: number; startedAt: number; version: string }

/**
 * Call once at service start. When the previous run never reached a clean
 * shutdown (its marker is still there and its process is gone), records an
 * `abnormal-exit` report with the tail of that run's log.
 */
export function beginRun(stateDir: string, store: CrashStore, version: string, opts: { logFile?: string; isAlive?: (pid: number) => boolean } = {}): CrashReport | null {
  const file = path.join(stateDir, RUN_MARKER);
  let report: CrashReport | null = null;
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8')) as RunMarker;
    const alive = (opts.isAlive ?? pidAlive)(prev.pid);
    if (prev.pid !== process.pid && !alive) {
      // The macOS app logs to ~/.airbridge/server.log, the launchd agent to
      // ~/Library/Logs/airbridge.log; use whichever was written last.
      const candidates = opts.logFile ? [opts.logFile] : [path.join(stateDir, 'server.log'), path.join(os.homedir(), 'Library', 'Logs', 'airbridge.log')];
      const newest = candidates
        .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
        .filter((x): x is { f: string; m: number } => x !== null)
        .sort((a, b) => b.m - a.m)[0];
      const tail = newest ? readTail(newest.f, 80) : [];
      const err = new Error(`The previous run (started ${new Date(prev.startedAt).toISOString()}) ended without a clean shutdown`);
      err.name = 'AbnormalExit';
      err.stack = `${err.name}: ${err.message}`;
      report = buildCrashReport(err, 'abnormal-exit', { version: prev.version, startedAt: prev.startedAt, logTail: tail });
      report.uptimeSeconds = null;
      if (!store.recordSync(report)) report = null;
    }
  } catch {
    // No marker: first run or the last one shut down cleanly.
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version } satisfies RunMarker), { mode: 0o600 });
  } catch {
    // Unwritable state dir: no abnormal-exit detection this run.
  }
  return report;
}

/** Call on every intentional exit (stop, restart for update, Ctrl+C). */
export function endRunCleanly(stateDir: string): void {
  try {
    const file = path.join(stateDir, RUN_MARKER);
    const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as RunMarker;
    if (marker.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // nothing to clean
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readTail(file: string, lines: number): string[] {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

// ───────────────────────────── sending ─────────────────────────────

export interface Dsn { endpoint: string; publicKey: string }

/** `https://<key>@<host>[/<path>]/<project>` → envelope endpoint + key. */
export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.host.replace(/:\d+$/, '')))) return null;
    const project = u.pathname.split('/').filter(Boolean).pop();
    if (!u.username || !project || !/^\d+$/.test(project)) return null;
    const prefix = u.pathname.split('/').filter(Boolean).slice(0, -1).join('/');
    return { endpoint: `${u.protocol}//${u.host}/${prefix ? `${prefix}/` : ''}api/${project}/envelope/`, publicKey: u.username };
  } catch {
    return null;
  }
}

export function loadCrashDsn(stateDir: string, env: NodeJS.ProcessEnv = process.env): Dsn | null {
  if (env.AIRBRIDGE_CRASH_DSN !== undefined) return parseDsn(env.AIRBRIDGE_CRASH_DSN);
  try { return parseDsn(fs.readFileSync(path.join(stateDir, 'crash-dsn'), 'utf8')); } catch { return null; }
}

function stackFrames(stack: string): Array<Record<string, unknown>> {
  return stack.split('\n').filter((l) => /^\s*at /.test(l)).map((l) => {
    const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l.trim());
    return m
      ? { function: m[1] ?? '<anonymous>', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|node:|internal\//.test(m[2] ?? '') }
      : { function: l.trim().replace(/^at /, '') };
  }).reverse(); // Sentry wants the innermost frame last
}

/** Sentry envelope (works with Sentry and GlitchTip). */
export function sentryEnvelope(r: CrashReport, sentAt = new Date()): { body: string; eventId: string } {
  const eventId = randomBytes(16).toString('hex');
  const event = {
    event_id: eventId,
    timestamp: Date.parse(r.createdAt) / 1000,
    platform: 'node',
    level: 'fatal',
    logger: 'airbridge',
    release: `airbridge@${r.version}`,
    environment: 'production',
    fingerprint: [r.fingerprint],
    exception: { values: [{ type: r.name, value: r.message, mechanism: { type: r.kind, handled: false }, stacktrace: { frames: stackFrames(r.stack) } }] },
    tags: { kind: r.kind, arch: r.arch, runtime: r.runtime, supervised: r.supervisedBy ?? 'no' },
    contexts: { os: { name: r.platform, version: r.osRelease }, runtime: { name: r.runtime } },
    extra: { uptimeSeconds: r.uptimeSeconds, logTail: r.logTail.join('\n') },
  };
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: sentAt.toISOString() }),
    JSON.stringify({ type: 'event', content_type: 'application/json' }),
    JSON.stringify(event),
  ].join('\n') + '\n';
  return { body, eventId };
}

export function githubIssueUrl(r: CrashReport, repo = 'DigantaDey/AirBridge'): string {
  const fence = '```';
  const head = [
    `**${crashTitle(r)}**`,
    '',
    `- Version: ${r.version} · ${r.platform} ${r.osRelease} ${r.arch} · ${r.runtime}`,
    `- Kind: ${r.kind}${r.uptimeSeconds !== null ? ` after ${r.uptimeSeconds}s` : ''}${r.supervisedBy ? ` · supervised by ${r.supervisedBy}` : ''}`,
    `- Fingerprint: \`${r.fingerprint}\``,
    '',
    '<!-- What were you doing when it happened? (optional) -->',
    '',
    `${fence}`,
    r.stack,
    `${fence}`,
  ].join('\n');
  // Browsers and GitHub cap URL length (~8 KB); the log tail goes last and is trimmed first.
  let tail = r.logTail.slice(-40);
  const build = () => `${head}\n\n<details><summary>Recent log (scrubbed)</summary>\n\n${fence}\n${tail.join('\n')}\n${fence}\n</details>\n`;
  let body = build();
  while (encodeURIComponent(body).length > 6500 && tail.length > 0) {
    tail = tail.slice(Math.ceil(tail.length / 4));
    body = build();
  }
  if (encodeURIComponent(body).length > 6500) body = head.slice(0, 2500);
  const q = new URLSearchParams({ title: `[crash] ${crashTitle(r)}`.slice(0, 200), body, labels: 'crash' });
  return `https://github.com/${repo}/issues/new?${q.toString()}`;
}

export type SendResult = { via: 'sentry'; eventId: string } | { via: 'github'; url: string };

export async function sendCrashReport(r: CrashReport, opts: { dsn: Dsn | null; fetchImpl?: typeof fetch; repo?: string }): Promise<SendResult> {
  if (!opts.dsn) return { via: 'github', url: githubIssueUrl(r, opts.repo) };
  const { body, eventId } = sentryEnvelope(r);
  const res = await (opts.fetchImpl ?? fetch)(opts.dsn.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${opts.dsn.publicKey}, sentry_client=airbridge/${r.version}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`crash endpoint answered HTTP ${res.status}`);
  return { via: 'sentry', eventId };
}
