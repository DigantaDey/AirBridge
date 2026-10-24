export type PlatformType = 'macos' | 'android' | 'ios' | 'windows' | 'linux' | 'unknown';
export type FormFactor = 'laptop' | 'phone' | 'tablet' | 'desktop';
export type VisibilityMode = 'nearby' | 'paired-only' | 'hidden';
export type TransportKind = 'webrtc' | 'ws-relay';

export interface DeviceProfile {
  name: string;
  platform: PlatformType;
  model: string;
  formFactor: FormFactor;
  publicKey: string; // base64url raw ECDH P-256 public key (65 bytes)
}

export interface PeerSummary {
  peerId: string;
  device: DeviceProfile;
  discoveryScope: 'paired' | 'nearby';
  connectedAt: number;
}

export interface LocalDaemonStatus {
  enabled: boolean;
  platform: string;
  hostname: string;
  downloadDir?: string;
  autoSaveToDownloads: boolean;
}

export interface FileManifestItem {
  index: number;
  name: string;
  relativePath?: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  previewDataUrl?: string;
}

export interface EncryptedEnvelope {
  encrypted: true;
  iv: string; // base64url 12-byte IV
  ciphertext: string; // base64url AES-GCM ciphertext
}

export type ControlPayload =
  | {
      kind: 'transfer-offer';
      transferId: string;
      files: FileManifestItem[];
      totalBytes: number;
      createdAt: number;
    }
  | {
      kind: 'transfer-accept';
      transferId: string;
      preferredTransport: TransportKind;
    }
  | {
      kind: 'transfer-decline';
      transferId: string;
      reason?: string;
    }
  | {
      kind: 'transfer-cancel';
      transferId: string;
    }
  | {
      kind: 'chunk-ack';
      transferId: string;
      fileIndex: number;
      ackedChunkIndex: number;
      bytesReceivedTotal: number;
    }
  | {
      kind: 'file-complete';
      transferId: string;
      fileIndex: number;
      sha256?: string;
    }
  | {
      kind: 'transfer-complete';
      transferId: string;
    }
  | {
      kind: 'clipboard-beam';
      beamId: string;
      text: string;
      contentType: 'url' | 'otp' | 'code' | 'text';
      timestamp: number;
    }
  | {
      kind: 'ping';
      ts: number;
    }
  | {
      kind: 'pong';
      ts: number;
    };

export type ClientToServerMessage =
  | {
      type: 'hello';
      peerId?: string;
      device: DeviceProfile;
      pairCode?: string;
      visibility: VisibilityMode;
    }
  | {
      type: 'update-profile';
      device: DeviceProfile;
      visibility: VisibilityMode;
    }
  | {
      type: 'join-pair';
      pairCode: string;
    }
  | {
      type: 'rotate-pair';
    }
  | {
      type: 'rtc-signal';
      to: string;
      signal: Record<string, unknown>;
    }
  | {
      type: 'transfer-control';
      to: string;
      envelope: EncryptedEnvelope | { encrypted: false; payload: ControlPayload };
    };

export type ServerToClientMessage =
  | {
      type: 'welcome';
      peerId: string;
      pairCode: string;
      lanUrls: string[];
      localDaemon: LocalDaemonStatus;
      peers: PeerSummary[];
    }
  | {
      type: 'pair-updated';
      pairCode: string;
      peers: PeerSummary[];
    }
  | {
      type: 'peers';
      peers: PeerSummary[];
    }
  | {
      type: 'rtc-signal';
      from: string;
      signal: Record<string, unknown>;
    }
  | {
      type: 'transfer-control';
      from: string;
      envelope: EncryptedEnvelope | { encrypted: false; payload: ControlPayload };
    }
  | {
      type: 'error';
      code: string;
      message: string;
    };

// ============================================================================
// Pair Code Formatting & Generation (Unambiguous 32-char Crockford-like alphabet)
// ============================================================================

const PAIR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIR_CODE_LENGTH = 6;

export function generatePairCode(randomBytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    const byte = randomBytes[i % randomBytes.length] ?? 0;
    out += PAIR_ALPHABET[byte % PAIR_ALPHABET.length];
  }
  return out;
}

export function normalizePairCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0/g, '2')
    .replace(/O/g, 'Q')
    .replace(/1/g, 'L')
    .replace(/I/g, 'J')
    .slice(0, PAIR_CODE_LENGTH);
}

export function isValidPairCode(code: string): boolean {
  if (code.length !== PAIR_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!PAIR_ALPHABET.includes(code[i])) return false;
  }
  return true;
}

export function formatPairCode(code: string): string {
  const clean = normalizePairCode(code);
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)}-${clean.slice(3, 6)}`;
}

// ============================================================================
// Binary Frame Codecs (0x01 Encrypted Chunk Frame & 0x02 WS Relay Routed Frame)
// ============================================================================

export const FRAME_ENCRYPTED_CHUNK = 0x01;
export const FRAME_ROUTED_RELAY = 0x02;

export const ID_ASCII_LENGTH = 16; // 16 hex chars = 64 bits entropy
export const GCM_IV_LENGTH = 12;
export const CHUNK_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + 4 + 4 + GCM_IV_LENGTH; // 37 bytes
export const ROUTING_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + ID_ASCII_LENGTH; // 33 bytes

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeFixedAsciiId(target: Uint8Array, offset: number, id: string): void {
  const padded = id.slice(0, ID_ASCII_LENGTH).padEnd(ID_ASCII_LENGTH, '0');
  for (let i = 0; i < ID_ASCII_LENGTH; i++) {
    target[offset + i] = padded.charCodeAt(i) & 0x7f;
  }
}

function readFixedAsciiId(source: Uint8Array, offset: number): string {
  return textDecoder.decode(source.subarray(offset, offset + ID_ASCII_LENGTH));
}

export interface EncryptedChunkFrame {
  transferId: string;
  fileIndex: number;
  chunkIndex: number;
  iv: Uint8Array; // 12 bytes
  ciphertext: Uint8Array;
}

export function encodeEncryptedChunkFrame(frame: EncryptedChunkFrame): Uint8Array {
  if (frame.iv.byteLength !== GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${GCM_IV_LENGTH}, got ${frame.iv.byteLength}`);
  }
  const out = new Uint8Array(CHUNK_HEADER_LENGTH + frame.ciphertext.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = FRAME_ENCRYPTED_CHUNK;
  writeFixedAsciiId(out, 1, frame.transferId);
  view.setUint32(17, frame.fileIndex >>> 0, false);
  view.setUint32(21, frame.chunkIndex >>> 0, false);
  out.set(frame.iv, 25);
  out.set(frame.ciphertext, CHUNK_HEADER_LENGTH);

  return out;
}

export function decodeEncryptedChunkFrame(bytes: Uint8Array): EncryptedChunkFrame {
  if (bytes.byteLength < CHUNK_HEADER_LENGTH) {
    throw new Error(`Chunk frame too short: ${bytes.byteLength} bytes`);
  }
  if (bytes[0] !== FRAME_ENCRYPTED_CHUNK) {
    throw new Error(`Unexpected chunk frame type: 0x${bytes[0].toString(16)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const transferId = readFixedAsciiId(bytes, 1);
  const fileIndex = view.getUint32(17, false);
  const chunkIndex = view.getUint32(21, false);
  const iv = bytes.slice(25, 37);
  const ciphertext = bytes.subarray(CHUNK_HEADER_LENGTH);

  return {
    transferId,
    fileIndex,
    chunkIndex,
    iv,
    ciphertext,
  };
}

export interface RoutedRelayFrame {
  targetPeerId: string;
  sourcePeerId: string;
  payload: Uint8Array;
}

export function wrapRoutedRelayFrame(
  targetPeerId: string,
  sourcePeerId: string,
  innerPayload: Uint8Array
): Uint8Array {
  const out = new Uint8Array(ROUTING_HEADER_LENGTH + innerPayload.byteLength);
  out[0] = FRAME_ROUTED_RELAY;
  writeFixedAsciiId(out, 1, targetPeerId);
  writeFixedAsciiId(out, 17, sourcePeerId);
  out.set(innerPayload, ROUTING_HEADER_LENGTH);
  return out;
}

export function unwrapRoutedRelayFrame(bytes: Uint8Array): RoutedRelayFrame {
  if (bytes.byteLength < ROUTING_HEADER_LENGTH) {
    throw new Error(`Routed frame too short: ${bytes.byteLength} bytes`);
  }
  if (bytes[0] !== FRAME_ROUTED_RELAY) {
    throw new Error(`Unexpected routed frame type: 0x${bytes[0].toString(16)}`);
  }
  const targetPeerId = readFixedAsciiId(bytes, 1);
  const sourcePeerId = readFixedAsciiId(bytes, 17);
  const payload = bytes.subarray(ROUTING_HEADER_LENGTH);
  return {
    targetPeerId,
    sourcePeerId,
    payload,
  };
}

export function overwriteRoutedSourcePeerId(bytes: Uint8Array, authenticatedPeerId: string): void {
  if (bytes.byteLength >= ROUTING_HEADER_LENGTH && bytes[0] === FRAME_ROUTED_RELAY) {
    writeFixedAsciiId(bytes, 17, authenticatedPeerId);
  }
}

// ============================================================================
// Base64URL & Formatting Helpers
// ============================================================================

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function utf8ToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value >= 100 || exp === 0 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[exp]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function classifyTextPayload(text: string): 'url' | 'otp' | 'code' | 'text' {
  const trimmed = text.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return 'url';
  if (/^\d{4,8}$/.test(trimmed) || /\b(?:code|otp|pin|verification)\b.*?\b\d{4,8}\b/i.test(trimmed)) {
    return 'otp';
  }
  if (
    trimmed.includes('\n') &&
    /[{};()=>[\]]/.test(trimmed) &&
    (/\b(const|let|function|import|export|class|def|return|curl|npm|brew|adb)\b/.test(trimmed) ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('$ '))
  ) {
    return 'code';
  }
  return 'text';
}
