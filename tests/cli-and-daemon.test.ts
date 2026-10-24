import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { createCliBeamSession, type CliBeamSession } from '../src/server/cliSendSession.js';
import { sanitizeFilename } from '../src/server/macIntegration.js';

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
