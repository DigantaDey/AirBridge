// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContinuityCenter, type ContinuityClient } from '../src/client/components/ContinuityCenter.js';
import type { ContinuitySnapshot, ScreenVideoFrame } from '../src/client/engine/continuity.js';
import {
  annexBToAvcc,
  buildAvcDecoderConfigurationRecord,
  extractSpsPps,
  h264CodecFromAnnexB,
  prependSpsPpsIfMissing,
  splitAnnexBNalus,
} from '../src/client/engine/h264.js';
import type { PeerSummary } from '../src/shared/protocol.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function annexBFrame(...nalus: Uint8Array[]): Uint8Array {
  const total = nalus.reduce((sum, n) => sum + 4 + n.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nalu of nalus) {
    out.set([0, 0, 0, 1], offset);
    offset += 4;
    out.set(nalu, offset);
    offset += nalu.byteLength;
  }
  return out;
}

describe('H.264 Annex-B & AVCC helpers', () => {
  const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x28, 0xda, 0x01, 0x10]); // High/Baseline 4.0 -> avc1.42c028
  const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
  const idr = new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0]);
  const slice = new Uint8Array([0x41, 0x9a, 0x22, 0x10]);

  it('splits mixed 3-byte and 4-byte Annex-B start codes cleanly', () => {
    const buf = new Uint8Array([0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...idr]);
    const nalus = splitAnnexBNalus(buf);
    expect(nalus).toHaveLength(3);
    expect(Array.from(nalus[0]!)).toEqual(Array.from(sps));
    expect(Array.from(nalus[1]!)).toEqual(Array.from(pps));
    expect(Array.from(nalus[2]!)).toEqual(Array.from(idr));
  });

  it('extracts SPS/PPS, builds ISO 14496-15 avcC record, and derives RFC 6381 codec string', () => {
    const key = annexBFrame(sps, pps, idr);
    const extracted = extractSpsPps(key);
    expect(extracted).not.toBeNull();
    expect(Array.from(extracted!.sps)).toEqual(Array.from(sps));
    expect(Array.from(extracted!.pps)).toEqual(Array.from(pps));
    expect(h264CodecFromAnnexB(key)).toBe('avc1.42c028');

    const avcC = buildAvcDecoderConfigurationRecord(extracted!.sps, extracted!.pps);
    expect(avcC[0]).toBe(1);
    expect(avcC[1]).toBe(0x42);
    expect(avcC[2]).toBe(0xc0);
    expect(avcC[3]).toBe(0x28);
    expect(avcC[4]).toBe(0xff); // 4-byte length prefix
    expect(avcC[5]).toBe(0xe1); // 1 SPS
    expect((avcC[6]! << 8) | avcC[7]!).toBe(sps.byteLength);
  });

  it('prepends cached codecConfig only when SPS/PPS are missing and converts Annex-B to AVCC', () => {
    const config = annexBFrame(sps, pps);
    const bareIdr = annexBFrame(idr);
    const combined = prependSpsPpsIfMissing(bareIdr, config);
    expect(extractSpsPps(combined)).not.toBeNull();
    expect(prependSpsPpsIfMissing(combined, config)).toBe(combined);

    const avcc = annexBToAvcc(combined);
    // SPS/PPS stripped, only 4-byte BE length + IDR remains
    expect(avcc.byteLength).toBe(4 + idr.byteLength);
    const view = new DataView(avcc.buffer);
    expect(view.getUint32(0, false)).toBe(idr.byteLength);
    expect(Array.from(avcc.subarray(4))).toEqual(Array.from(idr));

    const deltaAvcc = annexBToAvcc(annexBFrame(slice));
    expect(deltaAvcc.byteLength).toBe(4 + slice.byteLength);
  });
});

describe('ScreenViewer WebCodecs H.264 AVCC & PLI recovery', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => { root!.unmount(); });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
    delete (window as unknown as { VideoDecoder?: unknown }).VideoDecoder;
    delete (window as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  });

  const phone: PeerSummary = {
    peerId: 'aaaaaaaaaaaaaaaa',
    discoveryScope: 'paired',
    connectedAt: 1,
    device: {
      name: 'Pixel 9',
      platform: 'android',
      model: 'Pixel 9',
      formFactor: 'phone',
      deviceId: '1111111111111111',
      publicKey: 'pk-phone',
    },
  };

  it('probes isConfigSupported, supplies avcC description on WKWebView/Safari, renders via rAF, closes dropped frames, and sends PLI on error', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRoot(container);
    root = r;

    const configuredCalls: Array<Record<string, unknown>> = [];
    const decodeCalls: Array<{ type: string; timestamp: number; data: Uint8Array }> = [];
    const isConfigSupported = vi.fn(async (cfg: Record<string, unknown>) => {
      // Simulate Safari rejecting prefer-hardware with description only on first probe, then accepting no-preference AVCC
      const supported = Boolean(cfg.description) && cfg.hardwareAcceleration === 'no-preference';
      return { supported };
    });

    let capturedOutput: ((frame: { displayWidth: number; displayHeight: number; close: () => void }) => void) | null = null;
    let capturedError: ((err: Error) => void) | null = null;

    class MockVideoDecoder {
      static isConfigSupported = isConfigSupported;
      constructor(init: { output: typeof capturedOutput; error: (err: Error) => void }) {
        capturedOutput = init.output;
        capturedError = init.error;
      }
      configure(cfg: Record<string, unknown>) {
        configuredCalls.push(cfg);
      }
      decode(chunk: { type: string; timestamp: number; data: Uint8Array }) {
        decodeCalls.push(chunk);
      }
      close() {}
    }
    class MockEncodedVideoChunk {
      type: string;
      timestamp: number;
      data: Uint8Array;
      constructor(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.data = init.data;
      }
    }
    Object.assign(window, { VideoDecoder: MockVideoDecoder, EncodedVideoChunk: MockEncodedVideoChunk });

    // Mock 2D canvas context + rAF
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    let pendingRafCb: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      pendingRafCb = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const videoListeners = new Set<(frame: ScreenVideoFrame) => void>();
    const requestScreenKeyframe = vi.fn();
    const recordScreenViewerStats = vi.fn();

    const client: ContinuityClient = {
      requestContacts: vi.fn(async () => ({ contacts: [], total: 0, truncated: false })),
      shareContacts: vi.fn(),
      clearSharedContacts: vi.fn(),
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangUpCall: vi.fn(),
      dialNumber: vi.fn(),
      requestScreenShare: vi.fn(() => 'bbbbbbbbbbbbbbbb'),
      stopScreenShare: vi.fn(),
      requestScreenKeyframe,
      recordScreenViewerStats,
      subscribeScreenFrames: vi.fn(() => () => {}),
      subscribeScreenVideo: vi.fn((_id, listener) => {
        videoListeners.add(listener);
        return () => videoListeners.delete(listener);
      }),
    };

    const continuity: ContinuitySnapshot = {
      peerFeatures: { [phone.peerId]: ['screen.source', 'screen.audio.capture'] },
      calls: [],
      screenShares: [{
        sessionId: 'bbbbbbbbbbbbbbbb',
        peerId: phone.peerId,
        peerName: 'Pixel 9',
        role: 'viewer',
        state: 'active',
        width: 1080,
        height: 2400,
        maxWidth: 1280,
        maxFps: 30,
        frames: 1,
        fps: 30,
        kbps: 4000,
        startedAt: 1,
        updatedAt: 2,
      }],
      screenRequests: [],
      sharedContacts: [],
      savedContacts: [],
      batteryStatus: {},
      callAudio: null,
    };

    await act(async () => {
      r.render(createElement(ContinuityCenter, { client, peers: [phone], continuity, initialTab: 'screen', onClose: () => {} }));
    });

    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac]);
    const pps = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);
    const idr = new Uint8Array([0x65, 0x88, 0x84]);
    const keyAu = annexBFrame(sps, pps, idr);

    await act(async () => {
      for (const l of videoListeners) {
        l({ sessionId: 'bbbbbbbbbbbbbbbb', peerId: phone.peerId, seq: 1, codec: 'h264', width: 1080, height: 2400, ptsMs: 10, keyFrame: true, data: keyAu });
      }
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((res) => setTimeout(res, 10));
    });

    expect(isConfigSupported).toHaveBeenCalled();
    expect(configuredCalls).toHaveLength(1);
    expect(configuredCalls[0]!.codec).toBe('avc1.640028');
    expect(configuredCalls[0]!.description).toBeInstanceOf(Uint8Array);
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0]!.type).toBe('key');
    // Verify AVCC conversion (4-byte length prefix + IDR)
    expect(decodeCalls[0]!.data.byteLength).toBe(4 + idr.byteLength);

    // Emit two output frames before rAF fires: first must be closed immediately (latest-frame-wins), second drawn on rAF then closed
    const close1 = vi.fn();
    const close2 = vi.fn();
    act(() => {
      capturedOutput!({ displayWidth: 1080, displayHeight: 2400, close: close1 });
      capturedOutput!({ displayWidth: 1080, displayHeight: 2400, close: close2 });
    });
    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).not.toHaveBeenCalled();

    act(() => {
      pendingRafCb!(16);
    });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);

    // Trigger decoder error -> sends PLI keyframe request
    act(() => {
      capturedError!(new Error('corrupt frame'));
    });
    expect(requestScreenKeyframe).toHaveBeenCalledWith('bbbbbbbbbbbbbbbb', 'decode-error');
  });
});
