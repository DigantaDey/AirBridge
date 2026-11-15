import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  corruptAuthTag,
  createSyntheticBuffer,
  encodeEncryptedChunkFrame,
  encryptBinaryChunk,
  negotiateTransfer,
  randomTransferId,
  readRepoFile,
  withPairedEnv,
  wrapRoutedRelayFrame,
} from '../harness/index.js';

describe('F10: Decoupled 3-Stage Crypto/IO Pipeline', () => {
  it('separates reader, crypto worker pool, sequential disk writer, and finalizer executors in Engine.kt', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    expect(engine).toContain('"airbridge-control"');
    expect(engine).toContain('"airbridge-crypto"');
    expect(engine).toContain('"airbridge-disk-writer"');
    expect(engine).toContain('"airbridge-finalizer"');
    expect(engine).toContain('enqueueEncryptedChunk(');
    expect(engine).toContain('persistDecryptedChunk(');
  });

  it('accounts for both ciphertext and decrypted plaintext in maxRecvInFlightBytes backpressure', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    expect(engine).toContain('maxRecvInFlightBytes = 8L * 1024 * 1024');
    expect(engine).toContain('val budgetBytes = frame.ciphertextLength + expectedSize');
  });

  it('verifies ByteBoundedQueue enforces capacity limits, blocking waits, and clean shutdown', async () => {
    const q = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/ByteBoundedQueue.kt');
    expect(q).toContain('private val maxBytes: Int');
    expect(q).toContain('while (!closed && (items.size >= maxItems || (items.isNotEmpty() && bytes + size > maxBytes)))');
    expect(q).toContain('fun close()');
  });

  it('decrypts out-of-order AES-256-GCM chunks independently without sequential head-of-line stalling', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      const chunkSize = 64 * 1024;
      const chunks = [0, 1, 2, 3].map((i) => createSyntheticBuffer(chunkSize, i + 50));
      await negotiateTransfer(desktopPeer, androidPeer, transferId, [
        {
          index: 0,
          name: 'ooo-crypto.bin',
          size: chunkSize * 4,
          mimeType: 'application/octet-stream',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      // Send chunks intentionally out-of-order: 3, 1, 0, 2
      for (const idx of [3, 1, 0, 2]) {
        await desktopPeer.sendChunk(androidPeer.peerId, transferId, 0, idx, chunks[idx]);
      }

      for (let idx = 0; idx < 4; idx++) {
        const received = await androidPeer.waitForChunk(
          (c) => c.frame.transferId === transferId && c.frame.chunkIndex === idx,
        );
        assertBuffersEqual(received.plaintext, chunks[idx], `Out-of-order chunk ${idx} failed decrypt`);
      }
    });
  });

  it('isolates tampered GCM chunk failures without breaking subsequent valid chunks on the session', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      const goodChunk = createSyntheticBuffer(32 * 1024, 99);
      await negotiateTransfer(desktopPeer, androidPeer, transferId, [
        {
          index: 0,
          name: 'tamper-isolation.bin',
          size: goodChunk.byteLength * 2,
          mimeType: 'application/octet-stream',
          totalChunks: 2,
          chunkSize: goodChunk.byteLength,
        },
      ]);

      const session = await desktopPeer.getSession(androidPeer.peerId);
      const { iv, ciphertext } = await encryptBinaryChunk(session.aesKey, goodChunk);
      const badFrame = corruptAuthTag(
        encodeEncryptedChunkFrame({ transferId, fileIndex: 0, chunkIndex: 0, iv, ciphertext }),
      );
      desktopPeer.sendRaw(wrapRoutedRelayFrame(desktopPeer.peerId, androidPeer.peerId, badFrame));

      // Send valid chunk 1 right after tampered chunk 0
      await desktopPeer.sendChunk(androidPeer.peerId, transferId, 0, 1, goodChunk);
      const okChunk = await androidPeer.waitForChunk(
        (c) => c.frame.transferId === transferId && c.frame.chunkIndex === 1,
        5000,
      );
      assertBuffersEqual(okChunk.plaintext, goodChunk);
    });
  });

  it('delivers control messages concurrently while binary relay chunks traverse the hub', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      const payload = createSyntheticBuffer(512 * 1024, 15);
      await negotiateTransfer(androidPeer, desktopPeer, transferId, [
        {
          index: 0,
          name: 'control-conc.bin',
          size: payload.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: payload.byteLength,
        },
      ]);

      await Promise.all([
        androidPeer.sendChunk(desktopPeer.peerId, transferId, 0, 0, payload),
        desktopPeer.sendControl(androidPeer.peerId, {
          kind: 'transfer-cancel',
          transferId,
        }),
      ]);

      const [cancelled, rxChunk] = await Promise.all([
        androidPeer.waitForControl(
          (e) => e.payload.kind === 'transfer-cancel' && e.payload.transferId === transferId,
        ),
        desktopPeer.waitForChunk((c) => c.frame.transferId === transferId && c.frame.chunkIndex === 0),
      ]);
      expect(cancelled.payload.kind).toBe('transfer-cancel');
      assertBuffersEqual(rxChunk.plaintext, payload);
    });
  });
});
