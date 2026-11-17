/**
 * Secure code exchange end to end: a real hub, real WarpClients, real
 * sockets. The "phone" connects through 127.0.0.2 so the hub treats it as a
 * remote device (only 127.0.0.1 counts as this computer).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import { WarpClient, type WarpClientSnapshot } from '../src/client/engine/warpClient.js';
import type { IdentityStore, StoredIdentityKeys } from '../src/client/engine/identity.js';
import { PakeFailureLimiter, verifiedIdentity } from '../src/server/signalingHub.js';
import { generateIdentityKeyPair } from '../src/client/engine/crypto.js';

function memoryIdentityStore(): IdentityStore {
  let saved: StoredIdentityKeys | null = null;
  return { load: async () => saved, save: async (k) => { saved = k; } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const isHost = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '') === '127.0.0.1';

function mac(wsUrl: string, store = memoryIdentityStore()) {
  return new WarpClient({
    wsUrl,
    enableWebRtc: false,
    storage: null,
    identityStore: store,
    deviceOverride: { name: 'MacBook', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
  });
}

function phone(wsUrl: string, code: string, store = memoryIdentityStore(), joinMode: 'pake' | 'legacy' = 'pake') {
  return new WarpClient({
    wsUrl,
    enableWebRtc: false,
    storage: null,
    initialPairCode: code,
    identityStore: store,
    joinMode,
    deviceOverride: { name: 'Pixel', platform: 'android', model: 'Pixel', formFactor: 'phone' },
  });
}

describe('code-authenticated join (SPAKE2)', () => {
  let server: AirBridgeServerInstance;
  let hostUrl: string;
  let remoteUrl: string;

  beforeAll(async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: '::',
      mode: 'test',
      enableMdns: false,
      hostClipboard: false,
      isLocalMachineAddress: isHost,
    });
    hostUrl = `ws://127.0.0.1:${server.port}/ws`;
    remoteUrl = `ws://[::1]:${server.port}/ws`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('joins with the right code, vouches both ways and gives a stable identity-based code', async () => {
    const m = mac(hostUrl);
    await m.start();
    await waitFor(() => m.getSnapshot().connectionState === 'connected');
    const code = m.getSnapshot().pairCode;
    expect(m.getSnapshot().admission).toBe('host');

    const phoneStore = memoryIdentityStore();
    let p = phone(remoteUrl, code, phoneStore);
    await p.start();
    await waitFor(() => p.getSnapshot().connectionState === 'connected' && p.getSnapshot().peers.length === 1);
    const ps = p.getSnapshot();
    expect(ps.admission).toBe('pake');
    const macPeer = ps.peers[0];
    expect(macPeer.attestation).toBe('host');
    expect(macPeer.vouch).toMatch(/^[A-Za-z0-9_-]{22}$/);

    await waitFor(() => m.getSnapshot().peers.length === 1);
    const phoneView = m.getSnapshot().peers[0];
    expect(phoneView.attestation).toBe('pake');

    await waitFor(() => {
      const a = p.getSnapshot().peerSecurity[macPeer.peerId];
      const b = m.getSnapshot().peerSecurity[phoneView.peerId];
      return Boolean(a?.identityKey && b?.identityKey && a.sasCode !== '··· ···' && b.sasCode !== '··· ···');
    });
    const fromPhone = p.getSnapshot().peerSecurity[macPeer.peerId];
    const fromMac = m.getSnapshot().peerSecurity[phoneView.peerId];
    expect(fromPhone.verification).toBe('verified');
    expect(fromMac.verification).toBe('verified');
    expect(fromPhone.sasCode).toBe(fromMac.sasCode);
    expect(fromPhone.trustKey).toBe(m.getSnapshot().myDevice?.identityKey);

    // Trust pins the identity, which survives a restart with fresh session keys.
    m.toggleTrustedPeer(phoneView.device.publicKey, true);
    const firstSas = fromMac.sasCode;
    const firstSessionKey = phoneView.device.publicKey;
    p.stop();
    p = phone(remoteUrl, code, phoneStore);
    await p.start();
    await waitFor(() => m.getSnapshot().peers.some((x) => x.device.publicKey !== firstSessionKey));
    const again = m.getSnapshot().peers.find((x) => x.device.publicKey !== firstSessionKey)!;
    await waitFor(() => m.getSnapshot().peerSecurity[again.peerId]?.sasCode !== '··· ···' && Boolean(m.getSnapshot().peerSecurity[again.peerId]?.identityKey));
    const sec = m.getSnapshot().peerSecurity[again.peerId];
    expect(sec.sasCode).toBe(firstSas);
    expect(m.getSnapshot().trustedPeerKeys).toContain(sec.trustKey);
    expect(sec.identityChanged).toBe(false);
    p.stop();
    m.stop();
  });

  it('rejects a wrong code without retrying and without the hub learning anything', async () => {
    const m = mac(hostUrl);
    await m.start();
    await waitFor(() => m.getSnapshot().connectionState === 'connected');
    const code = m.getSnapshot().pairCode;
    const wrong = code === '222222' ? '333333' : '222222';
    const p = phone(remoteUrl, wrong);
    await p.start();
    await waitFor(() => Boolean(p.getSnapshot().connectionError));
    expect(p.getSnapshot().connectionError).toMatch(/doesn't know that pairing code/);
    await new Promise((r) => setTimeout(r, 1800));
    expect(p.getSnapshot().connectionState).toBe('disconnected');
    expect(m.getSnapshot().peers).toHaveLength(0);
    // Entering the right code reconnects immediately.
    p.joinPairCode(code);
    await waitFor(() => p.getSnapshot().admission === 'pake' && p.getSnapshot().peers.length === 1);
    p.stop();
    m.stop();
  });

  it('never sends the code to a hub that cannot prove it knows it', async () => {
    const frames: string[] = [];
    const rogue = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    rogue.on('connection', (ws) => {
      ws.on('message', (data) => {
        frames.push(data.toString());
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          // Answer with a valid-looking point and a made-up confirmation.
          ws.send(JSON.stringify({ type: 'pake-challenge', share: msg.pake.share, confirm: 'A'.repeat(43) }));
        }
      });
    });
    await new Promise((r) => rogue.once('listening', r));
    const port = (rogue.address() as { port: number }).port;
    const p = phone(`ws://127.0.0.1:${port}/ws`, 'K7Q2XP', memoryIdentityStore(), 'pake');
    await p.start();
    await waitFor(() => Boolean(p.getSnapshot().connectionError));
    expect(frames.length).toBe(1);
    expect(frames.join('\n')).not.toContain('K7Q2XP');
    expect(JSON.parse(frames[0]).pairCode).toBeUndefined();
    p.stop();
    await new Promise((r) => rogue.close(() => r(null)));
  });

  it('drops peers whose keys were swapped in transit, and rejects a tampered welcome', async () => {
    const m = mac(hostUrl);
    await m.start();
    await waitFor(() => m.getSnapshot().connectionState === 'connected');
    const code = m.getSnapshot().pairCode;

    // A man in the middle that forwards everything but rewrites keys/pins.
    const startProxy = (mutate: (msg: Record<string, any>) => void) => {
      const proxy = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      proxy.on('connection', (client) => {
        const upstream = new WebSocket(remoteUrl);
        const queue: string[] = [];
        upstream.on('open', () => { for (const q of queue.splice(0)) upstream.send(q); });
        client.on('message', (d) => { const t = d.toString(); if (upstream.readyState === WebSocket.OPEN) upstream.send(t); else queue.push(t); });
        upstream.on('message', (d, isBinary) => {
          if (isBinary) { client.send(d); return; }
          const msg = JSON.parse(d.toString());
          mutate(msg);
          client.send(JSON.stringify(msg));
        });
        client.on('close', () => upstream.close());
        upstream.on('close', () => client.close());
      });
      return new Promise<{ url: string; close: () => Promise<void> }>((resolve) =>
        proxy.once('listening', () => resolve({
          url: `ws://127.0.0.1:${(proxy.address() as { port: number }).port}/ws`,
          close: () => new Promise((r) => proxy.close(() => r())),
        })),
      );
    };

    const evilKey = (await generateIdentityKeyPair()).publicKeyB64; // a valid key the attacker controls
    const swap = await startProxy((msg) => {
      for (const peer of msg.peers ?? []) peer.device.publicKey = evilKey;
    });
    const p = phone(swap.url, code);
    await p.start();
    await waitFor(() => p.getSnapshot().admission === 'pake');
    await new Promise((r) => setTimeout(r, 200));
    expect(p.getSnapshot().peers).toHaveLength(0);
    expect(p.getSnapshot().connectionError).toMatch(/failed verification/);
    p.stop();
    await swap.close();

    const pin = await startProxy((msg) => { if (msg.type === 'welcome') msg.tlsPin = 'x'.repeat(43); });
    const q = phone(pin.url, code);
    await q.start();
    await waitFor(() => Boolean(q.getSnapshot().connectionError));
    expect(q.getSnapshot().connectionError).toMatch(/Could not verify this computer/);
    expect(q.getSnapshot().admission).toBeNull();
    q.stop();
    await pin.close();
    m.stop();
  });

  it('keeps admission keys fixed and does not hand rooms to a reused peer id from another address', async () => {
    const m = mac(hostUrl);
    await m.start();
    await waitFor(() => m.getSnapshot().connectionState === 'connected');
    const code = m.getSnapshot().pairCode;
    const p = phone(remoteUrl, code);
    await p.start();
    await waitFor(() => m.getSnapshot().peers.length === 1);
    const original = m.getSnapshot().peers[0];

    // Raw socket: legacy hello without a code but with the phone's peer id.
    p.stop();
    await waitFor(() => m.getSnapshot().peers.length === 0);
    const raw = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { localAddress: '127.0.0.3' });
    const welcome = await new Promise<any>((resolve) => {
      raw.on('open', () => raw.send(JSON.stringify({
        type: 'hello', peerId: original.peerId, visibility: 'hidden',
        device: { ...original.device, identityKey: undefined, identitySig: undefined },
      })));
      raw.on('message', (d) => { const msg = JSON.parse(d.toString()); if (msg.type === 'welcome') resolve(msg); });
    });
    expect(welcome.pairCode).not.toBe(code);
    expect(welcome.admission).toBe('legacy');
    raw.close();
    m.stop();
  });

  it('verifies identity signatures on the hub and limits wrong guesses', async () => {
    expect(verifiedIdentity('AAAA', 'BBBB', 'x')).toBeNull();
    let now = 0;
    const limiter = new PakeFailureLimiter(1000, 3, 5, () => now);
    for (let i = 0; i < 3; i++) limiter.fail('a');
    expect(limiter.allows('a')).toBe(false);
    expect(limiter.allows('b')).toBe(true);
    limiter.fail('b'); limiter.fail('c');
    expect(limiter.allows('d')).toBe(false); // global cap
    now = 1001;
    expect(limiter.allows('a')).toBe(true);
  });
});
