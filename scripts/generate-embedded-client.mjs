#!/usr/bin/env node
/**
 * Serializes dist/client into packaging/clientAssets.json as { "/path": base64 }
 * so `packaging/desktop-entry.ts` can embed the whole UI into a single-file
 * executable via Bun's static JSON import.
 *
 * The generated file is temporary: scripts/build-desktop.mjs restores the
 * committed stub afterwards so typecheck and git stay clean.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'dist', 'client');
const outFile = path.join(root, 'packaging', 'clientAssets.json');

if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
  console.error(`No built client at ${clientDir} — run \`npm run build\` (or vite build) first.`);
  process.exit(1);
}

/** Walk the built client and emit URL-path -> base64 entries. */
function collect(dir, prefix = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
fs.writeFileSync(outFile, json);

const totalBytes = Object.values(assets).reduce((n, b64) => n + Buffer.from(b64, 'base64').byteLength, 0);
console.log(
  `Embedded ${Object.keys(assets).length} client files (${(totalBytes / 1024).toFixed(0)} KiB) -> ${path.relative(root, outFile)}`
);
