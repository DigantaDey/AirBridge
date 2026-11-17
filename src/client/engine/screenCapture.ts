/**
 * Browser screen capture for continuity screen sharing (getDisplayMedia).
 *
 * Frames are pulled, never pushed: ContinuityManager calls capture() only when
 * it has flow-control credit, so a slow link drops stale frames instead of
 * queueing them (latest frame wins). Each capture scales the current video
 * frame to fit `maxWidth` on its longer edge and encodes JPEG at the adaptive
 * quality the manager picked from the measured round trip.
 */
import type { CapturedScreenFrame, ScreenFrameSource } from './continuity.js';

/** getDisplayMedia exists and the page is a secure context (required by browsers). */
export function canCaptureScreen(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!window.isSecureContext) return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** Longer edge clamped to `maxEdge`, even dimensions (JPEG/YUV friendly). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

export interface DisplayMediaLike {
  getVideoTracks(): Array<{ stop(): void; addEventListener(type: 'ended', cb: () => void): void; readyState?: string }>;
  getTracks(): Array<{ stop(): void }>;
}

export interface ScreenSourceDeps {
  /** Video element fed by the stream (tests pass a fake). */
  video?: { videoWidth: number; videoHeight: number; srcObject: unknown; muted: boolean; playsInline?: boolean; play(): Promise<void> };
  canvas?: {
    width: number;
    height: number;
    getContext(type: '2d'): { drawImage(source: unknown, x: number, y: number, w: number, h: number): void } | null;
    toBlob(cb: (blob: Blob | null) => void, type: string, quality: number): void;
  };
}

/** Wraps a live display stream as a pull-based JPEG frame source. */
export function createStreamScreenSource(stream: DisplayMediaLike, deps: ScreenSourceDeps = {}): ScreenFrameSource {
  const video = deps.video ?? Object.assign(document.createElement('video'), { muted: true, playsInline: true });
  const canvas = deps.canvas ?? document.createElement('canvas');
  video.srcObject = stream;
  const ready = video.play().catch(() => undefined);
  let stopped = false;
  const endedCallbacks: Array<() => void> = [];
  const track = stream.getVideoTracks()[0];
  track?.addEventListener('ended', () => {
    if (stopped) return;
    stopped = true;
    for (const cb of endedCallbacks) cb();
  });

  return {
    async capture({ maxWidth, quality }): Promise<CapturedScreenFrame | null> {
      if (stopped) return null;
      await ready;
      const size = fitWithin(video.videoWidth, video.videoHeight, maxWidth);
      if (!size.width || !size.height) return null;
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || stopped) return null;
      return { data: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
    onEnded(callback) {
      endedCallbacks.push(callback);
    },
  };
}

/**
 * Asks the browser for a screen/window (its own picker is the second consent
 * step) and returns a frame source. Must run inside a user gesture.
 */
export async function startDisplayCapture(maxFps: number): Promise<ScreenFrameSource> {
  if (!canCaptureScreen()) throw new Error('Screen sharing needs a secure page in a browser that supports it.');
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: maxFps, max: maxFps } },
    audio: false,
  });
  return createStreamScreenSource(stream);
}
