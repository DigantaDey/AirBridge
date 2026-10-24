import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { createCliBeamSession, type CliBeamSession } from '../src/server/cliSendSession.js';
import { HostClipboardMonitor, type HostClipboardProvider } from '../src/server/hostClipboard.js';
import { sanitizeFilename } from '../src/server/macIntegration.js';
import { bytesToBase64Url, type ServerToClientMessage } from '../src/shared/protocol.js';
import { webcrypto } from 'node:crypto';

async function testPublicKey(): Promise<string> {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
}

describe('CLI Beam Resumable Range Streaming & macOS Local Daemon Save', () => {
  let tmpDir: string;
  let sampleFilePath: string;
  let downloadDir: string;
  let server: AirBridgeServerInstance;
  let baseUrl: string;
  let session: CliBeamSession;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-test-'));
    sampleFilePath = path.join(tmpDir, 'Demo-Footage.bin');
    downloadDir = path.join(tmpDir, 'Downloads');

    const payload = Buffer.alloc(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    await fs.promises.writeFile(sampleFilePath, payload);

    session = await createCliBeamSession([sampleFilePath]);
    const sessions = new Map([[session.token, session]]);

    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      cliSessions: sessions,
      daemonConfig: {
        enabled: true,
        downloadDir,
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('sanitizes dangerous path traversal filenames cleanly', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('Photo:Summer*2026?.jpg')).toBe('Photo_Summer_2026_.jpg');
  });

  it('serves CLI beam manifest and supports HTTP 206 Byte-Range resumable downloads', async () => {
    const metaResp = await fetch(`${baseUrl}/api/beam/${session.token}`);
    expect(metaResp.status).toBe(200);
    const meta = (await metaResp.json()) as { files: Array<{ name: string; size: number }> };
    expect(meta.files).toHaveLength(1);
    expect(meta.files[0].name).toBe('Demo-Footage.bin');
    expect(meta.files[0].size).toBe(1024);

    // Partial byte-range request (bytes 10..29 inclusive = 20 bytes)
    const rangeResp = await fetch(`${baseUrl}/api/beam/${session.token}/file/0`, {
      headers: { Range: 'bytes=10-29' },
    });
    expect(rangeResp.status).toBe(206);
    expect(rangeResp.headers.get('content-range')).toBe('bytes 10-29/1024');
    const slice = new Uint8Array(await rangeResp.arrayBuffer());
    expect(slice.byteLength).toBe(20);
    expect(slice[0]).toBe(10);
    expect(slice[19]).toBe(29);
  });

  it('saves files atomically to local Downloads with collision-free deduplication', async () => {
    const content = Buffer.from('Hello MacBook Downloads Folder!');
    const r1 = await fetch(`${baseUrl}/api/daemon/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-AirBridge-Filename': encodeURIComponent('../CameraRoll.jpg'),
        'X-AirBridge-Sender': encodeURIComponent('Pixel 9 Pro'),
      },
      body: content,
    });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { finalName: string; savedPath: string };
    expect(j1.finalName).toBe('CameraRoll.jpg');
    expect(fs.readFileSync(j1.savedPath).toString('utf8')).toBe('Hello MacBook Downloads Folder!');

    // Sending same filename again creates "CameraRoll (1).jpg" instead of overwriting!
    const r2 = await fetch(`${baseUrl}/api/daemon/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-AirBridge-Filename': encodeURIComponent('CameraRoll.jpg'),
      },
      body: content,
    });
    const j2 = (await r2.json()) as { finalName: string };
    expect(j2.finalName).toBe('CameraRoll (1).jpg');
  });
});

describe('HostClipboardMonitor & Loopback Desktop Daemon Isolation', () => {
  it('seeds initial OS clipboard without firing onClipboardChange and suppresses echo writes', async () => {
    let osClipboard = 'Pre-existing secret on clipboard';
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => osClipboard,
      writeText: async (text: string) => {
        osClipboard = text;
        return true;
      },
    };

    const events: string[] = [];
    const monitor = new HostClipboardMonitor({
      provider,
      pollIntervalMs: 60,
      onClipboardChange: (text: string) => events.push(text),
    });

    monitor.setShouldWatch(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(events).toEqual([]);

    // User copies new text in another macOS app
    osClipboard = 'Copied from VS Code';
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual(['Copied from VS Code']);

    // Incoming beam from Android writes to macOS clipboard -> must NOT echo back
    await monitor.writeClipboard('Incoming from Android');
    expect(osClipboard).toBe('Incoming from Android');
    await new Promise((r) => setTimeout(r, 160));
    expect(events).toEqual(['Copied from VS Code']);

    monitor.close();
  });

  it('scopes localDaemon & host-clipboard bridge strictly to host desktop clients', async () => {
    let osClipboard = 'Baseline';
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => osClipboard,
      writeText: async (text: string) => {
        osClipboard = text;
        return true;
      },
    };

    const srv = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      hostClipboard: provider,
      hostClipboardPollMs: 120,
      daemonConfig: {
        enabled: true,
        downloadDir: os.tmpdir(),
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });

    const validPublicKey = await testPublicKey();
    const macMessages: ServerToClientMessage[] = [];
    const androidMessages: ServerToClientMessage[] = [];

    const connectClient = (
      platform: 'macos' | 'android',
      sink: ServerToClientMessage[]
    ): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString()) as ServerToClientMessage;
          sink.push(msg);
          if (msg.type === 'welcome') resolve(ws);
        });
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'hello',
              pairCode: 'CLIP99',
              visibility: 'nearby-and-paired',
              device: {
                deviceId: platform === 'macos' ? 'aaaa1111bbbb2222' : 'cccc3333dddd4444',
                name: platform === 'macos' ? 'MacBook Pro' : 'Pixel 9 Pro',
                platform,
                model: platform,
                formFactor: platform === 'macos' ? 'laptop' : 'phone',
                publicKey: validPublicKey,
              },
            })
          );
        });
        ws.on('error', reject);
      });

    const macWs = await connectClient('macos', macMessages);
    const androidWs = await connectClient('android', androidMessages);

    try {
      const macWelcome = macMessages.find((m) => m.type === 'welcome');
      const androidWelcome = androidMessages.find((m) => m.type === 'welcome');
      expect(macWelcome?.type === 'welcome' && macWelcome.localDaemon.enabled).toBe(true);
      expect(macWelcome?.type === 'welcome' && macWelcome.localDaemon.clipboardBridge).toBe(true);
      expect(androidWelcome?.type === 'welcome' && androidWelcome.localDaemon.enabled).toBe(false);
      expect(
        androidWelcome?.type === 'welcome' && Boolean(androidWelcome.localDaemon.clipboardBridge)
      ).toBe(false);

      // Wait for initial monitor seed, then simulate external Cmd+C on MacBook
      await new Promise((r) => setTimeout(r, 160));
      osClipboard = 'Background macOS copy';
      await new Promise((r) => setTimeout(r, 220));

      expect(
        macMessages.some(
          (m) => m.type === 'host-clipboard' && m.text === 'Background macOS copy'
        )
      ).toBe(true);
      expect(androidMessages.some((m) => m.type === 'host-clipboard')).toBe(false);

      // Android client attempting set-host-clipboard is ignored; Mac client updates host clipboard without echo
      androidWs.send(JSON.stringify({ type: 'set-host-clipboard', text: 'Spoofed' }));
      await new Promise((r) => setTimeout(r, 80));
      expect(osClipboard).toBe('Background macOS copy');

      macWs.send(JSON.stringify({ type: 'set-host-clipboard', text: 'Beamed from Pixel' }));
      await new Promise((r) => setTimeout(r, 220));
      expect(osClipboard).toBe('Beamed from Pixel');
      expect(
        macMessages.some((m) => m.type === 'host-clipboard' && m.text === 'Beamed from Pixel')
      ).toBe(false);
    } finally {
      macWs.close();
      androidWs.close();
      await srv.close();
    }
  });
});
