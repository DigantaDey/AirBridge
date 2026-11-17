/**
 * This-computer-only service controls: update availability (download happens
 * in the background; one click installs and restarts) and "Copy diagnostics"
 * for support requests. Hidden on phones and remote pages.
 */
import { useCallback, useEffect, useState } from 'react';

export interface UpdateStatusView {
  supported: boolean;
  current?: string;
  latest?: string | null;
  available?: boolean;
  state?: string;
  error?: string | null;
  releaseUrl?: string | null;
}

/** Copy text; falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
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
  let service: unknown;
  try {
    const res = await fetch('/api/diagnostics', { cache: 'no-store' });
    service = res.ok ? await res.json() : { error: `HTTP ${res.status}` };
  } catch (err) {
    service = { error: `service unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const report = {
    page: {
      url: `${window.location.protocol}//${window.location.host}${window.location.pathname}`,
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      online: navigator.onLine,
      ...page,
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

  const ready = update?.supported && update.available && update.state === 'ready';
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
      <button className="text-button service-bar-diagnostics" onClick={() => void diagnostics.copy()} disabled={diagnostics.state === 'copying'}>
        {diagnostics.label}
      </button>
    </div>
  );
}
