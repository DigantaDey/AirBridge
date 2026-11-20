export interface ScreenAudioPlayerStats {
  contextState: string;
  sampleRate: number;
  framesReceived: number;
  framesPlayed: number;
  nonZeroFrames: number;
  silentFrames: number;
  lastRms: number;
  lastError: string | null;
}

export interface ScreenAudioPlayerOptions {
  AudioContextCtor?: typeof AudioContext;
  onStats?: (stats: ScreenAudioPlayerStats) => void;
}

/** Normalized RMS in [0, 1] across signed 16-bit little-endian PCM bytes. */
export function computePcm16Rms(data: Uint8Array, byteLength = data.byteLength): number {
  const sampleCount = Math.floor(Math.min(byteLength, data.byteLength) / 2);
  if (sampleCount <= 0) return 0;
  const view = new DataView(data.buffer, data.byteOffset, sampleCount * 2);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true) / 0x8000;
    sumSquares += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSquares / sampleCount));
}

/** True when at least one S16LE sample meets or exceeds |threshold|. */
export function hasNonZeroPcm16(data: Uint8Array, byteLength = data.byteLength, threshold = 2): boolean {
  const sampleCount = Math.floor(Math.min(byteLength, data.byteLength) / 2);
  if (sampleCount <= 0) return false;
  const view = new DataView(data.buffer, data.byteOffset, sampleCount * 2);
  const cutoff = Math.max(1, threshold);
  for (let i = 0; i < sampleCount; i += 1) {
    if (Math.abs(view.getInt16(i * 2, true)) >= cutoff) return true;
  }
  return false;
}

/**
 * Web Audio player for shared Android app playback PCM packets.
 *
 * Schedules packets solely against the local AudioContext clock with a
 * bounded jitter window (immune to cross-stream video/audio clock mismatches)
 * and synchronously unlocks WebKit/WKWebView output on user interaction.
 */
export class ScreenAudioPlayer {
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private readonly activeNodes = new Set<AudioBufferSourceNode>();
  private playhead = 0;
  private disposed = false;

  private framesReceived = 0;
  private framesPlayed = 0;
  private nonZeroFrames = 0;
  private silentFrames = 0;
  private lastRms = 0;
  private lastError: string | null = null;

  constructor(private readonly opts: ScreenAudioPlayerOptions = {}) {}

  private resolveAudioContextCtor(): typeof AudioContext | undefined {
    if (this.opts.AudioContextCtor) return this.opts.AudioContextCtor;
    if (typeof window === 'undefined') return undefined;
    return (
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    );
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (this.context) return this.context;
    const Ctor = this.resolveAudioContextCtor();
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.context = ctx;
    if (typeof ctx.createGain === 'function') {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(ctx.destination);
      this.gainNode = gain;
    }
    return ctx;
  }

  private emitStats(force = false): void {
    if (!this.opts.onStats) return;
    if (!force && this.framesReceived > 1 && this.framesReceived % 10 !== 0) return;
    this.opts.onStats(this.getStats());
  }

  public getStats(): ScreenAudioPlayerStats {
    return {
      contextState: this.context?.state ?? 'uninitialized',
      sampleRate: this.context?.sampleRate ?? 0,
      framesReceived: this.framesReceived,
      framesPlayed: this.framesPlayed,
      nonZeroFrames: this.nonZeroFrames,
      silentFrames: this.silentFrames,
      lastRms: this.lastRms,
      lastError: this.lastError,
    };
  }

  /** Must be invoked synchronously inside the user's click handler so WebKit allows playback. */
  public async start(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) {
      const err = new Error('This browser cannot play the shared app audio.');
      this.lastError = err.message;
      this.emitStats(true);
      throw err;
    }
    this.lastError = null;
    try {
      if (typeof ctx.createBuffer === 'function' && typeof ctx.createBufferSource === 'function') {
        const unlockBuf = ctx.createBuffer(1, 1, ctx.sampleRate || 48_000);
        const unlockNode = ctx.createBufferSource();
        unlockNode.buffer = unlockBuf;
        unlockNode.connect(this.gainNode ?? ctx.destination);
        unlockNode.start(0);
      }
    } catch {
      // Ignore synthetic unlock failure on mock AudioContexts
    }
    try {
      if (typeof ctx.resume === 'function') {
        await ctx.resume();
      }
      this.emitStats(true);
    } catch {
      const err = new Error('Allow audio playback in this browser, then try again.');
      this.lastError = err.message;
      this.emitStats(true);
      throw err;
    }
  }

  public playFrame(frame: { sampleRate: number; channels: number; frames: number; ptsMs: number; data: Uint8Array }): void {
    const ctx = this.context;
    if (
      this.disposed ||
      !ctx ||
      frame.frames <= 0 ||
      frame.channels < 1 ||
      frame.data.byteLength < frame.frames * frame.channels * 2
    ) {
      return;
    }
    this.framesReceived += 1;
    const expectedBytes = frame.frames * frame.channels * 2;
    this.lastRms = computePcm16Rms(frame.data, expectedBytes);
    if (hasNonZeroPcm16(frame.data, expectedBytes)) {
      this.nonZeroFrames += 1;
    } else {
      this.silentFrames += 1;
    }

    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      void ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    if (this.playhead < now + 0.015 || this.playhead > now + 0.30) {
      this.playhead = now + 0.05;
    }

    const buffer = ctx.createBuffer(frame.channels, frame.frames, frame.sampleRate);
    const view = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    for (let ch = 0; ch < frame.channels; ch += 1) {
      const samples = buffer.getChannelData(ch);
      for (let i = 0; i < frame.frames; i += 1) {
        const byteOffset = (i * frame.channels + ch) * 2;
        if (byteOffset + 1 >= frame.data.byteLength) break;
        samples[i] = view.getInt16(byteOffset, true) / 0x8000;
      }
    }

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gainNode ?? ctx.destination);
    this.activeNodes.add(node);
    node.onended = () => {
      this.activeNodes.delete(node);
      try { node.disconnect(); } catch { /* already disconnected */ }
    };
    node.start(this.playhead);
    this.playhead += buffer.duration;
    this.framesPlayed += 1;
    this.emitStats(this.framesReceived === 1);
  }

  public stop(): void {
    for (const node of this.activeNodes) {
      try { node.stop(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
    this.activeNodes.clear();
    this.playhead = 0;
    this.emitStats(true);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    try { this.gainNode?.disconnect(); } catch { /* ignore */ }
    this.gainNode = null;
    if (this.context) {
      void this.context.close?.().catch(() => {});
      this.context = null;
    }
  }
}
