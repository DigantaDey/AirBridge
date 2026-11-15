import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  createSyntheticBuffer,
  createSyntheticFileManifest,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  withTempDir,
} from '../harness/index.js';

describe('Tier 4 Scenario 04: Interrupted Wi-Fi Handover & Exact Offset Resumption', () => {
  it('survives receiver Wi-Fi->5G->Wi-Fi drop mid-stream and finalizes bit-exact file via daemon partial storage', async () => {
    await withTempDir('ab-t4-s04-handover-', async (dir) => {
      const server = await startTestServer({
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

      const sender = await OpaquePeer.create({ name: 'MacBookPro', platform: 'macos', pairCode: 'WIF111' });
      let phone = await OpaquePeer.create({
        name: 'Moto G57',
        platform: 'android',
        deviceId: '0011223344556677',
        pairCode: 'WIF111',
      });

      const chunkSize = 64 * 1024;
      const totalChunks = 6;
      const payload = createSyntheticBuffer(totalChunks * chunkSize + 333, 64);
      const expectedSha = await computeSha256(payload);
      const tid = randomTransferId();

      try {
        await Promise.all([sender.connect(server.wsUrl), phone.connect(server.wsUrl)]);
        await sender.waitForPeer((p) => p.peerId === phone.peerId);
        await negotiateTransfer(sender, phone, tid, [
          createSyntheticFileManifest('handover-video.mp4', payload.byteLength, chunkSize, 'video/mp4'),
        ]);

        // Phase 1: Receive chunks 0..2 and flush to daemon partial cache before link drop
        for (let idx = 0; idx < 3; idx++) {
          const slice = payload.subarray(idx * chunkSize, (idx + 1) * chunkSize);
          await sender.sendChunk(phone.peerId, tid, 0, idx, slice);
          const rx = await phone.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx);
          const put = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-airbridge-transfer': tid,
              'x-airbridge-file': '0',
              'x-airbridge-chunk': String(idx),
              'x-airbridge-name': 'handover-video.mp4',
              'x-airbridge-size': String(payload.byteLength),
              'x-airbridge-chunk-size': String(chunkSize),
              'x-airbridge-total-chunks': String(totalChunks + 1),
            },
            body: Buffer.from(rx.plaintext),
          });
          expect(put.status).toBe(200);
        }

        // Simulate abrupt Wi-Fi interface loss on Android
        await phone.disconnect();

        // Phase 2: Android reconnects on new network, checks persisted offset, and requests resume
        const statusRes = await fetch(`${server.httpUrl}/api/daemon/received?transferId=${tid}&fileIndex=0`);
        expect(statusRes.status).toBe(200);
        const partial = (await statusRes.json()) as { receivedCount: number; receivedChunks: number[] };
        expect(partial.receivedCount).toBe(3);
        expect(partial.receivedChunks).toEqual([0, 1, 2]);

        phone = await OpaquePeer.create({
          name: 'Moto G57',
          platform: 'android',
          deviceId: '0011223344556677',
          pairCode: 'WIF111',
        });
        await phone.connect(server.wsUrl);
        await sender.waitForPeer((p) => p.peerId === phone.peerId);

        await phone.sendControl(sender.peerId, {
          kind: 'transfer-accept',
          transferId: tid,
          preferredTransport: 'ws-relay',
          resumeFromChunks: { 0: partial.receivedCount },
          resumeBytesTotal: partial.receivedCount * chunkSize,
        });

        const resumeAccept = await sender.waitForControl(
          (e) =>
            e.from === phone.peerId &&
            e.payload.kind === 'transfer-accept' &&
            e.payload.transferId === tid,
        );
        const startChunk =
          resumeAccept.payload.kind === 'transfer-accept'
            ? (resumeAccept.payload.resumeFromChunks?.[0] ?? 0)
            : 0;
        expect(startChunk).toBe(3);

        // Stream remaining chunks 3..6 (tail chunk 6)
        const actualTotalChunks = Math.ceil(payload.byteLength / chunkSize);
        for (let idx = startChunk; idx < actualTotalChunks; idx++) {
          const slice = payload.subarray(idx * chunkSize, Math.min(payload.byteLength, (idx + 1) * chunkSize));
          await sender.sendChunk(phone.peerId, tid, 0, idx, slice);
          const rx = await phone.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx);
          const put = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-airbridge-transfer': tid,
              'x-airbridge-file': '0',
              'x-airbridge-chunk': String(idx),
              'x-airbridge-name': 'handover-video.mp4',
              'x-airbridge-size': String(payload.byteLength),
              'x-airbridge-chunk-size': String(chunkSize),
              'x-airbridge-total-chunks': String(actualTotalChunks),
            },
            body: Buffer.from(rx.plaintext),
          });
          expect(put.status).toBe(200);
        }

        const fin = await fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0, expectedSha256: expectedSha }),
        });
        expect(fin.status).toBe(200);
        const finJson = (await fin.json()) as { savedPath: string; sha256: string };
        expect(finJson.sha256).toBe(expectedSha);

        const savedBytes = await readFile(finJson.savedPath || join(dir, 'handover-video.mp4'));
        assertBuffersEqual(savedBytes, payload);
      } finally {
        await phone.disconnect().catch(() => {});
        await sender.disconnect().catch(() => {});
        await server.close();
      }
    });
  });

  it('recovers smoothly when sender drops mid-transfer and reconnects with same identity and pair room', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    let sender = await OpaquePeer.create({
      name: 'MacHandover',
      platform: 'macos',
      deviceId: 'feedfacecafebeef',
      pairCode: 'W9F222',
    });
    const receiver = await OpaquePeer.create({
      name: 'AndroidHandover',
      platform: 'android',
      pairCode: 'W9F222',
    });

    const chunkSize = 64 * 1024;
    const data = createSyntheticBuffer(4 * chunkSize, 129);
    const out = new Uint8Array(data.byteLength);
    const tid = randomTransferId();

    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      await negotiateTransfer(sender, receiver, tid, [
        createSyntheticFileManifest('sender-handover.bin', data.byteLength, chunkSize),
      ]);

      await sender.sendChunk(receiver.peerId, tid, 0, 0, data.subarray(0, chunkSize));
      out.set(
        (await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 0)).plaintext,
        0,
      );

      await sender.disconnect();

      sender = await OpaquePeer.create({
        name: 'MacHandover-Reconnected',
        platform: 'macos',
        deviceId: 'feedfacecafebeef',
        pairCode: 'W9F222',
      });
      const welcome = await sender.connect(server.wsUrl);
      expect(welcome.pairCode).toBe('W9F222');
      await receiver.waitForPeer(
        (p) => p.peerId === sender.peerId && p.device.deviceId === 'feedfacecafebeef',
      );

      for (const idx of [1, 2, 3]) {
        await sender.sendChunk(receiver.peerId, tid, 0, idx, data.subarray(idx * chunkSize, (idx + 1) * chunkSize));
        out.set(
          (await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx)).plaintext,
          idx * chunkSize,
        );
      }

      assertBuffersEqual(out, data);
    } finally {
      await sender.disconnect().catch(() => {});
      await receiver.disconnect().catch(() => {});
      await server.close();
    }
  });
});
