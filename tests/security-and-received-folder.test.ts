import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { createCliBeamSession } from '../src/server/cliSendSession.js';
import { sanitizeDeviceProfile } from '../src/server/signalingHub.js';
import { isValidFileManifest, CHUNK_SIZE } from '../src/client/engine/warpClient.js';
import { bytesToBase64Url } from '../src/shared/protocol.js';
import { buildZipArchiveParts } from '../src/shared/zipStore.js';

async function validPublicKey(): Promise<string> {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
}
const device = async (name: string) => ({
  name, platform: 'android', model: 'Pixel', formFactor: 'phone', publicKey: await validPublicKey(), deviceId: '0123456789abcdef',
});

describe('security hardening', () => {
  let server: AirBridgeServerInstance;
  const sockets: WebSocket[] = [];
  afterAll(async () => { sockets.forEach((s) => s.close()); await server?.close(); });

  async function startServer() {
    server = await createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false, hostClipboard: false, receivedFolderSettingsPath: null });
    return `ws://127.0.0.1:${server.port}/ws`;
  }
  function connect(url: string, dev: unknown, messages: unknown[]): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); sockets.push(ws);
      ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', device: dev, visibility: 'nearby' })));
      ws.on('message', (raw) => { try { if ((JSON.parse(raw.toString()) as { type: string }).type === 'welcome') resolve(ws); } catch { /* ignore */ } });
      ws.on('error', reject);
    });
  }

  it('validates ECDH public keys in device profiles', async () => {
    expect(sanitizeDeviceProfile({ name: 'x', platform: 'android', model: 'm', formFactor: 'phone', publicKey: 'AAAA' })).toBeNull();
    expect(sanitizeDeviceProfile({ name: 'x', platform: 'android', model: 'm', formFactor: 'phone', publicKey: await validPublicKey() })?.name).toBe('x');
  });

  it('rejects invalid hello profiles and plaintext control injection, and rate-limits pair guessing', async () => {
    const url = await startServer();
    // Invalid public key -> INVALID_DEVICE
    const badMessages: unknown[] = [];
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url); sockets.push(ws);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', device: { name: 'evil', publicKey: 'AAAA' }, visibility: 'nearby' })));
      ws.on('message', (raw) => { badMessages.push(JSON.parse(raw.toString())); resolve(); });
      ws.on('error', () => resolve());
    });
    expect(JSON.stringify(badMessages)).toContain('INVALID_DEVICE');

    const aMsgs: unknown[] = []; const bMsgs: unknown[] = [];
    const a = await connect(url, await device('A'), aMsgs);
    await connect(url, await device('B'), bMsgs);
    const bWelcome = bMsgs.find((m) => (m as { type: string }).type === 'welcome') as { peerId: string };
    a.send(JSON.stringify({ type: 'transfer-control', to: bWelcome.peerId, envelope: { encrypted: false, payload: { kind: 'clipboard-beam', beamId: 'x', text: 'injected', contentType: 'text', timestamp: 1 } } }));
    await new Promise((r) => setTimeout(r, 150));
    expect(JSON.stringify(bMsgs)).not.toContain('injected');
    expect(JSON.stringify(aMsgs)).toContain('ENCRYPTION_REQUIRED');

    for (let i = 0; i < 7; i++) a.send(JSON.stringify({ type: 'join-pair', pairCode: 'ZZZZZZ' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(JSON.stringify(aMsgs)).toContain('RATE_LIMITED');
  });

  it('rejects hostile file manifests and zip path traversal entries', () => {
    const good = [{ index: 0, name: 'a.bin', size: CHUNK_SIZE * 2, mimeType: 'application/octet-stream', totalChunks: 2, chunkSize: CHUNK_SIZE }];
    expect(isValidFileManifest(good, CHUNK_SIZE * 2)).toBe(true);
    // Declared chunks inconsistent with size (pre-consent memory exhaustion vector)
    expect(isValidFileManifest([{ ...good[0], totalChunks: 1_000_000 }], CHUNK_SIZE * 2)).toBe(false);
    expect(isValidFileManifest(good, 123)).toBe(false);
    expect(isValidFileManifest([{ ...good[0], chunkSize: 1 }], CHUNK_SIZE * 2)).toBe(false);
    const zip = Buffer.concat(buildZipArchiveParts([{ path: '../../evil.txt', chunks: [new Uint8Array([65])] }]).map((p) => Buffer.from(p)));
    expect(zip.toString('latin1')).not.toContain('../evil.txt');
    expect(zip.toString('latin1')).toContain('evil.txt');
  });

  it('expires CLI beam sessions', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-sec-'));
    const file = path.join(tmp, 'f.txt'); await fs.promises.writeFile(file, 'secret');
    const session = await createCliBeamSession([file]);
    session.expiresAt = Date.now() - 1;
    const sessions = new Map([[session.token, session]]);
    const srv = await createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false, hostClipboard: false, cliSessions: sessions, receivedFolderSettingsPath: null });
    try {
      const resp = await fetch(`http://127.0.0.1:${srv.port}/api/beam/${session.token}/file/0`);
      expect(resp.status).toBe(404);
      expect(session.token.length).toBeGreaterThanOrEqual(40);
    } finally { await srv.close(); await fs.promises.rm(tmp, { recursive: true, force: true }); }
  });
});

describe('received-files folder setting', () => {
  it('changes the save folder over loopback, saves there, and only opens paths inside it', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-folder-'));
    const first = path.join(tmp, 'first'); const second = path.join(tmp, 'second');
    const opened: string[] = [];
    const srv = await createAirBridgeServer({
      port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false, hostClipboard: false,
      receivedFolderSettingsPath: path.join(tmp, 'settings.json'),
      openFolder: async (p) => { opened.push(p); },
      daemonConfig: { enabled: true, downloadDir: first, autoSaveToDownloads: true, notifyOnReceive: false },
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      let resp = await fetch(`${base}/api/received-folder`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ downloadDir: 'relative/path' }) });
      expect(resp.status).toBe(400);
      resp = await fetch(`${base}/api/received-folder`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ downloadDir: second }) });
      expect(resp.status).toBe(200);
      expect(((await resp.json()) as { downloadDir: string }).downloadDir).toBe(second);
      expect(JSON.parse(await fs.promises.readFile(path.join(tmp, 'settings.json'), 'utf8')).downloadDir).toBe(second);

      resp = await fetch(`${base}/api/daemon/save`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-AirBridge-Filename': encodeURIComponent('photo.jpg') }, body: Buffer.from('jpeg-bytes') });
      expect(resp.status).toBe(200);
      expect(await fs.promises.readFile(path.join(second, 'photo.jpg'), 'utf8')).toBe('jpeg-bytes');

      resp = await fetch(`${base}/api/received-folder/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.join(second, 'photo.jpg') }) });
      expect(resp.status).toBe(200); expect(opened).toEqual([path.join(second, 'photo.jpg')]);
      resp = await fetch(`${base}/api/received-folder/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/etc' }) });
      expect(resp.status).toBe(400);
    } finally { await srv.close(); await fs.promises.rm(tmp, { recursive: true, force: true }); }
  });
});
