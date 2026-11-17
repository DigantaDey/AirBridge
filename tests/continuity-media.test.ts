import { afterEach, describe, expect, it } from 'vitest';
import {
  FRAME_SCREEN_AUDIO,
  SCREEN_CODEC_H264,
  encodeScreenAudioAad,
  encodeScreenAudioFrame,
  encodeScreenFrame,
  encodeScreenFrameAad,
  encodeScreenH264Packet,
} from '../src/shared/continuity.js';
import type { ControlPayload, DeviceProfile, PeerSummary } from '../src/shared/protocol.js';
import { encryptMediaFrame } from '../src/client/engine/crypto.js';
import { ContinuityManager, type ContinuityHost, type ScreenAudioFrame, type ScreenVideoFrame } from '../src/client/engine/continuity.js';

const peerId = '0123456789abcdef';
const sessionIdPattern = /^[0-9a-f]{16}$/;
const device: DeviceProfile = { name: 'Pixel test device', platform: 'android', model: 'Pixel', formFactor: 'phone', publicKey: 'test-public-key' };
const peer: PeerSummary = { peerId, device, discoveryScope: 'paired', connectedAt: 1 };

async function makeRig(): Promise<{ manager: ContinuityManager; key: CryptoKey; controls: ControlPayload[] }> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x3c), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const controls: ControlPayload[] = [];
  const host: ContinuityHost = {
    sendControl: async (_target, payload) => { controls.push(payload); },
    sendFrame: () => true,
    sessionKey: async (id) => id === peerId ? key : null,
    peer: (id) => id === peerId ? peer : undefined,
    isAuthorized: (id) => id === peerId,
    isPaired: (id) => id === peerId,
    peerIds: () => [peerId],
    emit: () => {},
  };
  return { manager: new ContinuityManager(host), key, controls };
}

describe('encrypted Android casting media', () => {
  const managers: ContinuityManager[] = [];
  afterEach(() => { for (const manager of managers.splice(0)) manager.destroy(); });

  it('delivers authenticated AVC and permitted PCM, and drops stale audio timestamps', async () => {
    const { manager, key, controls } = await makeRig();
    managers.push(manager);
    const sessionId = manager.requestScreenShare(peerId);
    expect(sessionId).toMatch(sessionIdPattern);
    await manager.handleControl(peerId, { kind: 'screen-share-state', sessionId, state: 'active', width: 1080, height: 2400, audio: true });

    const video: ScreenVideoFrame[] = [];
    const audio: ScreenAudioFrame[] = [];
    const unsubscribeVideo = manager.subscribeScreenVideo(sessionId, (frame) => video.push(frame));
    const unsubscribeAudio = manager.subscribeScreenAudio(sessionId, (frame) => audio.push(frame));

    const accessUnit = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]);
    const videoPlaintext = encodeScreenH264Packet({ keyFrame: true, ptsMs: 10_000, data: accessUnit });
    const videoAad = encodeScreenFrameAad({ sessionId, seq: 1, codec: SCREEN_CODEC_H264, width: 1080, height: 2400 });
    const encryptedVideo = await encryptMediaFrame(key, videoAad, videoPlaintext);
    await manager.handleScreenFrame(peerId, encodeScreenFrame(videoAad, encryptedVideo.iv, encryptedVideo.ciphertext));
    expect(video).toEqual([expect.objectContaining({ codec: 'h264', keyFrame: true, ptsMs: 10_000, data: accessUnit })]);
    expect(controls).toContainEqual(expect.objectContaining({ kind: 'screen-share-ack', sessionId, seq: 1 }));

    const pcm = new Uint8Array(960 * 2 * 2).map((_sample, index) => index & 0xff);
    const sendAudio = async (seq: number, ptsMs: number) => {
      const audioAad = encodeScreenAudioAad({ sessionId, seq, sampleRate: 48_000, channels: 2, frames: 960, ptsMs });
      const encryptedAudio = await encryptMediaFrame(key, audioAad, pcm);
      await manager.handleScreenAudioFrame(peerId, encodeScreenAudioFrame(audioAad, encryptedAudio.iv, encryptedAudio.ciphertext));
    };
    await sendAudio(1, 10_020);
    await sendAudio(2, 9_900); // a higher sequence carrying an old source timestamp
    await sendAudio(3, 10_040);
    expect(audio.map((frame) => [frame.seq, frame.ptsMs, frame.data.byteLength])).toEqual([[1, 10_020, pcm.byteLength], [3, 10_040, pcm.byteLength]]);
    expect(manager.snapshot().screenShares).toContainEqual(expect.objectContaining({ sessionId, audioAvailable: true }));

    // A differently typed packet must never reach the audio path.
    await manager.handleScreenAudioFrame(peerId, new Uint8Array([FRAME_SCREEN_AUDIO]));
    expect(audio).toHaveLength(2);
    unsubscribeVideo();
    unsubscribeAudio();
  });
});
