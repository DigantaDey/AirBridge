import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, resolveConfig } from 'vite';
import { resolveViteAllowedHosts, resolveViteHost } from '../vite.config';

const root = path.resolve(__dirname, '..');
const trackedAssetsFile = path.join(root, 'packaging', 'clientAssets.json');

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hostTargetForCurrentPlatform(): { flag: string; out: string } | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { flag: 'bun-darwin-aarch64', out: 'AirBridge-darwin-arm64' };
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { flag: 'bun-darwin-x64', out: 'AirBridge-darwin-x64' };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { flag: 'bun-linux-x64', out: 'AirBridge-linux-x64' };
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { flag: 'bun-linux-aarch64', out: 'AirBridge-linux-arm64' };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { flag: 'bun-windows-x64', out: 'AirBridge-windows-x64.exe' };
  }
  return null;
}

function httpRequestWithHost(port: number, hostHeader: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: { Host: hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('vite.config.ts DNS-rebinding host hardening (S-1)', () => {
  it('defaults server and preview to loopback host and explicit allowlist (never allowedHosts: true)', async () => {
    expect(resolveViteHost({})).toBe('127.0.0.1');
    const allowed = resolveViteAllowedHosts({});
    expect(Array.isArray(allowed)).toBe(true);
    expect(allowed).toContain('localhost');
    expect(allowed).toContain('.localhost');
    expect(allowed).toContain('127.0.0.1');
    expect(allowed).toContain('::1');

    const resolved = await resolveConfig({ configFile: path.join(root, 'vite.config.ts'), mode: 'development' }, 'serve');
    expect(resolved.server.host).toBe('127.0.0.1');
    expect(resolved.preview.host).toBe('127.0.0.1');
    expect(resolved.server.allowedHosts).not.toBe(true);
    expect(resolved.preview.allowedHosts).not.toBe(true);
    expect(Array.isArray(resolved.server.allowedHosts)).toBe(true);
    expect(Array.isArray(resolved.preview.allowedHosts)).toBe(true);
  });

  it('supports opt-in LAN dev env vars while filtering wildcard/true values from allowedHosts', () => {
    expect(resolveViteHost({ AIRBRIDGE_LAN_DEV: '1' })).toBe('0.0.0.0');
    expect(resolveViteHost({ AIRBRIDGE_VITE_HOST: '192.168.1.10', AIRBRIDGE_LAN_DEV: '1' })).toBe('192.168.1.10');

    const allowed = resolveViteAllowedHosts({
      AIRBRIDGE_VITE_ALLOWED_HOSTS: 'dev-mac.local, *, true,  , phone.local',
    });
    expect(allowed).toContain('dev-mac.local');
    expect(allowed).toContain('phone.local');
    expect(allowed).not.toContain('*');
    expect(allowed).not.toContain('true');
  });

  it('rejects DNS-rebinding Host headers with 403 while permitting localhost and 127.0.0.1 on a real Vite server', async () => {
    const server = await createServer({
      configFile: path.join(root, 'vite.config.ts'),
      server: { port: 0, watch: null },
      logLevel: 'silent',
    });
    await server.listen();
    try {
      const addr = server.httpServer?.address();
      expect(addr && typeof addr === 'object').toBe(true);
      const port = (addr as { port: number }).port;

      const evil = await httpRequestWithHost(port, `evil.rebind.test:${port}`);
      expect(evil.statusCode).toBe(403);
      expect(evil.body).toContain('Blocked request');

      const local = await httpRequestWithHost(port, `localhost:${port}`);
      expect(local.statusCode).not.toBe(403);

      const loopback = await httpRequestWithHost(port, `127.0.0.1:${port}`);
      expect(loopback.statusCode).not.toBe(403);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('generate-embedded-client.mjs & build-desktop.mjs signal safety (B-5)', () => {
  it('generate-embedded-client.mjs writes sorted base64 assets to --out without mutating packaging/clientAssets.json', () => {
    const beforeSha = sha256File(trackedAssetsFile);
    const tmp = makeTempDir('airbridge-gen-assets-');
    const clientDir = path.join(tmp, 'client');
    const nestedDir = path.join(clientDir, 'assets');
    const outFile = path.join(tmp, 'out', 'clientAssets.json');

    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'z.txt'), 'last');
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<h1>AirBridge Test</h1>');
    fs.writeFileSync(path.join(nestedDir, 'app.js'), 'console.log("ok");');

    const res = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/generate-embedded-client.mjs'), '--client-dir', clientDir, '--out', outFile],
      { cwd: root, encoding: 'utf8' },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(sha256File(trackedAssetsFile)).toBe(beforeSha);

    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(['/assets/app.js', '/index.html', '/z.txt']);
    expect(Buffer.from(parsed['/index.html'], 'base64').toString('utf8')).toBe('<h1>AirBridge Test</h1>');
    expect(Buffer.from(parsed['/assets/app.js'], 'base64').toString('utf8')).toBe('console.log("ok");');

    const missingVal = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/generate-embedded-client.mjs'), '--out'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(missingVal.status).not.toBe(0);
    expect(sha256File(trackedAssetsFile)).toBe(beforeSha);
  });

  it('build-desktop.mjs fails non-zero when --only is missing its target value', () => {
    const res = spawnSync(process.execPath, [path.join(root, 'scripts/build-desktop.mjs'), '--only'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--only requires a target name');
  });

  it('build-desktop.mjs compiles an isolated host binary and leaves packaging/clientAssets.json untouched', () => {
    const target = hostTargetForCurrentPlatform();
    if (!target) return;

    const beforeSha = sha256File(trackedAssetsFile);
    const tmp = makeTempDir('airbridge-build-isolated-');
    const clientDir = path.join(tmp, 'client');
    const outBinDir = path.join(tmp, 'dist-bin');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<html><body>Custom Build</body></html>');
    fs.writeFileSync(path.join(clientDir, 'marker.txt'), 'isolated-build-marker');

    const buildRes = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/build-desktop.mjs'), '--skip-client', '--only', target.out],
      {
        cwd: root,
        env: {
          ...process.env,
          AIRBRIDGE_CLIENT_DIST_DIR: clientDir,
          AIRBRIDGE_DIST_BIN_DIR: outBinDir,
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(buildRes.status, buildRes.stderr).toBe(0);
    expect(sha256File(trackedAssetsFile)).toBe(beforeSha);

    const binPath = path.join(outBinDir, target.out);
    expect(fs.existsSync(binPath)).toBe(true);
    expect(fs.existsSync(path.join(outBinDir, 'SHA256SUMS.txt'))).toBe(true);
    const sums = fs.readFileSync(path.join(outBinDir, 'SHA256SUMS.txt'), 'utf8');
    expect(sums).toContain(`${sha256File(binPath)}  ${target.out}`);

    const verRes = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    expect(verRes.status, verRes.stderr).toBe(0);
    expect(verRes.stdout).toMatch(/^airbridge \d+\.\d+\.\d+/);
  }, 40_000);

  it('leaves packaging/clientAssets.json clean and cleans temp dirs when terminated mid-build via SIGTERM', async () => {
    const target = hostTargetForCurrentPlatform();
    if (!target) return;

    const beforeSha = sha256File(trackedAssetsFile);
    const tmp = makeTempDir('airbridge-build-sigterm-');
    const clientDir = path.join(tmp, 'client');
    const outBinDir = path.join(tmp, 'dist-bin');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<html><body>Signal Test</body></html>');

    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts/build-desktop.mjs'), '--skip-client', '--only', target.out],
      {
        cwd: root,
        env: {
          ...process.env,
          AIRBRIDGE_CLIENT_DIST_DIR: clientDir,
          AIRBRIDGE_DIST_BIN_DIR: outBinDir,
          TMPDIR: tmp,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let signaled = false;
      const timer = setTimeout(() => {
        if (!signaled) {
          signaled = true;
          child.kill('SIGTERM');
        }
      }, 2000);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (!signaled && stdout.includes('compile ')) {
          signaled = true;
          child.kill('SIGTERM');
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(sha256File(trackedAssetsFile)).toBe(beforeSha);
    const remainingTmp = fs.readdirSync(tmp).filter((entry) => entry.startsWith('airbridge-desktop-build-'));
    expect(remainingTmp).toEqual([]);
  }, 20_000);
});
