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
 * Flow: vite build -> embed dist/client into a temp JSON file ->
 * Bun.build compile matrix (redirecting ./clientAssets.json to temp JSON so
 * tracked packaging/clientAssets.json is never touched) -> checksums.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { flag: 'bun-darwin-aarch64', out: 'AirBridge-darwin-arm64' },
  { flag: 'bun-darwin-x64', out: 'AirBridge-darwin-x64' },
  { flag: 'bun-windows-x64', out: 'AirBridge-windows-x64.exe' },
  { flag: 'bun-windows-aarch64', out: 'AirBridge-windows-arm64.exe' },
  { flag: 'bun-linux-x64', out: 'AirBridge-linux-x64' },
  { flag: 'bun-linux-aarch64', out: 'AirBridge-linux-arm64' },
  { flag: 'bun-linux-x64-musl', out: 'AirBridge-linux-x64-musl' },
  { flag: 'bun-linux-aarch64-musl', out: 'AirBridge-linux-arm64-musl' },
];

async function runBunCompile(argv) {
  let targetFlag = '';
  let outfile = '';
  let assetsPath = '';
  let entryPath = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') targetFlag = argv[++i] ?? '';
    else if (arg === '--outfile') outfile = argv[++i] ?? '';
    else if (arg === '--assets') assetsPath = argv[++i] ?? '';
    else if (arg === '--entry') entryPath = argv[++i] ?? '';
  }
  if (!targetFlag || !outfile || !assetsPath || !entryPath) {
    console.error('✖ --bun-compile requires --target, --outfile, --assets, and --entry');
    process.exit(2);
  }
  if (typeof Bun === 'undefined') {
    console.error('✖ --bun-compile must be executed with Bun');
    process.exit(1);
  }

  const resolvedEntry = path.resolve(entryPath);
  const resolvedAssets = path.resolve(assetsPath);
  const tmpOutfile = path.join(path.dirname(outfile), `.tmp-${process.pid}-${path.basename(outfile)}`);

  const cleanupTmp = () => {
    if (fs.existsSync(tmpOutfile)) {
      fs.rmSync(tmpOutfile, { force: true });
    }
  };

  const onBunSignal = () => {
    cleanupTmp();
    process.exit(143);
  };
  process.on('SIGINT', onBunSignal);
  process.on('SIGTERM', onBunSignal);
  process.on('SIGHUP', onBunSignal);

  try {
    const result = await Bun.build({
      entrypoints: [resolvedEntry],
      compile: {
        target: targetFlag,
        outfile: tmpOutfile,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
        autoloadDotenv: true,
        autoloadBunfig: true,
      },
      minify: true,
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      plugins: [
        {
          name: 'airbridge-external-client-assets',
          setup(build) {
            build.onResolve({ filter: /(?:^|[\\/])clientAssets\.json$/ }, (args) => {
              if (args.importer && path.resolve(args.importer) === resolvedEntry) {
                return { path: resolvedAssets };
              }
              return undefined;
            });
          },
        },
      ],
    });
    if (!result.success) {
      for (const log of result.logs) {
        console.error(log);
      }
      cleanupTmp();
      process.exit(1);
    }
    fs.renameSync(tmpOutfile, outfile);
  } catch (err) {
    cleanupTmp();
    throw err;
  } finally {
    process.off('SIGINT', onBunSignal);
    process.off('SIGTERM', onBunSignal);
    process.off('SIGHUP', onBunSignal);
  }
}

function parseCoordinatorArgs(argv) {
  let skipClient = false;
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skip-client') {
      skipClient = true;
    } else if (arg === '--only') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        console.error('✖ --only requires a target name (e.g. --only linux-x64)');
        process.exit(2);
      }
      only = val;
    } else {
      console.error(`✖ unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return { skipClient, only };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--bun-compile') {
    await runBunCompile(args.slice(1));
    return;
  }

  const { skipClient, only } = parseCoordinatorArgs(args);
  const clientDir = process.env.AIRBRIDGE_CLIENT_DIST_DIR
    ? path.resolve(process.env.AIRBRIDGE_CLIENT_DIST_DIR)
    : path.join(root, 'dist', 'client');
  const outDir = process.env.AIRBRIDGE_DIST_BIN_DIR
    ? path.resolve(process.env.AIRBRIDGE_DIST_BIN_DIR)
    : path.join(root, 'dist-bin');

  const targets = only ? TARGETS.filter((t) => t.out.includes(only) || t.flag.includes(only)) : TARGETS;
  if (targets.length === 0) {
    console.error(`✖ no targets match --only ${only}`);
    process.exit(1);
  }

  const bunBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'bun.cmd' : 'bun');
  if (!fs.existsSync(bunBin)) {
    console.error('✖ bun not found — run `npm i -D bun` first.');
    process.exit(1);
  }

  let activeChild = null;
  let tmpDir = null;
  let cleaningUp = false;

  const cleanup = () => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    if (fs.existsSync(outDir)) {
      for (const entry of fs.readdirSync(outDir)) {
        if (entry.startsWith('.tmp-') || entry.startsWith('SHA256SUMS.txt.tmp.')) {
          fs.rmSync(path.join(outDir, entry), { force: true });
        }
      }
    }
  };

  const onSignal = (signal) => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (activeChild && !activeChild.killed) {
      activeChild.kill('SIGTERM');
    }
    cleanup();
    const code = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
    process.exit(code);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  const run = (cmd, cmdArgs, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, cmdArgs, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32' && cmd.toLowerCase().endsWith('.cmd'),
        ...opts,
      });
      activeChild = child;
      child.on('error', (err) => {
        activeChild = null;
        reject(err);
      });
      child.on('exit', (code, signal) => {
        activeChild = null;
        if (code === 0) {
          resolve();
        } else {
          const detail = signal ? `signal ${signal}` : `code ${code}`;
          reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited with ${detail}`));
        }
      });
    });

  try {
    // 1. Built client (embedded into every binary)
    if (!skipClient) {
      console.log('▸ vite build (client)');
      const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
      const viteArgs = [viteBin, 'build'];
      if (process.env.AIRBRIDGE_CLIENT_DIST_DIR) {
        viteArgs.push('--outDir', clientDir);
      }
      await run(process.execPath, viteArgs);
    } else if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
      console.error(`✖ --skip-client but ${clientDir} is missing — run without --skip-client first.`);
      process.exitCode = 1;
      return;
    }

    // 2. Serialize client into an isolated temp JSON file (tracked stub stays untouched)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-desktop-build-'));
    const tempAssetsFile = path.join(tmpDir, 'clientAssets.json');
    console.log('▸ generate embedded client assets');
    await run(process.execPath, [
      path.join(root, 'scripts', 'generate-embedded-client.mjs'),
      '--client-dir',
      clientDir,
      '--out',
      tempAssetsFile,
    ]);

    fs.mkdirSync(outDir, { recursive: true });
    const entryPath = path.join(root, 'packaging', 'desktop-entry.ts');
    const selfPath = fileURLToPath(import.meta.url);

    for (const t of targets) {
      const outfile = path.join(outDir, t.out);
      console.log(`▸ compile ${t.flag} -> ${path.relative(root, outfile) || outfile}`);
      await run(bunBin, [
        selfPath,
        '--bun-compile',
        '--target',
        t.flag,
        '--outfile',
        outfile,
        '--assets',
        tempAssetsFile,
        '--entry',
        entryPath,
      ]);
    }

    // 3. Checksums for release verification (works with `shasum -a 256 -c` / `certutil`)
    const lines = [];
    for (const t of targets) {
      const buf = fs.readFileSync(path.join(outDir, t.out));
      lines.push(`${crypto.createHash('sha256').update(buf).digest('hex')}  ${t.out}`);
    }
    const sumsPath = path.join(outDir, 'SHA256SUMS.txt');
    const tmpSumsPath = path.join(outDir, `SHA256SUMS.txt.tmp.${process.pid}`);
    fs.writeFileSync(tmpSumsPath, lines.join('\n') + '\n');
    fs.renameSync(tmpSumsPath, sumsPath);
    console.log(`✔ ${targets.length} binary/binaries + SHA256SUMS.txt in ${path.relative(root, outDir) || outDir}/`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    cleanup();
  }
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
