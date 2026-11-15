import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  createSyntheticBuffer,
  negotiateTransfer,
  randomTransferId,
  withPairedEnv,
} from '../harness/index.js';

describe('Tier 3 Cross-Feature: Transfer + Concurrent Bidirectional Clipboard Sync', () => {
  it('delivers alternating UTF-8 clipboard beams both ways during an active multi-chunk file transfer', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const chunkSize = 256 * 1024;
      const fileData = createSyntheticBuffer(chunkSize * 4, 10);
      const tid = randomTransferId();
      await negotiateTransfer(desktopPeer, androidPeer, tid, [
        {
          index: 0,
          name: 'concurrent-clip.bin',
          size: fileData.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      const received = new Uint8Array(fileData.byteLength);
      for (let i = 0; i < 4; i++) {
        await desktopPeer.sendChunk(
          androidPeer.peerId,
          tid,
          0,
          i,
          fileData.subarray(i * chunkSize, (i + 1) * chunkSize),
        );
        const beamId = `conc-beam-${i}`;
        const sender = i % 2 === 0 ? androidPeer : desktopPeer;
        const target = i % 2 === 0 ? desktopPeer : androidPeer;
        await sender.sendControl(target.peerId, {
          kind: 'clipboard-beam',
          beamId,
          contentType: 'text',
          text: `Live copy #${i}`,
          timestamp: Date.now(),
        });

        const [chunkEvt, clipEvt] = await Promise.all([
          androidPeer.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === i),
          target.waitForControl(
            (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === beamId,
          ),
        ]);
        received.set(chunkEvt.plaintext, i * chunkSize);
        expect(clipEvt.payload.kind === 'clipboard-beam' && clipEvt.payload.text).toBe(
          `Live copy #${i}`,
        );
      }

      assertBuffersEqual(received, fileData);
    });
  });

  it('delivers image clipboard beams interleaved between binary 0x03 SACK acknowledgments', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const imgUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await Promise.all([
        androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, tid, 0, 12, 0x03),
        androidPeer.sendControl(desktopPeer.peerId, {
          kind: 'clipboard-beam',
          beamId: 'img-between-sacks',
          contentType: 'image',
          imageDataUrl: imgUrl,
          timestamp: Date.now(),
        }),
        androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, tid, 0, 14, 0x01),
      ]);

      const [sack12, imgClip, sack14] = await Promise.all([
        desktopPeer.waitForSack((s) => s.canonical?.transferId === tid && s.canonical.chunkIndex === 12),
        desktopPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'img-between-sacks',
        ),
        desktopPeer.waitForSack((s) => s.canonical?.transferId === tid && s.canonical.chunkIndex === 14),
      ]);
      expect(sack12.canonical?.bitmask).toBe(0x03);
      expect(sack14.canonical?.chunkIndex).toBe(14);
      expect(imgClip.payload.kind === 'clipboard-beam' && imgClip.payload.imageDataUrl).toBe(imgUrl);
    });
  });

  it('handles OTP/URL auto-classifications alongside reverse-direction uploads', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const payload = createSyntheticBuffer(128 * 1024, 30);
      await negotiateTransfer(androidPeer, desktopPeer, tid, [
        {
          index: 0,
          name: 'reverse-upload.bin',
          size: payload.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: payload.byteLength,
        },
      ]);

      await Promise.all([
        androidPeer.sendChunk(desktopPeer.peerId, tid, 0, 0, payload),
        desktopPeer.sendControl(androidPeer.peerId, {
          kind: 'clipboard-beam',
          beamId: 'otp-concurrent',
          contentType: 'otp',
          text: '492817',
          timestamp: Date.now(),
        }),
      ]);

      const [rxChunk, rxOtp] = await Promise.all([
        desktopPeer.waitForChunk((c) => c.frame.transferId === tid),
        androidPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'otp-concurrent',
        ),
      ]);
      expect(await computeSha256(rxChunk.plaintext)).toBe(await computeSha256(payload));
      expect(rxOtp.payload.kind === 'clipboard-beam' && rxOtp.payload.contentType).toBe('otp');
    });
  });

  it('prevents large 200 KB clipboard beams from starving subsequent transfer-complete-ack signals', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const largeText = 'Z'.repeat(200_000);
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'large-clip-starvation-test',
        contentType: 'text',
        text: largeText,
        timestamp: Date.now(),
      });
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'transfer-complete-ack',
        transferId: tid,
        verified: true,
      });

      const [rxClip, rxAck] = await Promise.all([
        androidPeer.waitForControl(
          (e) =>
            e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'large-clip-starvation-test',
        ),
        androidPeer.waitForControl(
          (e) => e.payload.kind === 'transfer-complete-ack' && e.payload.transferId === tid,
        ),
      ]);
      expect(rxClip.payload.kind === 'clipboard-beam' && rxClip.payload.text?.length).toBe(200_000);
      expect(rxAck.payload.kind === 'transfer-complete-ack' && rxAck.payload.verified).toBe(true);
    });
  });
});
