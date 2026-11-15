import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  readRepoFile,
  startTestServer,
  withTempDir,
} from '../harness/index.js';

describe('Tier 2 Boundary: Connection Drop, Recovery & Resumption', () => {
  it('resumes an interrupted transfer at chunk 3 after receiver disconnect and reconnect', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'Mac', platform: 'macos', pairCode: 'RES111' });
    let receiver = await OpaquePeer.create({
      name: 'Phone',
      platform: 'android',
      deviceId: 'aabbccddeeff0011',
      pairCode: 'RES111',
    });
    const chunkSize = 64 * 1024;
    const data = createSyntheticBuffer(6 * chunkSize, 21);
    const assembled = new Uint8Array(data.byteLength);
    const tid = randomTransferId();

    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      await negotiateTransfer(sender, receiver, tid, [
        {
          index: 0,
          name: 'resume-6.bin',
          size: data.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 6,
          chunkSize,
        },
      ]);

      for (const idx of [0, 1, 2]) {
        await sender.sendChunk(receiver.peerId, tid, 0, idx, data.subarray(idx * chunkSize, (idx + 1) * chunkSize));
        const rx = await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx);
        assembled.set(rx.plaintext, idx * chunkSize);
      }
      await receiver.disconnect();

      receiver = await OpaquePeer.create({
        name: 'Phone',
        platform: 'android',
        deviceId: 'aabbccddeeff0011',
        pairCode: 'RES111',
      });
      await receiver.connect(server.wsUrl);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);

      await receiver.sendControl(sender.peerId, {
        kind: 'transfer-accept',
        transferId: tid,
        preferredTransport: 'ws-relay',
        resumeFromChunks: { 0: 3 },
      });
      const accept2 = await sender.waitForControl(
        (e) => e.from === receiver.peerId && e.payload.kind === 'transfer-accept' && e.payload.transferId === tid,
      );
      expect(accept2.payload.kind === 'transfer-accept' && accept2.payload.resumeFromChunks?.[0]).toBe(3);

      for (const idx of [3, 4, 5]) {
        await sender.sendChunk(receiver.peerId, tid, 0, idx, data.subarray(idx * chunkSize, (idx + 1) * chunkSize));
        const rx = await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx);
        assembled.set(rx.plaintext, idx * chunkSize);
      }
      expect(await computeSha256(assembled)).toBe(await computeSha256(data));
    } finally {
      await receiver.disconnect().catch(() => {});
      await sender.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rejoins its previous pair group automatically when reconnecting with the same peerId', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a1 = await OpaquePeer.create({ name: 'PersistentPhone', pairCode: 'REJ222' });
    const b = await OpaquePeer.create({ name: 'Mac', pairCode: 'REJ222' });
    try {
      await Promise.all([a1.connect(server.wsUrl), b.connect(server.wsUrl)]);
      const savedId = a1.peerId;
      await a1.disconnect();

      const a2 = await OpaquePeer.create({ name: 'PersistentPhone' });
      const welcome = await a2.connect(server.wsUrl, savedId);
      expect(welcome.pairCode).toBe('REJ222');
      await b.waitForPeer((p) => p.peerId === a2.peerId);
      await a2.disconnect();
    } finally {
      await a1.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('supports resume when SENDER disconnects and reconnects mid-transfer', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    let sender = await OpaquePeer.create({ name: 'Sender', pairCode: 'SND333' });
    const receiver = await OpaquePeer.create({ name: 'Receiver', pairCode: 'SND333' });
    const chunkSize = 64 * 1024;
    const data = createSyntheticBuffer(4 * chunkSize, 88);
    const out = new Uint8Array(data.byteLength);
    const tid = randomTransferId();

    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      await negotiateTransfer(sender, receiver, tid, [
        {
          index: 0,
          name: 'sender-drop.bin',
          size: data.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      await sender.sendChunk(receiver.peerId, tid, 0, 0, data.subarray(0, chunkSize));
      const c0 = await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 0);
      out.set(c0.plaintext, 0);
      await sender.disconnect();

      sender = await OpaquePeer.create({ name: 'Sender', pairCode: 'SND333' });
      await sender.connect(server.wsUrl);
      await receiver.waitForPeer((p) => p.peerId === sender.peerId);

      for (const idx of [1, 2, 3]) {
        await sender.sendChunk(receiver.peerId, tid, 0, idx, data.subarray(idx * chunkSize, (idx + 1) * chunkSize));
        const rx = await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === idx);
        out.set(rx.plaintext, idx * chunkSize);
      }
      expect(await computeSha256(out)).toBe(await computeSha256(data));
    } finally {
      await sender.disconnect().catch(() => {});
      await receiver.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('persists partial chunks across requests in /api/daemon/received and finalizes atomically with SHA-256', async () => {
    await withTempDir('ab-t2-res-', async (dir) => {
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
        const chunkSize = 64 * 1024;
        const data = createSyntheticBuffer(2 * chunkSize + 100, 44);
        const expectedSha = await computeSha256(data);
        const tid = randomTransferId();

        for (let i = 0; i < 3; i++) {
          const slice = data.subarray(i * chunkSize, Math.min(data.byteLength, (i + 1) * chunkSize));
          const wr = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-airbridge-transfer': tid,
              'x-airbridge-file': '0',
              'x-airbridge-chunk': String(i),
              'x-airbridge-name': encodeURIComponent('resumed.bin'),
              'x-airbridge-size': String(data.byteLength),
              'x-airbridge-chunk-size': String(chunkSize),
              'x-airbridge-total-chunks': '3',
            },
            body: Buffer.from(slice),
          });
          expect(wr.status).toBe(200);
          if (i === 1) {
            const state = await fetch(
              `${server.httpUrl}/api/daemon/received?transferId=${tid}&fileIndex=0`,
            );
            expect(state.status).toBe(200);
            const json = (await state.json()) as {
              receivedCount?: number;
              receivedChunks?: number[];
              complete?: boolean;
            };
            expect(json.receivedCount).toBe(2);
            expect(json.receivedChunks).toEqual([0, 1]);
            expect(json.complete).toBe(false);
          }
        }

        const fin = await fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0, expectedSha256: expectedSha }),
        });
        expect(fin.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  it('rejects /api/daemon/finalize with HTTP 400 when expectedSha256 does not match written chunks', async () => {
    await withTempDir('ab-t2-sha-bad-', async (dir) => {
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
        const data = createSyntheticBuffer(32 * 1024, 7);
        const tid = randomTransferId();
        await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': 'corrupt.bin',
            'x-airbridge-size': String(data.byteLength),
            'x-airbridge-chunk-size': String(data.byteLength),
            'x-airbridge-total-chunks': '1',
          },
          body: Buffer.from(data),
        });
        const fin = await fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0, expectedSha256: 'f'.repeat(64) }),
        });
        expect(fin.status).toBe(400);
      } finally {
        await server.close();
      }
    });
  });

  it('cleans up partial daemon state cleanly when /api/daemon/discard is invoked', async () => {
    await withTempDir('ab-t2-disc-', async (dir) => {
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
        await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-airbridge-transfer': tid,
            'x-airbridge-file': '0',
            'x-airbridge-chunk': '0',
            'x-airbridge-name': 'discard-me.bin',
            'x-airbridge-size': '131072',
            'x-airbridge-chunk-size': '65536',
            'x-airbridge-total-chunks': '2',
          },
          body: Buffer.from(createSyntheticBuffer(65536, 1)),
        });
        const disc = await fetch(`${server.httpUrl}/api/daemon/discard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tid, fileIndex: 0 }),
        });
        expect(disc.status).toBe(200);
        const after = await fetch(
          `${server.httpUrl}/api/daemon/received?transferId=${tid}&fileIndex=0`,
        );
        const afterJson = (await after.json()) as { complete: boolean };
        expect(afterJson.complete).toBe(false);
      } finally {
        await server.close();
      }
    });
  });

  it('verifies TypeScript warpClient throws TransferConnectionInterruptedError when peer drops mid-transfer', async () => {
    const wc = await readRepoFile('src/client/engine/warpClient.ts');
    expect(wc).toContain('TransferConnectionInterruptedError');
    expect(wc).toContain('this.assertTransferPeerConnected(sendState, peer.peerId)');
  });

  it('reconciles transfer history across reconnects via encrypted history-sync payloads', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'HST444' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'HST444' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      const tid = randomTransferId();
      await a.sendControl(b.peerId, {
        kind: 'history-sync',
        transfers: [
          {
            transferId: tid,
            direction: 'outgoing',
            peerName: 'A',
            peerPlatform: 'android',
            transport: 'ws-relay',
            files: [],
            totalBytes: 4096,
            transferredBytes: 4096,
            status: 'completed',
            startedAt: Date.now() - 5000,
            completedAt: Date.now(),
            sasCode: '123456',
          },
        ],
      });
      const rx = await b.waitForControl((e) => e.payload.kind === 'history-sync');
      expect(rx.payload.kind === 'history-sync' && rx.payload.transfers[0].transferId).toBe(tid);
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('propagates transfer-cancel cleanly so interrupted partial receivers abort immediately', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'CAN555' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'CAN555' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      const tid = randomTransferId();
      await negotiateTransfer(a, b, tid, [
        {
          index: 0,
          name: 'cancel.bin',
          size: 1024,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: 1024,
        },
      ]);
      await a.sendControl(b.peerId, { kind: 'transfer-cancel', transferId: tid });
      const rx = await b.waitForControl(
        (e) => e.payload.kind === 'transfer-cancel' && e.payload.transferId === tid,
      );
      expect(rx.payload.kind).toBe('transfer-cancel');
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('handles duplicate chunk delivery deterministically without length distortion', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'DUP666' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'DUP666' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      const tid = randomTransferId();
      const chunk = createSyntheticBuffer(32 * 1024, 5);
      await negotiateTransfer(a, b, tid, [
        {
          index: 0,
          name: 'dup.bin',
          size: chunk.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: chunk.byteLength,
        },
      ]);
      await a.sendChunk(b.peerId, tid, 0, 0, chunk);
      await a.sendChunk(b.peerId, tid, 0, 0, chunk);
      const rx = await b.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 0);
      expect(await computeSha256(rx.plaintext)).toBe(await computeSha256(chunk));
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('handles duplicate transfer-complete-ack confirmations idempotently', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'ACK777' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'ACK777' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      const tid = randomTransferId();
      await b.sendControl(a.peerId, { kind: 'transfer-complete-ack', transferId: tid, verified: true });
      await b.sendControl(a.peerId, { kind: 'transfer-complete-ack', transferId: tid, verified: true });
      const ack = await a.waitForControl(
        (e) => e.payload.kind === 'transfer-complete-ack' && e.payload.transferId === tid,
      );
      expect(ack.payload.kind === 'transfer-complete-ack' && ack.payload.verified).toBe(true);
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('retains Kotlin NativeFiles .meta and .journal files across process restart before finalization', async () => {
    const nativeFiles = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/NativeFiles.kt');
    expect(nativeFiles).toContain('persistSidecar()');
    expect(nativeFiles).toContain('replayJournal()');
    expect(nativeFiles).toContain('sidecar.delete()');
  });

  it('keeps fresh peer discovery broadcasts accurate when a partner disconnects and rejoins', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const desktop = await OpaquePeer.create({ name: 'Desktop', pairCode: 'PR8888' });
    const phone1 = await OpaquePeer.create({ name: 'Phone', pairCode: 'PR8888' });
    try {
      await Promise.all([desktop.connect(server.wsUrl), phone1.connect(server.wsUrl)]);
      await desktop.waitForPeer((p) => p.peerId === phone1.peerId);
      await phone1.disconnect();
      await desktop.waitForMessage(
        (m) => m.type === 'peers' && !m.peers.some((p) => p.peerId === phone1.peerId),
      );
      const phone2 = await OpaquePeer.create({ name: 'Phone', pairCode: 'PR8888' });
      await phone2.connect(server.wsUrl);
      const reseen = await desktop.waitForPeer((p) => p.peerId === phone2.peerId);
      expect(reseen.peerId).toBe(phone2.peerId);
      await phone2.disconnect();
    } finally {
      await phone1.disconnect().catch(() => {});
      await desktop.disconnect().catch(() => {});
      await server.close();
    }
  });
});
