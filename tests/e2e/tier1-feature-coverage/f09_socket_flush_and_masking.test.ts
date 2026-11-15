import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  createSyntheticBuffer,
  negotiateTransfer,
  randomTransferId,
  readRepoFile,
  withPairedEnv,
} from '../harness/index.js';

describe('F09: Socket Flush Coalescing & Unrolled XOR Masking', () => {
  it('uses unaligned 8-byte XOR masking and reusable maskBuffer in WebSocketClient.kt', async () => {
    const ws = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/WebSocketClient.kt');
    expect(ws).toContain('maskBuffer = ByteArray(1024 * 1024 + 128)');
    expect(ws).toContain('val limit8 = count and -8');
    expect(ws).toContain('val limit4 = count and -4');
  });

  it('configures 4 MiB RX / 2 MiB TX socket buffers, 512 KiB streams, and TCP_NODELAY', async () => {
    const ws = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/WebSocketClient.kt');
    expect(ws).toContain('receiveBufferSize = 4 * 1024 * 1024');
    expect(ws).toContain('sendBufferSize = 2 * 1024 * 1024');
    expect(ws).toContain('tcpNoDelay = true');
    expect(ws).toContain('BufferedOutputStream(raw.getOutputStream(), 512 * 1024)');
    expect(ws).toContain('BufferedInputStream(raw.getInputStream(), 512 * 1024)');
  });

  it('coalesces Engine writer loop frames up to 3 MiB before calling flush()', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    expect(engine).toContain('target.sendBinary(cur.payload, flush = false)');
    expect(engine).toContain('batchBytes < 3 * 1024 * 1024');
    expect(engine).toContain('if (dirty) activeTarget?.flush()');
  });

  it('disables Nagle algorithm on TypeScript server dispatcher sockets for low-latency relay', async () => {
    const server = await readRepoFile('src/server/index.ts');
    expect(server).toContain('socket.setNoDelay(true)');
  });

  it('delivers 16 back-to-back 128 KiB binary frames over a single socket without masking or frame corruption', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      const chunkSize = 128 * 1024;
      const payloads = Array.from({ length: 16 }, (_, i) => createSyntheticBuffer(chunkSize, i + 10));
      await negotiateTransfer(androidPeer, desktopPeer, transferId, [
        {
          index: 0,
          name: 'coalesced-burst.bin',
          size: chunkSize * 16,
          mimeType: 'application/octet-stream',
          totalChunks: 16,
          chunkSize,
        },
      ]);

      await Promise.all(
        payloads.map((chunk, i) =>
          androidPeer.sendChunk(desktopPeer.peerId, transferId, 0, i, chunk),
        ),
      );

      for (let i = 0; i < payloads.length; i++) {
        const evt = await desktopPeer.waitForChunk(
          (c) => c.frame.transferId === transferId && c.frame.chunkIndex === i,
          8000,
        );
        assertBuffersEqual(evt.plaintext, payloads[i], `Chunk ${i} mismatch after coalesced burst`);
      }
    });
  });

  it('interleaves encrypted JSON control frames cleanly during active binary frame bursts', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      const chunk = createSyntheticBuffer(256 * 1024, 77);
      await negotiateTransfer(desktopPeer, androidPeer, transferId, [
        {
          index: 0,
          name: 'mixed-stream.bin',
          size: chunk.byteLength * 2,
          mimeType: 'application/octet-stream',
          totalChunks: 2,
          chunkSize: chunk.byteLength,
        },
      ]);

      await desktopPeer.sendChunk(androidPeer.peerId, transferId, 0, 0, chunk);
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'clip-interleave-f09',
        contentType: 'text',
        text: 'clipboard-during-flush',
        timestamp: Date.now(),
      });
      await desktopPeer.sendChunk(androidPeer.peerId, transferId, 0, 1, chunk);

      const [c0, clip, c1] = await Promise.all([
        androidPeer.waitForChunk((c) => c.frame.transferId === transferId && c.frame.chunkIndex === 0),
        androidPeer.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'clip-interleave-f09',
        ),
        androidPeer.waitForChunk((c) => c.frame.transferId === transferId && c.frame.chunkIndex === 1),
      ]);
      assertBuffersEqual(c0.plaintext, chunk);
      assertBuffersEqual(c1.plaintext, chunk);
      expect(clip.payload.kind).toBe('clipboard-beam');
    });
  });
});
