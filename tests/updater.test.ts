// @vitest-environment node
/**
 * Self-update: staged download, SHA-256 verification, anti-downgrade, smoke
 * test, atomic swap with backup, and rollback of a build that will not start.
 * A local HTTP server plays GitHub's releases API and asset hosting.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Updater, assetNameFor, compareVersions, parseChecksums, resolvePendingUpdate } from '../src/server/updater.js';

let dir: string;
let server: http.Server;
let base: string;
let routes: Record<string, { status?: number; body: string | Buffer; headers?: Record<string, string> }>;

const fakeBinary = (version: string) => `#!/bin/sh\nif [ "$1" = --version ]; then echo "airbridge ${version}"; exit 0; fi\nexit 0\n`;
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function release(version: string, assets: Record<string, string | Buffer>, sums?: string, extra: Record<string, unknown> = {}) {
  routes = {};
  const list = Object.entries(assets).map(([name, body]) => {
    routes[`/dl/${name}`] = { body };
    return { name, browser_download_url: `${base}/dl/${name}`, size: Buffer.byteLength(body) };
  });
  const sumsText = sums ?? Object.entries(assets).map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + '\n';
  routes['/dl/SHA256SUMS.txt'] = { body: sumsText };
  list.push({ name: 'SHA256SUMS.txt', browser_download_url: `${base}/dl/SHA256SUMS.txt`, size: sumsText.length });
  routes['/repos/DigantaDey/AirBridge/releases/latest'] = {
    body: JSON.stringify({ tag_name: `v${version}`, html_url: `${base}/r/v${version}`, body: 'notes', draft: false, prerelease: false, assets: list, ...extra }),
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-updater-'));
  routes = {};
  server = http.createServer((req, res) => {
    const r = routes[req.url ?? ''];
    if (!r) { res.statusCode = 404; res.end('nope'); return; }
    res.writeHead(r.status ?? 200, r.headers ?? {});
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function installedBinary(version: string): string {
  const bin = path.join(dir, 'bin', 'AirBridge-linux-x64');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, fakeBinary(version), { mode: 0o755 });
  return bin;
}

function makeUpdater(exe: string, extra: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
  return new Updater({
    currentVersion: '0.0.5',
    stateDir: path.join(dir, 'state'),
    executablePath: exe,
    platform: 'linux',
    arch: 'x64',
    apiBase: base,
    allowedHosts: [],
    log: () => {},
    ...extra,
  });
}

describe('version and asset helpers', () => {
  it('compares versions and ignores prereleases', () => {
    expect(compareVersions('0.0.6', '0.0.5')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.0.99')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.0.4', '0.0.5')).toBeLessThan(0);
    expect(compareVersions('0.0.6-beta.1', '0.0.5')).toBe(0);
  });
  it('maps platforms to release asset names', () => {
    expect(assetNameFor({ platform: 'darwin', arch: 'arm64', executablePath: '/x', appBundle: true })).toBe('AirBridge-macOS-arm64.zip');
    expect(assetNameFor({ platform: 'darwin', arch: 'x64', executablePath: '/x', appBundle: false })).toBe('AirBridge-darwin-x64');
    expect(assetNameFor({ platform: 'linux', arch: 'x64', executablePath: '/b/AirBridge-linux-x64-musl', appBundle: false })).toBe('AirBridge-linux-x64-musl');
    expect(assetNameFor({ platform: 'win32', arch: 'arm64', executablePath: 'C:/a.exe', appBundle: false })).toBe('AirBridge-windows-arm64.exe');
    expect(assetNameFor({ platform: 'linux', arch: 'ia32', executablePath: '/x', appBundle: false })).toBeNull();
  });
  it('parses SHA256SUMS', () => {
    const m = parseChecksums(`${'a'.repeat(64)}  AirBridge-linux-x64\n${'b'.repeat(64)} *AirBridge.apk\ngarbage\n`);
    expect(m.get('AirBridge-linux-x64')).toBe('a'.repeat(64));
    expect(m.get('AirBridge.apk')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });
});

describe('Updater', () => {
  it('stages a verified newer build, then swaps it in atomically and keeps a backup', async () => {
    const exe = installedBinary('0.0.5');
    release('0.0.6', { 'AirBridge-linux-x64': fakeBinary('0.0.6'), 'AirBridge.apk': 'apk' });
    const onInstalled = vi.fn();
    const u = makeUpdater(exe, { onInstalled });

    const staged = await u.checkAndStage();
    expect(staged).toMatchObject({ supported: true, latest: '0.0.6', available: true, state: 'ready', error: null });
    expect(fs.readFileSync(exe, 'utf8')).toContain('0.0.5'); // nothing replaced yet

    const done = await u.install();
    expect(done.state).toBe('installed');
    expect(fs.readFileSync(exe, 'utf8')).toContain('airbridge 0.0.6');
    expect(fs.readFileSync(`${exe}.previous`, 'utf8')).toContain('airbridge 0.0.5');
    expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
    const pending = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'update-pending.json'), 'utf8'));
    expect(pending).toMatchObject({ from: '0.0.5', to: '0.0.6', target: exe, appBundle: false, attempts: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(onInstalled).toHaveBeenCalledWith({ version: '0.0.6', appBundle: false });
  });

  it('rejects a download whose checksum does not match SHA256SUMS', async () => {
    const exe = installedBinary('0.0.5');
    release('0.0.6', { 'AirBridge-linux-x64': fakeBinary('0.0.6') }, `${'0'.repeat(64)}  AirBridge-linux-x64\n`);
    const s = await makeUpdater(exe).checkAndStage();
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(exe, 'utf8')).toContain('0.0.5');
    expect(fs.existsSync(path.join(dir, 'state', 'updates', '0.0.6'))).toBe(false);
  });

  it('rejects a build that does not report the release version (smoke test)', async () => {
    const exe = installedBinary('0.0.5');
    release('0.0.6', { 'AirBridge-linux-x64': fakeBinary('0.0.5') });
    const s = await makeUpdater(exe).checkAndStage();
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/reports 0\.0\.5 instead of 0\.0\.6/);
  });

  it('never downgrades or reinstalls the same version; ignores prereleases', async () => {
    const exe = installedBinary('0.0.5');
    release('0.0.5', { 'AirBridge-linux-x64': fakeBinary('0.0.5') });
    expect((await makeUpdater(exe).checkAndStage()).state).toBe('up-to-date');
    release('0.0.4', { 'AirBridge-linux-x64': fakeBinary('0.0.4') });
    expect((await makeUpdater(exe).checkAndStage())).toMatchObject({ available: false, state: 'up-to-date' });
    release('0.0.7', { 'AirBridge-linux-x64': fakeBinary('0.0.7') }, undefined, { prerelease: true });
    expect((await makeUpdater(exe).checkAndStage()).state).toBe('error');
  });

  it('only downloads over HTTPS from GitHub in production', async () => {
    const exe = installedBinary('0.0.5');
    release('0.0.6', { 'AirBridge-linux-x64': fakeBinary('0.0.6') });
    const s = await makeUpdater(exe, { allowedHosts: undefined as never }).check();
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/refusing to download from http:\/\/127\.0\.0\.1/);
  });

  it('reports a missing asset for this platform clearly', async () => {
    const exe = installedBinary('0.0.5');
    release('0.0.6', { 'AirBridge-windows-x64.exe': 'x' });
    const s = await makeUpdater(exe).checkAndStage();
    expect(s.error).toMatch(/has no AirBridge-linux-x64/);
  });

  it('development builds do not self-update', () => {
    const u = makeUpdater(installedBinary('dev'), { currentVersion: 'dev' });
    expect(u.getStatus()).toMatchObject({ supported: false });
  });

  it('never replaces the node / bun runtime (desktop entry run from source)', async () => {
    for (const exe of ['/usr/bin/node', '/opt/homebrew/bin/bun', 'C:/Program Files/nodejs/node.exe']) {
      const u = makeUpdater(exe);
      expect(u.getStatus()).toMatchObject({ supported: false, reason: 'Development builds do not self-update.' });
      release('0.0.6', { 'AirBridge-linux-x64': fakeBinary('0.0.6') });
      expect((await u.install()).state).not.toBe('installed');
    }
  });

  it('macOS: replaces the whole app bundle (verified signature + version)', async () => {
    const apps = path.join(dir, 'Applications');
    const bundle = path.join(apps, 'AirBridge.app');
    const makeBundle = (root: string, version: string) => {
      fs.mkdirSync(path.join(root, 'Contents', 'Resources'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
      fs.writeFileSync(path.join(root, 'Contents', 'Resources', 'airbridge-server'), fakeBinary(version), { mode: 0o755 });
    };
    makeBundle(bundle, '0.0.5');
    release('0.0.6', { 'AirBridge-macOS-arm64.zip': 'zip-bytes' });
    const verifyBundle = vi.fn(async () => true);
    const u = makeUpdater(path.join(bundle, 'Contents', 'Resources', 'airbridge-server'), {
      platform: 'darwin',
      arch: 'arm64',
      appBundlePath: bundle,
      extractZip: async (_zip, dest) => makeBundle(path.join(dest, 'AirBridge.app'), '0.0.6'),
      verifyBundle,
    });
    expect((await u.checkAndStage()).state).toBe('ready');
    expect(verifyBundle).toHaveBeenCalled();
    expect((await u.install()).state).toBe('installed');
    expect(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('0.0.6');
    expect(fs.readFileSync(path.join(dir, 'state', 'previous', 'AirBridge.app', 'Contents', 'Info.plist'), 'utf8')).toContain('0.0.5');
  });

  it('macOS: refuses a bundle that fails code-signature verification', async () => {
    const bundle = path.join(dir, 'AirBridge.app');
    fs.mkdirSync(bundle);
    release('0.0.6', { 'AirBridge-macOS-x64.zip': 'zip' });
    const u = makeUpdater('/x', {
      platform: 'darwin', arch: 'x64', appBundlePath: bundle,
      extractZip: async (_z, dest) => {
        fs.mkdirSync(path.join(dest, 'AirBridge.app', 'Contents'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'AirBridge.app', 'Contents', 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.0.6</string>');
      },
      verifyBundle: async () => false,
    });
    const s = await u.checkAndStage();
    expect(s.error).toMatch(/code-signature/);
  });
});

describe('rollback of an update that does not start', () => {
  it('keeps the update for 3 starts, then restores the previous build', () => {
    const state = path.join(dir, 'state');
    fs.mkdirSync(state, { recursive: true });
    const exe = installedBinary('0.0.6');
    fs.writeFileSync(`${exe}.previous`, fakeBinary('0.0.5'));
    fs.writeFileSync(path.join(state, 'update-pending.json'), JSON.stringify({ from: '0.0.5', to: '0.0.6', target: exe, previous: `${exe}.previous`, appBundle: false, attempts: 0 }));
    const log = vi.fn();
    expect(resolvePendingUpdate(state, '0.0.6', log)).toBe('pending');
    expect(resolvePendingUpdate(state, '0.0.6', log)).toBe('pending');
    expect(resolvePendingUpdate(state, '0.0.6', log)).toBe('pending');
    expect(resolvePendingUpdate(state, '0.0.6', log)).toBe('rolled-back');
    expect(fs.readFileSync(exe, 'utf8')).toContain('0.0.5');
    expect(fs.readFileSync(`${exe}.failed`, 'utf8')).toContain('0.0.6');
    expect(log.mock.calls.at(-1)![0]).toMatch(/rolled back to 0\.0\.5/);
    expect(resolvePendingUpdate(state, '0.0.5', log)).toBe('none');
  });
});

describe('appBundleForExecutable', () => {
  it('finds the bundle for the embedded server, also through a symlink', async () => {
    const { appBundleForExecutable } = await import('../src/server/updater.js');
    const bundle = path.join(dir, 'Applications', 'AirBridge.app');
    const server = path.join(bundle, 'Contents', 'Resources', 'airbridge-server');
    fs.mkdirSync(path.dirname(server), { recursive: true });
    fs.writeFileSync(server, 'x');
    const link = path.join(dir, 'AirBridge');
    fs.symlinkSync(server, link);
    expect(appBundleForExecutable(server, {})).toBe(fs.realpathSync(bundle));
    expect(appBundleForExecutable(link, {})).toBe(fs.realpathSync(bundle));
    expect(appBundleForExecutable('/usr/local/bin/AirBridge', {})).toBeNull();
    expect(appBundleForExecutable('/x', { AIRBRIDGE_APP_BUNDLE: '/Applications/AirBridge.app' })).toBe('/Applications/AirBridge.app');
  });
});
