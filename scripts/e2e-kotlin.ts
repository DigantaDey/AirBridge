/**
 * TypeScript side of the Kotlin <-> TS engine interop test.
 *
 * Paired with `E2EHarnessKt k` (which writes its SAS to
 * <baseDir>/kts-sas.txt before waiting). Sequence:
 *   1. discover the Kotlin engine, verify SAS matches,
 *   2. TS -> Kotlin file transfer (Kotlin verifies on its disk),
 *   3. clipboard TS -> Kotlin,
 *   4. Kotlin -> TS file transfer (daemon saves to expectDownloadDir; verified),
 *   5. clipboard Kotlin -> TS.
 *
 *   npx tsx scripts/e2e-kotlin.ts [wsUrl] [expectDownloadDir] [baseDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  WarpClient,
  type ClipboardBeamItem,
  type TransferSessionView,
} from '../src/client/engine/warpClient.js';

const wsUrl = process.argv[2] || 'ws://127.0.0.1:3411/ws';
const expectDownloadDir = process.argv[3] || '';
const baseDir = process.argv[4] || '/tmp/ab-e2e';

function waitFor(predicate: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
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
  console.log(`▸ e2e-kotlin: connecting to ${wsUrl}`);
  let tsClip: ClipboardBeamItem | null = null;
  let tsIncoming: TransferSessionView | null = null;

  const ts = new WarpClient({
    wsUrl,
    enableWebRtc: false,
    autoAcceptAll: true,
    deviceOverride: { name: 'TS Bridge', platform: 'macos', model: 'Mac', formFactor: 'laptop' },
    onIncomingClipboard: (item) => {
      tsClip = item;
    },
    onIncomingTransfer: (t) => {
      tsIncoming = t;
    },
  });
  let lastTransfers = '';
  ts.subscribe((snap) => {
    const desc = snap.transfers
      .map((x) => `${x.direction}:${x.status}:${x.transferredBytes}/${x.totalBytes}`)
      .join(',');
    if (desc !== lastTransfers) {
      lastTransfers = desc;
      console.log(`  [ts-snap] ${desc || '(none)'} daemon=${snap.localDaemon?.enabled ? 'on' : 'off'}`);
    }
  });

  await ts.start();
  await waitFor(() => ts.getSnapshot().peers.length === 1, 'TS sees the Kotlin engine');
  const kPeer = ts.getSnapshot().peers[0].peerId;
  // Session derivation can land just after the peer becomes visible — wait
  // for a real SAS before comparing (the placeholder is '··· ···').
  await waitFor(
    () => /^\d{3} \u00b7 \d{3}$/.test(ts.getSnapshot().peerSecurity[kPeer]?.sasCode ?? ''),
    'TS derived the ECDH session (SAS)',
    30_000,
  );
  const tsSas = ts.getSnapshot().peerSecurity[kPeer]?.sasCode ?? 'missing';
  const sasFile = path.join(baseDir, 'kts-sas.txt');
  let kSas = '';
  await waitFor(() => {
    if (!fs.existsSync(sasFile)) return false;
    const raw = fs.readFileSync(sasFile, 'utf8').trim();
    if (/^\d{3} \u00b7 \d{3}$/.test(raw)) {
      kSas = raw;
      return true;
    }
    return false; // tolerate a partially flushed write
  }, 'Kotlin SAS file written');
  if (tsSas !== kSas) throw new Error(`SAS mismatch: TS=${tsSas} K=${kSas}`);
  if (!/^\d{3} \u00b7 \d{3}$/.test(tsSas)) throw new Error(`bad SAS format: ${tsSas}`);
  console.log(`  ok: discovery + matching SAS (${tsSas})`);

  // Leg 1: TS -> Kotlin
  const toK = makeFile('e2e-kts-ts.bin', 1024 * 1024 + 1536 + 777);
  const toKSha = crypto.createHash('sha256').update(Buffer.from(toK.raw)).digest('hex');
  const outDone = new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      const done = ts
        .getSnapshot()
        .transfers.find((x) => x.direction === 'outgoing' && x.status === 'completed');
      const failed = ts
        .getSnapshot()
        .transfers.find((x) => x.direction === 'outgoing' && (x.status === 'error' || x.status === 'declined'));
      if (done) {
        clearInterval(t);
        resolve();
      } else if (failed) {
        clearInterval(t);
        reject(new Error(`TS -> K transfer ended as ${failed.status}: ${failed.errorMessage ?? ''}`));
      }
    }, 40);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error('TS -> K timed out'));
    }, 90_000);
  });
  await ts.sendFiles(kPeer, [toK.input]);
  await outDone;
  console.log(`  ok: TS -> Kotlin transfer completed (sha ${toKSha.slice(0, 12)}…)`);
  if (toKSha.length !== 64) throw new Error('bad sha');

  // Leg 3a: clipboard TS -> Kotlin (Kotlin waits for this before sending back)
  await ts.sendClipboard(kPeer, 'hello-from-ts-456');
  console.log('  ok: clipboard TS -> Kotlin dispatched');

  // Leg 2: Kotlin -> TS (auto-accepted; daemon should persist to expectDownloadDir)
  const inDone = new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      const s = ts.getSnapshot();
      const done = s.transfers.find((x) => x.direction === 'incoming' && x.status === 'completed');
      const failed = s.transfers.find(
        (x) => x.direction === 'incoming' && (x.status === 'error' || x.status === 'declined'),
      );
      if (done) {
        clearInterval(t);
        resolve();
      } else if (failed) {
        clearInterval(t);
        reject(new Error(`K -> TS ended as ${failed.status}`));
      }
    }, 40);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error('K -> TS timed out'));
    }, 90_000);
  });
  await inDone;
  const incoming = ts
    .getSnapshot()
    .transfers.find((x) => x.direction === 'incoming' && x.status === 'completed')!;
  if (incoming.receivedFiles.some((f) => !f.verified)) {
    throw new Error('TS received an unverified file from K');
  }
  console.log('  ok: Kotlin -> TS transfer completed + verified');

  if (expectDownloadDir) {
    const saved = incoming.receivedFiles
      .map((f) => f.savedToMacPath)
      .filter(Boolean) as string[];
    if (saved.length === 0) throw new Error('no daemon-saved path for TS receiver');
    const onDisk = crypto.createHash('sha256').update(fs.readFileSync(saved[0])).digest('hex');
    // Kotlin harness sends pattern (i*31+17)&0xff — identical to makeFile()
    const expectSha = crypto
      .createHash('sha256')
      .update(Buffer.from(makeFile('e2e-kts-k.bin', 600 * 1024).raw))
      .digest('hex');
    if (onDisk !== expectSha) throw new Error(`daemon sha mismatch: ${onDisk} vs ${expectSha}`);
    if (!saved[0].startsWith(expectDownloadDir)) {
      throw new Error(`saved outside expected dir: ${saved[0]}`);
    }
    console.log(`  ok: daemon direct-to-disk write verified (${saved[0]})`);
  }

  // Leg 3b: clipboard Kotlin -> TS
  await waitFor(() => tsClip !== null, 'TS received Kotlin clipboard');
  const gotClip = tsClip as ClipboardBeamItem | null;
  if (gotClip?.text !== 'hello-from-kotlin-123') {
    throw new Error(`clipboard mismatch: ${gotClip?.text}`);
  }
  console.log('  ok: clipboard Kotlin -> TS verified');

  ts.stop();
  console.log('\nTS side of K<->TS E2E PASSED');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nE2E-KOTLIN FAILED:', err);
    process.exit(1);
  });
