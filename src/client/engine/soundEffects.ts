let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function playNotes(
  notes: Array<{ freq: number; delay: number; duration: number; gain?: number; type?: OscillatorType }>,
  muted: boolean
): void {
  if (muted) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = note.type ?? 'sine';
      osc.frequency.setValueAtTime(note.freq, now + note.delay);

      const peak = note.gain ?? 0.08;
      gainNode.gain.setValueAtTime(0.0001, now + note.delay);
      gainNode.gain.exponentialRampToValueAtTime(peak, now + note.delay + 0.018);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + note.delay + note.duration);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(now + note.delay);
      osc.stop(now + note.delay + note.duration + 0.02);
    }
  } catch {
    // Ignore WebAudio restrictions before user gesture
  }
}

export function playIncomingChime(muted = false): void {
  // Crisp two-tone AirDrop-style interval (F5 -> C6)
  playNotes(
    [
      { freq: 698.46, delay: 0, duration: 0.22, gain: 0.075, type: 'sine' },
      { freq: 1046.5, delay: 0.11, duration: 0.34, gain: 0.085, type: 'sine' },
    ],
    muted
  );
}

export function playBeamSentPulse(muted = false): void {
  playNotes(
    [
      { freq: 523.25, delay: 0, duration: 0.14, gain: 0.055, type: 'triangle' },
      { freq: 783.99, delay: 0.07, duration: 0.18, gain: 0.06, type: 'sine' },
    ],
    muted
  );
}

export function playTransferCompleteChime(muted = false): void {
  // Warm major triad resolution (C5 -> E5 -> G5 -> C6)
  playNotes(
    [
      { freq: 523.25, delay: 0, duration: 0.16, gain: 0.05 },
      { freq: 659.25, delay: 0.06, duration: 0.2, gain: 0.06 },
      { freq: 783.99, delay: 0.12, duration: 0.24, gain: 0.065 },
      { freq: 1046.5, delay: 0.18, duration: 0.38, gain: 0.075 },
    ],
    muted
  );
}
