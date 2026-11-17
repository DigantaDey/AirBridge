// @vitest-environment node
/**
 * This-computer-only endpoints used by the desktop UI and the macOS app:
 * the shell event stream, "Copy diagnostics" and self-update status.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { recordLog, redact } from '../src/server/diagnostics.js';
import { emitShellEvent, shellSubscriberCount } from '../src/server/shellEvents.js';

let server: AirBridgeServerInstance;
let dir: string;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-local-'));
  server = await createAirBridgeServer({
    port: 0, host: '127.0.0.1', mode: 'test', https: false, hostClipboard: false,
    backgroundClipboard: false, enableMdns: false, receivedFolderSettingsPath: null,
    reverseConnect: false, version: '3.2.1',
    daemonConfig: { enabled: true, downloadDir: path.join(dir, 'received'), notifyOnReceive: false },
  });
});
afterAll(async () => {
  await server?.close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function openStream(headers: Record<string, string>, query = ''): Promise<{ status: number; read: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: `/api/local/events${query}`, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('error', () => {});
      resolve({ status: res.statusCode ?? 0, read: () => buf, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('shell event stream', () => {
  it('requires the shell header (web pages cannot subscribe)', async () => {
    const s = await openStream({});
    expect(s.status).toBe(400);
    s.close();
  });

  it('rejects cross-origin requests', async () => {
    const s = await openStream({ 'X-AirBridge-Shell': '1', Origin: 'https://evil.example' });
    expect(s.status).toBe(403);
    s.close();
  });

  it('greets the app with version + pid and delivers subscribed events', async () => {
    const s = await openStream({ 'X-AirBridge-Shell': '1' }, '?capabilities=notification,lifecycle');
    expect(s.status).toBe(200);
    await until(() => s.read().includes('event: hello'));
    expect(s.read()).toContain(`"version":"3.2.1"`);
    expect(s.read()).toContain(`"pid":${process.pid}`);
    expect(shellSubscriberCount('notification')).toBe(1);
    expect(emitShellEvent({ type: 'notification', title: 'T', body: 'B' })).toBe(true);
    await until(() => s.read().includes('event: notification'));
    s.close();
    await until(() => shellSubscriberCount() === 0);
    expect(emitShellEvent({ type: 'notification', title: 'T', body: 'B' })).toBe(false);
  });
});

describe('diagnostics', () => {
  it('redacts pair codes and terminal colours', () => {
    expect(redact('\u001b[32mopen https://10.0.0.2:3000/?pair=ABC234&ca=xyz\u001b[0m')).toBe('open https://10.0.0.2:3000/?pair=[redacted]&ca=xyz');
  });

  it('reports the service state for support without secrets', async () => {
    recordLog('info', 'scan https://192.168.1.5:3000/#join?pair=QWERTY');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/diagnostics`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.app).toMatchObject({ version: '3.2.1', pid: process.pid });
    expect(d.network).toMatchObject({ port: server.port, protocol: 'http', reverseConnect: 'disabled' });
    expect(Array.isArray(d.network.interfaces)).toBe(true);
    expect(d.update).toEqual({ supported: false });
    expect(d.eventLoop).toHaveProperty('stalls');
    const text = JSON.stringify(d);
    expect(text).toContain('pair=[redacted]');
    expect(text).not.toContain('QWERTY');
    expect(text).not.toContain(server.hub.getDefaultPairCode());
  });

  it('accepts a same-origin low-battery notification request and rejects cross-origin posts', async () => {
    const url = `http://127.0.0.1:${server.port}/api/local/notification`;
    const valid = await fetch(url, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${server.port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Phone battery is low', body: '18% battery. Put the phone on charge soon.' }),
    });
    expect(valid.status).toBe(202);
    expect(await valid.json()).toEqual({ accepted: true });
    const rejected = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Injected', body: 'No' }),
    });
    expect(rejected.status).toBe(403);
  });

  it('update status explains when self-update is not available', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/update`);
    expect(await res.json()).toMatchObject({ supported: false, current: '3.2.1' });
    const check = await fetch(`http://127.0.0.1:${server.port}/api/update/check`, { method: 'POST' });
    expect(check.status).toBe(404);
  });
});
