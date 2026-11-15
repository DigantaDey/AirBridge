import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  streamSingleFileAndVerify,
} from '../harness/index.js';

describe('Tier 4 Scenario 05: Multi-Device Room Sharing & E2EE Session Isolation', () => {
  it('supports simultaneous encrypted transfers and targeted clipboard beams across Desktop, Phone, and Tablet in one room', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const desktop = await OpaquePeer.create({
      name: 'StudioMac',
      platform: 'macos',
      pairCode: 'FAM999',
      visibility: 'paired-only',
    });
    const phone = await OpaquePeer.create({
      name: 'MotoG57',
      platform: 'android',
      pairCode: 'FAM999',
      visibility: 'paired-only',
    });
    const tablet = await OpaquePeer.create({
      name: 'TabS9',
      platform: 'android',
      pairCode: 'FAM999',
      visibility: 'paired-only',
    });

    try {
      await Promise.all([
        desktop.connect(server.wsUrl),
        phone.connect(server.wsUrl),
        tablet.connect(server.wsUrl),
      ]);

      await Promise.all([
        desktop.waitForPeer((p) => p.peerId === phone.peerId),
        desktop.waitForPeer((p) => p.peerId === tablet.peerId),
        phone.waitForPeer((p) => p.peerId === tablet.peerId),
      ]);

      const phonePayload = createSyntheticBuffer(256 * 1024, 31);
      const tabletPayload = createSyntheticBuffer(320 * 1024, 62);
      const tidPhone = randomTransferId();
      const tidTablet = randomTransferId();

      const [resPhone, resTablet] = await Promise.all([
        streamSingleFileAndVerify(desktop, phone, tidPhone, 'phone-notes.pdf', phonePayload, 128 * 1024),
        streamSingleFileAndVerify(desktop, tablet, tidTablet, 'tablet-deck.key', tabletPayload, 128 * 1024),
      ]);

      expect(resPhone.sha256).toBe(await computeSha256(phonePayload));
      expect(resTablet.sha256).toBe(await computeSha256(tabletPayload));

      // Verify strict targeted relay isolation: Tablet received zero chunks for tidPhone and vice versa
      await expect(
        tablet.waitForChunk((c) => c.frame.transferId === tidPhone, 80),
      ).rejects.toThrow(/Timed out/);
      await expect(
        phone.waitForChunk((c) => c.frame.transferId === tidTablet, 80),
      ).rejects.toThrow(/Timed out/);

      // Direct Phone -> Tablet clipboard beam inside shared room bypasses Desktop
      await phone.sendControl(tablet.peerId, {
        kind: 'clipboard-beam',
        beamId: 'phone-to-tab-only',
        contentType: 'text',
        text: 'Room-private snippet for Tablet',
        timestamp: Date.now(),
      });
      const tabBeam = await tablet.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'phone-to-tab-only',
      );
      expect(tabBeam.payload.kind === 'clipboard-beam' && tabBeam.payload.text).toBe(
        'Room-private snippet for Tablet',
      );
      await expect(
        desktop.waitForControl(
          (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'phone-to-tab-only',
          80,
        ),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await desktop.disconnect().catch(() => {});
      await phone.disconnect().catch(() => {});
      await tablet.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('prevents discovery across separate pair-only rooms until a device explicitly joins the target room', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const hostA = await OpaquePeer.create({ name: 'HostA', pairCode: 'AAA222', visibility: 'paired-only' });
    const guestB = await OpaquePeer.create({ name: 'GuestB', pairCode: 'BBB333', visibility: 'paired-only' });

    try {
      await Promise.all([hostA.connect(server.wsUrl), guestB.connect(server.wsUrl)]);
      expect(hostA.discoveredPeers.some((p) => p.peerId === guestB.peerId)).toBe(false);

      // Explicit join-pair bridges guestB into AAA222
      const joined = await guestB.joinPair('AAA222');
      expect(joined.pairCode).toBe('AAA222');

      await Promise.all([
        hostA.waitForPeer((p) => p.peerId === guestB.peerId),
        guestB.waitForPeer((p) => p.peerId === hostA.peerId),
      ]);

      const payload = createSyntheticBuffer(96 * 1024, 99);
      const { sha256 } = await streamSingleFileAndVerify(
        hostA,
        guestB,
        randomTransferId(),
        'bridged.bin',
        payload,
        48 * 1024,
      );
      expect(sha256).toBe(await computeSha256(payload));
    } finally {
      await hostA.disconnect().catch(() => {});
      await guestB.disconnect().catch(() => {});
      await server.close();
    }
  });
});
