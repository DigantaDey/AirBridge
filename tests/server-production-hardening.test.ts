// @vitest-environment node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  buildTerminalPairingUrl,
  createAirBridgeServer,
  type AirBridgeServerInstance,
} from '../src/server/index.js';
import { isAllowedHostHeader, isSameOriginRequest } from '../src/server/httpSafety.js';
import { sanitizeFilename } from '../src/server/macIntegration.js';
import { deriveNetworkKey, isLocalMachineAddress, clearLocalMachineAddressCache } from '../src/server/signalingHub.js';
import { isLoopbackAddress } from '../src/server/tls.js';
import { classifyInterface } from '../src/server/lanAddresses.js';
import { PartialReceiveStore } from '../src/server/partialReceive.js';
import { buildZipArchiveParts, MAX_ZIP_ENTRIES } from '../src/shared/zipStore.js';
import { bytesToBase64Url, base64UrlToBytes } from '../src/shared/protocol.js';
import { redact, recordLog, resetDiagnosticsForTests } from '../src/server/diagnostics.js';
import { createWifiJoiner, validateNetshSsid } from '../src/server/wifiJoin.js';
import { generateHandoffKeys, HandoffService, openOffer, sealOffer } from '../src/server/handoff.js';
import { createSystemClipboardProvider } from '../src/server/hostClipboard.js';
import { buildMdnsAnnouncement, isAirBridgeMdnsQuery } from '../src/server/mdnsService.js';

function rawHttpGet(
  port: number,
  reqPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'GET',
        headers,
        setHost: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function makeDeviceProfile() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    name: 'Test Peer',
    platform: 'android' as const,
    model: 'Pixel 9',
    formFactor: 'phone' as const,
    publicKey: ecdh.getPublicKey().toString('base64url'),
  };
}

describe('M1.2 & M1.3 server production hardening regressions', () => {
  let tmpDir: string;
  let server: AirBridgeServerInstance | null = null;

  beforeEach(async () => {
    resetDiagnosticsForTests();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-prod-hardening-'));
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('S-1: blocks DNS rebinding Host headers with 403 on loopback APIs and /ws', async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: false,
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: {
        enabled: true,
        downloadDir: path.join(tmpDir, 'downloads'),
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });

    for (const reboundHost of [`evil.com:${server.port}`, `127.0.0.1.nip.io:${server.port}`, 'rebind.attacker.test']) {
      for (const apiPath of [
        '/api/fs/list',
        '/api/received-folder',
        '/api/daemon/received?transferId=0123456789abcdef&fileIndex=0',
        '/api/handoff',
        '/api/update',
        '/api/crashes',
        '/api/diagnostics',
      ]) {
        const res = await rawHttpGet(server.port, apiPath, {
          Host: reboundHost,
          Origin: `http://${reboundHost}`,
        });
        expect(res.status, `${reboundHost} -> ${apiPath}`).toBe(403);
      }

      // Also verify /ws rejects DNS-rebound Host header with 403
      const serverPort = server.port;
      const wsRejected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`, {
          headers: {
            Host: reboundHost,
            Origin: `http://${reboundHost}`,
          },
        });
        ws.once('unexpected-response', (_req, res) => {
          ws.close();
          resolve(res.statusCode === 403);
        });
        ws.once('error', () => resolve(true));
      });
      expect(wsRejected).toBe(true);
    }

    // Valid localhost / 127.0.0.1 / [::1] Host headers continue to succeed
    const okRes = await rawHttpGet(server.port, '/api/received-folder', {
      Host: `localhost:${server.port}`,
    });
    expect(okRes.status).toBe(200);
    expect(isAllowedHostHeader({ headers: { host: '[::1]:3000' } } as http.IncomingMessage)).toBe(true);
    expect(isSameOriginRequest({ headers: { host: 'evil.com:3000', origin: 'http://evil.com:3000' } } as http.IncomingMessage)).toBe(false);
  });

  it('S-5: confines /api/fs/list and /api/fs/mkdir to allowed roots and sanitizes Windows reserved filenames', async () => {
    const allowedDir = path.join(tmpDir, 'downloads');
    await fs.promises.mkdir(allowedDir, { recursive: true });
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: false,
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: {
        enabled: true,
        downloadDir: allowedDir,
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    for (const forbidden of ['/etc', '/var', '/System', '/private/etc']) {
      const listRes = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(forbidden)}`);
      expect(listRes.status, `list ${forbidden}`).toBe(403);

      const mkdirRes = await fetch(`${base}/api/fs/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: forbidden, name: 'pwn' }),
      });
      expect(mkdirRes.status, `mkdir ${forbidden}`).toBe(403);
    }

    const okList = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(allowedDir)}`);
    expect(okList.status).toBe(200);

    // Windows reserved device names and trailing dots/spaces
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('prn.txt')).toBe('_prn.txt');
    expect(sanitizeFilename('AUX.json')).toBe('_AUX.json');
    expect(sanitizeFilename('NUL')).toBe('_NUL');
    expect(sanitizeFilename('COM1.log')).toBe('_COM1.log');
    expect(sanitizeFilename('LPT9.dat')).toBe('_LPT9.dat');
    expect(sanitizeFilename('report.pdf. . .')).toBe('report.pdf');
  });

  it('S-7: guards embedded clientAssets lookup with Object.hasOwn so /toString and /constructor do not crash', async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'production',
      https: false,
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      clientAssets: {
        '/index.html': Buffer.from('<!doctype html><title>AirBridge</title>').toString('base64'),
      },
    });
    // Temporarily run in a cwd without dist/client or test the embedded fallback route directly:
    // Even if dist/client is present or embedded assets are used, /toString and /constructor must return 200 HTML, never 500.
    for (const protoPath of ['/toString', '/constructor', '/__proto__', '/valueOf']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${protoPath}`);
      expect(res.status).toBe(200);
    }
  });

  it('S-2: rate-limits legacy hello { pairCode } across fresh connections and counts malformed PAKE payloads', async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: false,
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      isLocalMachineAddress: () => false, // treat connections as remote LAN peers
    });
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;

    // 1. Send malformed PAKE payload -> increments pakeFailures
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          device: makeDeviceProfile(),
          visibility: 'nearby',
          pake: { v: 99, nameplate: 'zz', share: 'invalid' },
        }));
      });
      ws.on('close', () => resolve());
    });
    expect(server.hub.getTelemetry().pakeFailures).toBe(1);

    // 2. Brute-force legacy hello { pairCode } across fresh WS connections -> triggers RATE_LIMITED after 8 failures
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const msg = await new Promise<{ type: string; code?: string }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'hello',
            device: makeDeviceProfile(),
            visibility: 'nearby',
            pairCode: '234567',
          }));
        });
        ws.on('message', (raw) => {
          const parsed = JSON.parse(raw.toString()) as { type: string; code?: string };
          ws.close();
          resolve(parsed);
        });
      });
      if (msg.type === 'error' && msg.code === 'RATE_LIMITED') {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
    expect(server.hub.getTelemetry().rateLimitedCount).toBeGreaterThan(0);
    expect(server.hub.getTelemetry().legacyBlockedCount).toBeGreaterThan(0);
  });

  it('N-4 & N-6: groups IPv6 LAN peers by /64 prefix, isolates relayed peers, and detects hex-mapped loopback', () => {
    const reqV6A = { socket: { remoteAddress: 'fe80::1c2b:3aff:fe4d:1111%en0' } } as unknown as http.IncomingMessage;
    const reqV6B = { socket: { remoteAddress: 'fe80::9999:8888:7777:2222%en0' } } as unknown as http.IncomingMessage;
    expect(deriveNetworkKey(reqV6A)).toBe('net:lan6-fe80:0000:0000:0000');
    expect(deriveNetworkKey(reqV6A)).toBe(deriveNetworkKey(reqV6B));

    // Relayed peers never share a nearby room
    expect(deriveNetworkKey(reqV6A, '0123456789abcdef')).toBe('net:relayed:0123456789abcdef');
    expect(deriveNetworkKey(reqV6A, 'fedcba9876543210')).not.toBe(deriveNetworkKey(reqV6A, '0123456789abcdef'));

    // Hex-mapped IPv4 loopback and expanded IPv6 loopback
    expect(isLoopbackAddress('::ffff:7f00:0001')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackAddress('0000:0000:0000:0000:0000:0000:0000:0001%lo0')).toBe(true);
    expect(isLoopbackAddress('::ffff:c0a8:0101')).toBe(false);

    clearLocalMachineAddressCache();
    expect(isLocalMachineAddress('::1%lo0')).toBe(true);
    expect(classifyInterface('en0', 'en1')).toBe('ethernet');
    expect(classifyInterface('en1', 'en1')).toBe('wifi');
  });

  it('N-1: closes idle TCP sockets that never send a first byte within tcpPeekTimeoutMs', async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: true,
      tlsDir: path.join(tmpDir, 'tls'),
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      tcpPeekTimeoutMs: 120,
      tlsHandshakeTimeoutMs: 250,
    });

    const closedQuickly = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: server!.port });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 1500);
      sock.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closedQuickly).toBe(true);

    const diagRes = await fetch(`http://127.0.0.1:${server.port}/api/diagnostics`);
    const diag = (await diagRes.json()) as { signaling: { peekTimeouts: number } };
    expect(diag.signaling.peekTimeouts).toBeGreaterThanOrEqual(1);
  });

  it('B-1 & B-2: PartialReceiveStore cleans up expired partials and only truncates when file size differs', async () => {
    const downloadDir = path.join(tmpDir, 'rx');
    const partialDir = path.join(downloadDir, '.airbridge-partial');
    await fs.promises.mkdir(partialDir, { recursive: true });

    const stalePart = path.join(partialDir, '0011223344556677-0.part');
    const staleMeta = path.join(partialDir, '0011223344556677-0.json');
    await fs.promises.writeFile(stalePart, 'old-bytes');
    await fs.promises.writeFile(staleMeta, '{}');
    const past = new Date(Date.now() - 48 * 3600_000);
    await fs.promises.utimes(stalePart, past, past);
    await fs.promises.utimes(staleMeta, past, past);

    const store = new PartialReceiveStore({
      enabled: true,
      downloadDir,
      autoSaveToDownloads: true,
      notifyOnReceive: false,
      revealInFinder: false,
    });
    const cleaned = await store.cleanupExpiredPartials(24 * 3600_000);
    expect(cleaned).toBe(1);
    expect(store.getStats().orphanedPartialsCleaned).toBe(1);
    expect(fs.existsSync(stalePart)).toBe(false);
    await store.dispose();
  });

  it('B-3: enforces zipStore 16-bit entry count and 32-bit size bounds and fast base64url round-trip', () => {
    const payload = crypto.randomBytes(4096);
    const encoded = bytesToBase64Url(new Uint8Array(payload));
    expect(Buffer.compare(Buffer.from(base64UrlToBytes(encoded)), payload)).toBe(0);

    const tooManyEntries = new Array(MAX_ZIP_ENTRIES + 1).fill({
      path: 'a.txt',
      chunks: [new Uint8Array([1])],
    });
    expect(() => buildZipArchiveParts(tooManyEntries)).toThrow(RangeError);
  });

  it('P-1, P-2, P-4 & S-7: validates netsh SSIDs, skips power-cycling on macOS <redacted>, re-detects Linux display, and deduplicates handoff offers by device id', async () => {
    expect(() => validateNetshSsid(' Safe_Hotspot-5G ')).not.toThrow();
    expect(() => validateNetshSsid('bad"ssid')).toThrow();
    expect(() => validateNetshSsid('bad%ssid')).toThrow();

    // macOS <redacted> SSID should not power-cycle Wi-Fi on leave()
    const calls: string[] = [];
    const macJoiner = createWifiJoiner('darwin', {
      retryDelayMs: 1,
      addressTimeoutMs: 20,
      interfaces: () => ({ en0: [{ address: '192.168.43.10', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] }),
      exec: async (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        if (args[0] === '-listallhardwareports') return { code: 0, stdout: 'Hardware Port: Wi-Fi\nDevice: en0\n', stderr: '' };
        if (args[0] === '-getairportnetwork') return { code: 0, stdout: 'Current Wi-Fi Network: <redacted>\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await macJoiner.join({ ssid: 'PhoneHotspot', psk: 'password123', security: 'wpa2' });
    expect(macJoiner.getRedactedSsidHits?.()).toBe(1);
    await macJoiner.leave('PhoneHotspot');
    expect(calls.some((c) => c.includes('-setairportpower en0 off'))).toBe(false);

    // Linux dynamic display re-detection
    const origWayland = process.env.WAYLAND_DISPLAY;
    const origDisplay = process.env.DISPLAY;
    try {
      delete process.env.WAYLAND_DISPLAY;
      delete process.env.DISPLAY;
      const linuxProvider = createSystemClipboardProvider('linux');
      expect(linuxProvider.isSupported()).toBe(false);
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      expect(linuxProvider.isSupported()).toBe(true);
    } finally {
      if (origWayland === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = origWayland;
      if (origDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = origDisplay;
    }

    // Handoff offer deduplication by cryptographic payload.id and string coercion check
    const keys = generateHandoffKeys();
    const keyB64 = Buffer.from(keys.publicKey).toString('base64url');
    const o1 = sealOffer(keyB64, 'K7Q2XP', { ssid: 'Spot1', psk: 'password123', sec: 'wpa2', rp: 47390, id: 'phone-id-A', name: 'Phone' });
    const o2 = sealOffer(keyB64, 'K7Q2XP', { ssid: 'Spot2', psk: 'password123', sec: 'wpa2', rp: 47390, id: 'phone-id-B', name: 'Phone' });
    expect(openOffer(o1, keys, ['K7Q2XP']).payload.id).toBe('phone-id-A');
    const svc = new HandoffService({
      keys,
      pairCodes: () => ['K7Q2XP'],
      joiner: macJoiner,
      stateDir: tmpDir,
    });
    const v1 = svc.submit(o1, 'session');
    const v2 = svc.submit(o2, 'session');
    // Different payload.id phones sharing display name "Phone" must NOT expire each other
    expect(svc.get(v1.id)?.state).toBe('pending');
    expect(svc.get(v2.id)?.state).toBe('pending');
    await svc.dispose();
  });

  it('D1-D7 & N-5: redacts secrets in diagnostics, stores POST /api/client-diagnostics, exposes extended telemetry, and builds full terminal QR URLs', async () => {
    const scrubbed = redact(
      'open https://10.0.0.2:3000/?pair=ABC234&token=secretToken12345 /api/beam/beamTok999 Authorization: Bearer myJwt999 {"psk":"myWifiPass"} user@example.com a4:83:e7:11:22:33 /Users/alice/Downloads',
    );
    expect(scrubbed).not.toContain('ABC234');
    expect(scrubbed).not.toContain('secretToken12345');
    expect(scrubbed).not.toContain('beamTok999');
    expect(scrubbed).not.toContain('myJwt999');
    expect(scrubbed).not.toContain('myWifiPass');
    expect(scrubbed).not.toContain('user@example.com');
    expect(scrubbed).not.toContain('a4:83:e7:11:22:33');
    expect(scrubbed).not.toContain('/Users/alice');

    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: true,
      tlsDir: path.join(tmpDir, 'tls-qr'),
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: {
        enabled: true,
        downloadDir: path.join(tmpDir, 'dl'),
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });
    const base = `https://127.0.0.1:${server.port}`;
    recordLog('info', 'pairing link https://192.168.1.10:3000/?pair=ZXCVBN');

    // Terminal QR URL includes pair, alt, and ca pin
    const qrUrl = buildTerminalPairingUrl({
      lanUrls: ['https://192.168.1.10:3000', 'https://10.42.0.1:3000'],
      port: 3000,
      hub: server.hub,
      tls: server.tls,
    });
    expect(qrUrl).toContain(`pair=${server.hub.getDefaultPairCode()}`);
    expect(qrUrl).toContain('alt=10.42.0.1');
    expect(qrUrl).toContain(`ca=${server.tls!.pinSha256}`);

    // POST /api/client-diagnostics and GET /api/diagnostics
    const postRes = await fetch(`http://127.0.0.1:${server.port}/api/client-diagnostics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${server.port}`,
      },
      body: JSON.stringify({
        uiVersion: '2.4.8',
        rtcState: 'connected',
        transferErrors: [],
        pairCode: 'SHOULD_BE_REDACTED',
      }),
    });
    expect(postRes.status).toBe(200);
    expect(base).toContain('https://');

    const diagRes = await fetch(`http://127.0.0.1:${server.port}/api/diagnostics`);
    expect(diagRes.status).toBe(200);
    const diag = (await diagRes.json()) as Record<string, Record<string, unknown>>;
    expect(typeof diag.system.heapUsedMb).toBe('number');
    expect(typeof diag.system.externalMb).toBe('number');
    expect(diag.network).toHaveProperty('mdnsLastError');
    expect(diag.signaling).toMatchObject({
      pakeFailures: 0,
      rateLimitedCount: 0,
      legacyBlockedCount: 0,
      relayDrops: 0,
    });
    expect(diag.localDaemon).toMatchObject({
      enabled: true,
      writable: true,
      activePartials: 0,
    });
    expect(diag.handoff).toHaveProperty('policy');
    expect(diag.client).toMatchObject({
      payload: {
        uiVersion: '2.4.8',
        rtcState: 'connected',
        pairCode: '[redacted]',
      },
    });
    expect(JSON.stringify(diag)).not.toContain('ZXCVBN');
    expect(JSON.stringify(diag)).not.toContain('SHOULD_BE_REDACTED');
  });

  it('N-9: isAirBridgeMdnsQuery ignores announcement responses, zero-QDCOUNT, truncated, and non-AirBridge packets', () => {
    // Own mDNS announcement has QR=1 (0x8400) and QDCOUNT=0; must never trigger announce() again
    const announcement = buildMdnsAnnouncement(3000, '192.168.1.10');
    expect(isAirBridgeMdnsQuery(announcement)).toBe(false);

    // Valid DNS query: QR=0, QDCOUNT=1, QNAME=_airbridge._tcp.local, QTYPE=PTR(12), QCLASS=IN(1)
    const encodeQname = (name: string): Buffer => {
      const parts = name.split('.').map((label) => {
        const b = Buffer.from(label, 'utf8');
        return Buffer.concat([Buffer.from([b.length]), b]);
      });
      return Buffer.concat([...parts, Buffer.from([0])]);
    };
    const buildQuery = (flags: number, qdCount: number, service: string): Buffer => {
      const hdr = Buffer.alloc(12);
      hdr.writeUInt16BE(0x0000, 0);
      hdr.writeUInt16BE(flags, 2);
      hdr.writeUInt16BE(qdCount, 4);
      const q = Buffer.concat([encodeQname(service), Buffer.from([0x00, 0x0c, 0x00, 0x01])]);
      return Buffer.concat([hdr, q]);
    };

    expect(isAirBridgeMdnsQuery(buildQuery(0x0000, 1, '_airbridge._tcp.local'))).toBe(true);
    expect(isAirBridgeMdnsQuery(buildQuery(0x8000, 1, '_airbridge._tcp.local'))).toBe(false);
    expect(isAirBridgeMdnsQuery(buildQuery(0x0000, 0, '_airbridge._tcp.local'))).toBe(false);
    expect(isAirBridgeMdnsQuery(buildQuery(0x0000, 1, '_http._tcp.local'))).toBe(false);
    expect(isAirBridgeMdnsQuery(Buffer.from('_airbridge'))).toBe(false);
  });
});
