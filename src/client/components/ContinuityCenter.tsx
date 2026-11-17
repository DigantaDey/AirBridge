import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Maximize2, Phone, PhoneIncoming, PhoneOff, ScreenShare, Search, Upload, Download, UserPlus, Volume2 } from "lucide-react";
import {
  MAX_VCARD_LENGTH,
  buildVCard,
  buildVCards,
  callPartyLabel,
  contactMatches,
  dialableNumber,
  parseVCards,
  type ContactCard,
  type ContinuityFeature,
} from "../../shared/continuity.js";
import type { PeerSummary } from "../../shared/protocol.js";
import { h264CodecFromAnnexB } from "../engine/h264.js";
import type {
  CallCommandResult,
  CallView,
  ContactShareItem,
  ContactsQueryResult,
  ContinuitySnapshot,
  ScreenAudioFrame,
  ScreenFrame,
  ScreenVideoFrame,
  PhoneBatteryStatusView,
  ScreenShareRequestView,
  ScreenShareView,
} from "../engine/continuity.js";

export type ContinuityTab = "contacts" | "calls" | "screen";

/** The subset of the client the continuity UI drives (WarpClient or a fake in tests). */
export interface ContinuityClient {
  requestContacts(peerId: string, options?: { query?: string; limit?: number }): Promise<ContactsQueryResult>;
  shareContacts(peerId: string, contacts: ContactCard[]): Promise<ContactShareItem>;
  clearSharedContacts(): void;
  answerCall(peerId: string, callId: string): Promise<CallCommandResult>;
  rejectCall(peerId: string, callId: string): Promise<CallCommandResult>;
  hangUpCall(peerId: string, callId: string): Promise<CallCommandResult>;
  dialNumber(peerId: string, number: string): Promise<CallCommandResult>;
  requestScreenShare(peerId: string, options?: { maxWidth?: number; maxFps?: number }): string;
  stopScreenShare(sessionId: string): void;
  subscribeScreenFrames(sessionId: string, listener: (frame: ScreenFrame) => void): () => void;
  subscribeScreenVideo?(sessionId: string, listener: (frame: ScreenVideoFrame) => void): () => void;
  subscribeScreenAudio?(sessionId: string, listener: (frame: ScreenAudioFrame) => void): () => void;
}

const TAB_FEATURE: Record<ContinuityTab, ContinuityFeature> = {
  contacts: "contacts.provide",
  calls: "calls.control",
  screen: "screen.source",
};

const TAB_LABEL: Record<ContinuityTab, string> = { contacts: "Contacts", calls: "Calls", screen: "Screen" };

const SCREEN_PRESETS = {
  standard: { label: "Standard · 1280 px, 15 fps", maxWidth: 1280, maxFps: 15 },
  high: { label: "High · 1920 px, 30 fps", maxWidth: 1920, maxFps: 30 },
  saver: { label: "Data saver · 960 px, 10 fps", maxWidth: 960, maxFps: 10 },
} as const;
type ScreenPreset = keyof typeof SCREEN_PRESETS;

const LIST_PAGE = 150;

export const EMPTY_SNAPSHOT: ContinuitySnapshot = { peerFeatures: {}, calls: [], screenShares: [], screenRequests: [], sharedContacts: [], batteryStatus: {} };

/** Why a tab cannot be used with a device, in words the user can act on (null = ready). */
export function featureGuidance(tab: ContinuityTab, peer: PeerSummary | undefined, features: ContinuityFeature[] | undefined): string | null {
  if (!peer) return "Pair a phone or computer first — use Pair device on the main screen.";
  if (peer.discoveryScope !== "paired") return `${peer.device.name} is nearby but not paired. Pair it first.`;
  if (!features) return `${peer.device.name} hasn't announced phone features yet. Update AirBridge on it to the latest version.`;
  if (features.includes(TAB_FEATURE[tab])) return null;
  const isPhone = peer.device.formFactor === "phone" || peer.device.formFactor === "tablet" || peer.device.platform === "android";
  if (tab === "contacts") return isPhone
    ? `Turn on Contacts in AirBridge on ${peer.device.name} (Settings → Phone on your computer) and allow access.`
    : `${peer.device.name} doesn't share an address book.`;
  if (tab === "calls") return isPhone
    ? `Turn on Calls in AirBridge on ${peer.device.name} (Settings → Phone on your computer) and allow phone access.`
    : `${peer.device.name} can't make phone calls.`;
  return isPhone
    ? `Turn on Screen sharing in AirBridge on ${peer.device.name} (Settings → Phone on your computer).`
    : `${peer.device.name} can't share its screen from this browser. Open AirBridge there in a current browser over HTTPS.`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function callStatusLabel(call: CallView, now: number): string {
  switch (call.state) {
    case "ringing": return call.direction === "incoming" ? "Incoming call" : "Ringing";
    case "dialing": return "Calling…";
    case "held": return "On hold";
    case "ended": return "Call ended";
    case "active": return call.connectedAt ? formatDuration(now - call.connectedAt) : "On call";
    default: return call.state;
  }
}

function safeFileName(name: string): string {
  return (name.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim() || "contact").slice(0, 60);
}

/** Saves vCard text as a .vcf download (opens in Contacts / Outlook / Thunderbird). */
export function downloadVCard(vcard: string, name: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([vcard], { type: "text/vcard;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(name)}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

interface ContinuityCenterProps {
  client: ContinuityClient;
  peers: PeerSummary[];
  continuity: ContinuitySnapshot | undefined;
  initialTab: ContinuityTab;
  onClose: () => void;
}

/** Contacts, calls and screen viewing for paired devices (top bar → Contacts / Calls / Screen). */
export function ContinuityCenter({ client, peers, continuity, initialTab, onClose }: ContinuityCenterProps) {
  const snap = continuity ?? EMPTY_SNAPSHOT;
  const [tab, setTab] = useState<ContinuityTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const paired = useMemo(() => peers.filter((p) => p.discoveryScope === "paired"), [peers]);
  const capable = (t: ContinuityTab) => paired.filter((p) => snap.peerFeatures[p.peerId]?.includes(TAB_FEATURE[t]));
  const [peerId, setPeerId] = useState<string>("");
  // Follow the best device for the tab unless the user picked one that still exists.
  useEffect(() => {
    if (peerId && paired.some((p) => p.peerId === peerId)) return;
    const next = capable(tab)[0] ?? paired[0];
    setPeerId(next?.peerId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, paired, snap.peerFeatures]);
  const peer = paired.find((p) => p.peerId === peerId);
  const guidance = featureGuidance(tab, peer, peer ? snap.peerFeatures[peer.peerId] : undefined);
  const canCall = Boolean(peer && snap.peerFeatures[peer.peerId]?.includes("calls.control"));
  const [autoDial, setAutoDial] = useState<{ number: string; at: number } | null>(null);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="utility-modal continuity-modal" role="dialog" aria-modal="true" aria-label="Phone">
        <div className="modal-heading">
          <div>
            <p className="section-kicker">PHONE ON YOUR COMPUTER</p>
            <h2>{TAB_LABEL[tab]}</h2>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="continuity-tabs" role="tablist" aria-label="Phone features">
          {(Object.keys(TAB_LABEL) as ContinuityTab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "continuity-tab is-active" : "continuity-tab"} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
              {t === "calls" && snap.calls.some((c) => c.state !== "ended") && <span className="continuity-dot" aria-label="call in progress" />}
              {t === "screen" && snap.screenShares.some((s) => s.role === "viewer" && s.state === "active") && <span className="continuity-dot" aria-label="viewing" />}
            </button>
          ))}
        </div>
        {paired.length > 1 && (
          <label className="continuity-device">
            <span>Device</span>
            <select aria-label="Device" value={peerId} onChange={(e) => setPeerId(e.target.value)}>
              {paired.map((p) => (
                <option key={p.peerId} value={p.peerId}>
                  {p.device.name}{snap.peerFeatures[p.peerId]?.includes(TAB_FEATURE[tab]) ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </label>
        )}
        {peer && snap.batteryStatus?.[peer.peerId] && <PhoneBatteryStatus status={snap.batteryStatus[peer.peerId]!} />}
        {tab === "calls" && <CallsPanel client={client} calls={snap.calls} peer={peer} guidance={guidance} autoDial={autoDial} />}
        {tab === "contacts" && (
          <ContactsPanel
            client={client}
            peer={peer}
            guidance={guidance}
            canCall={canCall}
            canReceive={Boolean(peer && (snap.peerFeatures[peer.peerId] ?? []).includes("contacts.receive"))}
            shared={snap.sharedContacts}
            onCall={(number) => { setAutoDial({ number, at: Date.now() }); setTab("calls"); }}
          />
        )}
        {tab === "screen" && <ScreenPanel client={client} peer={peer} guidance={guidance} shares={snap.screenShares} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- calls

function CallsPanel({ client, calls, peer, guidance, autoDial }: { client: ContinuityClient; calls: CallView[]; peer?: PeerSummary; guidance: string | null; autoDial?: { number: string; at: number } | null }) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = calls.filter((c) => c.state !== "ended" || Date.now() - c.updatedAt < 5000);
  const now = useNow(live.some((c) => c.state === "active"));
  const dialable = dialableNumber(number);

  const dial = async (event?: FormEvent, override?: string) => {
    event?.preventDefault();
    const target = override ?? dialable;
    if (!peer || !target) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.dialNumber(peer.peerId, target);
      if (!result.ok) setError(result.error ?? "The phone could not place the call.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The phone did not respond.");
    } finally {
      setBusy(false);
    }
  };

  // "Call" next to a contact: show the number here and place the call once.
  const dialedRef = useRef(0);
  useEffect(() => {
    if (!autoDial || autoDial.at === dialedRef.current || !peer || guidance) return;
    dialedRef.current = autoDial.at;
    setNumber(autoDial.number);
    void dial(undefined, autoDial.number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDial, peer, guidance]);

  return (
    <div className="continuity-panel">
      {live.length > 0 && (
        <ul className="call-list" aria-label="Calls">
          {live.map((call) => <CallRow key={`${call.peerId}:${call.callId}`} client={client} call={call} now={now} onError={setError} />)}
        </ul>
      )}
      {guidance ? (
        <p className="continuity-guidance" role="status">{guidance}</p>
      ) : (
        <form className="dialer" onSubmit={dial}>
          <input
            aria-label="Phone number"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Enter a number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <div className="dial-pad" role="group" aria-label="Keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((d) => (
              <button key={d} type="button" className="dial-key" onClick={() => setNumber((n) => (n + d).slice(0, 40))}>{d}</button>
            ))}
          </div>
          <div className="dialer-actions">
            <button type="button" className="quiet-button" disabled={!number} onClick={() => setNumber((n) => n.slice(0, -1))}>Delete</button>
            <button type="submit" className="beam-button call-button" disabled={!dialable || busy}>
              <Phone size={15} aria-hidden="true" /> {busy ? "Calling…" : `Call from ${peer?.device.name ?? "phone"}`}
            </button>
          </div>
          <small className="continuity-note">Audio plays on {peer?.device.name ?? "the phone"} or its connected headset — Android doesn&apos;t let apps route call audio to a computer.</small>
        </form>
      )}
      {error && <p className="clipboard-error" role="alert">{error}</p>}
    </div>
  );
}

function CallRow({ client, call, now, onError }: { client: ContinuityClient; call: CallView; now: number; onError: (e: string | null) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const run = async (action: "answer" | "reject" | "hangup") => {
    setPending(action);
    onError(null);
    try {
      const fn = action === "answer" ? client.answerCall : action === "reject" ? client.rejectCall : client.hangUpCall;
      const result = await fn.call(client, call.peerId, call.callId);
      if (!result.ok) onError(result.error ?? "The phone did not respond.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "The phone did not respond.");
    } finally {
      setPending(null);
    }
  };
  return (
    <li className={`call-row call-${call.state}`}>
      <span className="call-party">
        <strong>{callPartyLabel(call)}</strong>
        <small>{call.name && call.number ? `${call.number} · ` : ""}{callStatusLabel(call, now)} · {call.peerName}</small>
      </span>
      <span className="call-actions">
        {call.actions.includes("answer") && (
          <button type="button" className="beam-button call-answer" disabled={pending !== null} onClick={() => run("answer")}>
            <PhoneIncoming size={14} aria-hidden="true" /> Answer
          </button>
        )}
        {call.actions.includes("reject") && (
          <button type="button" className="secondary-button call-decline" disabled={pending !== null} onClick={() => run("reject")}>Decline</button>
        )}
        {call.actions.includes("hangup") && (
          <button type="button" className="secondary-button call-decline" disabled={pending !== null} onClick={() => run("hangup")}>
            <PhoneOff size={14} aria-hidden="true" /> Hang up
          </button>
        )}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------- contacts

interface ContactsPanelProps {
  client: ContinuityClient;
  peer?: PeerSummary;
  guidance: string | null;
  canCall: boolean;
  canReceive: boolean;
  shared: ContactShareItem[];
  onCall: (number: string) => void;
}

function ContactsPanel({ client, peer, guidance, canCall, canReceive, shared, onCall }: ContactsPanelProps) {
  const [all, setAll] = useState<ContactCard[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [remote, setRemote] = useState<ContactCard[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(LIST_PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const loadedFor = useRef<string>("");

  const load = async () => {
    if (!peer || guidance) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.requestContacts(peer.peerId);
      setAll(result.contacts);
      setTruncated(result.truncated);
      loadedFor.current = peer.peerId;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The phone did not send its contacts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (peer && !guidance && loadedFor.current !== peer.peerId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer?.peerId, guidance]);

  // Large address books: the phone filters when the local page is incomplete.
  useEffect(() => {
    setVisible(LIST_PAGE);
    if (!truncated || !peer || !query.trim()) { setRemote(null); return; }
    const timer = window.setTimeout(() => {
      client.requestContacts(peer.peerId, { query: query.trim(), limit: 500 })
        .then((r) => setRemote(r.contacts))
        .catch(() => setRemote(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, truncated, peer, client]);

  const matches = useMemo(() => {
    if (remote) return remote;
    if (!all) return [];
    return query.trim() ? all.filter((c) => contactMatches(c, query)) : all;
  }, [all, remote, query]);

  const incoming = shared.filter((s) => s.direction === "incoming");

  return (
    <div className="continuity-panel">
      {guidance ? (
        <p className="continuity-guidance" role="status">{guidance}</p>
      ) : (
        <>
          <div className="contacts-toolbar">
            <label className="contacts-search">
              <Search size={14} aria-hidden="true" />
              <input aria-label="Search contacts" placeholder="Search name, number, email or company" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button type="button" className="quiet-button" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
            <button type="button" className="quiet-button" disabled={!matches.length} onClick={() => downloadVCard(buildVCards(matches), query.trim() ? `contacts-${query.trim()}` : `${peer?.device.name ?? "phone"} contacts`)}>
              <Download size={13} aria-hidden="true" /> Export
            </button>
          </div>
          {error && <p className="clipboard-error" role="alert">{error}</p>}
          {all && (
            <p className="quiet-count" aria-live="polite">
              {matches.length} {matches.length === 1 ? "contact" : "contacts"}{truncated && !remote ? " (search to find more)" : ""}
            </p>
          )}
          <ul className="contact-list" aria-label="Contacts">
            {matches.slice(0, visible).map((card, i) => (
              <li key={card.id ?? `${card.name}-${i}`} className="contact-row">
                <span className="contact-copy">
                  <strong>{card.name || card.phones[0]?.number || card.emails[0]?.address}</strong>
                  {card.organization && <small>{card.organization}</small>}
                  {card.phones.map((p) => (
                    <span key={p.number} className="contact-value">
                      <span>{p.number}{p.label ? <small> · {p.label}</small> : null}</span>
                      {canCall && dialableNumber(p.number) && (
                        <button type="button" className="text-button" aria-label={`Call ${card.name} ${p.number}`} onClick={() => onCall(dialableNumber(p.number)!)}>Call</button>
                      )}
                    </span>
                  ))}
                  {card.emails.map((e) => (
                    <span key={e.address} className="contact-value"><a href={`mailto:${e.address}`}>{e.address}</a></span>
                  ))}
                </span>
                <button type="button" className="text-button" aria-label={`Save ${card.name} as vCard`} onClick={() => downloadVCard(buildVCard(card), card.name)}>Save</button>
              </li>
            ))}
          </ul>
          {matches.length > visible && (
            <button type="button" className="quiet-button" onClick={() => setVisible((v) => v + LIST_PAGE)}>Show more ({matches.length - visible})</button>
          )}
        </>
      )}
      {peer && canReceive && <SendContactForm client={client} peer={peer} onSent={setNotice} />}
      {notice && <p className="continuity-note" role="status">{notice}</p>}
      {incoming.length > 0 && (
        <div className="clipboard-history">
          <div className="section-title">
            <h2>Received contacts</h2>
            <button type="button" className="text-button" onClick={() => client.clearSharedContacts()}>Clear</button>
          </div>
          <ul className="contact-list" aria-label="Received contacts">
            {incoming.map((item) => (
              <li key={item.shareId} className="contact-row">
                <span className="contact-copy">
                  <strong>{item.contacts.map((c) => c.name).slice(0, 3).join(", ")}{item.contacts.length > 3 ? ` +${item.contacts.length - 3}` : ""}</strong>
                  <small>From {item.peerName} · {new Date(item.timestamp).toLocaleTimeString()}</small>
                </span>
                <button type="button" className="text-button" onClick={() => downloadVCard(item.vcard, item.contacts[0]?.name ?? "contact")}>Save .vcf</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SendContactForm({ client, peer, onSent }: { client: ContinuityClient; peer: PeerSummary; onSent: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (cards: ContactCard[]) => {
    setError(null);
    try {
      await client.shareContacts(peer.peerId, cards);
      onSent(cards.length === 1 ? `Sent ${cards[0].name} to ${peer.device.name}.` : `Sent ${cards.length} contacts to ${peer.device.name}.`);
      setName(""); setPhone(""); setEmail(""); setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the contact.");
    }
  };

  const importFile = async (file: File) => {
    if (file.size > MAX_VCARD_LENGTH * 4) return setError("That file is too large to send at once (64 KB of vCard text).");
    const cards = parseVCards(await file.text());
    if (!cards.length) return setError("No contacts found in that file.");
    await send(cards);
  };

  if (!open) {
    return (
      <div className="contacts-send-row">
        <button type="button" className="quiet-button" onClick={() => setOpen(true)}><UserPlus size={13} aria-hidden="true" /> Send a contact to {peer.device.name}</button>
        <button type="button" className="quiet-button" onClick={() => fileRef.current?.click()}><Upload size={13} aria-hidden="true" /> Send .vcf file</button>
        <input ref={fileRef} type="file" accept=".vcf,text/vcard,text/x-vcard" className="visually-hidden" aria-label="vCard file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
        {error && <p className="clipboard-error" role="alert">{error}</p>}
      </div>
    );
  }
  const card: ContactCard = {
    name: name.trim(),
    phones: phone.trim() ? [{ number: phone.trim(), label: "mobile" }] : [],
    emails: email.trim() ? [{ address: email.trim() }] : [],
  };
  return (
    <form className="contact-form" onSubmit={(e) => { e.preventDefault(); if (card.name) void send([card]); }}>
      <input aria-label="Contact name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input aria-label="Contact phone" placeholder="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <input aria-label="Contact email" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <span className="contact-form-actions">
        <button type="button" className="quiet-button" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="beam-button" disabled={!card.name || (!card.phones.length && !card.emails.length)}>Send</button>
      </span>
      {error && <p className="clipboard-error" role="alert">{error}</p>}
    </form>
  );
}

function PhoneBatteryStatus({ status }: { status: PhoneBatteryStatusView }) {
  const isLow = status.level < 20 && !status.charging;
  const voltage = status.charging && status.voltageMv
    ? `Battery voltage ${ (status.voltageMv / 1000).toFixed(2) } V`
    : null;
  return (
    <div className={`phone-battery ${isLow ? "is-low" : ""}`}>
      <div className="phone-battery-line" role="status" aria-label={`${status.peerName} battery ${status.level} percent${status.charging ? ", charging" : ""}`}>
        <span className="phone-battery-label">Phone battery</span>
        <strong>{status.level}%</strong>
        <span>{status.charging ? "Charging" : "On battery"}</span>
        {voltage && <span className="phone-battery-voltage">{voltage}</span>}
      </div>
      {isLow && <div className="phone-battery-warning" role="alert">Low battery — put {status.peerName} on charge soon.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- screen

function ScreenPanel({ client, peer, guidance, shares }: { client: ContinuityClient; peer?: PeerSummary; guidance: string | null; shares: ScreenShareView[] }) {
  const [preset, setPreset] = useState<ScreenPreset>("standard");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewing = shares.filter((s) => s.role === "viewer");
  // Reattach to a session started earlier (panel reopened).
  const share = viewing.find((s) => s.sessionId === sessionId) ??
    viewing.find((s) => s.peerId === peer?.peerId && ["requesting", "pending", "active"].includes(s.state));

  const start = () => {
    if (!peer) return;
    setError(null);
    try {
      const p = SCREEN_PRESETS[preset];
      setSessionId(client.requestScreenShare(peer.peerId, { maxWidth: p.maxWidth, maxFps: p.maxFps }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not ask for the screen.");
    }
  };

  const live = share && ["requesting", "pending", "active"].includes(share.state);
  return (
    <div className="continuity-panel">
      {guidance && !live ? (
        <p className="continuity-guidance" role="status">{guidance}</p>
      ) : !live ? (
        <div className="screen-start">
          {share && share.state !== "active" && (
            <p className="continuity-note" role="status">{screenEndedLabel(share)}</p>
          )}
          <label className="continuity-device">
            <span>Quality</span>
            <select aria-label="Screen quality" value={preset} onChange={(e) => setPreset(e.target.value as ScreenPreset)}>
              {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map((k) => <option key={k} value={k}>{SCREEN_PRESETS[k].label}</option>)}
            </select>
          </label>
          <button type="button" className="beam-button" onClick={start}>
            <ScreenShare size={15} aria-hidden="true" /> View {peer?.device.name ?? "device"} screen
          </button>
          <small className="continuity-note">{peer?.device.name ?? "The device"} asks for permission first. Frames are end-to-end encrypted and adapt to the connection.</small>
        </div>
      ) : (
        <ScreenViewer client={client} share={share!} onStop={() => { client.stopScreenShare(share!.sessionId); }} />
      )}
      {error && <p className="clipboard-error" role="alert">{error}</p>}
    </div>
  );
}

export function screenEndedLabel(share: ScreenShareView): string {
  switch (share.state) {
    case "declined": return share.reason ? `${share.peerName} declined: ${share.reason}` : `${share.peerName} declined screen sharing.`;
    case "unsupported": return share.reason ?? `${share.peerName} can't share its screen.`;
    case "error": return share.reason ?? "Screen sharing failed.";
    case "stopped": return share.reason ? `Screen sharing ended: ${share.reason}` : "Screen sharing ended.";
    default: return "";
  }
}

function ScreenViewer({ client, share, onStop }: { client: ContinuityClient; share: ScreenShareView; onStop: () => void }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const playheadRef = useRef(0);
  /** Maps Android's shared video/audio elapsed clock to this viewer's clock. */
  const timelineRef = useRef<{ remotePtsMs: number; localMs: number } | null>(null);
  const audioNodesRef = useRef(new Set<AudioBufferSourceNode>());
  const [hasFrame, setHasFrame] = useState(false);
  const [h264Active, setH264Active] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const mapSourceTime = (ptsMs: number): number => {
    const now = performance.now();
    const prior = timelineRef.current;
    const delta = prior ? ((ptsMs - prior.remotePtsMs + 0x80000000) % 0x100000000 + 0x100000000) % 0x100000000 - 0x80000000 : 0;
    if (!prior || Math.abs(delta) > 10_000) {
      timelineRef.current = { remotePtsMs: ptsMs, localMs: now };
      return now;
    }
    return prior.localMs + delta;
  };
  useEffect(() => {
    let url: string | null = null;
    const unsubscribe = client.subscribeScreenFrames(share.sessionId, (frame) => {
      if (typeof URL.createObjectURL !== "function" || !imgRef.current) return;
      const next = URL.createObjectURL(new Blob([frame.data as BlobPart], { type: frame.mimeType }));
      imgRef.current.src = next;
      if (url) URL.revokeObjectURL(url);
      url = next;
      setH264Active(false);
      setHasFrame(true);
    });
    return () => {
      unsubscribe();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, share.sessionId]);

  // Android uses AVC access units rather than serialised bitmaps. WebCodecs
  // keeps decode off the layout path; a legacy browser can still view JPEG
  // streams from browser peers, but is told when it cannot render Android AVC.
  useEffect(() => {
    if (!client.subscribeScreenVideo) return;
    type DecodedFrame = { displayWidth: number; displayHeight: number; close: () => void };
    type DecoderInstance = { configure(config: Record<string, unknown>): void; decode(chunk: unknown): void; close(): void };
    type DecoderCtor = new (init: { output: (frame: DecodedFrame) => void; error: (error: Error) => void }) => DecoderInstance;
    type ChunkCtor = new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown;
    const api = window as unknown as Window & { VideoDecoder?: DecoderCtor; EncodedVideoChunk?: ChunkCtor };
    if (!api.VideoDecoder || !api.EncodedVideoChunk) {
      setVideoError("This browser cannot decode the phone's low-latency H.264 stream. Use a current Chromium-based AirBridge desktop browser.");
      return;
    }
    let decoder: DecoderInstance | null = null;
    let codecString: string | null = null;
    let waitingForKeyFrame = true;
    const createDecoder = (codec: string) => {
      let created!: DecoderInstance;
      created = new api.VideoDecoder!({
        output: (frame) => {
          try {
            const canvas = canvasRef.current;
            const context = canvas?.getContext('2d');
            if (canvas && context) {
              // Resizing a canvas reallocates its backing store; do it only on
              // rotation/resize, not for every output frame.
              if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
              if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
              context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
              setH264Active(true);
              setHasFrame(true);
              setVideoError(null);
            }
          } finally {
            frame.close();
          }
        },
        error: () => {
          if (decoder === created) {
            decoder = null;
            codecString = null;
            waitingForKeyFrame = true;
            setVideoError("The H.264 decoder recovered from a damaged frame and is waiting for the next sync frame.");
          }
        },
      });
      // The actual MediaCodec profile/level varies by phone and output size.
      // Configure from the SPS in a sync access unit instead of assuming
      // baseline level 3.0 (which cannot decode many 1080p streams).
      created.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      decoder = created;
      codecString = codec;
    };
    const unsubscribe = client.subscribeScreenVideo(share.sessionId, (frame) => {
      mapSourceTime(frame.ptsMs);
      if (waitingForKeyFrame && !frame.keyFrame) return;
      if (frame.keyFrame) {
        const detectedCodec = h264CodecFromAnnexB(frame.data);
        if (detectedCodec && detectedCodec !== codecString) {
          try { decoder?.close(); } catch { /* previous decoder already failed */ }
          decoder = null;
          try { createDecoder(detectedCodec); } catch {
            decoder = null;
            codecString = null;
            waitingForKeyFrame = true;
            setVideoError("This browser cannot initialise the phone's H.264 profile.");
            return;
          }
        }
      }
      if (!decoder) {
        waitingForKeyFrame = true;
        setVideoError("Waiting for an H.264 sync frame with codec headers…");
        return;
      }
      try {
        decoder.decode(new api.EncodedVideoChunk!({ type: frame.keyFrame ? 'key' : 'delta', timestamp: frame.ptsMs * 1000, data: frame.data }));
        waitingForKeyFrame = false;
      } catch {
        // Decoder has entered an error state; don't feed deltas after a lost frame.
        waitingForKeyFrame = true;
      }
    });
    return () => {
      unsubscribe();
      try { decoder?.close(); } catch { /* decoder already closed */ }
    };
  }, [client, share.sessionId]);

  // The source sends timestamped, small PCM packets. Keep a bounded local
  // jitter buffer and drop old packets rather than letting A/V drift grow.
  useEffect(() => {
    if (!audioEnabled || !client.subscribeScreenAudio || !contextRef.current) return;
    const context = contextRef.current;
    const unsubscribe = client.subscribeScreenAudio(share.sessionId, (frame) => {
      // Video and AudioRecord carry the same elapsed-realtime PTS. Map that
      // source clock once at arrival, then keep about 60 ms of jitter room.
      const desired = context.currentTime + (mapSourceTime(frame.ptsMs) - performance.now()) / 1000 + 0.06;
      if (desired < context.currentTime - 0.18) return;
      const startAt = Math.max(context.currentTime + 0.015, Math.min(desired, context.currentTime + 0.2), playheadRef.current);
      const buffer = context.createBuffer(frame.channels, frame.frames, frame.sampleRate);
      for (let channel = 0; channel < frame.channels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let index = 0; index < frame.frames; index += 1) {
          const byteOffset = (index * frame.channels + channel) * 2;
          const value = frame.data[byteOffset] | (frame.data[byteOffset + 1] << 8);
          samples[index] = (value & 0x8000 ? value - 0x10000 : value) / 0x8000;
        }
      }
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      audioNodesRef.current.add(node);
      node.onended = () => { audioNodesRef.current.delete(node); node.disconnect(); };
      node.start(startAt);
      playheadRef.current = startAt + buffer.duration;
    });
    return () => {
      unsubscribe();
      for (const node of audioNodesRef.current) { try { node.stop(); } catch { /* already stopped */ } }
      audioNodesRef.current.clear();
      playheadRef.current = 0;
      timelineRef.current = null;
    };
  }, [audioEnabled, client, share.sessionId]);

  useEffect(() => () => { void contextRef.current?.close(); }, []);

  const toggleAudio = () => {
    if (audioEnabled) { setAudioEnabled(false); return; }
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) { setAudioError("This browser cannot play the shared app audio."); return; }
    const context = contextRef.current ?? new AudioContextCtor();
    contextRef.current = context;
    void context.resume().then(() => { setAudioError(null); setAudioEnabled(true); }).catch(() => setAudioError("Allow audio playback in this browser, then try again."));
  };

  const status = share.state === "active"
    ? `${share.width && share.height ? `${share.width}×${share.height} · ` : ""}${share.fps} fps · ${share.kbps >= 1000 ? `${(share.kbps / 1000).toFixed(1)} Mbps` : `${share.kbps} kbps`}`
    : share.state === "pending" ? `Waiting for ${share.peerName} to allow screen sharing…` : `Asking ${share.peerName}…`;
  const audioLabel = share.audioAvailable
    ? audioEnabled ? "App audio playing" : "App audio is available"
    : "App audio is off or unavailable";

  return (
    <div className="screen-viewer">
      <div ref={stageRef} className="screen-stage">
        <img ref={imgRef} alt={`${share.peerName} screen`} className={hasFrame && !h264Active ? "screen-frame" : "screen-frame is-empty"} />
        <canvas ref={canvasRef} aria-label={`${share.peerName} screen`} className={h264Active ? "screen-frame" : "screen-frame is-empty"} />
        {!hasFrame && <span className="screen-placeholder">{videoError ?? status}</span>}
      </div>
      <div className="screen-toolbar">
        <span className="quiet-count" aria-live="polite">{status} · {audioLabel}</span>
        <span className="call-actions">
          {share.audioAvailable && client.subscribeScreenAudio && <button type="button" className="quiet-button" onClick={toggleAudio} aria-pressed={audioEnabled}>
            <Volume2 size={13} aria-hidden="true" /> {audioEnabled ? "Mute app audio" : "Play app audio"}
          </button>}
          <button type="button" className="quiet-button" aria-label="Full screen" disabled={!hasFrame} onClick={() => { void stageRef.current?.requestFullscreen?.(); }}>
            <Maximize2 size={13} aria-hidden="true" /> Full screen
          </button>
          <button type="button" className="secondary-button" onClick={onStop}>Stop viewing</button>
        </span>
      </div>
      {videoError && <p className="clipboard-error" role="alert">{videoError}</p>}
      {audioError && <p className="clipboard-error" role="alert">{audioError}</p>}
      {share.state === "active" && !share.audioAvailable && <small className="continuity-note">App audio is disabled, unavailable, or blocked by the source app or platform. Protected content cannot be cast.</small>}
    </div>
  );
}

// ---------------------------------------------------------------- alerts

interface ContinuityAlertsProps {
  client: ContinuityClient & {
    acceptScreenShare(sessionId: string, source: import("../engine/continuity.js").ScreenFrameSource): void;
    declineScreenShare(sessionId: string): void;
  };
  continuity: ContinuitySnapshot | undefined;
  onOpenCalls: () => void;
  /** Starts a capture source for an accepted request (browser picker); injectable for tests. */
  startCapture: (maxFps: number) => Promise<import("../engine/continuity.js").ScreenFrameSource>;
}

/**
 * Always-visible continuity prompts: ringing calls (answer / decline),
 * screen-share requests for this computer, and an "everyone can see your
 * screen" bar while sharing.
 */
export function ContinuityAlerts({ client, continuity, onOpenCalls, startCapture }: ContinuityAlertsProps) {
  const snap = continuity ?? EMPTY_SNAPSHOT;
  const ringing = snap.calls.filter((c) => c.state === "ringing" && c.direction === "incoming");
  const request = snap.screenRequests[0];
  const sharing = snap.screenShares.filter((s) => s.role === "source" && s.state === "active");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const command = async (call: CallView, action: "answer" | "reject") => {
    setBusy(call.callId);
    setError(null);
    try {
      const result = action === "answer" ? await client.answerCall(call.peerId, call.callId) : await client.rejectCall(call.peerId, call.callId);
      if (!result.ok) setError(result.error ?? "The phone did not respond.");
      else if (action === "answer") onOpenCalls();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The phone did not respond.");
    } finally {
      setBusy(null);
    }
  };

  const allow = async (req: ScreenShareRequestView) => {
    setError(null);
    try {
      const source = await startCapture(req.maxFps);
      client.acceptScreenShare(req.sessionId, source);
    } catch (err) {
      client.declineScreenShare(req.sessionId);
      const denied = err instanceof Error && /denied|NotAllowed|Permission/i.test(`${err.name} ${err.message}`);
      setError(denied ? "Screen sharing was cancelled." : err instanceof Error ? err.message : "Screen sharing failed.");
    }
  };

  if (!ringing.length && !request && !sharing.length && !error) return null;
  return (
    <div className="continuity-alerts" aria-live="assertive">
      {ringing.map((call) => (
        <div key={call.callId} className="continuity-alert incoming-call" role="alertdialog" aria-label={`Incoming call from ${callPartyLabel(call)}`}>
          <span className="call-party">
            <strong><PhoneIncoming size={14} aria-hidden="true" /> {callPartyLabel(call)}</strong>
            <small>{call.name && call.number ? `${call.number} · ` : ""}Incoming call on {call.peerName}</small>
          </span>
          <span className="call-actions">
            {call.actions.includes("answer") && <button type="button" className="beam-button" disabled={busy === call.callId} onClick={() => command(call, "answer")}>Answer</button>}
            {call.actions.includes("reject") && <button type="button" className="secondary-button" disabled={busy === call.callId} onClick={() => command(call, "reject")}>Decline</button>}
          </span>
        </div>
      ))}
      {request && (
        <div className="continuity-alert" role="alertdialog" aria-label="Screen sharing request">
          <span className="call-party">
            <strong><ScreenShare size={14} aria-hidden="true" /> {request.peerName} wants to view your screen</strong>
            <small>You choose what to share next. Encrypted end to end; stop any time.</small>
          </span>
          <span className="call-actions">
            <button type="button" className="beam-button" onClick={() => allow(request)}>Choose screen…</button>
            <button type="button" className="secondary-button" onClick={() => client.declineScreenShare(request.sessionId)}>Decline</button>
          </span>
        </div>
      )}
      {sharing.map((s) => (
        <div key={s.sessionId} className="continuity-alert sharing-bar" role="status">
          <span className="call-party">
            <strong>Sharing your screen with {s.peerName}</strong>
            <small>{s.fps} fps · {s.kbps} kbps</small>
          </span>
          <button type="button" className="secondary-button" onClick={() => client.stopScreenShare(s.sessionId)}>Stop sharing</button>
        </div>
      ))}
      {error && (
        <div className="continuity-alert" role="alert">
          <span className="call-party"><strong>{error}</strong></span>
          <button type="button" className="quiet-button" aria-label="Dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}
    </div>
  );
}

/** Header badge count for the Calls button (ringing + in progress). */
export function activeCallCount(continuity: ContinuitySnapshot | undefined): number {
  return (continuity?.calls ?? []).filter((c) => c.state !== "ended").length;
}
