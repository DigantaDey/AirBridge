// @vitest-environment node
/**
 * Reverse connections (computer → phone) for configurations where the phone
 * cannot reach the computer: inbound firewall, VPN, phone routing over mobile
 * data. Covers target discovery parsers, the dialer's safety rules/backoff,
 * and the real server pipeline: the server dials a "phone" listener, the
 * phone side runs TLS as the *client* pinned to the server CA, upgrades /ws
 * and receives `welcome` — and the dialled peer never counts as this machine.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import {
  ReverseConnector,
  gatewayTargets,
  isDialableAddress,
  isReversePeer,
  parseAvahiBrowse,
  parseDnsSdBrowse,
  parseDnsSdLookup,
  parseIpRouteDefaults,
  parseNetstatDefaults,
  parseProcNetRoute,
  parseWindowsRoutePrint,
  type ReverseTarget,
} from '../src/server/reverseConnect.js';
import { REVERSE_CONNECT_PORT } from '../src/shared/protocol.js';

describe('gateway discovery', () => {
  it('parses macOS netstat (phone hotspot = default gateway), skipping VPN tunnels', () => {
    const out = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            172.20.10.1        UGScg                 en0
default            10.8.0.1           UGScIg              utun4
default            link#22            UCSIg           bridge100      !
127                127.0.0.1          UCS                   lo0
172.20.10/28       link#11            UCS                   en0      !`;
    expect(parseNetstatDefaults(out)).toEqual([{ address: '172.20.10.1', interface: 'en0' }]);
  });

  it('parses Linux ip route and /proc/net/route', () => {
    expect(parseIpRouteDefaults('default via 10.42.0.1 dev wlan0 proto dhcp metric 600\ndefault via 192.168.1.1 dev docker0\n'))
      .toEqual([{ address: '10.42.0.1', interface: 'wlan0' }]);
    const proc = 'Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t01002A0A\t0003\nwlan0\t00002A0A\t00000000\t0001\n';
    expect(parseProcNetRoute(proc)).toEqual([{ address: '10.42.0.1', interface: 'wlan0' }]);
  });

  it('parses Windows route print', () => {
    const out = `IPv4 Route Table
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0     192.168.43.1   192.168.43.20     35
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331`;
    expect(parseWindowsRoutePrint(out)).toEqual([{ address: '192.168.43.1', interface: '192.168.43.20' }]);
  });

  it('never targets public, loopback or link-local gateways', () => {
    expect(isDialableAddress('8.8.8.8')).toBe(false);
    expect(isDialableAddress('127.0.0.1')).toBe(false);
    expect(isDialableAddress('169.254.1.1')).toBe(false);
    expect(isDialableAddress('192.168.43.1')).toBe(true);
    expect(isDialableAddress('100.64.0.1')).toBe(true);
    expect(parseIpRouteDefaults('default via 203.0.113.1 dev eth0')).toEqual([]);
  });

  it('builds targets for the reverse port', () => {
    expect(gatewayTargets([{ address: '172.20.10.1', interface: 'en0' }], REVERSE_CONNECT_PORT, { en0: [] }))
      .toEqual([{ address: '172.20.10.1', port: 47390, source: 'gateway' }]);
  });
});

describe('mDNS discovery of phones', () => {
  it('parses dns-sd browse + lookup', () => {
    const browse = `Browsing for _airbridge-rv._tcp
DATE: ---Mon 16 Nov 2026---
12:00:00.000  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
12:00:00.100  Add        2  14 local.               _airbridge-rv._tcp.  AirBridge-ab12cd`;
    expect(parseDnsSdBrowse(browse)).toEqual(['AirBridge-ab12cd']);
    const lookup = `Lookup AirBridge-ab12cd._airbridge-rv._tcp.local
12:00:00.200  AirBridge-ab12cd._airbridge-rv._tcp.local. can be reached at Android-3.local.:47390 (interface 14)
 v=1 a=192.168.1.23,10.0.0.5`;
    expect(parseDnsSdLookup(lookup)).toEqual({ port: 47390, addresses: ['192.168.1.23', '10.0.0.5'] });
  });

  it('parses avahi-browse resolved records', () => {
    const out = '+;wlan0;IPv4;AirBridge-ab12cd;_airbridge-rv._tcp;local\n=;wlan0;IPv4;AirBridge-ab12cd;_airbridge-rv._tcp;local;Android.local;192.168.1.23;47390;"v=1" "a=192.168.1.23"\n';
    expect(parseAvahiBrowse(out)).toEqual([{ port: 47390, addresses: ['192.168.1.23'] }]);
  });
});

describe('ReverseConnector', () => {
  const fakeSocket = () => {
    const s = new net.Socket();
    return s;
  };

  it('dials each target once, skips connected/local/public, backs off on failure', async () => {
    let now = 0;
    const dialled: string[] = [];
    const injected: net.Socket[] = [];
    const connector = new ReverseConnector({
      targets: () => [
        { address: '172.20.10.1', port: 47390, source: 'gateway' },
        { address: '172.20.10.1', port: 47390, source: 'recent' }, // duplicate
        { address: '192.168.1.50', port: 47390, source: 'mdns' }, // already connected
        { address: '192.168.1.9', port: 47390, source: 'mdns' }, // this machine
        { address: '8.8.8.8', port: 47390, source: 'mdns' }, // public: never
        { address: '10.0.0.7', port: 47390, source: 'mdns' }, // refuses
      ],
      isConnectedFrom: (a) => a === '192.168.1.50',
      isLocalAddress: (a) => a === '192.168.1.9',
      inject: (s) => injected.push(s),
      connect: async (address) => {
        dialled.push(address);
        if (address === '10.0.0.7') throw new Error('ECONNREFUSED');
        return fakeSocket();
      },
      intervalMs: 1000,
      now: () => now,
    });
    await connector.tick();
    expect(dialled.sort()).toEqual(['10.0.0.7', '172.20.10.1']);
    expect(injected).toHaveLength(1);
    expect(isReversePeer(injected[0]!)).toBe(true);

    // Live session: not re-dialled. Failed target: backoff.
    dialled.length = 0;
    now = 500;
    await connector.tick();
    expect(dialled).toEqual([]);
    now = 1001;
    await connector.tick();
    expect(dialled).toEqual(['10.0.0.7']);
    dialled.length = 0;
    now = 2000; // second failure → 2 s backoff from t=1001
    await connector.tick();
    expect(dialled).toEqual([]);
    connector.reset(); // network changed
    await connector.tick();
    expect(dialled).toEqual(['10.0.0.7']);

    // Phone closed the session immediately (busy / other computer): retry later, not in a tight loop.
    dialled.length = 0;
    injected[0]!.destroy();
    await new Promise((r) => setImmediate(r));
    now = 2500;
    await connector.tick();
    expect(dialled).not.toContain('172.20.10.1');
    now = 4000;
    await connector.tick();
    expect(dialled).toContain('172.20.10.1');
    connector.stop();
  });
});

describe('server pipeline over a reverse connection', () => {
  let server: AirBridgeServerInstance | null = null;
  let phone: net.Server | null = null;
  let tmp = '';
  afterEach(async () => {
    await server?.close();
    phone?.close();
    server = null;
    phone = null;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('phone listener receives the server, runs pinned TLS as client and gets welcome', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reverse-'));
    // Phone: listens, accepts the computer's connection, uses it like a dialled one.
    const welcome = new Promise<{ pairCode: string; ws: WebSocket; authorized: boolean }>((resolve, reject) => {
      phone = net.createServer((raw) => {
        const secure = tls.connect({
          socket: raw,
          ca: server!.tls!.caCertPem,
          servername: undefined,
          checkServerIdentity: (_host, cert) =>
            // Same check the Android client makes: the IP SAN for the address it reached.
            /IP Address:127\.0\.0\.1/.test(cert.subjectaltname ?? '') ? undefined : new Error(`SAN ${cert.subjectaltname}`),
        });
        secure.once('secureConnect', () => {
          const ws = new WebSocket(`wss://127.0.0.1:${server!.port}/ws`, { createConnection: () => secure });
          ws.on('open', () => ws.send(JSON.stringify({
            type: 'hello',
            device: {
              name: 'Reverse Phone', platform: 'android', model: 'Pixel', formFactor: 'phone',
              publicKey: (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64url'); })(),
            },
          })));
          ws.on('message', (data) => {
            const msg = JSON.parse(String(data));
            if (msg.type === 'error') reject(new Error(msg.message));
            if (msg.type === 'welcome') resolve({ pairCode: msg.pairCode, ws, authorized: secure.authorized });
          });
          ws.on('error', reject);
        });
        secure.once('error', reject);
      });
    });
    await new Promise<void>((r) => phone!.listen(0, '127.0.0.1', () => r()));
    const phonePort = (phone!.address() as net.AddressInfo).port;
    const targets: ReverseTarget[] = [{ address: '127.0.0.1', port: phonePort, source: 'static' }];
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      https: true,
      tlsDir: path.join(tmp, 'certs'),
      hostClipboard: false,
      reverseConnect: { targets: () => targets, intervalMs: 5_000 },
    });
    const got = await welcome;
    expect(got.authorized).toBe(true);
    expect(got.pairCode).toMatch(/^[A-Z0-9]{6}$/);
    // The dialled peer is a remote phone, never the host desktop — even over loopback.
    const clients = [...(server.hub as unknown as { clients: Map<string, { isLoopback: boolean; device: { name: string } }> }).clients.values()];
    const me = clients.find((c) => c.device.name === 'Reverse Phone');
    expect(me?.isLoopback).toBe(false);
    expect(server.hub.hasClientFrom('127.0.0.1')).toBe(true);
    got.ws.close();
  }, 30_000);
});
