import { describe, expect, it } from 'vitest';
import { readRepoFile, withPairedEnv } from '../harness/index.js';

describe('F16: Bidirectional Clipboard Sync & Background Android Access', () => {
  it('delivers encrypted clipboard text bidirectionally between Android and Desktop peers', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const aToDId = 'f16-a-to-d';
      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: aToDId,
        contentType: 'text',
        text: 'Copied on moto g57 in background',
        timestamp: Date.now(),
      });
      const rxDesktop = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === aToDId,
      );
      expect(rxDesktop.payload.kind === 'clipboard-beam' && rxDesktop.payload.text).toBe(
        'Copied on moto g57 in background',
      );

      const dToAId = 'f16-d-to-a';
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: dToAId,
        contentType: 'text',
        text: 'Copied on MacBook Pro',
        timestamp: Date.now(),
      });
      const rxAndroid = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === dToAId,
      );
      expect(rxAndroid.payload.kind === 'clipboard-beam' && rxAndroid.payload.text).toBe(
        'Copied on MacBook Pro',
      );
    });
  });

  it('transmits image clipboard data URLs cleanly through encrypted transfer-control', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const pngDataUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'f16-img-clip',
        contentType: 'image',
        imageDataUrl: pngDataUrl,
        timestamp: Date.now(),
      });
      const rx = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'f16-img-clip',
      );
      expect(rx.payload.kind === 'clipboard-beam' && rx.payload.imageDataUrl).toBe(pngDataUrl);
    });
  });

  it('uses explicit Android clipboard-send paths instead of Accessibility observation', async () => {
    const manifest = await readRepoFile('android/app/src/main/AndroidManifest.xml');
    const tile = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ClipboardTileService.kt');
    const share = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ShareTextActivity.kt');
    expect(manifest).not.toContain('BIND_ACCESSIBILITY_SERVICE');
    expect(manifest).not.toContain('ClipboardAccessibilityService');
    expect(tile).toContain('explicit, one-tap clipboard beam');
    expect(share).toContain('Intent.ACTION_PROCESS_TEXT');
  });

  it('implements own-write echo suppression and burst deduplication in ConnectionService', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('OWN_WRITE_ECHO_WINDOW_MS = 1_500L');
    expect(svc).toContain('DUPLICATE_EVENT_WINDOW_MS = 400L');
    expect(svc).toContain('fun markOwnClipboardWrite(text: String)');
    expect(svc).toContain('fun publishClipboardChange(context: Context, text: String');
  });

  it('provides Quick Settings Tile, notification Beam trampoline, and Share/Process-Text fallbacks', async () => {
    const tile = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ClipboardTileService.kt',
    );
    const beam = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ClipboardBeamActivity.kt',
    );
    const share = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ShareTextActivity.kt',
    );
    expect(tile).toContain('class ClipboardTileService : TileService()');
    expect(beam).toContain('class ClipboardBeamActivity : Activity()');
    expect(beam).toContain('ACTION_SHARE_TEXT');
    expect(share).toContain('Intent.ACTION_PROCESS_TEXT');
    expect(share).toContain('Intent.ACTION_SEND');
  });

  it('enforces the 256,000-char clipboard size cap locally in ConnectionService and ShareTextActivity', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    const share = await readRepoFile(
      'android/app/src/main/kotlin/com/airbridge/app/ShareTextActivity.kt',
    );
    expect(svc).toContain('Limits.MAX_CLIPBOARD_TEXT');
    expect(share).toContain('Limits.MAX_CLIPBOARD_TEXT');
  });
});
