/**
 * Desktop side of the QR pairing E2E (paired with `QrPairingE2EKt`).
 *
 *   npx tsx scripts/e2e-qr-desktop.ts <wsUrl> <baseDir>
 *
 * 1. Connects like the Mac UI (loopback host desktop) and receives the
 *    advertised endpoints + TLS pin in `welcome`.
 * 2. Renders the pairing QR with the production builder, deliberately
 *    ordering the unreachable campus address first (the reported failure).
 * 3. Waits for the phone to appear as a paired peer, rotates the room code,
 *    renders a fresh QR, and waits for the phone to re-pair.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WarpClient } from '../src/client/engine/warpClient.js';
import { buildPairingUrl } from '../src/client/engine/pairingUrl.js';

const wsUrl = process.argv[2];
const baseDir = process.argv[3];
const CAMPUS = '10.205.95.167';
const HOTSPOT = '10.42.61.23';

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const desktop = new WarpClient({
    wsUrl,
    enableWebRtc: false,
    deviceOverride: { name: 'QR Desktop', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
  });
  await desktop.start();
  await waitFor(() => {
    const snap = desktop.getSnapshot();
    return Boolean(snap.pairCode && snap.tlsPin && snap.lanUrls.length >= 2);
  }, 'welcome with endpoints and TLS pin');

  const origin = new URL(wsUrl.replace(/^ws/, 'http')).origin;
  const port = new URL(origin).port;
  const render = (): string => {
    const snap = desktop.getSnapshot();
    const advertised = new Set(snap.lanUrls);
    assert(advertised.has(`https://${CAMPUS}:${port}`) && advertised.has(`https://${HOTSPOT}:${port}`),
      `advertised endpoints: ${snap.lanUrls.join(', ')}`);
    assert(JSON.stringify((snap.lanEndpoints ?? []).map((e) => e.url)) === JSON.stringify(snap.lanUrls),
      'lanEndpoints and lanUrls disagree');
    // Worst case: OS order puts the campus NIC first.
    const campusFirst = [`https://${CAMPUS}:${port}`, ...snap.lanUrls.filter((u) => !u.includes(CAMPUS))];
    const qr = buildPairingUrl({
      pairCode: snap.pairCode,
      lanUrls: campusFirst,
      pageOrigin: origin,
      pageHostname: '127.0.0.1',
      tlsPin: snap.tlsPin,
    });
    const url = new URL(qr);
    const hosts = [url.hostname, ...(url.searchParams.get('alt') ?? '').split(',').filter(Boolean)];
    for (const host of hosts) assert(advertised.has(`https://${host}:${port}`), `QR host ${host} not advertised`);
    assert(url.searchParams.get('ca') === snap.tlsPin, 'QR pin differs from server pin');
    return qr;
  };

  const qr1 = render();
  console.log(`  [desktop] QR #1 ${qr1}`);
  fs.writeFileSync(path.join(baseDir, 'qr1.txt'), qr1);

  const pairedPhone = (): boolean =>
    desktop.getSnapshot().peers.some((p) => p.discoveryScope === 'paired' && p.device.name === 'QR Phone');
  await waitFor(() => fs.existsSync(path.join(baseDir, 'k-paired-1.txt')), 'phone paired via QR #1');
  await waitFor(pairedPhone, 'desktop sees the phone as paired');
  console.log('  ok: [desktop] phone paired from QR #1');

  const before = desktop.getSnapshot().pairCode;
  desktop.rotatePairCode();
  await waitFor(() => desktop.getSnapshot().pairCode !== before, 'room code rotated');
  const qr2 = render();
  console.log(`  [desktop] QR #2 ${qr2}`);
  fs.writeFileSync(path.join(baseDir, 'qr2.txt'), qr2);
  await waitFor(() => fs.existsSync(path.join(baseDir, 'k-paired-2.txt')), 'phone re-paired via QR #2');
  await waitFor(pairedPhone, 'desktop sees the phone paired after rescan');
  console.log('  ok: [desktop] phone re-paired from fresh QR #2');
  fs.writeFileSync(path.join(baseDir, 'd-paired-2.txt'), 'ok');

  await waitFor(() => fs.existsSync(path.join(baseDir, 'k-done.txt')), 'phone finished', 150_000);
  desktop.stop();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
