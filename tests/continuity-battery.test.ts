import { describe, expect, it, vi } from 'vitest';
import { ContinuityManager, type ContinuityHost, type PhoneBatteryStatusView, type ScreenVideoFrame } from '../src/client/engine/continuity.js';
import { encodeScreenFrame, encodeScreenFrameAad, encodeScreenH264Packet, SCREEN_CODEC_H264 } from '../src/shared/continuity.js';
import type { ControlPayload, PeerSummary } from '../src/shared/protocol.js';
import { encryptMediaFrame } from '../src/client/engine/crypto.js';

const phoneId = '0123456789abcdef';
const phone: PeerSummary = {
  peerId: phoneId,
  device: { name: 'Pixel phone', platform: 'android', model: 'Pixel', formFactor: 'phone', publicKey: 'phone-key' },
  discoveryScope: 'paired',
  connectedAt: 1,
};

function makeHost(overrides: Partial<ContinuityHost> = {}): ContinuityHost {
  return {
    sendControl: async () => {},
    sendFrame: () => true,
    sessionKey: async () => null,
    peer: (id) => id === phoneId ? phone : undefined,
    isAuthorized: (id) => id === phoneId,
    isPaired: (id) => id === phoneId,
    peerIds: () => [phoneId],
    emit: () => {},
    ...overrides,
  };
}

describe('phone battery status', () => {
  it('accepts paired status, sanitizes charge-time estimates, and warns once per low-battery episode', async () => {
    const lowBattery: PhoneBatteryStatusView[] = [];
    const host = makeHost();
    const manager = new ContinuityManager(host, { onLowPhoneBattery: (status) => lowBattery.push(status) });
    try {
      manager.onPeersChanged([{ peerId: phoneId, publicKey: 'phone-key' }]);
      const send = (status: Extract<ControlPayload, { kind: 'battery-status' }>) => manager.handleControl(phoneId, status);
      await send({ kind: 'battery-status', level: 18, charging: false, updatedAt: 100 });
      await send({ kind: 'battery-status', level: 17, charging: false, updatedAt: 200, chargeTimeRemainingMs: 90 * 60_000 });
      expect(manager.snapshot().batteryStatus[phoneId]).toMatchObject({
        peerId: phoneId, peerName: 'Pixel phone', level: 17, charging: false, chargeTimeRemainingMs: undefined, updatedAt: 200,
      });
      expect(lowBattery).toHaveLength(1);

      await send({ kind: 'battery-status', level: 19, charging: true, chargeTimeRemainingMs: 90 * 60_000, updatedAt: 300 });
      expect(manager.snapshot().batteryStatus[phoneId]?.chargeTimeRemainingMs).toBe(90 * 60_000);
      await send({ kind: 'battery-status', level: 19, charging: false, chargeTimeRemainingMs: 80 * 60_000, updatedAt: 400 });
      expect(manager.snapshot().batteryStatus[phoneId]?.chargeTimeRemainingMs).toBeUndefined();
      await send({ kind: 'battery-status', level: 19, charging: true, chargeTimeRemainingMs: 8 * 24 * 60 * 60_000, updatedAt: 500 });
      expect(manager.snapshot().batteryStatus[phoneId]?.chargeTimeRemainingMs).toBeUndefined();
      expect(lowBattery).toHaveLength(2);

      await manager.handleControl('fedcba9876543210', { kind: 'battery-status', level: 10, charging: false, updatedAt: 600 });
      await send({ kind: 'battery-status', level: 101, charging: false, updatedAt: 700 });
      expect(manager.snapshot().batteryStatus[phoneId]?.level).toBe(19);
      expect(lowBattery).toHaveLength(2);

      manager.onPeersChanged([]);
      expect(manager.snapshot().batteryStatus).toEqual({});
    } finally {
      manager.destroy();
    }
  });
});

describe('ordered screen-frame decoding', () => {
  it('keeps H.264 frames in wire order when the first key lookup is delayed', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x52), 'AES-GCM', false, ['encrypt', 'decrypt']);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let keyRequests = 0;
    const host = makeHost({
      sessionKey: async () => {
        keyRequests += 1;
        if (keyRequests === 1) { markFirstStarted(); await firstGate; }
        return key;
      },
    });
    const manager = new ContinuityManager(host);
    const frames: ScreenVideoFrame[] = [];
    try {
      const sessionId = manager.requestScreenShare(phoneId);
      await manager.handleControl(phoneId, { kind: 'screen-share-state', sessionId, state: 'active' });
      manager.subscribeScreenVideo(sessionId, (frame) => frames.push(frame));
      const accessUnit = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]);
      const makeFrame = async (seq: number) => {
        const aad = encodeScreenFrameAad({ sessionId, seq, codec: SCREEN_CODEC_H264, width: 720, height: 1280 });
        const plaintext = encodeScreenH264Packet({ keyFrame: seq === 1, ptsMs: seq * 33, data: accessUnit });
        const encrypted = await encryptMediaFrame(key, aad, plaintext);
        return encodeScreenFrame(aad, encrypted.iv, encrypted.ciphertext);
      };
      const first = await makeFrame(1);
      const second = await makeFrame(2);
      const firstDelivery = manager.handleScreenFrame(phoneId, first);
      await firstStarted;
      const secondDelivery = manager.handleScreenFrame(phoneId, second);
      releaseFirst();
      await Promise.all([firstDelivery, secondDelivery]);
      expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    } finally {
      manager.destroy();
    }
  });
});
