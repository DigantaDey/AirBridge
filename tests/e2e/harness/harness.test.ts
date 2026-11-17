import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestServer,
  closeAllTestServers,
  type TestServerInstance,
  OpaquePeer,
  deriveSasCode,
  createSyntheticBuffer,
  createSyntheticFileManifest,
  assertBuffersEqual,
  computeSha256,
  isValidSasCode,
  isValidPairCode,
  corruptAuthTag,
  truncateFrame,
  decodeEncryptedChunkFrame,
  decryptBinaryChunk,
  encodeBinarySackFrame,
  decodeBinarySackFrame,
  readAndroidManifest,
  hasPermission,
  hasForegroundServiceType,
  readAppBuildGradle,
  isV1SigningEnabled,
  isV2SigningEnabled,
} from './index.js';

describe('AirBridge E2E Harness Self-Verification', () => {
  let testServer: TestServerInstance;
  let androidPeer: OpaquePeer;
  let desktopPeer: OpaquePeer;

  beforeAll(async () => {
    // 1. Verify ephemeral server spin-up on OS-assigned port (port: 0)
    testServer = await createTestServer();
  });

  afterAll(async () => {
    if (androidPeer) await androidPeer.disconnect();
    if (desktopPeer) await desktopPeer.disconnect();
    await closeAllTestServers();
  });

  it('allocates ephemeral port 0 and establishes valid endpoints', () => {
    expect(testServer.port).toBeGreaterThan(0);
    expect(testServer.port).not.toBe(3000);
    expect(testServer.wsUrl).toBe(`ws://127.0.0.1:${testServer.port}/ws`);
    expect(testServer.httpUrl).toBe(`http://127.0.0.1:${testServer.port}`);
  });

  it('connects two OpaquePeers, discovers each other, and verifies matching SAS codes', async () => {
    androidPeer = await OpaquePeer.create({
      name: 'Pixel 9 Pro · E2E',
      platform: 'android',
      model: 'Pixel 9 Pro',
      formFactor: 'phone',
    });

    desktopPeer = await OpaquePeer.create({
      name: 'MacBook Pro · E2E',
      platform: 'macos',
      model: 'MacBook Pro',
      formFactor: 'laptop',
    });

    const androidWelcome = await androidPeer.connect(testServer.wsUrl);
    expect(androidWelcome.peerId).toBeTruthy();
    expect(isValidPairCode(androidWelcome.pairCode)).toBe(true);

    // Desktop joins Android's pair code
    desktopPeer.pairCode = androidWelcome.pairCode;
    const desktopWelcome = await desktopPeer.connect(testServer.wsUrl);
    expect(desktopWelcome.peerId).toBeTruthy();

    // Verify mutual discovery in the room
    const discoveredOnAndroid = await androidPeer.waitForPeer(
      (p) => p.peerId === desktopPeer.peerId
    );
    const discoveredOnDesktop = await desktopPeer.waitForPeer(
      (p) => p.peerId === androidPeer.peerId
    );

    expect(discoveredOnAndroid.device.name).toBe('MacBook Pro · E2E');
    expect(discoveredOnDesktop.device.name).toBe('Pixel 9 Pro · E2E');

    // Verify ECDH key agreement and SAS 6-digit verification code parity
    const androidSas = await androidPeer.getSasCode(desktopPeer.peerId);
    const desktopSas = await desktopPeer.getSasCode(androidPeer.peerId);

    expect(androidSas).toBe(desktopSas);
    expect(isValidSasCode(androidSas)).toBe(true);

    // Standalone SAS derivation check
    const manualSas = await deriveSasCode(
      androidPeer.identity.publicKeyB64,
      desktopPeer.identity.publicKeyB64
    );
    expect(manualSas.sasCode).toBe(androidSas);
  });

  it('exchanges encrypted transfer-control payloads with zero leakage', async () => {
    const transferId = 'e2e0123456789abc';
    const syntheticManifest = createSyntheticFileManifest('sample-doc.pdf', 64 * 1024);

    // Android peer sends encrypted transfer-offer
    await androidPeer.sendControl(desktopPeer.peerId, {
      kind: 'transfer-offer',
      transferId,
      totalBytes: 64 * 1024,
      createdAt: Date.now(),
      files: [syntheticManifest],
    });

    const receivedOffer = await desktopPeer.waitForControl(
      (e) => e.from === androidPeer.peerId && e.payload.kind === 'transfer-offer'
    );

    expect(receivedOffer.payload.kind).toBe('transfer-offer');
    if (receivedOffer.payload.kind === 'transfer-offer') {
      expect(receivedOffer.payload.transferId).toBe(transferId);
      expect(receivedOffer.payload.files[0].name).toBe('sample-doc.pdf');
    }

    // Desktop peer replies with transfer-accept
    await desktopPeer.sendControl(androidPeer.peerId, {
      kind: 'transfer-accept',
      transferId,
      preferredTransport: 'ws-relay',
    });

    const receivedAccept = await androidPeer.waitForControl(
      (e) => e.from === desktopPeer.peerId && e.payload.kind === 'transfer-accept'
    );

    expect(receivedAccept.payload.kind).toBe('transfer-accept');
    if (receivedAccept.payload.kind === 'transfer-accept') {
      expect(receivedAccept.payload.transferId).toBe(transferId);
    }
  });

  it('streams encrypted binary chunks over routed relay frames with byte-for-byte integrity', async () => {
    const transferId = 'chunktest1234567';
    const originalPlaintext = createSyntheticBuffer(128 * 1024, 42);
    const expectedSha256 = await computeSha256(originalPlaintext);

    // Desktop peer transmits encrypted 0x01 chunk wrapped in 0x02 routed frame to Android
    await desktopPeer.sendChunk(
      androidPeer.peerId,
      transferId,
      0, // fileIndex
      0, // chunkIndex
      originalPlaintext
    );

    // Android peer receives, un-routs, decodes, and decrypts the binary chunk
    const chunkEvent = await androidPeer.waitForChunk(
      (c) => c.sourcePeerId === desktopPeer.peerId && c.frame.transferId === transferId
    );

    expect(chunkEvent.frame.fileIndex).toBe(0);
    expect(chunkEvent.frame.chunkIndex).toBe(0);
    assertBuffersEqual(chunkEvent.plaintext, originalPlaintext);

    const receivedSha256 = await computeSha256(chunkEvent.plaintext);
    expect(receivedSha256).toBe(expectedSha256);
  });

  it('transmits and decodes compact 16-byte binary SACK frames', async () => {
    const transferId = 'sacktest12345678';

    // Android peer sends compact binary SACK acknowledging chunk 0 with window size 16
    await androidPeer.sendBinarySack(
      desktopPeer.peerId,
      transferId,
      0, // fileIndex
      0, // chunkIndex
      16, // windowSize
      0b00000001 // bitmask
    );

    const sackEvent = await desktopPeer.waitForSack(
      (s) => s.sourcePeerId === androidPeer.peerId && s.frame.chunkIndex === 0
    );

    expect(sackEvent.frame.fileIndex).toBe(0);
    expect(sackEvent.frame.chunkIndex).toBe(0);
    expect(sackEvent.frame.windowSize).toBe(16);
    expect(sackEvent.frame.bitmask).toBe(1);
  });

  it('transmits and decodes canonical 0x03 hex-packed 16-byte wire SACK frames', async () => {
    const transferId = 'a1b2c3d4e5f60708';

    await androidPeer.sendCanonicalBinarySack(
      desktopPeer.peerId,
      transferId,
      2, // fileIndex
      14, // chunkIndex
      0x5a // bitmask
    );

    const sackEvent = await desktopPeer.waitForSack(
      (s) => s.sourcePeerId === androidPeer.peerId && s.canonical?.transferId === transferId
    );

    expect(sackEvent.rawBytes?.byteLength).toBe(16);
    expect(sackEvent.canonical?.transferId).toBe(transferId);
    expect(sackEvent.canonical?.fileIndex).toBe(2);
    expect(sackEvent.canonical?.chunkIndex).toBe(14);
    expect(sackEvent.canonical?.bitmask).toBe(0x5a);
  });

  it('detects tampering: corrupted auth tags and truncated frames fail verification', async () => {
    const session = await androidPeer.getSession(desktopPeer.peerId);
    const plaintext = createSyntheticBuffer(1024, 99);

    // Encrypt a valid chunk
    const { iv, ciphertext } = await import('./index.js').then((m) =>
      m.encryptBinaryChunk(session.aesKey, plaintext)
    );
    const validFrame = import('./index.js').then((m) =>
      m.encodeEncryptedChunkFrame({
        transferId: 'tampertest123456',
        fileIndex: 0,
        chunkIndex: 0,
        iv,
        ciphertext,
      })
    );
    const frameBytes = await validFrame;

    // 1. Corrupt auth tag (bit flipped in the last 16 bytes)
    const tamperedTag = corruptAuthTag(frameBytes);
    const decodedTampered = decodeEncryptedChunkFrame(tamperedTag);

    await expect(
      decryptBinaryChunk(session.aesKey, decodedTampered.iv, decodedTampered.ciphertext)
    ).rejects.toThrow();

    // 2. Truncate frame header to less than 37 bytes
    const truncated = truncateFrame(frameBytes, 20);
    expect(() => decodeEncryptedChunkFrame(truncated)).toThrow(/too short/);
  });

  it('audits AndroidManifest.xml and build.gradle.kts configurations', async () => {
    const manifest = await readAndroidManifest();

    // Verify critical Android 14+ permissions
    expect(hasPermission(manifest, 'INTERNET')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_CONNECTED_DEVICE')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_DATA_SYNC')).toBe(true);
    expect(hasPermission(manifest, 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')).toBe(false);
    expect(hasPermission(manifest, 'WAKE_LOCK')).toBe(true);

    // Verify ConnectionService declares connectedDevice|dataSync FGS types
    expect(hasForegroundServiceType(manifest, 'ConnectionService', 'connectedDevice')).toBe(true);
    expect(hasForegroundServiceType(manifest, 'ConnectionService', 'dataSync')).toBe(true);

    // Verify build.gradle.kts signing configs
    const gradle = await readAppBuildGradle();
    expect(gradle.compileSdk).toBe(36);
    expect(gradle.minSdk).toBe(26);
    expect(isV1SigningEnabled(gradle, 'ciSideload')).toBe(true);
    expect(isV2SigningEnabled(gradle, 'ciSideload')).toBe(true);
  });
});
