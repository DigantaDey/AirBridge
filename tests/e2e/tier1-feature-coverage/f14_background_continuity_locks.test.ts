import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  createSyntheticBuffer,
  hasPermission,
  negotiateTransfer,
  OpaquePeer,
  randomTransferId,
  readAndroidManifest,
  readRepoFile,
  startTestServer,
} from '../harness/index.js';

describe('F14: Background Continuity, WakeLocks & Network Recovery', () => {
  it('declares WAKE_LOCK and Wi-Fi/Network state permissions without unused change permissions in AndroidManifest.xml', async () => {
    const manifest = await readAndroidManifest();
    expect(hasPermission(manifest, 'WAKE_LOCK')).toBe(true);
    expect(hasPermission(manifest, 'ACCESS_NETWORK_STATE')).toBe(true);
    expect(hasPermission(manifest, 'CHANGE_NETWORK_STATE')).toBe(false);
    expect(hasPermission(manifest, 'ACCESS_WIFI_STATE')).toBe(true);
    // Only for the hotspot handoff, which calls startLocalOnlyHotspot (requires it).
    const handoff = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/HotspotHandoff.kt');
    expect(handoff).toContain('startLocalOnlyHotspot(');
    expect(hasPermission(manifest, 'CHANGE_WIFI_STATE')).toBe(true);
  });

  it('acquires bounded PARTIAL_WAKE_LOCK with periodic refresh in ConnectionService', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('PowerManager.PARTIAL_WAKE_LOCK');
    expect(svc).toContain('"$packageName:AirBridgeTransfer"');
    expect(svc).toContain('setReferenceCounted(false)');
    expect(svc).toContain('val wakeTimeoutMs = if (transferActive) 10 * 60_000L else 3 * 60_000L');
    expect(svc).toContain('releaseTransferWakeLock()');
  });

  it('acquires WIFI_MODE_FULL_LOW_LATENCY (Q+) with HIGH_PERF fallback and SecurityException guard', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('WifiManager.WIFI_MODE_FULL_LOW_LATENCY');
    expect(svc).toContain('WifiManager.WIFI_MODE_FULL_HIGH_PERF');
    expect(svc).toContain('"$packageName:AirBridgeWifi"');
    expect(svc).toContain('catch (e: SecurityException)');
  });

  it('registers ConnectivityManager.NetworkCallback to trigger immediate reconnect on network change/loss', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('registerDefaultNetworkCallback');
    expect(svc).toContain('override fun onAvailable(network: android.net.Network)');
    expect(svc).toContain('override fun onLost(network: android.net.Network)');
    expect(svc).toContain('engineHost?.reconnect()');
  });

  it('returns START_STICKY when connectionContinuity is enabled and START_NOT_STICKY otherwise', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('return if (Prefs(this).connectionContinuity) START_STICKY else START_NOT_STICKY');
    expect(svc).toContain('!Prefs(this).connectionContinuity');
  });

  it('preserves pair identity and resumes mid-transfer after background WebSocket drop and reconnect', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const desktop = await OpaquePeer.create({ name: 'Desktop', platform: 'macos', pairCode: 'BG1234' });
    let phone = await OpaquePeer.create({
      name: 'Android Background',
      platform: 'android',
      deviceId: '0011223344556677',
      pairCode: 'BG1234',
    });
    const chunkSize = 64 * 1024;
    const payload = createSyntheticBuffer(chunkSize * 4, 33);
    const received = new Uint8Array(payload.byteLength);
    const transferId = randomTransferId();

    try {
      await Promise.all([desktop.connect(server.wsUrl), phone.connect(server.wsUrl)]);
      await desktop.waitForPeer((p) => p.peerId === phone.peerId);
      await negotiateTransfer(desktop, phone, transferId, [
        {
          index: 0,
          name: 'bg-continuity.bin',
          size: payload.byteLength,
          mimeType: 'application/octet-stream',
          totalChunks: 4,
          chunkSize,
        },
      ]);

      // Receive first 2 chunks, then drop Android socket as if backgrounded across network swap
      for (const i of [0, 1]) {
        await desktop.sendChunk(phone.peerId, transferId, 0, i, payload.subarray(i * chunkSize, (i + 1) * chunkSize));
        const rx = await phone.waitForChunk((c) => c.frame.transferId === transferId && c.frame.chunkIndex === i);
        received.set(rx.plaintext, i * chunkSize);
      }
      await phone.disconnect();

      // Reconnect with same deviceId + pairCode and resume remaining chunks [2, 3]
      phone = await OpaquePeer.create({
        name: 'Android Background',
        platform: 'android',
        deviceId: '0011223344556677',
        pairCode: 'BG1234',
      });
      await phone.connect(server.wsUrl);
      const rejoined = await desktop.waitForPeer((p) => p.peerId === phone.peerId);
      expect(rejoined.device.deviceId).toBe('0011223344556677');

      await phone.sendControl(desktop.peerId, {
        kind: 'transfer-accept',
        transferId,
        preferredTransport: 'ws-relay',
        resumeFromChunks: { 0: 2 },
      });
      const resumeAck = await desktop.waitForControl(
        (e) =>
          e.from === phone.peerId &&
          e.payload.kind === 'transfer-accept' &&
          e.payload.transferId === transferId,
      );
      expect(resumeAck.payload.kind === 'transfer-accept' && resumeAck.payload.resumeFromChunks?.[0]).toBe(2);

      for (const i of [2, 3]) {
        await desktop.sendChunk(phone.peerId, transferId, 0, i, payload.subarray(i * chunkSize, (i + 1) * chunkSize));
        const rx = await phone.waitForChunk((c) => c.frame.transferId === transferId && c.frame.chunkIndex === i);
        received.set(rx.plaintext, i * chunkSize);
      }
      expect(await computeSha256(received)).toBe(await computeSha256(payload));
    } finally {
      await phone.disconnect().catch(() => {});
      await desktop.disconnect().catch(() => {});
      await server.close();
    }
  });
});
