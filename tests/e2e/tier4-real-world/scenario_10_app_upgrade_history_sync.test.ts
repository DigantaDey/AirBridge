import { describe, expect, it } from 'vitest';
import {
  derivePeerSession,
  encryptControlPayload,
  generateIdentityKeyPair,
  isV1SigningEnabled,
  isV2SigningEnabled,
  OpaquePeer,
  randomTransferId,
  readAppBuildGradle,
  startTestServer,
} from '../harness/index.js';
import type { HistoricalTransferSummary } from '../../../src/shared/protocol.js';

describe('Tier 4 Scenario 10: Seamless APK Upgrade Continuity & Encrypted History Sync', () => {
  it('enforces upgradeable applicationId, monotonic versionCode, and v1/v2/v3 signing lineage in Gradle config', async () => {
    const gradle = await readAppBuildGradle();
    expect(gradle.rawText).toContain('applicationId = "com.airbridge.app"');
    expect(gradle.rawText).toContain('100000 + gitCommitCount');
    expect(gradle.rawText).toContain('enableV3Signing = true');
    expect(isV1SigningEnabled(gradle, 'ciSideload')).toBe(true);
    expect(isV2SigningEnabled(gradle, 'ciSideload')).toBe(true);
    expect(gradle.compileSdk).toBe(36);
    expect(gradle.targetSdk).toBe(36);
  });

  it('rejoins same room across app restart/upgrade and synchronizes encrypted transfer history cleanly', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    let mac = await OpaquePeer.create({
      name: 'MacStudio',
      platform: 'macos',
      deviceId: 'a1b2c3d4e5f60718',
      pairCode: 'VPG777',
    });
    const android = await OpaquePeer.create({
      name: 'MotoG57-v2',
      platform: 'android',
      deviceId: '9988776655443322',
      pairCode: 'VPG777',
    });

    try {
      await Promise.all([mac.connect(server.wsUrl), android.connect(server.wsUrl)]);
      await android.waitForPeer((p) => p.peerId === mac.peerId);
      const previousPeerId = mac.peerId;
      await mac.disconnect();

      // Upgraded desktop/app process restarts with preserved deviceId + pairCode and fresh ECDH session keypair
      mac = await OpaquePeer.create({
        name: 'MacStudio-v2.2.1',
        platform: 'macos',
        deviceId: 'a1b2c3d4e5f60718',
        pairCode: 'VPG777',
      });
      const welcome = await mac.connect(server.wsUrl);
      expect(welcome.pairCode).toBe('VPG777');
      expect(mac.peerId).not.toBe(previousPeerId);
      await android.waitForPeer(
        (p) => p.peerId === mac.peerId && p.device.deviceId === 'a1b2c3d4e5f60718',
      );

      const historyEntries: HistoricalTransferSummary[] = [
        {
          transferId: randomTransferId(),
          peerDeviceId: '9988776655443322',
          peerName: 'MotoG57',
          peerPlatform: 'android',
          direction: 'outgoing',
          status: 'completed',
          transport: 'ws-relay',
          files: [
            {
              index: 0,
              name: 'confidential-contract.pdf',
              size: 131072,
              mimeType: 'application/pdf',
              totalChunks: 2,
              chunkSize: 65536,
            },
          ],
          totalBytes: 131072,
          transferredBytes: 131072,
          startedAt: Date.now() - 60_000,
          completedAt: Date.now() - 59_000,
          sasCode: '482910',
        },
        {
          transferId: randomTransferId(),
          peerDeviceId: '9988776655443322',
          peerName: 'MotoG57',
          peerPlatform: 'android',
          direction: 'incoming',
          status: 'cancelled',
          transport: 'ws-relay',
          files: [
            {
              index: 0,
              name: 'aborted-raw.mov',
              size: 4_194_304,
              mimeType: 'video/quicktime',
              totalChunks: 4,
              chunkSize: 1_048_576,
            },
          ],
          totalBytes: 4_194_304,
          transferredBytes: 1_048_576,
          startedAt: Date.now() - 30_000,
          sasCode: '482910',
        },
      ];

      await mac.sendControl(android.peerId, {
        kind: 'history-sync',
        transfers: historyEntries,
      });

      const rx = await android.waitForControl((e) => e.payload.kind === 'history-sync');
      expect(rx.from).toBe(mac.peerId);
      expect(rx.payload.kind).toBe('history-sync');
      if (rx.payload.kind === 'history-sync') {
        expect(rx.payload.transfers).toHaveLength(2);
        expect(rx.payload.transfers[0].files[0].name).toBe('confidential-contract.pdf');
        expect(rx.payload.transfers[0].status).toBe('completed');
        expect(rx.payload.transfers[1].status).toBe('cancelled');
      }

      // Ensure encrypted control envelope does not leak plaintext history metadata on the wire
      const kpA = await generateIdentityKeyPair();
      const kpB = await generateIdentityKeyPair();
      const sess = await derivePeerSession(kpA.privateKey, kpA.publicKeyB64, kpB.publicKeyB64);
      const wireEnv = await encryptControlPayload(sess.aesKey, {
        kind: 'history-sync',
        transfers: historyEntries,
      });
      const serialized = JSON.stringify(wireEnv);
      expect(serialized).not.toContain('confidential-contract.pdf');
      expect(serialized).not.toContain('482910');
    } finally {
      await mac.disconnect().catch(() => {});
      await android.disconnect().catch(() => {});
      await server.close();
    }
  });
});
