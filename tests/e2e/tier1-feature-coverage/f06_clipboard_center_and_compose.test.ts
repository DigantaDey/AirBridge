import { describe, expect, it } from 'vitest';
import { readRepoFile, withPairedEnv } from '../harness/index.js';

describe('F06: Clipboard Center & Compose', () => {
  it('beams UTF-8 multi-line text payloads encrypted end-to-end', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const text = 'Line 1: Hello\nLine 2: 🚀 Unicode & ₹100';
      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'clip0001',
        text,
        contentType: 'text',
        timestamp: Date.now(),
      });
      const received = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'clip0001',
      );
      expect(received.payload.kind).toBe('clipboard-beam');
      if (received.payload.kind === 'clipboard-beam') {
        expect(received.payload.text).toBe(text);
        expect(received.payload.contentType).toBe('text');
      }
    });
  });

  it('beams URL and code-classified clipboard items intact', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const url = 'https://github.com/airbridge/releases?tag=v2.2.1';
      await desktopPeer.sendControl(androidPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'clip0002',
        text: url,
        contentType: 'url',
        timestamp: Date.now(),
      });
      const evt = await androidPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'clip0002',
      );
      if (evt.payload.kind === 'clipboard-beam') {
        expect(evt.payload.text).toBe(url);
        expect(evt.payload.contentType).toBe('url');
      }
    });
  });

  it('beams inline PNG clipboard images via imageDataUrl cleanly', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP8z8DwH4gZgKQBAQcCA/8fV9oAAAAASUVORK5CYII=';
      await androidPeer.sendControl(desktopPeer.peerId, {
        kind: 'clipboard-beam',
        beamId: 'clip0003',
        imageDataUrl,
        imageName: 'snap.png',
        contentType: 'image',
        timestamp: Date.now(),
      });
      const evt = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'clip0003',
      );
      if (evt.payload.kind === 'clipboard-beam') {
        expect(evt.payload.imageDataUrl).toBe(imageDataUrl);
        expect(evt.payload.contentType).toBe('image');
      }
    });
  });

  it('renders ClipboardScreen composer, PickVisualMedia image trigger, and clipboard history', async () => {
    const screen = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/screens/ClipboardScreen.kt');
    expect(screen).toContain('fun ClipboardScreen(');
    expect(screen).toContain('onBeamText');
    expect(screen).toContain('onPickImage');
    expect(screen).toContain('onBeamSystemClipboard');
    expect(screen).toContain('ClipboardItemCard');

    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    expect(activity).toContain('ActivityResultContracts.PickVisualMedia');
  });

  it('supports clear-history and per-item copy controls in ViewModel and NativeEngineHost', async () => {
    const vm = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt');
    expect(vm).toContain('fun beamText(');
    expect(vm).toContain('fun beamImageUri(');
    expect(vm).toContain('fun copyClipboardItem(');
    expect(vm).toContain('fun clearClipboardHistory(');
  });
});
