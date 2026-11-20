// @vitest-environment jsdom
import crypto from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContinuityCenter, type ContinuityClient } from '../src/client/components/ContinuityCenter.js';
import { CallAudioSession, float32ToPcm16, pcm16ToFloat32, resampleFloat32 } from '../src/client/engine/callAudio.js';
import { ContinuityManager, type ContinuityHost, type ContinuitySnapshot } from '../src/client/engine/continuity.js';
import {
  CALL_AUDIO_FRAME_SAMPLES,
  CALL_AUDIO_SAMPLE_RATE,
  FRAME_CALL_AUDIO,
  decodeCallAudioFrame,
  encodeCallAudioAad,
  encodeCallAudioFrame,
} from '../src/shared/continuity.js';
import type { ControlPayload, PeerSummary } from '../src/shared/protocol.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

async function testAesKey(seedByte: number): Promise<CryptoKey> {
  const raw = new Uint8Array(32).fill(seedByte);
  return crypto.webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

describe('Permanent saved contacts + two-way continuity call audio', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => { root!.unmount(); });
      root = null;
    }
    container?.remove();
    container = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists saved contacts across reloads while connected, removes by user, and purges on disconnect or offline reload', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const aes = await testAesKey(0x33);
    const peerA = { peerId: '1111111111111111', publicKey: 'pk-a-1', deviceId: 'dev-a', identityKey: 'id-a', name: 'Pixel 9' };
    const peerB = { peerId: '2222222222222222', publicKey: 'pk-b-1', deviceId: 'dev-b', identityKey: 'id-b', name: 'Pixel 8' };
    let currentPeers = [peerA];
    const sentControls: ControlPayload[] = [];

    const makeHost = (): ContinuityHost => ({
      sendControl: vi.fn(async (_peerId, payload) => {
        sentControls.push(payload);
      }),
      sendFrame: vi.fn(() => true),
      sessionKey: async () => aes,
      peer: (id) => {
        const found = currentPeers.find((p) => p.peerId === id);
        return found ? { peerId: found.peerId, discoveryScope: 'paired', connectedAt: 1, device: { name: found.name, platform: 'android', model: found.name, formFactor: 'phone', deviceId: found.deviceId, publicKey: found.publicKey } } : undefined;
      },
      isAuthorized: (id) => currentPeers.some((p) => p.peerId === id),
      isPaired: (id) => currentPeers.some((p) => p.peerId === id),
      peerIds: () => currentPeers.map((p) => p.peerId),
      emit: vi.fn(),
    });

    const mgr1 = new ContinuityManager(makeHost(), { storage, storagePrefix: 'test' });
    mgr1.onPeersChanged([peerA]);

    const contactsPromise = mgr1.requestContacts(peerA.peerId);
    const req = sentControls.find((c): c is Extract<ControlPayload, { kind: 'contacts-request' }> => c.kind === 'contacts-request')!;
    await mgr1.handleControl(peerA.peerId, {
      kind: 'contacts-response',
      requestId: req.requestId,
      contacts: [
        { id: 'c1', name: 'Ada Lovelace', phones: [{ number: '+15550101' }], emails: [] },
        { id: 'c2', name: 'Alan Turing', phones: [{ number: '+15550102' }], emails: [] },
      ],
      total: 2,
      truncated: false,
    });
    await contactsPromise;
    expect(mgr1.snapshot().savedContacts).toHaveLength(2);
    mgr1.destroy();

    // Simulate page reload with same connected device (even rotated ephemeral publicKey)
    const peerAReloaded = { ...peerA, peerId: '3333333333333333', publicKey: 'pk-a-2' };
    currentPeers = [peerAReloaded];
    const mgr2 = new ContinuityManager(makeHost(), { storage, storagePrefix: 'test' });
    expect(mgr2.snapshot().savedContacts).toHaveLength(2);
    mgr2.onPeersChanged([peerAReloaded]);
    expect(mgr2.snapshot().savedContacts).toHaveLength(2);
    expect(mgr2.snapshot().savedContacts![0]!.peerId).toBe(peerAReloaded.peerId);

    // User removes one contact explicitly
    const firstId = mgr2.snapshot().savedContacts![0]!.id;
    expect(mgr2.removeSavedContact(firstId)).toBe(true);
    expect(mgr2.snapshot().savedContacts).toHaveLength(1);

    // Live disconnect of peerAReloaded purges its saved contacts automatically
    currentPeers = [peerB];
    mgr2.onPeersChanged([peerB]);
    expect(mgr2.snapshot().savedContacts).toHaveLength(0);
    mgr2.destroy();

    // Offline disconnect while app closed: seeded contact from peerA must be reconciled/purged 3s after peerB connects
    const mgrSeed = new ContinuityManager(makeHost(), { storage, storagePrefix: 'offline-test' });
    currentPeers = [peerA];
    mgrSeed.onPeersChanged([peerA]);
    const p2 = mgrSeed.requestContacts(peerA.peerId);
    const req2 = sentControls.filter((c): c is Extract<ControlPayload, { kind: 'contacts-request' }> => c.kind === 'contacts-request').at(-1)!;
    await mgrSeed.handleControl(peerA.peerId, {
      kind: 'contacts-response',
      requestId: req2.requestId,
      contacts: [{ id: 'c9', name: 'Grace Hopper', phones: [], emails: [] }],
      total: 1,
      truncated: false,
    });
    await p2;
    mgrSeed.destroy();

    currentPeers = [peerB];
    const mgrOffline = new ContinuityManager(makeHost(), { storage, storagePrefix: 'offline-test' });
    expect(mgrOffline.snapshot().savedContacts).toHaveLength(1);
    mgrOffline.onPeersChanged([peerB]);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(mgrOffline.snapshot().savedContacts).toHaveLength(0);
    mgrOffline.destroy();
  });

  it('seals and unseals FRAME_CALL_AUDIO end-to-end with per-call anti-replay cursor and authorization check', async () => {
    const aes = await testAesKey(0x55);
    const macId = '1111111111111111';
    const phoneId = '2222222222222222';
    const callId = '0123456789abcdef';
    const framesToMac: Uint8Array[] = [];
    let authorized = true;

    const createMgr = (isPhone: boolean) => {
      const host: ContinuityHost = {
        sendControl: vi.fn(async () => {}),
        sendFrame: vi.fn((_peer, frame) => {
          framesToMac.push(frame);
          return true;
        }),
        sessionKey: async () => aes,
        peer: (id) => ({
          peerId: id,
          discoveryScope: 'paired',
          connectedAt: 1,
          device: {
            name: isPhone ? 'MacBook' : 'Pixel',
            platform: isPhone ? 'macos' : 'android',
            model: isPhone ? 'MacBook' : 'Pixel',
            formFactor: isPhone ? 'laptop' : 'phone',
            publicKey: 'pk-' + id,
          },
        }),
        isAuthorized: () => authorized,
        isPaired: () => true,
        peerIds: () => [isPhone ? macId : phoneId],
        emit: vi.fn(),
      };
      return new ContinuityManager(host, { callAudioAvailable: !isPhone });
    };

    const phone = createMgr(true);
    const mac = createMgr(false);
    const received: number[] = [];
    mac.subscribeCallAudio(callId, (f) => received.push(f.seq));

    const pcm = new Uint8Array(CALL_AUDIO_FRAME_SAMPLES * 2).fill(7);
    expect(await phone.sendCallAudio(macId, callId, pcm, CALL_AUDIO_SAMPLE_RATE, 1, CALL_AUDIO_FRAME_SAMPLES, 0)).toBe(true);
    expect(await phone.sendCallAudio(macId, callId, pcm, CALL_AUDIO_SAMPLE_RATE, 1, CALL_AUDIO_FRAME_SAMPLES, 20)).toBe(true);
    expect(framesToMac).toHaveLength(2);
    expect(framesToMac[0]![0]).toBe(FRAME_CALL_AUDIO);
    expect(decodeCallAudioFrame(framesToMac[0]!).seq).toBe(1);

    await mac.handleCallAudioFrame(phoneId, framesToMac[0]!);
    // Replay frame 1 must be ignored
    await mac.handleCallAudioFrame(phoneId, framesToMac[0]!);
    // Tampered frame must be ignored
    const tampered = framesToMac[1]!.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await mac.handleCallAudioFrame(phoneId, tampered);
    // Valid frame 2 accepted (even if ptsMs == 0 wasn't rejected erroneously by anti-replay cursor)
    await mac.handleCallAudioFrame(phoneId, framesToMac[1]!);

    expect(received).toEqual([1, 2]);

    // Unauthorized peer frame must be rejected
    authorized = false;
    const rawAad = encodeCallAudioAad({ callId, seq: 99, sampleRate: 16_000, channels: 1, frames: CALL_AUDIO_FRAME_SAMPLES, ptsMs: 40 });
    const iv = crypto.randomBytes(12);
    const ct = new Uint8Array(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: rawAad }, aes, pcm));
    await mac.handleCallAudioFrame(phoneId, encodeCallAudioFrame(rawAad, iv, ct));
    expect(received).toEqual([1, 2]);

    phone.destroy();
    mac.destroy();
  });

  it('CallAudioSession resamples, converts PCM16, emits monotonic ptsMs, and supports mute', async () => {
    const floatIn = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = float32ToPcm16(floatIn);
    const floatOut = pcm16ToFloat32(pcm, floatIn.length, 1, 0);
    expect(floatOut[1]).toBeCloseTo(0.5, 3);
    expect(floatOut[2]).toBeCloseTo(-0.5, 3);

    const resampled = resampleFloat32(new Float32Array(960).fill(0.25), 48_000, 16_000);
    expect(resampled).toHaveLength(320);

    const sent: Array<{ pcm: Uint8Array; sr: number; ch: number; frames: number; ptsMs: number }> = [];
    const session = new CallAudioSession({
      peerId: '2222222222222222',
      callId: '0123456789abcdef',
      sendFrame: (data, sr, ch, frames, ptsMs) => {
        sent.push({ pcm: data, sr, ch, frames, ptsMs });
      },
      subscribeIncoming: () => () => {},
    });

    // Feed 640 samples -> 2 exact 20ms packets must get distinct 0ms and 20ms ptsMs
    session.handleMicChunk(new Float32Array(640).fill(0.1), 16_000);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.ptsMs).toBe(0);
    expect(sent[1]!.ptsMs).toBe(20);

    session.setMuted(true);
    session.handleMicChunk(new Float32Array(640).fill(0.1), 16_000);
    expect(sent).toHaveLength(2);
    session.stop();
  });

  it('ContinuityCenter ContactsPanel removes saved contacts and CallsPanel drives CallAudioSession controls', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRoot(container);
    root = r;

    const mockTrack = { enabled: true, stop: vi.fn() };
    const mockGain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    const mockSource = { connect: vi.fn(), disconnect: vi.fn() };
    const mockScript = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    Object.assign(navigator, {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] })) },
    });
    Object.assign(window, {
      AudioContext: class {
        sampleRate = 16_000;
        currentTime = 0;
        state = 'running';
        destination = {};
        createGain = () => mockGain;
        createMediaStreamSource = () => mockSource;
        createScriptProcessor = () => mockScript;
        close = vi.fn(async () => {});
      },
    });

    const phone: PeerSummary = {
      peerId: '2222222222222222',
      discoveryScope: 'paired',
      connectedAt: 1,
      device: { name: 'Pixel 9', platform: 'android', model: 'Pixel 9', formFactor: 'phone', deviceId: 'dev-px9', publicKey: 'pk-p' },
    };

    const removeSavedContact = vi.fn(() => true);
    const startCallAudio = vi.fn(async () => {});
    const setCallAudioMuted = vi.fn(async () => {});
    const stopCallAudio = vi.fn(async () => {});
    const client: ContinuityClient = {
      requestContacts: vi.fn(async () => ({ contacts: [], total: 0, truncated: false })),
      shareContacts: vi.fn(),
      clearSharedContacts: vi.fn(),
      removeSavedContact,
      clearSavedContacts: vi.fn(() => 1),
      answerCall: vi.fn(async () => ({ ok: true })),
      rejectCall: vi.fn(async () => ({ ok: true })),
      hangUpCall: vi.fn(async () => ({ ok: true })),
      dialNumber: vi.fn(async () => ({ ok: true })),
      startCallAudio,
      stopCallAudio,
      setCallAudioMuted,
      sendCallAudio: vi.fn(async () => true),
      subscribeCallAudio: vi.fn(() => () => {}),
      requestScreenShare: vi.fn(() => 'cccccccccccccccc'),
      stopScreenShare: vi.fn(),
      subscribeScreenFrames: vi.fn(() => () => {}),
    };

    const snap: ContinuitySnapshot = {
      peerFeatures: { [phone.peerId]: ['contacts.provide', 'calls.control', 'calls.audio'] },
      calls: [{ callId: '0123456789abcdef', peerId: phone.peerId, peerName: 'Pixel 9', state: 'active', direction: 'incoming', number: '+15550199', name: 'Mom', updatedAt: 10, connectedAt: 1, actions: ['hangup'] }],
      screenShares: [],
      screenRequests: [],
      sharedContacts: [],
      savedContacts: [{
        id: 'saved-1',
        peerId: phone.peerId,
        peerDeviceId: 'dev-px9',
        peerKey: 'dev-px9',
        peerName: 'Pixel 9',
        source: 'synced',
        savedAt: 1,
        contact: { id: 'c1', name: 'Mom', phones: [{ number: '+15550199' }], emails: [] },
      }],
      batteryStatus: {},
      callAudio: null,
    };

    // ContactsPanel shows saved contact immediately without calling requestContacts, and Remove deletes it
    await act(async () => {
      r.render(createElement(ContinuityCenter, { client, peers: [phone], continuity: snap, initialTab: 'contacts', onClose: () => {} }));
    });
    expect(client.requestContacts).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Mom');
    act(() => {
      const btn = container!.querySelector('button[aria-label="Remove Mom"]') as HTMLButtonElement;
      btn.click();
    });
    expect(removeSavedContact).toHaveBeenCalledWith('saved-1');

    // CallsPanel drives Use Mac Audio -> Mute -> Switch to Phone
    await act(async () => {
      r.render(createElement(ContinuityCenter, { client, peers: [phone], continuity: snap, initialTab: 'calls', onClose: () => {} }));
    });
    const useMacBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Use Mac Audio'))!;
    await act(async () => {
      useMacBtn.click();
      await Promise.resolve();
    });
    expect(startCallAudio).toHaveBeenCalledWith(phone.peerId, '0123456789abcdef');

    const muteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Mute')!;
    await act(async () => {
      muteBtn.click();
      await Promise.resolve();
    });
    expect(setCallAudioMuted).toHaveBeenCalledWith(phone.peerId, '0123456789abcdef', true);

    const phoneBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Switch to Phone'))!;
    await act(async () => {
      phoneBtn.click();
      await Promise.resolve();
    });
    expect(stopCallAudio).toHaveBeenCalledWith(phone.peerId, '0123456789abcdef');
  });
});
