import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Maximize2, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, ScreenShare, Search, Trash2, Upload, Download, UserPlus, Volume2 } from "lucide-react";
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
  type SavedContactRecord,
} from "../../shared/continuity.js";
import type { PeerSummary } from "../../shared/protocol.js";
import {
  annexBToAvcc,
  buildAvcDecoderConfigurationRecord,
  extractSpsPps,
  h264CodecFromAnnexB,
  prependSpsPpsIfMissing,
} from "../engine/h264.js";
import { CallAudioSession } from "../engine/callAudio.js";
import type {
  CallAudioFrame,
  CallAudioStateView,
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
  removeSavedContact?(contactId: string): boolean;
  clearSavedContacts?(peerId?: string): number;
  answerCall(peerId: string, callId: string): Promise<CallCommandResult>;
  rejectCall(peerId: string, callId: string): Promise<CallCommandResult>;
  hangUpCall(peerId: string, callId: string): Promise<CallCommandResult>;
  dialNumber(peerId: string, number: string): Promise<CallCommandResult>;
  startCallAudio?(peerId: string, callId: string): Promise<void>;
  stopCallAudio?(peerId: string, callId: string): Promise<void>;
  setCallAudioMuted?(peerId: string, callId: string, muted: boolean): Promise<void>;
  sendCallAudio?(
    peerId: string,
    callId: string,
    pcmS16le: Uint8Array,
    sampleRate: number,
    channels: number,
    frames: number,
    ptsMs: number,
  ): Promise<boolean>;
  subscribeCallAudio?(callId: string, listener: (frame: CallAudioFrame) => void): () => void;
  requestScreenShare(peerId: string, options?: { maxWidth?: number; maxFps?: number }): string;
  stopScreenShare(sessionId: string): void;
  requestScreenKeyframe?(sessionId: string, reason?: string): void;
  recordScreenViewerStats?(stats: {
    decoderMode?: string | null;
    codec?: string | null;
    framesDecodedDelta?: number;
    decodeErrorsDelta?: number;
    keyframesReceivedDelta?: number;
  }): void;
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
  motion: { label: "Smooth video · 1280 px, 30 fps", maxWidth: 1280, maxFps: 30 },
  standard: { label: "Standard · 1280 px, 15 fps", maxWidth: 1280, maxFps: 15 },
  high: { label: "High detail · 1920 px, 30 fps", maxWidth: 1920, maxFps: 30 },
  saver: { label: "Data saver · 960 px, 10 fps", maxWidth: 960, maxFps: 10 },
} as const;
type ScreenPreset = keyof typeof SCREEN_PRESETS;

const LIST_PAGE = 150;

export const EMPTY_SNAPSHOT: ContinuitySnapshot = { peerFeatures: {}, calls: [], screenShares: [], screenRequests: [], sharedContacts: [], savedContacts: [], batteryStatus: {}, callAudio: null };

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
  const [tabState, setTabState] = useState<{ initial: ContinuityTab; current: ContinuityTab }>({
    initial: initialTab,
    current: initialTab,
  });
  const tab = tabState.initial === initialTab ? tabState.current : initialTab;
  const setTab = (next: ContinuityTab) => setTabState({ initial: initialTab, current: next });
  const paired = useMemo(() => peers.filter((p) => p.discoveryScope === "paired"), [peers]);
  const capable = (t: ContinuityTab) => paired.filter((p) => snap.peerFeatures[p.peerId]?.includes(TAB_FEATURE[t]));
  const [selectedPeerId, setSelectedPeerId] = useState<string>("");
  // Follow the best device for the tab unless the user picked one that still exists.
  const peerId =
    selectedPeerId && paired.some((p) => p.peerId === selectedPeerId)
      ? selectedPeerId
      : ((capable(tab)[0] ?? paired[0])?.peerId ?? "");
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
            <select aria-label="Device" value={peerId} onChange={(e) => setSelectedPeerId(e.target.value)}>
              {paired.map((p) => (
                <option key={p.peerId} value={p.peerId}>
                  {p.device.name}{snap.peerFeatures[p.peerId]?.includes(TAB_FEATURE[tab]) ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </label>
        )}
        {peer && snap.batteryStatus?.[peer.peerId] && <PhoneBatteryStatus status={snap.batteryStatus[peer.peerId]!} />}
        {tab === "calls" && (
          <CallsPanel
            client={client}
            calls={snap.calls}
            peer={peer}
            guidance={guidance}
            autoDial={autoDial}
            peerFeatures={snap.peerFeatures}
            callAudio={snap.callAudio ?? null}
          />
        )}
        {tab === "contacts" && (
          <ContactsPanel
            client={client}
            peer={peer}
            guidance={guidance}
            canCall={canCall}
            canReceive={Boolean(peer && (snap.peerFeatures[peer.peerId] ?? []).includes("contacts.receive"))}
            shared={snap.sharedContacts}
            savedContacts={snap.savedContacts ?? []}
            onCall={(number) => { setAutoDial({ number, at: Date.now() }); setTab("calls"); }}
          />
        )}
        {tab === "screen" && <ScreenPanel client={client} peer={peer} guidance={guidance} shares={snap.screenShares} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- calls

function CallsPanel({
  client,
  calls,
  peer,
  guidance,
  autoDial,
  peerFeatures,
  callAudio,
}: {
  client: ContinuityClient;
  calls: CallView[];
  peer?: PeerSummary;
  guidance: string | null;
  autoDial?: { number: string; at: number } | null;
  peerFeatures: Record<string, ContinuityFeature[]>;
  callAudio: CallAudioStateView | null;
}) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(calls.some((c) => c.state === "active" || c.state === "ended"));
  const live = calls.filter((c) => c.state !== "ended" || now - c.updatedAt < 5000);
  const dialable = dialableNumber(number);
  const callsAudioSupported = Boolean(peer && (peerFeatures[peer.peerId] ?? []).includes("calls.audio"));

  const dial = useCallback(async (event?: FormEvent, override?: string) => {
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
  }, [client, dialable, peer]);

  // "Call" next to a contact: show the number here and place the call once.
  const dialedRef = useRef(0);
  useEffect(() => {
    if (!autoDial || autoDial.at === dialedRef.current || !peer || guidance) return;
    dialedRef.current = autoDial.at;
    const targetNumber = autoDial.number;
    queueMicrotask(() => {
      setNumber(targetNumber);
      void dial(undefined, targetNumber);
    });
  }, [autoDial, peer, guidance, dial]);

  return (
    <div className="continuity-panel">
      {live.length > 0 && (
        <ul className="call-list" aria-label="Calls">
          {live.map((call) => (
            <CallRow
              key={`${call.peerId}:${call.callId}`}
              client={client}
              call={call}
              now={now}
              canCallAudio={Boolean(
                (peerFeatures[call.peerId] ?? []).includes("calls.audio") &&
                client.startCallAudio &&
                client.stopCallAudio &&
                client.sendCallAudio &&
                client.subscribeCallAudio,
              )}
              callAudioState={callAudio?.callId === call.callId ? callAudio : null}
              onError={setError}
            />
          ))}
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
          <small className="continuity-note">
            {callsAudioSupported
              ? "Speak and listen on this Mac using \"Use Mac Audio\" during a call (uses Android's speakerphone-assisted E2EE audio bridge)."
              : `Audio plays on ${peer?.device.name ?? "the phone"} or its connected headset unless two-way call audio is enabled in Android settings.`}
          </small>
        </form>
      )}
      {error && <p className="clipboard-error" role="alert">{error}</p>}
    </div>
  );
}

function CallRow({
  client,
  call,
  now,
  canCallAudio,
  callAudioState,
  onError,
}: {
  client: ContinuityClient;
  call: CallView;
  now: number;
  canCallAudio: boolean;
  callAudioState: CallAudioStateView | null;
  onError: (e: string | null) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [localAudioActive, setLocalAudioActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const sessionRef = useRef<CallAudioSession | null>(null);

  const stopMacAudio = useCallback(async () => {
    const existing = sessionRef.current;
    sessionRef.current = null;
    existing?.stop();
    setLocalAudioActive(false);
    setMuted(false);
    if (client.stopCallAudio) {
      await client.stopCallAudio(call.peerId, call.callId).catch(() => {});
    }
  }, [call.callId, call.peerId, client]);

  useEffect(() => {
    if (call.state === "ended" && sessionRef.current) {
      queueMicrotask(() => { void stopMacAudio(); });
    }
  }, [call.state, stopMacAudio]);

  useEffect(() => {
    return () => {
      const existing = sessionRef.current;
      sessionRef.current = null;
      existing?.stop();
      if (existing && client.stopCallAudio) {
        void client.stopCallAudio(call.peerId, call.callId).catch(() => {});
      }
    };
  }, [call.callId, call.peerId, client]);

  const startMacAudio = async () => {
    if (!client.startCallAudio || !client.sendCallAudio || !client.subscribeCallAudio) return;
    setPending("audio-start");
    onError(null);
    const session = new CallAudioSession({
      peerId: call.peerId,
      callId: call.callId,
      sendFrame: (pcm, sr, ch, frames, ptsMs) => {
        void client.sendCallAudio?.(call.peerId, call.callId, pcm, sr, ch, frames, ptsMs);
      },
      subscribeIncoming: (listener) => client.subscribeCallAudio?.(call.callId, listener) ?? (() => {}),
      onError: (msg) => onError(msg),
    });
    try {
      await session.start();
      sessionRef.current = session;
      await client.startCallAudio(call.peerId, call.callId);
      setLocalAudioActive(true);
      setMuted(false);
    } catch (err) {
      session.stop();
      sessionRef.current = null;
      setLocalAudioActive(false);
      onError(err instanceof Error ? err.message : "Could not start Mac call audio.");
    } finally {
      setPending(null);
    }
  };

  const toggleMute = async () => {
    const nextMuted = !muted;
    sessionRef.current?.setMuted(nextMuted);
    setMuted(nextMuted);
    await client.setCallAudioMuted?.(call.peerId, call.callId, nextMuted).catch(() => {});
  };

  const run = async (action: "answer" | "reject" | "hangup") => {
    setPending(action);
    onError(null);
    try {
      if (action === "hangup" && (localAudioActive || sessionRef.current)) {
        await stopMacAudio();
      }
      const fn = action === "answer" ? client.answerCall : action === "reject" ? client.rejectCall : client.hangUpCall;
      const result = await fn.call(client, call.peerId, call.callId);
      if (!result.ok) onError(result.error ?? "The phone did not respond.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "The phone did not respond.");
    } finally {
      setPending(null);
    }
  };

  const isAudioOn = localAudioActive || Boolean(callAudioState?.active);
  const canRouteAudio = canCallAudio && (call.state === "active" || call.state === "dialing");

  return (
    <li className={`call-row call-${call.state}`}>
      <span className="call-party">
        <strong>{callPartyLabel(call)}</strong>
        <small>
          {call.name && call.number ? `${call.number} · ` : ""}
          {callStatusLabel(call, now)} · {call.peerName}
          {isAudioOn ? " · Mac audio active" : ""}
        </small>
        {callAudioState?.reason && !callAudioState.active && (
          <small className="continuity-note">{callAudioState.reason}</small>
        )}
      </span>
      <span className="call-actions">
        {canRouteAudio && !isAudioOn && (
          <button type="button" className="quiet-button" disabled={pending !== null} onClick={() => void startMacAudio()}>
            <Volume2 size={14} aria-hidden="true" /> Use Mac Audio
          </button>
        )}
        {canRouteAudio && isAudioOn && (
          <>
            <button type="button" className="quiet-button" aria-pressed={muted} disabled={pending !== null} onClick={() => void toggleMute()}>
              {muted ? <MicOff size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />} {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="quiet-button" disabled={pending !== null} onClick={() => void stopMacAudio()}>
              Switch to Phone
            </button>
          </>
        )}
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
  savedContacts: SavedContactRecord[];
  onCall: (number: string) => void;
}

function ContactsPanel({ client, peer, guidance, canCall, canReceive, shared, savedContacts, onCall }: ContactsPanelProps) {
  const [all, setAll] = useState<ContactCard[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [remote, setRemote] = useState<ContactCard[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(LIST_PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const loadedFor = useRef<string>("");

  const targetPeerId = peer?.peerId;
  const targetDeviceId = peer?.device.deviceId;
  const peerSavedRecords = useMemo(() => {
    if (!peer) return savedContacts;
    return savedContacts.filter(
      (record) =>
        (targetDeviceId && record.peerDeviceId === targetDeviceId) ||
        record.peerId === targetPeerId,
    );
  }, [peer, savedContacts, targetDeviceId, targetPeerId]);

  const savedIdByCardKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of peerSavedRecords) {
      if (record.contact.id) map.set(`id:${record.contact.id}`, record.id);
      map.set(`name:${record.contact.name.toLowerCase()}`, record.id);
    }
    return map;
  }, [peerSavedRecords]);

  const load = useCallback(async () => {
    if (!targetPeerId || guidance) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.requestContacts(targetPeerId);
      setAll(result.contacts);
      setTruncated(result.truncated);
      loadedFor.current = targetPeerId;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The phone did not send its contacts.");
    } finally {
      setLoading(false);
    }
  }, [client, guidance, targetPeerId]);

  useEffect(() => {
    if (targetPeerId && !guidance && loadedFor.current !== targetPeerId && peerSavedRecords.length === 0) {
      queueMicrotask(() => { void load(); });
    }
  }, [targetPeerId, guidance, peerSavedRecords.length, load]);

  // Large address books: the phone filters when the local page is incomplete.
  useEffect(() => {
    if (!truncated || !peer || !query.trim()) return;
    const timer = window.setTimeout(() => {
      client.requestContacts(peer.peerId, { query: query.trim(), limit: 500 })
        .then((r) => setRemote(r.contacts))
        .catch(() => setRemote(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, truncated, peer, client]);

  const activeRemote = truncated && peer && query.trim() ? remote : null;
  const effectiveList = useMemo(() => {
    if (activeRemote) return activeRemote;
    if (all) {
      // Keep UI consistent immediately if user removed from savedContacts after loading
      if (peerSavedRecords.length > 0 && savedContacts.length > 0) {
        const savedCardIds = new Set(peerSavedRecords.map((r) => r.contact.id).filter(Boolean));
        const hasIds = all.some((c) => Boolean(c.id));
        if (hasIds && savedCardIds.size > 0 && peerSavedRecords.every((r) => r.source === "synced")) {
          const mergedIds = new Set(peerSavedRecords.map((r) => r.contact.id).filter(Boolean));
          return all.filter((c) => !c.id || mergedIds.has(c.id));
        }
      }
      return all;
    }
    return peerSavedRecords.map((r) => r.contact);
  }, [activeRemote, all, peerSavedRecords, savedContacts.length]);

  const matches = useMemo(() => {
    if (!effectiveList.length && all === null && peerSavedRecords.length === 0) return [];
    return query.trim() ? effectiveList.filter((c) => contactMatches(c, query)) : effectiveList;
  }, [effectiveList, all, peerSavedRecords.length, query]);

  const incoming = shared.filter((s) => s.direction === "incoming");

  const removeCard = (card: ContactCard) => {
    const savedId = (card.id && savedIdByCardKey.get(`id:${card.id}`)) || savedIdByCardKey.get(`name:${card.name.toLowerCase()}`);
    if (savedId && client.removeSavedContact) {
      client.removeSavedContact(savedId);
    }
    setAll((prev) => (prev ? prev.filter((item) => (card.id && item.id ? item.id !== card.id : item !== card)) : prev));
  };

  return (
    <div className="continuity-panel">
      {guidance && <p className="continuity-guidance" role="status">{guidance}</p>}
      {(!guidance || peerSavedRecords.length > 0) && (
        <>
          <div className="contacts-toolbar">
            <label className="contacts-search">
              <Search size={14} aria-hidden="true" />
              <input aria-label="Search contacts" placeholder="Search name, number, email or company" value={query} onChange={(e) => { setQuery(e.target.value); setVisible(LIST_PAGE); }} />
            </label>
            {!guidance && (
              <button type="button" className="quiet-button" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
            )}
            <button type="button" className="quiet-button" disabled={!matches.length} onClick={() => downloadVCard(buildVCards(matches), query.trim() ? `contacts-${query.trim()}` : `${peer?.device.name ?? "phone"} contacts`)}>
              <Download size={13} aria-hidden="true" /> Export
            </button>
            {peerSavedRecords.length > 0 && client.clearSavedContacts && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  client.clearSavedContacts?.(peer?.peerId);
                  setAll([]);
                }}
              >
                <Trash2 size={13} aria-hidden="true" /> Clear saved
              </button>
            )}
          </div>
          {error && <p className="clipboard-error" role="alert">{error}</p>}
          {(all || peerSavedRecords.length > 0) && (
            <p className="quiet-count" aria-live="polite">
              {matches.length} {matches.length === 1 ? "contact" : "contacts"}{peerSavedRecords.length > 0 && all === null ? " · saved while connected" : ""}{truncated && !remote ? " (search to find more)" : ""}
            </p>
          )}
          <ul className="contact-list" aria-label="Contacts">
            {matches.slice(0, visible).map((card, i) => {
              const savedId = (card.id && savedIdByCardKey.get(`id:${card.id}`)) || savedIdByCardKey.get(`name:${card.name.toLowerCase()}`);
              return (
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
                  <span className="call-actions">
                    <button type="button" className="text-button" aria-label={`Save ${card.name} as vCard`} onClick={() => downloadVCard(buildVCard(card), card.name)}>Save</button>
                    {savedId && client.removeSavedContact && (
                      <button type="button" className="text-button" aria-label={`Remove ${card.name}`} onClick={() => removeCard(card)}>Remove</button>
                    )}
                  </span>
                </li>
              );
            })}
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

export function formatChargeTimeRemaining(ms: number | undefined): string | null {
  if (!Number.isSafeInteger(ms) || ms === undefined || ms <= 0 || ms > 7 * 24 * 60 * 60 * 1000) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `Full in about ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `Full in about ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
}

function PhoneBatteryStatus({ status }: { status: PhoneBatteryStatusView }) {
  const isLow = status.level < 20 && !status.charging;
  const eta = status.charging ? formatChargeTimeRemaining(status.chargeTimeRemainingMs) : null;
  return (
    <div className={`phone-battery ${isLow ? "is-low" : ""}`}>
      <div className="phone-battery-line" role="status" aria-label={`${status.peerName} battery ${status.level} percent${status.charging ? `, charging${eta ? `, ${eta}` : ""}` : ""}`}>
        <span className="phone-battery-label">Phone battery</span>
        <strong>{status.level}%</strong>
        <span>{status.charging ? "Charging" : "On battery"}</span>
        {eta && <span className="phone-battery-eta">{eta}</span>}
      </div>
      {isLow && <div className="phone-battery-warning" role="alert">Low battery — put {status.peerName} on charge soon.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- screen

function ScreenPanel({ client, peer, guidance, shares }: { client: ContinuityClient; peer?: PeerSummary; guidance: string | null; shares: ScreenShareView[] }) {
  const [preset, setPreset] = useState<ScreenPreset>("motion");
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
  // keeps decode off the layout path; on macOS WKWebView / Safari WebKit
  // VideoDecoder requires an ISO 14496-15 avcC `description` + length-prefixed
  // samples (`avcc` mode), with Annex-B kept as an automatic fallback.
  useEffect(() => {
    if (!client.subscribeScreenVideo) return;
    type DecodedFrame = { displayWidth: number; displayHeight: number; close: () => void };
    type DecoderInstance = { configure(config: Record<string, unknown>): void; decode(chunk: unknown): void; close(): void };
    type DecoderCtor = {
      new (init: { output: (frame: DecodedFrame) => void; error: (error: Error) => void }): DecoderInstance;
      isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>;
    };
    type ChunkCtor = new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown;
    const api = window as unknown as Window & { VideoDecoder?: DecoderCtor; EncodedVideoChunk?: ChunkCtor };
    if (!api.VideoDecoder || !api.EncodedVideoChunk) {
      queueMicrotask(() => {
        setVideoError("This browser cannot decode the phone's low-latency H.264 stream. Use a current Chromium-based AirBridge desktop browser.");
      });
      return;
    }

    let disposed = false;
    let decoder: DecoderInstance | null = null;
    let decoderConfigKey: string | null = null;
    let decoderMode: 'avcc' | 'annexb' = 'annexb';
    let cachedCodecConfig: Uint8Array | null = null;
    let waitingForKeyFrame = true;
    let configuringPromise: Promise<void> | null = null;
    const pendingFrames: ScreenVideoFrame[] = [];
    let lastPliSentAt = 0;
    let lastFrameAt = Date.now();
    let pendingDrawFrame: DecodedFrame | null = null;
    let rafId: number | null = null;

    const requestPli = (reason: string) => {
      const now = Date.now();
      if (disposed || now - lastPliSentAt < 1_200) return;
      lastPliSentAt = now;
      client.requestScreenKeyframe?.(share.sessionId, reason);
    };

    const flushDraw = () => {
      const frame = pendingDrawFrame;
      pendingDrawFrame = null;
      if (!frame) return;
      try {
        if (!disposed) {
          const canvas = canvasRef.current;
          const context = canvas?.getContext('2d');
          if (canvas && context) {
            if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
            if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
            context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
            client.recordScreenViewerStats?.({ framesDecodedDelta: 1 });
            setH264Active(true);
            setHasFrame(true);
            setVideoError(null);
          }
        }
      } finally {
        try { frame.close(); } catch { /* ignore */ }
      }
    };

    const scheduleDraw = (frame: DecodedFrame) => {
      if (disposed) {
        try { frame.close(); } catch { /* ignore */ }
        return;
      }
      if (pendingDrawFrame) {
        try { pendingDrawFrame.close(); } catch { /* ignore */ }
      }
      pendingDrawFrame = frame;
      if (typeof requestAnimationFrame === 'function') {
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            flushDraw();
          });
        }
      } else {
        flushDraw();
      }
    };

    const makeDecoder = (mode: 'avcc' | 'annexb', codec: string, config: Record<string, unknown>, key: string) => {
      try { decoder?.close(); } catch { /* previous decoder already closed */ }
      const created: DecoderInstance = new api.VideoDecoder!({
        output: (frame) => scheduleDraw(frame),
        error: () => {
          if (disposed || decoder !== created) return;
          decoder = null;
          decoderConfigKey = null;
          waitingForKeyFrame = true;
          client.recordScreenViewerStats?.({ decodeErrorsDelta: 1 });
          setVideoError("The H.264 decoder recovered from a damaged frame and is waiting for the next sync frame.");
          requestPli('decode-error');
        },
      });
      created.configure(config);
      decoder = created;
      decoderMode = mode;
      decoderConfigKey = key;
      client.recordScreenViewerStats?.({ decoderMode: mode, codec });
    };

    const selectConfig = async (
      codec: string,
      spsPps: { sps: Uint8Array; pps: Uint8Array } | null,
    ): Promise<{ mode: 'avcc' | 'annexb'; config: Record<string, unknown> } | null> => {
      const candidates: Array<{ mode: 'avcc' | 'annexb'; config: Record<string, unknown> }> = [];
      if (spsPps) {
        const avcC = buildAvcDecoderConfigurationRecord(spsPps.sps, spsPps.pps);
        candidates.push(
          { mode: 'avcc', config: { codec, description: avcC, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' } },
          { mode: 'avcc', config: { codec, description: avcC, optimizeForLatency: true, hardwareAcceleration: 'no-preference' } },
        );
      }
      candidates.push(
        { mode: 'annexb', config: { codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' } },
        { mode: 'annexb', config: { codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' } },
      );
      const isSupported = api.VideoDecoder?.isConfigSupported;
      if (typeof isSupported !== 'function') {
        return candidates[0] ?? null;
      }
      for (const candidate of candidates) {
        try {
          const result = await isSupported.call(api.VideoDecoder, candidate.config);
          if (result?.supported) return candidate;
        } catch {
          // Try next configuration candidate
        }
      }
      return candidates[candidates.length - 1] ?? null;
    };

    const submitToDecoder = (frame: ScreenVideoFrame, accessUnit: Uint8Array) => {
      if (!decoder) {
        waitingForKeyFrame = true;
        setVideoError("Waiting for an H.264 sync frame with codec headers…");
        requestPli('missing-decoder');
        return;
      }
      try {
        const payload = decoderMode === 'avcc' ? annexBToAvcc(accessUnit) : accessUnit;
        decoder.decode(new api.EncodedVideoChunk!({
          type: frame.keyFrame ? 'key' : 'delta',
          timestamp: frame.ptsMs * 1000,
          data: payload,
        }));
        waitingForKeyFrame = false;
      } catch {
        waitingForKeyFrame = true;
        client.recordScreenViewerStats?.({ decodeErrorsDelta: 1 });
        requestPli('decode-exception');
      }
    };

    const handleFrame = (frame: ScreenVideoFrame) => {
      if (disposed) return;
      lastFrameAt = Date.now();
      mapSourceTime(frame.ptsMs);
      let accessUnit = frame.data;
      const foundSpsPps = extractSpsPps(accessUnit);
      if (foundSpsPps) {
        const spsLen = foundSpsPps.sps.byteLength;
        const ppsLen = foundSpsPps.pps.byteLength;
        const combined = new Uint8Array(8 + spsLen + ppsLen);
        combined.set([0, 0, 0, 1], 0);
        combined.set(foundSpsPps.sps, 4);
        combined.set([0, 0, 0, 1], 4 + spsLen);
        combined.set(foundSpsPps.pps, 8 + spsLen);
        cachedCodecConfig = combined;
      } else if (frame.keyFrame && cachedCodecConfig) {
        accessUnit = prependSpsPpsIfMissing(accessUnit, cachedCodecConfig);
      }

      if (frame.keyFrame) {
        client.recordScreenViewerStats?.({ keyframesReceivedDelta: 1 });
      }
      if (waitingForKeyFrame && !frame.keyFrame) {
        requestPli('awaiting-keyframe');
        return;
      }

      if (configuringPromise) {
        if (frame.keyFrame) pendingFrames.length = 0;
        if (pendingFrames.length < 15) pendingFrames.push({ ...frame, data: accessUnit });
        return;
      }

      if (frame.keyFrame) {
        const effectiveSpsPps = foundSpsPps ?? extractSpsPps(accessUnit);
        const detectedCodec = h264CodecFromAnnexB(accessUnit);
        const targetKey = detectedCodec ? `${detectedCodec}:${effectiveSpsPps ? 'avcc' : 'annexb'}` : null;
        if (detectedCodec && targetKey !== decoderConfigKey) {
          if (typeof api.VideoDecoder?.isConfigSupported !== 'function') {
            try {
              const avcC = effectiveSpsPps
                ? buildAvcDecoderConfigurationRecord(effectiveSpsPps.sps, effectiveSpsPps.pps)
                : undefined;
              const syncConfig: Record<string, unknown> = {
                codec: detectedCodec,
                ...(avcC ? { description: avcC } : {}),
                optimizeForLatency: true,
                hardwareAcceleration: 'prefer-hardware',
              };
              makeDecoder(avcC ? 'avcc' : 'annexb', detectedCodec, syncConfig, targetKey!);
            } catch {
              decoder = null;
              decoderConfigKey = null;
              waitingForKeyFrame = true;
              client.recordScreenViewerStats?.({ decodeErrorsDelta: 1 });
              setVideoError("This browser cannot initialise the phone's H.264 profile.");
              return;
            }
          } else {
            pendingFrames.length = 0;
            pendingFrames.push({ ...frame, data: accessUnit });
            configuringPromise = (async () => {
              try {
                const chosen = await selectConfig(detectedCodec, effectiveSpsPps);
                if (disposed || !chosen) return;
                makeDecoder(chosen.mode, detectedCodec, chosen.config, targetKey!);
                const batch = pendingFrames.splice(0);
                for (const queued of batch) {
                  if (disposed) break;
                  submitToDecoder(queued, queued.data);
                }
              } catch {
                decoder = null;
                decoderConfigKey = null;
                waitingForKeyFrame = true;
                client.recordScreenViewerStats?.({ decodeErrorsDelta: 1 });
                setVideoError("This browser cannot initialise the phone's H.264 profile.");
              } finally {
                configuringPromise = null;
              }
            })();
            return;
          }
        }
      }

      submitToDecoder(frame, accessUnit);
    };

    const unsubscribe = client.subscribeScreenVideo(share.sessionId, handleFrame);
    const watchdog = window.setInterval(() => {
      if (!disposed && waitingForKeyFrame && Date.now() - lastFrameAt > 2_500) {
        requestPli('stalled-keyframe');
      }
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      if (pendingDrawFrame) {
        try { pendingDrawFrame.close(); } catch { /* ignore */ }
        pendingDrawFrame = null;
      }
      pendingFrames.length = 0;
      unsubscribe();
      try { decoder?.close(); } catch { /* decoder already closed */ }
    };
  }, [client, share.sessionId]);

  // The source sends timestamped, small PCM packets. Keep a bounded local
  // jitter buffer and drop old packets rather than letting A/V drift grow.
  useEffect(() => {
    if (!audioEnabled || !client.subscribeScreenAudio || !contextRef.current) return;
    const context = contextRef.current;
    const audioNodes = audioNodesRef.current;
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
      audioNodes.add(node);
      node.onended = () => { audioNodes.delete(node); node.disconnect(); };
      node.start(startAt);
      playheadRef.current = startAt + buffer.duration;
    });
    return () => {
      unsubscribe();
      for (const node of audioNodes) { try { node.stop(); } catch { /* already stopped */ } }
      audioNodes.clear();
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
      {share.state === "active" && !share.audioAvailable && <small className="continuity-note">To share sound, stop and share again, select “Also share permitted app audio” in the phone’s consent, and allow Android’s optional audio-capture permission if asked. When audio becomes available, click “Play app audio” here. This captures app playback, not microphone audio; Android, the source app, or protected content may block it.</small>}
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
