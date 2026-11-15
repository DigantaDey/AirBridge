import { readdir } from 'node:fs/promises';
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

describe('Tier 4 Scenario 09: Low-Storage Mid-Transfer Abort & Partial Cleanup', () => {
  it('propagates receiver transfer-cancel and purges partial daemon artifacts with zero leftover .part files', async () => {
    await withTempDir('ab-t4-s09-lowdisk-', async (dir) => {
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
      const sender = await OpaquePeer.create({ name: 'MacStorage', platform: 'macos', pairCode: 'LOW111' });
      const receiver = await OpaquePeer.create({ name: 'PhoneFull', platform: 'android', pairCode: 'LOW111' });

      const chunkSize = 64 * 1024;
      const totalChunks = 5;
      const payload = createSyntheticBuffer(chunkSize * totalChunks, 13);
      const tid = randomTransferId();

      try {
        await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
        await sender.waitForPeer((p) => p.peerId === receiver.peerId);
        await negotiateTransfer(sender, receiver, tid, [
          createSyntheticFileManifest('huge-backup.tar', payload.byteLength, chunkSize),
        ]);

        // Receive chunks 0..1 into daemon staging area
        for (const idx of [0, 1]) {
          await sender.sendChunk(
            receiver.peerId,
            tid,
            0,
            idx,
            payload.subarray(idx * chunkSize, (idx + 1) * chunkSize),
          );
          const rx = await receiver.waitForChunk(
            (c) => c.frame.transferId === tid && c.frame.chunkIndex === idx,
          );
          const wr = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-airbridge-transfer': tid,
              'x-airbridge-file': '0',
              'x-airbridge-chunk': String(idx),
              'x-airbridge-name': 'huge-backup.tar',
              'x-airbridge-size': String(payload.byteLength),
              'x-airbridge-chunk-size': String(chunkSize),
              'x-airbridge-total-chunks': String(totalChunks),
            },
            body: Buffer.from(rx.plaintext),
          });
          expect(wr.status).toBe(200);
        }

        // Low-storage trap triggers graceful abort: signal sender + discard partial files
        await receiver.sendControl(sender.peerId, {
          kind: 'transfer-cancel',
          transferId: tid,
        });
        const cancelEvt = await sender.waitForControl(
          (e) => e.payload.kind === 'transfer-cancel' && e.payload.transferId === tid,
        );
        expect(cancelEvt.payload.kind === 'transfer-cancel' && cancelEvt.payload.transferId).toBe(tid);

        const discardRes = await fetch(`${server.httpUrl}/api/daemon/discard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0 }),
        });
        expect(discardRes.status).toBe(200);

        const receivedAfter = await fetch(
          `${server.httpUrl}/api/daemon/received?transferId=${tid}&fileIndex=0`,
        );
        const stateAfter = (await receivedAfter.json()) as {
          complete: boolean;
          receivedCount?: number;
        };
        expect(stateAfter.complete).toBe(false);
        expect(stateAfter.receivedCount ?? 0).toBe(0);

        // Verify downloadDir contains no orphan partial or final artifact for huge-backup.tar
        const entries = await readdir(dir);
        expect(entries.some((f) => f.includes('huge-backup') || f.endsWith('.part'))).toBe(false);
      } finally {
        await receiver.disconnect().catch(() => {});
        await sender.disconnect().catch(() => {});
        await server.close();
      }
    });
  });

  it('completes a subsequent smaller transfer cleanly immediately after a low-storage abort', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'MacRetry', platform: 'macos', pairCode: 'LOW222' });
    const receiver = await OpaquePeer.create({ name: 'PhoneRetry', platform: 'android', pairCode: 'LOW222' });

    const abortedTid = randomTransferId();
    const okTid = randomTransferId();
    const okData = createSyntheticBuffer(64 * 1024 + 5, 51);

    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      await negotiateTransfer(sender, receiver, abortedTid, [
        createSyntheticFileManifest('aborted.bin', 512 * 1024, 64 * 1024),
      ]);
      await receiver.sendControl(sender.peerId, {
        kind: 'transfer-cancel',
        transferId: abortedTid,
      });
      await sender.waitForControl(
        (e) => e.payload.kind === 'transfer-cancel' && e.payload.transferId === abortedTid,
      );

      await negotiateTransfer(sender, receiver, okTid, [
        createSyntheticFileManifest('small-ok.txt', okData.byteLength, 32 * 1024),
      ]);
      const out = new Uint8Array(okData.byteLength);
      const chunks = Math.ceil(okData.byteLength / (32 * 1024));
      for (let i = 0; i < chunks; i++) {
        await sender.sendChunk(
          receiver.peerId,
          okTid,
          0,
          i,
          okData.subarray(i * 32 * 1024, Math.min(okData.byteLength, (i + 1) * 32 * 1024)),
        );
        const rx = await receiver.waitForChunk(
          (c) => c.frame.transferId === okTid && c.frame.chunkIndex === i,
        );
        out.set(rx.plaintext, i * 32 * 1024);
      }
      expect(await computeSha256(out)).toBe(await computeSha256(okData));
      assertBuffersEqual(out, okData);
    } finally {
      await receiver.disconnect().catch(() => {});
      await sender.disconnect().catch(() => {});
      await server.close();
    }
  });
});
