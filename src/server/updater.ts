/**
 * Self-update for the packaged desktop service (and the macOS app bundle).
 *
 * Model (Chrome / VS Code style): check in the background, download and verify
 * the new build in the background ("staged"), then one click (or the next
 * restart) swaps it in atomically and restarts.
 *
 * Integrity, in order:
 *   1. HTTPS to GitHub only (redirects followed only to GitHub hosts in production).
 *   2. SHA-256 of the asset must match the release's SHA256SUMS.txt.
 *   3. Anti-downgrade: only strictly newer, non-prerelease versions.
 *   4. Smoke test: the staged binary must run and report exactly the new
 *      version (`--version`); app bundles must also pass `codesign --verify`.
 *   5. Atomic swap with the previous build kept; if the new build fails to
 *      stay up (3 starts without becoming healthy), it is rolled back.
 * Releases also carry Sigstore build-provenance attestations produced by the
 * release workflow (`gh attestation verify <file> -R DigantaDey/AirBridge`).
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'installed' | 'error' | 'up-to-date';

export interface UpdateStatus {
  supported: boolean;
  reason?: string;
  current: string;
  latest: string | null;
  available: boolean;
  state: UpdateState;
  error: string | null;
  lastChecked: string | null;
  releaseUrl: string | null;
  notes: string | null;
  asset: string | null;
  autoCheck: boolean;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  url: string;
  notes: string;
  assets: { name: string; url: string; size: number }[];
}

export interface UpdaterOptions {
  currentVersion: string;
  stateDir: string;
  executablePath: string;
  /** macOS: the AirBridge.app this service runs from (updates replace the whole bundle). */
  appBundlePath?: string | null;
  repo?: string;
  apiBase?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  autoCheck?: boolean;
  checkIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Restrict downloads to these hosts (production: GitHub). Empty = any (tests). */
  allowedHosts?: string[];
  maxDownloadBytes?: number;
  runVersion?: (binary: string) => Promise<string | null>;
  extractZip?: (zip: string, destDir: string) => Promise<void>;
  verifyBundle?: (bundle: string) => Promise<boolean>;
  /** Called after a successful install; should restart the service. */
  onInstalled?: (info: { version: string; appBundle: boolean }) => void;
  log?: (msg: string) => void;
}

const GITHUB_HOSTS = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
];

const PENDING_FILE = 'update-pending.json';

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** >0 if a is newer than b; prereleases / unparsable never compare as newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function assetNameFor(opts: { platform: NodeJS.Platform; arch: string; executablePath: string; appBundle: boolean }): string | null {
  const arch = opts.arch === 'arm64' ? 'arm64' : opts.arch === 'x64' ? 'x64' : null;
  if (!arch) return null;
  if (opts.appBundle && opts.platform === 'darwin') return `AirBridge-macOS-${arch}.zip`;
  switch (opts.platform) {
    case 'darwin': return `AirBridge-darwin-${arch}`;
    case 'win32': return `AirBridge-windows-${arch}.exe`;
    case 'linux': return `AirBridge-linux-${arch}${/musl/i.test(path.basename(opts.executablePath)) ? '-musl' : ''}`;
    default: return null;
  }
}

/**
 * The AirBridge.app bundle this service ships in (release builds embed it at
 * Contents/Resources/airbridge-server; ~/.local/bin/AirBridge may be a symlink
 * to it). Self-updates then replace the whole signed bundle, never one file in it.
 */
export function appBundleForExecutable(execPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.AIRBRIDGE_APP_BUNDLE;
  if (fromEnv && fromEnv.endsWith('.app')) return fromEnv;
  let real = execPath;
  try { real = fs.realpathSync(execPath); } catch { /* keep the given path */ }
  const m = /^(.*?\.app)\/Contents\/Resources\/[^/]+$/.exec(real);
  return m ? m[1]! : null;
}

/** node / bun / deno / tsx themselves: never an AirBridge release binary. */
export function isScriptRuntime(execPath: string): boolean {
  return /^(node|nodejs|bun|deno|tsx)(\.exe)?$/i.test(path.basename(execPath));
}

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) map.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return map;
}

function defaultRunVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 20_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const word = String(stdout).trim().split(/\s+/).pop();
      resolve(word || null);
    });
  });
}

function defaultExtractZip(zip: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zip, destDir], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

function defaultVerifyBundle(bundle: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 60_000 }, (err) => resolve(!err));
  });
}

function readBundleVersion(bundle: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return m ? m[1]!.trim() : null;
  } catch { return null; }
}

function moveSync(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export class Updater {
  private readonly o: Required<Omit<UpdaterOptions, 'appBundlePath' | 'onInstalled' | 'log' | 'fetchImpl'>> & UpdaterOptions;
  private status: UpdateStatus;
  private release: ReleaseInfo | null = null;
  private staged: { version: string; path: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(options: UpdaterOptions) {
    this.o = {
      repo: 'DigantaDey/AirBridge',
      apiBase: 'https://api.github.com',
      platform: process.platform,
      arch: process.arch,
      autoCheck: true,
      checkIntervalMs: 6 * 60 * 60 * 1000,
      allowedHosts: GITHUB_HOSTS,
      maxDownloadBytes: 400 * 1024 * 1024,
      runVersion: defaultRunVersion,
      extractZip: defaultExtractZip,
      verifyBundle: defaultVerifyBundle,
      // An explicit `undefined` must never override a (security) default.
      ...(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as UpdaterOptions),
    };
    const asset = this.assetName();
    const versioned = parseVersion(options.currentVersion) !== null;
    const runtime = isScriptRuntime(options.executablePath);
    const supported = versioned && asset !== null && !runtime;
    this.status = {
      supported,
      reason: supported ? undefined
        : runtime || !versioned ? 'Development builds do not self-update.'
        : 'No release build for this platform.',
      current: options.currentVersion,
      latest: null,
      available: false,
      state: 'idle',
      error: null,
      lastChecked: null,
      releaseUrl: null,
      notes: null,
      asset,
      autoCheck: this.o.autoCheck,
    };
  }

  private log(msg: string): void {
    (this.o.log ?? ((m: string) => console.log(m)))(`[airbridge] update: ${msg}`);
  }

  get appBundle(): boolean {
    return Boolean(this.o.appBundlePath) && this.o.platform === 'darwin';
  }

  assetName(): string | null {
    return assetNameFor({ platform: this.o.platform, arch: this.o.arch, executablePath: this.o.executablePath, appBundle: this.appBundle });
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /** Background checks: shortly after start, then every `checkIntervalMs`. Stages updates automatically. */
  start(initialDelayMs = 60_000): void {
    if (!this.status.supported || !this.o.autoCheck || this.timer) return;
    const run = () => { void this.checkAndStage().catch(() => {}); };
    const first = setTimeout(run, initialDelayMs);
    first.unref();
    this.timer = setInterval(run, this.o.checkIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async fetchChecked(url: string, init?: RequestInit): Promise<Response> {
    const f = this.o.fetchImpl ?? fetch;
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(current);
      if (this.o.allowedHosts.length > 0) {
        if (u.protocol !== 'https:' || !this.o.allowedHosts.includes(u.hostname)) {
          throw new Error(`refusing to download from ${u.protocol}//${u.hostname}`);
        }
      }
      const res = await f(current, { ...init, redirect: 'manual', headers: { 'User-Agent': `AirBridge/${this.o.currentVersion}`, ...(init?.headers ?? {}) } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  }

  async check(): Promise<UpdateStatus> {
    if (!this.status.supported) return this.getStatus();
    this.status.state = 'checking';
    this.status.error = null;
    try {
      const res = await this.fetchChecked(`${this.o.apiBase}/repos/${this.o.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`release lookup failed (HTTP ${res.status})`);
      const json = (await res.json()) as {
        tag_name?: string; html_url?: string; body?: string; draft?: boolean; prerelease?: boolean;
        assets?: { name: string; browser_download_url: string; size: number }[];
      };
      if (json.draft || json.prerelease || !json.tag_name || !parseVersion(json.tag_name)) throw new Error('latest release is not a stable version');
      this.release = {
        version: json.tag_name.replace(/^v/, ''),
        tag: json.tag_name,
        url: json.html_url ?? '',
        notes: (json.body ?? '').slice(0, 4000),
        assets: (json.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      };
      this.status.latest = this.release.version;
      this.status.releaseUrl = this.release.url || null;
      this.status.notes = this.release.notes || null;
      this.status.available = compareVersions(this.release.version, this.o.currentVersion) > 0;
      this.status.lastChecked = new Date().toISOString();
      if (!this.status.available) this.status.state = 'up-to-date';
      else this.status.state = this.staged?.version === this.release.version ? 'ready' : 'idle';
    } catch (err) {
      this.status.state = 'error';
      this.status.error = (err as Error).message;
    }
    return this.getStatus();
  }

  /** Check, then download + verify (stage) a newer release. Never installs. */
  async checkAndStage(): Promise<UpdateStatus> {
    if (this.busy) { await this.busy.catch(() => {}); return this.getStatus(); }
    const job = (async () => {
      await this.check();
      if (this.status.available && this.status.state !== 'ready' && this.status.state !== 'error') await this.stage();
      return this.getStatus();
    })();
    this.busy = job;
    try { return await job; } finally { this.busy = null; }
  }

  private async download(url: string, dest: string, expectedSha: string): Promise<void> {
    const res = await this.fetchChecked(url);
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest, { mode: 0o600 });
    let total = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.o.maxDownloadBytes) throw new Error('download exceeds the size limit');
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    } finally {
      // Wait for the descriptor to close: executing a file that is still open
      // for writing fails with ETXTBSY on Linux.
      await new Promise<void>((r) => { out.once('close', () => r()); out.end(); });
    }
    const actual = hash.digest('hex');
    if (actual !== expectedSha) {
      fs.rmSync(dest, { force: true });
      throw new Error(`checksum mismatch for ${path.basename(url)} (expected ${expectedSha.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
    }
  }

  async stage(): Promise<UpdateStatus> {
    const release = this.release;
    const assetName = this.assetName();
    if (!release || !assetName || !this.status.available) return this.getStatus();
    this.status.state = 'downloading';
    this.status.error = null;
    const dir = path.join(this.o.stateDir, 'updates', release.version);
    try {
      const asset = release.assets.find((a) => a.name === assetName);
      const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
      if (!asset) throw new Error(`release ${release.tag} has no ${assetName}`);
      if (!sums) throw new Error(`release ${release.tag} has no SHA256SUMS.txt`);
      const sumsRes = await this.fetchChecked(sums.url);
      if (!sumsRes.ok) throw new Error(`checksum list download failed (HTTP ${sumsRes.status})`);
      const expected = parseChecksums(await sumsRes.text()).get(assetName);
      if (!expected) throw new Error(`SHA256SUMS.txt has no entry for ${assetName}`);

      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, assetName);
      await this.download(asset.url, file, expected);

      let stagedPath: string;
      if (this.appBundle) {
        const extractDir = path.join(dir, 'app');
        fs.mkdirSync(extractDir);
        await this.o.extractZip(file, extractDir);
        const bundle = path.join(extractDir, 'AirBridge.app');
        if (!fs.existsSync(bundle)) throw new Error('update archive does not contain AirBridge.app');
        if (readBundleVersion(bundle) !== release.version) throw new Error('update bundle reports a different version');
        if (!(await this.o.verifyBundle(bundle))) throw new Error('update bundle failed its code-signature check');
        const server = path.join(bundle, 'Contents', 'Resources', 'airbridge-server');
        const reported = await this.o.runVersion(server);
        if (reported !== release.version) throw new Error(`staged service reports ${reported ?? 'nothing'} instead of ${release.version}`);
        fs.rmSync(file, { force: true });
        stagedPath = bundle;
      } else {
        fs.chmodSync(file, 0o755);
        const reported = await this.o.runVersion(file);
        if (reported !== release.version) throw new Error(`downloaded build reports ${reported ?? 'nothing'} instead of ${release.version}`);
        stagedPath = file;
      }
      this.staged = { version: release.version, path: stagedPath };
      this.status.state = 'ready';
      this.log(`${release.version} downloaded and verified; ready to install`);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      this.staged = null;
      this.status.state = 'error';
      this.status.error = (err as Error).message;
      this.log(`staging failed: ${(err as Error).message}`);
    }
    return this.getStatus();
  }

  /** Swap the staged build in and restart. Stages first if needed. */
  async install(): Promise<UpdateStatus> {
    if (!this.staged) await this.checkAndStage();
    const staged = this.staged;
    if (!staged) return this.getStatus();
    this.status.state = 'installing';
    try {
      const previousDir = path.join(this.o.stateDir, 'previous');
      fs.mkdirSync(previousDir, { recursive: true, mode: 0o700 });
      let target: string;
      let previous: string;
      if (this.appBundle) {
        target = this.o.appBundlePath!;
        previous = path.join(previousDir, 'AirBridge.app');
        fs.rmSync(previous, { recursive: true, force: true });
        moveSync(target, previous);
        try {
          moveSync(staged.path, target);
        } catch (err) {
          moveSync(previous, target);
          throw err;
        }
      } else {
        target = this.o.executablePath;
        previous = `${target}.previous`;
        const incoming = `${target}.new`;
        fs.copyFileSync(staged.path, incoming);
        fs.chmodSync(incoming, 0o755);
        fs.rmSync(previous, { force: true });
        fs.renameSync(target, previous); // allowed for a running executable (also on Windows)
        try {
          fs.renameSync(incoming, target);
        } catch (err) {
          fs.renameSync(previous, target);
          throw err;
        }
      }
      fs.writeFileSync(
        path.join(this.o.stateDir, PENDING_FILE),
        JSON.stringify({ from: this.o.currentVersion, to: staged.version, target, previous, appBundle: this.appBundle, attempts: 0 }),
        { mode: 0o600 },
      );
      fs.rmSync(path.join(this.o.stateDir, 'updates'), { recursive: true, force: true });
      this.status.state = 'installed';
      this.log(`installed ${staged.version}; restarting`);
      const info = { version: staged.version, appBundle: this.appBundle };
      this.staged = null;
      setTimeout(() => this.o.onInstalled?.(info), 250).unref();
    } catch (err) {
      this.status.state = 'error';
      this.status.error = `install failed: ${(err as Error).message}`;
      this.log(this.status.error);
    }
    return this.getStatus();
  }
}

export interface PendingUpdate {
  from: string;
  to: string;
  target: string;
  previous: string;
  appBundle: boolean;
  attempts: number;
}

/**
 * Call at service start. Returns 'rolled-back' when the freshly installed
 * build failed to become healthy three times (the caller should exit so the
 * supervisor starts the restored build), otherwise 'ok'. Call
 * `confirmUpdateHealthy` once the service has been up for a while.
 */
export function resolvePendingUpdate(stateDir: string, currentVersion: string, log: (m: string) => void = console.error): 'none' | 'pending' | 'rolled-back' {
  const file = path.join(stateDir, PENDING_FILE);
  let pending: PendingUpdate;
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingUpdate;
  } catch {
    return 'none';
  }
  if (pending.to !== currentVersion) {
    fs.rmSync(file, { force: true });
    return 'none';
  }
  pending.attempts += 1;
  if (pending.attempts <= 3) {
    fs.writeFileSync(file, JSON.stringify(pending), { mode: 0o600 });
    return 'pending';
  }
  try {
    const failed = pending.appBundle ? `${pending.previous}.failed` : `${pending.target}.failed`;
    fs.rmSync(failed, { recursive: true, force: true });
    moveSync(pending.target, failed);
    moveSync(pending.previous, pending.target);
    log(`[airbridge] update: ${pending.to} did not start correctly; rolled back to ${pending.from}`);
  } catch (err) {
    log(`[airbridge] update: rollback failed: ${(err as Error).message}`);
  }
  fs.rmSync(file, { force: true });
  return 'rolled-back';
}

export function confirmUpdateHealthy(stateDir: string): void {
  fs.rmSync(path.join(stateDir, PENDING_FILE), { force: true });
}
