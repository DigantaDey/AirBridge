import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  createSyntheticBuffer,
  createSyntheticFileManifest,
  negotiateTransfer,
  randomTransferId,
  withPairedEnv,
} from '../harness/index.js';

describe('Tier 4 Scenario 03: Bidirectional Clipboard Storm & Unicode Fidelity', () => {
  it('delivers 24 rapid alternating UTF-8 text and image clipboard beams without loss or corruption', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tinyPng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

      const sentDesktopTexts: string[] = [];
      const sentAndroidTexts: string[] = [];

      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 12; i++) {
        const macText = `Mac-Copy #${i} — café naïve 日本語 🚀\nline2=${i * 17}`;
        const phoneText = `Moto-Copy #${i} — ₹${i * 100} ✓ OTP-${1000 + i} 🔐`;
        sentDesktopTexts.push(macText);
        sentAndroidTexts.push(phoneText);

        promises.push(
          desktopPeer.sendControl(androidPeer.peerId, {
            kind: 'clipboard-beam',
            beamId: `storm-mac-${i}`,
            contentType: i === 11 ? 'image' : 'text',
            text: i === 11 ? undefined : macText,
            imageDataUrl: i === 11 ? tinyPng : undefined,
            timestamp: Date.now() + i,
          }),
          androidPeer.sendControl(desktopPeer.peerId, {
            kind: 'clipboard-beam',
            beamId: `storm-phone-${i}`,
            contentType: i === 10 ? 'image' : 'text',
            text: i === 10 ? undefined : phoneText,
            imageDataUrl: i === 10 ? tinyPng : undefined,
            timestamp: Date.now() + i,
          }),
        );
      }

      await Promise.all(promises);

      for (let i = 0; i < 12; i++) {
        const fromMac = await androidPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === `storm-mac-${i}`,
        );
        if (i === 11) {
          expect(fromMac.payload.kind === 'clipboard-beam' && fromMac.payload.imageDataUrl).toBe(tinyPng);
        } else {
          expect(fromMac.payload.kind === 'clipboard-beam' && fromMac.payload.text).toBe(
            sentDesktopTexts[i],
          );
        }

        const fromPhone = await desktopPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === `storm-phone-${i}`,
        );
        if (i === 10) {
          expect(fromPhone.payload.kind === 'clipboard-beam' && fromPhone.payload.imageDataUrl).toBe(
            tinyPng,
          );
        } else {
          expect(fromPhone.payload.kind === 'clipboard-beam' && fromPhone.payload.text).toBe(
            sentAndroidTexts[i],
          );
        }
      }
    });
  });

  it('maintains 100% clipboard storm fidelity concurrently during a multi-chunk file transfer and binary SACK flow', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const chunkSize = 128 * 1024;
      const totalChunks = 6;
      const fileData = createSyntheticBuffer(chunkSize * totalChunks, 55);
      await negotiateTransfer(desktopPeer, androidPeer, tid, [
        createSyntheticFileManifest('storm-overlap.bin', fileData.byteLength, chunkSize),
      ]);

      const received = new Uint8Array(fileData.byteLength);
      const beamPromises: Promise<unknown>[] = [];

      for (let idx = 0; idx < totalChunks; idx++) {
        await desktopPeer.sendChunk(
          androidPeer.peerId,
          tid,
          0,
          idx,
          fileData.subarray(idx * chunkSize, (idx + 1) * chunkSize),
        );
        beamPromises.push(
          androidPeer.sendControl(desktopPeer.peerId, {
            kind: 'clipboard-beam',
            beamId: `concurrent-beam-${idx}`,
            contentType: 'text',
            text: `Concurrent clip @ chunk ${idx}`,
            timestamp: Date.now(),
          }),
        );
        const rx = await androidPeer.waitForChunk(
          (c) => c.frame.transferId === tid && c.frame.chunkIndex === idx,
        );
        received.set(rx.plaintext, idx * chunkSize);
        if (idx % 2 === 1) {
          await androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, tid, 0, idx, 0x03);
        }
      }

      await Promise.all(beamPromises);

      for (let idx = 0; idx < totalChunks; idx++) {
        const clip = await desktopPeer.waitForControl(
          (e) =>
            e.payload.kind === 'clipboard-beam' && e.payload.beamId === `concurrent-beam-${idx}`,
        );
        expect(clip.payload.kind === 'clipboard-beam' && clip.payload.text).toBe(
          `Concurrent clip @ chunk ${idx}`,
        );
      }
      const finalSack = await desktopPeer.waitForSack(
        (s) => s.canonical?.transferId === tid && s.canonical.chunkIndex === 5,
      );
      expect(finalSack.canonical?.bitmask).toBe(0x03);
      assertBuffersEqual(received, fileData);
    });
  });
});
