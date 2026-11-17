// @vitest-environment node
/**
 * Hotspot handoff: the sealed offer format, the consent state machine, the
 * OS Wi-Fi tools (with a fake exec) and the full path through a real hub with
 * a code-authenticated (SPAKE2) phone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  BEACON_WINDOW_MS,
  HandoffError,
  HandoffService,
  beaconTag,
  generateHandoffKeys,
  handoffInfoFor,
  loadOrCreateHandoffKeys,
  openOffer,
  sealOffer,
  type HandoffKeys,
  type HandoffOfferView,
} from '../src/server/handoff.js';
import {
  createWifiJoiner,
  ipv4On,
  macJoinFailure,
  parseMacCurrentNetwork,
  parseMacWifiDevice,
  parseNetshInterfaces,
  parseNmcliActiveConnection,
  parseNmcliWifiDevice,
  windowsProfileXml,
  type Exec,
  type WifiJoiner,
} from '../src/server/wifiJoin.js';
import { HUB_SPAKE2_IDENTITY, JOIN_SPAKE2_AAD, joinerSpake2Identity, nameplateFor, passwordScalar, verifyHandoffProof, vouchKeyFrom } from '../src/shared/pairingProof.js';
import { Spake2, constantTimeEqual } from '../src/shared/spake2.js';
import { bytesToBase64Url, base64UrlToBytes } from '../src/shared/protocol.js';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const offer = { ssid: 'AndroidShare_4821', psk: 'p4ss-w0rd-xyz', sec: 'wpa2' as const, rp: 47390, id: '', name: 'Pixel 8' };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-handoff-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('offer envelope', () => {
  const keys = generateHandoffKeys();
  const key = b64u(keys.publicKey);

  it('round-trips and is readable only by this computer with a room code', () => {
    const env = sealOffer(key, 'K7Q2XP', offer);
    expect(env[0]).toBe(1);
    expect(env.length).toBeLessThan(400); // fits a single BLE attribute (512)
    const opened = openOffer(env, keys, ['ZZZZZZ', 'k7q-2xp']);
    expect(opened.credentials).toEqual({ ssid: offer.ssid, psk: offer.psk, security: 'wpa2' });
    expect(opened.payload.name).toBe('Pixel 8');

    expect(() => openOffer(env, generateHandoffKeys(), ['K7Q2XP'])).toThrow(expect.objectContaining({ code: 'NOT_FOR_US' }));
    expect(() => openOffer(env, keys, ['ZZZZZZ'])).toThrow(expect.objectContaining({ code: 'BAD_AUTH' }));
    const tampered = env.slice(); tampered[5] ^= 1; // header is authenticated
    expect(() => openOffer(tampered, keys, ['K7Q2XP'])).toThrow(HandoffError);
    const body = env.slice(); body[body.length - 20] ^= 1;
    expect(() => openOffer(body, keys, ['K7Q2XP'])).toThrow(expect.objectContaining({ code: 'NOT_FOR_US' }));
    expect(() => openOffer(env.slice(0, 50), keys, ['K7Q2XP'])).toThrow(expect.objectContaining({ code: 'MALFORMED' }));
  });

  it('rejects stale offers and unsafe credentials', () => {
    const old = sealOffer(key, 'K7Q2XP', offer, { issuedAt: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => openOffer(old, keys, ['K7Q2XP'])).toThrow(expect.objectContaining({ code: 'STALE' }));
    for (const bad of [
      { ...offer, psk: 'short' },
      { ...offer, ssid: 'evil\nname' },
      { ...offer, ssid: 'x'.repeat(33) },
      { ...offer, sec: 'open' as unknown as 'wpa2' },
    ]) {
      expect(() => openOffer(sealOffer(key, 'K7Q2XP', bad), keys, ['K7Q2XP'])).toThrow(expect.objectContaining({ code: 'BAD_CREDENTIALS' }));
    }
    expect(openOffer(sealOffer(key, 'K7Q2XP', { ...offer, psk: 'a'.repeat(64), sec: 'wpa3' }), keys, ['K7Q2XP']).credentials.security).toBe('wpa3');
  });

  it('is deterministic given the ephemeral key, IV and nonce (cross-language vectors)', () => {
    const fixed = { ephemeralPrivateKey: new Uint8Array(32).fill(7), iv: new Uint8Array(12).fill(9), nonce: new Uint8Array(12).fill(3), issuedAt: 1_800_000_000 };
    expect(b64u(sealOffer(key, 'K7Q2XP', offer, fixed))).toBe(b64u(sealOffer(key, 'K7Q2XP', offer, fixed)));
  });

  it('rotating Bluetooth tag: stable within a window, unlinkable across windows and computers', () => {
    const t = 1_800_000_000_000;
    const a = beaconTag(keys.beaconSecret, t);
    expect(a.length).toBe(9);
    expect(a[0]).toBe(1);
    const windowStart = Math.floor(t / BEACON_WINDOW_MS) * BEACON_WINDOW_MS;
    expect(b64u(beaconTag(keys.beaconSecret, windowStart + BEACON_WINDOW_MS - 1))).toBe(b64u(a));
    expect(b64u(beaconTag(keys.beaconSecret, windowStart + BEACON_WINDOW_MS))).not.toBe(b64u(a));
    expect(b64u(beaconTag(generateHandoffKeys().beaconSecret, t))).not.toBe(b64u(a));
  });

  it('keys persist privately and the welcome info is bound to the session', () => {
    const k1 = loadOrCreateHandoffKeys(dir);
    expect(b64u(loadOrCreateHandoffKeys(dir).publicKey)).toBe(b64u(k1.publicKey));
    expect(fs.statSync(path.join(dir, 'handoff-key.json')).mode & 0o077).toBe(0);
    const vk = new Uint8Array(32).fill(1);
    const info = handoffInfoFor(k1, vk, 'peer-1');
    expect(verifyHandoffProof(vk, { peerId: 'peer-1', key: info.key, beacon: info.beacon }, info.proof)).toBe(true);
    expect(verifyHandoffProof(vk, { peerId: 'peer-2', key: info.key, beacon: info.beacon }, info.proof)).toBe(false);
    expect(verifyHandoffProof(vk, { peerId: 'peer-1', key: b64u(generateHandoffKeys().publicKey), beacon: info.beacon }, info.proof)).toBe(false);
  });
});

function fakeJoiner(opts: { fail?: string } = {}) {
  const calls: string[] = [];
  const joiner: WifiJoiner = {
    platform: 'linux',
    unsupportedReason: async () => null,
    join: async (c) => {
      calls.push(`join ${c.ssid}`);
      if (opts.fail) throw new Error(opts.fail);
      return { device: 'wlan0', address: '192.168.49.23', previous: 'Home' };
    },
    leave: async (ssid) => { calls.push(`leave ${ssid}`); return 'Home'; },
  };
  return { joiner, calls };
}

function service(keys: HandoffKeys, joiner: WifiJoiner, extra: Partial<ConstructorParameters<typeof HandoffService>[0]> = {}) {
  return new HandoffService({ keys, pairCodes: () => ['K7Q2XP'], joiner, stateDir: dir, ...extra });
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('HandoffService', () => {
  const keys = generateHandoffKeys();
  const key = b64u(keys.publicKey);

  it('asks first, joins when allowed, and returns to the previous network at the end', async () => {
    const { joiner, calls } = fakeJoiner();
    const joined = vi.fn();
    const svc = service(keys, joiner, { onJoined: joined });
    const states: string[] = [];
    svc.on('status', (v: HandoffOfferView) => states.push(v.state));
    const requests: HandoffOfferView[] = [];
    svc.on('request', (v: HandoffOfferView) => requests.push(v));

    const view = svc.submit(sealOffer(key, 'K7Q2XP', offer), 'bluetooth');
    expect(view).toMatchObject({ state: 'pending', deviceName: 'Pixel 8', ssid: offer.ssid, via: 'bluetooth' });
    expect(JSON.stringify(view)).not.toContain(offer.psk); // never exposed
    expect(requests).toHaveLength(1);
    expect(calls).toEqual([]);

    svc.respond(view.id, true);
    await settle();
    expect(svc.get(view.id)?.state).toBe('joined');
    expect(joined).toHaveBeenCalledWith(expect.objectContaining({ id: view.id }), 47390);

    await svc.end(view.id);
    expect(calls).toEqual([`join ${offer.ssid}`, `leave ${offer.ssid}`]);
    expect(states).toEqual(['pending', 'joining', 'joined', 'ended']);
  });

  it('declines, expires, refuses replays, and honours always/off', async () => {
    const { joiner, calls } = fakeJoiner();
    const svc = service(keys, joiner, { consentTimeoutMs: 30 });
    const declined = svc.submit(sealOffer(key, 'K7Q2XP', offer), 'session', 'peer');
    expect(svc.respond(declined.id, false)?.state).toBe('declined');

    const env = sealOffer(key, 'K7Q2XP', offer);
    const pending = svc.submit(env, 'session');
    expect(svc.submit(env, 'session')).toMatchObject({ state: 'invalid', reason: expect.stringMatching(/already used/) });
    await new Promise((r) => setTimeout(r, 60));
    expect(svc.get(pending.id)?.state).toBe('expired');

    expect(svc.submit(sealOffer(b64u(generateHandoffKeys().publicKey), 'K7Q2XP', offer), 'bluetooth').state).toBe('invalid');

    svc.setPolicy('always');
    const auto = svc.submit(sealOffer(key, 'K7Q2XP', offer), 'session');
    await settle();
    expect(svc.get(auto.id)?.state).toBe('joined');
    expect(service(keys, joiner).getPolicy()).toBe('always'); // persisted

    svc.setPolicy('off');
    expect(svc.submit(sealOffer(key, 'K7Q2XP', offer), 'session').state).toBe('declined');
    expect(calls.filter((c) => c.startsWith('join'))).toHaveLength(1);
  });

  it('remembers once keys were shared with a phone (gates Bluetooth in the desktop app), with the policy', () => {
    const svc = service(keys, fakeJoiner().joiner);
    expect(svc.shared).toBe(false);
    svc.setPolicy('always');
    svc.markShared();
    const reloaded = service(keys, fakeJoiner().joiner);
    expect(reloaded.shared).toBe(true);
    expect(reloaded.getPolicy()).toBe('always');
    expect((fs.statSync(path.join(dir, 'handoff.json')).mode & 0o777).toString(8)).toBe('600');
  });

  it('reports a failed join without leaking the password', async () => {
    const { joiner } = fakeJoiner({ fail: 'Could not join “AndroidShare_4821”: network not found' });
    const svc = service(keys, joiner);
    const v = svc.submit(sealOffer(key, 'K7Q2XP', offer), 'session');
    svc.respond(v.id, true);
    await settle();
    expect(svc.get(v.id)).toMatchObject({ state: 'failed', reason: expect.stringContaining('network not found') });
  });
});

describe('Wi-Fi tools', () => {
  it('parses macOS, NetworkManager and netsh output', () => {
    expect(parseMacWifiDevice('Hardware Port: Ethernet\nDevice: en1\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa')).toBe('en0');
    expect(parseMacCurrentNetwork('Current Wi-Fi Network: Home Net\n')).toBe('Home Net');
    expect(parseMacCurrentNetwork('You are not associated with an AirPort network.\n')).toBeNull();
    expect(macJoinFailure('')).toBeNull();
    expect(macJoinFailure('Could not find network X.')).toBe('not-found');
    expect(macJoinFailure('Failed to join network X.\nError: -3900')).toMatch(/Failed/);
    expect(parseNmcliWifiDevice('p2p-dev-wlan0:wifi-p2p:disconnected\neth0:ethernet:connected\nwlan0:wifi:connected\n')).toBe('wlan0');
    expect(parseNmcliActiveConnection('Wired:802-3-ethernet:eth0\nCafe\\: Guest:802-11-wireless:wlan0\n', 'wlan0')).toBe('Cafe: Guest');
    expect(parseNetshInterfaces('\n    Name                   : Wi-Fi\n    State : connected\n    SSID                   : Home\n    BSSID                  : aa:bb\n')).toEqual({ name: 'Wi-Fi', ssid: 'Home' });
    expect(ipv4On({ en0: [{ address: '169.254.1.2', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo, { address: '192.168.49.5', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] }, 'en0')).toBe('192.168.49.5');
  });

  it('Windows profiles escape XML and never auto-connect', () => {
    const xml = windowsProfileXml({ ssid: 'A&B <x>', psk: 'pa"ss&word', security: 'wpa3' });
    expect(xml).toContain('<name>A&amp;B &lt;x&gt;</name>');
    expect(xml).toContain('<keyMaterial>pa&quot;ss&amp;word</keyMaterial>');
    expect(xml).toContain('<authentication>WPA3SAE</authentication>');
    expect(xml).toContain('<connectionMode>manual</connectionMode>');
    expect(xml).toContain(Buffer.from('A&B <x>').toString('hex').toUpperCase());
  });

  function scripted(responses: Array<[RegExp, { code?: number; stdout?: string; stderr?: string }]>) {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const line = [cmd, ...args].join(' ');
      const hit = responses.find(([re]) => re.test(line));
      return { code: hit?.[1].code ?? 0, stdout: hit?.[1].stdout ?? '', stderr: hit?.[1].stderr ?? '' };
    };
    return { exec, calls };
  }

  it('macOS: retries while the new hotspot is not visible yet, waits for an address, restores on leave', async () => {
    let joins = 0;
    let addr: string | null = null;
    const { exec: base, calls } = scripted([
      [/-listallhardwareports/, { stdout: 'Hardware Port: Wi-Fi\nDevice: en0\n' }],
      [/-getairportnetwork/, { stdout: 'Current Wi-Fi Network: Home\n' }],
    ]);
    const exec: Exec = async (cmd, args, t) => {
      if (args[0] === '-setairportnetwork' && args[2] === 'AndroidShare_4821') {
        calls.push([cmd, ...args]);
        joins++;
        if (joins === 1) return { code: 0, stdout: 'Could not find network AndroidShare_4821.\n', stderr: '' };
        addr = '192.168.49.7';
        return { code: 0, stdout: '', stderr: '' };
      }
      return base(cmd, args, t);
    };
    const joiner = createWifiJoiner('darwin', { exec, retryDelayMs: 1, addressTimeoutMs: 200, interfaces: () => (addr ? { en0: [{ address: addr, family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] } : {}) });
    expect(await joiner.join({ ssid: 'AndroidShare_4821', psk: 'secretpass', security: 'wpa2' })).toEqual({ device: 'en0', address: '192.168.49.7', previous: 'Home' });
    expect(joins).toBe(2);
    expect(await joiner.leave('AndroidShare_4821')).toBe('Home');
    expect(calls.some((c) => c.join(' ') === 'networksetup -removepreferredwirelessnetwork en0 AndroidShare_4821')).toBe(true);
    expect(calls.some((c) => c.join(' ') === 'networksetup -setairportnetwork en0 Home')).toBe(true);
  });

  it('Linux: uses a dedicated NetworkManager profile and never puts the password in errors', async () => {
    const { exec, calls } = scripted([
      [/--version/, { stdout: 'nmcli tool, version 1.46' }],
      [/-f DEVICE,TYPE,STATE/, { stdout: 'wlan0:wifi:connected\n' }],
      [/connection show --active/, { stdout: 'Home:802-11-wireless:wlan0\n' }],
      [/device wifi connect/, { code: 4, stderr: 'Error: Connection activation failed: Secrets were required, but not provided (secretpass).' }],
    ]);
    const joiner = createWifiJoiner('linux', { exec, retryDelayMs: 1, addressTimeoutMs: 10, interfaces: () => ({}) });
    expect(await joiner.unsupportedReason()).toBeNull();
    const err = await joiner.join({ ssid: 'AndroidShare_4821', psk: 'secretpass', security: 'wpa2' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/Secrets were required/);
    expect(String(err)).not.toContain('secretpass');
    const connect = calls.find((c) => c.includes('connect'))!;
    expect(connect).toEqual(['nmcli', '--wait', '40', 'device', 'wifi', 'connect', 'AndroidShare_4821', 'password', 'secretpass', 'ifname', 'wlan0', 'name', 'AirBridge handoff']);
    expect(calls.at(-1)).toEqual(['nmcli', 'connection', 'delete', 'AirBridge handoff']); // cleaned up
  });

  it('Windows: adds a temporary profile file that is deleted right away', async () => {
    let profileFile = '';
    let addr: string | null = null;
    const { exec: base } = scripted([[/show interfaces/, { stdout: '    Name : Wi-Fi\n    SSID : Office\n' }]]);
    const exec: Exec = async (cmd, args, t) => {
      if (args[1] === 'add') {
        profileFile = args[3]!.slice('filename='.length);
        expect(fs.readFileSync(profileFile, 'utf8')).toContain('<keyMaterial>secretpass</keyMaterial>');
      }
      if (args[1] === 'connect') addr = '192.168.49.9';
      return base(cmd, args, t);
    };
    const joiner = createWifiJoiner('win32', { exec, tmpDir: dir, retryDelayMs: 1, addressTimeoutMs: 100, interfaces: () => (addr ? { 'Wi-Fi': [{ address: addr, family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] } : {}) });
    expect(await joiner.join({ ssid: 'AndroidShare_4821', psk: 'secretpass', security: 'wpa2-wpa3' })).toMatchObject({ device: 'Wi-Fi', previous: 'Office' });
    expect(fs.existsSync(profileFile)).toBe(false);
  });

  it('other systems explain what to do instead', async () => {
    expect(await createWifiJoiner('freebsd' as NodeJS.Platform).unsupportedReason()).toMatch(/Wi-Fi menu/);
  });
});

describe('handoff through the hub (code-authenticated phone)', () => {
  it('welcome carries a verifiable handoff key; a sealed offer is joined after consent and the phone hears every step', async () => {
    const { createAirBridgeServer } = await import('../src/server/index.js');
    const { joiner, calls } = fakeJoiner();
    const isHost = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '') === '127.0.0.1';
    const server = await createAirBridgeServer({ port: 0, host: '::', mode: 'test', enableMdns: false, hostClipboard: false, isLocalMachineAddress: isHost, handoff: { stateDir: dir, joiner } });
    const sockets: WebSocket[] = [];
    try {
      const code = server.hub.getDefaultPairCode();
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const publicKey = bytesToBase64Url(new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', kp.publicKey)));
      const party = new Spake2('A', passwordScalar(code), joinerSpake2Identity(publicKey, undefined), HUB_SPAKE2_IDENTITY, JOIN_SPAKE2_AAD);
      const ws = new WebSocket(`ws://[::1]:${server.port}/ws`);
      sockets.push(ws);
      const messages: Array<Record<string, unknown>> = [];
      let vouchKey: Uint8Array | null = null;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === 'pake-challenge') {
          const result = party.finish(base64UrlToBytes(msg.share as string));
          expect(constantTimeEqual(result.expectedPeerConfirm, base64UrlToBytes(msg.confirm as string))).toBe(true);
          vouchKey = vouchKeyFrom(result.ke);
          ws.send(JSON.stringify({ type: 'pake-confirm', confirm: bytesToBase64Url(result.confirm) }));
        }
      });
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({
        type: 'hello',
        device: { name: 'Pixel 8', platform: 'android', model: 'Pixel', formFactor: 'phone', publicKey },
        visibility: 'nearby',
        pake: { v: 1, nameplate: nameplateFor(code), share: bytesToBase64Url(party.share()) },
      }));
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'welcome')).toBe(true));
      const welcome = messages.find((m) => m.type === 'welcome') as { peerId: string; admission: string; handoff: { key: string; beacon: string; proof: string } };
      expect(welcome.admission).toBe('pake');
      expect(verifyHandoffProof(vouchKey!, { peerId: welcome.peerId, key: welcome.handoff.key, beacon: welcome.handoff.beacon }, welcome.handoff.proof)).toBe(true);

      ws.send(JSON.stringify({ type: 'handoff-offer', envelope: b64u(sealOffer(welcome.handoff.key, code, offer)) }));
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'handoff-status' && m.state === 'pending')).toBe(true));

      // The computer's UI lists the request and the user allows it.
      const base = `http://127.0.0.1:${server.port}`;
      const list = await (await fetch(`${base}/api/handoff`)).json() as { enabled: boolean; policy: string; offers: HandoffOfferView[] };
      expect(list).toMatchObject({ enabled: true, policy: 'ask', offers: [{ deviceName: 'Pixel 8', ssid: offer.ssid, state: 'pending' }] });
      expect(JSON.stringify(list)).not.toContain(offer.psk);
      const id = list.offers[0]!.id;
      expect((await fetch(`${base}/api/handoff/${id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"allow":true}' })).status).toBe(403);
      await fetch(`${base}/api/handoff/${id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"allow":true}' });
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'handoff-status' && m.state === 'joined')).toBe(true));
      expect(calls).toEqual([`join ${offer.ssid}`]);

      ws.send(JSON.stringify({ type: 'handoff-end', id }));
      await vi.waitFor(() => expect(calls).toEqual([`join ${offer.ssid}`, `leave ${offer.ssid}`]));

      // The macOS app's Bluetooth bridge: tag for the GATT service, offers forwarded as base64.
      expect((await fetch(`${base}/api/local/handoff/beacon`)).status).toBe(400); // shell header required
      const beacon = await (await fetch(`${base}/api/local/handoff/beacon`, { headers: { 'X-AirBridge-Shell': '1' } })).json() as { enabled: boolean; shared: boolean; tag: string; uuids: { service: string } };
      expect(beacon.enabled).toBe(true);
      expect(beacon.shared).toBe(true); // a code-authenticated phone now holds the keys
      expect(Buffer.from(beacon.tag, 'base64')).toHaveLength(9);
      const viaBle = await (await fetch(`${base}/api/local/handoff/offer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AirBridge-Shell': '1' },
        body: JSON.stringify({ envelope: Buffer.from(sealOffer(welcome.handoff.key, code, offer)).toString('base64') }),
      })).json() as HandoffOfferView;
      expect(viaBle).toMatchObject({ state: 'pending', via: 'bluetooth' });
      const polled = await (await fetch(`${base}/api/local/handoff/offer/${viaBle.id}`, { headers: { 'X-AirBridge-Shell': '1' } })).json();
      expect(polled.state).toBe('pending');
    } finally {
      for (const s of sockets) s.close();
      await server.close();
    }
  });

  it('devices that did not prove the code get no handoff key and cannot send offers', async () => {
    const { createAirBridgeServer } = await import('../src/server/index.js');
    const { joiner } = fakeJoiner();
    const server = await createAirBridgeServer({ port: 0, host: '127.0.0.1', mode: 'test', enableMdns: false, hostClipboard: false, handoff: { stateDir: dir, joiner } });
    try {
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const publicKey = bytesToBase64Url(new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', kp.publicKey)));
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const messages: Array<Record<string, unknown>> = [];
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ type: 'hello', device: { name: 'Mac', platform: 'macos', model: 'Mac', formFactor: 'laptop', publicKey }, visibility: 'nearby' }));
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'welcome')).toBe(true));
      expect((messages.find((m) => m.type === 'welcome') as { handoff?: unknown }).handoff).toBeUndefined();
      ws.send(JSON.stringify({ type: 'handoff-offer', envelope: 'AAAA' }));
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'error' && m.code === 'HANDOFF_UNAVAILABLE')).toBe(true));
      ws.close();
    } finally {
      await server.close();
    }
  });
});
