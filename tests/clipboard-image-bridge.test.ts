import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarpClient } from '../src/client/engine/warpClient.js';
import {
  HostClipboardMonitor,
  classifyMacPasteboardTypes,
  createSystemClipboardProvider,
  isCorruptedBinaryClipboardText,
  type HostClipboardContent,
} from '../src/server/hostClipboard.js';
import { SignalingHub } from '../src/server/signalingHub.js';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2WkAAAAASUVORK5CYII=';

describe('Clipboard photo bridge (MacBook <-> Android without binary gibberish echo)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('classifies macOS image pasteboards before filename/text UTIs and rejects corrupted binary text', () => {
    // Finder / Screenshot puts both image & utf8 filename/metadata UTIs on NSPasteboard
    expect(classifyMacPasteboardTypes(['public.utf8-plain-text', 'public.png'], false)).toBe('image');
    expect(classifyMacPasteboardTypes(['public.utf8-plain-text'], true)).toBe('image');
    expect(classifyMacPasteboardTypes(['public.utf8-plain-text', 'public.rtf'], false)).toBe('text');
    expect(classifyMacPasteboardTypes(['com.apple.finder.node'], false)).toBe('none');

    // Binary image payloads read through pbpaste must be blocked cleanly
    expect(isCorruptedBinaryClipboardText('\u0089PNG\r\n\u001a\n\u0000IHDR')).toBe(true);
    expect(isCorruptedBinaryClipboardText('\ufffd\ufffd\ufffd\ufffdJFIF binary garbage')).toBe(true);
    expect(isCorruptedBinaryClipboardText('bplist00\u00d4\u0001\u0002')).toBe(true);
    expect(isCorruptedBinaryClipboardText('Hello normal clipboard text https://example.com')).toBe(false);
  });

  it('uses injectable JXA command runner on darwin without reading/overwriting real macOS pasteboard', async () => {
    const writtenPayloads: string[] = [];
    const provider = createSystemClipboardProvider('darwin', async (_cmd, args, stdinText) => {
      if (args.includes('-e') && stdinText === null) {
        return {
          ok: true,
          stdout: JSON.stringify({ kind: 'image', imageDataUrl: TINY_PNG_DATA_URL, imageName: 'shot.png' }),
        };
      }
      if (stdinText !== null) {
        writtenPayloads.push(stdinText);
        return { ok: true, stdout: 'OK\n' };
      }
      return { ok: false, stdout: null };
    });

    const content = await provider.readClipboard!();
    expect(content).toEqual({
      kind: 'image',
      imageDataUrl: TINY_PNG_DATA_URL,
      imageName: 'shot.png',
    });

    const ok = await provider.writeImage!(TINY_PNG_DATA_URL);
    expect(ok).toBe(true);
    expect(writtenPayloads).toHaveLength(1);
    expect(JSON.parse(writtenPayloads[0]!).mime).toBe('image/png');
  });

  it('HostClipboardMonitor captures new host images, blocks corrupted text, and suppresses echo after writeImage', async () => {
    vi.useFakeTimers();
    let current: HostClipboardContent | null = { kind: 'text', text: 'initial-seed' };
    const capturedImages: Array<{ dataUrl: string; name?: string }> = [];
    const capturedTexts: string[] = [];

    const monitor = new HostClipboardMonitor({
      pollIntervalMs: 50,
      provider: {
        isSupported: () => true,
        readText: async () => (current?.kind === 'text' ? current.text : null),
        readClipboard: async () => current,
        writeText: async (text) => { current = { kind: 'text', text }; return true; },
        writeImage: async (imageDataUrl) => { current = { kind: 'image', imageDataUrl }; return true; },
      },
      onClipboardChange: (t) => capturedTexts.push(t),
      onClipboardImageChange: (dataUrl, name) => capturedImages.push({ dataUrl, name }),
    });
    cleanups.push(() => monitor.close());

    monitor.setShouldWatch(true);
    await vi.advanceTimersByTimeAsync(10); // seeds initial-seed

    // Binary garbage text must be dropped and counted
    current = { kind: 'text', text: '\u0089PNG\r\n\u001a\nIHDRbinarygarbage' };
    await vi.advanceTimersByTimeAsync(60);
    expect(capturedTexts).toHaveLength(0);
    expect(monitor.getTelemetry().corruptedTextBlocked).toBe(1);

    // Real photo copied on Mac -> captured cleanly as image
    current = { kind: 'image', imageDataUrl: TINY_PNG_DATA_URL, imageName: 'photo.png' };
    await vi.advanceTimersByTimeAsync(60);
    expect(capturedImages).toHaveLength(1);
    expect(capturedImages[0]!.dataUrl).toBe(TINY_PNG_DATA_URL);

    // Incoming photo written from Android -> must suppress immediate re-capture echo
    expect(await monitor.writeImage(TINY_PNG_DATA_URL)).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(capturedImages).toHaveLength(1);
    expect(monitor.getTelemetry().imageWrites).toBe(1);
  });

  it('beams host clipboard photo from SignalingHub through WarpClient to paired peer with E2EE', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-clip-img-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    let current: HostClipboardContent = { kind: 'text', text: 'seed' };
    let port = 0;
    const hub = new SignalingHub({
      getLanUrls: () => [`http://127.0.0.1:${port}`],
      getDaemonStatus: () => ({ enabled: false, platform: 'test', hostname: 'h', autoSaveToDownloads: false, clipboardBridge: true }),
      clipboardPollMs: 40,
      clipboardProvider: {
        isSupported: () => true,
        readText: async () => (current.kind === 'text' ? current.text : null),
        readClipboard: async () => current,
        writeText: async () => true,
        writeImage: async () => true,
      },
      isLocalMachine: () => true,
    });
    const server = http.createServer();
    server.on('upgrade', (req, sock, head) => {
      hub.wss.handleUpgrade(req, sock, head, (ws) => {
        hub.wss.emit('connection', ws, req);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    cleanups.push(() => {
      hub.close();
      return new Promise((r) => server.close(() => r()));
    });

    const mac = new WarpClient({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      initialPairCode: hub.getDefaultPairCode(),
      enableWebRtc: false,
      deviceOverride: { name: 'MacBook', platform: 'macos', model: 'MacBook', formFactor: 'laptop', deviceId: '1111111111111111' },
    });
    const phone = new WarpClient({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      initialPairCode: hub.getDefaultPairCode(),
      enableWebRtc: false,
      deviceOverride: { name: 'Pixel', platform: 'android', model: 'Pixel', formFactor: 'phone', deviceId: '2222222222222222' },
    });
    cleanups.push(() => { mac.stop(); phone.stop(); });

    await mac.start();
    await phone.start();
    const waitPaired = async (c: WarpClient) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (c.getSnapshot().peers.some((p) => p.discoveryScope === 'paired')) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('paired timeout');
    };
    await waitPaired(mac);
    await waitPaired(phone);

    // Trigger new image on host clipboard
    current = { kind: 'image', imageDataUrl: TINY_PNG_DATA_URL, imageName: 'copied.png' };
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (phone.getSnapshot().clipboardItems.some((item) => item.contentType === 'image')) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const received = phone.getSnapshot().clipboardItems.find((i) => i.contentType === 'image');
    expect(received).toBeDefined();
    expect(received!.imageDataUrl).toBe(TINY_PNG_DATA_URL);
    expect(received!.imageName).toBe('copied.png');
  });
});
