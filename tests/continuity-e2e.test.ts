import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignalingHub } from '../src/server/signalingHub.js';
import { WarpClient } from '../src/client/engine/warpClient.js';
import type { CallCommand, CallView, ContactShareItem, ScreenFrame, ScreenFrameSource, ScreenShareRequestView } from '../src/client/engine/continuity.js';
import { SCREEN_MAX_INFLIGHT, type ContactCard } from '../src/shared/continuity.js';

function waitFor(fn: () => boolean, label: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, 15);
  });
}

const PHONEBOOK: ContactCard[] = [
  { id: '1', name: 'Ada Lovelace', phones: [{ number: '+44 20 7946 0958', label: 'mobile' }], emails: [{ address: 'ada@example.org' }] },
  { id: '2', name: 'Alan Turing', phones: [{ number: '+44 161 496 0000', label: 'work' }], emails: [], organization: 'Bletchley' },
  { id: '3', name: 'Grace Hopper', phones: [{ number: '+1 202 555 0143' }], emails: [] },
];

interface Rig {
  hub: SignalingHub;
  http: Server;
  wsUrl: string;
  clients: WarpClient[];
}

let rig: Rig | null = null;

async function startRig(): Promise<Rig> {
  const hub = new SignalingHub({
    getLanUrls: () => ['http://192.168.1.150:3000'],
    getDaemonStatus: () => ({ enabled: true, platform: 'macos', hostname: 'MacBook', autoSaveToDownloads: true }),
  });
  const http = createServer();
  http.on('upgrade', (req, socket, head) => {
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  rig = { hub, http, wsUrl: `ws://127.0.0.1:${port}/ws`, clients: [] };
  return rig;
}

afterEach(async () => {
  if (!rig) return;
  for (const c of rig.clients) c.stop();
  rig.hub.close();
  await new Promise<void>((r) => rig!.http.close(() => r()));
  rig = null;
});

/** A fake capture source: numbered "JPEG" frames, records flow-control pressure. */
function fakeSource(): ScreenFrameSource & { captured: number; stopped: boolean; qualities: number[] } {
  const src = {
    captured: 0,
    stopped: false,
    qualities: [] as number[],
    async capture({ quality }: { maxWidth: number; quality: number }) {
      src.captured++;
      src.qualities.push(quality);
      const data = new Uint8Array(2048 + src.captured);
      data[0] = 0xff; data[1] = 0xd8;
      new DataView(data.buffer).setUint32(2, src.captured);
      return { data, width: 1080, height: 2400 };
    },
    stop() { src.stopped = true; },
  };
  return src;
}

describe('phone continuity over the paired encrypted session', () => {
  it('shares contacts, controls calls and streams the screen between paired devices', async () => {
    const { wsUrl, clients } = await startRig();
    const commands: CallCommand[] = [];
    const screenRequests: ScreenShareRequestView[] = [];
    const phoneCards: ContactShareItem[] = [];
    const macCalls: CallView[] = [];

    const phone = new WarpClient({
      wsUrl, initialPairCode: 'CONT01', storage: null, identityStore: null,
      deviceOverride: { name: 'Pixel 9', platform: 'android', model: 'Pixel', formFactor: 'phone' },
      contactProvider: (query, limit) => PHONEBOOK.filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
      callController: (command) => {
        commands.push(command);
        return command.action === 'dial' ? { ok: true, callId: 'feedfacecafebeef' } : { ok: true };
      },
      screenSourceAvailable: true,
      onScreenShareRequest: (r) => screenRequests.push(r),
      onIncomingContact: (item) => phoneCards.push(item),
    });
    const mac = new WarpClient({
      wsUrl, initialPairCode: 'CONT01', storage: null, identityStore: null,
      deviceOverride: { name: 'MacBook Air', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
      onCallStateChanged: (call) => macCalls.push(call),
    });
    clients.push(phone, mac);
    await Promise.all([phone.start(), mac.start()]);
    await waitFor(() => mac.getSnapshot().peers.length === 1 && phone.getSnapshot().peers.length === 1, 'peers');
    const phoneId = phone.getSnapshot().peerId;
    const macId = mac.getSnapshot().peerId;
    // Same-machine hub: both admitted by the host, so each vouches for the other.
    for (const c of [phone, mac]) {
      const peer = c.getSnapshot().peers[0];
      expect(peer.discoveryScope).toBe('paired');
      expect(c.getSnapshot().peerSecurity[peer.peerId]?.verification).toBe('verified');
    }

    // ---- capability advertisement ----
    await waitFor(() => (mac.getSnapshot().continuity?.peerFeatures[phoneId] ?? []).includes('calls.control'), 'phone features at mac');
    expect(mac.getSnapshot().continuity!.peerFeatures[phoneId]).toEqual(
      expect.arrayContaining(['contacts.provide', 'contacts.receive', 'calls.control', 'screen.source', 'screen.view']),
    );
    await waitFor(() => (phone.getSnapshot().continuity?.peerFeatures[macId] ?? []).length > 0, 'mac features at phone');
    expect(phone.getSnapshot().continuity!.peerFeatures[macId]).toEqual(['contacts.receive', 'screen.view', 'screen.audio.play']);

    // ---- contacts ----
    const all = await mac.requestContacts(phoneId);
    expect(all.contacts.map((c) => c.name)).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    expect(all.truncated).toBe(false);
    const filtered = await mac.requestContacts(phoneId, { query: 'al' });
    expect(filtered.contacts.map((c) => c.name)).toEqual(['Alan Turing']);
    const limited = await mac.requestContacts(phoneId, { limit: 2 });
    expect(limited).toMatchObject({ truncated: true, total: 3 });
    expect(limited.contacts).toHaveLength(2);
    // The Mac has no address book to offer.
    await expect(phone.requestContacts(macId)).rejects.toThrow(/can't share contacts/);

    const shared = await mac.shareContacts(phoneId, [{ name: 'Dr. Who', phones: [{ number: '+44 7700 900123', label: 'mobile' }], emails: [] }]);
    expect(shared.direction).toBe('outgoing');
    await waitFor(() => phoneCards.length === 1, 'card at phone');
    expect(phoneCards[0].contacts[0]).toMatchObject({ name: 'Dr. Who', phones: [{ number: '+44 7700 900123', label: 'mobile' }] });
    expect(phoneCards[0].vcard).toContain('BEGIN:VCARD');
    expect(phone.getSnapshot().continuity!.sharedContacts[0].direction).toBe('incoming');
    expect(mac.getSnapshot().continuity!.sharedContacts[0].direction).toBe('outgoing');

    // ---- calls ----
    const callId = '0123456789abcdef';
    phone.publishCallState({ callId, state: 'ringing', direction: 'incoming', number: '+1 202 555 0143', name: 'Grace Hopper', updatedAt: 1, actions: ['answer', 'reject'] });
    await waitFor(() => mac.getSnapshot().continuity!.calls.some((c) => c.callId === callId), 'ringing at mac');
    expect(mac.getSnapshot().continuity!.calls[0]).toMatchObject({ state: 'ringing', name: 'Grace Hopper', peerId: phoneId, peerName: 'Pixel 9' });
    expect(macCalls.at(-1)?.state).toBe('ringing');

    await expect(mac.answerCall(phoneId, callId)).resolves.toEqual({ ok: true });
    expect(commands.at(-1)).toEqual({ peerId: macId, action: 'answer', callId });
    phone.publishCallState({ callId, state: 'active', direction: 'incoming', number: '+1 202 555 0143', name: 'Grace Hopper', connectedAt: 2, updatedAt: 2, actions: ['hangup'] });
    await waitFor(() => mac.getSnapshot().continuity!.calls[0]?.state === 'active', 'active at mac');
    // A late, reordered "ringing" must not resurrect the old state.
    phone.publishCallState({ callId, state: 'ringing', direction: 'incoming', updatedAt: 1, actions: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(mac.getSnapshot().continuity!.calls[0].state).toBe('active');

    await expect(mac.hangUpCall(phoneId, callId)).resolves.toEqual({ ok: true });
    expect(commands.at(-1)?.action).toBe('hangup');
    await expect(mac.dialNumber(phoneId, 'not a number')).rejects.toThrow(/valid phone number/);
    await expect(mac.dialNumber(phoneId, '+1 (202) 555-0143')).resolves.toEqual({ ok: true, callId: 'feedfacecafebeef' });
    expect(commands.at(-1)).toEqual({ peerId: macId, action: 'dial', number: '+12025550143' });
    // The Mac cannot place calls itself.
    await expect(phone.dialNumber(macId, '123')).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });

    phone.publishCallState({ callId, state: 'ended', direction: 'incoming', updatedAt: 3, actions: [] });
    await waitFor(() => mac.getSnapshot().continuity!.calls[0]?.state === 'ended', 'ended at mac');

    // ---- screen sharing: decline ----
    const declinedId = mac.requestScreenShare(phoneId);
    await waitFor(() => screenRequests.some((r) => r.sessionId === declinedId), 'request at phone');
    await waitFor(() => mac.getSnapshot().continuity!.screenShares.find((s) => s.sessionId === declinedId)?.state === 'pending', 'pending at mac');
    phone.declineScreenShare(declinedId);
    await waitFor(() => mac.getSnapshot().continuity!.screenShares.find((s) => s.sessionId === declinedId)?.state === 'declined', 'declined at mac');
    expect(phone.getSnapshot().continuity!.screenRequests).toEqual([]);

    // ---- screen sharing: stream ----
    const sessionId = mac.requestScreenShare(phoneId, { maxFps: 30, maxWidth: 720 });
    await waitFor(() => screenRequests.some((r) => r.sessionId === sessionId), 'second request at phone');
    expect(screenRequests.at(-1)).toMatchObject({ peerId: macId, peerName: 'MacBook Air', maxWidth: 720, maxFps: 30 });
    const frames: ScreenFrame[] = [];
    let maxUnacked = 0;
    const source = fakeSource();
    const unsubscribe = mac.subscribeScreenFrames(sessionId, (f) => frames.push(f));
    const originalCapture = source.capture.bind(source);
    source.capture = async (opts) => {
      maxUnacked = Math.max(maxUnacked, source.captured - frames.length);
      return originalCapture(opts);
    };
    phone.acceptScreenShare(sessionId, source);
    await waitFor(() => frames.length >= 12, 'frames at mac');
    const seqs = frames.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    const first = frames[0];
    expect(first).toMatchObject({ width: 1080, height: 2400, mimeType: 'image/jpeg', peerId: phoneId });
    expect(first.data[0]).toBe(0xff);
    expect(new DataView(first.data.buffer, first.data.byteOffset).getUint32(2)).toBe(first.data.byteLength - 2048);
    // Credit-based flow control: never more than the window ahead of the viewer.
    expect(maxUnacked).toBeLessThanOrEqual(SCREEN_MAX_INFLIGHT + 1);
    await waitFor(() => mac.getSnapshot().continuity!.screenShares.find((s) => s.sessionId === sessionId)?.state === 'active', 'active at mac');
    const sourceView = phone.getSnapshot().continuity!.screenShares.find((s) => s.sessionId === sessionId);
    expect(sourceView).toMatchObject({ role: 'source', state: 'active', peerId: macId, width: 1080, height: 2400 });
    // Late subscribers get the latest frame immediately.
    let replayed: ScreenFrame | null = null;
    mac.subscribeScreenFrames(sessionId, (f) => { replayed ??= f; })();
    expect(replayed).not.toBeNull();

    mac.stopScreenShare(sessionId);
    await waitFor(() => source.stopped, 'source stopped on phone');
    expect(phone.getSnapshot().continuity!.screenShares.find((s) => s.sessionId === sessionId)?.state).toBe('stopped');
    const count = frames.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(frames.length).toBe(count);
    unsubscribe();
  }, 30_000);

  it('refuses sensitive requests from nearby devices that are not paired', async () => {
    const { wsUrl, clients } = await startRig();
    const commands: CallCommand[] = [];
    const strangerCalls: CallView[] = [];
    const phone = new WarpClient({
      wsUrl, initialPairCode: 'HOME42', storage: null, identityStore: null,
      deviceOverride: { name: 'Phone', platform: 'android', model: 'Pixel', formFactor: 'phone' },
      contactProvider: () => PHONEBOOK,
      callController: (c) => { commands.push(c); return { ok: true }; },
      screenSourceAvailable: true,
    });
    const stranger = new WarpClient({
      wsUrl, initialPairCode: 'EVIL99', storage: null, identityStore: null,
      deviceOverride: { name: 'Café laptop', platform: 'linux', model: 'PC', formFactor: 'laptop' },
      onCallStateChanged: (c) => strangerCalls.push(c),
    });
    clients.push(phone, stranger);
    await Promise.all([phone.start(), stranger.start()]);
    await waitFor(() => stranger.getSnapshot().peers.length === 1 && phone.getSnapshot().peers.length === 1, 'nearby peers');
    const phoneId = phone.getSnapshot().peerId;
    const strangerId = stranger.getSnapshot().peerId;
    expect(stranger.getSnapshot().peers[0].discoveryScope).toBe('nearby');

    await expect(stranger.requestContacts(phoneId)).rejects.toThrow(/hasn't verified this computer/);
    await expect(stranger.dialNumber(phoneId, '+1 900 555 0100')).resolves.toMatchObject({ ok: false });
    expect(commands).toEqual([]);
    expect(() => stranger.requestScreenShare(phoneId)).toThrow(/Pair with this device first/);

    // The phone never publishes calls to unpaired devices, and a stranger's
    // forged call state or contact card is ignored by a paired device.
    phone.publishCallState({ callId: '0123456789abcdef', state: 'ringing', direction: 'incoming', number: '123', updatedAt: 1, actions: [] });
    stranger.publishCallState({ callId: '0123456789abcdef', state: 'ringing', direction: 'incoming', number: '123', updatedAt: 1, actions: [] }, phoneId);
    await stranger.shareContacts(phoneId, [{ name: 'Spam', phones: [{ number: '123' }], emails: [] }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(strangerCalls).toEqual([]);
    expect(phone.getSnapshot().continuity!.calls).toEqual([]);
    expect(phone.getSnapshot().continuity!.sharedContacts).toEqual([]);
    expect(phone.getSnapshot().continuity!.peerFeatures[strangerId]).toBeUndefined();
  }, 20_000);

  it('cleans up calls, requests and streams when a device disconnects', async () => {
    const { wsUrl, clients } = await startRig();
    const phone = new WarpClient({
      wsUrl, initialPairCode: 'BYE123', storage: null, identityStore: null,
      deviceOverride: { name: 'Phone', platform: 'android', model: 'Pixel', formFactor: 'phone' },
      screenSourceAvailable: true,
      contactProvider: () => new Promise(() => {}), // never answers
    });
    const mac = new WarpClient({
      wsUrl, initialPairCode: 'BYE123', storage: null, identityStore: null,
      deviceOverride: { name: 'Mac', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
    });
    clients.push(phone, mac);
    await Promise.all([phone.start(), mac.start()]);
    await waitFor(() => mac.getSnapshot().peers.length === 1 && phone.getSnapshot().peers.length === 1, 'peers');
    const phoneId = phone.getSnapshot().peerId;
    phone.publishCallState({ callId: '0123456789abcdef', state: 'active', direction: 'outgoing', number: '123', updatedAt: 1, actions: ['hangup'] });
    await waitFor(() => mac.getSnapshot().continuity!.calls.length === 1, 'call at mac');
    const sessionId = mac.requestScreenShare(phoneId);
    await waitFor(() => phone.getSnapshot().continuity!.screenRequests.length === 1, 'request at phone');
    const source = fakeSource();
    phone.acceptScreenShare(sessionId, source);
    await waitFor(() => mac.getSnapshot().continuity!.screenShares[0]?.state === 'active', 'streaming');
    const pendingContacts = mac.requestContacts(phoneId);

    phone.stop();
    await expect(pendingContacts).rejects.toThrow(/disconnected/);
    await waitFor(() => mac.getSnapshot().continuity!.calls.length === 0, 'call cleared');
    expect(mac.getSnapshot().continuity!.screenShares[0]).toMatchObject({ state: 'stopped', reason: 'Device disconnected' });
    expect(source.stopped).toBe(true);
    expect(mac.getSnapshot().continuity!.peerFeatures[phoneId]).toBeUndefined();
  }, 20_000);
});
