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
  CONTINUITY_PROTOCOL_VERSION,
  DEFAULT_CONTACTS_LIMIT,
  MAX_CONTACTS_PER_RESPONSE,
  MAX_CONTACT_QUERY,
  MAX_VCARD_LENGTH,
  SCREEN_CODEC_JPEG,
  SCREEN_CONSENT_TIMEOUT_MS,
  SCREEN_MAX_FRAME_BYTES,
  SCREEN_MAX_INFLIGHT,
  buildVCards,
  clampScreenParams,
  decodeScreenFrame,
  decodeScreenAudioFrame,
  encodeScreenAudioAad,
  encodeScreenAudioFrame,
  SCREEN_AUDIO_MAX_FRAME_BYTES,
  AUDIO_CODEC_PCM_S16LE,
  SCREEN_INVITE_TTL_MS,
  dialableNumber,
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
  type ScreenShareState,
} from '../../shared/continuity.js';
import type { ControlPayload, PeerSummary } from '../../shared/protocol.js';
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
  quality?: number;
  reason?: string;
  /** Sound requested (viewer) / included (source); true once audio is flowing. */
  audio?: boolean;
  /** Casting started on the source device (screen-share-invite). */
  invited?: boolean;
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
  audio?: boolean;
  /** Answers an invite this device sent: the user already chose to cast. */
  invited?: boolean;
}

/** Decrypted screen audio: interleaved signed 16-bit PCM. */
export interface ScreenAudioChunk {
  sessionId: string;
  peerId: string;
  seq: number;
  sampleRate: number;
  channels: number;
  pcm: Int16Array;
}

export interface ContinuitySnapshot {
  /** What each peer announced it can do (empty = older app / not announced yet). */
  peerFeatures: Record<string, ContinuityFeature[]>;
  calls: CallView[];
  screenShares: ScreenShareView[];
  screenRequests: ScreenShareRequestView[];
  sharedContacts: ContactShareItem[];
}

export const EMPTY_CONTINUITY: ContinuitySnapshot = {
  peerFeatures: {},
  calls: [],
  screenShares: [],
  screenRequests: [],
  sharedContacts: [],
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
  /** This device can share its screen (getDisplayMedia, or a test source). */
  screenSourceAvailable?: boolean | (() => boolean);
  onCallStateChanged?: (call: CallView) => void;
  onIncomingContact?: (item: ContactShareItem) => void;
  onScreenShareRequest?: (request: ScreenShareRequestView) => void;
  /** This source can send screen audio with sendScreenAudio (simulators, tests). */
  screenAudioSource?: boolean | (() => boolean);
  /** This viewer can play screen audio (Web Audio available). */
  screenAudioPlayable?: boolean | (() => boolean);
  /** A paired device started casting to us; a viewer session was opened. */
  onScreenShareInvite?: (view: ScreenShareView) => void;
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
const ACK_STALL_MS = 3_000;
const INVITE_MIN_INTERVAL_MS = 2_000;
const STATS_EMIT_MS = 500;

interface Pending<T> {
  peerId: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SourceSession {
  view: ScreenShareView;
  audioSeq: number;
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
  private readonly contactRequests = new Map<string, Pending<ContactsQueryResult>>();
  private readonly callCommands = new Map<string, Pending<CallCommandResult>>();
  private readonly frameListeners = new Map<string, Set<(frame: ScreenFrame) => void>>();
  private readonly audioListeners = new Map<string, Set<(chunk: ScreenAudioChunk) => void>>();
  /** Invites this device sent (source side), single use. */
  private readonly invites = new Map<string, { peerId: string; audio: boolean; expiresAt: number }>();
  private readonly lastInviteAt = new Map<string, number>();
  private readonly lingerTimers = new Set<ReturnType<typeof setTimeout>>();
  private knownPeers = new Map<string, string>();
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly host: ContinuityHost, private options: ContinuityOptions = {}) {}

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  features(): ContinuityFeature[] {
    const out: ContinuityFeature[] = ['contacts.receive', 'screen.view'];
    if (this.options.contactProvider) out.push('contacts.provide');
    if (this.options.callController) out.push('calls.control');
    const screen = this.options.screenSourceAvailable;
    if (typeof screen === 'function' ? screen() : screen) {
      out.push('screen.source');
      const audio = this.options.screenAudioSource;
      if (typeof audio === 'function' ? audio() : audio) out.push('screen.audio');
    }
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
  onPeersChanged(peers: Array<{ peerId: string; publicKey: string }>): void {
    const next = new Map(peers.map((p) => [p.peerId, p.publicKey]));
    for (const [id, key] of next) {
      if (this.knownPeers.get(id) === key) continue;
      this.announce(id);
      // The first hello can race the peer's own roster update and be dropped
      // there; one retry covers it (peers also answer a first hello in kind).
      this.linger(() => {
        if (this.knownPeers.get(id) === key && !this.peerFeatures.has(id)) this.announce(id);
      }, 2_000);
    }
    for (const id of this.knownPeers.keys()) {
      if (!next.has(id)) this.dropPeer(id);
    }
    this.knownPeers = next;
  }

  private dropPeer(peerId: string): void {
    this.peerFeatures.delete(peerId);
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

  snapshot(): ContinuitySnapshot {
    return {
      peerFeatures: Object.fromEntries(this.peerFeatures),
      calls: [...this.calls.values()].map((c) => ({ ...c.view })).sort((a, b) => b.updatedAt - a.updatedAt),
      screenShares: [...this.viewers.values(), ...this.sources.values()].map((s) => ({ ...s.view })),
      screenRequests: [...this.requests.values()].map((r) => ({ ...r.view })),
      sharedContacts: this.sharedContacts.slice(),
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
      case 'screen-share-invite':
        this.receiveScreenInvite(fromPeerId, payload);
        return true;
      case 'screen-share-state':
        this.receiveScreenState(fromPeerId, payload);
        return true;
      case 'screen-share-ack':
        this.receiveScreenAck(fromPeerId, payload.sessionId, payload.seq);
        return true;
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
    this.remember(item);
    this.options.onIncomingContact?.(item);
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
  // Screen sharing — viewer side
  // -------------------------------------------------------------------------

  private audioPlayable(): boolean {
    const v = this.options.screenAudioPlayable;
    return typeof v === 'function' ? v() : v === true;
  }

  requestScreenShare(peerId: string, options: { maxWidth?: number; maxFps?: number; audio?: boolean; inviteId?: string } = {}): string {
    if (!this.host.peer(peerId)) throw new Error('That device is not connected.');
    if (!this.host.isPaired(peerId)) throw new Error('Pair with this device first.');
    for (const s of this.viewers.values()) {
      if (s.view.peerId === peerId && ['requesting', 'pending', 'active'].includes(s.view.state)) return s.view.sessionId;
    }
    const { maxWidth, maxFps } = clampScreenParams(options.maxWidth, options.maxFps);
    const audio = options.audio === true && this.audioPlayable();
    const inviteId = isContinuityId(options.inviteId) ? options.inviteId : undefined;
    const now = Date.now();
    const sessionId = randomId();
    const session: ViewerSession = {
      view: {
        sessionId, peerId, peerName: this.peerName(peerId), role: 'viewer', state: 'requesting',
        width: 0, height: 0, maxWidth, maxFps, frames: 0, fps: 0, kbps: 0, startedAt: now, updatedAt: now,
        ...(audio ? { audio: true } : {}),
        ...(inviteId ? { invited: true } : {}),
      },
      lastSeq: 0, lastAudioSeq: 0, windowStart: now, windowFrames: 0, windowBytes: 0,
    };
    session.timer = setTimeout(() => {
      if (session.view.state === 'requesting' || session.view.state === 'pending') {
        this.finishViewer(session, 'error', `${session.view.peerName} did not respond.`);
      }
    }, SCREEN_CONSENT_TIMEOUT_MS + 10_000);
    this.viewers.set(sessionId, session);
    this.host.sendControl(peerId, {
      kind: 'screen-share-request', sessionId, maxWidth, maxFps,
      ...(audio ? { audio: true } : {}),
      ...(inviteId ? { inviteId } : {}),
    }).catch(() => {
      this.finishViewer(session, 'error', 'Could not reach the device.');
    });
    this.host.emit();
    return sessionId;
  }

  /**
   * A paired device wants to cast to us. Accepting only opens a viewer: the
   * source still asks its own user (Android's capture prompt). Strangers on the
   * network and invite floods are ignored.
   */
  private receiveScreenInvite(fromPeerId: string, payload: Extract<ControlPayload, { kind: 'screen-share-invite' }>): void {
    if (!isContinuityId(payload.inviteId) || !this.host.isPaired(fromPeerId)) return;
    const now = Date.now();
    if (now - (this.lastInviteAt.get(fromPeerId) ?? 0) < INVITE_MIN_INTERVAL_MS) return;
    this.lastInviteAt.set(fromPeerId, now);
    for (const s of this.viewers.values()) {
      if (s.view.peerId === fromPeerId && ['requesting', 'pending', 'active'].includes(s.view.state)) return;
    }
    let sessionId: string;
    try {
      sessionId = this.requestScreenShare(fromPeerId, { inviteId: payload.inviteId, audio: payload.audio === true });
    } catch {
      return;
    }
    const session = this.viewers.get(sessionId);
    if (session) this.options.onScreenShareInvite?.({ ...session.view });
  }

  /** Source side: offer to cast this screen to a paired viewer. */
  inviteScreenShare(peerId: string, options: { audio?: boolean } = {}): string {
    if (!this.host.peer(peerId)) throw new Error('That device is not connected.');
    if (!this.host.isAuthorized(peerId)) throw new Error('Pair with this device first.');
    if (!this.features().includes('screen.source')) throw new Error('Screen sharing is not available on this device.');
    const now = Date.now();
    for (const [id, inv] of this.invites) if (inv.expiresAt <= now) this.invites.delete(id);
    const inviteId = randomId();
    const audio = options.audio === true && this.features().includes('screen.audio');
    this.invites.set(inviteId, { peerId, audio, expiresAt: now + SCREEN_INVITE_TTL_MS });
    this.send(peerId, { kind: 'screen-share-invite', inviteId, ...(audio ? { audio: true } : {}) });
    return inviteId;
  }

  subscribeScreenAudio(sessionId: string, listener: (chunk: ScreenAudioChunk) => void): () => void {
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
    let frame;
    try {
      frame = decodeScreenAudioFrame(bytes);
    } catch {
      return;
    }
    const session = this.viewers.get(frame.sessionId);
    if (!session || session.view.peerId !== fromPeerId || session.view.state !== 'active') return;
    if (frame.codec !== AUDIO_CODEC_PCM_S16LE || frame.seq <= session.lastAudioSeq) return;
    const key = await this.host.sessionKey(fromPeerId);
    if (!key) return;
    let data: Uint8Array;
    try {
      data = await decryptMediaFrame(key, frame.aad, frame.iv, frame.ciphertext);
    } catch {
      return;
    }
    if (frame.seq <= session.lastAudioSeq || !this.viewers.has(frame.sessionId) || data.byteLength % (2 * frame.channels) !== 0) return;
    session.lastAudioSeq = frame.seq;
    const pcm = new Int16Array(data.byteLength / 2);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
    if (!session.view.audio) {
      session.view.audio = true;
      this.host.emit();
    }
    const chunk: ScreenAudioChunk = { sessionId: frame.sessionId, peerId: fromPeerId, seq: frame.seq, sampleRate: frame.sampleRate, channels: frame.channels, pcm };
    for (const listener of this.audioListeners.get(frame.sessionId) ?? []) {
      try { listener(chunk); } catch { /* a broken player must not stop the stream */ }
    }
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

  async handleScreenFrame(fromPeerId: string, bytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    let frame;
    try {
      frame = decodeScreenFrame(bytes);
    } catch {
      return;
    }
    const session = this.viewers.get(frame.sessionId);
    if (!session || session.view.peerId !== fromPeerId) return;
    if (!['requesting', 'pending', 'active'].includes(session.view.state)) return;
    if (frame.codec !== SCREEN_CODEC_JPEG || frame.seq <= session.lastSeq) return;
    const key = await this.host.sessionKey(fromPeerId);
    if (!key) return;
    let data: Uint8Array;
    try {
      data = await decryptMediaFrame(key, frame.aad, frame.iv, frame.ciphertext);
    } catch {
      return; // forged, spliced or corrupted
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
    const out: ScreenFrame = {
      sessionId: frame.sessionId, peerId: fromPeerId, seq: frame.seq,
      width: frame.width, height: frame.height, mimeType: 'image/jpeg', data,
    };
    session.lastFrame = out;
    this.send(fromPeerId, { kind: 'screen-share-ack', sessionId: frame.sessionId, seq: frame.seq });
    for (const listener of this.frameListeners.get(frame.sessionId) ?? []) {
      try { listener(out); } catch { /* a broken view must not stop the stream */ }
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
        if (payload.audio === false) session.view.audio = false;
        // While active, a reason is a live notice (e.g. protected content shows black); "" clears it.
        if (reason !== undefined) session.view.reason = reason || undefined;
        if (typeof payload.width === 'number' && payload.width > 0) session.view.width = payload.width;
        if (typeof payload.height === 'number' && payload.height > 0) session.view.height = payload.height;
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
        this.audioListeners.delete(session.view.sessionId);
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
    // An answer to our own fresh invite: the user here already chose to cast.
    const invite = isContinuityId(payload.inviteId) ? this.invites.get(payload.inviteId) : undefined;
    const invited = !!invite && invite.peerId === fromPeerId && invite.expiresAt > Date.now();
    if (invited) this.invites.delete(payload.inviteId!);
    const audio = payload.audio === true && this.features().includes('screen.audio');
    const view: ScreenShareRequestView = {
      sessionId: payload.sessionId, peerId: fromPeerId, peerName: this.peerName(fromPeerId), maxWidth, maxFps, requestedAt: Date.now(),
      ...(audio ? { audio: true } : {}),
      ...(invited ? { invited: true } : {}),
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
        ...(req.view.audio ? { audio: true } : {}),
      },
      audioSeq: 0, source, nextSeq: 1, ackedSeq: 0, lastAckAt: now, sentAt: new Map(), quality: 0.7, running: true,
    };
    this.sources.set(sessionId, session);
    source.onEnded?.(() => this.finishSource(session, 'stopped', 'Sharing ended', true));
    this.send(session.view.peerId, { kind: 'screen-share-state', sessionId, state: 'active', audio: req.view.audio === true });
    this.host.emit();
    void this.pump(session);
  }

  /** Seals one chunk of interleaved s16 PCM for an active session that includes sound. */
  async sendScreenAudio(sessionId: string, pcm: Int16Array, sampleRate: number, channels: number): Promise<boolean> {
    const session = this.sources.get(sessionId);
    if (!session || !session.running || !session.view.audio || pcm.length === 0) return false;
    const bytes = new Uint8Array(pcm.length * 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
    if (bytes.byteLength > SCREEN_AUDIO_MAX_FRAME_BYTES) return false;
    const key = await this.host.sessionKey(session.view.peerId);
    if (!key || !session.running) return false;
    const seq = ++session.audioSeq;
    const aad = encodeScreenAudioAad({ sessionId, seq, codec: AUDIO_CODEC_PCM_S16LE, channels, sampleRate });
    const { iv, ciphertext } = await encryptMediaFrame(key, aad, bytes);
    return this.host.sendFrame(session.view.peerId, encodeScreenAudioFrame(aad, iv, ciphertext));
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
      let captured: CapturedScreenFrame | null = null;
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
