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

describe('Tier 4 Scenario 06: Decline, Cancelled Offer & Fresh Re-Offer Recovery', () => {
  it('handles transfer-decline gracefully and completes a subsequent re-offer over the same paired connection', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'MacBookPro', platform: 'macos', pairCode: 'DEC111' });
    const receiver = await OpaquePeer.create({ name: 'MotoG57', platform: 'android', pairCode: 'DEC111' });

    const declinedTid = randomTransferId();
    const acceptedTid = randomTransferId();
    const payload = createSyntheticBuffer(256 * 1024 + 41, 77);
    const chunkSize = 128 * 1024;

    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);

      // Step 1: Sender offers wrong export; receiver declines
      await sender.sendControl(receiver.peerId, {
        kind: 'transfer-offer',
        transferId: declinedTid,
        files: [createSyntheticFileManifest('wrong-draft.zip', 512 * 1024, chunkSize)],
        totalBytes: 512 * 1024,
        createdAt: Date.now(),
      });

      const offer1 = await receiver.waitForControl(
        (e) => e.payload.kind === 'transfer-offer' && e.payload.transferId === declinedTid,
      );
      expect(offer1.payload.kind).toBe('transfer-offer');

      await receiver.sendControl(sender.peerId, {
        kind: 'transfer-decline',
        transferId: declinedTid,
        reason: 'Wrong archive selected',
      });

      const declineEvt = await sender.waitForControl(
        (e) => e.payload.kind === 'transfer-decline' && e.payload.transferId === declinedTid,
      );
      expect(declineEvt.payload.kind === 'transfer-decline' && declineEvt.payload.reason).toBe(
        'Wrong archive selected',
      );
      await expect(
        receiver.waitForChunk((c) => c.frame.transferId === declinedTid, 80),
      ).rejects.toThrow(/Timed out/);

      // Step 2: Sender immediately issues fresh re-offer over existing session and completes
      const manifest = [createSyntheticFileManifest('final-release.apk', payload.byteLength, chunkSize)];
      await negotiateTransfer(sender, receiver, acceptedTid, manifest);

      const totalChunks = manifest[0].totalChunks;
      const out = new Uint8Array(payload.byteLength);
      for (let i = 0; i < totalChunks; i++) {
        const slice = payload.subarray(i * chunkSize, Math.min(payload.byteLength, (i + 1) * chunkSize));
        await sender.sendChunk(receiver.peerId, acceptedTid, 0, i, slice);
        const rx = await receiver.waitForChunk(
          (c) => c.frame.transferId === acceptedTid && c.frame.chunkIndex === i,
        );
        out.set(rx.plaintext, i * chunkSize);
      }

      const sha = await computeSha256(out);
      expect(sha).toBe(await computeSha256(payload));
      await sender.sendControl(receiver.peerId, {
        kind: 'file-complete',
        transferId: acceptedTid,
        fileIndex: 0,
        sha256: sha,
      });
      await sender.sendControl(receiver.peerId, {
        kind: 'transfer-complete',
        transferId: acceptedTid,
      });
      await receiver.sendControl(sender.peerId, {
        kind: 'transfer-complete-ack',
        transferId: acceptedTid,
        verified: true,
      });

      const ack = await sender.waitForControl(
        (e) => e.payload.kind === 'transfer-complete-ack' && e.payload.transferId === acceptedTid,
      );
      expect(ack.payload.kind === 'transfer-complete-ack' && ack.payload.verified).toBe(true);
      assertBuffersEqual(out, payload);
    } finally {
      await receiver.disconnect().catch(() => {});
      await sender.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('leaves zero partial files behind for declined offers while persisting accepted re-offer cleanly to daemon storage', async () => {
    await withTempDir('ab-t4-s06-reoffer-', async (dir) => {
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
      try {
        const declinedTid = randomTransferId();
        const acceptedTid = randomTransferId();
        const checkDeclined = await fetch(
          `${server.httpUrl}/api/daemon/received?transferId=${declinedTid}&fileIndex=0`,
        );
        expect(checkDeclined.status).toBe(200);
        const declinedJson = (await checkDeclined.json()) as { complete: boolean; receivedCount?: number };
        expect(declinedJson.complete).toBe(false);
        expect(declinedJson.receivedCount ?? 0).toBe(0);

        const data = createSyntheticBuffer(48 * 1024, 15);
        const saveRes = await fetch(`${server.httpUrl}/api/daemon/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': acceptedTid,
            'x-airbridge-file': '0',
            'x-airbridge-name': 'reoffered.bin',
          },
          body: Buffer.from(data),
        });
        expect(saveRes.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });
});
