/**
 * Relay fallback: the rendezvous server, the computer-side agent, and the
 * hub treating relayed sockets as remote devices (never "this computer").
 */
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  RelayAgent,
  loadOrCreateRelayHostKey,
  parseRelayEndpoint,
  relayRoomFor,
  startRelayServer,
  type RelayServer,
} from '../src/server/relay.js';
import { createAirBridgeServer } from '../src/server/index.js';
import { generateIdentityKeyPair } from '../src/client/engine/crypto.js';

const HOST_KEY = 'ab'.repeat(32);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Opens a DIAL; resolves with the socket after GO, or rejects with the relay's error line. */
function dial(port: number, room: string, extra = ''): Promise<{ socket: net.Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    socket.once('connect', () => socket.write(`AB-RELAY/1 DIAL ${room}\n${extra}`));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString();
      socket.off('data', onData);
      if (line === 'GO') resolve({ socket, rest: buf.subarray(nl + 1) });
      else { socket.destroy(); reject(new Error(line)); }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed')));
  });
}

async function relay(opts: Parameters<typeof startRelayServer>[0] = {}): Promise<RelayServer> {
  const r = await startRelayServer({ port: 0, host: '127.0.0.1', ...opts });
  cleanups.push(() => r.close());
  return r;
}

describe('relay endpoint parsing', () => {
  it('accepts host, host:port and [v6]:port; rejects junk', () => {
    expect(parseRelayEndpoint('relay.example.com')).toEqual({ host: 'relay.example.com', port: 47391, endpoint: 'relay.example.com:47391' });
    expect(parseRelayEndpoint(' 203.0.113.9:443 ')).toEqual({ host: '203.0.113.9', port: 443, endpoint: '203.0.113.9:443' });
    expect(parseRelayEndpoint('[2001:db8::1]:7000')?.endpoint).toBe('[2001:db8::1]:7000');
    for (const bad of ['', 'relay:0', 'relay:70000', 'http://relay:1', 'a b:1', '2001:db8::1:7000']) {
      expect(parseRelayEndpoint(bad)).toBeNull();
    }
  });

  it('room ids are a one-way function of the host key', () => {
    const room = relayRoomFor(HOST_KEY);
    expect(room).toMatch(/^[0-9a-f]{64}$/);
    expect(room).not.toBe(HOST_KEY);
    expect(relayRoomFor(HOST_KEY)).toBe(room);
  });
});

describe('relay rendezvous', () => {
  it('splices a dialler to a standby connection, both directions, with early bytes intact', async () => {
    const r = await relay();
    const injected: net.Socket[] = [];
    let atHost = '';
    // Like dispatchSocket: the reader is attached synchronously inside inject().
    const agent = new RelayAgent({
      endpoint: `127.0.0.1:${r.port}`,
      hostKey: HOST_KEY,
      inject: (s) => { injected.push(s); s.on('data', (c: Buffer) => { atHost += c.toString(); }); },
      standby: 2,
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => agent.describe().state === 'ready' && agent.describe().standby === 2);
    expect(agent.offer()).toEqual({ endpoint: `127.0.0.1:${r.port}`, token: relayRoomFor(HOST_KEY) });

    // Bytes sent right behind the DIAL line (a TLS ClientHello in practice) must not be lost.
    const { socket: phone } = await dial(r.port, agent.room, 'early-bytes|');
    await waitFor(() => injected.length === 1);
    const host = injected[0];
    phone.write('hello-computer');
    await waitFor(() => atHost === 'early-bytes|hello-computer');
    let atPhone = '';
    phone.on('data', (c: Buffer) => { atPhone += c.toString(); });
    host.write('hello-phone');
    await waitFor(() => atPhone === 'hello-phone');

    // The agent replaces the standby it handed off.
    await waitFor(() => agent.describe().standby === 2);
    expect(agent.describe().relayed).toBe(1);
    phone.destroy();
    host.destroy();
  });

  it('refuses unknown rooms, the host key itself, and malformed headers', async () => {
    const r = await relay({ dialWaitMs: 150 });
    const agent = new RelayAgent({ endpoint: `127.0.0.1:${r.port}`, hostKey: HOST_KEY, inject: (s) => s.destroy(), standby: 1 });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => agent.describe().standby === 1);
    await expect(dial(r.port, 'cd'.repeat(32))).rejects.toThrow('ERR NO_HOST');
    // A dialler that only knows the room cannot listen on it, and vice versa.
    await expect(dial(r.port, HOST_KEY)).rejects.toThrow('ERR NO_HOST');
    await expect(dial(r.port, 'not-hex')).rejects.toThrow('ERR PROTOCOL');
    expect(r.stats().standby).toBe(1);
  });

  it('a dialler waits briefly for a standby to arrive', async () => {
    const r = await relay({ dialWaitMs: 3000 });
    const pending = dial(r.port, relayRoomFor(HOST_KEY));
    await new Promise((res) => setTimeout(res, 100));
    const injected: net.Socket[] = [];
    const agent = new RelayAgent({ endpoint: `127.0.0.1:${r.port}`, hostKey: HOST_KEY, inject: (s) => injected.push(s), standby: 1 });
    cleanups.push(() => agent.stop());
    agent.start();
    const { socket } = await pending;
    await waitFor(() => injected.length === 1);
    socket.destroy();
  });

  it('drops slow or oversized headers and caps connections per address', async () => {
    const r = await relay({ headerTimeoutMs: 100, maxPerAddress: 3 });
    const silent = net.connect({ host: '127.0.0.1', port: r.port });
    const closed = new Promise<void>((res) => silent.once('close', () => res()));
    silent.on('error', () => {});
    await closed; // header timeout

    const big = net.connect({ host: '127.0.0.1', port: r.port });
    big.on('error', () => {});
    const bigClosed = new Promise<void>((res) => big.once('close', () => res()));
    big.write('A'.repeat(400));
    await bigClosed;

    const held = await Promise.all([0, 1, 2].map(() => new Promise<net.Socket>((res) => {
      const s = net.connect({ host: '127.0.0.1', port: r.port }, () => res(s));
      s.on('error', () => {});
    })));
    await waitFor(() => r.stats().connections === 3);
    const over = net.connect({ host: '127.0.0.1', port: r.port });
    let reply = '';
    over.on('data', (c: Buffer) => { reply += c.toString(); });
    over.on('error', () => {});
    await new Promise<void>((res) => over.once('close', () => res()));
    expect(reply).toBe('ERR BUSY\n');
    held.forEach((s) => s.destroy());
  });

  it('the agent backs off while the relay is down and recovers when it returns', async () => {
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((res) => probe.close(() => res()));

    const agent = new RelayAgent({ endpoint: `127.0.0.1:${port}`, hostKey: HOST_KEY, inject: (s) => s.destroy(), standby: 1 });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => agent.describe().state === 'error');
    expect(agent.describe().lastError).toMatch(/ECONNREFUSED/);

    await relay({ port });
    await waitFor(() => agent.describe().state === 'ready', 8000);
    expect(agent.describe().lastError).toBeNull();
  }, 15_000);

  it('the host key is created once, private, and reused', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ab-relay-key-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'nested', 'relay-host-key');
    const a = await loadOrCreateRelayHostKey(file);
    const b = await loadOrCreateRelayHostKey(file);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect((await readFile(file, 'utf8')).trim()).toBe(a);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0);
  });
});

describe('hub behind a relay', () => {
  it('relayed devices are remote: TLS terminates at the computer, no host admission, relay offered only after the code', async () => {
    const r = await relay();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ab-relay-hub-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      https: true,
      tlsDir: path.join(dir, 'tls'),
      hostClipboard: false,
      relay: { endpoint: `127.0.0.1:${r.port}`, hostKeyFile: path.join(dir, 'relay-host-key'), standby: 1 },
    });
    cleanups.push(() => server.close());
    await waitFor(() => r.stats().standby === 1);
    const hostKey = (await readFile(path.join(dir, 'relay-host-key'), 'utf8')).trim();

    const { socket, rest } = await dial(r.port, relayRoomFor(hostKey));
    expect(rest.length).toBe(0);
    const secure = tls.connect({ socket, servername: 'airbridge.local', ca: server.tls!.caCertPem, ALPNProtocols: ['http/1.1'] });
    await new Promise<void>((res, rej) => { secure.once('secureConnect', () => res()); secure.once('error', rej); });
    expect(secure.authorized).toBe(true); // the computer's own CA, end to end through the relay

    const ws = new WebSocket('wss://airbridge.local/ws', { createConnection: () => secure } as unknown as ConstructorParameters<typeof WebSocket>[1]);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const { publicKeyB64 } = await generateIdentityKeyPair();
    // Relayed loopback traffic must not count as "this computer": a hello
    // without a code is admitted as an unproven legacy device, not as host.
    ws.send(JSON.stringify({
      type: 'hello',
      device: { name: 'Relayed', platform: 'android', model: 'Pixel', formFactor: 'phone', publicKey: publicKeyB64 },
    }));
    await waitFor(() => messages.some((m) => m.type === 'welcome'));
    const welcome = messages.find((m) => m.type === 'welcome')!;
    expect(welcome.admission).toBe('legacy');
    expect(welcome.relay).toBeUndefined();
    const clients = [...(server.hub as unknown as { clients: Map<string, { isLoopback: boolean }> }).clients.values()];
    expect(clients.length).toBe(1);
    expect(clients[0].isLoopback).toBe(false);
    ws.close();
  });
});
