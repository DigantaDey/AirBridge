import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  isValidPairCode,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
} from '../harness/index.js';

describe('Tier 3 Cross-Feature: Pair Rotation During Active Transfers', () => {
  it('completes an active nearby-visible transfer cleanly even after one peer rotates its pair code mid-stream', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({
      name: 'Mac',
      pairCode: 'ROT111',
      visibility: 'nearby',
    });
    const receiver = await OpaquePeer.create({
      name: 'Phone',
      pairCode: 'ROT111',
      visibility: 'nearby',
    });
    const chunkSize = 64 * 1024;
    const data = createSyntheticBuffer(4 * chunkSize, 7);
    const out = new Uint8Array(data.byteLength);
    const tid = randomTransferId();

    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      await negotiateTransfer(sender, receiver, tid, [
        {
          index: 0,
          name: 'rotate-mid.bin',
          size: data.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      await sender.sendChunk(receiver.peerId, tid, 0, 0, data.subarray(0, chunkSize));
      const c0 = await receiver.waitForChunk((c) => c.frame.transferId === tid && c.frame.chunkIndex === 0);
      out.set(c0.plaintext, 0);

      // Sender rotates room code mid-transfer while both remain visible on the same nearby LAN
      const nextCode = await sender.rotatePair();
      expect(isValidPairCode(nextCode)).toBe(true);
      expect(nextCode).not.toBe('ROT111');

      for (const i of [1, 2, 3]) {
        await sender.sendChunk(
          receiver.peerId,
          tid,
          0,
          i,
          data.subarray(i * chunkSize, (i + 1) * chunkSize),
        );
        const rx = await receiver.waitForChunk(
          (c) => c.frame.transferId === tid && c.frame.chunkIndex === i,
        );
        out.set(rx.plaintext, i * chunkSize);
      }
      expect(await computeSha256(out)).toBe(await computeSha256(data));
    } finally {
      await sender.disconnect().catch(() => {});
      await receiver.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('severs relay communication immediately when a paired-only peer rotates out of the shared room', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const alice = await OpaquePeer.create({
      name: 'Alice',
      pairCode: 'ISO777',
      visibility: 'paired-only',
    });
    const bob = await OpaquePeer.create({
      name: 'Bob',
      pairCode: 'ISO777',
      visibility: 'paired-only',
    });
    try {
      await Promise.all([alice.connect(server.wsUrl), bob.connect(server.wsUrl)]);
      await alice.waitForPeer((p) => p.peerId === bob.peerId);

      const rotated = await alice.rotatePair();
      expect(rotated).not.toBe('ISO777');

      await alice.sendControl(bob.peerId, { kind: 'ping', ts: 31415 }, true);
      await expect(
        bob.waitForControl((e) => e.payload.kind === 'ping' && e.payload.ts === 31415, 150),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await alice.disconnect().catch(() => {});
      await bob.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('restores peer communication when partner joins the newly rotated pair code', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const host = await OpaquePeer.create({
      name: 'Host',
      pairCode: 'OLD222',
      visibility: 'paired-only',
    });
    const phone = await OpaquePeer.create({
      name: 'Phone',
      pairCode: 'OLD222',
      visibility: 'paired-only',
    });
    try {
      await Promise.all([host.connect(server.wsUrl), phone.connect(server.wsUrl)]);
      await phone.waitForPeer((p) => p.peerId === host.peerId);

      const newCode = await host.rotatePair();
      const joined = await phone.joinPair(newCode);
      expect(joined.pairCode).toBe(newCode);

      await phone.sendControl(host.peerId, {
        kind: 'clipboard-beam',
        beamId: 'rejoined-new-room',
        contentType: 'text',
        text: 'relinked',
        timestamp: Date.now(),
      });
      const rx = await host.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'rejoined-new-room',
      );
      expect(rx.payload.kind).toBe('clipboard-beam');
    } finally {
      await host.disconnect().catch(() => {});
      await phone.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('updates discoveryScope from nearby to paired without interrupting queued transfers when joining pair', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'AAA222', visibility: 'nearby' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'BBB333', visibility: 'nearby' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      const nearbyView = await a.waitForPeer((p) => p.peerId === b.peerId);
      expect(nearbyView.discoveryScope).toBe('nearby');

      await b.joinPair('AAA222');
      const pairedMsg = await a.waitForMessage(
        (m) =>
          m.type === 'peers' &&
          m.peers.some((p) => p.peerId === b.peerId && p.discoveryScope === 'paired'),
      );
      expect(pairedMsg.type).toBe('peers');
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });
});
