import { describe, expect, it } from 'vitest';
import {
  getActivity,
  getService,
  hasForegroundServiceType,
  hasPermission,
  readAndroidManifest,
  readRepoFile,
} from '../harness/index.js';

describe('F13: Foreground Service Types & Android 14/15 Compliance', () => {
  it('declares FOREGROUND_SERVICE, CONNECTED_DEVICE, DATA_SYNC, and POST_NOTIFICATIONS permissions', async () => {
    const manifest = await readAndroidManifest();
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_CONNECTED_DEVICE')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_DATA_SYNC')).toBe(true);
    expect(hasPermission(manifest, 'POST_NOTIFICATIONS')).toBe(true);
    expect(hasPermission(manifest, 'WRITE_EXTERNAL_STORAGE')).toBe(false);
  });

  it('configures ConnectionService with connectedDevice|dataSync types, non-exported, and stopWithTask=false', async () => {
    const manifest = await readAndroidManifest();
    const svc = getService(manifest, '.ConnectionService');
    expect(svc).toBeDefined();
    expect(svc!.exported).toBe(false);
    expect(svc!.stopWithTask).toBe(false);
    expect(hasForegroundServiceType(manifest, '.ConnectionService', 'connectedDevice')).toBe(true);
    expect(hasForegroundServiceType(manifest, '.ConnectionService', 'dataSync')).toBe(true);
  });

  it('passes API 34+ dual foregroundServiceType flags cleanly in ConnectionService.startForegroundCompat', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
    expect(svc).toContain('FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE');
    expect(svc).toContain('FOREGROUND_SERVICE_TYPE_DATA_SYNC');
  });

  it('implements Android 14/15 onTimeout(startId) and onTimeout(startId, fgsType) handlers', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('override fun onTimeout(startId: Int)');
    expect(svc).toContain('override fun onTimeout(startId: Int, fgsType: Int)');
    expect(svc).toContain('handleFgsTimeout(startId');
    expect(svc).toContain('stopForeground(STOP_FOREGROUND_REMOVE)');
  });

  it('promotes ConnectionService before stopping on ACTION_STOP to prevent ForegroundServiceDidNotStartInTimeException', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('ForegroundServiceDidNotStartInTimeException');
    expect(svc).toContain('if (!foregroundStarted)');
    expect(svc).toContain('startForegroundCompat(buildNotification())');
    expect(svc).toContain('stopForegroundAndSelf(startId)');
  });

  it('keeps exported components explicit and excludes privileged clipboard-observation services', async () => {
    const manifest = await readAndroidManifest();
    const main = getActivity(manifest, '.MainActivity');
    expect(main).toBeDefined();
    expect(main!.exported).toBe(true);
    expect(main!.actions).toContain('android.intent.action.MAIN');

    expect(getService(manifest, '.ClipboardAccessibilityService')).toBeUndefined();
    expect(getService(manifest, '.NotificationSharingService')).toBeUndefined();
    expect(manifest.rawXml).not.toContain('BIND_ACCESSIBILITY_SERVICE');
    expect(manifest.rawXml).not.toContain('BIND_NOTIFICATION_LISTENER_SERVICE');

    const tile = getService(manifest, '.ClipboardTileService');
    expect(tile).toBeDefined();
    expect(tile!.permission).toBe('android.permission.BIND_QUICK_SETTINGS_TILE');
  });
});
