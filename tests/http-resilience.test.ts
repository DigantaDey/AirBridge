// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { createCliBeamSession, type CliBeamSession } from '../src/server/cliSendSession.js';
import { createMacDaemonConfig, saveBufferToLocalDownloads } from '../src/server/macIntegration.js';
import { PartialReceiveStore } from '../src/server/partialReceive.js';

describe('HTTP, download and filesystem resilience', () => {
  let server: AirBridgeServerInstance;
  let dir: string;
  let base: string;
  let beam: CliBeamSession;
  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-http-safe-'));
    const file = path.join(dir, 'download.bin');
    await fs.promises.writeFile(file, Buffer.alloc(32, 7));
    beam = await createCliBeamSession([file]);
    server = await createAirBridgeServer({
      port: 0, host: '127.0.0.1', mode: 'test', https: false, hostClipboard: false,
      backgroundClipboard: false, enableMdns: false, receivedFolderSettingsPath: null,
      cliSessions: new Map([[beam.token, beam]]),
      daemonConfig: { enabled: true, downloadDir: path.join(dir, 'received'), notifyOnReceive: false },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => { await server?.close(); await fs.promises.rm(dir, { recursive: true, force: true }); });

  it('turns malformed URI metadata into a 400 and keeps the daemon alive', async () => {
    const response = await fetch(`${base}/api/daemon/receive-chunk`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-AirBridge-Name': '%ZZ' },
      body: Buffer.from('data'),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request.' });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('rejects browser cross-origin disk/clipboard access but permits same-host TLS preview origins', async () => {
    const blocked = await fetch(`${base}/api/received-folder`, { headers: { Origin: 'https://another-website.invalid' } });
    expect(blocked.status).toBe(403);
    const allowed = await fetch(`${base}/api/received-folder`, { headers: { Origin: base.replace('http:', 'https:') } });
    expect(allowed.status).toBe(200);
    const blockedWrite = await fetch(`${base}/api/daemon/save`, {
      method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not saved'),
    });
    expect(blockedWrite.status).toBe(403);
    const beamNavigation = await fetch(`${base}/api/beam/${beam.token}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(beamNavigation.status).toBe(200);
  });

  it('rejects cross-site WebSocket upgrades before registering a peer', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: 'https://another-website.invalid' });
      socket.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode ?? 0); socket.terminate(); });
      socket.on('error', () => {});
      socket.on('open', () => { socket.close(); reject(new Error('Cross-site WebSocket was accepted')); });
    });
    expect(status).toBe(403);
    expect(server.hub.getStats().connectedPeers).toBe(0);
  });

  it('uses correct suffix ranges and rejects unsatisfiable, malformed and multi-range requests', async () => {
    const url = `${base}/api/beam/${beam.token}/file/0`;
    for (const range of ['bytes=100-', 'bytes=-0', 'bytes=5-2', 'bytes=0-1,4-5', 'garbage']) {
      const response = await fetch(url, { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */32');
      await response.arrayBuffer();
    }
    const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(3);
    const source = beam.files[0].absPath;
    await fs.promises.rename(source, source + '.moved');
    try { expect((await fetch(url)).status).toBe(404); }
    finally { await fs.promises.rename(source + '.moved', source); }
  });

  it('publishes simultaneous same-name receives without overwriting any verified bytes', async () => {
    const downloadDir = path.join(dir, 'collisions');
    const config = createMacDaemonConfig({ enabled: true, downloadDir, notifyOnReceive: false });
    const payloads = Array.from({ length: 12 }, (_, i) => Buffer.from(`verified file ${i}`));
    const saved = await Promise.all(payloads.map((bytes) => saveBufferToLocalDownloads(config, 'same.bin', bytes)));
    expect(new Set(saved.map((file) => file.savedPath)).size).toBe(payloads.length);
    await Promise.all(saved.map(async (file, i) => expect(await fs.promises.readFile(file.savedPath)).toEqual(payloads[i])));
    expect((await fs.promises.readdir(downloadDir)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('uses the same collision-safe publication for streaming .part files', async () => {
    const config = createMacDaemonConfig({ enabled: true, downloadDir: path.join(dir, 'stream-collisions'), notifyOnReceive: false });
    const store = new PartialReceiveStore(config);
    try {
      const ids = ['1111111111111111', '2222222222222222'];
      await Promise.all(ids.map((transferId, i) => store.writeChunk({ transferId, fileIndex: 0, name: 'stream.bin', size: 1, chunkSize: 16_384, totalChunks: 1 }, 0, Uint8Array.of(i))));
      const results = await Promise.all(ids.map((id) => store.finalize(id, 0)));
      expect(results[0].savedPath).not.toBe(results[1].savedPath);
      expect((await fs.promises.readFile(results[0].savedPath))[0]).toBe(0);
      expect((await fs.promises.readFile(results[1].savedPath))[0]).toBe(1);
    } finally { await store.dispose(); }
  });
});
