/**
 * This-computer-only service controls: update availability (download happens
 * in the background; one click installs and restarts; staged rollouts can be
 * skipped by asking), crash reports (reviewed in full, sent only on request)
 * and "Copy diagnostics" for support requests. Hidden on phones and remote pages.
 */
import { useCallback, useEffect, useState } from 'react';
import { UI_VERSION } from '../engine/buildInfo.js';
import { canRestartLocalService, copyTextToDesktopShell, openExternalInDesktopShell } from '../engine/desktopShell.js';
import { HandoffPrompt } from './HandoffPrompt.js';

export interface ClientErrorRingEntry {
  source: string;
  message: string;
  at: number;
}

const MAX_CLIENT_ERROR_RING = 30;
const globalClientErrorRing: ClientErrorRingEntry[] = [];
let globalListenersAttached = false;

export function recordClientDiagnosticError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  globalClientErrorRing.push({
    source,
    message: message.slice(0, 300),
    at: Date.now(),
  });
  if (globalClientErrorRing.length > MAX_CLIENT_ERROR_RING) {
    globalClientErrorRing.splice(0, globalClientErrorRing.length - MAX_CLIENT_ERROR_RING);
  }
}

export function getClientErrorRing(): ClientErrorRingEntry[] {
  return [...globalClientErrorRing];
}

function ensureGlobalErrorListeners(): void {
  if (globalListenersAttached || typeof window === 'undefined') return;
  globalListenersAttached = true;
  window.addEventListener('error', (event) => {
    recordClientDiagnosticError('window.onerror', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordClientDiagnosticError('unhandledrejection', event.reason);
  });
}
ensureGlobalErrorListeners();

export interface UpdateStatusView {
  supported: boolean;
  current?: string;
  latest?: string | null;
  available?: boolean;
  state?: string;
  error?: string | null;
  releaseUrl?: string | null;
  rollout?: { eligible: boolean; percent: number; halted: boolean; eligibleAt: string | null; forced: boolean; reason: string } | null;
}

export interface CrashSummaryView {
  id: string;
  createdAt: string;
  kind: string;
  version: string;
  title: string;
  sent: boolean;
}

interface CrashListView {
  supported?: boolean;
  sendVia?: 'sentry' | 'github';
  reports?: CrashSummaryView[];
}

/** Copy text; falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the native macOS clipboard, then browser fallback */ }
  if (copyTextToDesktopShell(text)) return true;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Service report from /api/diagnostics, plus what this page knows (works even when the service is down). */
export async function collectDiagnostics(page: Record<string, unknown> = {}): Promise<string> {
  ensureGlobalErrorListeners();
  let service: unknown;
  try {
    const res = await fetch('/api/diagnostics', { cache: 'no-store' });
    service = res.ok ? await res.json() : { error: `HTTP ${res.status}` };
  } catch (err) {
    service = { error: `service unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const pageErrorRing = Array.isArray(page.clientErrorRing) ? page.clientErrorRing : [];
  const mergedErrorRing = [...globalClientErrorRing, ...pageErrorRing].slice(-MAX_CLIENT_ERROR_RING);
  const report = {
    page: {
      url: `${window.location.protocol}//${window.location.host}${window.location.pathname}`,
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      online: navigator.onLine,
      uiVersion: UI_VERSION ?? 'dev',
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : 0,
        height: typeof window !== 'undefined' ? window.innerHeight : 0,
      },
      wsCloseCode: null,
      wsCloseReason: '',
      reconnectAttempts: 0,
      rtcState: {},
      transferErrors: [],
      fallbackTimerFires: 0,
      transferResumes: 0,
      transferChunkRetries: 0,
      lastFinalizeDurationMs: null,
      screenShare: null,
      contacts: null,
      callAudio: null,
      clipboardBridge: null,
      ...page,
      clientErrorRing: mergedErrorRing,
    },
    service,
  };
  return `AirBridge diagnostics\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

export function useDiagnosticsCopy(page: Record<string, unknown>) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const copy = useCallback(async () => {
    setState('copying');
    const ok = await copyText(await collectDiagnostics(page));
    setState(ok ? 'copied' : 'failed');
    window.setTimeout(() => setState('idle'), 2500);
  }, [page]);
  const label = state === 'copied' ? 'Diagnostics copied' : state === 'failed' ? 'Copy failed' : state === 'copying' ? 'Collecting…' : 'Copy diagnostics';
  return { copy, label, state };
}

export function ServiceStatusBar({ page, connected }: { page: Record<string, unknown>; connected: boolean }) {
  const [update, setUpdate] = useState<UpdateStatusView | null>(null);
  const [installing, setInstalling] = useState(false);
  const diagnostics = useDiagnosticsCopy(page);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!connected) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/update', { cache: 'no-store' });
        if (res.ok && !cancelled) setUpdate((await res.json()) as UpdateStatusView);
      } catch { /* service restarting */ }
    };
    void load();
    const timer = window.setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connected]);

  const install = async () => {
    setInstalling(true);
    try {
      const res = await fetch('/api/update/install', { method: 'POST' });
      const next = (await res.json()) as UpdateStatusView;
      setUpdate(next);
      if (next.state !== 'installed') setInstalling(false);
      // On success the service restarts; the page reconnects and reloads by itself.
    } catch {
      setInstalling(false);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      if (res.ok) setUpdate((await res.json()) as UpdateStatusView);
    } catch { /* offline */ }
    setChecking(false);
  };

  const ready = update?.supported && update.available && update.state === 'ready';
  const deferred = update?.supported && update.available && update.state === 'deferred' ? update : null;
  const restarting = installing || update?.state === 'installed';
  return (
    <div className="service-bar">
      {ready || restarting ? (
        <div className="update-note" role="status">
          <span>
            <strong>{restarting ? `Updating AirBridge to ${update?.latest ?? 'the new version'}…` : `AirBridge ${update?.latest} is ready`}</strong>
            <small>{restarting
              ? 'The service restarts and this page reconnects by itself.'
              : 'Downloaded and verified in the background. Installing restarts the service for a few seconds.'}</small>
            {update?.state === 'error' && update.error ? <small>{update.error}</small> : null}
          </span>
          <span className="update-actions">
            {update?.releaseUrl ? <a className="text-button" href={update.releaseUrl} target="_blank" rel="noreferrer">What&apos;s new</a> : null}
            <button className="text-button" disabled={installing} onClick={() => void install()}>{installing ? 'Restarting…' : 'Restart to update'}</button>
          </span>
        </div>
      ) : null}
      {deferred && !restarting ? (
        <div className="update-note update-note-quiet" role="status">
          <span>
            <strong>AirBridge {deferred.latest} is rolling out</strong>
            <small>{describeRollout(deferred.rollout)}</small>
          </span>
          <span className="update-actions">
            {deferred.releaseUrl ? <a className="text-button" href={deferred.releaseUrl} target="_blank" rel="noreferrer">What&apos;s new</a> : null}
            <button className="text-button" disabled={checking} onClick={() => void checkNow()}>{checking ? 'Downloading…' : 'Get it now'}</button>
          </span>
        </div>
      ) : null}
      {connected ? <HandoffPrompt /> : null}
      {connected ? <CrashReports /> : null}
      <button className="text-button service-bar-diagnostics" onClick={() => void diagnostics.copy()} disabled={diagnostics.state === 'copying'}>
        {diagnostics.label}
      </button>
    </div>
  );
}

function describeRollout(rollout: UpdateStatusView['rollout']): string {
  if (!rollout) return 'Updates reach computers gradually.';
  if (rollout.halted) return 'The rollout is paused while an issue is looked into. You can still install it yourself.';
  if (/rolled back/.test(rollout.reason)) return 'This version did not start correctly here and was undone. AirBridge waits for the next fix.';
  const when = rollout.eligibleAt ? new Date(rollout.eligibleAt) : null;
  const whenText = when && !Number.isNaN(when.getTime()) ? ` It arrives here automatically around ${when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
  return `Updates reach computers gradually (${rollout.percent}% so far) so problems are caught early.${whenText}`;
}

/** Recent crashes on this computer: review exactly what would be sent, then send or dismiss. */
export function CrashReports() {
  const [list, setList] = useState<CrashListView | null>(null);
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/crashes', { cache: 'no-store' });
      if (res.ok) setList((await res.json()) as CrashListView);
    } catch { /* service restarting */ }
  }, []);
  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);

  const pending = (Array.isArray(list?.reports) ? list.reports : []).filter((r) => !r.sent);
  if (!list?.supported || pending.length === 0) return null;
  const latest = pending[0]!;

  const review = async () => {
    if (preview) { setPreview(null); return; }
    try {
      const res = await fetch(`/api/crashes/${encodeURIComponent(latest.id)}`, { cache: 'no-store' });
      setPreview({ id: latest.id, text: JSON.stringify(await res.json(), null, 2) });
    } catch { setMessage('Could not load the report.'); }
  };
  const send = async () => {
    setBusy('send');
    const inMacShell = canRestartLocalService();
    // In regular browsers, open the tab synchronously (popup blockers), then point it at the issue form.
    // Inside macOS WKWebView, about:blank has no external URL to hand to NSWorkspace, so open after fetch.
    const win = !inMacShell && list.sendVia === 'github' ? window.open('about:blank', '_blank') : null;
    try {
      const res = await fetch(`/api/crashes/${encodeURIComponent(latest.id)}/send`, { method: 'POST' });
      const result = (await res.json()) as { via?: string; url?: string; error?: string };
      if (!res.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
      if (result.via === 'github' && result.url) {
        if (win) {
          win.location.href = result.url;
        } else if (!openExternalInDesktopShell(result.url)) {
          window.open(result.url, '_blank', 'noopener');
        }
        setMessage('Opened a prefilled GitHub issue. Review it there and press Submit.');
      } else {
        win?.close();
        setMessage('Report sent. Thank you!');
      }
      setPreview(null);
      await load();
    } catch (err) {
      win?.close();
      setMessage(`Sending failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setBusy(null);
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try { await fetch(`/api/crashes/${encodeURIComponent(latest.id)}`, { method: 'DELETE' }); } catch { /* ignore */ }
    setPreview(null);
    setBusy(null);
    await load();
  };

  const when = new Date(latest.createdAt);
  return (
    <div className="update-note crash-note" role="status">
      <span>
        <strong>{latest.kind === 'abnormal-exit' ? 'AirBridge stopped unexpectedly' : 'AirBridge hit an unexpected error'}{pending.length > 1 ? ` (${pending.length} reports)` : ''}</strong>
        <small>
          {Number.isNaN(when.getTime()) ? '' : `${when.toLocaleString()} · `}version {latest.version}. It restarted by itself. A report with no personal data
          (addresses, names, codes and keys are removed) can help fix it. Nothing is sent unless you choose to.
        </small>
        {message ? <small>{message}</small> : null}
      </span>
      <span className="update-actions">
        <button className="text-button" onClick={() => void review()}>{preview ? 'Hide report' : 'Review report'}</button>
        <button className="text-button" disabled={busy !== null} onClick={() => void send()}>{list.sendVia === 'github' ? 'Report on GitHub' : 'Send report'}</button>
        <button className="text-button" disabled={busy !== null} onClick={() => void dismiss()}>Dismiss</button>
      </span>
      {preview ? <pre className="crash-preview" aria-label="Crash report contents">{preview.text}</pre> : null}
    </div>
  );
}
