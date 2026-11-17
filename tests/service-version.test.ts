// @vitest-environment node
/**
 * The local service identifies its build so a window or app shell can tell
 * whether it is talking to the installed version (field report: a stale
 * server kept answering the macOS app's health check after an update and
 * handed out an old QR without the TLS pin).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';

let server: AirBridgeServerInstance;
let dir: string;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-version-'));
  server = await createAirBridgeServer({
    port: 0, host: '127.0.0.1', mode: 'test', https: false, hostClipboard: false,
    backgroundClipboard: false, enableMdns: false, receivedFolderSettingsPath: null,
    version: '7.8.9',
    daemonConfig: { enabled: true, downloadDir: path.join(dir, 'received'), notifyOnReceive: false },
  });
});
afterAll(async () => {
  await server?.close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('service version', () => {
  it('/api/health reports the service, its version and (to this computer only) its pid', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    const health = await res.json();
    expect(health.service).toBe('AirBridge Warp Server');
    expect(health.version).toBe('7.8.9');
    // The caller is on this machine: the macOS app needs the pid to replace a stale server.
    expect(health.pid).toBe(process.pid);
  });

  it('welcome carries the server version so an old page reloads itself', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no welcome')), 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          device: {
            id: 'version-test-device', name: 'Version test', kind: 'desktop', platform: 'test',
            publicKey: ecdh.getPublicKey().toString('base64url'),
          },
        }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'welcome') { clearTimeout(timer); resolve(msg); }
      });
      ws.on('error', reject);
    });
    ws.close();
    expect(welcome.serverVersion).toBe('7.8.9');
  });
});
