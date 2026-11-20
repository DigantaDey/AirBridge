/**
 * Hotspot handoff on the computer: a paired phone offers its hotspot (over the
 * session or Bluetooth) and AirBridge asks here before joining it. Also shows
 * the active direct link and the "phone hotspots" policy.
 *
 * Localhost-only API (the server refuses other origins and remote peers), so
 * on any other page this renders nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type HandoffPolicyView = 'ask' | 'always' | 'off';

export interface HandoffOfferSummary {
  id: string;
  state: 'pending' | 'joining' | 'joined' | 'declined' | 'expired' | 'failed' | 'invalid' | 'ended';
  reason: string;
  deviceName: string;
  ssid: string;
  via: 'session' | 'bluetooth';
  createdAt: string;
  expiresAt: string;
}

export interface HandoffStatusView {
  enabled: boolean;
  policy?: HandoffPolicyView;
  unsupportedReason?: string | null;
  offers: HandoffOfferSummary[];
}

const POLL_IDLE_MS = 4000;
const POLL_ACTIVE_MS = 1500;

export function HandoffPrompt({ pollMs }: { pollMs?: { idle: number; active: number } } = {}) {
  const [status, setStatus] = useState<HandoffStatusView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const statusRef = useRef<HandoffStatusView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/handoff', { cache: 'no-store' });
      if (!res.ok) {
        statusRef.current = null;
        setStatus(null);
        return;
      }
      const next = (await res.json()) as HandoffStatusView;
      statusRef.current = next;
      setStatus(next);
    } catch { /* service restarting */ }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const idle = pollMs?.idle ?? POLL_IDLE_MS;
    const active = pollMs?.active ?? POLL_ACTIVE_MS;
    const tick = async () => {
      await load();
      if (cancelled) return;
      const offers = statusRef.current?.offers ?? [];
      const live = offers.some((o) => o.state === 'pending' || o.state === 'joining');
      timer = window.setTimeout(() => void tick(), live ? active : idle);
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [load, pollMs?.idle, pollMs?.active]);

  const post = async (key: string, url: string, init: RequestInit) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
    await load();
  };

  if (!status?.enabled) return null;
  const offers = Array.isArray(status.offers) ? status.offers : [];
  const pending = offers.find((o) => o.state === 'pending');
  const joining = offers.find((o) => o.state === 'joining');
  const joined = offers.find((o) => o.state === 'joined');
  const policy = status.policy ?? 'ask';

  const respond = (o: HandoffOfferSummary, allow: boolean, always = false) =>
    post(`respond-${o.id}`, `/api/handoff/${encodeURIComponent(o.id)}/respond`, {
      method: 'POST',
      body: JSON.stringify({ allow, always }),
    });
  const end = (o: HandoffOfferSummary) =>
    post(`end-${o.id}`, `/api/handoff/${encodeURIComponent(o.id)}/end`, { method: 'POST' });
  const setPolicy = (next: HandoffPolicyView) =>
    post('policy', '/api/handoff/settings', { method: 'PUT', body: JSON.stringify({ policy: next }) });

  const policyControl = (
    <label className="handoff-policy" title="When a paired phone offers its hotspot for a direct link">
      <span>Phone hotspots</span>
      <select
        aria-label="Phone hotspot handoff"
        value={policy}
        disabled={busy === 'policy'}
        onChange={(e) => void setPolicy(e.target.value as HandoffPolicyView)}
      >
        <option value="ask">Ask first</option>
        <option value="always">Join automatically</option>
        <option value="off">Never join</option>
      </select>
    </label>
  );

  if (pending) {
    const secondsLeft = Math.max(0, Math.round((Date.parse(pending.expiresAt) - now) / 1000));
    return (
      <>
        <div className="update-note handoff-note" role="alertdialog" aria-labelledby={`handoff-${pending.id}`}>
          <span>
            <strong id={`handoff-${pending.id}`}>{pending.deviceName || 'Your phone'} offers its hotspot “{pending.ssid}”</strong>
            <small>
              This computer would join it for a direct, faster link{pending.via === 'bluetooth' ? ' (offered over Bluetooth)' : ''}.
              Its normal Wi-Fi comes back when the phone stops the hotspot.
              {Number.isFinite(secondsLeft) && secondsLeft > 0 ? ` Expires in ${formatSeconds(secondsLeft)}.` : ''}
            </small>
            {status.unsupportedReason ? <small className="handoff-warning">{status.unsupportedReason}</small> : null}
            {error ? <small className="handoff-warning">{error}</small> : null}
          </span>
          <span className="update-actions">
            <button className="text-button" disabled={busy !== null} onClick={() => void respond(pending, true)}>Join</button>
            <button className="text-button" disabled={busy !== null} onClick={() => void respond(pending, true, true)}>Always for paired phones</button>
            <button className="text-button" disabled={busy !== null} onClick={() => void respond(pending, false)}>Not now</button>
          </span>
        </div>
        {policyControl}
      </>
    );
  }

  const active = joining ?? joined;
  if (active) {
    return (
      <>
        <div className="update-note update-note-quiet handoff-note" role="status">
          <span>
            <strong>{active.state === 'joining' ? `Joining “${active.ssid}”…` : `Direct link on ${active.deviceName || 'the phone'}'s hotspot`}</strong>
            <small>{active.state === 'joining'
              ? 'Connecting to the phone\u2019s hotspot. This can take a few seconds.'
              : `Connected to “${active.ssid}”. Transfers go straight to the phone. Ending it rejoins your previous Wi-Fi.`}</small>
            {error ? <small className="handoff-warning">{error}</small> : null}
          </span>
          {active.state === 'joined' ? (
            <span className="update-actions">
              <button className="text-button" disabled={busy !== null} onClick={() => void end(active)}>Leave hotspot</button>
            </span>
          ) : null}
        </div>
        {policyControl}
      </>
    );
  }

  return (
    <>
      {policyControl}
      {error ? <small className="handoff-warning" role="alert">{error}</small> : null}
    </>
  );
}

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, '0')}`;
}
