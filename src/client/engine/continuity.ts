/**
 * Phone continuity for the browser / desktop peer: contacts, calls and screen
 * sharing over the paired, end-to-end encrypted session (docs/continuity.md).
 *
 * WarpClient owns sockets and keys; this manager owns continuity state and
 * talks to the session only through {@link ContinuityHost}, which keeps it
 * testable and keeps the transfer engine untouched.
 *
 * Authorization (enforced on the device that holds the data):
 *  - reading contacts, controlling calls and viewing the screen require a
 *    peer in the same paired room whose keys were vouched for by the computer
 *    that knows the pairing code (or that the user explicitly trusted);
 *  - call-state and contact cards are only accepted from paired-room members,
 *    never from "nearby" strangers on the same network.
 */
import {
  CALL_AUDIO_MAX_FRAME_BYTES,
  CALL_AUDIO_MAX_FRAMES,
  CALL_AUDIO_SAMPLE_RATE,
  CONTINUITY_PROTOCOL_VERSION,
  DEFAULT_CONTACTS_LIMIT,
  MAX_CONTACTS_PER_RESPONSE,
  MAX_CONTACT_QUERY,
  MAX_VCARD_LENGTH,
  SCREEN_CODEC_H264,
  SCREEN_CODEC_JPEG,
  SCREEN_CONSENT_TIMEOUT_MS,
  SCREEN_MAX_FRAME_BYTES,
  SCREEN_MAX_INFLIGHT,
  buildVCards,
  clampScreenParams,
  decodeCallAudioFrame,
  decodeScreenAudioFrame,
  decodeScreenFrame,
  decodeScreenH264Packet,
  dialableNumber,
  encodeCallAudioAad,
  encodeCallAudioFrame,
  encodeScreenFrame,
  encodeScreenFrameAad,
  isCallAction,
  isContinuityId,
  nextScreenQuality,
  parseVCards,
  sanitizeCall,
  sanitizeContact,
  sanitizeFeatures,
  type CallAction,
  type CallInfo,
  type ContactCard,
  type ContinuityFeature,
  type SavedContactRecord,
  type ScreenShareState,
} from '../../shared/continuity.js';
import type { ControlPayload, PeerSummary } from '../../shared/protocol.js';
import type { CallAudioSessionStats } from './callAudio.js';
import { decryptMediaFrame, encryptMediaFrame } from './crypto.js';

export interface ContactsQueryResult {
  contacts: ContactCard[];
  total: number;
  truncated: boolean;
}

export interface ContactShareItem {
  shareId: string;
  peerId: string;
  peerName: string;
  direction: 'incoming' | 'outgoing';
  contacts: ContactCard[];
  vcard: string;
  timestamp: number;
}

export interface CallView extends CallInfo {
  peerId: string;
  peerName: string;
}

export interface PhoneBatteryStatusView {
  peerId: string;
  peerName: string;
  level: number;
  charging: boolean;
  /** Android estimate in milliseconds; absent when not charging or unavailable. */
  chargeTimeRemainingMs?: number;
  updatedAt: number;
}

export interface ScreenShareView {
  sessionId: string;
  peerId: string;
  peerName: string;
  /** viewer = this device watches the peer; source = this device is shared. */
  role: 'viewer' | 'source';
  state: ScreenShareState;
  width: number;
  height: number;
  maxWidth: number;
  maxFps: number;
  frames: number;
  fps: number;
  kbps: number;
  /** Playback audio is available only when Android and the source app permit capture. */
  audioAvailable?: boolean;
  quality?: number;
  reason?: string;
  startedAt: number;
  updatedAt: number;
}

export interface ScreenShareRequestView {
  sessionId: string;
  peerId: string;
  peerName: string;
  maxWidth: number;
  maxFps: number;
  requestedAt: number;
}

export interface CallAudioStateView {
  peerId: string;
  callId: string;
  active: boolean;
  muted: boolean;
  route: 'computer' | 'phone';
  reason?: string;
}

export interface CallAudioFrame {
  callId: string;
  peerId: string;
  seq: number;
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  ptsMs: number;
  data: Uint8Array;
}

export interface ContinuityDiagnosticsSnapshot {
  screenShare: {
    activeSessions: number;
    targetFps: number;
    actualFps: number;
    actualKbps: number;
    decoderMode: string | null;
    codec: string | null;
    framesDecoded: number;
    framesRendered: number;
    framesDroppedBeforeDraw: number;
    decodeErrors: number;
    keyframesReceived: number;
    pliSent: number;
    pliReceived: number;
    fullscreenMode: string;
    lastFullscreenError: string | null;
    audioContextState: string;
    audioFramesReceived: number;
    audioFramesPlayed: number;
    audioNonZeroFrames: number;
    audioSilentFrames: number;
    audioFramesDroppedStale: number;
    audioFramesDroppedDecrypt: number;
    audioLastRms: number;
  };
  contacts: {
    savedCount: number;
    removedByUser: number;
    clearedOnDisconnect: number;
  };
  callAudio: {
    active: boolean;
    muted: boolean;
    route: 'computer' | 'phone';
    framesSent: number;
    framesReceived: number;
    packetsDropped: number;
    lastError: string | null;
    captureMode: string;
    audioContextState: string;
    audioContextSampleRate: number;
    micFramesCaptured: number;
    micNonZeroFrames: number;
    micLastRms: number;
    playbackFramesScheduled: number;
    playbackNonZeroFrames: number;
    playbackSilentFrames: number;
    playbackLastRms: number;
  };
}

export interface ContinuitySnapshot {
  /** What each peer announced it can do (empty = older app / not announced yet). */
  peerFeatures: Record<string, ContinuityFeature[]>;
  calls: CallView[];
  screenShares: ScreenShareView[];
  screenRequests: ScreenShareRequestView[];
  sharedContacts: ContactShareItem[];
  savedContacts?: SavedContactRecord[];
  callAudio?: CallAudioStateView | null;
  batteryStatus: Record<string, PhoneBatteryStatusView>;
}

export const EMPTY_CONTINUITY: ContinuitySnapshot = {
  peerFeatures: {},
  calls: [],
  screenShares: [],
  screenRequests: [],
  sharedContacts: [],
  savedContacts: [],
  callAudio: null,
  batteryStatus: {},
};

export interface ScreenFrame {
  sessionId: string;
  peerId: string;
  seq: number;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  data: Uint8Array;
}

/** A short encrypted PCM packet. The viewer schedules it with a tiny jitter buffer. */
export interface ScreenVideoFrame {
  sessionId: string;
  peerId: string;
  seq: number;
  width: number;
  height: number;
  /** AVC/H.264 Annex-B access unit from the Android MediaCodec encoder. */
  codec: 'h264';
  keyFrame: boolean;
  ptsMs: number;
  data: Uint8Array;
}

export interface ScreenAudioFrame {
  sessionId: string;
  peerId: string;
  seq: number;
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  ptsMs: number;
  data: Uint8Array;
}

export interface CapturedScreenFrame {
  /** Encoded JPEG bytes. */
  data: Uint8Array;
  width: number;
  height: number;
}

/** Produces encoded frames on demand (latest-frame-wins; never queues). */
export interface ScreenFrameSource {
  capture(options: { maxWidth: number; quality: number }): Promise<CapturedScreenFrame | null>;
  stop(): void;
  /** Called when the OS/user ends the capture (e.g. "Stop sharing" in the browser). */
  onEnded?(callback: () => void): void;
}

export interface CallCommand {
  peerId: string;
  action: CallAction;
  callId?: string;
  number?: string;
}

export interface CallCommandResult {
  ok: boolean;
  error?: string;
  callId?: string;
}

export interface ContinuityOptions {
  /** This device can answer contacts-request (phones / simulators). */
  contactProvider?: (query: string, limit: number) => Promise<ContactCard[]> | ContactCard[];
  /** This device can execute call commands (phones / simulators). */
  callController?: (command: CallCommand) => Promise<CallCommandResult> | CallCommandResult;
  /** This device can bridge two-way encrypted call audio (MacBook browser / desktop). */
  callAudioAvailable?: boolean;
  /** Phone/controller side handler for call-audio start/stop/mute commands. */
  callAudioController?: (command: { peerId: string; callId: string; action: 'start' | 'stop' | 'mute' | 'unmute'; sampleRate?: number }) => Promise<{ active: boolean; muted: boolean; route?: 'computer' | 'phone'; reason?: string }> | { active: boolean; muted: boolean; route?: 'computer' | 'phone'; reason?: string };
  /** This device can share its screen (getDisplayMedia, or a test source). */
  screenSourceAvailable?: boolean | (() => boolean);
  /** Optional callback invoked when a viewer asks this source for a fresh H.264 IDR keyframe. */
  onScreenKeyframeRequest?: (sessionId: string, reason?: string) => void;
  /** Persistence store for permanent saved contacts. */
  storage?: Storage | null;
  storagePrefix?: string;
  onCallStateChanged?: (call: CallView) => void;
  onIncomingContact?: (item: ContactShareItem) => void;
  onScreenShareRequest?: (request: ScreenShareRequestView) => void;
  /** Called once when a phone first reports a low, unplugged battery; reset above 20% or when charging. */
  onLowPhoneBattery?: (status: PhoneBatteryStatusView) => void;
}

export interface ContinuityHost {
  sendControl(peerId: string, payload: ControlPayload): Promise<void>;
  /** Sends a routed binary frame; false = socket busy or closed (frame dropped). */
  sendFrame(peerId: string, innerFrame: Uint8Array): boolean;
  sessionKey(peerId: string): Promise<CryptoKey | null>;
  peer(peerId: string): PeerSummary | undefined;
  /** Same paired room and vouched-for (or explicitly trusted). */
  isAuthorized(peerId: string): boolean;
  /** Same paired room (not a nearby stranger). */
  isPaired(peerId: string): boolean;
  peerIds(): string[];
  emit(): void;
}

const CONTACTS_TIMEOUT_MS = 30_000;
const CALL_COMMAND_TIMEOUT_MS = 15_000;
const ENDED_CALL_LINGER_MS = 5_000;
const STOPPED_SHARE_LINGER_MS = 8_000;
const MAX_CALLS = 8;
const MAX_SHARED_CONTACTS = 30;
const MAX_SAVED_CONTACTS = 2000;
const MAX_CHARGE_TIME_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;
const ACK_STALL_MS = 3_000;
const STATS_EMIT_MS = 500;
const SAVED_CONTACTS_STORAGE_SUFFIX = ':continuity:savedContacts:v1';

interface Pending<T> {
  peerId: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SourceSession {
  view: ScreenShareView;
  source: ScreenFrameSource;
  nextSeq: number;
  ackedSeq: number;
  lastAckAt: number;
  sentAt: Map<number, number>;
  quality: number;
  running: boolean;
  wake?: () => void;
}

interface ViewerSession {
  view: ScreenShareView;
  lastSeq: number;
  lastAudioSeq: number;
  lastAudioPtsMs?: number;
  lastFrame?: ScreenFrame;
  windowStart: number;
  windowFrames: number;
  windowBytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ContinuityManager {
  private readonly peerFeatures = new Map<string, ContinuityFeature[]>();
  private readonly calls = new Map<string, { view: CallView; timer?: ReturnType<typeof setTimeout> }>();
  private readonly sources = new Map<string, SourceSession>();
  private readonly viewers = new Map<string, ViewerSession>();
  private readonly requests = new Map<string, { view: ScreenShareRequestView; timer: ReturnType<typeof setTimeout> }>();
  private readonly sharedContacts: ContactShareItem[] = [];
  private savedContacts: SavedContactRecord[] = [];
  private readonly batteryStatus = new Map<string, PhoneBatteryStatusView>();
  private readonly lowBatteryNotified = new Set<string>();
  private readonly contactRequests = new Map<string, Pending<ContactsQueryResult>>();
  private readonly callCommands = new Map<string, Pending<CallCommandResult>>();
  private readonly frameListeners = new Map<string, Set<(frame: ScreenFrame) => void>>();
  /** Serialize async decrypts: H.264 deltas must reach WebCodecs in wire order. */
  private readonly screenFrameQueues = new Map<string, Promise<void>>();
  /** Serialize async screen-audio decrypts so concurrent WebCrypto resolutions never race cursor checks. */
  private readonly screenAudioQueues = new Map<string, Promise<void>>();
  private readonly videoListeners = new Map<string, Set<(frame: ScreenVideoFrame) => void>>();
  private readonly audioListeners = new Map<string, Set<(frame: ScreenAudioFrame) => void>>();
  private readonly callAudioListeners = new Map<string, Set<(frame: CallAudioFrame) => void>>();
  private readonly lingerTimers = new Set<ReturnType<typeof setTimeout>>();
  private knownPeers = new Map<string, { peerId: string; publicKey: string; deviceId?: string; peerKey: string; name?: string }>();
  private callAudioState: CallAudioStateView | null = null;
  private callAudioSeq = 1;
  private readonly lastCallAudioCursor = new Map<string, { seq: number; ptsMs?: number }>();
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private startupContactsReconciled = false;
  private destroyed = false;

  // Continuity diagnostics telemetry
  private screenDecoderMode: string | null = null;
  private screenCodec: string | null = null;
  private screenFramesDecoded = 0;
  private screenFramesRendered = 0;
  private screenFramesDroppedBeforeDraw = 0;
  private screenDecodeErrors = 0;
  private screenKeyframesReceived = 0;
  private screenPliSent = 0;
  private screenPliReceived = 0;
  private screenFullscreenMode = 'none';
  private screenLastFullscreenError: string | null = null;
  private screenAudioContextState = 'uninitialized';
  private screenAudioFramesReceived = 0;
  private screenAudioFramesPlayed = 0;
  private screenAudioNonZeroFrames = 0;
  private screenAudioSilentFrames = 0;
  private screenAudioFramesDroppedStale = 0;
  private screenAudioFramesDroppedDecrypt = 0;
  private screenAudioLastRms = 0;
  private contactsRemovedByUser = 0;
  private contactsClearedOnDisconnect = 0;
  private callAudioFramesSent = 0;
  private callAudioFramesReceived = 0;
  private callAudioPacketsDropped = 0;
  private callAudioLastError: string | null = null;
  private callAudioCaptureMode = 'none';
  private callAudioContextState = 'uninitialized';
  private callAudioContextSampleRate = 0;
  private callAudioMicFramesCaptured = 0;
  private callAudioMicNonZeroFrames = 0;
  private callAudioMicLastRms = 0;
  private callAudioPlaybackFramesScheduled = 0;
  private callAudioPlaybackNonZeroFrames = 0;
  private callAudioPlaybackSilentFrames = 0;
  private callAudioPlaybackLastRms = 0;

  constructor(private readonly host: ContinuityHost, private options: ContinuityOptions = {}) {
    this.loadSavedContacts();
  }

  private savedContactsStorageKey(): string {
    return `${this.options.storagePrefix ?? 'airbridge'}${SAVED_CONTACTS_STORAGE_SUFFIX}`;
  }

  private loadSavedContacts(): void {
    const store = this.options.storage;
    if (!store) return;
    try {
      const raw = store.getItem(this.savedContactsStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const restored: SavedContactRecord[] = [];
      for (const entry of parsed.slice(0, MAX_SAVED_CONTACTS)) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Partial<SavedContactRecord>;
        const contact = sanitizeContact(item.contact);
        if (!contact || typeof item.id !== 'string' || typeof item.peerId !== 'string' || typeof item.peerKey !== 'string') continue;
        restored.push({
          id: item.id.slice(0, 256),
          peerId: item.peerId,
          peerDeviceId: typeof item.peerDeviceId === 'string' ? item.peerDeviceId : undefined,
          peerKey: item.peerKey,
          peerName: typeof item.peerName === 'string' && item.peerName.trim() ? item.peerName : 'Paired device',
          contact,
          source: item.source === 'shared' ? 'shared' : 'synced',
          savedAt: typeof item.savedAt === 'number' && Number.isFinite(item.savedAt) ? item.savedAt : Date.now(),
        });
      }
      this.savedContacts = restored;
    } catch {
      this.savedContacts = [];
    }
  }

  private persistSavedContacts(): void {
    const store = this.options.storage;
    if (!store) return;
    try {
      store.setItem(this.savedContactsStorageKey(), JSON.stringify(this.savedContacts.slice(0, MAX_SAVED_CONTACTS)));
    } catch {
      // ignore quota/private-mode storage failure
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  features(): ContinuityFeature[] {
    // Desktop viewers can render the lightweight signed-PCM stream directly
    // with Web Audio. The Android source still decides whether the OS and the
    // app allow capture; this advertisement never requests protected audio.
    const out: ContinuityFeature[] = ['contacts.receive', 'screen.view', 'screen.audio.play'];
    if (this.options.contactProvider) out.push('contacts.provide');
    if (this.options.callController) out.push('calls.control');
    if (this.options.callAudioAvailable || this.options.callAudioController) out.push('calls.audio');
    const screen = this.options.screenSourceAvailable;
    if (typeof screen === 'function' ? screen() : screen) out.push('screen.source');
    return out;
  }

  /** Replace providers at runtime (permission granted, toggle changed) and re-announce. */
  configure(options: Partial<ContinuityOptions>): void {
    this.options = { ...this.options, ...options };
    this.announce();
  }

  announce(peerId?: string): void {
    const targets = peerId ? [peerId] : this.host.peerIds();
    const payload: ControlPayload = { kind: 'continuity-hello', v: CONTINUITY_PROTOCOL_VERSION, features: this.features() };
    for (const id of targets) {
      if (!this.host.isPaired(id)) continue;
      void this.host.sendControl(id, payload).catch(() => {});
    }
  }

  /**
   * Call whenever the roster changes. A peer that reconnects with a fresh
   * session key is re-announced to (its app may have restarted) but keeps its
   * calls and screen sessions; a peer that left is cleaned up.
   */
  onPeersChanged(
    peers: Array<{ peerId: string; publicKey: string; deviceId?: string; identityKey?: string; name?: string }>,
  ): void {
    const next = new Map<string, { peerId: string; publicKey: string; deviceId?: string; peerKey: string; name?: string }>();
    for (const p of peers) {
      const peerKey = p.identityKey || p.deviceId || p.publicKey;
      next.set(p.peerId, { peerId: p.peerId, publicKey: p.publicKey, deviceId: p.deviceId, peerKey, name: p.name });
      // Keep saved contact peer metadata up to date when the peer reloads/reconnects
      let updated = false;
      for (let i = 0; i < this.savedContacts.length; i += 1) {
        const record = this.savedContacts[i]!;
        const matches =
          (record.peerDeviceId && p.deviceId && record.peerDeviceId === p.deviceId) ||
          record.peerKey === peerKey ||
          record.peerId === p.peerId;
        if (matches && (record.peerId !== p.peerId || record.peerKey !== peerKey || (p.name && record.peerName !== p.name))) {
          this.savedContacts[i] = {
            ...record,
            peerId: p.peerId,
            peerDeviceId: p.deviceId ?? record.peerDeviceId,
            peerKey,
            peerName: p.name ?? record.peerName,
          };
          updated = true;
        }
      }
      if (updated) this.persistSavedContacts();
    }
    for (const [id, info] of next) {
      if (this.knownPeers.get(id)?.publicKey === info.publicKey) continue;
      this.announce(id);
      // The first hello can race the peer's own roster update and be dropped
      // there; one retry covers it (peers also answer a first hello in kind).
      this.linger(() => {
        if (this.knownPeers.get(id)?.publicKey === info.publicKey && !this.peerFeatures.has(id)) this.announce(id);
      }, 2_000);
    }
    for (const [id, prev] of this.knownPeers.entries()) {
      if (!next.has(id)) this.dropPeer(id, prev, [...next.values()]);
    }
    this.knownPeers = next;
    if (!this.startupContactsReconciled) {
      this.startupContactsReconciled = true;
      if (this.savedContacts.length > 0) {
        this.linger(() => {
          const active = [...this.knownPeers.values()];
          const before = this.savedContacts.length;
          if (before === 0) return;
          this.savedContacts = this.savedContacts.filter((record) =>
            active.some(
              (p) =>
                (record.peerDeviceId && p.deviceId && record.peerDeviceId === p.deviceId) ||
                record.peerKey === p.peerKey ||
                record.peerId === p.peerId,
            ),
          );
          const removed = before - this.savedContacts.length;
          if (removed > 0) {
            this.contactsClearedOnDisconnect += removed;
            this.persistSavedContacts();
            this.host.emit();
          }
        }, 3_000);
      }
    }
  }

  private dropPeer(
    peerId: string,
    prevInfo?: { peerId: string; publicKey: string; deviceId?: string; peerKey: string },
    remainingPeers: Array<{ peerId: string; publicKey: string; deviceId?: string; peerKey: string }> = [],
  ): void {
    this.peerFeatures.delete(peerId);
    this.batteryStatus.delete(peerId);
    this.lowBatteryNotified.delete(peerId);
    const stillConnectedElsewhere = prevInfo
      ? remainingPeers.some(
          (p) =>
            (prevInfo.deviceId && p.deviceId === prevInfo.deviceId) ||
            p.peerKey === prevInfo.peerKey,
        )
      : false;
    if (!stillConnectedElsewhere) {
      this.purgeSavedContactsForPeer(peerId, prevInfo?.peerKey, prevInfo?.deviceId);
    }
    if (this.callAudioState?.peerId === peerId) {
      this.callAudioState = null;
      this.callAudioListeners.clear();
    }
    for (const k of [...this.lastCallAudioCursor.keys()]) {
      if (k.startsWith(`${peerId}:`)) this.lastCallAudioCursor.delete(k);
    }
    for (const [key, entry] of this.calls) {
      if (entry.view.peerId === peerId) {
        if (entry.timer) clearTimeout(entry.timer);
        this.calls.delete(key);
      }
    }
    for (const [id, req] of this.requests) {
      if (req.view.peerId === peerId) {
        clearTimeout(req.timer);
        this.requests.delete(id);
      }
    }
    for (const session of this.sources.values()) {
      if (session.view.peerId === peerId) this.finishSource(session, 'stopped', 'Viewer disconnected', false);
    }
    for (const session of this.viewers.values()) {
      if (session.view.peerId === peerId) this.finishViewer(session, 'stopped', 'Device disconnected');
    }
    for (const map of [this.contactRequests, this.callCommands] as Array<Map<string, Pending<never>>>) {
      for (const [id, pending] of map) {
        if (pending.peerId !== peerId) continue;
        clearTimeout(pending.timer);
        map.delete(id);
        pending.reject(new Error('The device disconnected.'));
      }
    }
    this.host.emit();
  }

  private purgeSavedContactsForPeer(peerId: string, peerKey?: string, peerDeviceId?: string): void {
    const before = this.savedContacts.length;
    if (before === 0) return;
    this.savedContacts = this.savedContacts.filter((record) => {
      if (peerDeviceId && record.peerDeviceId === peerDeviceId) return false;
      if (peerKey && record.peerKey === peerKey) return false;
      if (record.peerId === peerId && !peerDeviceId && !peerKey) return false;
      if (record.peerId === peerId && (!record.peerDeviceId || record.peerDeviceId === peerDeviceId)) return false;
      return true;
    });
    const removed = before - this.savedContacts.length;
    if (removed > 0) {
      this.contactsClearedOnDisconnect += removed;
      this.persistSavedContacts();
    }
  }

  snapshot(): ContinuitySnapshot {
    return {
      peerFeatures: Object.fromEntries(this.peerFeatures),
      calls: [...this.calls.values()].map((c) => ({ ...c.view })).sort((a, b) => b.updatedAt - a.updatedAt),
      screenShares: [...this.viewers.values(), ...this.sources.values()].map((s) => ({ ...s.view })),
      screenRequests: [...this.requests.values()].map((r) => ({ ...r.view })),
      sharedContacts: this.sharedContacts.slice(),
      savedContacts: this.savedContacts.map((r) => ({ ...r })),
      callAudio: this.callAudioState ? { ...this.callAudioState } : null,
      batteryStatus: Object.fromEntries(this.batteryStatus),
    };
  }

  getDiagnostics(): ContinuityDiagnosticsSnapshot {
    const activeList = [...this.viewers.values(), ...this.sources.values()].filter((s) =>
      ['requesting', 'pending', 'active'].includes(s.view.state),
    );
    const activeSessions = activeList.length;
    const primarySession =
      activeList.find((s) => s.view.role === 'viewer' && s.view.state === 'active') ??
      activeList[0];
    return {
      screenShare: {
        activeSessions,
        targetFps: primarySession?.view.maxFps ?? 0,
        actualFps: primarySession?.view.fps ?? 0,
        actualKbps: primarySession?.view.kbps ?? 0,
        decoderMode: this.screenDecoderMode,
        codec: this.screenCodec,
        framesDecoded: this.screenFramesDecoded,
        framesRendered: this.screenFramesRendered,
        framesDroppedBeforeDraw: this.screenFramesDroppedBeforeDraw,
        decodeErrors: this.screenDecodeErrors,
        keyframesReceived: this.screenKeyframesReceived,
        pliSent: this.screenPliSent,
        pliReceived: this.screenPliReceived,
        fullscreenMode: this.screenFullscreenMode,
        lastFullscreenError: this.screenLastFullscreenError,
        audioContextState: this.screenAudioContextState,
        audioFramesReceived: this.screenAudioFramesReceived,
        audioFramesPlayed: this.screenAudioFramesPlayed,
        audioNonZeroFrames: this.screenAudioNonZeroFrames,
        audioSilentFrames: this.screenAudioSilentFrames,
        audioFramesDroppedStale: this.screenAudioFramesDroppedStale,
        audioFramesDroppedDecrypt: this.screenAudioFramesDroppedDecrypt,
        audioLastRms: this.screenAudioLastRms,
      },
      contacts: {
        savedCount: this.savedContacts.length,
        removedByUser: this.contactsRemovedByUser,
        clearedOnDisconnect: this.contactsClearedOnDisconnect,
      },
      callAudio: {
        active: this.callAudioState?.active ?? false,
        muted: this.callAudioState?.muted ?? false,
        route: this.callAudioState?.route ?? 'phone',
        framesSent: this.callAudioFramesSent,
        framesReceived: this.callAudioFramesReceived,
        packetsDropped: this.callAudioPacketsDropped,
        lastError: this.callAudioLastError,
        captureMode: this.callAudioCaptureMode,
        audioContextState: this.callAudioContextState,
        audioContextSampleRate: this.callAudioContextSampleRate,
        micFramesCaptured: this.callAudioMicFramesCaptured,
        micNonZeroFrames: this.callAudioMicNonZeroFrames,
        micLastRms: this.callAudioMicLastRms,
        playbackFramesScheduled: this.callAudioPlaybackFramesScheduled,
        playbackNonZeroFrames: this.callAudioPlaybackNonZeroFrames,
        playbackSilentFrames: this.callAudioPlaybackSilentFrames,
        playbackLastRms: this.callAudioPlaybackLastRms,
      },
    };
  }

  destroy(): void {
    this.destroyed = true;
    for (const session of this.sources.values()) {
      session.running = false;
      session.wake?.();
      try { session.source.stop(); } catch { /* already stopped */ }
    }
    for (const session of this.viewers.values()) if (session.timer) clearTimeout(session.timer);
    for (const req of this.requests.values()) clearTimeout(req.timer);
    for (const call of this.calls.values()) if (call.timer) clearTimeout(call.timer);
    for (const timer of this.lingerTimers) clearTimeout(timer);
    this.screenFrameQueues.clear();
    this.screenAudioQueues.clear();
    this.batteryStatus.clear();
    this.lowBatteryNotified.clear();
    for (const map of [this.contactRequests, this.callCommands] as Array<Map<string, Pending<never>>>) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('AirBridge stopped.'));
      }
      map.clear();
    }
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.sources.clear();
    this.viewers.clear();
    this.requests.clear();
    this.frameListeners.clear();
    this.videoListeners.clear();
    this.audioListeners.clear();
    this.callAudioListeners.clear();
    this.callAudioState = null;
  }

  private peerName(peerId: string): string {
    return this.host.peer(peerId)?.device.name || 'Paired device';
  }

  private send(peerId: string, payload: ControlPayload): void {
    void this.host.sendControl(peerId, payload).catch(() => {});
  }

  private linger(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.lingerTimers.delete(timer);
      if (!this.destroyed) fn();
    }, ms);
    this.lingerTimers.add(timer);
  }

  // -------------------------------------------------------------------------
  // Incoming control
  // -------------------------------------------------------------------------

  /** Returns true when the payload was a continuity message (handled or rejected). */
  async handleControl(fromPeerId: string, payload: ControlPayload): Promise<boolean> {
    if (this.destroyed) return false;
    switch (payload.kind) {
      case 'continuity-hello':
        if (!this.host.isPaired(fromPeerId)) return true;
        {
          const first = !this.peerFeatures.has(fromPeerId);
          this.peerFeatures.set(fromPeerId, sanitizeFeatures(payload.features));
          if (first) this.announce(fromPeerId);
        }
        this.host.emit();
        return true;
      case 'contacts-request':
        await this.answerContactsRequest(fromPeerId, payload);
        return true;
      case 'contacts-response':
        this.settleContacts(fromPeerId, payload);
        return true;
      case 'contact-share':
        this.receiveContactShare(fromPeerId, payload);
        return true;
      case 'call-state':
        this.receiveCallState(fromPeerId, payload.call);
        return true;
      case 'battery-status':
        this.receiveBatteryStatus(fromPeerId, payload);
        return true;
      case 'call-command':
        await this.executeCallCommand(fromPeerId, payload);
        return true;
      case 'call-command-result': {
        const pending = this.callCommands.get(payload.commandId);
        if (!pending || pending.peerId !== fromPeerId) return true;
        clearTimeout(pending.timer);
        this.callCommands.delete(payload.commandId);
        pending.resolve({
          ok: payload.ok === true,
          error: typeof payload.error === 'string' ? payload.error.slice(0, 300) : undefined,
          callId: isContinuityId(payload.callId) ? payload.callId : undefined,
        });
        return true;
      }
      case 'screen-share-request':
        this.receiveScreenRequest(fromPeerId, payload);
        return true;
      case 'screen-share-state':
        this.receiveScreenState(fromPeerId, payload);
        return true;
      case 'screen-share-ack':
        this.receiveScreenAck(fromPeerId, payload.sessionId, payload.seq);
        return true;
      case 'screen-share-keyframe': {
        const session = this.sources.get(payload.sessionId);
        if (session && session.view.peerId === fromPeerId) {
          this.screenPliReceived++;
          this.options.onScreenKeyframeRequest?.(payload.sessionId, payload.reason);
        }
        return true;
      }
      case 'screen-share-stop': {
        const session = this.sources.get(payload.sessionId);
        if (session && session.view.peerId === fromPeerId) {
          this.finishSource(session, 'stopped', 'Viewer stopped watching', false);
        } else {
          const req = this.requests.get(payload.sessionId);
          if (req && req.view.peerId === fromPeerId) {
            clearTimeout(req.timer);
            this.requests.delete(payload.sessionId);
            this.host.emit();
          }
        }
        return true;
      }
      case 'call-audio-control':
        await this.executeCallAudioControl(fromPeerId, payload);
        return true;
      case 'call-audio-state':
        this.receiveCallAudioState(fromPeerId, payload);
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  requestContacts(peerId: string, options: { query?: string; limit?: number } = {}): Promise<ContactsQueryResult> {
    if (!this.host.peer(peerId)) return Promise.reject(new Error('That device is not connected.'));
    const requestId = randomId();
    const query = (options.query ?? '').trim().slice(0, MAX_CONTACT_QUERY);
    const limit = Math.min(MAX_CONTACTS_PER_RESPONSE, Math.max(1, Math.round(options.limit ?? DEFAULT_CONTACTS_LIMIT)));
    return new Promise<ContactsQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.contactRequests.delete(requestId);
        reject(new Error(`${this.peerName(peerId)} did not answer. Open AirBridge on the phone and check that it is up to date.`));
      }, CONTACTS_TIMEOUT_MS);
      this.contactRequests.set(requestId, { peerId, resolve, reject, timer });
      this.host.sendControl(peerId, { kind: 'contacts-request', requestId, query: query || undefined, limit }).catch((error: unknown) => {
        clearTimeout(timer);
        this.contactRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error('Could not reach the device.'));
      });
    });
  }

  private settleContacts(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'contacts-response' }>): void {
    const pending = this.contactRequests.get(payload.requestId);
    if (!pending || pending.peerId !== fromPeerId) return;
    clearTimeout(pending.timer);
    this.contactRequests.delete(payload.requestId);
    if (payload.error) {
      pending.reject(new Error(contactsErrorMessage(payload.error, this.peerName(fromPeerId), payload.message)));
      return;
    }
    const contacts = Array.isArray(payload.contacts)
      ? payload.contacts.slice(0, MAX_CONTACTS_PER_RESPONSE).map(sanitizeContact).filter((c): c is ContactCard => c !== null)
      : [];
    this.upsertSavedContacts(fromPeerId, contacts, 'synced');
    pending.resolve({
      contacts,
      total: typeof payload.total === 'number' && payload.total >= contacts.length ? payload.total : contacts.length,
      truncated: payload.truncated === true,
    });
  }

  private async answerContactsRequest(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'contacts-request' }>): Promise<void> {
    if (!isContinuityId(payload.requestId)) return;
    const reply = (rest: Omit<Extract<ControlPayload, { kind: 'contacts-response' }>, 'kind' | 'requestId'>) =>
      this.send(fromPeerId, { kind: 'contacts-response', requestId: payload.requestId, ...rest });
    if (!this.host.isAuthorized(fromPeerId)) return reply({ error: 'unauthorized' });
    const provider = this.options.contactProvider;
    if (!provider) return reply({ error: 'unsupported' });
    const query = typeof payload.query === 'string' ? payload.query.trim().slice(0, MAX_CONTACT_QUERY) : '';
    const limit = Math.min(MAX_CONTACTS_PER_RESPONSE, Math.max(1, Math.round(typeof payload.limit === 'number' ? payload.limit : DEFAULT_CONTACTS_LIMIT)));
    try {
      const all = (await provider(query, limit + 1)).map(sanitizeContact).filter((c): c is ContactCard => c !== null);
      reply({ contacts: all.slice(0, limit), total: all.length, truncated: all.length > limit });
    } catch (error) {
      reply({ error: 'failed', message: error instanceof Error ? error.message.slice(0, 200) : undefined });
    }
  }

  async shareContacts(peerId: string, contacts: ContactCard[]): Promise<ContactShareItem> {
    const cards = contacts.map(sanitizeContact).filter((c): c is ContactCard => c !== null);
    if (cards.length === 0) throw new Error('Nothing to share: the contact has no name, number or email.');
    const vcard = buildVCards(cards);
    if (vcard.length > MAX_VCARD_LENGTH) throw new Error('Too many contacts to share at once.');
    if (!this.host.peer(peerId)) throw new Error('That device is not connected.');
    const item: ContactShareItem = {
      shareId: randomId(), peerId, peerName: this.peerName(peerId), direction: 'outgoing',
      contacts: cards, vcard, timestamp: Date.now(),
    };
    await this.host.sendControl(peerId, { kind: 'contact-share', shareId: item.shareId, vcard, timestamp: item.timestamp });
    this.remember(item);
    return item;
  }

  private receiveContactShare(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'contact-share' }>): void {
    if (!this.host.isPaired(fromPeerId)) return;
    if (!isContinuityId(payload.shareId) || typeof payload.vcard !== 'string' || payload.vcard.length > MAX_VCARD_LENGTH) return;
    if (this.sharedContacts.some((s) => s.shareId === payload.shareId)) return;
    const contacts = parseVCards(payload.vcard);
    if (contacts.length === 0) return;
    const item: ContactShareItem = {
      shareId: payload.shareId, peerId: fromPeerId, peerName: this.peerName(fromPeerId), direction: 'incoming',
      contacts, vcard: buildVCards(contacts), timestamp: Date.now(),
    };
    this.upsertSavedContacts(fromPeerId, contacts, 'shared');
    this.remember(item);
    this.options.onIncomingContact?.(item);
  }

  private upsertSavedContacts(peerId: string, cards: ContactCard[], source: 'synced' | 'shared'): void {
    if (cards.length === 0) return;
    const peer = this.host.peer(peerId);
    const peerDeviceId = peer?.device.deviceId;
    const peerKey = peer?.device.identityKey || peerDeviceId || peer?.device.publicKey || peerId;
    const peerName = peer?.device.name || 'Paired device';
    const now = Date.now();
    const byId = new Map<string, SavedContactRecord>();
    for (const existing of this.savedContacts) byId.set(existing.id, existing);

    for (const contact of cards) {
      const baseKey =
        contact.id ||
        contact.phones[0]?.number.replace(/\D/g, '') ||
        contact.emails[0]?.address.toLowerCase() ||
        contact.name.toLowerCase();
      const id = `${peerDeviceId || peerKey}:${baseKey}`.slice(0, 256);
      byId.set(id, {
        id,
        peerId,
        peerDeviceId,
        peerKey,
        peerName,
        contact,
        source,
        savedAt: now,
      });
    }

    this.savedContacts = [...byId.values()].slice(0, MAX_SAVED_CONTACTS);
    this.persistSavedContacts();
    this.host.emit();
  }

  removeSavedContact(contactId: string): boolean {
    const before = this.savedContacts.length;
    this.savedContacts = this.savedContacts.filter((record) => record.id !== contactId);
    if (this.savedContacts.length === before) return false;
    this.contactsRemovedByUser++;
    this.persistSavedContacts();
    this.host.emit();
    return true;
  }

  clearSavedContacts(peerId?: string): number {
    const before = this.savedContacts.length;
    if (!peerId) {
      this.savedContacts = [];
    } else {
      const peer = this.host.peer(peerId);
      const peerDeviceId = peer?.device.deviceId;
      const peerKey = peer?.device.identityKey || peerDeviceId || peer?.device.publicKey;
      this.savedContacts = this.savedContacts.filter((record) => {
        if (peerDeviceId && record.peerDeviceId === peerDeviceId) return false;
        if (peerKey && record.peerKey === peerKey) return false;
        return record.peerId !== peerId;
      });
    }
    const removed = before - this.savedContacts.length;
    if (removed > 0) {
      this.contactsRemovedByUser += removed;
      this.persistSavedContacts();
      this.host.emit();
    }
    return removed;
  }

  private remember(item: ContactShareItem): void {
    this.sharedContacts.unshift(item);
    this.sharedContacts.splice(MAX_SHARED_CONTACTS);
    this.host.emit();
  }

  clearSharedContacts(): void {
    this.sharedContacts.splice(0);
    this.host.emit();
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private receiveCallState(fromPeerId: string, raw: unknown): void {
    if (!this.host.isPaired(fromPeerId)) return;
    const call = sanitizeCall(raw);
    if (!call) return;
    const key = `${fromPeerId}:${call.callId}`;
    const existing = this.calls.get(key);
    if (existing && existing.view.updatedAt > call.updatedAt) return; // stale reorder
    if (existing?.timer) clearTimeout(existing.timer);
    const view: CallView = { ...call, peerId: fromPeerId, peerName: this.peerName(fromPeerId) };
    const entry: { view: CallView; timer?: ReturnType<typeof setTimeout> } = { view };
    if (call.state === 'ended') {
      if (this.callAudioState?.peerId === fromPeerId && this.callAudioState.callId === call.callId) {
        this.callAudioState = null;
        this.callAudioListeners.delete(call.callId);
      }
      this.lastCallAudioCursor.delete(`${fromPeerId}:${call.callId}`);
      entry.timer = setTimeout(() => {
        if (this.calls.get(key) === entry) {
          this.calls.delete(key);
          this.host.emit();
        }
      }, ENDED_CALL_LINGER_MS);
    }
    this.calls.set(key, entry);
    while (this.calls.size > MAX_CALLS) {
      const oldest = [...this.calls.entries()].sort((a, b) => a[1].view.updatedAt - b[1].view.updatedAt)[0];
      if (oldest[1].timer) clearTimeout(oldest[1].timer);
      this.calls.delete(oldest[0]);
    }
    this.options.onCallStateChanged?.(view);
    this.host.emit();
  }

  private receiveBatteryStatus(
    fromPeerId: string,
    payload: Extract<ControlPayload, { kind: 'battery-status' }>,
  ): void {
    if (!this.host.isPaired(fromPeerId) || this.host.peer(fromPeerId)?.device.platform !== 'android') return;
    if (!Number.isInteger(payload.level) || payload.level < 0 || payload.level > 100 ||
        typeof payload.charging !== 'boolean' || !Number.isFinite(payload.updatedAt) || payload.updatedAt <= 0) return;
    const previous = this.batteryStatus.get(fromPeerId);
    if (previous && previous.updatedAt > payload.updatedAt) return;
    const eta = payload.chargeTimeRemainingMs;
    const chargeTimeRemainingMs = payload.charging && Number.isSafeInteger(eta) && eta! > 0 && eta! <= MAX_CHARGE_TIME_REMAINING_MS
      ? eta
      : undefined;
    const status: PhoneBatteryStatusView = {
      peerId: fromPeerId,
      peerName: this.peerName(fromPeerId),
      level: payload.level,
      charging: payload.charging,
      chargeTimeRemainingMs,
      updatedAt: payload.updatedAt,
    };
    this.batteryStatus.set(fromPeerId, status);
    if (status.charging || status.level >= 20) {
      this.lowBatteryNotified.delete(fromPeerId);
    } else if (!this.lowBatteryNotified.has(fromPeerId)) {
      this.lowBatteryNotified.add(fromPeerId);
      this.options.onLowPhoneBattery?.(status);
    }
    this.host.emit();
  }

  /** Phone side: report a call change to every authorized peer. */
  publishCallState(call: CallInfo, peerId?: string): void {
    const clean = sanitizeCall(call);
    if (!clean) throw new Error('Invalid call state');
    for (const id of peerId ? [peerId] : this.host.peerIds()) {
      if (this.host.isAuthorized(id)) this.send(id, { kind: 'call-state', call: clean });
    }
  }

  sendCallCommand(peerId: string, action: CallAction, target: { callId?: string; number?: string } = {}): Promise<CallCommandResult> {
    if (!this.host.peer(peerId)) return Promise.reject(new Error('That device is not connected.'));
    let number: string | undefined;
    if (action === 'dial') {
      number = dialableNumber(target.number);
      if (!number) return Promise.reject(new Error('Enter a valid phone number.'));
    } else if (!isContinuityId(target.callId)) {
      return Promise.reject(new Error('That call has ended.'));
    }
    const commandId = randomId();
    return new Promise<CallCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callCommands.delete(commandId);
        reject(new Error(`${this.peerName(peerId)} did not respond. Open AirBridge on the phone and allow phone access.`));
      }, CALL_COMMAND_TIMEOUT_MS);
      this.callCommands.set(commandId, { peerId, resolve, reject, timer });
      this.host.sendControl(peerId, { kind: 'call-command', commandId, action, callId: target.callId, number }).catch((error: unknown) => {
        clearTimeout(timer);
        this.callCommands.delete(commandId);
        reject(error instanceof Error ? error : new Error('Could not reach the phone.'));
      });
    });
  }

  private async executeCallCommand(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'call-command' }>): Promise<void> {
    if (!isContinuityId(payload.commandId)) return;
    const reply = (result: CallCommandResult) =>
      this.send(fromPeerId, { kind: 'call-command-result', commandId: payload.commandId, ...result });
    if (!this.host.isAuthorized(fromPeerId)) return reply({ ok: false, error: 'This computer is not verified for call control. Pair again with the code or QR.' });
    const controller = this.options.callController;
    if (!controller) return reply({ ok: false, error: 'Call control is not available on this device.' });
    if (!isCallAction(payload.action)) return reply({ ok: false, error: 'Unknown call action.' });
    const command: CallCommand = { peerId: fromPeerId, action: payload.action };
    if (payload.action === 'dial') {
      const number = dialableNumber(payload.number);
      if (!number) return reply({ ok: false, error: 'Invalid phone number.' });
      command.number = number;
    } else {
      if (!isContinuityId(payload.callId)) return reply({ ok: false, error: 'Unknown call.' });
      command.callId = payload.callId;
    }
    try {
      const result = await controller(command);
      reply({ ok: result.ok === true, error: result.error, callId: result.callId });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'Call command failed.' });
    }
  }

  // -------------------------------------------------------------------------
  // Two-way encrypted call audio bridge (calls.audio)
  // -------------------------------------------------------------------------

  async startCallAudio(peerId: string, callId: string): Promise<void> {
    if (!this.host.peer(peerId)) throw new Error('That device is not connected.');
    if (!isContinuityId(callId)) throw new Error('Unknown call.');
    this.lastCallAudioCursor.delete(`${peerId}:${callId}`);
    this.callAudioLastError = null;
    this.callAudioState = { peerId, callId, active: true, muted: false, route: 'computer' };
    this.host.emit();
    await this.host.sendControl(peerId, {
      kind: 'call-audio-control',
      callId,
      action: 'start',
      sampleRate: CALL_AUDIO_SAMPLE_RATE,
    });
  }

  async stopCallAudio(peerId: string, callId: string): Promise<void> {
    if (this.callAudioState?.callId === callId) {
      this.callAudioState = { peerId, callId, active: false, muted: false, route: 'phone' };
      this.host.emit();
    }
    this.lastCallAudioCursor.delete(`${peerId}:${callId}`);
    this.callAudioListeners.delete(callId);
    if (!this.host.peer(peerId)) return;
    await this.host.sendControl(peerId, {
      kind: 'call-audio-control',
      callId,
      action: 'stop',
    }).catch(() => {});
  }

  async setCallAudioMuted(peerId: string, callId: string, muted: boolean): Promise<void> {
    if (!isContinuityId(callId)) return;
    if (this.callAudioState?.callId === callId) {
      this.callAudioState = { ...this.callAudioState, muted };
      this.host.emit();
    }
    if (!this.host.peer(peerId)) return;
    await this.host.sendControl(peerId, {
      kind: 'call-audio-control',
      callId,
      action: muted ? 'mute' : 'unmute',
    }).catch(() => {});
  }

  subscribeCallAudio(callId: string, listener: (frame: CallAudioFrame) => void): () => void {
    let set = this.callAudioListeners.get(callId);
    if (!set) {
      set = new Set();
      this.callAudioListeners.set(callId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.callAudioListeners.delete(callId);
    };
  }

  async sendCallAudio(
    peerId: string,
    callId: string,
    pcmS16le: Uint8Array,
    sampleRate: number,
    channels: number,
    frames: number,
    ptsMs: number,
  ): Promise<boolean> {
    if (this.destroyed || !isContinuityId(callId)) return false;
    if (!this.host.isAuthorized(peerId)) return false;
    if (
      sampleRate < 8_000 ||
      sampleRate > 48_000 ||
      (channels !== 1 && channels !== 2) ||
      frames < 1 ||
      frames > CALL_AUDIO_MAX_FRAMES ||
      pcmS16le.byteLength !== frames * channels * 2 ||
      pcmS16le.byteLength > CALL_AUDIO_MAX_FRAME_BYTES ||
      ptsMs < 0 ||
      ptsMs > 0xffffffff
    ) {
      return false;
    }
    const key = await this.host.sessionKey(peerId);
    if (!key || this.destroyed) return false;
    const seq = this.callAudioSeq++;
    const aad = encodeCallAudioAad({ callId, seq, sampleRate, channels, frames, ptsMs });
    const { iv, ciphertext } = await encryptMediaFrame(key, aad, pcmS16le);
    if (!this.host.sendFrame(peerId, encodeCallAudioFrame(aad, iv, ciphertext))) {
      this.callAudioPacketsDropped++;
      return false;
    }
    this.callAudioFramesSent++;
    return true;
  }

  async handleCallAudioFrame(fromPeerId: string, bytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    let frame;
    try {
      frame = decodeCallAudioFrame(bytes);
    } catch {
      return;
    }
    if (!this.host.isAuthorized(fromPeerId)) return;
    const cursorKey = `${fromPeerId}:${frame.callId}`;
    const prevCursor = this.lastCallAudioCursor.get(cursorKey);
    if (prevCursor && frame.seq <= prevCursor.seq) {
      this.callAudioPacketsDropped++;
      return;
    }
    if (prevCursor?.ptsMs !== undefined) {
      const delta = (frame.ptsMs - prevCursor.ptsMs + 0x100000000) % 0x100000000;
      if (delta > 0x80000000) {
        this.callAudioPacketsDropped++;
        return;
      }
    }
    const key = await this.host.sessionKey(fromPeerId);
    if (!key || this.destroyed) return;
    let data: Uint8Array;
    try {
      data = await decryptMediaFrame(key, frame.aad, frame.iv, frame.ciphertext);
    } catch {
      return;
    }
    const latestCursor = this.lastCallAudioCursor.get(cursorKey);
    if (data.byteLength !== frame.frames * frame.channels * 2 || (latestCursor && frame.seq <= latestCursor.seq)) return;
    this.lastCallAudioCursor.set(cursorKey, { seq: frame.seq, ptsMs: frame.ptsMs });
    this.callAudioFramesReceived++;
    const out: CallAudioFrame = {
      callId: frame.callId,
      peerId: fromPeerId,
      seq: frame.seq,
      sampleRate: frame.sampleRate,
      channels: frame.channels as 1 | 2,
      frames: frame.frames,
      ptsMs: frame.ptsMs,
      data,
    };
    for (const listener of this.callAudioListeners.get(frame.callId) ?? []) {
      try {
        listener(out);
      } catch {
        // isolate broken audio subscriber
      }
    }
  }

  private async executeCallAudioControl(
    fromPeerId: string,
    payload: Extract<ControlPayload, { kind: 'call-audio-control' }>,
  ): Promise<void> {
    if (!isContinuityId(payload.callId)) return;
    const reply = (state: { active: boolean; muted: boolean; route?: 'computer' | 'phone'; reason?: string }) =>
      this.send(fromPeerId, { kind: 'call-audio-state', callId: payload.callId, ...state });
    if (!this.host.isAuthorized(fromPeerId)) {
      reply({ active: false, muted: false, route: 'phone', reason: 'This computer is not verified for call audio. Pair again.' });
      return;
    }
    const controller = this.options.callAudioController;
    if (!controller) {
      reply({ active: false, muted: false, route: 'phone', reason: 'Call audio is not enabled on this device.' });
      return;
    }
    try {
      const next = await controller({
        peerId: fromPeerId,
        callId: payload.callId,
        action: payload.action,
        sampleRate: payload.sampleRate,
      });
      this.callAudioState = {
        peerId: fromPeerId,
        callId: payload.callId,
        active: next.active,
        muted: next.muted,
        route: next.route ?? (next.active ? 'computer' : 'phone'),
        reason: next.reason,
      };
      reply(next);
      this.host.emit();
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'Call audio command failed.';
      this.callAudioLastError = reason;
      reply({ active: false, muted: false, route: 'phone', reason });
    }
  }

  private receiveCallAudioState(
    fromPeerId: string,
    payload: Extract<ControlPayload, { kind: 'call-audio-state' }>,
  ): void {
    if (!this.host.isPaired(fromPeerId) || !isContinuityId(payload.callId)) return;
    const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : undefined;
    if (reason && !payload.active) this.callAudioLastError = reason;
    this.callAudioState = {
      peerId: fromPeerId,
      callId: payload.callId,
      active: Boolean(payload.active),
      muted: Boolean(payload.muted),
      route: payload.route === 'computer' ? 'computer' : 'phone',
      reason,
    };
    this.host.emit();
  }

  // -------------------------------------------------------------------------
  // Screen sharing — viewer side
  // -------------------------------------------------------------------------

  requestScreenKeyframe(sessionId: string, reason?: string): void {
    const viewer = this.viewers.get(sessionId);
    if (!viewer || !['pending', 'active'].includes(viewer.view.state)) return;
    this.screenPliSent++;
    this.send(viewer.view.peerId, {
      kind: 'screen-share-keyframe',
      sessionId,
      ...(reason ? { reason: reason.slice(0, 120) } : {}),
    });
  }

  recordScreenViewerStats(stats: {
    decoderMode?: string | null;
    codec?: string | null;
    framesDecodedDelta?: number;
    framesRenderedDelta?: number;
    framesDroppedBeforeDrawDelta?: number;
    decodeErrorsDelta?: number;
    keyframesReceivedDelta?: number;
    fullscreenMode?: string;
    lastFullscreenError?: string | null;
    audioContextState?: string;
    audioFramesPlayedDelta?: number;
    audioNonZeroFramesDelta?: number;
    audioSilentFramesDelta?: number;
    audioFramesPlayed?: number;
    audioNonZeroFrames?: number;
    audioSilentFrames?: number;
    audioLastRms?: number;
  }): void {
    if (stats.decoderMode !== undefined) this.screenDecoderMode = stats.decoderMode;
    if (stats.codec !== undefined) this.screenCodec = stats.codec;
    if (stats.framesDecodedDelta) this.screenFramesDecoded += stats.framesDecodedDelta;
    if (stats.framesRenderedDelta) this.screenFramesRendered += stats.framesRenderedDelta;
    if (stats.framesDroppedBeforeDrawDelta) this.screenFramesDroppedBeforeDraw += stats.framesDroppedBeforeDrawDelta;
    if (stats.decodeErrorsDelta) this.screenDecodeErrors += stats.decodeErrorsDelta;
    if (stats.keyframesReceivedDelta) this.screenKeyframesReceived += stats.keyframesReceivedDelta;
    if (stats.fullscreenMode !== undefined) this.screenFullscreenMode = stats.fullscreenMode;
    if (stats.lastFullscreenError !== undefined) this.screenLastFullscreenError = stats.lastFullscreenError;
    if (stats.audioContextState !== undefined) this.screenAudioContextState = stats.audioContextState;
    if (stats.audioFramesPlayedDelta) this.screenAudioFramesPlayed += stats.audioFramesPlayedDelta;
    if (stats.audioNonZeroFramesDelta) this.screenAudioNonZeroFrames += stats.audioNonZeroFramesDelta;
    if (stats.audioSilentFramesDelta) this.screenAudioSilentFrames += stats.audioSilentFramesDelta;
    if (stats.audioFramesPlayed !== undefined) this.screenAudioFramesPlayed = stats.audioFramesPlayed;
    if (stats.audioNonZeroFrames !== undefined) this.screenAudioNonZeroFrames = stats.audioNonZeroFrames;
    if (stats.audioSilentFrames !== undefined) this.screenAudioSilentFrames = stats.audioSilentFrames;
    if (stats.audioLastRms !== undefined) this.screenAudioLastRms = stats.audioLastRms;
  }

  recordCallAudioStats(stats: Partial<CallAudioSessionStats>): void {
    if (stats.captureMode !== undefined) this.callAudioCaptureMode = stats.captureMode;
    if (stats.audioContextState !== undefined) this.callAudioContextState = stats.audioContextState;
    if (stats.audioContextSampleRate !== undefined) this.callAudioContextSampleRate = stats.audioContextSampleRate;
    if (stats.micFramesCaptured !== undefined) this.callAudioMicFramesCaptured = stats.micFramesCaptured;
    if (stats.micNonZeroFrames !== undefined) this.callAudioMicNonZeroFrames = stats.micNonZeroFrames;
    if (stats.micLastRms !== undefined) this.callAudioMicLastRms = stats.micLastRms;
    if (stats.playbackFramesScheduled !== undefined) this.callAudioPlaybackFramesScheduled = stats.playbackFramesScheduled;
    if (stats.playbackNonZeroFrames !== undefined) this.callAudioPlaybackNonZeroFrames = stats.playbackNonZeroFrames;
    if (stats.playbackSilentFrames !== undefined) this.callAudioPlaybackSilentFrames = stats.playbackSilentFrames;
    if (stats.playbackLastRms !== undefined) this.callAudioPlaybackLastRms = stats.playbackLastRms;
  }

  requestScreenShare(peerId: string, options: { maxWidth?: number; maxFps?: number } = {}): string {
    if (!this.host.peer(peerId)) throw new Error('That device is not connected.');
    if (!this.host.isPaired(peerId)) throw new Error('Pair with this device first.');
    for (const s of this.viewers.values()) {
      if (s.view.peerId === peerId && ['requesting', 'pending', 'active'].includes(s.view.state)) return s.view.sessionId;
    }
    const { maxWidth, maxFps } = clampScreenParams(options.maxWidth, options.maxFps);
    const now = Date.now();
    const sessionId = randomId();
    const session: ViewerSession = {
      view: {
        sessionId, peerId, peerName: this.peerName(peerId), role: 'viewer', state: 'requesting',
        width: 0, height: 0, maxWidth, maxFps, frames: 0, fps: 0, kbps: 0, startedAt: now, updatedAt: now,
      },
      lastSeq: 0, lastAudioSeq: 0, windowStart: now, windowFrames: 0, windowBytes: 0,
    };
    session.timer = setTimeout(() => {
      if (session.view.state === 'requesting' || session.view.state === 'pending') {
        this.finishViewer(session, 'error', `${session.view.peerName} did not respond.`);
      }
    }, SCREEN_CONSENT_TIMEOUT_MS + 10_000);
    this.viewers.set(sessionId, session);
    this.host.sendControl(peerId, { kind: 'screen-share-request', sessionId, maxWidth, maxFps }).catch(() => {
      this.finishViewer(session, 'error', 'Could not reach the device.');
    });
    this.host.emit();
    return sessionId;
  }

  subscribeScreenFrames(sessionId: string, listener: (frame: ScreenFrame) => void): () => void {
    let set = this.frameListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.frameListeners.set(sessionId, set);
    }
    set.add(listener);
    const last = this.viewers.get(sessionId)?.lastFrame;
    if (last) listener(last);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.frameListeners.delete(sessionId);
    };
  }

  subscribeScreenVideo(sessionId: string, listener: (frame: ScreenVideoFrame) => void): () => void {
    let set = this.videoListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.videoListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.videoListeners.delete(sessionId);
    };
  }

  subscribeScreenAudio(sessionId: string, listener: (frame: ScreenAudioFrame) => void): () => void {
    let set = this.audioListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.audioListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.audioListeners.delete(sessionId);
    };
  }

  async handleScreenAudioFrame(fromPeerId: string, bytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    let frame: ReturnType<typeof decodeScreenAudioFrame>;
    try {
      frame = decodeScreenAudioFrame(bytes);
    } catch {
      return;
    }
    const key = frame.sessionId;
    const prior = this.screenAudioQueues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.processScreenAudioFrame(fromPeerId, frame));
    const settled = next.catch(() => {});
    this.screenAudioQueues.set(key, settled);
    try {
      await settled;
    } finally {
      if (this.screenAudioQueues.get(key) === settled) this.screenAudioQueues.delete(key);
    }
  }

  private async processScreenAudioFrame(
    fromPeerId: string,
    frame: ReturnType<typeof decodeScreenAudioFrame>,
  ): Promise<void> {
    if (this.destroyed) return;
    const session = this.viewers.get(frame.sessionId);
    if (!session || session.view.peerId !== fromPeerId || !['pending', 'active'].includes(session.view.state)) return;
    // Audio is independent from video, but it must still move forward on the
    // source's monotonic sample clock without falsely dropping equal-ms packets.
    if (frame.seq <= session.lastAudioSeq) {
      this.screenAudioFramesDroppedStale++;
      return;
    }
    if (session.lastAudioPtsMs !== undefined) {
      const ptsDelta = (frame.ptsMs - session.lastAudioPtsMs + 0x100000000) % 0x100000000;
      if (ptsDelta > 0x80000000) {
        this.screenAudioFramesDroppedStale++;
        return;
      }
    }
    const key = await this.host.sessionKey(fromPeerId);
    if (!key) return;
    let data: Uint8Array;
    try {
      data = await decryptMediaFrame(key, frame.aad, frame.iv, frame.ciphertext);
    } catch {
      this.screenAudioFramesDroppedDecrypt++;
      return;
    }
    const postPtsDelta = session.lastAudioPtsMs === undefined
      ? 0
      : (frame.ptsMs - session.lastAudioPtsMs + 0x100000000) % 0x100000000;
    if (
      frame.seq <= session.lastAudioSeq ||
      !this.viewers.has(frame.sessionId) ||
      data.byteLength !== frame.frames * frame.channels * 2 ||
      (session.lastAudioPtsMs !== undefined && postPtsDelta > 0x80000000)
    ) {
      this.screenAudioFramesDroppedStale++;
      return;
    }
    session.lastAudioSeq = frame.seq;
    session.lastAudioPtsMs = frame.ptsMs;
    session.view.audioAvailable = true;
    this.screenAudioFramesReceived++;
    const out: ScreenAudioFrame = {
      sessionId: frame.sessionId,
      peerId: fromPeerId,
      seq: frame.seq,
      sampleRate: frame.sampleRate,
      channels: frame.channels as 1 | 2,
      frames: frame.frames,
      ptsMs: frame.ptsMs,
      data,
    };
    for (const listener of this.audioListeners.get(frame.sessionId) ?? []) {
      try { listener(out); } catch { /* a broken audio sink must not stop the share */ }
    }
    this.scheduleStatsEmit();
  }

  async handleScreenFrame(fromPeerId: string, bytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    let frame: ReturnType<typeof decodeScreenFrame>;
    try {
      frame = decodeScreenFrame(bytes);
    } catch {
      return;
    }
    const key = frame.sessionId;
    const prior = this.screenFrameQueues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.processScreenFrame(fromPeerId, frame));
    const settled = next.catch(() => {});
    this.screenFrameQueues.set(key, settled);
    try {
      await settled;
    } finally {
      if (this.screenFrameQueues.get(key) === settled) this.screenFrameQueues.delete(key);
    }
  }

  private async processScreenFrame(fromPeerId: string, frame: ReturnType<typeof decodeScreenFrame>): Promise<void> {
    if (this.destroyed) return;
    const session = this.viewers.get(frame.sessionId);
    if (!session || session.view.peerId !== fromPeerId) return;
    if (!['requesting', 'pending', 'active'].includes(session.view.state)) return;
    if ((frame.codec !== SCREEN_CODEC_JPEG && frame.codec !== SCREEN_CODEC_H264) || frame.seq <= session.lastSeq) return;
    const key = await this.host.sessionKey(fromPeerId);
    if (!key) return;
    let data: Uint8Array;
    try {
      data = await decryptMediaFrame(key, frame.aad, frame.iv, frame.ciphertext);
    } catch {
      return; // forged, spliced or corrupted
    }
    let h264Packet: ReturnType<typeof decodeScreenH264Packet> | undefined;
    if (frame.codec === SCREEN_CODEC_H264) {
      try { h264Packet = decodeScreenH264Packet(data); } catch { return; }
    }
    // Decrypts finish out of order; never show an older frame after a newer one.
    if (frame.seq <= session.lastSeq || !this.viewers.has(frame.sessionId)) return;
    session.lastSeq = frame.seq;
    const now = Date.now();
    const view = session.view;
    const becameActive = view.state !== 'active' || view.width !== frame.width || view.height !== frame.height;
    view.state = 'active';
    view.width = frame.width;
    view.height = frame.height;
    view.frames += 1;
    view.updatedAt = now;
    session.windowFrames += 1;
    session.windowBytes += data.byteLength;
    if (now - session.windowStart >= 1000) {
      const seconds = (now - session.windowStart) / 1000;
      view.fps = Math.round((session.windowFrames / seconds) * 10) / 10;
      view.kbps = Math.round((session.windowBytes * 8) / 1000 / seconds);
      session.windowStart = now;
      session.windowFrames = 0;
      session.windowBytes = 0;
    }
    this.send(fromPeerId, { kind: 'screen-share-ack', sessionId: frame.sessionId, seq: frame.seq });
    if (frame.codec === SCREEN_CODEC_JPEG) {
      const out: ScreenFrame = {
        sessionId: frame.sessionId, peerId: fromPeerId, seq: frame.seq,
        width: frame.width, height: frame.height, mimeType: 'image/jpeg', data,
      };
      session.lastFrame = out;
      for (const listener of this.frameListeners.get(frame.sessionId) ?? []) {
        try { listener(out); } catch { /* a broken view must not stop the stream */ }
      }
    } else {
      const packet = h264Packet!;
      const out: ScreenVideoFrame = {
        sessionId: frame.sessionId, peerId: fromPeerId, seq: frame.seq,
        width: frame.width, height: frame.height, codec: 'h264',
        keyFrame: packet.keyFrame, ptsMs: packet.ptsMs, data: packet.data,
      };
      for (const listener of this.videoListeners.get(frame.sessionId) ?? []) {
        try { listener(out); } catch { /* a broken decoder must not stop the stream */ }
      }
    }
    if (becameActive) this.host.emit();
    else this.scheduleStatsEmit();
  }

  private scheduleStatsEmit(): void {
    if (this.statsTimer || this.destroyed) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.host.emit();
    }, STATS_EMIT_MS);
  }

  private receiveScreenState(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'screen-share-state' }>): void {
    const session = this.viewers.get(payload.sessionId);
    if (!session || session.view.peerId !== fromPeerId) return;
    const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : undefined;
    switch (payload.state) {
      case 'pending':
        if (session.view.state === 'requesting') session.view.state = 'pending';
        break;
      case 'active':
        session.view.state = 'active';
        if (typeof payload.width === 'number' && payload.width > 0) session.view.width = payload.width;
        if (typeof payload.height === 'number' && payload.height > 0) session.view.height = payload.height;
        if (typeof payload.audio === 'boolean') session.view.audioAvailable = payload.audio;
        if (session.timer) clearTimeout(session.timer);
        break;
      case 'stopped':
      case 'declined':
      case 'unsupported':
      case 'error':
        this.finishViewer(session, payload.state, reason ?? defaultScreenReason(payload.state, session.view.peerName));
        return;
      default:
        return;
    }
    session.view.updatedAt = Date.now();
    this.host.emit();
  }

  private finishViewer(session: ViewerSession, state: ScreenShareState, reason?: string): void {
    if (session.timer) clearTimeout(session.timer);
    if (!this.viewers.has(session.view.sessionId)) return;
    session.view.state = state;
    session.view.reason = reason;
    session.view.updatedAt = Date.now();
    this.linger(() => {
      if (this.viewers.get(session.view.sessionId) === session) {
        this.viewers.delete(session.view.sessionId);
        this.frameListeners.delete(session.view.sessionId);
        this.videoListeners.delete(session.view.sessionId);
        this.audioListeners.delete(session.view.sessionId);
        this.screenFrameQueues.delete(session.view.sessionId);
        this.screenAudioQueues.delete(session.view.sessionId);
        this.host.emit();
      }
    }, STOPPED_SHARE_LINGER_MS);
    this.host.emit();
  }

  /** Stop watching (viewer) or stop sharing (source). */
  stopScreenShare(sessionId: string): void {
    const viewer = this.viewers.get(sessionId);
    if (viewer) {
      if (['requesting', 'pending', 'active'].includes(viewer.view.state)) {
        this.send(viewer.view.peerId, { kind: 'screen-share-stop', sessionId });
        this.finishViewer(viewer, 'stopped', 'You stopped watching');
      }
      return;
    }
    const source = this.sources.get(sessionId);
    if (source) this.finishSource(source, 'stopped', 'You stopped sharing', true);
  }

  // -------------------------------------------------------------------------
  // Screen sharing — source side
  // -------------------------------------------------------------------------

  private receiveScreenRequest(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'screen-share-request' }>): void {
    if (!isContinuityId(payload.sessionId)) return;
    if (this.requests.has(payload.sessionId) || this.sources.has(payload.sessionId)) return;
    const reply = (state: ScreenShareState, reason?: string) =>
      this.send(fromPeerId, { kind: 'screen-share-state', sessionId: payload.sessionId, state, reason });
    if (!this.host.isAuthorized(fromPeerId)) return reply('declined', 'This device is not verified. Pair again with the code or QR.');
    if (!this.features().includes('screen.source')) return reply('unsupported', 'Screen sharing is not available on this device.');
    const { maxWidth, maxFps } = clampScreenParams(payload.maxWidth, payload.maxFps);
    const view: ScreenShareRequestView = {
      sessionId: payload.sessionId, peerId: fromPeerId, peerName: this.peerName(fromPeerId), maxWidth, maxFps, requestedAt: Date.now(),
    };
    const timer = setTimeout(() => {
      if (this.requests.delete(payload.sessionId)) {
        reply('declined', 'The request timed out.');
        this.host.emit();
      }
    }, SCREEN_CONSENT_TIMEOUT_MS);
    this.requests.set(payload.sessionId, { view, timer });
    reply('pending');
    this.options.onScreenShareRequest?.(view);
    this.host.emit();
  }

  declineScreenShare(sessionId: string, reason = 'Declined'): void {
    const req = this.requests.get(sessionId);
    if (!req) return;
    clearTimeout(req.timer);
    this.requests.delete(sessionId);
    this.send(req.view.peerId, { kind: 'screen-share-state', sessionId, state: 'declined', reason });
    this.host.emit();
  }

  /** User consented and picked what to share: start streaming. */
  acceptScreenShare(sessionId: string, source: ScreenFrameSource): void {
    const req = this.requests.get(sessionId);
    if (!req) {
      try { source.stop(); } catch { /* ignore */ }
      throw new Error('That screen request expired.');
    }
    clearTimeout(req.timer);
    this.requests.delete(sessionId);
    const now = Date.now();
    const session: SourceSession = {
      view: {
        sessionId, peerId: req.view.peerId, peerName: req.view.peerName, role: 'source', state: 'active',
        width: 0, height: 0, maxWidth: req.view.maxWidth, maxFps: req.view.maxFps,
        frames: 0, fps: 0, kbps: 0, quality: 0.7, startedAt: now, updatedAt: now,
      },
      source, nextSeq: 1, ackedSeq: 0, lastAckAt: now, sentAt: new Map(), quality: 0.7, running: true,
    };
    this.sources.set(sessionId, session);
    source.onEnded?.(() => this.finishSource(session, 'stopped', 'Sharing ended', true));
    this.send(session.view.peerId, { kind: 'screen-share-state', sessionId, state: 'active' });
    this.host.emit();
    void this.pump(session).catch(() => {
      if (!this.destroyed && session.running) {
        this.finishSource(session, 'error', 'Screen capture stopped unexpectedly.', true);
      }
    });
  }

  private receiveScreenAck(fromPeerId: string, sessionId: string, seq: number): void {
    const session = this.sources.get(sessionId);
    if (!session || session.view.peerId !== fromPeerId || typeof seq !== 'number') return;
    if (seq <= session.ackedSeq || seq >= session.nextSeq) return;
    const now = Date.now();
    const sent = session.sentAt.get(seq);
    if (sent !== undefined) {
      session.quality = nextScreenQuality(session.quality, now - sent);
      session.view.quality = session.quality;
    }
    for (const s of session.sentAt.keys()) if (s <= seq) session.sentAt.delete(s);
    session.ackedSeq = seq;
    session.lastAckAt = now;
    session.wake?.();
  }

  private waitForAck(session: SourceSession, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.wake = undefined;
        resolve();
      }, ms);
      session.wake = () => {
        clearTimeout(timer);
        session.wake = undefined;
        resolve();
      };
    });
  }

  private async pump(session: SourceSession): Promise<void> {
    const interval = 1000 / session.view.maxFps;
    let lastSent = 0;
    let windowStart = Date.now();
    let windowFrames = 0;
    let windowBytes = 0;
    while (session.running && !this.destroyed) {
      const inflight = session.nextSeq - 1 - session.ackedSeq;
      if (inflight >= SCREEN_MAX_INFLIGHT) {
        if (Date.now() - session.lastAckAt > ACK_STALL_MS) {
          // Frames lost on a reconnect: forget them instead of stalling forever.
          session.ackedSeq = session.nextSeq - 1;
          session.sentAt.clear();
          session.lastAckAt = Date.now();
        } else {
          await this.waitForAck(session, 250);
        }
        continue;
      }
      const wait = lastSent + interval - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, 250));
        continue;
      }
      let captured: CapturedScreenFrame | null;
      try {
        captured = await session.source.capture({ maxWidth: session.view.maxWidth, quality: session.quality });
      } catch {
        captured = null;
      }
      if (!session.running) break;
      if (!captured || captured.data.byteLength === 0 || captured.data.byteLength > SCREEN_MAX_FRAME_BYTES ||
          captured.width <= 0 || captured.height <= 0) {
        await sleep(50);
        continue;
      }
      const key = await this.host.sessionKey(session.view.peerId);
      if (!key || !session.running) {
        await sleep(200);
        continue;
      }
      const seq = session.nextSeq;
      const aad = encodeScreenFrameAad({
        sessionId: session.view.sessionId, seq, codec: SCREEN_CODEC_JPEG,
        width: Math.min(0xffff, Math.round(captured.width)), height: Math.min(0xffff, Math.round(captured.height)),
      });
      const { iv, ciphertext } = await encryptMediaFrame(key, aad, captured.data);
      if (!session.running) break;
      lastSent = Date.now();
      if (!this.host.sendFrame(session.view.peerId, encodeScreenFrame(aad, iv, ciphertext))) {
        await sleep(100); // socket busy: drop this frame, try a fresh one shortly
        continue;
      }
      session.sentAt.set(seq, lastSent);
      session.nextSeq = seq + 1;
      const view = session.view;
      const sizeChanged = view.width !== captured.width || view.height !== captured.height;
      view.width = captured.width;
      view.height = captured.height;
      view.frames += 1;
      view.updatedAt = lastSent;
      windowFrames += 1;
      windowBytes += captured.data.byteLength;
      if (lastSent - windowStart >= 1000) {
        const seconds = (lastSent - windowStart) / 1000;
        view.fps = Math.round((windowFrames / seconds) * 10) / 10;
        view.kbps = Math.round((windowBytes * 8) / 1000 / seconds);
        windowStart = lastSent;
        windowFrames = 0;
        windowBytes = 0;
      }
      if (sizeChanged) this.host.emit();
      else this.scheduleStatsEmit();
    }
  }

  private finishSource(session: SourceSession, state: ScreenShareState, reason: string, notifyViewer: boolean): void {
    if (!session.running) return;
    session.running = false;
    session.wake?.();
    try { session.source.stop(); } catch { /* already stopped */ }
    session.view.state = state;
    session.view.reason = reason;
    session.view.updatedAt = Date.now();
    if (notifyViewer) {
      this.send(session.view.peerId, { kind: 'screen-share-state', sessionId: session.view.sessionId, state, reason });
    }
    this.linger(() => {
      if (this.sources.get(session.view.sessionId) === session) {
        this.sources.delete(session.view.sessionId);
        this.host.emit();
      }
    }, STOPPED_SHARE_LINGER_MS);
    this.host.emit();
  }
}

function contactsErrorMessage(error: string, peerName: string, message?: string): string {
  switch (error) {
    case 'unsupported':
      return `${peerName} can't share contacts. Update AirBridge on that device.`;
    case 'disabled':
      return `Contact sharing is turned off on ${peerName}. Turn it on in AirBridge settings on the phone.`;
    case 'permission':
      return `Allow AirBridge to access contacts on ${peerName}, then try again.`;
    case 'unauthorized':
      return `${peerName} hasn't verified this computer. Pair again with the code or QR.`;
    default:
      return message ? `Could not load contacts: ${message}` : 'Could not load contacts.';
  }
}

function defaultScreenReason(state: ScreenShareState, peerName: string): string {
  switch (state) {
    case 'declined':
      return `${peerName} declined screen sharing.`;
    case 'unsupported':
      return `${peerName} can't share its screen.`;
    case 'stopped':
      return `${peerName} stopped sharing.`;
    default:
      return 'Screen sharing failed.';
  }
}
