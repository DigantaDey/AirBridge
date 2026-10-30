#!/usr/bin/env node
/**
 * Cross-compiles the AirBridge desktop app into dependency-free single-file
 * executables for every supported platform using Bun:
 *
 *   macOS  arm64 (Apple Silicon) + x64 (Intel)
 *   Windows x64 (AMD64)         + arm64
 *   Linux  x64 (AMD64)          + arm64 (e.g. Raspberry Pi), glibc + musl
 *
 * Runs on any OS; only `bun` (npm) and a built dist/client are required.
 *
 *   node scripts/build-desktop.mjs [--skip-client] [--only <target>]
 *
 * Flow: vite build → embed dist/client into packaging/clientAssets.json →
 * bun compile matrix → restore the committed clientAssets stub → checksums.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-bin');
const assetsFile = path.join(root, 'packaging', 'clientAssets.json');
const stubContent = fs.readFileSync(assetsFile, 'utf8'); // committed stub — restored in finally

const TARGETS = [
  { flag: 'bun-darwin-aarch64', out: 'AirBridge-macos-arm64' },
  { flag: 'bun-darwin-x64', out: 'AirBridge-macos-x64' },
  { flag: 'bun-windows-x64', out: 'AirBridge-windows-x64.exe' },
  { flag: 'bun-windows-aarch64', out: 'AirBridge-windows-arm64.exe' },
  { flag: 'bun-linux-x64', out: 'AirBridge-linux-x64' },
  { flag: 'bun-linux-aarch64', out: 'AirBridge-linux-arm64' },
  { flag: 'bun-linux-x64-musl', out: 'AirBridge-linux-x64-musl' },
  { flag: 'bun-linux-aarch64-musl', out: 'AirBridge-linux-arm64-musl' },
];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`✖ ${cmd} ${args.join(' ')} exited with ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

const args = process.argv.slice(2);
const skipClient = args.includes('--skip-client');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

// 1. Built client (embedded into every binary)
if (!skipClient) {
  console.log('▸ vite build (client)');
  run('npx', ['vite', 'build']);
} else if (!fs.existsSync(path.join(root, 'dist/client/index.html'))) {
  console.error('✖ --skip-client but dist/client is missing — run without --skip-client first.');
  process.exit(1);
}

// 2. Serialize client → packaging/clientAssets.json (stub restored in finally)
console.log('▸ generate embedded client assets');
run(process.execPath, [path.join(root, 'scripts/generate-embedded-client.mjs')]);

const bun = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'bun.cmd' : 'bun');
if (!fs.existsSync(bun.replace(/\.cmd$/, ''))) {
  console.error('✖ bun not found — run `npm i -D bun` first.');
  process.exit(1);
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  const targets = only ? TARGETS.filter((t) => t.out.includes(only) || t.flag.includes(only)) : TARGETS;
  if (targets.length === 0) {
    console.error(`✖ no targets match --only ${only}`);
    process.exit(1);
  }

  for (const t of targets) {
    const outfile = path.join(outDir, t.out);
    console.log(`▸ compile ${t.flag} → dist-bin/${t.out}`);
    run(bun, [
      'build',
      '--compile',
      `--target=${t.flag}`,
      '--minify',
      `--outfile=${outfile}`,
      path.join(root, 'packaging', 'desktop-entry.ts'),
    ]);
  }

  // 3. Checksums for release verification (works with `shasum -a 256 -c` / `certutil`)
  const lines = [];
  for (const t of targets) {
    const buf = fs.readFileSync(path.join(outDir, t.out));
    lines.push(`${crypto.createHash('sha256').update(buf).digest('hex')}  ${t.out}`);
  }
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log(`✔ ${targets.length} binary/binaries + SHA256SUMS.txt in dist-bin/`);
} finally {
  // Restore the committed stub so the working tree stays clean.
  fs.writeFileSync(assetsFile, stubContent);
}
