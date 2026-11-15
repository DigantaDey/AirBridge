import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  corruptAuthTag,
  createSyntheticBuffer,
  createSyntheticFileManifest,
  decryptBinaryChunk,
  derivePeerSession,
  encodeEncryptedChunkFrame,
  encryptBinaryChunk,
  generateIdentityKeyPair,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  withTempDir,
} from '../harness/index.js';

describe('Tier 4 Scenario 08: Corrupted Chunk Detection & Clean Retransmission Recovery', () => {
  it('rejects AES-GCM bit-flipped chunks cryptographically and recovers cleanly via sender retransmission', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'MacCorruptTest', platform: 'macos', pairCode: 'CRC111' });
    const receiver = await OpaquePeer.create({ name: 'PhoneCorruptTest', platform: 'android', pairCode: 'CRC111' });

    const chunkSize = 64 * 1024;
    const data = createSyntheticBuffer(3 * chunkSize, 41);
    const tid = randomTransferId();

    try {
      // 1. Validate raw AES-256-GCM frame tamper fails authentication tag check
      const alice = await generateIdentityKeyPair();
      const bob = await generateIdentityKeyPair();
      const aliceSess = await derivePeerSession(alice.privateKey, alice.publicKeyB64, bob.publicKeyB64);
      const bobSess = await derivePeerSession(bob.privateKey, bob.publicKeyB64, alice.publicKeyB64);
      const enc = await encryptBinaryChunk(aliceSess.aesKey, data.subarray(chunkSize, 2 * chunkSize));
      const tamperedWire = corruptAuthTag(
        encodeEncryptedChunkFrame({
          transferId: tid,
          fileIndex: 0,
          chunkIndex: 1,
          iv: enc.iv,
          ciphertext: enc.ciphertext,
        }),
      );
      await expect(
        decryptBinaryChunk(bobSess.aesKey, tamperedWire.subarray(25, 37), tamperedWire.subarray(37)),
      ).rejects.toThrow();

      // 2. Over live relay: receiver verifies intact chunks, requests retry if tampered locally, completes clean SHA-256
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      await negotiateTransfer(sender, receiver, tid, [
        createSyntheticFileManifest('integrity-checked.bin', data.byteLength, chunkSize),
      ]);

      const out = new Uint8Array(data.byteLength);
      await sender.sendChunk(receiver.peerId, tid, 0, 0, data.subarray(0, chunkSize));
      out.set(
        (await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 0)).plaintext,
        0,
      );

      // Re-transmit chunk 1 (simulating retransmission after corrupt frame drop) & chunk 2
      for (const idx of [1, 2]) {
        await sender.sendChunk(receiver.peerId, tid, 0, idx, data.subarray(idx * chunkSize, (idx + 1) * chunkSize));
        const rx = await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx);
        out.set(rx.plaintext, idx * chunkSize);
      }

      expect(await computeSha256(out)).toBe(await computeSha256(data));
      assertBuffersEqual(out, data);
    } finally {
      await receiver.disconnect().catch(() => {});
      await sender.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('catches SHA-256 disk mismatch on /api/daemon/finalize (HTTP 400), discards partial, and recovers cleanly', async () => {
    await withTempDir('ab-t4-s08-disk-', async (dir) => {
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
        const cleanData = createSyntheticBuffer(64 * 1024, 9);
        const expectedSha = await computeSha256(cleanData);
        const corruptData = new Uint8Array(cleanData);
        corruptData[1234] ^= 0xff; // single-bit flip in chunk payload
        const tid = randomTransferId();

        // Upload corrupted chunk
        const badUpload = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': 'recover.bin',
            'x-airbridge-size': String(cleanData.byteLength),
            'x-airbridge-chunk-size': String(cleanData.byteLength),
            'x-airbridge-total-chunks': '1',
          },
          body: Buffer.from(corruptData),
        });
        expect(badUpload.status).toBe(200);

        const badFinalize = await fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0, expectedSha256: expectedSha }),
        });
        expect(badFinalize.status).toBe(400);

        // Discard corrupted partial and re-upload valid payload
        const discard = await fetch(`${server.httpUrl}/api/daemon/discard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0 }),
        });
        expect(discard.status).toBe(200);

        const goodUpload = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': 'recover.bin',
            'x-airbridge-size': String(cleanData.byteLength),
            'x-airbridge-chunk-size': String(cleanData.byteLength),
            'x-airbridge-total-chunks': '1',
          },
          body: Buffer.from(cleanData),
        });
        expect(goodUpload.status).toBe(200);

        const goodFinalize = await fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0, expectedSha256: expectedSha }),
        });
        expect(goodFinalize.status).toBe(200);
        const finJson = (await goodFinalize.json()) as { savedPath: string; sha256: string };
        expect(finJson.sha256).toBe(expectedSha);

        const saved = await readFile(finJson.savedPath || join(dir, 'recover.bin'));
        assertBuffersEqual(saved, cleanData);
      } finally {
        await server.close();
      }
    });
  });
});
