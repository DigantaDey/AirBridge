import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  createSyntheticFileManifest,
  negotiateTransfer,
  randomTransferId,
  readRepoFile,
  streamSingleFileAndVerify,
  withPairedEnv,
} from '../harness/index.js';

describe('F08: High-Throughput 1 MiB Chunk Pipeline', () => {
  it('aligns Kotlin Limits constants with 1 MiB chunks, 32 MiB byte window, and 2 MiB ACK cadence', async () => {
    const model = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Model.kt');
    expect(model).toContain('const val CHUNK_SIZE = 1024 * 1024');
    expect(model).toContain('const val MIN_CHUNK_SIZE = 16 * 1024');
    expect(model).toContain('const val MAX_CHUNK_SIZE = 1024 * 1024');
    expect(model).toContain('const val WINDOW_BYTE_BUDGET = 32 * 1024 * 1024');
    expect(model).toContain('const val ACK_BYTE_CADENCE = 2 * 1024 * 1024');
    expect(model).toContain('fun windowChunksFor(chunkSize: Int)');
    expect(model).toContain('fun ackIntervalFor(chunkSize: Int)');
  });

  it('bounds send/receive pipelines for heap safety under low-memory JVMs', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    const outboundQueue = await readRepoFile(
      'android/engine/src/main/kotlin/com/airbridge/engine/OutboundQueue.kt',
    );
    expect(outboundQueue).toContain('maxBytes: Int = 8 * 1024 * 1024');
    expect(engine).toContain('ByteBoundedQueue<IncomingWork>(6 * 1024 * 1024)');
    expect(engine).toContain('private val maxRecvInFlightBytes = 8L * 1024 * 1024');
    expect(engine).toContain('val pipelineDepth = 4');
  });

  it('emits throttled ACK progress updates and synchronized speed metrics in Engine.kt', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    expect(engine).toContain('var lastAckEmitMs = 0L');
    expect(engine).toContain('var lastAckEmitBytes = 0L');
    expect(engine).toContain('now - send.lastAckEmitMs >= 100');
    expect(engine).toContain('viewToEmit = send.session.toView()');
    expect(engine).toContain('session.speedBytesPerSec =');
  });

  it('streams a 4 MiB multi-chunk payload across 1 MiB chunks with bit-exact SHA-256 verification', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const payload = createSyntheticBuffer(4 * 1024 * 1024, 81);
      const transferId = randomTransferId();
      const { sha256, sacks } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        transferId,
        'bulk-4mb.bin',
        payload,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(payload));
      expect(sacks.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('preserves exact tail-chunk lengths for non-multiple 1 MiB file sizes (2.5 MiB + 17 B)', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const totalSize = 2 * 1024 * 1024 + 512 * 1024 + 17;
      const payload = createSyntheticBuffer(totalSize, 19);
      const transferId = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        androidPeer,
        desktopPeer,
        transferId,
        'unaligned-tail.bin',
        payload,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(payload));
    });
  });

  it('delivers pipelined bursts of 8 chunks cleanly over the relay without loss or reordering defects', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const chunkSize = 256 * 1024;
      const totalSize = 8 * chunkSize;
      const payload = createSyntheticBuffer(totalSize, 42);
      const transferId = randomTransferId();
      const manifest = [createSyntheticFileManifest('burst-8x256k.bin', totalSize, chunkSize)];
      await negotiateTransfer(desktopPeer, androidPeer, transferId, manifest);

      // Pipeline all 8 chunks without awaiting each individual chunk first
      await Promise.all(
        Array.from({ length: 8 }, (_, idx) =>
          desktopPeer.sendChunk(
            androidPeer.peerId,
            transferId,
            0,
            idx,
            payload.subarray(idx * chunkSize, (idx + 1) * chunkSize),
          ),
        ),
      );

      const reassembled = new Uint8Array(totalSize);
      for (let i = 0; i < 8; i++) {
        const evt = await androidPeer.waitForChunk(
          (c) => c.frame.transferId === transferId && c.frame.chunkIndex === i,
          8000,
        );
        reassembled.set(evt.plaintext, i * chunkSize);
      }

      expect(await computeSha256(reassembled)).toBe(await computeSha256(payload));
    });
  });
});
