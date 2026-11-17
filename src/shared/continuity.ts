/**
 * Phone continuity — contacts, calls and screen sharing between paired devices.
 *
 * Everything here travels inside the existing end-to-end encrypted session:
 * signalling as AES-GCM `transfer-control` payloads, screen frames as routed
 * binary frames (type 0x04) sealed with the same session key and an AAD that
 * binds the frame header. The hub only ever sees ciphertext.
 *
 * This module is pure (no DOM, no Node APIs) so the browser client, the
 * desktop runtime, the tests and the Kotlin vector generator share it.
 */

// ---------------------------------------------------------------------------
// Feature advertisement
// ---------------------------------------------------------------------------

/**
 * What a device can do for its peers. Sent as `continuity-hello` whenever a
 * peer appears or a capability changes (permission granted, toggle flipped).
 */
export type ContinuityFeature =
  | 'contacts.provide' // answers contacts-request (phone with READ_CONTACTS + toggle on)
  | 'contacts.receive' // accepts contact-share cards
  | 'calls.control' // reports call-state and executes call-command
  | 'screen.source' // can share its screen (MediaProjection / getDisplayMedia)
  | 'screen.view'; // can view a shared screen

export const CONTINUITY_FEATURES: readonly ContinuityFeature[] = [
  'contacts.provide',
  'contacts.receive',
  'calls.control',
  'screen.source',
  'screen.view',
];

export const CONTINUITY_PROTOCOL_VERSION = 1;

export function sanitizeFeatures(value: unknown): ContinuityFeature[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<ContinuityFeature>();
  for (const v of value) {
    if (typeof v === 'string' && (CONTINUITY_FEATURES as readonly string[]).includes(v)) out.add(v as ContinuityFeature);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactPhone {
  number: string;
  /** mobile | home | work | main | fax | other (free text from the phone is kept). */
  label?: string;
}

export interface ContactEmail {
  address: string;
  label?: string;
}

export interface ContactCard {
  /** Stable id on the providing device (lookup key); opaque to the receiver. */
  id?: string;
  name: string;
  phones: ContactPhone[];
  emails: ContactEmail[];
  organization?: string;
  note?: string;
  starred?: boolean;
}

export const MAX_CONTACTS_PER_RESPONSE = 5000;
export const DEFAULT_CONTACTS_LIMIT = 2000;
export const MAX_CONTACT_FIELD = 256;
export const MAX_CONTACT_NOTE = 2000;
export const MAX_CONTACT_VALUES = 20;
export const MAX_VCARD_LENGTH = 64 * 1024;
export const MAX_CONTACT_QUERY = 100;

const PHONE_ALLOWED = /^[+0-9*#()\-.,;/ pwPW]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** A phone number as typed or stored; keeps formatting, rejects anything else. */
export function sanitizePhoneNumber(value: unknown): string | undefined {
  const text = cleanText(value, 64);
  if (!text || !PHONE_ALLOWED.test(text)) return undefined;
  return /[0-9]/.test(text) ? text : undefined;
}

/** Digits and dial symbols only — what is actually passed to the dialer. */
export function dialableNumber(value: unknown): string | undefined {
  const text = sanitizePhoneNumber(value);
  if (!text) return undefined;
  const dial = text.replace(/[^+0-9*#,;]/g, '').replace(/(?!^)\+/g, '');
  return /[0-9]/.test(dial) && dial.length <= 40 ? dial : undefined;
}

/** Validates an untrusted contact from the wire; returns null when unusable. */
export function sanitizeContact(value: unknown): ContactCard | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const phones: ContactPhone[] = [];
  if (Array.isArray(v.phones)) {
    for (const p of v.phones.slice(0, MAX_CONTACT_VALUES)) {
      const number = sanitizePhoneNumber((p as ContactPhone | null)?.number);
      if (number) phones.push({ number, label: cleanText((p as ContactPhone).label, 40) });
    }
  }
  const emails: ContactEmail[] = [];
  if (Array.isArray(v.emails)) {
    for (const e of v.emails.slice(0, MAX_CONTACT_VALUES)) {
      const address = cleanText((e as ContactEmail | null)?.address, MAX_CONTACT_FIELD);
      if (address && /^[^\s@]+@[^\s@]+$/.test(address)) emails.push({ address, label: cleanText((e as ContactEmail).label, 40) });
    }
  }
  const name = cleanText(v.name, MAX_CONTACT_FIELD) ?? phones[0]?.number ?? emails[0]?.address;
  if (!name) return null;
  const card: ContactCard = { name, phones, emails };
  const id = cleanText(v.id, 128);
  if (id) card.id = id;
  const organization = cleanText(v.organization, MAX_CONTACT_FIELD);
  if (organization) card.organization = organization;
  const note = cleanText(v.note, MAX_CONTACT_NOTE);
  if (note) card.note = note;
  if (v.starred === true) card.starred = true;
  return card;
}

/** Case/diacritic-insensitive match on name, organisation, emails and digits. */
export function contactMatches(card: ContactCard, query: string): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  if (normalizeForSearch(card.name).includes(q)) return true;
  if (card.organization && normalizeForSearch(card.organization).includes(q)) return true;
  if (card.emails.some((e) => e.address.toLowerCase().includes(q))) return true;
  const digits = query.replace(/\D/g, '');
  return digits.length >= 3 && card.phones.some((p) => p.number.replace(/\D/g, '').includes(digits));
}

function normalizeForSearch(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// vCard (RFC 6350 / 2426, reads 2.1 quoted-printable as exported by Android)
// ---------------------------------------------------------------------------

const PHONE_TYPE_TO_LABEL: Record<string, string> = {
  CELL: 'mobile', MOBILE: 'mobile', IPHONE: 'mobile', HOME: 'home', WORK: 'work', MAIN: 'main',
  FAX: 'fax', PAGER: 'pager', OTHER: 'other', VOICE: 'other',
};
const LABEL_TO_PHONE_TYPE: Record<string, string> = {
  mobile: 'CELL', home: 'HOME', work: 'WORK', main: 'MAIN', fax: 'FAX', pager: 'PAGER', other: 'VOICE',
};

function escapeVCardValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Folds at 75 octets without splitting a UTF-8 sequence (RFC 6350 §3.2). */
function foldLine(line: string): string {
  if (utf8Length(line) <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = 75;
  for (const ch of line) {
    const size = utf8Length(ch);
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = 74; // continuation lines start with a space
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function splitName(full: string): { family: string; given: string } {
  const trimmed = full.trim();
  const idx = trimmed.lastIndexOf(' ');
  if (idx <= 0) return { family: '', given: trimmed };
  return { family: trimmed.slice(idx + 1), given: trimmed.slice(0, idx) };
}

/** vCard 3.0: the most widely imported version (macOS/iOS Contacts, Android, Google, Outlook). */
export function buildVCard(card: ContactCard): string {
  const { family, given } = splitName(card.name);
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVCardValue(family)};${escapeVCardValue(given)};;;`,
    `FN:${escapeVCardValue(card.name)}`,
  ];
  if (card.organization) lines.push(`ORG:${escapeVCardValue(card.organization)}`);
  for (const phone of card.phones) {
    const type = LABEL_TO_PHONE_TYPE[(phone.label ?? '').toLowerCase()] ?? 'VOICE';
    lines.push(`TEL;TYPE=${type}:${escapeVCardValue(phone.number)}`);
  }
  for (const email of card.emails) {
    const label = (email.label ?? '').toLowerCase();
    const type = label === 'home' || label === 'work' ? `INTERNET,${label.toUpperCase()}` : 'INTERNET';
    lines.push(`EMAIL;TYPE=${type}:${escapeVCardValue(email.address)}`);
  }
  if (card.note) lines.push(`NOTE:${escapeVCardValue(card.note)}`);
  lines.push('END:VCARD');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function buildVCards(cards: readonly ContactCard[]): string {
  return cards.map(buildVCard).join('');
}

function unescapeVCardValue(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Splits on unescaped `sep`. */
function splitUnescaped(value: string, sep: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      current += c + value[i + 1];
      i++;
    } else if (c === sep) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x80) bytes.push(code);
      else for (const b of new TextEncoder().encode(c)) bytes.push(b);
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

interface VCardProperty {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

function parseProperty(line: string): VCardProperty | null {
  // name[;param...]:value — the first ':' outside a quoted parameter value.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon).split(';');
  const name = head[0].replace(/^[^.]*\./, '').toUpperCase(); // drop group prefix (item1.TEL)
  const params: Record<string, string[]> = {};
  for (const raw of head.slice(1)) {
    const eq = raw.indexOf('=');
    const key = (eq === -1 ? 'TYPE' : raw.slice(0, eq)).toUpperCase();
    const vals = (eq === -1 ? raw : raw.slice(eq + 1)).replace(/"/g, '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    params[key] = [...(params[key] ?? []), ...vals];
  }
  let value = line.slice(colon + 1);
  if ((params.ENCODING ?? []).includes('QUOTED-PRINTABLE')) value = decodeQuotedPrintable(value);
  return { name, params, value };
}

function phoneLabel(types: string[]): string | undefined {
  for (const t of types) if (t !== 'VOICE' && t !== 'PREF' && PHONE_TYPE_TO_LABEL[t]) return PHONE_TYPE_TO_LABEL[t];
  return types.includes('VOICE') ? 'other' : undefined;
}

/** Parses one or more vCards (2.1, 3.0, 4.0). Unknown properties are ignored. */
export function parseVCards(text: string): ContactCard[] {
  if (typeof text !== 'string' || text.length > MAX_VCARD_LENGTH * 16) return [];
  // Unfold RFC folding (CRLF + space/tab) and 2.1 quoted-printable soft breaks.
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0 && /QUOTED-PRINTABLE/i.test(line.slice(0, colon))) {
      while (line.endsWith('=') && i + 1 < rawLines.length) line = line.slice(0, -1) + rawLines[++i];
    }
    lines.push(line);
  }
  const cards: ContactCard[] = [];
  let current: { fn?: string; n?: string; org?: string; note?: string; phones: ContactPhone[]; emails: ContactEmail[] } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const prop = parseProperty(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VCARD') {
      current = { phones: [], emails: [] };
      continue;
    }
    if (!current) continue;
    switch (prop.name) {
      case 'END': {
        if (prop.value.toUpperCase() !== 'VCARD') break;
        const nameFromN = current.n
          ? (() => {
              const [family = '', given = '', additional = '', prefix = '', suffix = ''] = splitUnescaped(current.n!, ';').map(unescapeVCardValue);
              return [prefix, given, additional, family, suffix].map((s) => s.trim()).filter(Boolean).join(' ');
            })()
          : '';
        const card = sanitizeContact({
          name: current.fn || nameFromN,
          phones: current.phones,
          emails: current.emails,
          organization: current.org,
          note: current.note,
        });
        if (card) cards.push(card);
        current = null;
        break;
      }
      case 'FN':
        current.fn = unescapeVCardValue(prop.value);
        break;
      case 'N':
        current.n = prop.value;
        break;
      case 'ORG':
        current.org = splitUnescaped(prop.value, ';').map(unescapeVCardValue).filter(Boolean).join(', ');
        break;
      case 'NOTE':
        current.note = unescapeVCardValue(prop.value);
        break;
      case 'TEL': {
        const number = unescapeVCardValue(prop.value).replace(/^tel:/i, '');
        if (current.phones.length < MAX_CONTACT_VALUES) current.phones.push({ number, label: phoneLabel(prop.params.TYPE ?? []) });
        break;
      }
      case 'EMAIL': {
        const types = (prop.params.TYPE ?? []).filter((t) => t !== 'INTERNET' && t !== 'PREF');
        const label = types[0] === 'HOME' ? 'home' : types[0] === 'WORK' ? 'work' : undefined;
        if (current.emails.length < MAX_CONTACT_VALUES) current.emails.push({ address: unescapeVCardValue(prop.value).replace(/^mailto:/i, ''), label });
        break;
      }
      default:
        break;
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type CallState = 'ringing' | 'dialing' | 'active' | 'held' | 'ended';
export type CallDirection = 'incoming' | 'outgoing';
export type CallAction = 'answer' | 'reject' | 'hangup' | 'dial';

export interface CallInfo {
  callId: string;
  state: CallState;
  direction: CallDirection;
  /** Caller/callee number when the phone can read it (READ_CALL_LOG on Android). */
  number?: string;
  /** Contact name resolved on the phone. */
  name?: string;
  /** When the call connected (ms since epoch), for the duration clock. */
  connectedAt?: number;
  /** Device clock of the change (ms). */
  updatedAt: number;
  /** Which commands the phone can execute right now. */
  actions: CallAction[];
  /** Call audio stays on the phone (or its headset); never streamed. */
  audioRoute?: 'phone' | 'speaker' | 'headset' | 'bluetooth';
}

const CALL_STATES: readonly CallState[] = ['ringing', 'dialing', 'active', 'held', 'ended'];
const CALL_ACTIONS: readonly CallAction[] = ['answer', 'reject', 'hangup', 'dial'];
const ID_PATTERN = /^[0-9a-f]{16}$/;

export function isContinuityId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isCallAction(value: unknown): value is CallAction {
  return typeof value === 'string' && (CALL_ACTIONS as readonly string[]).includes(value);
}

export function sanitizeCall(value: unknown, now = Date.now()): CallInfo | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isContinuityId(v.callId)) return null;
  if (typeof v.state !== 'string' || !(CALL_STATES as readonly string[]).includes(v.state)) return null;
  const direction: CallDirection = v.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const actions = Array.isArray(v.actions) ? [...new Set(v.actions.filter(isCallAction))] : [];
  const call: CallInfo = {
    callId: v.callId,
    state: v.state as CallState,
    direction,
    updatedAt: typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : now,
    actions,
  };
  const number = sanitizePhoneNumber(v.number);
  if (number) call.number = number;
  const name = cleanText(v.name, MAX_CONTACT_FIELD);
  if (name) call.name = name;
  if (typeof v.connectedAt === 'number' && Number.isFinite(v.connectedAt) && v.connectedAt > 0) call.connectedAt = v.connectedAt;
  if (v.audioRoute === 'phone' || v.audioRoute === 'speaker' || v.audioRoute === 'headset' || v.audioRoute === 'bluetooth') {
    call.audioRoute = v.audioRoute;
  }
  return call;
}

/** Display label for a call party: contact name, number, else "Unknown caller". */
export function callPartyLabel(call: Pick<CallInfo, 'name' | 'number'>): string {
  return call.name || call.number || 'Unknown caller';
}

// ---------------------------------------------------------------------------
// Screen sharing
// ---------------------------------------------------------------------------

export type ScreenShareState = 'requesting' | 'pending' | 'active' | 'stopped' | 'declined' | 'unsupported' | 'error';

export const SCREEN_CODEC_JPEG = 1;
export const SCREEN_DEFAULT_MAX_WIDTH = 1280;
export const SCREEN_MAX_WIDTH_LIMIT = 2560;
export const SCREEN_DEFAULT_FPS = 15;
export const SCREEN_MAX_FPS = 30;
/** Frames in flight before the sender waits for an ack (latest-frame-wins). */
export const SCREEN_MAX_INFLIGHT = 2;
export const SCREEN_MAX_FRAME_BYTES = 3 * 1024 * 1024;
/** No consent within this window = declined. */
export const SCREEN_CONSENT_TIMEOUT_MS = 2 * 60_000;

export const FRAME_SCREEN = 0x04;
/** type(1) ‖ sessionId(16 ASCII hex) ‖ seq(u32) ‖ codec(u8) ‖ width(u16) ‖ height(u16) */
export const SCREEN_FRAME_AAD_LENGTH = 1 + 16 + 4 + 1 + 2 + 2; // 26
export const SCREEN_FRAME_HEADER_LENGTH = SCREEN_FRAME_AAD_LENGTH + 12; // + IV = 38

export interface ScreenFrameHeader {
  sessionId: string;
  seq: number;
  codec: number;
  width: number;
  height: number;
}

export interface DecodedScreenFrame extends ScreenFrameHeader {
  /** Authenticated header bytes (GCM additional data). */
  aad: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export function encodeScreenFrameAad(header: ScreenFrameHeader): Uint8Array {
  if (!isContinuityId(header.sessionId)) throw new Error('Invalid screen session id');
  if (!Number.isInteger(header.seq) || header.seq < 0 || header.seq > 0xffffffff) throw new Error('Invalid frame sequence');
  if (header.width <= 0 || header.width > 0xffff || header.height <= 0 || header.height > 0xffff) throw new Error('Invalid frame size');
  const out = new Uint8Array(SCREEN_FRAME_AAD_LENGTH);
  const view = new DataView(out.buffer);
  out[0] = FRAME_SCREEN;
  for (let i = 0; i < 16; i++) out[1 + i] = header.sessionId.charCodeAt(i);
  view.setUint32(17, header.seq >>> 0, false);
  out[21] = header.codec & 0xff;
  view.setUint16(22, header.width, false);
  view.setUint16(24, header.height, false);
  return out;
}

export function encodeScreenFrame(aad: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (aad.byteLength !== SCREEN_FRAME_AAD_LENGTH || aad[0] !== FRAME_SCREEN) throw new Error('Invalid screen frame header');
  if (iv.byteLength !== 12) throw new Error('Invalid IV length');
  const out = new Uint8Array(SCREEN_FRAME_HEADER_LENGTH + ciphertext.byteLength);
  out.set(aad, 0);
  out.set(iv, SCREEN_FRAME_AAD_LENGTH);
  out.set(ciphertext, SCREEN_FRAME_HEADER_LENGTH);
  return out;
}

export function decodeScreenFrame(bytes: Uint8Array): DecodedScreenFrame {
  if (bytes.byteLength < SCREEN_FRAME_HEADER_LENGTH + 16) throw new Error('Screen frame too short');
  if (bytes[0] !== FRAME_SCREEN) throw new Error('Not a screen frame');
  if (bytes.byteLength > SCREEN_FRAME_HEADER_LENGTH + SCREEN_MAX_FRAME_BYTES + 16) throw new Error('Screen frame too large');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sessionId = '';
  for (let i = 0; i < 16; i++) sessionId += String.fromCharCode(bytes[1 + i]);
  if (!isContinuityId(sessionId)) throw new Error('Invalid screen session id');
  const width = view.getUint16(22, false);
  const height = view.getUint16(24, false);
  if (width === 0 || height === 0) throw new Error('Invalid frame size');
  return {
    sessionId,
    seq: view.getUint32(17, false),
    codec: bytes[21],
    width,
    height,
    aad: bytes.subarray(0, SCREEN_FRAME_AAD_LENGTH),
    iv: bytes.slice(SCREEN_FRAME_AAD_LENGTH, SCREEN_FRAME_HEADER_LENGTH),
    ciphertext: bytes.subarray(SCREEN_FRAME_HEADER_LENGTH),
  };
}

/** Clamp a requested capture width/fps to sane bounds. */
export function clampScreenParams(maxWidth: unknown, maxFps: unknown): { maxWidth: number; maxFps: number } {
  const w = typeof maxWidth === 'number' && Number.isFinite(maxWidth) ? Math.round(maxWidth) : SCREEN_DEFAULT_MAX_WIDTH;
  const f = typeof maxFps === 'number' && Number.isFinite(maxFps) ? Math.round(maxFps) : SCREEN_DEFAULT_FPS;
  return {
    maxWidth: Math.min(SCREEN_MAX_WIDTH_LIMIT, Math.max(320, w)),
    maxFps: Math.min(SCREEN_MAX_FPS, Math.max(1, f)),
  };
}

/**
 * Adaptive JPEG quality from ack round-trip time (AIMD): back off quickly when
 * the path is congested, recover slowly when it is clear.
 */
export function nextScreenQuality(current: number, ackRttMs: number): number {
  const next = ackRttMs > 400 ? current * 0.75 : ackRttMs > 200 ? current - 0.05 : current + 0.02;
  return Math.round(Math.min(0.85, Math.max(0.3, next)) * 100) / 100;
}
