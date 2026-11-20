// @vitest-environment jsdom
import crypto from 'node:crypto';
import fs from 'node:fs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContinuityCenter,
  exitStageFullscreen,
  requestStageFullscreen,
  type ContinuityClient,
} from '../src/client/components/ContinuityCenter.js';
import { CallAudioSession, type CallAudioSessionStats } from '../src/client/engine/callAudio.js';
import {
  ContinuityManager,
  type CallAudioStateView,
  type ContinuityHost,
  type ScreenAudioFrame,
  type ScreenFrame,
  type ScreenVideoFrame,
} from '../src/client/engine/continuity.js';
import {
  ScreenAudioPlayer,
  computePcm16Rms,
  hasNonZeroPcm16,
  type ScreenAudioPlayerStats,
} from '../src/client/engine/screenAudio.js';
import {
  CALL_AUDIO_FRAME_SAMPLES,
  CALL_AUDIO_SAMPLE_RATE,
  FRAME_SCREEN_AUDIO,
  SCREEN_VIDEO_MAX_INFLIGHT,
  encodeScreenAudioAad,
  encodeScreenAudioFrame,
} from '../src/shared/continuity.js';
import { encryptMediaFrame } from '../src/client/engine/crypto.js';
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

describe('Screen sharing FPS, Fullscreen, Screen Audio, and Call Audio fixes', () => {
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
    delete (window as unknown as { VideoDecoder?: unknown }).VideoDecoder;
    delete (window as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  const phone: PeerSummary = {
    peerId: 'aaaaaaaaaaaaaaaa',
    discoveryScope: 'paired',
    connectedAt: 1,
    device: {
      name: 'moto g57 power',
      platform: 'android',
      model: 'moto g57 power',
      formFactor: 'phone',
      deviceId: '1111111111111111',
      publicKey: 'pk-moto',
    },
  };

  it('raises SCREEN_VIDEO_MAX_INFLIGHT for 30fps bursts and reconfigures VideoDecoder across portrait-landscape rotation', async () => {
    expect(SCREEN_VIDEO_MAX_INFLIGHT).toBe(12);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const configuredCalls: Array<Record<string, unknown>> = [];
    const decodeCalls: Array<{ type: string; timestamp: number; data: Uint8Array }> = [];
    let outputCb: ((frame: { displayWidth: number; displayHeight: number; close: () => void }) => void) | null = null;

    class MockVideoDecoder {
      static isConfigSupported = vi.fn(async (cfg: Record<string, unknown>) => ({
        supported: Boolean(cfg.description),
      }));
      constructor(init: { output: typeof outputCb; error: (err: Error) => void }) {
        outputCb = init.output;
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

    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    let pendingRaf: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      pendingRaf = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const videoListeners = new Set<(frame: ScreenVideoFrame) => void>();
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
      recordScreenViewerStats,
      subscribeScreenFrames: vi.fn(() => () => {}),
      subscribeScreenVideo: vi.fn((_id, listener) => {
        videoListeners.add(listener);
        return () => videoListeners.delete(listener);
      }),
    };

    const continuity = {
      peerFeatures: { [phone.peerId]: ['screen.source', 'screen.audio.capture'] as const },
      calls: [],
      screenShares: [{
        sessionId: 'bbbbbbbbbbbbbbbb',
        peerId: phone.peerId,
        peerName: 'moto g57 power',
        role: 'viewer' as const,
        state: 'active' as const,
        width: 576,
        height: 1280,
        maxWidth: 1280,
        maxFps: 30,
        frames: 1,
        fps: 30,
        kbps: 2400,
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
      root!.render(createElement(ContinuityCenter, { client, peers: [phone], continuity: continuity as never, initialTab: 'screen', onClose: () => {} }));
    });

    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    const idr = new Uint8Array([0x65, 0x88, 0x84]);
    const spsPortrait = new Uint8Array([0x67, 0x42, 0xc0, 0x28, 0xda, 0x01]);
    // Same AVC profile/level string (avc1.42c028), different encoded resolution/SPS payload for landscape rotation
    const spsLandscape = new Uint8Array([0x67, 0x42, 0xc0, 0x28, 0xda, 0x02]);

    await act(async () => {
      for (const l of videoListeners) {
        l({ sessionId: 'bbbbbbbbbbbbbbbb', peerId: phone.peerId, seq: 1, codec: 'h264', width: 576, height: 1280, ptsMs: 0, keyFrame: true, data: annexBFrame(spsPortrait, pps, idr) });
      }
      await Promise.resolve();
      await new Promise((res) => setTimeout(res, 10));
    });
    expect(configuredCalls).toHaveLength(1);

    await act(async () => {
      for (const l of videoListeners) {
        l({ sessionId: 'bbbbbbbbbbbbbbbb', peerId: phone.peerId, seq: 2, codec: 'h264', width: 1280, height: 576, ptsMs: 33, keyFrame: true, data: annexBFrame(spsLandscape, pps, idr) });
      }
      await Promise.resolve();
      await new Promise((res) => setTimeout(res, 10));
    });
    expect(configuredCalls).toHaveLength(2);
    expect(decodeCalls).toHaveLength(2);

    const dropClose = vi.fn();
    const renderClose = vi.fn();
    act(() => {
      outputCb!({ displayWidth: 1280, displayHeight: 576, close: dropClose });
      outputCb!({ displayWidth: 1280, displayHeight: 576, close: renderClose });
    });
    expect(dropClose).toHaveBeenCalledTimes(1);
    expect(recordScreenViewerStats).toHaveBeenCalledWith({ framesDroppedBeforeDrawDelta: 1 });

    act(() => {
      pendingRaf!(16);
    });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(renderClose).toHaveBeenCalledTimes(1);
    expect(recordScreenViewerStats).toHaveBeenCalledWith({ framesDecodedDelta: 1, framesRenderedDelta: 1 });
  });

  it('supports native Fullscreen, webkitFullscreen, and WKWebView-safe expanded fallback with Escape & exit overlay button', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const frameListeners = new Set<(frame: ScreenFrame) => void>();
    const recordScreenViewerStats = vi.fn();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:frame'), revokeObjectURL: vi.fn() });

    const client: ContinuityClient = {
      requestContacts: vi.fn(async () => ({ contacts: [], total: 0, truncated: false })),
      shareContacts: vi.fn(),
      clearSharedContacts: vi.fn(),
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangUpCall: vi.fn(),
      dialNumber: vi.fn(),
      requestScreenShare: vi.fn(() => 'cccccccccccccccc'),
      stopScreenShare: vi.fn(),
      recordScreenViewerStats,
      subscribeScreenFrames: vi.fn((_id, l) => {
        frameListeners.add(l);
        return () => frameListeners.delete(l);
      }),
    };

    const continuity = {
      peerFeatures: { [phone.peerId]: ['screen.source'] as const },
      calls: [],
      screenShares: [{
        sessionId: 'cccccccccccccccc',
        peerId: phone.peerId,
        peerName: 'moto g57 power',
        role: 'viewer' as const,
        state: 'active' as const,
        width: 1280,
        height: 576,
        maxWidth: 1280,
        maxFps: 30,
        frames: 2,
        fps: 30,
        kbps: 2400,
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
      root!.render(createElement(ContinuityCenter, { client, peers: [phone], continuity: continuity as never, initialTab: 'screen', onClose: () => {} }));
    });
    act(() => {
      for (const l of frameListeners) {
        l({ sessionId: 'cccccccccccccccc', peerId: phone.peerId, seq: 1, width: 1280, height: 576, mimeType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8]) });
      }
    });

    const stage = container.querySelector('.screen-stage') as HTMLDivElement;
    // Simulate WKWebView rejecting standard requestFullscreen
    stage.requestFullscreen = vi.fn(async () => {
      throw new Error('Fullscreen disallowed');
    });

    const fsBtn = container.querySelector('button[aria-label="Full screen"]') as HTMLButtonElement;
    expect(fsBtn.disabled).toBe(false);
    await act(async () => {
      fsBtn.click();
      await Promise.resolve();
    });

    expect(stage.classList.contains('is-expanded-fullscreen')).toBe(true);
    expect(container.querySelector('.screen-fullscreen-exit')).not.toBeNull();
    expect(recordScreenViewerStats).toHaveBeenCalledWith({
      fullscreenMode: 'fallback',
      lastFullscreenError: 'Fullscreen disallowed',
    });

    // Pressing Escape exits fallback fullscreen cleanly
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await Promise.resolve();
    });
    expect(stage.classList.contains('is-expanded-fullscreen')).toBe(false);
    expect(recordScreenViewerStats).toHaveBeenCalledWith({ fullscreenMode: 'none' });

    // Native fullscreen path + exitStageFullscreen helper
    let activeEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => activeEl });
    document.exitFullscreen = vi.fn(async () => { activeEl = null; });
    stage.requestFullscreen = vi.fn(async () => { activeEl = stage; });

    await act(async () => {
      (container!.querySelector('button[aria-label="Full screen"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(recordScreenViewerStats).toHaveBeenCalledWith({ fullscreenMode: 'native', lastFullscreenError: null });
    await act(async () => {
      (container!.querySelector('.screen-fullscreen-exit') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.exitFullscreen).toHaveBeenCalled();

    // Direct webkitRequestFullscreen path helper check
    const webkitEl = document.createElement('div') as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    webkitEl.webkitRequestFullscreen = vi.fn();
    expect(await requestStageFullscreen(webkitEl)).toEqual({ mode: 'webkit' });
    await exitStageFullscreen('fallback');
  });

  it('plays app audio via ScreenAudioPlayer without cross-clock PTS rejection and surfaces all audio telemetry', async () => {
    const startCalls: number[] = [];
    const resumed = vi.fn(async () => {
      ctxState = 'running';
    });
    let ctxState: AudioContextState = 'suspended';
    const gainConnect = vi.fn();
    const mockGain = { gain: { value: 1 }, connect: gainConnect, disconnect: vi.fn() };
    const createdNodes: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; buffer: { duration: number } }> = [];

    class MockAudioContext {
      sampleRate = 48_000;
      currentTime = 1.0;
      get state() { return ctxState; }
      destination = {};
      resume = resumed;
      close = vi.fn(async () => {});
      createGain = vi.fn(() => mockGain);
      createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
        const chData = Array.from({ length: channels }, () => new Float32Array(length));
        return { duration: length / sampleRate, getChannelData: (c: number) => chData[c]! };
      });
      createBufferSource = vi.fn(() => {
        const node = {
          buffer: null as unknown as { duration: number },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn((when?: number) => { startCalls.push(when ?? 0); }),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        createdNodes.push(node);
        return node;
      });
    }

    const statsHistory: ScreenAudioPlayerStats[] = [];
    const player = new ScreenAudioPlayer({
      AudioContextCtor: MockAudioContext as unknown as typeof AudioContext,
      onStats: (s) => statsHistory.push(s),
    });
    await player.start();
    expect(resumed).toHaveBeenCalled();
    expect(gainConnect).toHaveBeenCalled();
    expect(startCalls[0]).toBe(0); // 1-sample WebKit unlock buffer

    // Non-zero PCM packet with completely arbitrary source ptsMs must still play smoothly in [1.015, 1.30]
    const pcmNonZero = new Uint8Array(960 * 2 * 2);
    new DataView(pcmNonZero.buffer).setInt16(0, 12000, true);
    expect(hasNonZeroPcm16(pcmNonZero)).toBe(true);
    expect(computePcm16Rms(pcmNonZero)).toBeGreaterThan(0);

    player.playFrame({ sampleRate: 48_000, channels: 2, frames: 960, ptsMs: 99_999_999, data: pcmNonZero });
    player.playFrame({ sampleRate: 48_000, channels: 2, frames: 960, ptsMs: 100_000_019, data: pcmNonZero });
    expect(startCalls[1]).toBeCloseTo(1.05, 4);
    expect(startCalls[2]).toBeCloseTo(1.07, 4);
    expect(player.getStats()).toMatchObject({
      contextState: 'running',
      sampleRate: 48_000,
      framesReceived: 2,
      framesPlayed: 2,
      nonZeroFrames: 2,
      silentFrames: 0,
    });
    player.dispose();

    // Verify ContinuityManager serializes screen-audio decryption, allows equal-ms monotonic seq, and populates extended diagnostics
    const peerId = phone.peerId;
    const key = await crypto.webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(0x2b), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const host: ContinuityHost = {
      sendControl: vi.fn(async () => {}),
      sendFrame: vi.fn(() => true),
      sessionKey: async (id) => (id === peerId ? key : null),
      peer: (id) => (id === peerId ? phone : undefined),
      isAuthorized: (id) => id === peerId,
      isPaired: (id) => id === peerId,
      peerIds: () => [peerId],
      emit: () => {},
    };
    const manager = new ContinuityManager(host);
    const sid = manager.requestScreenShare(peerId, { maxWidth: 1280, maxFps: 30 });
    await manager.handleControl(peerId, { kind: 'screen-share-state', sessionId: sid, state: 'active', width: 576, height: 1280, audio: true });

    const delivered: ScreenAudioFrame[] = [];
    manager.subscribeScreenAudio(sid, (f) => delivered.push(f));

    const makeAudioPacket = async (seq: number, ptsMs: number) => {
      const aad = encodeScreenAudioAad({ sessionId: sid, seq, sampleRate: 48_000, channels: 2, frames: 960, ptsMs });
      const enc = await encryptMediaFrame(key, aad, pcmNonZero);
      return encodeScreenAudioFrame(aad, enc.iv, enc.ciphertext);
    };

    const p1 = await makeAudioPacket(1, 100);
    const p2 = await makeAudioPacket(2, 100); // same ms boundary on newer seq MUST NOT be dropped
    const pStale = await makeAudioPacket(3, 50); // stale backward PTS MUST be dropped

    await Promise.all([
      manager.handleScreenAudioFrame(peerId, p1),
      manager.handleScreenAudioFrame(peerId, p2),
      manager.handleScreenAudioFrame(peerId, pStale),
    ]);

    expect(delivered.map((d) => d.seq)).toEqual([1, 2]);
    expect(FRAME_SCREEN_AUDIO).toBe(0x05);
    const diag = manager.getDiagnostics();
    expect(diag.screenShare).toMatchObject({
      activeSessions: 1,
      targetFps: 30,
      audioFramesReceived: 2,
      audioFramesDroppedStale: 1,
      audioFramesDroppedDecrypt: 0,
    });
    manager.destroy();
  });

  it('CallAudioSession uses native hardware sampleRate + resamples mic and CallRow clears Mac audio active on phone rejection', async () => {
    const contextCtorArgs: unknown[] = [];
    let ctxState: AudioContextState = 'running';
    const resumed = vi.fn(async () => { ctxState = 'running'; });
    const playbackStarts: number[] = [];
    const mockTrack = { enabled: true, stop: vi.fn() };
    const mockGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const mockSource = { connect: vi.fn(), disconnect: vi.fn() };
    const mockScript = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as ((e: unknown) => void) | null };

    class HardwareRateAudioContext {
      sampleRate = 48_000;
      currentTime = 2.0;
      get state() { return ctxState; }
      destination = {};
      constructor(opts?: unknown) {
        if (opts !== undefined) contextCtorArgs.push(opts);
      }
      resume = resumed;
      close = vi.fn(async () => {});
      createGain = () => mockGain;
      createMediaStreamSource = () => mockSource;
      createScriptProcessor = () => mockScript;
      createBuffer = (channels: number, length: number, sampleRate: number) => {
        const arrays = Array.from({ length: channels }, () => new Float32Array(length));
        return { duration: length / sampleRate, getChannelData: (ch: number) => arrays[ch]! };
      };
      createBufferSource = () => ({
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn((when?: number) => { playbackStarts.push(when ?? 0); }),
        stop: vi.fn(),
        onended: null,
      });
    }

    const sentToPhone: Array<{ sr: number; ch: number; frames: number; ptsMs: number; bytes: number }> = [];
    const sessionStats: CallAudioSessionStats[] = [];
    let incomingCb: ((f: { sampleRate: number; channels: number; frames: number; ptsMs: number; data: Uint8Array }) => void) | null = null;
    const callId = '0123456789abcdef';

    const session = new CallAudioSession({
      peerId: phone.peerId,
      callId,
      getUserMedia: async () => ({ getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] }) as unknown as MediaStream,
      AudioContextCtor: HardwareRateAudioContext as unknown as typeof AudioContext,
      sendFrame: (data, sr, ch, frames, ptsMs) => {
        sentToPhone.push({ sr, ch, frames, ptsMs, bytes: data.byteLength });
        return true;
      },
      subscribeIncoming: (cb) => {
        incomingCb = cb;
        return () => { incomingCb = null; };
      },
      onStats: (s) => sessionStats.push(s),
    });

    await session.start();
    // Native sample rate chosen (no restrictive 16000 constraint passed to AudioContext ctor)
    expect(contextCtorArgs).toHaveLength(0);
    // Feed 48 kHz chunk -> resampled cleanly into 16 kHz / 320-sample packets
    session.handleMicChunk(new Float32Array(960).fill(0.2), 48_000);
    expect(sentToPhone).toHaveLength(1);
    expect(sentToPhone[0]).toEqual({ sr: CALL_AUDIO_SAMPLE_RATE, ch: 1, frames: CALL_AUDIO_FRAME_SAMPLES, ptsMs: 0, bytes: 640 });

    // Suspended AudioContext gets resumed on incoming call audio frame
    ctxState = 'suspended';
    const incomingPcm = new Uint8Array(640);
    new DataView(incomingPcm.buffer).setInt16(0, 6000, true);
    incomingCb!({ sampleRate: 16_000, channels: 1, frames: 320, ptsMs: 20, data: incomingPcm });
    expect(resumed).toHaveBeenCalled();
    expect(session.getStats()).toMatchObject({
      captureMode: 'script-processor',
      audioContextSampleRate: 48_000,
      micFramesCaptured: 1,
      micNonZeroFrames: 1,
      playbackFramesScheduled: 1,
      playbackNonZeroFrames: 1,
    });
    session.stop();

    // Verify CallRow UI reconciles immediately when phone responds with active=false
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    Object.assign(navigator, {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] })),
      },
    });
    Object.assign(window, { AudioContext: HardwareRateAudioContext });

    const recordCallAudioStats = vi.fn();
    const client: ContinuityClient = {
      requestContacts: vi.fn(async () => ({ contacts: [], total: 0, truncated: false })),
      shareContacts: vi.fn(),
      clearSharedContacts: vi.fn(),
      answerCall: vi.fn(),
      rejectCall: vi.fn(),
      hangUpCall: vi.fn(),
      dialNumber: vi.fn(),
      startCallAudio: vi.fn(async () => {}),
      stopCallAudio: vi.fn(async () => {}),
      setCallAudioMuted: vi.fn(async () => {}),
      sendCallAudio: vi.fn(async () => true),
      subscribeCallAudio: vi.fn(() => () => {}),
      recordCallAudioStats,
      requestScreenShare: vi.fn(() => 'dddddddddddddddd'),
      stopScreenShare: vi.fn(),
      subscribeScreenFrames: vi.fn(() => () => {}),
    };

    const baseSnap = {
      peerFeatures: { [phone.peerId]: ['calls.control', 'calls.audio'] as const },
      calls: [{
        callId,
        peerId: phone.peerId,
        peerName: 'moto g57 power',
        state: 'active' as const,
        direction: 'outgoing' as const,
        number: '9876543210',
        connectedAt: 1,
        updatedAt: 2,
        actions: ['hangup' as const],
      }],
      screenShares: [],
      screenRequests: [],
      sharedContacts: [],
      savedContacts: [],
      batteryStatus: {},
      callAudio: null as CallAudioStateView | null,
    };

    await act(async () => {
      root!.render(createElement(ContinuityCenter, { client, peers: [phone], continuity: baseSnap as never, initialTab: 'calls', onClose: () => {} }));
    });

    const useBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Use Mac Audio'))!;
    await act(async () => {
      useBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Mac audio active');
    expect(recordCallAudioStats).toHaveBeenCalled();

    // Phone rejects with active:false + reason -> Mac UI must immediately clear "Mac audio active" and show the reason
    await act(async () => {
      root!.render(createElement(ContinuityCenter, {
        client,
        peers: [phone],
        continuity: {
          ...baseSnap,
          callAudio: {
            peerId: phone.peerId,
            callId,
            active: false,
            muted: false,
            route: 'phone',
            reason: 'Microphone permission required on phone for Mac call audio.',
          },
        } as never,
        initialTab: 'calls',
        onClose: () => {},
      }));
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Mac audio active');
    expect(container.textContent).toContain('Use Mac Audio');
    expect(container.textContent).toContain('Microphone permission required on phone for Mac call audio.');

    // Active with warning reason (e.g. Android OS silenced background capture) keeps reason visible
    await act(async () => {
      root!.render(createElement(ContinuityCenter, {
        client,
        peers: [phone],
        continuity: {
          ...baseSnap,
          callAudio: {
            peerId: phone.peerId,
            callId,
            active: true,
            muted: false,
            route: 'computer',
            reason: 'Android silenced background microphone capture during this cellular call.',
          },
        } as never,
        initialTab: 'calls',
        onClose: () => {},
      }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Mac audio active');
    expect(container.textContent).toContain('Android silenced background microphone capture');
  });

  it('enables WKWebView element fullscreen, unrestricted media playback, AVFoundation mic permission check, and diagnostics in macOS shell & packaging scripts', () => {
    const swift = fs.readFileSync('scripts/mac_app.swift', 'utf8');
    const pkgSh = fs.readFileSync('scripts/package-mac-app.sh', 'utf8');
    const testSh = fs.readFileSync('scripts/test-mac-app.sh', 'utf8');
    const installSh = fs.readFileSync('install.sh', 'utf8');

    expect(swift).toContain('import AVFoundation');
    expect(swift).toContain('config.preferences.isElementFullscreenEnabled = true');
    expect(swift).toContain('window.collectionBehavior.insert(.fullScreenPrimary)');
    expect(swift).toContain('config.mediaTypesRequiringUserActionForPlayback = []');
    expect(swift).toContain('AVCaptureDevice.authorizationStatus(for: .audio)');
    expect(swift).toContain('AVCaptureDevice.requestAccess(for: .audio)');
    expect(swift).toContain('host == "::1"');
    expect(swift).toContain('"elementFullscreenEnabled": true');
    expect(swift).toContain('"mediaAutoplayUnrestricted": true');
    expect(swift).toContain('"microphoneAuthStatus": AppDelegate.microphoneAuthStatusString()');

    expect(pkgSh).toContain('-framework AVFoundation');
    expect(testSh).toContain('-framework AVFoundation');
    expect(installSh).toContain('-framework AVFoundation');
  });
});
