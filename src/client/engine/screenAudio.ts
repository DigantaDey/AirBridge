/**
 * Plays decrypted screen-share audio (interleaved signed 16-bit PCM) through
 * Web Audio with a small jitter buffer. Chunks are scheduled back to back; if
 * the network stalls long enough for the queue to drain, playback restarts a
 * little ahead of "now" instead of bunching up, and if it falls too far behind
 * (e.g. the tab was throttled) the backlog is dropped to keep A/V close.
 */

/** Target delay between receiving audio and hearing it. */
const LEAD_SECONDS = 0.12;
/** Beyond this much queued audio the oldest backlog is discarded. */
const MAX_QUEUE_SECONDS = 0.6;

type AudioContextCtor = new (options?: { sampleRate?: number; latencyHint?: string }) => AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
}

/** True when this runtime can play screen audio. */
export function canPlayScreenAudio(): boolean {
  return typeof audioContextCtor() === 'function';
}

export class ScreenAudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private muted = false;
  private closed = false;

  /** Create (or resume) the audio context. Call from a click so autoplay rules allow it. */
  async unlock(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* still blocked */ }
    }
    return ctx.state === 'running';
  }

  /** "running" when audible; "suspended" means the browser wants a click first. */
  get state(): 'running' | 'suspended' | 'closed' | 'unavailable' {
    if (this.closed) return 'closed';
    if (!this.ctx) return canPlayScreenAudio() ? 'suspended' : 'unavailable';
    return this.ctx.state === 'running' ? 'running' : this.ctx.state === 'closed' ? 'closed' : 'suspended';
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Queue one chunk of interleaved PCM. */
  play(pcm: Int16Array, sampleRate: number, channels: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.gain || channels < 1 || channels > 2 || pcm.length < channels) return;
    const frames = Math.floor(pcm.length / channels);
    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    for (let c = 0; c < channels; c++) {
      const out = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = pcm[i * channels + c] / 32768;
    }
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.02 || this.nextTime - now > MAX_QUEUE_SECONDS) {
      this.nextTime = now + LEAD_SECONDS;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  close(): void {
    this.closed = true;
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    if (ctx) void ctx.close().catch(() => {});
  }

  private ensure(): AudioContext | null {
    if (this.closed) return null;
    if (this.ctx) return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
      this.nextTime = 0;
    } catch {
      this.ctx = null;
      this.gain = null;
    }
    return this.ctx;
  }
}
