import {
  CALL_AUDIO_CHANNELS,
  CALL_AUDIO_FRAME_SAMPLES,
  CALL_AUDIO_SAMPLE_RATE,
} from '../../shared/continuity.js';
import { computePcm16Rms, hasNonZeroPcm16 } from './screenAudio.js';

export interface CallAudioSessionStats {
  captureMode: 'worklet' | 'script-processor' | 'none';
  audioContextState: string;
  audioContextSampleRate: number;
  micFramesCaptured: number;
  micNonZeroFrames: number;
  micLastRms: number;
  playbackFramesScheduled: number;
  playbackNonZeroFrames: number;
  playbackSilentFrames: number;
  playbackLastRms: number;
}

export interface CallAudioSessionOptions {
  peerId: string;
  callId: string;
  sampleRate?: number;
  sendFrame: (pcmS16le: Uint8Array, sampleRate: number, channels: number, frames: number, ptsMs: number) => boolean | void;
  subscribeIncoming: (listener: (frame: { sampleRate: number; channels: number; frames: number; ptsMs: number; data: Uint8Array }) => void) => () => void;
  onError?: (message: string) => void;
  onStats?: (stats: CallAudioSessionStats) => void;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextCtor?: typeof AudioContext;
}

function float32Rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Convert mono/multi Float32 samples in [-1, 1] to packed S16LE bytes. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    const intVal = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, intVal, true);
  }
  return out;
}

/** Convert packed S16LE bytes to normalized Float32Array for a specific channel. */
export function pcm16ToFloat32(data: Uint8Array, frames: number, channels: number, channelIndex = 0): Float32Array {
  const out = new Float32Array(frames);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i += 1) {
    const byteOffset = (i * channels + channelIndex) * 2;
    if (byteOffset + 1 >= data.byteLength) break;
    out[i] = view.getInt16(byteOffset, true) / 0x8000;
  }
  return out;
}

/** Linear-interpolation resampler for real-time voice audio frames. */
export function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[Math.min(idx, input.length - 1)]!;
    const b = input[Math.min(idx + 1, input.length - 1)]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

const CAPTURE_WORKLET_CODE = `
class AirBridgeMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('airbridge-mic-processor', AirBridgeMicProcessor);
`;

/**
 * Full-duplex Web Audio session for MacBook continuity calls:
 * captures echo-cancelled microphone speech into 20 ms 16 kHz mono S16LE
 * packets and plays back encrypted incoming voice packets with a bounded
 * jitter buffer.
 */
export class CallAudioSession {
  private readonly targetSampleRate: number;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private sinkGain: GainNode | null = null;
  private playbackGain: GainNode | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly playbackNodes = new Set<AudioBufferSourceNode>();
  private workletUrl: string | null = null;
  private residual = new Float32Array(0);
  private playhead = 0;
  private emittedSamples = 0;
  private started = false;
  private stopped = false;
  private muted = false;

  private captureMode: 'worklet' | 'script-processor' | 'none' = 'none';
  private micFramesCaptured = 0;
  private micNonZeroFrames = 0;
  private micLastRms = 0;
  private playbackFramesScheduled = 0;
  private playbackNonZeroFrames = 0;
  private playbackSilentFrames = 0;
  private playbackLastRms = 0;

  constructor(private readonly opts: CallAudioSessionOptions) {
    this.targetSampleRate = opts.sampleRate ?? CALL_AUDIO_SAMPLE_RATE;
  }

  public getStats(): CallAudioSessionStats {
    return {
      captureMode: this.captureMode,
      audioContextState: this.context?.state ?? 'uninitialized',
      audioContextSampleRate: this.context?.sampleRate ?? 0,
      micFramesCaptured: this.micFramesCaptured,
      micNonZeroFrames: this.micNonZeroFrames,
      micLastRms: this.micLastRms,
      playbackFramesScheduled: this.playbackFramesScheduled,
      playbackNonZeroFrames: this.playbackNonZeroFrames,
      playbackSilentFrames: this.playbackSilentFrames,
      playbackLastRms: this.playbackLastRms,
    };
  }

  private emitStats(force = false): void {
    if (!this.opts.onStats) return;
    const total = this.micFramesCaptured + this.playbackFramesScheduled;
    if (!force && total > 2 && total % 10 !== 0) return;
    this.opts.onStats(this.getStats());
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
  }

  public async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.emittedSamples = 0;

    const getUserMedia =
      this.opts.getUserMedia ??
      ((constraints: MediaStreamConstraints) => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          return Promise.reject(new Error('Microphone capture is not available in this browser.'));
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      });

    const AudioContextCtor =
      this.opts.AudioContextCtor ??
      (typeof window !== 'undefined'
        ? (window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined);
    if (!AudioContextCtor) {
      throw new Error('Web Audio playback is not available in this browser.');
    }

    const stream = await getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: CALL_AUDIO_CHANNELS,
        sampleRate: this.targetSampleRate,
      },
      video: false,
    });
    if (this.stopped) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.muted;
    }

    // Let macOS CoreAudio/WebKit run at native hardware sample rate (e.g. 48 kHz)
    // and resample captured speech cleanly to 16 kHz to prevent silent hardware rate mismatches.
    const context = new AudioContextCtor();
    this.context = context;
    if (typeof context.resume === 'function' && context.state === 'suspended') {
      await context.resume().catch(() => {});
    }
    if (this.stopped) {
      this.stop();
      return;
    }

    const source = context.createMediaStreamSource(stream);
    this.sourceNode = source;
    // Keep capture graph connected to destination through zero-gain sink so WebKit keeps firing process().
    const zeroGain = context.createGain();
    zeroGain.gain.value = 0;
    zeroGain.connect(context.destination);
    this.sinkGain = zeroGain;

    if (typeof context.createGain === 'function') {
      const outGain = context.createGain();
      outGain.gain.value = 1;
      outGain.connect(context.destination);
      this.playbackGain = outGain;
    }

    try {
      if (typeof context.createBuffer === 'function' && typeof context.createBufferSource === 'function') {
        const unlock = context.createBuffer(1, 1, context.sampleRate || 48_000);
        const unlockNode = context.createBufferSource();
        unlockNode.buffer = unlock;
        unlockNode.connect(this.playbackGain ?? context.destination);
        unlockNode.start(0);
      }
    } catch {
      // Ignore unlock failure on test mocks
    }

    let workletAttached = false;
    if (
      typeof context.audioWorklet?.addModule === 'function' &&
      typeof AudioWorkletNode !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      typeof Blob !== 'undefined'
    ) {
      try {
        const blob = new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' });
        this.workletUrl = URL.createObjectURL(blob);
        await context.audioWorklet.addModule(this.workletUrl);
        if (!this.stopped) {
          const node = new AudioWorkletNode(context, 'airbridge-mic-processor');
          node.port.onmessage = (event) => {
            if (event.data instanceof Float32Array) {
              this.handleMicChunk(event.data, context.sampleRate);
            }
          };
          source.connect(node);
          node.connect(zeroGain);
          this.workletNode = node;
          workletAttached = true;
          this.captureMode = 'worklet';
        }
      } catch {
        // Fall through to ScriptProcessorNode fallback when CSP/WKWebView blocks Blob AudioWorklet.
      }
    }

    if (!workletAttached && !this.stopped && typeof context.createScriptProcessor === 'function') {
      const processor = context.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const channel = event.inputBuffer.getChannelData(0);
        if (channel && channel.length > 0) {
          this.handleMicChunk(new Float32Array(channel), context.sampleRate);
        }
      };
      source.connect(processor);
      processor.connect(zeroGain);
      this.scriptNode = processor;
      this.captureMode = 'script-processor';
    }

    this.emitStats(true);
    this.unsubscribe = this.opts.subscribeIncoming((frame) => {
      this.schedulePlaybackFrame(frame);
    });
  }

  /** Capture entry point (also directly exercised in unit tests). */
  public handleMicChunk(samples: Float32Array, sourceSampleRate: number): void {
    if (this.stopped || samples.length === 0) return;
    if (this.muted) {
      this.residual = new Float32Array(0);
      return;
    }
    const resampled = resampleFloat32(samples, sourceSampleRate, this.targetSampleRate);
    if (resampled.length === 0) return;
    const combined = new Float32Array(this.residual.length + resampled.length);
    combined.set(this.residual, 0);
    combined.set(resampled, this.residual.length);

    let offset = 0;
    while (offset + CALL_AUDIO_FRAME_SAMPLES <= combined.length) {
      const frame = combined.subarray(offset, offset + CALL_AUDIO_FRAME_SAMPLES);
      const rms = float32Rms(frame);
      this.micFramesCaptured += 1;
      this.micLastRms = rms;
      if (rms > 1e-4) this.micNonZeroFrames += 1;
      const pcm = float32ToPcm16(frame);
      const ptsMs = Math.round((this.emittedSamples * 1000) / this.targetSampleRate) >>> 0;
      this.emittedSamples += CALL_AUDIO_FRAME_SAMPLES;
      try {
        this.opts.sendFrame(pcm, this.targetSampleRate, CALL_AUDIO_CHANNELS, CALL_AUDIO_FRAME_SAMPLES, ptsMs);
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err.message : 'Call audio send failed');
      }
      offset += CALL_AUDIO_FRAME_SAMPLES;
    }
    this.residual = offset < combined.length ? combined.slice(offset) : new Float32Array(0);
    if (offset > 0) this.emitStats(this.micFramesCaptured === 1);
  }

  /** Play back one incoming PCM S16LE packet on a bounded Web Audio timeline. */
  public schedulePlaybackFrame(frame: { sampleRate: number; channels: number; frames: number; ptsMs: number; data: Uint8Array }): void {
    const context = this.context;
    if (this.stopped || !context || frame.frames <= 0 || frame.data.byteLength < frame.frames * frame.channels * 2) return;
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      void context.resume().catch(() => {});
    }
    const expectedBytes = frame.frames * frame.channels * 2;
    const rms = computePcm16Rms(frame.data, expectedBytes);
    this.playbackFramesScheduled += 1;
    this.playbackLastRms = rms;
    if (hasNonZeroPcm16(frame.data, expectedBytes)) {
      this.playbackNonZeroFrames += 1;
    } else {
      this.playbackSilentFrames += 1;
    }
    const now = context.currentTime;
    // Clamp drift past 250ms so interactive call audio stays real-time.
    if (this.playhead < now + 0.015 || this.playhead > now + 0.25) {
      this.playhead = now + 0.04;
    }
    const buffer = context.createBuffer(frame.channels, frame.frames, frame.sampleRate);
    for (let ch = 0; ch < frame.channels; ch += 1) {
      const target = buffer.getChannelData(ch);
      target.set(pcm16ToFloat32(frame.data, frame.frames, frame.channels, ch));
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.playbackGain ?? context.destination);
    this.playbackNodes.add(node);
    node.onended = () => {
      this.playbackNodes.delete(node);
      try { node.disconnect(); } catch { /* already disconnected */ }
    };
    node.start(this.playhead);
    this.playhead += buffer.duration;
    this.emitStats(this.playbackFramesScheduled === 1);
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const node of this.playbackNodes) {
      try { node.stop(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
    }
    this.playbackNodes.clear();
    try { this.workletNode?.disconnect(); } catch { /* ignore */ }
    this.workletNode = null;
    try { this.scriptNode?.disconnect(); } catch { /* ignore */ }
    this.scriptNode = null;
    try { this.sourceNode?.disconnect(); } catch { /* ignore */ }
    this.sourceNode = null;
    try { this.sinkGain?.disconnect(); } catch { /* ignore */ }
    this.sinkGain = null;
    try { this.playbackGain?.disconnect(); } catch { /* ignore */ }
    this.playbackGain = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this.stream = null;
    }
    if (this.workletUrl && typeof URL.revokeObjectURL === 'function') {
      try { URL.revokeObjectURL(this.workletUrl); } catch { /* ignore */ }
      this.workletUrl = null;
    }
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    this.residual = new Float32Array(0);
    this.playhead = 0;
    this.emittedSamples = 0;
  }
}
