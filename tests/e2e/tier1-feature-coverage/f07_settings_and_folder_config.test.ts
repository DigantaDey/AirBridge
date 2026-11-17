import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  readRepoFile,
  startTestServer,
  withTempDir,
} from '../harness/index.js';

describe('F07: Native Settings Screen & Storage Config', () => {
  it('returns the configured received-folder path over loopback /api/received-folder', async () => {
    await withTempDir('ab-f07-get-', async (dir) => {
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
        const res = await fetch(`${server.httpUrl}/api/received-folder`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { downloadDir: string; enabled: boolean };
        expect(path.resolve(body.downloadDir)).toBe(path.resolve(dir));
      } finally {
        await server.close();
      }
    });
  });

  it('updates received-folder via PUT /api/received-folder on loopback and creates/uses valid directories', async () => {
    await withTempDir('ab-f07-put-', async (dir) => {
      const customDir = path.join(dir, 'custom-rx');
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
        const mkRes = await fetch(`${server.httpUrl}/api/fs/mkdir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base: dir, name: 'custom-rx' }),
        });
        expect(mkRes.status).toBe(200);

        const putRes = await fetch(`${server.httpUrl}/api/received-folder`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ downloadDir: customDir }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await fetch(`${server.httpUrl}/api/received-folder`);
        const json = (await getRes.json()) as { downloadDir: string };
        expect(path.resolve(json.downloadDir)).toBe(path.resolve(customDir));
      } finally {
        await server.close();
      }
    });
  });

  it('exposes device rename, visibility, theme, clipboard, continuity, and forget controls on SettingsScreen', async () => {
    const screen = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/screens/SettingsScreen.kt');
    expect(screen).toContain('onRenameDevice');
    expect(screen).toContain('onSetVisibility');
    expect(screen).toContain('onSetThemeMode');
    expect(screen).toContain('onSetAutoClipboard');
    expect(screen).toContain('onSetReceiveClipboard');
    expect(screen).toContain('onSetConnectionContinuity');
    expect(screen).toContain('onForgetComputer');
  });

  it('persists device preferences across sessions in Prefs.kt', async () => {
    const prefs = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/Prefs.kt');
    expect(prefs).toContain('visibility');
    expect(prefs).toContain('themeMode');
    expect(prefs).toContain('autoClipboard');
    expect(prefs).toContain('receiveClipboard');
    expect(prefs).toContain('connectionContinuity');
    expect(prefs).toContain('contactsOnComputer');
    expect(prefs).toContain('callsFromComputer');
    expect(prefs).toContain('screenSharing');
    expect(prefs).not.toContain('accessibilityClipboardOptIn');
  });

  it('propagates update-profile changes live across connected peers', async () => {
    await withTempDir('ab-f07-prof-', async () => {
      const server = await startTestServer({ enableMdns: false, hostClipboard: false });
      const { OpaquePeer } = await import('../harness/index.js');
      const phone = await OpaquePeer.create({ name: 'Old Phone', pairCode: 'PRF234' });
      const mac = await OpaquePeer.create({ name: 'Mac', pairCode: 'PRF234' });
      try {
        await Promise.all([phone.connect(server.wsUrl), mac.connect(server.wsUrl)]);
        await mac.waitForPeer((p) => p.peerId === phone.peerId && p.device.name === 'Old Phone');
        await phone.updateProfile({ name: 'Renamed Pixel' });
        const updated = await mac.waitForPeer(
          (p) => p.peerId === phone.peerId && p.device.name === 'Renamed Pixel',
        );
        expect(updated.device.name).toBe('Renamed Pixel');
      } finally {
        await phone.disconnect().catch(() => {});
        await mac.disconnect().catch(() => {});
        await server.close();
      }
    });
  });
});
