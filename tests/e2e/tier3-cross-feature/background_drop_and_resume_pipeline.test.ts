import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  withTempDir,
} from '../harness/index.js';

describe('Tier 3 Cross-Feature: Background Drop & Offset Resumption Pipeline', () => {
  it('completes a multi-file batch across a simulated background network handover with resumeFromChunks', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const desktop = await OpaquePeer.create({ name: 'MacBook', platform: 'macos', pairCode: 'HND111' });
    let android = await OpaquePeer.create({
      name: 'Moto G57',
      platform: 'android',
      deviceId: '1122334455667788',
      pairCode: 'HND111',
    });

    const chunkSize = 64 * 1024;
    const f0 = createSyntheticBuffer(chunkSize * 2, 11);
    const f1 = createSyntheticBuffer(chunkSize * 4, 22);
    const rx0 = new Uint8Array(f0.byteLength);
    const rx1 = new Uint8Array(f1.byteLength);
    const tid = randomTransferId();

    try {
      await Promise.all([desktop.connect(server.wsUrl), android.connect(server.wsUrl)]);
      await desktop.waitForPeer((p) => p.peerId === android.peerId);
      await negotiateTransfer(desktop, android, tid, [
        {
          index: 0,
          name: 'doc.pdf',
          size: f0.byteLength,
          mimeType: 'application/pdf',
          totalChunks: 2,
          chunkSize,
        },
        {
          index: 1,
          name: 'clip.mp4',
          size: f1.byteLength,
          mimeType: 'video/mp4',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      // Complete file 0 and first 2 chunks of file 1 before drop
      for (const c of [0, 1]) {
        await desktop.sendChunk(android.peerId, tid, 0, c, f0.subarray(c * chunkSize, (c + 1) * chunkSize));
        const rx = await android.waitForChunk(
          (x) => x.frame.transferId === tid && x.frame.fileIndex === 0 && x.frame.chunkIndex === c,
        );
        rx0.set(rx.plaintext, c * chunkSize);
      }
      for (const c of [0, 1]) {
        await desktop.sendChunk(android.peerId, tid, 1, c, f1.subarray(c * chunkSize, (c + 1) * chunkSize));
        const rx = await android.waitForChunk(
          (x) => x.frame.transferId === tid && x.frame.fileIndex === 1 && x.frame.chunkIndex === c,
        );
        rx1.set(rx.plaintext, c * chunkSize);
      }
      await android.disconnect();

      // Reconnect after Wi-Fi -> 5G -> Wi-Fi handover and request resume on file 1 from chunk 2
      android = await OpaquePeer.create({
        name: 'Moto G57',
        platform: 'android',
        deviceId: '1122334455667788',
        pairCode: 'HND111',
      });
      await android.connect(server.wsUrl);
      await desktop.waitForPeer((p) => p.peerId === android.peerId);
      await android.sendControl(desktop.peerId, {
        kind: 'transfer-accept',
        transferId: tid,
        preferredTransport: 'ws-relay',
        resumeFromChunks: { 0: 2, 1: 2 },
        resumeBytesTotal: f0.byteLength + chunkSize * 2,
      });
      await desktop.waitForControl(
        (e) =>
          e.from === android.peerId &&
          e.payload.kind === 'transfer-accept' &&
          e.payload.transferId === tid,
      );

      for (const c of [2, 3]) {
        await desktop.sendChunk(android.peerId, tid, 1, c, f1.subarray(c * chunkSize, (c + 1) * chunkSize));
        const rx = await android.waitForChunk(
          (x) => x.frame.transferId === tid && x.frame.fileIndex === 1 && x.frame.chunkIndex === c,
        );
        rx1.set(rx.plaintext, c * chunkSize);
      }

      expect(await computeSha256(rx0)).toBe(await computeSha256(f0));
      expect(await computeSha256(rx1)).toBe(await computeSha256(f1));
    } finally {
      await android.disconnect().catch(() => {});
      await desktop.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('recovers partial disk receive state across a full server process restart', async () => {
    await withTempDir('ab-t3-srv-restart-', async (dir) => {
      const tid = randomTransferId();
      const chunkSize = 64 * 1024;
      const fullData = createSyntheticBuffer(chunkSize * 2, 77);
      const expectedSha = await computeSha256(fullData);

      // Server generation 1 receives chunk 0
      const srv1 = await startTestServer({
        enableMdns: false,
        hostClipboard: false,
        daemonConfig: {
          enabled: true,
          autoSaveToDownloads: true,
          downloadDir: dir,
          notifyOnReceive: false,
          revealInFinder: false,
        },
      });
      try {
        const res = await fetch(`${srv1.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': 'across-restart.bin',
            'x-airbridge-size': String(fullData.byteLength),
            'x-airbridge-chunk-size': String(chunkSize),
            'x-airbridge-total-chunks': '2',
          },
          body: Buffer.from(fullData.subarray(0, chunkSize)),
        });
        expect(res.status).toBe(200);
      } finally {
        await srv1.close();
      }

      // Server generation 2 recovers journal/part state on same downloadDir and finishes chunk 1
      const srv2 = await startTestServer({
        enableMdns: false,
        hostClipboard: false,
        daemonConfig: {
          enabled: true,
          autoSaveToDownloads: true,
          downloadDir: dir,
          notifyOnReceive: false,
          revealInFinder: false,
        },
      });
      try {
        const query = await fetch(
          `${srv2.httpUrl}/api/daemon/received?transferId=${tid}&fileIndex=0`,
        );
        const info = (await query.json()) as { receivedChunks?: number[]; complete: boolean };
        expect(info.receivedChunks).toEqual([0]);
        expect(info.complete).toBe(false);

        const res2 = await fetch(`${srv2.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '1',
            'x-airbridge-name': 'across-restart.bin',
            'x-airbridge-size': String(fullData.byteLength),
            'x-airbridge-chunk-size': String(chunkSize),
            'x-airbridge-total-chunks': '2',
          },
          body: Buffer.from(fullData.subarray(chunkSize)),
        });
        expect(res2.status).toBe(200);

        const fin = await fetch(`${srv2.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0, expectedSha256: expectedSha }),
        });
        expect(fin.status).toBe(200);
      } finally {
        await srv2.close();
      }
    });
  });

  it('preserves clipboard delivery continuity immediately after background socket recovery', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const mac = await OpaquePeer.create({ name: 'Mac', pairCode: 'CLR222' });
    let phone = await OpaquePeer.create({ name: 'Phone', pairCode: 'CLR222' });
    try {
      await Promise.all([mac.connect(server.wsUrl), phone.connect(server.wsUrl)]);
      await mac.waitForPeer((p) => p.peerId === phone.peerId);
      await phone.disconnect();

      phone = await OpaquePeer.create({ name: 'Phone', pairCode: 'CLR222' });
      await phone.connect(server.wsUrl);
      await mac.waitForPeer((p) => p.peerId === phone.peerId);

      await phone.sendControl(mac.peerId, {
        kind: 'clipboard-beam',
        beamId: 'post-reconnect-clip',
        contentType: 'text',
        text: 'synced-after-doze-wakeup',
        timestamp: Date.now(),
      });
      const rx = await mac.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'post-reconnect-clip',
      );
      expect(rx.payload.kind === 'clipboard-beam' && rx.payload.text).toBe(
        'synced-after-doze-wakeup',
      );
    } finally {
      await phone.disconnect().catch(() => {});
      await mac.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('recovers from non-contiguous gap by combining SACK selective bits with resumeFromChunks', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const mac = await OpaquePeer.create({ name: 'Mac', pairCode: 'GAP333' });
    const phone = await OpaquePeer.create({ name: 'Phone', pairCode: 'GAP333' });
    try {
      await Promise.all([mac.connect(server.wsUrl), phone.connect(server.wsUrl)]);
      await mac.waitForPeer((p) => p.peerId === phone.peerId);
      const tid = randomTransferId();
      // Inform sender that chunk 0 is contiguous and chunk 2 (bit 1 = 0b10) also arrived before pause
      await phone.sendCanonicalBinarySack(mac.peerId, tid, 0, 0, 0b00000010);
      const sack = await mac.waitForSack((s) => s.canonical?.transferId === tid);
      expect(sack.canonical?.chunkIndex).toBe(0);
      expect(sack.canonical?.bitmask).toBe(0b00000010);
    } finally {
      await mac.disconnect().catch(() => {});
      await phone.disconnect().catch(() => {});
      await server.close();
    }
  });
});
