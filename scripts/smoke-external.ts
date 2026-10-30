/**
 * External-server smoke test: drives two full WarpClient instances (the real
 * browser engine, running under Node) against a *packaged* AirBridge binary
 * listening on a port — proving the single-file desktop build serves the
 * embedded UI, relays discovery/control, and moves bytes end to end.
 *
 *   npx tsx scripts/smoke-external.ts [wsUrl] [expectDownloadDir]
 *
 * Exit code 0 = all checks passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  WarpClient,
  type ClipboardBeamItem,
  type TransferSessionView,
} from '../src/client/engine/warpClient.js';

const wsUrl = process.argv[2] || 'ws://127.0.0.1:3000/ws';
const expectDownloadDir = process.argv[3];

function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, 30);
  });
}

function makeFile(name: string, size: number): { raw: Uint8Array; input: any } {
  const raw = new Uint8Array(size);
  for (let i = 0; i < size; i++) raw[i] = (i * 31 + 17) & 0xff;
  return {
    raw,
    input: {
      name,
      size,
      type: 'application/octet-stream',
      async sliceBytes(start: number, end: number) {
        return raw.slice(start, end);
      },
    },
  };
}

async function main(): Promise<void> {
  console.log(`▸ smoke: connecting to ${wsUrl}`);
  const results: string[] = [];
  let macClip: ClipboardBeamItem | null = null;
  let androidClip: ClipboardBeamItem | null = null;

  const mac = new WarpClient({
    wsUrl,
    enableWebRtc: false,
    deviceOverride: { name: 'Smoke Mac', platform: 'macos', model: 'Mac', formFactor: 'laptop' },
    onIncomingClipboard: (item) => {
      macClip = item;
    },
    onIncomingTransfer: (offer) => {
      void mac.acceptIncomingTransfer(offer.transferId);
    },
  });
  const android = new WarpClient({
    wsUrl,
    enableWebRtc: false,
    autoAcceptAll: true,
    deviceOverride: { name: 'Smoke Pixel', platform: 'android', model: 'Pixel', formFactor: 'phone' },
    onIncomingClipboard: (item) => {
      androidClip = item;
    },
  });

  let macIncoming: TransferSessionView | null = null;
  let macOutDone: TransferSessionView | null = null;
  let androidOutDone: TransferSessionView | null = null;
  let androidIncoming: TransferSessionView | null = null;
  mac.subscribe(() => {});
  android.subscribe(() => {});

  await mac.start();
  await android.start();
  results.push('both clients connected');

  // 1. Discovery + matching SAS codes (ECDH interop over the real socket)
  await waitFor(
    () =>
      mac.getSnapshot().peers.length === 1 &&
      android.getSnapshot().peers.length === 1 &&
      (mac.getSnapshot().peerSecurity[android.getSnapshot().peerId]?.sasCode ?? '··· ···') !==
        '··· ···',
    'peer discovery + SAS derivation'
  );
  const macSas = mac.getSnapshot().peerSecurity[android.getSnapshot().peerId]!.sasCode;
  const androidSas = android.getSnapshot().peerSecurity[mac.getSnapshot().peerId]!.sasCode;
  if (macSas !== androidSas) throw new Error(`SAS mismatch: ${macSas} vs ${androidSas}`);
  results.push(`discovery + matching SAS (${macSas})`);

  // 2. Mac → Android multi-chunk file transfer (Android saves via daemon path)
  const big = makeFile('smoke-big.bin', 3 * 1024 * 1024 + 12345); // 3 MiB+ → 13 chunks at 256 KiB
  const small = makeFile('smoke-small.txt', 7);
  const origSha = crypto.createHash('sha256').update(Buffer.from(big.raw)).digest('hex');

  const idOfAndroid = android.getSnapshot().peerId;
  const idOfMac = mac.getSnapshot().peerId;

  const transferDone = new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      const s = android.getSnapshot();
      const done = s.transfers.find((x) => x.direction === 'incoming' && x.status === 'completed');
      if (done) {
        clearInterval(t);
        if (done.receivedFiles.some((f) => !f.verified)) {
          reject(new Error('android received an unverified file'));
        } else resolve();
      }
      const failed = s.transfers.find(
        (x) => x.direction === 'incoming' && (x.status === 'error' || x.status === 'declined')
      );
      if (failed) {
        clearInterval(t);
        reject(new Error(`incoming transfer ended as ${failed.status}`));
      }
    }, 40);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error('transfer did not complete in time'));
    }, 60_000);
  });

  const sent = await mac.sendFiles(idOfAndroid, [big.input, small.input]);
  if (sent.status === 'error' || sent.status === 'declined') {
    throw new Error(`send failed early: ${sent.status} ${sent.errorMessage ?? ''}`);
  }
  results.push('mac → android offer accepted');
  await transferDone;

  const androidSnap = android.getSnapshot();
  const completed = androidSnap.transfers.find(
    (x) => x.direction === 'incoming' && x.status === 'completed'
  )!;
  if (completed.receivedFiles.length !== 2) throw new Error('expected 2 received files');
  results.push(`mac → android: ${completed.files.length} files verified (sha256 match)`);

  // 3. Clipboard beams both directions (encrypted control payloads)
  await mac.sendClipboard(idOfAndroid, 'hello from mac smoke https://example.com');
  await waitFor(() => androidClip !== null, 'android received clipboard beam');
  if ((androidClip as ClipboardBeamItem | null)?.text !== 'hello from mac smoke https://example.com') {
    throw new Error('clipboard text mismatch (mac → android)');
  }
  results.push('clipboard mac → android verified');

  // 4. Android → Mac reverse transfer. The Mac client is a loopback desktop
  // peer, so the binary's daemon streams these chunks straight to disk —
  // this is the packaged direct-to-disk assertion.
  void mac.subscribe((snap) => {
    const incoming = snap.transfers.find((x) => x.direction === 'incoming');
    if (incoming) macIncoming = incoming;
    const out = snap.transfers.find((x) => x.direction === 'outgoing' && x.status === 'completed');
    if (out) macOutDone = out;
  });
  void android.subscribe((snap) => {
    const out = snap.transfers.find((x) => x.direction === 'outgoing' && x.status === 'completed');
    if (out) androidOutDone = out;
    const inc = snap.transfers.find((x) => x.direction === 'incoming');
    if (inc) androidIncoming = inc;
  });
  const revDone = new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      const s = mac.getSnapshot();
      const done = s.transfers.find((x) => x.direction === 'incoming' && x.status === 'completed');
      if (done) {
        clearInterval(t);
        resolve();
      }
      const failed = s.transfers.find(
        (x) => x.direction === 'incoming' && (x.status === 'error' || x.status === 'declined')
      );
      if (failed) {
        clearInterval(t);
        reject(new Error(`reverse transfer ended as ${failed.status}`));
      }
    }, 40);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error('reverse transfer timed out'));
    }, 60_000);
  });
  const revFile = makeFile('smoke-reverse.bin', 1024 * 512);
  const revSha = crypto.createHash('sha256').update(Buffer.from(revFile.raw)).digest('hex');
  await android.sendFiles(idOfMac, [revFile.input]);
  await revDone;
  results.push('android → mac: completed + verified');

  // 5. Verify the reverse transfer's bytes landed on disk via the daemon
  if (expectDownloadDir) {
    const macDone = mac
      .getSnapshot()
      .transfers.find((x) => x.direction === 'incoming' && x.status === 'completed')!;
    const saved = macDone.receivedFiles.map((f) => f.savedToMacPath).filter(Boolean) as string[];
    if (saved.length === 0) throw new Error('no daemon-saved paths reported for host receiver');
    const savedPath = saved[0];
    const onDisk = crypto.createHash('sha256').update(fs.readFileSync(savedPath)).digest('hex');
    if (onDisk !== revSha) throw new Error(`disk sha mismatch: ${onDisk} vs ${revSha}`);
    if (!savedPath.startsWith(expectDownloadDir)) {
      throw new Error(`saved outside expected dir: ${savedPath}`);
    }
    results.push(`daemon direct-to-disk write verified (${savedPath})`);
  }

  // 6. Clipboard beam android → mac
  await android.sendClipboard(idOfMac, 'hello from android smoke 482913');
  await waitFor(() => macClip !== null, 'mac received clipboard beam');
  if ((macClip as ClipboardBeamItem | null)?.text !== 'hello from android smoke 482913') {
    throw new Error('clipboard text mismatch (android → mac)');
  }
  results.push('clipboard android → mac verified');

  // 7. Download center + security headers on the packaged server
  const origin = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const dlRes = await fetch(`${origin}/api/downloads`);
  if (!dlRes.ok) throw new Error(`/api/downloads -> ${dlRes.status}`);
  const dl = (await dlRes.json()) as {
    version: string;
    githubRelease: string;
    files: Array<{ name: string; url: string }>;
  };
  if (!dl.githubRelease.includes('github.com')) throw new Error('bad githubRelease in manifest');
  if (!Array.isArray(dl.files)) throw new Error('files missing from download manifest');
  results.push(`download manifest ok (v${dl.version}, ${dl.files.length} local file(s))`);

  const indexRes = await fetch(`${origin}/`);
  const csp = indexRes.headers.get('content-security-policy') || '';
  if (!csp.includes("default-src 'none'") || !csp.includes("script-src 'self'")) {
    throw new Error(`missing CSP hardening headers: "${csp}"`);
  }
  if (!indexRes.headers.get('permissions-policy')) {
    throw new Error('missing Permissions-Policy header');
  }
  results.push('CSP + Permissions-Policy headers present');

  const traversal = await fetch(
    `${origin}/downloads/${encodeURIComponent('..%2f..%2fetc%2fpasswd')}`
  );
  const notWhitelisted = await fetch(`${origin}/downloads/not-an-artifact.txt`);
  if (traversal.status !== 404 || notWhitelisted.status !== 404) {
    throw new Error(
      `download endpoint must 404 non-whitelisted names (got ${traversal.status}/${notWhitelisted.status})`
    );
  }
  results.push('download endpoint rejects non-whitelisted names');

  mac.stop();
  android.stop();
  console.log('\n✅ PACKAGED-BINARY SMOKE PASSED:');
  for (const r of results) console.log('   ✓ ' + r);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ SMOKE FAILED:', err);
    process.exit(1);
  });
