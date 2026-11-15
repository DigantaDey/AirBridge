import { describe, expect, it } from 'vitest';
import {
  isValidPairCode,
  OpaquePeer,
  readRepoFile,
  startTestServer,
} from '../harness/index.js';

describe('F05: Pairing Dock & Room Management', () => {
  it('assigns valid 6-character Crockford pair codes and moves peers when join-pair succeeds', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const p1 = await OpaquePeer.create({ name: 'P1', pairCode: 'AAA222', visibility: 'paired-only' });
    const p2 = await OpaquePeer.create({ name: 'P2', pairCode: 'BBB333', visibility: 'paired-only' });
    try {
      await Promise.all([p1.connect(server.wsUrl), p2.connect(server.wsUrl)]);
      expect(p1.discoveredPeers).toHaveLength(0);

      const updated = await p2.joinPair('AAA222');
      expect(isValidPairCode(updated.pairCode)).toBe(true);
      expect(updated.pairCode).toBe('AAA222');

      const seen = await p1.waitForPeer((p) => p.peerId === p2.peerId);
      expect(seen.device.name).toBe('P2');
    } finally {
      await p1.disconnect().catch(() => {});
      await p2.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rotates pair code on request and issues a fresh Crockford code', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const peer = await OpaquePeer.create({ name: 'Rotator', pairCode: 'K9M4P7' });
    try {
      await peer.connect(server.wsUrl);
      const res = await peer.rotatePairCode();
      expect(isValidPairCode(res.pairCode)).toBe(true);
      expect(res.pairCode).not.toBe('K9M4P7');
    } finally {
      await peer.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('isolates rooms when visibility is paired-only', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const roomA1 = await OpaquePeer.create({ name: 'RoomA1', pairCode: 'RMAA22', visibility: 'paired-only' });
    const roomA2 = await OpaquePeer.create({ name: 'RoomA2', pairCode: 'RMAA22', visibility: 'paired-only' });
    const roomB = await OpaquePeer.create({ name: 'RoomB', pairCode: 'RMBB33', visibility: 'paired-only' });
    try {
      await Promise.all([
        roomA1.connect(server.wsUrl),
        roomA2.connect(server.wsUrl),
        roomB.connect(server.wsUrl),
      ]);
      await roomA1.waitForPeer((p) => p.peerId === roomA2.peerId);
      expect(roomA1.discoveredPeers.some((p) => p.peerId === roomB.peerId)).toBe(false);
      expect(roomB.discoveredPeers).toHaveLength(0);
    } finally {
      await roomA1.disconnect().catch(() => {});
      await roomA2.disconnect().catch(() => {});
      await roomB.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('updates background daemon pair code via /api/daemon/background-pair-code from loopback when enabled', async () => {
    const server = await startTestServer({
      enableMdns: false,
      backgroundClipboard: true,
      hostClipboard: {
        isSupported: () => true,
        readText: async () => null,
        writeText: async () => true,
      },
      daemonConfig: {
        enabled: true,
        autoSaveToDownloads: true,
        downloadDir: serverTmpPath(),
        notifyOnReceive: false,
        revealInFinder: false,
      },
    });
    try {
      const res = await fetch(`${server.httpUrl}/api/daemon/background-pair-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairCode: 'XYZ-789', autoClipboard: true, receiveClipboard: true }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('provides Compose PairingSheet with QR display/scan, code entry, and rotation controls', async () => {
    const sheet = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/components/PairingSheet.kt');
    expect(sheet).toContain('fun PairingSheet(');
    expect(sheet).toContain('ModalBottomSheet(');
    expect(sheet).toContain('onJoinPairCode');
    expect(sheet).toContain('onRotatePairCode');
    expect(sheet).toContain('onOpenScanner');
  });
});

function serverTmpPath(): string {
  return process.env.TMPDIR || '/tmp';
}
