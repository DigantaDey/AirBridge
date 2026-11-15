import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBuffersEqual,
  computeSha256,
  createSyntheticBuffer,
  getService,
  hasForegroundServiceType,
  hasPermission,
  isValidPairCode,
  readAndroidManifest,
  readRepoFile,
  randomTransferId,
  startTestServer,
  withTempDir,
} from '../harness/index.js';

describe('Tier 4 Scenario 07: Background Transfer & Clipboard Daemon Continuity', () => {
  it('syncs background daemon pair code and persists multi-chunk drops to disk while app UI is backgrounded', async () => {
    await withTempDir('ab-t4-s07-bg-', async (dir) => {
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
          downloadDir: dir,
          notifyOnReceive: false,
          revealInFinder: false,
        },
      });

      try {
        const bgSync = await fetch(`${server.httpUrl}/api/daemon/background-pair-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pairCode: 'BG789K',
            autoClipboard: true,
            receiveClipboard: true,
          }),
        });
        expect(bgSync.status).toBe(200);
        const bgMeta = (await bgSync.json()) as { ok: boolean; pairCode?: string };
        expect(bgMeta.ok).toBe(true);
        if (bgMeta.pairCode) {
          expect(isValidPairCode(bgMeta.pairCode)).toBe(true);
        }

        const chunkSize = 64 * 1024;
        const payload = createSyntheticBuffer(chunkSize * 3 + 911, 222);
        const expectedSha = await computeSha256(payload);
        const tid = randomTransferId();
        const totalChunks = Math.ceil(payload.byteLength / chunkSize);

        for (let idx = 0; idx < totalChunks; idx++) {
          const slice = payload.subarray(idx * chunkSize, Math.min(payload.byteLength, (idx + 1) * chunkSize));
          const wr = await fetch(`${server.httpUrl}/api/daemon/receive-chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-airbridge-transfer': tid,
              'x-airbridge-file': '0',
              'x-airbridge-chunk': String(idx),
              'x-airbridge-name': 'background-screenrec.mp4',
              'x-airbridge-size': String(payload.byteLength),
              'x-airbridge-chunk-size': String(chunkSize),
              'x-airbridge-total-chunks': String(totalChunks),
            },
            body: Buffer.from(slice),
          });
          expect(wr.status).toBe(200);
        }

        const fin = await fetch(`${server.httpUrl}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transferId: tid,
            fileIndex: 0,
            expectedSha256: expectedSha,
          }),
        });
        expect(fin.status).toBe(200);
        const finJson = (await fin.json()) as { savedPath: string; sha256: string };
        expect(finJson.sha256).toBe(expectedSha);

        const diskData = await readFile(finJson.savedPath || join(dir, 'background-screenrec.mp4'));
        assertBuffersEqual(diskData, payload);
      } finally {
        await server.close();
      }
    });
  });

  it('enforces full Android 14/15 foreground service, wakelock, wifi lock, and battery exemption continuity stack', async () => {
    const manifest = await readAndroidManifest();
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_CONNECTED_DEVICE')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_DATA_SYNC')).toBe(true);
    expect(hasPermission(manifest, 'WAKE_LOCK')).toBe(true);
    expect(hasPermission(manifest, 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')).toBe(false);

    const svc = getService(manifest, '.ConnectionService');
    expect(svc).toBeDefined();
    expect(svc!.stopWithTask).toBe(false);
    expect(hasForegroundServiceType(manifest, '.ConnectionService', 'connectedDevice')).toBe(true);
    expect(hasForegroundServiceType(manifest, '.ConnectionService', 'dataSync')).toBe(true);

    const kt = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(kt).toContain('PowerManager.PARTIAL_WAKE_LOCK');
    expect(kt).toContain('WifiManager.WIFI_MODE_FULL_LOW_LATENCY');
    expect(kt).toContain('const val ACTION_START');
    expect(kt).toContain('startForegroundCompat');
    expect(kt).toContain('registerDefaultNetworkCallback');
  });
});
