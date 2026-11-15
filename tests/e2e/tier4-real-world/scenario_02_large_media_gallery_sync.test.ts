import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  createSyntheticBuffer,
  createSyntheticFileManifest,
  negotiateTransfer,
  randomTransferId,
  withPairedEnv,
} from '../harness/index.js';

describe('Tier 4 Scenario 02: Large Media Gallery & Mixed Video Batch Sync', () => {
  it('transfers 25 photos plus 2 multi-chunk video clips in a single encrypted batch with bit-exact integrity', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const photoSize = 24 * 1024 + 137;
      const videoChunkSize = 512 * 1024;
      const video1Size = 2 * videoChunkSize + 19; // ~1 MiB unaligned tail
      const video2Size = 3 * videoChunkSize; // 1.5 MiB aligned

      const sourceFiles: { name: string; mime: string; data: Uint8Array; chunkSize: number }[] = [];
      for (let i = 0; i < 25; i++) {
        sourceFiles.push({
          name: `IMG_${String(i + 1).padStart(4, '0')}.jpg`,
          mime: 'image/jpeg',
          data: createSyntheticBuffer(photoSize, i + 10),
          chunkSize: photoSize,
        });
      }
      sourceFiles.push(
        {
          name: 'VID_holiday_01.mp4',
          mime: 'video/mp4',
          data: createSyntheticBuffer(video1Size, 201),
          chunkSize: videoChunkSize,
        },
        {
          name: 'VID_holiday_02.mp4',
          mime: 'video/mp4',
          data: createSyntheticBuffer(video2Size, 202),
          chunkSize: videoChunkSize,
        },
      );

      const manifest = sourceFiles.map((f, index) => ({
        ...createSyntheticFileManifest(f.name, f.data.byteLength, f.chunkSize, f.mime),
        index,
      }));

      await negotiateTransfer(androidPeer, desktopPeer, tid, manifest);

      const totalBytes = sourceFiles.reduce((acc, f) => acc + f.data.byteLength, 0);
      const assembled = sourceFiles.map((f) => new Uint8Array(f.data.byteLength));
      const receivedCounts = new Array<number>(sourceFiles.length).fill(0);

      for (let fileIdx = 0; fileIdx < sourceFiles.length; fileIdx++) {
        const file = sourceFiles[fileIdx];
        const totalChunks = manifest[fileIdx].totalChunks;
        const sendBatch = Array.from({ length: totalChunks }, (_, chunkIdx) => {
          const start = chunkIdx * file.chunkSize;
          const end = Math.min(file.data.byteLength, start + file.chunkSize);
          return androidPeer.sendChunk(
            desktopPeer.peerId,
            tid,
            fileIdx,
            chunkIdx,
            file.data.subarray(start, end),
          );
        });
        await Promise.all(sendBatch);

        for (let c = 0; c < totalChunks; c++) {
          const evt = await desktopPeer.waitForChunk(
            (x) =>
              x.frame.transferId === tid &&
              x.frame.fileIndex === fileIdx &&
              x.frame.chunkIndex === c,
          );
          assembled[fileIdx].set(evt.plaintext, c * file.chunkSize);
          receivedCounts[fileIdx]++;
        }

        const expectedSha = await computeSha256(file.data);
        expect(await computeSha256(assembled[fileIdx])).toBe(expectedSha);

        await androidPeer.sendControl(desktopPeer.peerId, {
          kind: 'file-complete',
          transferId: tid,
          fileIndex: fileIdx,
          sha256: expectedSha,
        });
      }

      await desktopPeer.sendCanonicalBinarySack(androidPeer.peerId, tid, sourceFiles.length - 1, 2, 0x07);

      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'transfer-complete',
        transferId: tid,
      });

      const doneEvt = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-complete' && e.payload.transferId === tid,
      );
      expect(doneEvt.payload.kind === 'transfer-complete' && doneEvt.payload.transferId).toBe(tid);

      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'transfer-complete-ack',
        transferId: tid,
        verified: true,
      });
      const ackEvt = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-complete-ack' && e.payload.transferId === tid,
      );
      expect(ackEvt.payload.kind === 'transfer-complete-ack' && ackEvt.payload.verified).toBe(true);

      for (let i = 0; i < sourceFiles.length; i++) {
        expect(receivedCounts[i]).toBe(manifest[i].totalChunks);
        assertBuffersEqual(assembled[i], sourceFiles[i].data);
      }
    });
  }, 30_000);

  it('prevents cross-file contamination when chunks from multiple files arrive interleaved out of order', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const chunkSize = 64 * 1024;
      const f0 = createSyntheticBuffer(3 * chunkSize, 71);
      const f1 = createSyntheticBuffer(3 * chunkSize + 511, 93);
      const manifest = [
        { ...createSyntheticFileManifest('interleave-a.bin', f0.byteLength, chunkSize), index: 0 },
        { ...createSyntheticFileManifest('interleave-b.bin', f1.byteLength, chunkSize), index: 1 },
      ];
      await negotiateTransfer(desktopPeer, androidPeer, tid, manifest);

      // Interleave chunks out of order: (1,2), (0,1), (1,0), (0,2), (1,1), (0,0), (1,3)
      const schedule: Array<[number, number, Uint8Array]> = [
        [1, 2, f1.subarray(2 * chunkSize, 3 * chunkSize)],
        [0, 1, f0.subarray(1 * chunkSize, 2 * chunkSize)],
        [1, 0, f1.subarray(0, chunkSize)],
        [0, 2, f0.subarray(2 * chunkSize, 3 * chunkSize)],
        [1, 1, f1.subarray(chunkSize, 2 * chunkSize)],
        [0, 0, f0.subarray(0, chunkSize)],
        [1, 3, f1.subarray(3 * chunkSize)],
      ];

      await Promise.all(
        schedule.map(([fi, ci, slice]) =>
          desktopPeer.sendChunk(androidPeer.peerId, tid, fi, ci, slice),
        ),
      );

      const out0 = new Uint8Array(f0.byteLength);
      const out1 = new Uint8Array(f1.byteLength);
      await Promise.all([
        ...[0, 1, 2].map(async (c) => {
          const rx = await androidPeer.waitForChunk(
            (x) => x.frame.transferId === tid && x.frame.fileIndex === 0 && x.frame.chunkIndex === c,
          );
          out0.set(rx.plaintext, c * chunkSize);
        }),
        ...[0, 1, 2, 3].map(async (c) => {
          const rx = await androidPeer.waitForChunk(
            (x) => x.frame.transferId === tid && x.frame.fileIndex === 1 && x.frame.chunkIndex === c,
          );
          out1.set(rx.plaintext, c * chunkSize);
        }),
      ]);

      assertBuffersEqual(out0, f0);
      assertBuffersEqual(out1, f1);
    });
  });
});
