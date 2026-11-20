#!/usr/bin/env node
/**
 * Serializes a built client directory (default: dist/client) into JSON as
 * { "/path": base64 } so `packaging/desktop-entry.ts` can embed the whole UI
 * into a single-file executable via Bun's static JSON import.
 *
 * `scripts/build-desktop.mjs` writes this JSON to a temporary directory and
 * redirects the import via a Bun plugin, so tracked `packaging/clientAssets.json`
 * is never modified during builds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  let clientDir = process.env.AIRBRIDGE_CLIENT_DIST_DIR
    ? path.resolve(process.env.AIRBRIDGE_CLIENT_DIST_DIR)
    : path.join(root, 'dist', 'client');
  let outFile = process.env.AIRBRIDGE_CLIENT_ASSETS_OUT
    ? path.resolve(process.env.AIRBRIDGE_CLIENT_ASSETS_OUT)
    : path.join(root, 'packaging', 'clientAssets.json');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--client-dir') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        console.error('✖ --client-dir requires a directory path');
        process.exit(2);
      }
      clientDir = path.resolve(val);
    } else if (arg === '--out') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        console.error('✖ --out requires a file path');
        process.exit(2);
      }
      outFile = path.resolve(val);
    } else {
      console.error(`✖ unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return { clientDir, outFile };
}

const { clientDir, outFile } = parseArgs(process.argv.slice(2));

if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
  console.error(`No built client at ${clientDir} — run \`npm run build\` (or vite build) first.`);
  process.exit(1);
}

/** Walk the built client and emit deterministic URL-path -> base64 entries. */
function collect(dir, prefix = '') {
  const out = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const urlPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(out, collect(full, urlPath));
    } else if (entry.isFile()) {
      out[urlPath] = fs.readFileSync(full).toString('base64');
    }
  }
  return out;
}

const assets = collect(clientDir);
const json = JSON.stringify(assets);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const tmpOut = `${outFile}.tmp.${process.pid}`;
try {
  fs.writeFileSync(tmpOut, json);
  fs.renameSync(tmpOut, outFile);
} finally {
  if (fs.existsSync(tmpOut)) {
    fs.rmSync(tmpOut, { force: true });
  }
}

const totalBytes = Object.values(assets).reduce((n, b64) => n + Buffer.from(b64, 'base64').byteLength, 0);
console.log(
  `Embedded ${Object.keys(assets).length} client files (${(totalBytes / 1024).toFixed(0)} KiB) -> ${path.relative(root, outFile) || outFile}`
);
