import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  createSyntheticBuffer,
  decodeEncryptedChunkFrame,
  encodeEncryptedChunkFrame,
  encryptBinaryChunk,
  decryptBinaryChunk,
  negotiateTransfer,
  randomTransferId,
  startTestServer,
  streamSingleFileAndVerify,
  withPairedEnv,
  withTempDir,
} from '../harness/index.js';

describe('Tier 2 Boundary: File Size Extremes & Chunk Boundaries', () => {
  it('handles 0-byte empty files end-to-end with verified SHA-256', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const empty = new Uint8Array(0);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        'empty.txt',
        empty,
        1024 * 1024,
      );
      expect(sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  it('handles 1-byte minimum non-empty file transfers intact', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const oneByte = new Uint8Array([0x7f]);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        androidPeer,
        desktopPeer,
        tid,
        'one.bin',
        oneByte,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(oneByte));
    });
  });

  it('transfers exact 16 KiB minimum chunkSize boundary payload cleanly', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const data = createSyntheticBuffer(16 * 1024, 1);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        'min-chunk-16k.bin',
        data,
        16 * 1024,
      );
      expect(sha256).toBe(await computeSha256(data));
    });
  });

  it('transfers 1 MiB minus 1 byte single-chunk boundary without padding corruption', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const data = createSyntheticBuffer(1024 * 1024 - 1, 2);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        '1mb-minus-1.bin',
        data,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(data));
    });
  });

  it('transfers exact 1 MiB single-chunk boundary payload losslessly', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const data = createSyntheticBuffer(1024 * 1024, 3);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        androidPeer,
        desktopPeer,
        tid,
        'exact-1mb.bin',
        data,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(data));
    });
  });

  it('splits 1 MiB plus 1 byte into full chunk 0 and a 1-byte tail chunk 1', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const data = createSyntheticBuffer(1024 * 1024 + 1, 4);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        '1mb-plus-1.bin',
        data,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(data));
    });
  });

  it('transfers exact 2 MiB boundary across two full 1 MiB chunks', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const data = createSyntheticBuffer(2 * 1024 * 1024, 5);
      const tid = randomTransferId();
      const { sha256 } = await streamSingleFileAndVerify(
        desktopPeer,
        androidPeer,
        tid,
        'exact-2mb.bin',
        data,
        1024 * 1024,
      );
      expect(sha256).toBe(await computeSha256(data));
    });
  });

  it('encodes and decrypts high uint32 chunkIndex values representing > 4 GiB file offsets', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const session = await desktopPeer.getSession(androidPeer.peerId);
      const tailPayload = createSyntheticBuffer(4096, 6);
      const tid = randomTransferId();
      // Chunk 5000 at 1 MiB chunkSize corresponds to offset ~5.24 GB
      const { iv, ciphertext } = await encryptBinaryChunk(session.aesKey, tailPayload);
      const wire = encodeEncryptedChunkFrame({
        transferId: tid,
        fileIndex: 0,
        chunkIndex: 5000,
        iv,
        ciphertext,
      });
      const decoded = decodeEncryptedChunkFrame(wire);
      expect(decoded.chunkIndex).toBe(5000);
      const rxSession = await androidPeer.getSession(desktopPeer.peerId);
      const plain = await decryptBinaryChunk(rxSession.aesKey, decoded.iv, decoded.ciphertext);
      assertBuffersEqual(plain, tailPayload);
    });
  });

  it('transfers a mixed multi-file batch combining 0-byte, 1-byte, and multi-chunk files', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const f0 = new Uint8Array(0);
      const f1 = new Uint8Array([0x42]);
      const f2 = createSyntheticBuffer(160 * 1024, 9);
      const chunkSize = 64 * 1024;
      await negotiateTransfer(desktopPeer, androidPeer, tid, [
        { index: 0, name: 'zero.bin', size: 0, mimeType: 'application/octet-stream', totalChunks: 1, chunkSize },
        { index: 1, name: 'tiny.bin', size: 1, mimeType: 'application/octet-stream', totalChunks: 1, chunkSize },
        { index: 2, name: 'big.bin', size: f2.byteLength, mimeType: 'application/octet-stream', totalChunks: 3, chunkSize },
      ]);

      await desktopPeer.sendChunk(androidPeer.peerId, tid, 0, 0, f0);
      await desktopPeer.sendChunk(androidPeer.peerId, tid, 1, 0, f1);
      for (let i = 0; i < 3; i++) {
        await desktopPeer.sendChunk(
          androidPeer.peerId,
          tid,
          2,
          i,
          f2.subarray(i * chunkSize, Math.min(f2.byteLength, (i + 1) * chunkSize)),
        );
      }

      const rx0 = await androidPeer.waitForChunk((c) => c.frame.transferId === tid && c.frame.fileIndex === 0);
      const rx1 = await androidPeer.waitForChunk((c) => c.frame.transferId === tid && c.frame.fileIndex === 1);
      expect(rx0.plaintext.byteLength).toBe(0);
      assertBuffersEqual(rx1.plaintext, f1);

      const out2 = new Uint8Array(f2.byteLength);
      for (let i = 0; i < 3; i++) {
        const c = await androidPeer.waitForChunk(
          (e) => e.frame.transferId === tid && e.frame.fileIndex === 2 && e.frame.chunkIndex === i,
        );
        out2.set(c.plaintext, i * chunkSize);
      }
      assertBuffersEqual(out2, f2);
    });
  });

  it('rejects empty manifest offers cleanly without corrupting session state', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'transfer-offer',
        transferId: tid,
        files: [],
        totalBytes: 0,
        createdAt: Date.now(),
      });
      const offer = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-offer' && e.payload.transferId === tid,
      );
      expect(offer.payload.kind === 'transfer-offer' && offer.payload.files).toHaveLength(0);

      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'transfer-decline',
        transferId: tid,
        reason: 'Empty file list',
      });
      const dec = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-decline' && e.payload.transferId === tid,
      );
      expect(dec.payload.kind).toBe('transfer-decline');
    });
  });

  it('persists 0-byte and odd-length chunks safely on the daemon /api/daemon/receive-chunk endpoint', async () => {
    await withTempDir('ab-t2-daemon-size-', async (dir) => {
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
        const tid = randomTransferId();
        const emptyRes = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': encodeURIComponent('zero.txt'),
            'x-airbridge-size': '0',
            'x-airbridge-chunk-size': '65536',
            'x-airbridge-total-chunks': '1',
          },
          body: new Uint8Array(0),
        });
        expect(emptyRes.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  it('rejects negative sizes and zero totalChunks on /api/daemon/receive-chunk with HTTP 400', async () => {
    await withTempDir('ab-t2-daemon-bad-', async (dir) => {
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
        const res = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': randomTransferId(),
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': 'bad.bin',
            'x-airbridge-size': '-5',
            'x-airbridge-chunk-size': '65536',
            'x-airbridge-total-chunks': '0',
          },
          body: new Uint8Array(1),
        });
        expect(res.status).toBe(400);
      } finally {
        await server.close();
      }
    });
  });

  it('handles maximum 256,000-character UTF-8 clipboard beams intact', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const bigText = 'A'.repeat(256_000);
      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'max-clip-256k',
        contentType: 'text',
        text: bigText,
        timestamp: Date.now(),
      });
      const rx = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'max-clip-256k',
        8000,
      );
      expect(rx.payload.kind === 'clipboard-beam' && rx.payload.text?.length).toBe(256_000);
    });
  });

  it('handles Unicode multi-byte filenames across file offers without truncation', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const tid = randomTransferId();
      const unicodeName = '写真_テスト_résumé_🚀.bin';
      const data = createSyntheticBuffer(4096, 17);
      await negotiateTransfer(desktopPeer, androidPeer, tid, [
        {
          index: 0,
          name: unicodeName,
          size: data.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: data.byteLength,
        },
      ]);
      const offer = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'transfer-offer' && e.payload.transferId === tid,
      );
      expect(offer.payload.kind === 'transfer-offer' && offer.payload.files[0].name).toBe(
        unicodeName,
      );
    });
  });
});
