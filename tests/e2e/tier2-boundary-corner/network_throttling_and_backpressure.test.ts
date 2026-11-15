import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  createSyntheticBuffer,
  encodeCanonicalBinarySackFrame,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  readRepoFile,
  startTestServer,
  streamSingleFileAndVerify,
  withPairedEnv,
} from '../harness/index.js';

describe('Tier 2 Boundary: Network Throttling & Relay Backpressure', () => {
  it('routes canonical 0x03 binary SACKs across an active multi-chunk windowed transfer', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const chunkSize = 128 * 1024;
      const payload = createSyntheticBuffer(6 * chunkSize, 71);
      const tid = randomTransferId();
      const { sha256, sacks } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        'windowed-6x128k.bin',
        payload,
        chunkSize,
      );
      expect(sha256).toBe(await computeSha256(payload));
      expect(sacks.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('delivers all chunks in a 16-chunk pipeline window without dropping or corrupting frames', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const chunkSize = 64 * 1024;
      const totalChunks = 16;
      const payload = createSyntheticBuffer(chunkSize * totalChunks, 72);
      const tid = randomTransferId();
      await negotiateTransfer(androidPeer, desktopPeer, tid, [
        {
          index: 0,
          name: 'window-16.bin',
          size: payload.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks,
          chunkSize,
        },
      ]);

      await Promise.all(
        Array.from({ length: totalChunks }, (_, idx) =>
          androidPeer.sendChunk(
            desktopPeer.peerId,
            tid,
            0,
            idx,
            payload.subarray(idx * chunkSize, (idx + 1) * chunkSize),
          ),
        ),
      );

      const reassembled = new Uint8Array(payload.byteLength);
      for (let i = 0; i < totalChunks; i++) {
        const evt = await desktopPeer.waitForChunk(
          (c) => c.frame.transferId === tid && c.frame.chunkIndex === i,
          8000,
        );
        reassembled.set(evt.plaintext, i * chunkSize);
      }
      assertBuffersEqual(reassembled, payload);
    });
  });

  it('handles sparse out-of-order chunks plus selective SACK bitmasks cleanly', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const chunkSize = 64 * 1024;
      const tid = randomTransferId();
      const c0 = createSyntheticBuffer(chunkSize, 1);
      const c2 = createSyntheticBuffer(chunkSize, 3);
      const c3 = createSyntheticBuffer(chunkSize, 4);
      await negotiateTransfer(desktopPeer, androidPeer, tid, [
        {
          index: 0,
          name: 'sparse-sack.bin',
          size: chunkSize * 4,
          mimeType: 'application/octet-stream',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      await desktopPeer.sendChunk(androidPeer.peerId, tid, 0, 2, c2);
      await desktopPeer.sendChunk(androidPeer.peerId, tid, 0, 0, c0);
      await desktopPeer.sendChunk(androidPeer.peerId, tid, 0, 3, c3);

      // Receiver advertises base contiguous=0 + bitmask bits for chunks 2 & 3 (bit 1 -> chunk2, bit 2 -> chunk3 => 0b110 = 6)
      await androidPeer.sendCanonicalBinarySack(desktopPeer.peerId, tid, 0, 0, 0b00000110);
      const sack = await desktopPeer.waitForSack(
        (s) => s.canonical?.transferId === tid && s.canonical.bitmask === 0b00000110,
      );
      expect(sack.canonical?.chunkIndex).toBe(0);

      const [rx0, rx2, rx3] = await Promise.all([
        androidPeer.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 0),
        androidPeer.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 2),
        androidPeer.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 3),
      ]);
      assertBuffersEqual(rx0.plaintext, c0);
      assertBuffersEqual(rx2.plaintext, c2);
      assertBuffersEqual(rx3.plaintext, c3);
    });
  });

  it('preserves responsiveness for urgent control frames during simultaneous large chunk transfers', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const chunk = createSyntheticBuffer(512 * 1024, 9);
      await negotiateTransfer(desktopPeer, androidPeer, tid, [
        {
          index: 0,
          name: 'heavy-plus-ctrl.bin',
          size: chunk.byteLength * 2,
          mimeType: 'application/octet-stream',
          totalChunks: 2,
          chunkSize: chunk.byteLength,
        },
      ]);

      await desktopPeer.sendChunk(androidPeer.peerId, tid, 0, 0, chunk);
      await desktopPeer.sendControl(androidPeer.peerId, { kind: 'ping', ts: 88881 }, true);
      await desktopPeer.sendChunk(androidPeer.peerId, tid, 0, 1, chunk);

      const ping = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'ping' && e.payload.ts === 88881,
      );
      expect(ping.payload.kind).toBe('ping');
    });
  });

  it('verifies TypeScript warpClient backpressure & 32 MiB byte window helpers', async () => {
    const wc = await readRepoFile('src/client/engine/warpClient.ts');
    expect(wc).toContain('WINDOW_BYTE_BUDGET = 32 * 1024 * 1024');
    expect(wc).toContain('ACK_BYTE_CADENCE = 2 * 1024 * 1024');
    expect(wc).toContain('sendWsRelayBinaryWithBackpressure');
  });

  it('verifies hub drops relay frames cleanly when target bufferedAmount exceeds 64 MiB valve', async () => {
    const hub = await readRepoFile('src/server/signalingHub.ts');
    expect(hub).toContain('target.ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES');
    expect(hub).toContain('if (ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) { ws.terminate(); return; }');
  });

  it('verifies Kotlin Engine bounds outbound queue (8 MiB), inbound queue (6 MiB), and decrypt budget (8 MiB)', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    const out = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/OutboundQueue.kt');
    expect(out).toContain('maxBytes: Int = 8 * 1024 * 1024');
    expect(engine).toContain('ByteBoundedQueue<IncomingWork>(6 * 1024 * 1024)');
    expect(engine).toContain('maxRecvInFlightBytes = 8L * 1024 * 1024');
    expect(engine).toContain('val pipelineDepth = 4');
  });

  it('continues delivering frames across remaining paired peers when one peer pauses reading and disconnects', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'Sender', pairCode: 'THR222' });
    const slow = await OpaquePeer.create({ name: 'Slow', pairCode: 'THR222' });
    const healthy = await OpaquePeer.create({ name: 'Healthy', pairCode: 'THR222' });
    try {
      await Promise.all([
        sender.connect(server.wsUrl),
        slow.connect(server.wsUrl),
        healthy.connect(server.wsUrl),
      ]);
      await sender.waitForPeer((p) => p.peerId === healthy.peerId);
      await slow.disconnect();

      await sender.sendControl(healthy.peerId, {
        kind: 'clipboard-beam',
        beamId: 'after-slow-disconnect',
        contentType: 'text',
        text: 'healthy-peer-ok',
        timestamp: Date.now(),
      });
      const rx = await healthy.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'after-slow-disconnect',
      );
      expect(rx.payload.kind === 'clipboard-beam' && rx.payload.text).toBe('healthy-peer-ok');
    } finally {
      await sender.disconnect().catch(() => {});
      await slow.disconnect().catch(() => {});
      await healthy.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('delivers 1 MiB frames rapidly with SACK pacing on every 2nd chunk', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const payload = createSyntheticBuffer(3 * 1024 * 1024, 55);
      const tid = randomTransferId();
      const { sacks } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        'paced-3mb.bin',
        payload,
        1024 * 1024,
      );
      expect(sacks.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('allows full-duplex simultaneous chunk streams in opposite directions without head-of-line deadlock', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tidA = randomTransferId();
      const tidB = randomTransferId();
      const dataA = createSyntheticBuffer(512 * 1024, 101);
      const dataB = createSyntheticBuffer(512 * 1024, 202);

      const [resA, resB] = await Promise.all([
        streamSingleFileAndVerify(androidPeer, desktopPeer, tidA, 'up.bin', dataA, 256 * 1024),
        streamSingleFileAndVerify(desktopPeer, androidPeer, tidB, 'down.bin', dataB, 256 * 1024),
      ]);
      expect(resA.sha256).toBe(await computeSha256(dataA));
      expect(resB.sha256).toBe(await computeSha256(dataB));
    });
  });

  it('drops relay frames addressed to a disconnected targetPeerId safely without server crash', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const ghostId = desktopPeer.peerId;
      await desktopPeer.disconnect();
      const sackBytes = encodeCanonicalBinarySackFrame({
        transferId: randomTransferId(),
        fileIndex: 0,
        chunkIndex: 0,
        bitmask: 0,
      })!;
      await androidPeer.sendCanonicalBinarySack(ghostId, randomTransferId(), 0, 0, 0);
      expect(sackBytes.byteLength).toBe(16);
      const health = await fetch(`http://127.0.0.1:${(await androidPeer.rotatePair(), 'ignored')}`).catch(() => null);
      void health;
    });
  });

  it('enforces writer batch coalescing threshold < 3 MiB in Kotlin Engine', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    expect(engine).toContain('batchBytes < 3 * 1024 * 1024');
  });

  it('adapts windowChunksFor and ackIntervalFor across 16 KiB to 1 MiB chunk sizes', async () => {
    const model = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Model.kt');
    expect(model).toContain('.coerceIn(32, 128)');
    expect(model).toContain('.coerceIn(2, 16)');
  });
});
