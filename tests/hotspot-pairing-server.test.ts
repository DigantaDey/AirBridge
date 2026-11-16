// @vitest-environment node
/**
 * Server-side consistency for hotspot pairing, with mocked interfaces of the
 * reported MacBook (campus en0 + phone hotspot en7 + VPN/VM noise):
 *  - QR endpoint ⊂ advertised endpoints ⊂ TLS certificate SANs
 *  - welcome, `network`, /api/health and the QR all use the same set
 *  - joining the hotspot later / a hotspot subnet change re-issues the leaf
 *    (same CA ⇒ same QR pin) and pushes the new endpoints to clients
 *  - a user-provided certificate is never re-issued; uncovered addresses are
 *    withheld instead of advertised.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { NetworkInterfaceInfo } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { type InterfaceMap } from '../src/server/lanAddresses.js';
import { certificateCoversIp, chainAnchorPinSha256, resolveTlsMaterial, splitPemChain } from '../src/server/tls.js';
import { buildPairingUrl } from '../src/client/engine/pairingUrl.js';

const v4 = (address: string, netmask = '255.255.255.0', internal = false): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: 'IPv4',
  mac: '02:00:00:00:00:01',
  internal,
  cidr: `${address}/24`,
});

function macInterfaces(hotspot: string | null): InterfaceMap {
  return {
    lo0: [v4('127.0.0.1', '255.0.0.0', true)],
    en0: [v4('10.205.95.167', '255.255.252.0')],
    ...(hotspot ? { en7: [v4(hotspot)] } : {}),
    utun3: [v4('100.96.0.7', '255.255.255.255')],
    bridge100: [v4('192.168.64.1')],
    docker0: [v4('172.17.0.1', '255.255.0.0')],
  };
}

function device() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    name: 'Pixel',
    platform: 'android' as const,
    model: 'Pixel 9',
    formFactor: 'phone' as const,
    publicKey: ecdh.getPublicKey().toString('base64url'),
  };
}

interface Session {
  ws: WebSocket;
  messages: Array<Record<string, any>>;
  next: (type: string, timeoutMs?: number) => Promise<Record<string, any>>;
}

async function connect(server: AirBridgeServerInstance): Promise<Session> {
  const ws = new WebSocket(`wss://127.0.0.1:${server.port}/ws`, { ca: server.tls!.caCertPem });
  const messages: Array<Record<string, any>> = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', device: device(), visibility: 'nearby' }));
  const next = async (type: string, timeoutMs = 5_000) => {
    const start = Date.now();
    for (;;) {
      const index = messages.findIndex((m) => m.type === type);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      if (Date.now() - start > timeoutMs) throw new Error(`no ${type} message`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, messages, next };
}

function getJson(server: AirBridgeServerInstance, pathname: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(`https://127.0.0.1:${server.port}${pathname}`, { ca: server.tls!.caCertPem, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

function anchorPin(chain: string): string {
  const pems = splitPemChain(chain);
  const der = Buffer.from(pems[pems.length - 1]!.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('base64url');
}

describe('hotspot pairing: advertised endpoints, QR and certificate stay consistent', () => {
  let tmp: string;
  let interfaces: InterfaceMap;
  let server: AirBridgeServerInstance;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-hotspot-'));
    interfaces = macInterfaces('10.42.61.23');
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      https: true,
      tlsDir: path.join(tmp, 'certs'),
      hostClipboard: false,
      getNetworkInterfaces: () => interfaces,
    });
  });

  afterAll(async () => {
    await server?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('advertises only reachable-looking addresses, all covered by the certificate', () => {
    const port = server.port;
    expect(server.lanUrls).toEqual([`https://10.205.95.167:${port}`, `https://10.42.61.23:${port}`]);
    expect(server.lanEndpoints.map((e) => e.interface)).toEqual(['en0', 'en7']);
    for (const endpoint of server.lanEndpoints) {
      expect(certificateCoversIp(server.tls!.cert, endpoint.address)).toBe(true);
    }
    expect(server.uncoveredLanAddresses).toEqual([]);
    // VPN / VM / Docker addresses are neither advertised nor needed in SANs.
    expect(server.lanUrls.join(' ')).not.toMatch(/100\.96\.0\.7|192\.168\.64\.1|172\.17\.0\.1/);
  });

  it('welcome, /api/health and the QR agree; QR hosts ⊂ advertised ⊂ SANs; pin = served CA', async () => {
    const session = await connect(server);
    try {
      const welcome = await session.next('welcome');
      expect(welcome.lanUrls).toEqual(server.lanUrls);
      expect(welcome.lanEndpoints.map((e: { url: string }) => e.url)).toEqual(server.lanUrls);
      expect(welcome.tlsPin).toBe(anchorPin(server.tls!.cert));
      expect(welcome.tlsPin).toBe(chainAnchorPinSha256(server.tls!.cert));
      expect(welcome.tlsPin).toBe(anchorPin(server.tls!.caCertPem!));

      const health = await getJson(server, '/api/health');
      expect(health.lanEndpoints.map((e: { url: string }) => e.url)).toEqual(server.lanUrls);
      expect(health.tlsPin).toBe(welcome.tlsPin);

      const qr = new URL(
        buildPairingUrl({
          pairCode: welcome.pairCode,
          lanUrls: welcome.lanUrls,
          pageOrigin: `https://localhost:${server.port}`,
          pageHostname: 'localhost',
          tlsPin: welcome.tlsPin,
        })
      );
      const qrHosts = [qr.hostname, ...(qr.searchParams.get('alt') ?? '').split(',').filter(Boolean)];
      expect(qrHosts.sort()).toEqual(['10.205.95.167', '10.42.61.23']);
      for (const host of qrHosts) {
        expect(welcome.lanUrls).toContain(`https://${host}:${server.port}`);
        expect(certificateCoversIp(server.tls!.cert, host)).toBe(true);
      }
      expect(qr.searchParams.get('ca')).toBe(welcome.tlsPin);
    } finally {
      session.ws.close();
    }
  });

  it('hotspot subnet change: leaf re-issued for the new address, same CA pin, clients told', async () => {
    const session = await connect(server);
    try {
      const welcome = await session.next('welcome');
      const pinBefore = welcome.tlsPin;
      // Hotspot toggled: new subnet, new address for en7.
      interfaces = macInterfaces('10.42.99.17');
      expect(certificateCoversIp(server.tls!.cert, '10.42.99.17')).toBe(false);
      await expect(server.refreshNetwork()).resolves.toBe(true);
      const update = await session.next('network');
      const port = server.port;
      expect(update.lanUrls).toEqual([`https://10.205.95.167:${port}`, `https://10.42.99.17:${port}`]);
      expect(update.lanUrls).not.toContain(`https://10.42.61.23:${port}`);
      expect(update.tlsPin).toBe(pinBefore);
      expect(certificateCoversIp(server.tls!.cert, '10.42.99.17')).toBe(true);
      // New TLS connections are served the re-issued leaf.
      const health = await getJson(server, '/api/health');
      expect(health.lanEndpoints.map((e: { address: string }) => e.address)).toContain('10.42.99.17');
      // Nothing changed → no broadcast.
      await expect(server.refreshNetwork()).resolves.toBe(false);
    } finally {
      session.ws.close();
    }
  });

  it('joining the hotspot after start (late interface) becomes advertisable', async () => {
    interfaces = macInterfaces(null);
    await server.refreshNetwork();
    expect(server.lanUrls).toEqual([`https://10.205.95.167:${server.port}`]);
    interfaces = macInterfaces('10.42.61.23');
    await expect(server.refreshNetwork()).resolves.toBe(true);
    expect(server.lanUrls).toContain(`https://10.42.61.23:${server.port}`);
    expect(certificateCoversIp(server.tls!.cert, '10.42.61.23')).toBe(true);
  });
});

describe('hotspot pairing: provided certificate is never re-issued', () => {
  it('withholds addresses the provided certificate does not cover', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-provided-'));
    try {
      // A certificate issued for the campus address only.
      const material = await resolveTlsMaterial({ tlsDir: path.join(tmp, 'gen'), lanAddresses: ['10.205.95.167'] }, {});
      const certPath = path.join(tmp, 'cert.pem');
      const keyPath = path.join(tmp, 'key.pem');
      fs.writeFileSync(certPath, material.cert);
      fs.writeFileSync(keyPath, material.key);
      const server = await createAirBridgeServer({
        port: 0,
        host: '127.0.0.1',
        mode: 'test',
        enableMdns: false,
        https: true,
        tlsCertPath: certPath,
        tlsKeyPath: keyPath,
        hostClipboard: false,
        getNetworkInterfaces: () => macInterfaces('10.42.61.23'),
      });
      try {
        expect(server.lanUrls).toEqual([`https://10.205.95.167:${server.port}`]);
        expect(server.uncoveredLanAddresses).toEqual(['10.42.61.23']);
        await server.refreshNetwork();
        expect(server.tls!.cert).toBe(material.cert);
      } finally {
        await server.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
