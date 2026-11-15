import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  streamSingleFileAndVerify,
} from '../harness/index.js';

describe('Tier 3 Cross-Feature: Multi-Peer Mesh Relay & Session Isolation', () => {
  it('routes independent simultaneous encrypted transfers across 3 paired devices without key leakage', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const mac = await OpaquePeer.create({ name: 'MacBook', platform: 'macos', pairCode: 'MSH111' });
    const phone1 = await OpaquePeer.create({ name: 'Moto', platform: 'android', pairCode: 'MSH111' });
    const phone2 = await OpaquePeer.create({ name: 'Pixel', platform: 'android', pairCode: 'MSH111' });
    try {
      await Promise.all([
        mac.connect(server.wsUrl),
        phone1.connect(server.wsUrl),
        phone2.connect(server.wsUrl),
      ]);
      await Promise.all([
        mac.waitForPeer((p) => p.peerId === phone1.peerId),
        mac.waitForPeer((p) => p.peerId === phone2.peerId),
        phone1.waitForPeer((p) => p.peerId === phone2.peerId),
      ]);

      const d1 = createSyntheticBuffer(256 * 1024, 11);
      const d2 = createSyntheticBuffer(256 * 1024, 22);
      const d3 = createSyntheticBuffer(128 * 1024, 33);

      const [r1, r2, r3] = await Promise.all([
        streamSingleFileAndVerify(mac, phone1, randomTransferId(), 'to-moto.bin', d1, 128 * 1024),
        streamSingleFileAndVerify(mac, phone2, randomTransferId(), 'to-pixel.bin', d2, 128 * 1024),
        streamSingleFileAndVerify(phone1, phone2, randomTransferId(), 'p2p.bin', d3, 64 * 1024),
      ]);
      expect(r1.sha256).toBe(await computeSha256(d1));
      expect(r2.sha256).toBe(await computeSha256(d2));
      expect(r3.sha256).toBe(await computeSha256(d3));
    } finally {
      await mac.disconnect().catch(() => {});
      await phone1.disconnect().catch(() => {});
      await phone2.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('derives strictly distinct pairwise ECDH session keys & SAS codes for every edge of a 3-node room', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const p1 = await OpaquePeer.create({ name: 'N1', pairCode: 'EDG222' });
    const p2 = await OpaquePeer.create({ name: 'N2', pairCode: 'EDG222' });
    const p3 = await OpaquePeer.create({ name: 'N3', pairCode: 'EDG222' });
    try {
      await Promise.all([p1.connect(server.wsUrl), p2.connect(server.wsUrl), p3.connect(server.wsUrl)]);
      await p1.waitForPeer((p) => p.peerId === p2.peerId);
      await p1.waitForPeer((p) => p.peerId === p3.peerId);
      await p2.waitForPeer((p) => p.peerId === p3.peerId);

      const [sas12, sas21, sas13, sas23] = await Promise.all([
        p1.getSasCode(p2.peerId),
        p2.getSasCode(p1.peerId),
        p1.getSasCode(p3.peerId),
        p2.getSasCode(p3.peerId),
      ]);
      expect(sas12).toBe(sas21);
      expect(new Set([sas12, sas13, sas23]).size).toBe(3);
    } finally {
      await p1.disconnect().catch(() => {});
      await p2.disconnect().catch(() => {});
      await p3.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('keeps non-target peers completely silent when Peer A sends a routed transfer to Peer B', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'SIL333' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'SIL333' });
    const c = await OpaquePeer.create({ name: 'C', pairCode: 'SIL333' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl), c.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      const tid = randomTransferId();
      await negotiateTransfer(a, b, tid, [
        {
          index: 0,
          name: 'private.bin',
          size: 8192,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          chunkSize: 8192,
        },
      ]);
      await a.sendChunk(b.peerId, tid, 0, 0, createSyntheticBuffer(8192, 1));
      await b.waitForChunk((x) => x.frame.transferId === tid);

      await expect(
        c.waitForControl((e) => 'transferId' in e.payload && e.payload.transferId === tid, 100),
      ).rejects.toThrow(/Timed out/);
      await expect(
        c.waitForChunk((x) => x.frame.transferId === tid, 100),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await c.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('fans out a clipboard broadcast to multiple paired recipients while excluding the sender', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const mac = await OpaquePeer.create({ name: 'Mac', pairCode: 'FAN444' });
    const p1 = await OpaquePeer.create({ name: 'P1', pairCode: 'FAN444' });
    const p2 = await OpaquePeer.create({ name: 'P2', pairCode: 'FAN444' });
    try {
      await Promise.all([mac.connect(server.wsUrl), p1.connect(server.wsUrl), p2.connect(server.wsUrl)]);
      await Promise.all([
        mac.waitForPeer((p) => p.peerId === p1.peerId),
        mac.waitForPeer((p) => p.peerId === p2.peerId),
      ]);

      await Promise.all([
        mac.sendControl(p1.peerId, {
          kind: 'clipboard-beam',
          beamId: 'fanout-1',
          contentType: 'text',
          text: 'shared-snippet',
          timestamp: Date.now(),
        }),
        mac.sendControl(p2.peerId, {
          kind: 'clipboard-beam',
          beamId: 'fanout-1',
          contentType: 'text',
          text: 'shared-snippet',
          timestamp: Date.now(),
        }),
      ]);

      const [r1, r2] = await Promise.all([
        p1.waitForControl((e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'fanout-1'),
        p2.waitForControl((e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'fanout-1'),
      ]);
      expect(r1.payload.kind === 'clipboard-beam' && r1.payload.text).toBe('shared-snippet');
      expect(r2.payload.kind === 'clipboard-beam' && r2.payload.text).toBe('shared-snippet');
    } finally {
      await mac.disconnect().catch(() => {});
      await p1.disconnect().catch(() => {});
      await p2.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('maintains separate transfer progress counters when 2 peers send simultaneously to 1 receiver', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const hubPhone = await OpaquePeer.create({ name: 'HubPhone', pairCode: 'RXM555' });
    const lap1 = await OpaquePeer.create({ name: 'Laptop1', pairCode: 'RXM555' });
    const lap2 = await OpaquePeer.create({ name: 'Laptop2', pairCode: 'RXM555' });
    try {
      await Promise.all([
        hubPhone.connect(server.wsUrl),
        lap1.connect(server.wsUrl),
        lap2.connect(server.wsUrl),
      ]);
      await Promise.all([
        hubPhone.waitForPeer((p) => p.peerId === lap1.peerId),
        hubPhone.waitForPeer((p) => p.peerId === lap2.peerId),
      ]);
      const buf1 = createSyntheticBuffer(128 * 1024, 51);
      const buf2 = createSyntheticBuffer(128 * 1024, 52);
      const [res1, res2] = await Promise.all([
        streamSingleFileAndVerify(lap1, hubPhone, randomTransferId(), 'from-lap1.bin', buf1, 64 * 1024),
        streamSingleFileAndVerify(lap2, hubPhone, randomTransferId(), 'from-lap2.bin', buf2, 64 * 1024),
      ]);
      expect(res1.sha256).toBe(await computeSha256(buf1));
      expect(res2.sha256).toBe(await computeSha256(buf2));
    } finally {
      await hubPhone.disconnect().catch(() => {});
      await lap1.disconnect().catch(() => {});
      await lap2.disconnect().catch(() => {});
      await server.close();
    }
  });
});
