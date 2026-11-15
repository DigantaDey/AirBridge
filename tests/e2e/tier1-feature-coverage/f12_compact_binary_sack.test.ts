import { describe, expect, it } from 'vitest';
import {
  BINARY_SACK_LENGTH,
  decodeCanonicalBinarySackFrame,
  encodeCanonicalBinarySackFrame,
  FRAME_BINARY_SACK,
  randomTransferId,
  readRepoFile,
  withPairedEnv,
} from '../harness/index.js';
import { decodeBinarySackFrame, encodeBinarySackFrame } from '../../../src/shared/protocol.js';

describe('F12: Compact 16-Byte Binary SACK Protocol (0x03)', () => {
  it('matches canonical 16-byte Binary SACK layout between Kotlin Frames.kt and TypeScript protocol.ts', async () => {
    const frames = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Frames.kt');
    expect(frames).toContain('const val FRAME_BINARY_SACK = 0x03');
    expect(frames).toContain('const val BINARY_SACK_LENGTH = 16');
    expect(BINARY_SACK_LENGTH).toBe(16);
    expect(FRAME_BINARY_SACK).toBe(0x03);
  });

  it('round-trips edge uint16 fileIndex, uint32 chunkIndex, and bitmask values losslessly', () => {
    const tid = '0123456789abcdef';
    const cases = [
      { transferId: tid, fileIndex: 0, chunkIndex: 0, bitmask: 0x00 },
      { transferId: tid, fileIndex: 65535, chunkIndex: 0xffffffff, bitmask: 0xff },
      { transferId: 'fedcba9876543210', fileIndex: 42, chunkIndex: 131072, bitmask: 0xa5 },
    ];
    for (const sample of cases) {
      const encoded = encodeCanonicalBinarySackFrame(sample);
      expect(encoded).not.toBeNull();
      expect(encoded!.byteLength).toBe(16);
      expect(encoded![0]).toBe(0x03);
      const decoded = decodeCanonicalBinarySackFrame(encoded!);
      expect(decoded).toEqual(sample);
    }
  });

  it('rejects malformed, wrong-opcode, truncated, oversized, and non-hex transferId SACK frames', () => {
    const valid = encodeBinarySackFrame({
      transferId: 'aabbccddeeff0011',
      fileIndex: 1,
      chunkIndex: 10,
      bitmask: 0x0f,
    })!;
    expect(() => decodeBinarySackFrame(valid.subarray(0, 15))).toThrow();
    expect(() => decodeBinarySackFrame(new Uint8Array([...valid, 0x00]))).toThrow();
    const wrongOp = new Uint8Array(valid);
    wrongOp[0] = 0x04;
    expect(() => decodeBinarySackFrame(wrongOp)).toThrow();

    // Non-16-hex transferId fails canonical encoding
    expect(
      encodeBinarySackFrame({
        transferId: 'not-a-hex-id-1234',
        fileIndex: 0,
        chunkIndex: 0,
        bitmask: 0,
      }),
    ).toBeNull();
  });

  it('routes 16-byte canonical Binary SACK frames inside 0x02 relay envelopes with server-verified sender ID', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      await androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, transferId, 3, 1024, 0b10101100);
      const evt = await desktopPeer.waitForSack(
        (s) => s.canonical?.transferId === transferId && s.canonical.chunkIndex === 1024,
      );
      expect(evt.sourcePeerId).toBe(androidPeer.peerId);
      expect(evt.rawBytes?.byteLength).toBe(16);
      expect(evt.canonical).toEqual({
        transferId,
        fileIndex: 3,
        chunkIndex: 1024,
        bitmask: 0b10101100,
      });
    });
  });

  it('sustains rapid sequences of canonical SACK updates in ascending chunk order', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      for (const chunkIdx of [2, 4, 6, 8, 10]) {
        await androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, transferId, 0, chunkIdx, 0x07);
      }
      const ack8 = await desktopPeer.waitForSack(
        (s) => s.canonical?.transferId === transferId && s.canonical.chunkIndex === 8,
      );
      const ack10 = await desktopPeer.waitForSack(
        (s) => s.canonical?.transferId === transferId && s.canonical.chunkIndex === 10,
      );
      expect(ack8.canonical?.bitmask).toBe(0x07);
      expect(ack10.canonical?.fileIndex).toBe(0);
    });
  });

  it('keeps SACK 0x03 unambiguously separated from encrypted chunk 0x01 and control JSON relay frames', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      await Promise.all([
        androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, transferId, 0, 55, 0x11),
        androidPeer.sendControl(desktopPeer.peerId, {
          kind: 'clipboard-beam',
          beamId: 'clip-alongside-sack',
          contentType: 'text',
          text: 'sack-coexistence',
          timestamp: Date.now(),
        }),
      ]);
      const [sack, clip] = await Promise.all([
        desktopPeer.waitForSack((s) => s.canonical?.transferId === transferId),
        desktopPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'clip-alongside-sack',
        ),
      ]);
      expect(sack.canonical?.chunkIndex).toBe(55);
      expect(clip.payload.kind).toBe('clipboard-beam');
    });
  });
});
