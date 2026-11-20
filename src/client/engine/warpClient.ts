import {
  type ClientToServerMessage,
  type ControlPayload,
  type DeviceProfile,
  type LanEndpoint,
  type HostFirewallStatus,
  type FileManifestItem,
  type HistoricalTransferSummary,
  type LocalDaemonStatus,
  type PeerSummary,
  type ServerToClientMessage,
  type TransportKind,
  type VisibilityMode,
  classifyTextPayload,
  decodeBinarySackFrame,
  decodeEncryptedChunkFrame,
  encodeBinarySackFrame,
  encodeEncryptedChunkFrame,
  FRAME_BINARY_SACK,
  formatPairCode,
  isValidPairCode,
  base64UrlToBytes,
  bytesToBase64Url,
  type Admission,
  isValidClipboardImageDataUrl,
  MAX_CLIPBOARD_IMAGE_DATAURL,
  normalizePairCode,
  unwrapRoutedRelayFrame,
  wrapRoutedRelayFrame,
} from '../../shared/protocol.js';
import {
  type IdentityKeys,
  type PeerCryptoSession,
  decryptBinaryChunk,
  decryptControlPayload,
  derivePeerSession,
  encryptBinaryChunk,
  encryptControlPayload,
  generateIdentityKeyPair,
  sha256Hex,
} from './crypto.js';
import { loadOrCreateDeviceId } from './deviceDetect.js';
import {
  ContinuityManager,
  type CallAudioFrame,
  type CallCommandResult,
  type ContactShareItem,
  type ContactsQueryResult,
  type ContinuityDiagnosticsSnapshot,
  type ContinuityOptions,
  type ContinuitySnapshot,
  type ScreenAudioFrame,
  type ScreenFrame,
  type ScreenVideoFrame,
  type ScreenFrameSource,
} from './continuity.js';
import { FRAME_CALL_AUDIO, FRAME_SCREEN, FRAME_SCREEN_AUDIO, type CallInfo, type ContactCard } from '../../shared/continuity.js';
import {
  type DeviceIdentity,
  type IdentityStore,
  indexedDbIdentityStore,
  loadOrCreateDeviceIdentity,
  verifyIdentityBinding,
} from './identity.js';
import {
  HUB_SPAKE2_IDENTITY,
  JOIN_PROTOCOL_VERSION,
  JOIN_SPAKE2_AAD,
  joinerSpake2Identity,
  nameplateFor,
  passwordScalar,
  verifyHubProof,
  verifyPeerVouch,
  vouchKeyFrom,
} from '../../shared/pairingProof.js';
import { Spake2, constantTimeEqual } from '../../shared/spake2.js';
import { hashStream, Sha256Stream } from './sha256Stream.js';

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB — 4× fewer frame/crypto/ACK round-trips than 256 KiB
export const MIN_CHUNK_SIZE = 16 * 1024; // smallest per-file chunk size a peer may declare (legacy peers use 64 KiB)
export const MAX_CHUNK_SIZE = 1024 * 1024; // largest per-file chunk size a peer may declare
export const MAX_FILES_PER_TRANSFER = 100;
export const MAX_CHUNKS_PER_TRANSFER = 262_144; // Manifest safety ceiling: 64 GiB total at default 256 KiB chunks
export const MAX_CLIPBOARD_TEXT = 256_000;
export const MAX_BROWSER_BUFFERED_BYTES = 128 * 1024 * 1024; // larger receives require disk/native storage
export const MAX_CLIPBOARD_IMAGE_DATAURL_LENGTH = MAX_CLIPBOARD_IMAGE_DATAURL;

/** Verify that a candidate URL uses http: or https: before rendering or classifying as a link. */
export function isSafeHttpUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripPreviewDataUrl(file: FileManifestItem): Omit<FileManifestItem, 'previewDataUrl'> {
  const copy: FileManifestItem = { ...file };
  delete copy.previewDataUrl;
  return copy;
}

function sanitizeFileSegmentChars(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = raw[i]!;
    out += code < 0x20 || '<>:"|?*'.includes(ch) ? '_' : ch;
  }
  return out.trim();
}

export function isValidFileManifest(files: unknown, totalBytes: unknown): files is FileManifestItem[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_TRANSFER) return false;
  if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0) return false;
  let sum = 0; let chunks = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as FileManifestItem;
    if (!f || f.index !== i || typeof f.name !== 'string' || f.name.length === 0 || f.name.length > 512) return false;
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) return false;
    // Honor the sender's declared chunk size (bounded) instead of demanding
    // our own: legacy 64 KiB peers and future larger-chunk peers both work,
    // and the receiver sizes/validates every chunk against this declaration.
    if (typeof f.chunkSize !== 'number' || !Number.isSafeInteger(f.chunkSize) || f.chunkSize < MIN_CHUNK_SIZE || f.chunkSize > MAX_CHUNK_SIZE) return false;
    const expectedChunks = Math.max(1, Math.ceil(f.size / f.chunkSize));
    if (f.totalChunks !== expectedChunks) return false;
    if (f.previewDataUrl !== undefined && (typeof f.previewDataUrl !== 'string' || f.previewDataUrl.length > 16_000 || !f.previewDataUrl.startsWith('data:image/'))) return false;
    sum += f.size; chunks += f.totalChunks;
    if (chunks > MAX_CHUNKS_PER_TRANSFER) return false;
  }
  return sum === totalBytes;
}

function normalizeResumeChunks(
  raw: unknown,
  files: FileManifestItem[],
): Record<number, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const result: Record<number, number> = {};
  for (const file of files) {
    const value = source[String(file.index)];
    if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= file.totalChunks) {
      if ((value as number) > 0) result[file.index] = value as number;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function bytesForResumeChunks(
  files: FileManifestItem[],
  resume: Record<number, number> | undefined,
): number {
  let bytes = 0;
  for (const file of files) {
    const count = Math.min(file.totalChunks, Math.max(0, resume?.[file.index] ?? 0));
    for (let chunk = 0; chunk < count; chunk++) {
      bytes += file.size === 0 ? 0 : Math.min(file.chunkSize, file.size - chunk * file.chunkSize);
    }
  }
  return bytes;
}

/** Count receiver-confirmed chunks independently per file; later-file ACKs do not imply earlier files are durable. */
export function countNewlyAcknowledgedChunks(
  acknowledgedPrefixes: readonly number[],
  resumeFromChunks: Record<number, number> | undefined,
): number {
  return acknowledgedPrefixes.reduce(
    (sum, acknowledged, index) =>
      sum + Math.max(0, acknowledged - (resumeFromChunks?.[index] ?? 0)),
    0,
  );
}

const WINDOW_BYTE_BUDGET = 32 * 1024 * 1024;
const ACK_BYTE_CADENCE = 2 * 1024 * 1024;
function windowChunksFor(chunkSize: number): number {
  return Math.max(32, Math.min(128, Math.floor(WINDOW_BYTE_BUDGET / Math.max(MIN_CHUNK_SIZE, chunkSize))));
}
function ackIntervalFor(chunkSize: number): number {
  return Math.max(2, Math.min(16, Math.floor(ACK_BYTE_CADENCE / Math.max(MIN_CHUNK_SIZE, chunkSize))));
}
const ACK_STALL_TIMEOUT_MS = 60_000;
const ACK_MAX_DELAY_MS = 150;
// Keep the displayed rate truthful when disk writes or the network pause.
const SPEED_SAMPLE_INTERVAL_MS = 250;
const SPEED_STALE_TIMEOUT_MS = 1_500;
const COMPLETE_ACK_TIMEOUT_MS = 60_000;
const MAX_COMPLETE_ACK_RETRIES = 2;
const ENCRYPT_PIPELINE_DEPTH = 8; // 8 MiB in flight at 1 MiB/chunk without stalling the socket
const MAX_BUFFER_HIGH_WATER = 8 * 1024 * 1024; // keep high-speed local Wi-Fi fed smoothly
/** Screen frames are dropped (latest-frame-wins) once this much is queued on the socket. */
const CONTINUITY_MAX_BUFFERED = 2 * 1024 * 1024;
const BUFFER_LOW_WATER = 2 * 1024 * 1024;

export interface SendableFileInput {
  /** Opaque Android URI capability, never a path supplied by a peer. */
  nativeSourceId?: string;
  name: string;
  relativePath?: string;
  size: number;
  type: string;
  sliceBytes: (start: number, end: number) => Promise<Uint8Array>;
  rawBlob?: Blob;
}

export function wrapBrowserFile(file: File, relativePath?: string): SendableFileInput {
  return {
    nativeSourceId: typeof window === 'undefined' ? undefined : window.AirBridgeAndroid?.claimPickedFile?.(file.name, file.size) || undefined,
    name: file.name,
    relativePath: relativePath || (file.webkitRelativePath ? file.webkitRelativePath : undefined),
    size: file.size,
    type: file.type || 'application/octet-stream',
    rawBlob: file,
    async sliceBytes(start: number, end: number): Promise<Uint8Array> {
      const buf = await file.slice(start, end).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

export interface ReceivedFileRecord {
  index: number;
  name: string;
  relativePath?: string;
  size: number;
  mimeType: string;
  chunks: Uint8Array[];
  blobUrl?: string;
  sha256: string;
  verified: boolean;
  savedToMacPath?: string;
  /** Path of a file written straight to disk via the File System Access API (phone/browser). */
  savedToDiskPath?: string;
}

export type TransferDirection = 'incoming' | 'outgoing';
export type TransferStatus =
  | 'pending-accept'
  | 'connecting'
  | 'transferring'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'error';

export interface TransferSessionView {
  transferId: string;
  peerId: string;
  peerDeviceId?: string;
  pairCode?: string;
  peerName: string;
  peerPlatform: PeerSummary['device']['platform'];
  sasCode: string;
  direction: TransferDirection;
  status: TransferStatus;
  transport: TransportKind;
  files: FileManifestItem[];
  totalBytes: number;
  transferredBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  startedAt: number;
  completedAt?: number;
  receivedFiles: ReceivedFileRecord[];
  errorMessage?: string;
}

export interface ClipboardBeamItem {
  beamId: string;
  peerId: string;
  peerName: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  imageDataUrl?: string;
  imageName?: string;
  contentType: 'url' | 'otp' | 'code' | 'text' | 'image';
  timestamp: number;
  sasCode: string;
}

export interface PeerSecurityInfo {
  sasCode: string;
  fingerprintHex: string;
  rtcConnected: boolean;
  rttMs: number | null;
  /**
   * 'verified': the computer that knows the pairing code vouched for this
   * device's keys. 'unverified': older device or hub — compare sasCode.
   */
  verification: 'verified' | 'unverified';
  /** Proven long-term identity key, when the peer has one. */
  identityKey?: string;
  /** Key that "Trust device" pins: the identity key, else the session key (older peers). */
  trustKey: string;
  /** A device id we know presented a different identity key than before. */
  identityChanged: boolean;
}

export interface WarpClientDiagnostics {
  wsCloseCode: number | null;
  wsCloseReason: string;
  reconnectAttempts: number;
  rtcState: Record<string, { connectionState: string; iceConnectionState?: string; dataChannelState: string }>;
  transferErrors: Array<{ transferId: string; stage: string; message: string; at: number }>;
  fallbackTimerFires: number;
  clientErrorRing: Array<{ source: string; message: string; at: number }>;
  transferResumes: number;
  transferChunkRetries: number;
  lastFinalizeDurationMs: number | null;
  screenShare: ContinuityDiagnosticsSnapshot['screenShare'];
  contacts: ContinuityDiagnosticsSnapshot['contacts'];
  callAudio: ContinuityDiagnosticsSnapshot['callAudio'];
  clipboardBridge: {
    imagesSent: number;
    imagesReceived: number;
    autoSyncEnabled: boolean;
    receiveEnabled: boolean;
  };
}

export interface WarpClientSnapshot {
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  connectionError?: string;
  /** How the hub admitted this client ('pake' = code verified without revealing it). */
  admission?: Admission | null;
  peerId: string;
  pairCode: string;
  formattedPairCode: string;
  visibility: VisibilityMode;
  myDevice: DeviceProfile | null;
  lanUrls: string[];
  /** Build version reported by the server in welcome (null for older servers). */
  serverVersion?: string | null;
  /** lanUrls with interface details (same order); absent with older servers. */
  lanEndpoints?: LanEndpoint[];
  /** TLS anchor pin for the pairing QR `ca=` parameter. */
  tlsPin?: string | null;
  /** macOS firewall state of the computer this client is attached to. */
  hostFirewall?: HostFirewallStatus | null;
  localDaemon: LocalDaemonStatus;
  peers: PeerSummary[];
  peerSecurity: Record<string, PeerSecurityInfo>;
  transfers: TransferSessionView[];
  clipboardItems: ClipboardBeamItem[];
  trustedPeerKeys: string[];
  autoClipboardSync: boolean;
  clipboardReceiveEnabled: boolean;
  notificationSharing: boolean;
  /** Contacts, calls and screen sharing with paired devices. */
  continuity?: ContinuitySnapshot;
  /** Structured client diagnostics for support bundles. */
  diagnostics?: WarpClientDiagnostics;
}

export interface NotificationBeamItem {
  notificationId: string;
  peerId: string;
  peerName: string;
  title: string;
  body: string;
  appName?: string;
  packageName?: string;
  timestamp: number;
}

export interface WarpClientOptions extends ContinuityOptions {
  wsUrl?: string;
  initialPairCode?: string;
  storagePrefix?: string;
  deviceOverride?: Omit<DeviceProfile, 'publicKey'>;
  enableWebRtc?: boolean;
  /** Optional ICE servers override; defaults to [] (100% offline LAN). */
  iceServers?: RTCIceServer[];
  autoAcceptAll?: boolean;
  autoClipboardSync?: boolean;
  onIncomingNotification?: (notification: NotificationBeamItem) => void;
  /** Instance-owned persistence for headless peers; never replace global localStorage. */
  storage?: Storage | null;
  /** Headless peers can own serialized OS writes themselves instead of sending set-host-clipboard. */
  writeHostClipboard?: boolean;
  onIncomingTransfer?: (transfer: TransferSessionView) => void;
  onIncomingClipboard?: (item: ClipboardBeamItem) => void;
  onOutgoingAutoClipboard?: (item: ClipboardBeamItem) => void;
  onTransferCompleted?: (transfer: TransferSessionView) => void;
  /**
   * Where the long-term device identity lives. Default: IndexedDB (browsers);
   * null = in-memory only (tests). Headless peers pass a file-backed store.
   */
  identityStore?: IdentityStore | null;
  /**
   * 'auto' (default): prove the code with SPAKE2 unless the hub runs on this
   * machine. 'pake'/'legacy' force a mode (tests, diagnostics).
   */
  joinMode?: 'auto' | 'pake' | 'legacy';
}

interface InternalReceiveState {
  session: TransferSessionView;
  fileChunks: Array<Array<Uint8Array | undefined>>;
  receivedChunkCounts: number[];
  /** First chunk not yet stored contiguously, and last ACK sent, per file. */
  nextContiguousChunks: number[];
  lastAckedChunks: number[];
  lastAckTimes?: number[];
  /** Key that granted consent; a matching display name/deviceId is not authentication. */
  peerPublicKey?: string;
  peerIdentityKey?: string;
  bytesReceived: number;
  lastSpeedTs: number;
  lastSpeedBytes: number;
  fileCompletePayloads: Map<number, { sha256?: string }>;
  finalizedFiles: Set<number>;
  transferCompleteReceived: boolean;
  finalizeChain: Promise<void>;
  inFlightChunks: Set<Promise<void>>;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  /** Disk-backed receivers, one per file, when the host daemon is enabled. */
  diskReceivers?: Map<number, DaemonReceiver>;
  /** File-System-Access-API receivers, one per file, when the browser can write to disk directly. */
  fileSystemReceivers?: Map<number, FileSystemReceiver>;
}

interface InternalSendState {
  session: TransferSessionView;
  inputs: SendableFileInput[];
  /** Sent/ACKed counts for this attempt, tracked independently per file. */
  sentGlobalChunks: number;
  ackedGlobalChunks: number;
  sentChunksByFile: number[];
  ackedChunksByFile: number[];
  ackWaiters: Array<() => void>;
  lastAckAt: number;
  ackWaitStartedAt?: number;
  peerPublicKey?: string;
  peerIdentityKey?: string;
  peerConnectedAt?: number;
  fileDigests?: Map<number, string>;
  connection?: WebSocket;
  lastAckedBytes: number;
  /** Speed sampling is separate from ACK-stall detection, so a paused stream can show 0 B/s. */
  lastSpeedTs: number;
  lastSpeedBytes: number;
  cancelled: boolean;
  acceptResolver?: (transport: TransportKind) => void;
  acceptRejecter?: (reason: Error) => void;
  /** Highest contiguous chunk count the receiver already has, per file. */
  resumeFromChunks?: Record<number, number>;
  /** All durable bytes, including any non-contiguous chunks, on the receiver. */
  resumeBytesTotal?: number;
  completionResult?: { verified: boolean; reason?: string };
  completionAckWaiters: Array<(result: { verified: boolean; reason?: string } | null) => void>;
  acceptingPeerId?: string;
}

class TransferConnectionInterruptedError extends Error {
  constructor(message = 'Transfer connection interrupted; waiting to resume.') {
    super(message);
    this.name = 'TransferConnectionInterruptedError';
  }
}

/** Compare the consent-bearing manifest, not only names or byte counts. */
function sameManifest(a: readonly FileManifestItem[], b: readonly FileManifestItem[]): boolean {
  return a.length === b.length && a.every((file, index) => {
    const other = b[index];
    return other && file.index === other.index && file.name === other.name &&
      file.relativePath === other.relativePath && file.size === other.size &&
      file.mimeType === other.mimeType && file.totalChunks === other.totalChunks &&
      file.chunkSize === other.chunkSize;
  });
}

function isTerminalTransferStatus(
  status: TransferStatus
): status is HistoricalTransferSummary['status'] {
  return (
    status === 'completed' ||
    status === 'declined' ||
    status === 'cancelled' ||
    status === 'error'
  );
}

async function generateThumbnailIfImage(input: SendableFileInput): Promise<string | undefined> {
  if (typeof document === 'undefined' || !input.rawBlob) return undefined;
  if (!/^image\/(jpeg|png|webp|gif)$/i.test(input.type)) return undefined;
  if (input.size > 25 * 1024 * 1024 || input.size === 0) return undefined;

  return new Promise<string | undefined>((resolve) => {
    const url = URL.createObjectURL(input.rawBlob!);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);

    img.onload = () => {
      try {
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          resolve(undefined);
          return;
        }
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const dataUrl = canvas.toDataURL('image/webp', 0.7);
        cleanup();
        resolve(dataUrl.length < 12_000 ? dataUrl : undefined);
      } catch {
        cleanup();
        resolve(undefined);
      }
    };
    img.onerror = () => {
      cleanup();
      resolve(undefined);
    };
    img.src = url;
  });
}

function randomHex16(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getSafeLocalStorage(): Storage | null {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      localStorage !== null &&
      typeof localStorage.getItem === 'function' &&
      typeof localStorage.setItem === 'function'
    ) {
      return localStorage;
    }
  } catch {
    // ignore (e.g. Node experimental localStorage getter without file or sandboxed frame)
  }
  return null;
}

function loadOrCreatePeerId(storagePrefix: string, storage: Storage | null): string {
  const key = `${storagePrefix}:peerId`;
  try {
    const existing = storage?.getItem(key);
    if (existing && /^[0-9a-f]{16}$/.test(existing)) return existing;
  } catch {
    // Storage can be unavailable in private/sandboxed contexts; this peer
    // simply won't have the same server id after a reload.
  }
  const peerId = randomHex16();
  try {
    storage?.setItem(key, peerId);
  } catch {
    // Not required for a successful connection.
  }
  return peerId;
}

// ---------------------------------------------------------------------------
// Disk-backed streaming receive (host / macOS daemon)
// ---------------------------------------------------------------------------

const DISK_SEND_WINDOW = 6; // concurrent loopback chunk posts per inbound file

interface DiskReceiveMeta {
  transferId: string;
  fileIndex: number;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
}

export interface DiskFinalizeResult {
  savedPath: string;
  finalName: string;
  sha256: string;
  bytes: number;
}

// ---- File System Access API (browser-side disk receive, e.g. the phone) ----
// Structural interfaces so the browser's FileSystemDirectoryHandle etc. satisfy
// them, and tests can supply in-memory mocks.

interface FsWritableStream {
  /** File System Access API: WriteParams with an absolute position for sparse writes. */
  write(chunk: FileSystemWriteChunkType): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface FsFileHandle {
  readonly name: string;
  createWritable(): Promise<FsWritableStream>;
  getFile(): Promise<FsFile>;
}
interface FsFile {
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}
interface FsDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
type ShowDirectoryPicker = (options?: {
  mode?: 'read' | 'readwrite';
  id?: string;
}) => Promise<FsDirectoryHandle>;

/**
 * Shared chunk-queueing / concurrency / idle / finalize logic for the two
 * disk receive backends. Subclasses supply how a chunk is written and how the
 * file is finalized.
 */
abstract class ChunkStreamReceiver {
  protected readonly queue: Array<{ chunkIndex: number; data: Uint8Array }> = [];
  /** Queued or durable chunks (dedup), and durable chunks (ACK/finalize). */
  protected readonly received = new Set<number>();
  protected readonly stored = new Set<number>();
  private readonly storedWaiters = new Map<number, Array<(stored: boolean) => void>>();
  protected pending = 0;
  protected complete = false;
  protected finalized = false;
  protected stopped = false;
  protected result?: DiskFinalizeResult;
  protected error?: string;
  protected expectedSha256?: string;
  protected finalizePromise?: Promise<DiskFinalizeResult | null>;
  private idleResolvers: Array<() => void> = [];

  constructor(
    protected readonly meta: DiskReceiveMeta,
    protected readonly windowSize: number,
  ) {}

  hasReceived(chunkIndex: number): boolean {
    return this.received.has(chunkIndex);
  }

  hasStored(chunkIndex: number): boolean {
    return this.stored.has(chunkIndex);
  }

  getReceivedCount(): number {
    return this.received.size;
  }

  getStoredCount(): number {
    return this.stored.size;
  }

  isBusy(): boolean {
    return this.pending > 0 || this.queue.length > 0;
  }

  markReceived(chunkIndex: number): void {
    this.received.add(chunkIndex);
    this.stored.add(chunkIndex);
  }

  /** Resolve only after this chunk's disk write has succeeded. */
  waitUntilStored(chunkIndex: number): Promise<boolean> {
    if (this.stored.has(chunkIndex)) return Promise.resolve(true);
    if (this.stopped || (this.error && !this.received.has(chunkIndex))) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiters = this.storedWaiters.get(chunkIndex) ?? [];
      waiters.push(resolve);
      this.storedWaiters.set(chunkIndex, waiters);
    });
  }

  private notifyStored(chunkIndex: number, stored: boolean): void {
    const waiters = this.storedWaiters.get(chunkIndex) ?? [];
    this.storedWaiters.delete(chunkIndex);
    for (const resolve of waiters) resolve(stored);
  }

  markComplete(): void {
    this.complete = true;
  }

  /** Sender-declared full-file digest, required before reporting a verified result. */
  setExpectedSha256(sha256: string | undefined): void {
    this.expectedSha256 = sha256;
  }

  getError(): string | undefined {
    return this.error;
  }

  push(chunkIndex: number, data: Uint8Array): void {
    if (this.stopped || this.received.has(chunkIndex)) return;
    this.received.add(chunkIndex);
    this.queue.push({ chunkIndex, data });
    this.pump();
  }

  protected abstract writeChunk(chunkIndex: number, data: Uint8Array): Promise<void>;
  protected abstract finalize(): Promise<DiskFinalizeResult | null>;
  /** Remove any partial/final file when verification fails or the transfer is dropped. */
  abstract discard(): Promise<void>;
  /** Close any open resources (streams/handles). Safe to call multiple times. */
  async dispose(): Promise<void> { this.stopWrites(); await this.waitIdle(); }

  protected stopWrites(): void {
    this.stopped = true;
    this.queue.length = 0;
    for (const chunkIndex of this.storedWaiters.keys()) this.notifyStored(chunkIndex, false);
    this.maybeNotifyIdle();
  }

  protected pump(): void {
    while (!this.stopped && this.queue.length > 0 && this.pending < this.windowSize) {
      const item = this.queue.shift()!;
      this.pending++;
      void this.writeChunk(item.chunkIndex, item.data)
        .then(() => {
          if (this.stopped) { this.notifyStored(item.chunkIndex, false); return; }
          this.stored.add(item.chunkIndex);
          this.notifyStored(item.chunkIndex, true);
          // A later successful re-delivery heals an earlier write failure once every chunk is stored.
          if (this.stored.size >= this.meta.totalChunks && this.received.size === this.meta.totalChunks) {
            this.error = undefined;
          }
        })
        .catch((err) => {
          // A chunk that never landed on disk must not count as received,
          // or finalization would hash a truncated file as complete.
          this.received.delete(item.chunkIndex);
          this.error =
            this.error ||
            (err instanceof Error ? err.message : 'Failed to write chunk to disk.');
          this.notifyStored(item.chunkIndex, false);
        })
        .finally(() => {
          this.pending--;
          this.pump();
          this.maybeNotifyIdle();
        });
    }
  }

  waitIdle(): Promise<void> {
    if (this.pending === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private maybeNotifyIdle(): void {
    if (this.pending === 0 && this.queue.length === 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  async finalizeIfReady(forceFallback: boolean): Promise<DiskFinalizeResult | null> {
    if (this.finalized) return this.result ?? null;
    if (this.stopped) return null;
    if (!this.complete && !forceFallback) return null;
    if (this.received.size < this.meta.totalChunks && !forceFallback) return null;
    await this.waitIdle();
    if (this.stopped) return null;
    if (!this.expectedSha256 || !/^[0-9a-f]{64}$/.test(this.expectedSha256)) {
      this.error = 'Missing SHA-256 digest; file was not saved.'; return null;
    }
    if (this.received.size < this.meta.totalChunks) {
      if (forceFallback) this.error = 'Transfer incomplete: some chunks never arrived.';
      return null;
    }
    if (this.error) return null;
    const result = await this.finalize();
    if (result) {
      this.finalized = true;
      this.result = result;
    }
    return result;
  }
}

/**
 * Streams decrypted chunks to the local AirBridge daemon over loopback as
 * they arrive (host / macOS path). Writes are idempotent and resumable.
 */
class DaemonReceiver extends ChunkStreamReceiver {
  constructor(
    meta: DiskReceiveMeta,
    private readonly senderName: string,
    private readonly apiBase: string,
    private readonly onChunkRetry?: () => void,
  ) {
    super(meta, DISK_SEND_WINDOW);
  }

  protected async writeChunk(chunkIndex: number, data: Uint8Array): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-AirBridge-Transfer': this.meta.transferId,
      'X-AirBridge-File': String(this.meta.fileIndex),
      'X-AirBridge-Chunk': String(chunkIndex),
      'X-AirBridge-Name': encodeURIComponent(this.meta.name),
      'X-AirBridge-Size': String(this.meta.size),
      'X-AirBridge-Chunk-Size': String(this.meta.chunkSize),
      'X-AirBridge-Total-Chunks': String(this.meta.totalChunks),
    };
    if (this.senderName) headers['X-AirBridge-Sender'] = encodeURIComponent(this.senderName);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.stopped) throw new Error('Transfer stopped.');
      try {
        const resp = await fetch(`${this.apiBase}/api/daemon/receive-chunk`, {
          method: 'POST',
          headers,
          body: data as unknown as BodyInit,
        });
        if (resp.ok) return;
        const statusErr = new Error(`chunk ${chunkIndex} rejected (HTTP ${resp.status})`);
        if (resp.status !== 429 && resp.status < 500) {
          throw statusErr;
        }
        lastError = statusErr;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('chunk ') && !message.includes('HTTP 5') && !message.includes('HTTP 429')) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(message);
      }
      if (attempt < 3 && !this.stopped) {
        this.onChunkRetry?.();
        await new Promise((resolve) => setTimeout(resolve, 150 * Math.pow(2, attempt)));
      }
    }
    throw lastError ?? new Error(`chunk ${chunkIndex} failed after retries`);
  }

  protected async finalize(): Promise<DiskFinalizeResult | null> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = (async () => {
      try {
        const resp = await fetch(`${this.apiBase}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transferId: this.meta.transferId,
            fileIndex: this.meta.fileIndex,
            ...(this.expectedSha256 ? { expectedSha256: this.expectedSha256 } : {}),
          }),
        });
        if (!resp.ok) {
          const json = (await resp.json().catch(() => ({}))) as { error?: string };
          throw new Error(json.error || `finalize failed (HTTP ${resp.status})`);
        }
        const json = (await resp.json()) as DiskFinalizeResult;
        return {
          savedPath: json.savedPath || '',
          finalName: json.finalName || this.meta.name,
          sha256: json.sha256 || '',
          bytes: json.bytes ?? this.meta.size,
        };
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Failed to save to disk.';
        return null;
      }
    })();
    return this.finalizePromise;
  }

  async discard(): Promise<void> {
    this.stopWrites();
    await this.waitIdle();
    if (this.finalized) return;
    try {
      await fetch(`${this.apiBase}/api/daemon/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId: this.meta.transferId,
          fileIndex: this.meta.fileIndex,
        }),
      });
    } catch {
      // best effort; the daemon also expires stale partials on restart
    }
  }
}

/**
 * Streams decrypted chunks straight to a file in a directory the user picked
 * via the File System Access API — the phone/browser equivalent of the host
 * daemon. Chunks are written at their declared offset (out-of-order arrival is
 * fine), and the file is hash-verified by reading it back incrementally.
 */
class FileSystemReceiver extends ChunkStreamReceiver {
  private static readonly reservedNames = new WeakMap<FsDirectoryHandle, Set<string>>();
  private reservedName?: string;
  private digest: Sha256Stream | null = new Sha256Stream();
  private nextHashChunk = 0;
  private stream?: FsWritableStream;
  private fileHandle?: FsFileHandle;
  private readonly directoryHandle: FsDirectoryHandle;

  constructor(meta: DiskReceiveMeta, directoryHandle: FsDirectoryHandle) {
    // Writes to a single WritableFileStream must be serialized.
    super(meta, 1);
    this.directoryHandle = directoryHandle;
  }

  async open(): Promise<void> {
    const base = sanitizeFileSegmentChars(this.meta.name.replace(/\\/g, '/').split('/').pop()!);
    const safeName = base && base !== '.' && base !== '..' ? base : 'airbridge-file';
    const dot = safeName.lastIndexOf('.');
    const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
    const ext = dot > 0 ? safeName.slice(dot) : '';
    const reservations = FileSystemReceiver.reservedNames.get(this.directoryHandle) ?? new Set<string>();
    FileSystemReceiver.reservedNames.set(this.directoryHandle, reservations);
    for (let index = 0; index < 10_000; index++) {
      const name = index === 0 ? safeName : `${stem} (${index})${ext}`;
      if (reservations.has(name)) continue;
      reservations.add(name);
      this.reservedName = name;
      let exists = false;
      try { await this.directoryHandle.getFileHandle(name); exists = true; }
      catch (error) { if ((error as { name?: string }).name !== 'NotFoundError') { this.releaseName(); throw error; } }
      if (exists) { this.releaseName(); continue; }
      try {
        this.fileHandle = await this.directoryHandle.getFileHandle(name, { create: true });
        this.stream = await this.fileHandle.createWritable();
        await this.stream.truncate(this.meta.size);
        return;
      } catch (error) { await this.discard(); throw error; }
    }
    throw new Error('Too many files with this name.');
  }

  private releaseName(): void {
    if (this.reservedName) FileSystemReceiver.reservedNames.get(this.directoryHandle)?.delete(this.reservedName);
    this.reservedName = undefined;
  }

  protected async writeChunk(chunkIndex: number, data: Uint8Array): Promise<void> {
    await this.stream!.write({
      type: 'write',
      position: chunkIndex * this.meta.chunkSize,
      data,
    } as WriteParams);
    if (this.digest) {
      if (chunkIndex === this.nextHashChunk) { this.digest.update(data); this.nextHashChunk++; }
      else this.digest = null; // bounded read-back hash, never retain out-of-order file payloads
    }
  }

  protected async finalize(): Promise<DiskFinalizeResult | null> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = (async () => {
      try {
        let sha256 = this.digest && this.nextHashChunk === this.meta.totalChunks ? this.digest.hex() : undefined;
        if (sha256 && sha256 !== this.expectedSha256) {
          await this.discard();
          this.error = 'SHA-256 verification failed; the partial file was discarded.';
          return null;
        }
        if (this.stopped) return null;
        await this.stream?.close();
        this.stream = undefined;
        if (!sha256) {
          const file = await this.fileHandle!.getFile();
          sha256 = await hashStream(file.stream());
        }
        const finalName = this.fileHandle!.name || this.meta.name;
        if (this.expectedSha256 && sha256 !== this.expectedSha256) {
          await this.discard();
          this.error = 'SHA-256 verification failed; the partial file was discarded.';
          return null;
        }
        this.releaseName();
        return {
          savedPath: `${this.directoryHandle.name}/${finalName}`,
          finalName,
          sha256,
          bytes: this.meta.size,
        };
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Failed to save to disk.';
        return null;
      }
    })();
    return this.finalizePromise;
  }

  async dispose(): Promise<void> {
    this.stopWrites();
    await this.waitIdle();
    try {
      if (this.stream?.abort) await this.stream.abort();
      else await this.stream?.close(); // compatibility with older implementations
    } catch { /* stream may already have closed during finalization */ }
    this.stream = undefined;
    this.releaseName();
  }

  /** Only files allocated by this receiver can ever be removed. */
  async discard(): Promise<void> {
    await this.dispose();
    if (!this.finalized && this.fileHandle) {
      try { await this.directoryHandle.removeEntry(this.fileHandle.name); } catch { /* best effort */ }
    }
  }

}

export class WarpClient {
  private readonly opts: WarpClientOptions;
  private readonly storagePrefix: string;
  private readonly storage: Storage | null;
  private readonly listeners = new Set<(snap: WarpClientSnapshot) => void>();

  private keys: IdentityKeys | null = null;
  private myDevice: DeviceProfile | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private speedTicker: ReturnType<typeof setInterval> | null = null;
  private readonly speedProgress = new Map<string, { bytes: number; at: number }>();
  private destroyed = false;

  private connectionState: WarpClientSnapshot['connectionState'] = 'connecting';
  private peerId = randomHex16();
  private pairCode = '';
  private visibility: VisibilityMode = 'nearby';
  private lanUrls: string[] = [];
  private serverVersion: string | null = null;
  private lanEndpoints: LanEndpoint[] = [];
  private tlsPin: string | null = null;
  private hostFirewall: HostFirewallStatus | null = null;
  private localDaemon: LocalDaemonStatus = {
    enabled: false,
    platform: 'unknown',
    hostname: '',
    autoSaveToDownloads: false,
  };

  private peers: PeerSummary[] = [];
  private cryptoSessions = new Map<string, PeerCryptoSession>(); // key: peerId
  private cryptoKeyFingerprints = new Map<string, string>(); // peerId -> publicKeyB64
  private peerRttMs = new Map<string, number>();
  private peerControlQueues = new Map<string, Promise<void>>();

  // WebRTC PeerConnections & DataChannels
  private rtcPeers = new Map<string, RTCPeerConnection>();
  private rtcChannels = new Map<string, RTCDataChannel>();
  private rtcMakingOffer = new Map<string, boolean>();
  private rtcWaitTimers = new Map<ReturnType<typeof setInterval>, () => void>();
  private binaryFrameQueue: Promise<void> = Promise.resolve();
  private pendingBlobFrames = 0;

  // Diagnostics telemetry
  private lastWsCloseCode: number | null = null;
  private lastWsCloseReason = '';
  private reconnectAttempts = 0;
  private rateLimitedReconnect = false;
  private fallbackTimerFires = 0;
  private transferResumes = 0;
  private transferChunkRetries = 0;
  private lastFinalizeDurationMs: number | null = null;
  private clipboardImagesSent = 0;
  private clipboardImagesReceived = 0;
  private transferErrors: Array<{ transferId: string; stage: string; message: string; at: number }> = [];
  private clientErrorRing: Array<{ source: string; message: string; at: number }> = [];

  // Active & historical transfers / clipboard
  private transfers: TransferSessionView[] = [];
  // Local offers only: restored/peer-reported history is never a verified receipt.
  // Weak keys make the binding expire with pruned transfer history.
  private receiveOfferBindings = new WeakMap<TransferSessionView, {
    publicKey: string; identityKey?: string; files: FileManifestItem[]; totalBytes: number;
  }>();
  private incomingStates = new Map<string, InternalReceiveState>();
  private outgoingStates = new Map<string, InternalSendState>();
  private clipboardItems: ClipboardBeamItem[] = [];
  private trustedPeerKeys = new Set<string>();

  // Device identity & code-authenticated joining (see shared/pairingProof.ts)
  private identity: DeviceIdentity | null = null;
  private pakeParty: Spake2 | null = null;
  private vouchKey: Uint8Array | null = null;
  private admission: Admission | null = null;
  /** Set when the hub rejected our code: stop reconnecting until the code changes. */
  private pairingError: string | null = null;
  private connectionNotice: string | null = null;
  /** identityKey|sig|publicKey -> binding verified. */
  private identityChecks = new Map<string, boolean>();
  private identityPending = new Set<string>();
  /** deviceId -> identity key first seen (or last trusted) for that device. */
  private knownIdentities: Record<string, string> = {};

  // Automatic universal clipboard sync state
  private autoClipboardSync = true;
  private clipboardReceiveEnabled = true;
  private notificationSharing = true;
  private lastSyncedClipboardText = '';
  private lastSyncedClipboardImageHash = '';
  private seenBeamIds = new Set<string>();
  private lastIncomingClip: { peerId: string; text: string; ts: number } | null = null;
  private pendingAutoClipboard: { text: string; capturedAt: number; deliveredTo: Set<string> } | null = null;
  private autoClipboardSending = false;
  private pendingAutoClipboardImage: { imageDataUrl: string; imageName?: string; hash: string; capturedAt: number; deliveredTo: Set<string> } | null = null;
  private autoClipboardImageSending = false;
  private readonly continuity: ContinuityManager;

  constructor(opts: WarpClientOptions = {}) {
    this.opts = opts;
    this.storagePrefix = opts.storagePrefix ?? 'airbridge';
    this.storage = opts.storage === undefined ? getSafeLocalStorage() : opts.storage;
    this.continuity = new ContinuityManager({
      sendControl: (peerId, payload) => this.sendControlMessage(peerId, payload, true),
      sendFrame: (peerId, frame) => this.sendContinuityFrame(peerId, frame),
      sessionKey: async (peerId) => {
        const peer = this.peers.find((p) => p.peerId === peerId);
        if (!peer) return null;
        try {
          return (await this.ensureCryptoSession(peer)).aesKey;
        } catch {
          return null;
        }
      },
      peer: (peerId) => this.peers.find((p) => p.peerId === peerId),
      isAuthorized: (peerId) => {
        const peer = this.peers.find((p) => p.peerId === peerId);
        return !!peer && peer.discoveryScope === 'paired' &&
          (this.peerVerification(peer) === 'verified' || this.isPeerTrusted(peer));
      },
      isPaired: (peerId) => this.peers.some((p) => p.peerId === peerId && p.discoveryScope === 'paired'),
      peerIds: () => this.peers.map((p) => p.peerId),
      emit: () => this.emit(),
    }, { ...opts, storage: this.storage, storagePrefix: this.storagePrefix });
    this.peerId = loadOrCreatePeerId(this.storagePrefix, this.storage);
    if (opts.autoClipboardSync !== undefined) {
      this.autoClipboardSync = opts.autoClipboardSync;
    }

    // Restore persisted pairCode, trusted devices, auto-clipboard pref & transfer/clipboard history
    try {
      const storage = this.storage;
      if (storage) {
        const storedPair = storage.getItem(`${this.storagePrefix}:pairCode`);
        if (opts.initialPairCode) {
          this.pairCode = normalizePairCode(opts.initialPairCode);
        } else if (storedPair) {
          this.pairCode = normalizePairCode(storedPair);
        }
        try {
          const known = JSON.parse(storage.getItem(`${this.storagePrefix}:knownIdentities`) || '{}') as Record<string, string>;
          if (known && typeof known === 'object') this.knownIdentities = known;
        } catch { /* ignore */ }
        const trustedRaw = storage.getItem(`${this.storagePrefix}:trustedKeys`);
        if (trustedRaw) {
          for (const k of JSON.parse(trustedRaw) as string[]) {
            this.trustedPeerKeys.add(k);
          }
        }
        if (opts.autoClipboardSync === undefined) {
          const autoRaw = storage.getItem(`${this.storagePrefix}:autoClipboard`);
          if (autoRaw === '0' || autoRaw === 'false') {
            this.autoClipboardSync = false;
          }
        }
        const receiveRaw = storage.getItem(`${this.storagePrefix}:clipboardReceive`);
        if (receiveRaw === '0' || receiveRaw === 'false') {
          this.clipboardReceiveEnabled = false;
        }
        const notifRaw = storage.getItem(`${this.storagePrefix}:notificationSharing`);
        if (notifRaw === '0' || notifRaw === 'false') {
          this.notificationSharing = false;
        }
        const historyRaw = storage.getItem(`${this.storagePrefix}:transferHistory`);
        if (historyRaw) {
          const parsed = JSON.parse(historyRaw) as TransferSessionView[];
          if (Array.isArray(parsed)) {
            this.transfers = parsed
              .filter(
                (t) =>
                  t &&
                  typeof t.transferId === 'string' &&
                  Array.isArray(t.files) &&
                  isTerminalTransferStatus(t.status)
              )
              .map((t) => ({ ...t, receivedFiles: [] }));
            this.sortTransfers();
          }
        }
        const clipRaw = storage.getItem(`${this.storagePrefix}:clipboardHistory`);
        if (clipRaw) {
          const parsedClips = JSON.parse(clipRaw) as ClipboardBeamItem[];
          if (Array.isArray(parsedClips)) {
            this.clipboardItems = parsedClips
              .filter((c) => c && typeof c.beamId === 'string' && typeof c.text === 'string')
              .map((c) =>
                c.contentType === 'url' && !isSafeHttpUrl(c.text)
                  ? { ...c, contentType: 'text' as const }
                  : c
              )
              .slice(0, 50);
            this.pruneClipboardHistory();
            for (const c of this.clipboardItems) {
              this.seenBeamIds.add(c.beamId);
            }
            if (this.clipboardItems[0]) {
              this.lastSyncedClipboardText = this.clipboardItems[0].text;
            }
          }
        }
      } else if (opts.initialPairCode) {
        this.pairCode = normalizePairCode(opts.initialPairCode);
      }
    } catch {
      if (opts.initialPairCode) {
        this.pairCode = normalizePairCode(opts.initialPairCode);
      }
    }
  }

  public async start(deviceFactory?: (publicKeyB64: string) => DeviceProfile): Promise<void> {
    this.destroyed = false;
    this.keys = await generateIdentityKeyPair();
    try {
      const store = this.opts.identityStore !== undefined ? this.opts.identityStore : indexedDbIdentityStore(this.storagePrefix);
      this.identity = await loadOrCreateDeviceIdentity(store);
    } catch {
      this.identity = null; // WebCrypto without ECDSA: stay a legacy (unverifiable) peer
    }
    const identitySig = this.identity ? await this.identity.signBinding(this.keys.publicKeyB64).catch(() => null) : null;
    const identityFields = this.identity && identitySig ? { identityKey: this.identity.publicKeyB64, identitySig } : {};
    // Cleanup can run while WebCrypto is pending (e.g. StrictMode replay).
    // A stopped client must not open a socket or install a heartbeat.
    if (this.destroyed) return;

    const fallbackDeviceId =
      typeof window !== 'undefined' ? loadOrCreateDeviceId(this.storagePrefix) : this.peerId;

    if (this.opts.deviceOverride) {
      this.myDevice = {
        deviceId: fallbackDeviceId,
        ...this.opts.deviceOverride,
        publicKey: this.keys.publicKeyB64,
        ...identityFields,
      };
    } else if (deviceFactory) {
      const profile = deviceFactory(this.keys.publicKeyB64);
      this.myDevice = {
        deviceId: fallbackDeviceId,
        ...profile,
        ...(profile.publicKey === this.keys.publicKeyB64 ? identityFields : {}),
      };
    } else {
      this.myDevice = {
        name: 'AirBridge Peer',
        platform: 'unknown',
        model: 'Device',
        formFactor: 'laptop',
        publicKey: this.keys.publicKeyB64,
        deviceId: fallbackDeviceId,
        ...identityFields,
      };
    }

    this.connectWebSocket();

    if (this.speedTicker) clearInterval(this.speedTicker);
    this.speedTicker = setInterval(
      () => this.refreshLiveTransferSpeeds(),
      SPEED_SAMPLE_INTERVAL_MS,
    );

    this.pingInterval = setInterval(() => {
      for (const peer of this.peers) {
        this.sendControlMessage(peer.peerId, { kind: 'ping', ts: Date.now() }, false).catch(
          () => {}
        );
      }
    }, 8_000);
  }

  public stop(): void {
    this.destroyed = true;
    this.continuity.destroy();
    this.pendingAutoClipboard = null;
    for (const sendState of this.outgoingStates.values()) {
      sendState.cancelled = true;
      sendState.acceptRejecter?.(new Error('AirBridge stopped.'));
      for (const wake of sendState.ackWaiters.splice(0)) wake();
      for (const resolve of sendState.completionAckWaiters.splice(0)) {
        resolve({ verified: false, reason: 'AirBridge stopped.' });
      }
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.speedTicker) clearInterval(this.speedTicker);
    this.speedTicker = null;
    this.speedProgress.clear();
    for (const recv of this.incomingStates.values()) {
      if (recv.fallbackTimer) clearTimeout(recv.fallbackTimer);
      void this.disposeReceivers(recv, false).catch(() => {});
    }
    for (const transfer of this.transfers) for (const file of transfer.receivedFiles ?? []) {
      if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
    }
    this.incomingStates.clear();
    this.outgoingStates.clear();
    for (const cancelWait of [...this.rtcWaitTimers.values()]) {
      cancelWait();
    }
    this.rtcWaitTimers.clear();
    this.binaryFrameQueue = Promise.resolve();
    this.pendingBlobFrames = 0;
    for (const dc of this.rtcChannels.values()) {
      try {
        dc.close();
      } catch {
        // ignore
      }
    }
    for (const pc of this.rtcPeers.values()) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    this.rtcChannels.clear();
    this.rtcPeers.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connectionState = 'disconnected';
    this.emit();
  }

  public subscribe(listener: (snap: WarpClientSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getSnapshot(): WarpClientSnapshot {
    const peerSecurity: Record<string, PeerSecurityInfo> = {};
    for (const peer of this.peers) {
      const crypto = this.cryptoSessions.get(peer.peerId);
      const dc = this.rtcChannels.get(peer.peerId);
      const identityKey = this.provenIdentity(peer);
      const known = peer.device?.deviceId ? this.knownIdentities[peer.device.deviceId] : undefined;
      peerSecurity[peer.peerId] = {
        sasCode: crypto?.sasCode ?? '··· ···',
        fingerprintHex: crypto?.fingerprintHex ?? '',
        rtcConnected: dc?.readyState === 'open',
        rttMs: this.peerRttMs.get(peer.peerId) ?? null,
        verification: this.peerVerification(peer) === 'verified' ? 'verified' : 'unverified',
        identityKey,
        trustKey: identityKey ?? peer.device?.publicKey,
        identityChanged: Boolean(identityKey && known && known !== identityKey),
      };
    }

    return {
      connectionState: this.connectionState,
      connectionError: this.pairingError ?? this.connectionNotice ?? undefined,
      admission: this.admission,
      peerId: this.peerId,
      pairCode: this.pairCode,
      formattedPairCode: formatPairCode(this.pairCode),
      visibility: this.visibility,
      myDevice: this.myDevice,
      lanUrls: this.lanUrls,
      serverVersion: this.serverVersion,
      lanEndpoints: this.lanEndpoints,
      tlsPin: this.tlsPin,
      hostFirewall: this.hostFirewall,
      localDaemon: this.localDaemon,
      peers: [...this.peers],
      peerSecurity,
      transfers: [...this.transfers],
      clipboardItems: [...this.clipboardItems],
      trustedPeerKeys: Array.from(this.trustedPeerKeys),
      autoClipboardSync: this.autoClipboardSync,
      clipboardReceiveEnabled: this.clipboardReceiveEnabled,
      notificationSharing: this.notificationSharing,
      continuity: this.continuity.snapshot(),
      diagnostics: this.getDiagnostics(),
    };
  }

  public getDiagnostics(): WarpClientDiagnostics {
    const rtcState: WarpClientDiagnostics['rtcState'] = {};
    for (const [peerId, pc] of this.rtcPeers.entries()) {
      const dc = this.rtcChannels.get(peerId);
      rtcState[peerId] = {
        connectionState: pc.connectionState ?? 'new',
        iceConnectionState: pc.iceConnectionState,
        dataChannelState: dc?.readyState ?? 'none',
      };
    }
    const continuityDiag = this.continuity.getDiagnostics();
    return {
      wsCloseCode: this.lastWsCloseCode,
      wsCloseReason: this.lastWsCloseReason,
      reconnectAttempts: this.reconnectAttempts,
      rtcState,
      transferErrors: [...this.transferErrors],
      fallbackTimerFires: this.fallbackTimerFires,
      clientErrorRing: [...this.clientErrorRing],
      transferResumes: this.transferResumes,
      transferChunkRetries: this.transferChunkRetries,
      lastFinalizeDurationMs: this.lastFinalizeDurationMs,
      screenShare: continuityDiag.screenShare,
      contacts: continuityDiag.contacts,
      callAudio: continuityDiag.callAudio,
      clipboardBridge: {
        imagesSent: this.clipboardImagesSent,
        imagesReceived: this.clipboardImagesReceived,
        autoSyncEnabled: this.autoClipboardSync,
        receiveEnabled: this.clipboardReceiveEnabled,
      },
    };
  }

  public recordTransferError(transferId: string, stage: string, message: string): void {
    this.transferErrors.push({
      transferId,
      stage,
      message: String(message || 'unknown error').slice(0, 300),
      at: Date.now(),
    });
    if (this.transferErrors.length > 20) {
      this.transferErrors.splice(0, this.transferErrors.length - 20);
    }
  }

  public recordClientError(source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    this.clientErrorRing.push({
      source,
      message: message.slice(0, 300),
      at: Date.now(),
    });
    if (this.clientErrorRing.length > 30) {
      this.clientErrorRing.splice(0, this.clientErrorRing.length - 30);
    }
  }

  public setNotificationSharing(enabled: boolean): void {
    this.notificationSharing = enabled;
    try {
      this.storage?.setItem(`${this.storagePrefix}:notificationSharing`, enabled ? '1' : '0');
    } catch {
      // ignore storage error
    }
    this.emit();
  }

  public getNotificationSharing(): boolean {
    return this.notificationSharing;
  }

  public async sendNotification(
    targetPeerId: string,
    title: string,
    body: string,
    appName?: string,
    packageName?: string
  ): Promise<boolean> {
    if (!this.notificationSharing) return false;
    const peer = this.peers.find((p) => p.peerId === targetPeerId);
    if (!peer) return false;

    const notificationId = randomHex16();
    const payload: ControlPayload = {
      kind: 'notification-beam',
      notificationId,
      title: title.trim(),
      body: body.trim(),
      appName: appName?.trim() || 'AirBridge',
      packageName: packageName?.trim(),
      timestamp: Date.now(),
    };

    await this.sendControlMessage(targetPeerId, payload, true);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phone continuity: contacts, calls, screen sharing (see ./continuity.ts)
  // ---------------------------------------------------------------------------

  /** Ask a paired phone for its contacts (filtered on the phone by `query`). */
  public requestContacts(peerId: string, options?: { query?: string; limit?: number }): Promise<ContactsQueryResult> {
    return this.continuity.requestContacts(peerId, options);
  }

  /** Send contact cards (as vCard 3.0) to a paired device. */
  public shareContacts(peerId: string, contacts: ContactCard[]): Promise<ContactShareItem> {
    return this.continuity.shareContacts(peerId, contacts);
  }

  public clearSharedContacts(): void {
    this.continuity.clearSharedContacts();
  }

  public removeSavedContact(contactId: string): boolean {
    return this.continuity.removeSavedContact(contactId);
  }

  public clearSavedContacts(peerId?: string): number {
    return this.continuity.clearSavedContacts(peerId);
  }

  public startCallAudio(peerId: string, callId: string): Promise<void> {
    return this.continuity.startCallAudio(peerId, callId);
  }

  public stopCallAudio(peerId: string, callId: string): Promise<void> {
    return this.continuity.stopCallAudio(peerId, callId);
  }

  public setCallAudioMuted(peerId: string, callId: string, muted: boolean): Promise<void> {
    return this.continuity.setCallAudioMuted(peerId, callId, muted);
  }

  public sendCallAudio(
    peerId: string,
    callId: string,
    pcmS16le: Uint8Array,
    sampleRate: number,
    channels: number,
    frames: number,
    ptsMs: number,
  ): Promise<boolean> {
    return this.continuity.sendCallAudio(peerId, callId, pcmS16le, sampleRate, channels, frames, ptsMs);
  }

  public subscribeCallAudio(callId: string, listener: (frame: CallAudioFrame) => void): () => void {
    return this.continuity.subscribeCallAudio(callId, listener);
  }

  public answerCall(peerId: string, callId: string): Promise<CallCommandResult> {
    return this.continuity.sendCallCommand(peerId, 'answer', { callId });
  }

  public rejectCall(peerId: string, callId: string): Promise<CallCommandResult> {
    return this.continuity.sendCallCommand(peerId, 'reject', { callId });
  }

  public hangUpCall(peerId: string, callId: string): Promise<CallCommandResult> {
    return this.continuity.sendCallCommand(peerId, 'hangup', { callId });
  }

  /** Place a call on the phone; audio stays on the phone or its headset. */
  public dialNumber(peerId: string, number: string): Promise<CallCommandResult> {
    return this.continuity.sendCallCommand(peerId, 'dial', { number });
  }

  /** Phone/simulator side: report a call change to authorized peers. */
  public publishCallState(call: CallInfo, peerId?: string): void {
    this.continuity.publishCallState(call, peerId);
  }

  /** Ask a device to share its screen; returns the session id. */
  public requestScreenShare(peerId: string, options?: { maxWidth?: number; maxFps?: number }): string {
    return this.continuity.requestScreenShare(peerId, options);
  }

  public acceptScreenShare(sessionId: string, source: ScreenFrameSource): void {
    this.continuity.acceptScreenShare(sessionId, source);
  }

  public declineScreenShare(sessionId: string): void {
    this.continuity.declineScreenShare(sessionId);
  }

  public stopScreenShare(sessionId: string): void {
    this.continuity.stopScreenShare(sessionId);
  }

  public requestScreenKeyframe(sessionId: string, reason?: string): void {
    this.continuity.requestScreenKeyframe(sessionId, reason);
  }

  public recordScreenViewerStats(stats: Parameters<ContinuityManager['recordScreenViewerStats']>[0]): void {
    this.continuity.recordScreenViewerStats(stats);
  }

  public recordCallAudioStats(stats: Parameters<ContinuityManager['recordCallAudioStats']>[0]): void {
    this.continuity.recordCallAudioStats(stats);
  }

  /** Decrypted frames for a viewer session (the latest frame is replayed on subscribe). */
  public subscribeScreenFrames(sessionId: string, listener: (frame: ScreenFrame) => void): () => void {
    return this.continuity.subscribeScreenFrames(sessionId, listener);
  }

  /** Decrypted AVC access units for a viewer session. */
  public subscribeScreenVideo(sessionId: string, listener: (frame: ScreenVideoFrame) => void): () => void {
    return this.continuity.subscribeScreenVideo(sessionId, listener);
  }

  /** Decrypted app-audio packets for a viewer session. Playback remains locally opt-in. */
  public subscribeScreenAudio(sessionId: string, listener: (frame: ScreenAudioFrame) => void): () => void {
    return this.continuity.subscribeScreenAudio(sessionId, listener);
  }

  /** Update what this device offers (e.g. screen capture became available) and re-announce. */
  public configureContinuity(options: Partial<ContinuityOptions>): void {
    this.continuity.configure(options);
  }

  /** Media frames ride the relay socket; drop (never queue) when it is congested. */
  private sendContinuityFrame(peerId: string, innerFrame: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > CONTINUITY_MAX_BUFFERED) return false;
    try {
      ws.send(wrapRoutedRelayFrame(peerId, this.peerId, innerFrame));
      return true;
    } catch {
      return false;
    }
  }

  public updateDeviceName(newName: string): void {
    if (!this.myDevice) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    this.myDevice = { ...this.myDevice, name: trimmed };
    this.sendServer({
      type: 'update-profile',
      device: this.myDevice,
      visibility: this.visibility,
    });
    this.emit();
  }

  public setVisibility(visibility: VisibilityMode): void {
    if (!this.myDevice) return;
    this.visibility = visibility;
    this.sendServer({
      type: 'update-profile',
      device: this.myDevice,
      visibility,
    });
    this.emit();
  }

  public joinPairCode(code: string): void {
    const clean = normalizePairCode(code);
    if (clean.length !== 6) return;
    this.pairCode = clean;
    this.persistPairCode(clean);
    this.pairingError = null;
    if (this.admission === 'host' || this.admission === 'pake') {
      // The hub is this computer, or already proved it knows a code: it may
      // see the new one. It still never travels to an unauthenticated hub.
      this.sendServer({ type: 'join-pair', pairCode: clean });
    } else {
      this.reconnectNow();
    }
    this.emit();
  }

  public rotatePairCode(): void {
    this.sendServer({ type: 'rotate-pair' });
  }

  public toggleTrustedPeer(publicKey: string, trusted: boolean): void {
    // Accept either key of a connected peer and pin its proven identity.
    const peer = this.peers.find((p) => p.device.publicKey === publicKey || p.device.identityKey === publicKey);
    const key = peer ? this.trustKeyFor(peer) : publicKey;
    if (trusted) {
      this.trustedPeerKeys.add(key);
      const identity = peer ? this.provenIdentity(peer) : undefined;
      if (peer?.device.deviceId && identity) {
        this.knownIdentities[peer.device.deviceId] = identity;
        this.persistKnownIdentities();
      }
    } else {
      this.trustedPeerKeys.delete(key);
      if (peer) this.trustedPeerKeys.delete(peer.device.publicKey);
    }
    try {
      const storage = this.storage;
      if (storage) {
        storage.setItem(
          `${this.storagePrefix}:trustedKeys`,
          JSON.stringify(Array.from(this.trustedPeerKeys))
        );
      }
    } catch {
      // ignore
    }
    this.emit();
  }

  public setAutoClipboardSync(enabled: boolean): void {
    this.autoClipboardSync = enabled;
    if (!enabled) {
      this.pendingAutoClipboard = null;
    }
    try {
      const storage = this.storage;
      if (storage) {
        storage.setItem(`${this.storagePrefix}:autoClipboard`, enabled ? '1' : '0');
      }
    } catch {
      // ignore
    }
    this.emit();
  }

  public setClipboardReceiveEnabled(enabled: boolean): void {
    this.clipboardReceiveEnabled = enabled;
    try {
      const storage = this.storage;
      if (storage) {
        storage.setItem(`${this.storagePrefix}:clipboardReceive`, enabled ? '1' : '0');
      }
    } catch {
      // ignore
    }
    this.emit();
  }

  /** Folder on this device (host daemon) where received files are saved. Loopback-only server API. */
  public async updateReceivedFolder(downloadDir: string): Promise<string> {
    const resp = await fetch('/api/received-folder', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ downloadDir }),
    });
    const json = (await resp.json().catch(() => ({}))) as { downloadDir?: string; error?: string };
    if (!resp.ok || !json.downloadDir) throw new Error(json.error || 'Could not update the received-files folder.');
    this.localDaemon = { ...this.localDaemon, enabled: true, autoSaveToDownloads: true, downloadDir: json.downloadDir };
    this.emit();
    return json.downloadDir;
  }

  public async openReceivedFolder(savedPath?: string): Promise<void> {
    const resp = await fetch('/api/received-folder/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savedPath ? { path: savedPath } : {}),
    });
    if (!resp.ok) {
      const json = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(json.error || 'Could not open the received-files folder.');
    }
  }

  public markClipboardSynced(text: string): void {
    const trimmed = text.trim();
    if (trimmed) {
      this.lastSyncedClipboardText = text;
    }
  }

  public getLastSyncedClipboardText(): string {
    return this.lastSyncedClipboardText;
  }

  /**
   * Automatically beams newly copied clipboard text only to paired devices.
   * Nearby discovery alone must never opt another machine into clipboard access.
   */
  public async handleDetectedLocalClipboard(rawText: string): Promise<ClipboardBeamItem[]> {
    if (!this.autoClipboardSync || this.destroyed || !rawText.trim() || rawText.length > MAX_CLIPBOARD_TEXT) return [];
    if (rawText === this.lastSyncedClipboardText && this.pendingAutoClipboard?.text !== rawText) return [];
    if (this.pendingAutoClipboard?.text !== rawText) {
      this.pendingAutoClipboard = { text: rawText, capturedAt: Date.now(), deliveredTo: new Set() };
    }
    return this.flushAutoClipboard();
  }

  /** One active capture and one latest pending value, never a queue of large text copies. */
  private async flushAutoClipboard(): Promise<ClipboardBeamItem[]> {
    if (this.autoClipboardSending) return [];
    this.autoClipboardSending = true;
    const results: ClipboardBeamItem[] = [];
    try {
      while (this.pendingAutoClipboard && this.autoClipboardSync && !this.destroyed) {
        const pending = this.pendingAutoClipboard;
        if (Date.now() - pending.capturedAt > 60_000) { this.pendingAutoClipboard = null; break; }
        const targets = this.peers.filter((peer) => peer.discoveryScope === 'paired');
        if (this.connectionState !== 'connected' || targets.length === 0) break;
        for (const peer of targets) {
          if (this.pendingAutoClipboard !== pending || !this.autoClipboardSync || this.destroyed) break;
          const identity = peer.device?.publicKey || peer.peerId;
          if (pending.deliveredTo.has(identity)) continue;
          try {
            results.push(await this.sendClipboard(peer.peerId, pending.text, { isAuto: true }));
            pending.deliveredTo.add(identity);
          } catch { /* retain the unsent targets for a reconnect/retry */ }
        }
        if (this.pendingAutoClipboard !== pending) continue;
        if (targets.every((peer) => pending.deliveredTo.has(peer.device?.publicKey || peer.peerId))) {
          this.lastSyncedClipboardText = pending.text;
          this.pendingAutoClipboard = null;
        }
        break; // Do not spin when a peer failed; retry on the next capture/peer update.
      }
    } finally { this.autoClipboardSending = false; }
    return results;
  }

  /**
   * Automatically beams newly copied clipboard images only to paired devices.
   * Deduplicates by image hash to avoid re-sending images received from a peer.
   */
  public async handleDetectedLocalClipboardImage(
    imageDataUrl: string,
    imageName?: string,
  ): Promise<ClipboardBeamItem[]> {
    if (!this.autoClipboardSync || this.destroyed || !isValidClipboardImageDataUrl(imageDataUrl)) return [];
    const hash = await sha256Hex([new TextEncoder().encode(imageDataUrl)]);
    if (this.destroyed) return [];
    if (hash === this.lastSyncedClipboardImageHash && this.pendingAutoClipboardImage?.hash !== hash) return [];
    if (this.pendingAutoClipboardImage?.hash !== hash) {
      this.pendingAutoClipboardImage = {
        imageDataUrl,
        imageName,
        hash,
        capturedAt: Date.now(),
        deliveredTo: new Set(),
      };
    }
    return this.flushAutoClipboardImage();
  }

  private async flushAutoClipboardImage(): Promise<ClipboardBeamItem[]> {
    if (this.autoClipboardImageSending) return [];
    this.autoClipboardImageSending = true;
    const results: ClipboardBeamItem[] = [];
    try {
      while (this.pendingAutoClipboardImage && this.autoClipboardSync && !this.destroyed) {
        const pending = this.pendingAutoClipboardImage;
        if (Date.now() - pending.capturedAt > 60_000) {
          this.pendingAutoClipboardImage = null;
          break;
        }
        const targets = this.peers.filter((peer) => peer.discoveryScope === 'paired');
        if (this.connectionState !== 'connected' || targets.length === 0) break;
        for (const peer of targets) {
          if (this.pendingAutoClipboardImage !== pending || !this.autoClipboardSync || this.destroyed) break;
          const identity = peer.device?.publicKey || peer.peerId;
          if (pending.deliveredTo.has(identity)) continue;
          try {
            results.push(await this.sendClipboardImage(peer.peerId, pending.imageDataUrl, pending.imageName, { isAuto: true }));
            pending.deliveredTo.add(identity);
          } catch {
            /* retain unsent targets for reconnect retry */
          }
        }
        if (this.pendingAutoClipboardImage !== pending) continue;
        if (targets.every((peer) => pending.deliveredTo.has(peer.device?.publicKey || peer.peerId))) {
          this.lastSyncedClipboardImageHash = pending.hash;
          this.pendingAutoClipboardImage = null;
        }
        break;
      }
    } finally {
      this.autoClipboardImageSending = false;
    }
    return results;
  }

  // ==========================================================================
  // Universal Clipboard / Text & Link Instant Beam
  // ==========================================================================

  public async sendClipboard(
    peerId: string,
    text: string,
    options?: { isAuto?: boolean }
  ): Promise<ClipboardBeamItem> {
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      throw new Error('Selected peer is no longer online.');
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Cannot beam empty text.');
    }
    if (text.length > MAX_CLIPBOARD_TEXT && !isValidClipboardImageDataUrl(trimmed)) {
      throw new Error('Text too large to beam.');
    }

    if (this.identityCacheKey(peer)) {
      await this.checkPeerIdentity(peer);
    }
    const cryptoSession = await this.ensureCryptoSession(peer);
    const beamId = randomHex16();
    const contentType = classifyTextPayload(trimmed);
    const timestamp = Date.now();

    // Distinguish text vs image data URL payloads
    const isImage = isValidClipboardImageDataUrl(trimmed) || contentType === 'image';
    this.seenBeamIds.add(beamId);
    if (this.seenBeamIds.size > 200) this.seenBeamIds.delete(this.seenBeamIds.values().next().value!);

    await this.sendControlMessage(
      peerId,
      {
        kind: 'clipboard-beam',
        beamId,
        text: isImage ? undefined : text,
        imageDataUrl: isImage ? trimmed : undefined,
        imageName: isImage ? `clipboard-image-${Date.now()}.png` : undefined,
        contentType,
        timestamp,
      },
      true
    );

    if (!options?.isAuto) this.lastSyncedClipboardText = isImage ? trimmed : text;
    const item: ClipboardBeamItem = {
      beamId,
      peerId,
      peerName: peer.device.name,
      direction: 'outgoing',
      text: isImage ? trimmed : text,
      imageDataUrl: isImage ? trimmed : undefined,
      contentType,
      timestamp,
      sasCode: cryptoSession.sasCode,
    };
    this.clipboardItems = [item, ...this.clipboardItems];
    this.pruneClipboardHistory();
    this.persistClipboardHistory();
    this.emit();
    if (options?.isAuto) {
      this.opts.onOutgoingAutoClipboard?.(item);
    }
    return item;
  }

  /**
   * Beam an image (data URL) via the clipboard channel.
   * Accepts data:image/...;base64,<payload> up to ~5MB.
   */
  public async sendClipboardImage(
    peerId: string,
    imageDataUrl: string,
    imageName?: string,
    options?: { isAuto?: boolean },
  ): Promise<ClipboardBeamItem> {
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) throw new Error('Selected peer is no longer online.');
    if (!isValidClipboardImageDataUrl(imageDataUrl)) throw new Error('Invalid image data. Use a PNG/JPEG/WebP image under 5 MB.');
    if (this.identityCacheKey(peer)) {
      await this.checkPeerIdentity(peer);
    }
    const cryptoSession = await this.ensureCryptoSession(peer);
    const beamId = randomHex16();
    const timestamp = Date.now();
    this.seenBeamIds.add(beamId);
    if (this.seenBeamIds.size > 200) this.seenBeamIds.delete(this.seenBeamIds.values().next().value!);
    const imageHash = await sha256Hex([new TextEncoder().encode(imageDataUrl)]);
    if (!options?.isAuto) {
      this.lastSyncedClipboardText = imageDataUrl.slice(0, 1024);
      this.lastSyncedClipboardImageHash = imageHash;
    }

    await this.sendControlMessage(
      peerId,
      {
        kind: 'clipboard-beam',
        beamId,
        imageDataUrl,
        imageName: imageName || `image-${Date.now()}.png`,
        contentType: 'image',
        timestamp,
      },
      true
    );
    this.clipboardImagesSent += 1;
    const item: ClipboardBeamItem = {
      beamId,
      peerId,
      peerName: peer.device.name,
      direction: 'outgoing',
      text: imageDataUrl,
      imageDataUrl,
      imageName,
      contentType: 'image',
      timestamp,
      sasCode: cryptoSession.sasCode,
    };
    this.clipboardItems = [item, ...this.clipboardItems];
    this.pruneClipboardHistory();
    this.persistClipboardHistory();
    this.emit();
    if (options?.isAuto) {
      this.opts.onOutgoingAutoClipboard?.(item);
    }
    return item;
  }

  // ==========================================================================
  // Outgoing File Transfer (AirDrop Offer -> Accept -> Streaming Encrypted Chunks)
  // ==========================================================================

  public async sendFiles(
    peerId: string,
    inputs: SendableFileInput[]
  ): Promise<TransferSessionView> {
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      throw new Error('Selected device disconnected.');
    }
    if (inputs.length === 0 || inputs.length > MAX_FILES_PER_TRANSFER) {
      throw new Error('Select 1–100 files.');
    }
    if (this.outgoingStates.size + this.incomingStates.size >= 16) throw new Error('Too many active transfers. Wait for one to finish.');
    let declaredChunks = 0;
    for (const input of inputs) {
      if (!Number.isSafeInteger(input.size) || input.size < 0 || !input.name || input.name.length > 512) {
        throw new Error('Invalid file name or size.');
      }
      declaredChunks += Math.max(1, Math.ceil(input.size / CHUNK_SIZE));
    }
    if (declaredChunks > MAX_CHUNKS_PER_TRANSFER) throw new Error('Files exceed the per-transfer chunk limit.');

    if (this.identityCacheKey(peer)) {
      await this.checkPeerIdentity(peer);
    }
    const cryptoSession = await this.ensureCryptoSession(peer);
    // Proactively warm up WebRTC DataChannel while waiting for recipient Accept
    this.initiateWebRtcIfPossible(peerId);

    const transferId = randomHex16();
    const manifest: FileManifestItem[] = [];
    let totalBytes = 0;

    for (let i = 0; i < inputs.length; i++) {
      const f = inputs[i];
      totalBytes += f.size;
      const totalChunks = Math.max(1, Math.ceil(f.size / CHUNK_SIZE));
      const previewDataUrl = i < 4 ? await generateThumbnailIfImage(f) : undefined;
      manifest.push({
        index: i,
        name: f.name,
        relativePath: f.relativePath,
        size: f.size,
        mimeType: f.type || 'application/octet-stream',
        totalChunks,
        chunkSize: CHUNK_SIZE,
        previewDataUrl,
      });
    }

    const session: TransferSessionView = {
      transferId,
      peerId,
      peerDeviceId: peer.device.deviceId,
      pairCode: this.pairCode || undefined,
      peerName: peer.device.name,
      peerPlatform: peer.device.platform,
      sasCode: cryptoSession.sasCode,
      direction: 'outgoing',
      status: 'pending-accept',
      transport: this.isRtcOpen(peerId) ? 'webrtc' : 'ws-relay',
      files: manifest,
      totalBytes,
      transferredBytes: 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
      startedAt: Date.now(),
      receivedFiles: [],
    };

    const sendState: InternalSendState = {
      session,
      inputs,
      sentGlobalChunks: 0,
      ackedGlobalChunks: 0,
      peerPublicKey: peer.device.publicKey,
      peerIdentityKey: this.provenIdentity(peer),
      fileDigests: new Map(),
      sentChunksByFile: manifest.map(() => 0),
      ackedChunksByFile: manifest.map(() => 0),
      ackWaiters: [],
      lastAckAt: Date.now(),
      lastAckedBytes: 0,
      lastSpeedTs: Date.now(),
      lastSpeedBytes: 0,
      cancelled: false,
      completionAckWaiters: [],
    };

    if (this.destroyed) throw new Error('AirBridge stopped.');
    if (this.outgoingStates.size + this.incomingStates.size >= 16) throw new Error('Too many active transfers. Wait for one to finish.');
    this.outgoingStates.set(transferId, sendState);
    this.transfers = [session, ...this.transfers];
    this.sortTransfers();
    this.emit();

    try {
      const accepted = await this.requestTransferAcceptWithRetry(sendState, peer, cryptoSession);
      // Wait briefly (up to 1.2s) if recipient preferred WebRTC and ICE is mid-handshake
      let activeTransport: TransportKind = 'ws-relay';
      if (accepted.preferredTransport === 'webrtc' && this.canUseWebRtc()) {
        const opened = await this.waitForRtcChannel(accepted.peer.peerId, 1_200);
        activeTransport = opened ? 'webrtc' : 'ws-relay';
      }

      session.status = 'transferring';
      session.transport = activeTransport;
      session.startedAt = Date.now();
      this.emit();
      await this.streamOutgoingFiles(
        accepted.peer,
        accepted.cryptoSession,
        sendState,
        activeTransport,
      );
    } catch (err) {
      if (!sendState.cancelled && !isTerminalTransferStatus(session.status)) {
        session.status = 'error';
        session.completedAt = Date.now();
        session.errorMessage = err instanceof Error ? err.message : 'Transfer interrupted';
        this.outgoingStates.delete(transferId);
        this.sortTransfers();
        this.persistTransferHistory();
        this.emit();
      }
    }

    return session;
  }

  private async requestTransferAcceptWithRetry(
    sendState: InternalSendState,
    initialPeer: PeerSummary,
    initialCryptoSession: PeerCryptoSession,
    acceptTimeoutMs?: number,
  ): Promise<{ peer: PeerSummary; cryptoSession: PeerCryptoSession; preferredTransport: TransportKind }> {
    let peer = initialPeer;
    let cryptoSession = initialCryptoSession;
    const deadline = acceptTimeoutMs !== undefined ? Date.now() + 120_000 : Infinity;
    while (!sendState.cancelled && !this.destroyed) {
      try {
        const preferredTransport = await this.requestTransferAccept(sendState, peer, acceptTimeoutMs);
        return { peer, cryptoSession, preferredTransport };
      } catch (error) {
        if (!(error instanceof TransferConnectionInterruptedError)) throw error;
        if (Date.now() >= deadline) {
          throw new Error('Receiver did not confirm resumed transfer within two minutes.', { cause: error });
        }
        this.transferResumes += 1;
        sendState.session.status = 'connecting';
        sendState.session.speedBytesPerSec = 0;
        sendState.session.etaSeconds = null;
        sendState.lastSpeedTs = Date.now();
        sendState.lastSpeedBytes = sendState.session.transferredBytes;
        this.emit();
        peer = await this.waitForTransferPeer(sendState);
        cryptoSession = await this.ensureCryptoSession(peer);
      }
    }
    throw new Error(sendState.cancelled ? 'Transfer cancelled.' : 'AirBridge stopped.');
  }

  private async requestTransferAccept(
    sendState: InternalSendState,
    peer: PeerSummary,
    acceptTimeoutMs?: number,
  ): Promise<TransportKind> {
    sendState.connection = this.ws ?? undefined;
    sendState.peerConnectedAt = peer.connectedAt;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const acceptPromise = new Promise<TransportKind>((resolve, reject) => {
      let settled = false;
      const finishResolve = (transport: TransportKind) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        resolve(transport);
      };
      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        reject(err);
      };
      sendState.acceptResolver = finishResolve;
      sendState.acceptRejecter = finishReject;
      sendState.acceptingPeerId = peer.peerId;
      if (acceptTimeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          finishReject(new TransferConnectionInterruptedError('Resume offer timed out; retrying.'));
        }, acceptTimeoutMs);
      }
    });
    try {
      await this.sendControlMessage(
        peer.peerId,
        {
          kind: 'transfer-offer',
          transferId: sendState.session.transferId,
          files: sendState.session.files,
          totalBytes: sendState.session.totalBytes,
          createdAt: Date.now(),
        },
        true,
      );
      return await acceptPromise;
    } catch (error) {
      sendState.acceptRejecter?.(
        error instanceof Error ? error : new Error('Could not send transfer offer.'),
      );
      // If sending the offer itself failed, consume the separately rejected
      // acceptance promise too, avoiding an unhandled-rejection race.
      await acceptPromise.catch(() => undefined);
      throw error;
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      sendState.acceptResolver = undefined;
      sendState.acceptRejecter = undefined;
      sendState.acceptingPeerId = undefined;
    }
  }

  private async streamOutgoingFiles(
    peer: PeerSummary,
    cryptoSession: PeerCryptoSession,
    sendState: InternalSendState,
    initialTransport: TransportKind,
  ): Promise<void> {
    let currentPeer = peer;
    let currentCryptoSession = cryptoSession;
    let currentTransport = initialTransport;
    while (!sendState.cancelled) {
      try {
        await this.streamOutgoingFilesOnce(
          currentPeer,
          currentCryptoSession,
          sendState,
          currentTransport,
        );
        return;
      } catch (error) {
        if (!(error instanceof TransferConnectionInterruptedError) || sendState.cancelled) {
          throw error;
        }
        this.transferResumes += 1;
        sendState.session.status = 'connecting';
        sendState.session.speedBytesPerSec = 0;
        sendState.session.etaSeconds = null;
        sendState.lastSpeedTs = Date.now();
        sendState.lastSpeedBytes = sendState.session.transferredBytes;
        this.emit();
        currentPeer = await this.waitForTransferPeer(sendState);
        currentCryptoSession = await this.ensureCryptoSession(currentPeer);
        sendState.resumeFromChunks = undefined;
        sendState.resumeBytesTotal = undefined;
        sendState.completionResult = undefined;
        const accepted = await this.requestTransferAcceptWithRetry(
          sendState,
          currentPeer,
          currentCryptoSession,
          10_000,
        );
        currentPeer = accepted.peer;
        currentCryptoSession = accepted.cryptoSession;
        currentTransport = 'ws-relay';
        if (accepted.preferredTransport === 'webrtc' && this.canUseWebRtc()) {
          currentTransport = (await this.waitForRtcChannel(currentPeer.peerId, 1_200))
            ? 'webrtc'
            : 'ws-relay';
        }
        sendState.session.status = 'transferring';
        sendState.session.transport = currentTransport;
        this.emit();
      }
    }
  }

  private async waitForTransferPeer(sendState: InternalSendState): Promise<PeerSummary> {
    const deadline = Date.now() + 120_000;
    while (!sendState.cancelled && !this.destroyed) {
      if (this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
        const peer = this.peers.find((candidate) =>
          sendState.session.peerDeviceId
            ? candidate.device.deviceId === sendState.session.peerDeviceId
            : candidate.peerId === sendState.session.peerId,
        );
        if (peer) {
          if (this.identityCacheKey(peer)) {
            await this.checkPeerIdentity(peer);
          }
          if (!this.matchesTransferPeerIdentity(peer, sendState.peerPublicKey, sendState.peerIdentityKey)) {
            throw new Error('Receiver identity changed. Pair again before retrying.');
          }
          sendState.peerPublicKey = peer.device.publicKey;
          sendState.peerIdentityKey = this.provenIdentity(peer) ?? sendState.peerIdentityKey;
          sendState.session.peerId = peer.peerId;
          sendState.session.peerName = peer.device.name;
          sendState.session.peerPlatform = peer.device.platform;
          return peer;
        }
      }
      if (Date.now() >= deadline) throw new Error('Receiver did not reconnect within two minutes.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(sendState.cancelled ? 'Transfer cancelled.' : 'AirBridge stopped.');
  }

  private async streamOutgoingFilesOnce(
    peer: PeerSummary,
    cryptoSession: PeerCryptoSession,
    sendState: InternalSendState,
    initialTransport: TransportKind,
  ): Promise<void> {
    const { session, inputs } = sendState;
    const resumeFromChunks = sendState.resumeFromChunks;
    let transport = initialTransport;
    let globalSentChunks = 0;
    sendState.sentGlobalChunks = 0;
    sendState.ackedGlobalChunks = 0;
    sendState.ackWaitStartedAt = undefined;
    sendState.sentChunksByFile = session.files.map(() => 0);
    sendState.ackedChunksByFile = session.files.map(
      (file) => Math.min(file.totalChunks, resumeFromChunks?.[file.index] ?? 0),
    );
    const resumedBytes = Math.min(
      session.totalBytes,
      sendState.resumeBytesTotal ?? bytesForResumeChunks(session.files, resumeFromChunks),
    );
    session.transferredBytes = resumedBytes;
    session.speedBytesPerSec = 0;
    session.etaSeconds = null;
    sendState.lastAckAt = Date.now();
    sendState.lastAckedBytes = resumedBytes;
    sendState.lastSpeedTs = Date.now();
    sendState.lastSpeedBytes = resumedBytes;
    this.emit();

    for (let fileIdx = 0; fileIdx < inputs.length; fileIdx++) {
      const input = inputs[fileIdx];
      const meta = session.files[fileIdx];
      if (input.size !== meta.size) throw new Error(`Source file size changed: ${input.name}.`);
      // A receiver only skips the highest contiguous durable prefix, so every
      // byte still contributes exactly once to the full-file digest.
      const resumeFrom = Math.min(meta.totalChunks, resumeFromChunks?.[fileIdx] ?? 0);
      const cachedDigest = resumeFrom >= meta.totalChunks ? sendState.fileDigests?.get(fileIdx) : undefined;
      if (cachedDigest) {
        this.assertTransferPeerConnected(sendState, peer.peerId);
        await this.sendControlMessage(
          peer.peerId,
          {
            kind: 'file-complete',
            transferId: session.transferId,
            fileIndex: fileIdx,
            sha256: cachedDigest,
          },
          true
        );
        continue;
      }
      const fileHasher = new Sha256Stream();
      for (let c = 0; c < resumeFrom; c++) {
        const start = c * meta.chunkSize;
        const end = Math.min(start + meta.chunkSize, input.size);
        const prefix = input.size === 0 ? new Uint8Array(0) : await input.sliceBytes(start, end);
        if (prefix.byteLength !== end - start) {
          throw new Error(`Could not reread the resumed portion of ${input.name}.`);
        }
        fileHasher.update(prefix);
      }

      // Pipelined producer: up to ENCRYPT_PIPELINE_DEPTH chunks are being
      // read from disk + AES-GCM encrypted concurrently (WebCrypto runs
      // these in parallel off the main thread) while the chunk ahead of
      // them is being pushed into the socket. The old loop awaited read →
      // encrypt → send strictly one chunk at a time, so the network idled
      // during every encrypt and the CPU idled during every send. Frames
      // are still *sent* strictly in chunk order.
      interface PreparedChunk {
        plainChunk: Uint8Array;
        innerFrame: Uint8Array;
      }
      const preparedChunks = new Map<number, Promise<PreparedChunk>>();
      const launchPrepare = (chunkIdx: number): void => {
        if (chunkIdx >= meta.totalChunks || preparedChunks.has(chunkIdx)) return;
        const task = (async (): Promise<PreparedChunk> => {
          const start = chunkIdx * meta.chunkSize;
          const end = Math.min(start + meta.chunkSize, input.size);
          const plainChunk =
            input.size === 0 ? new Uint8Array(0) : await input.sliceBytes(start, end);
          if (plainChunk.byteLength !== end - start) {
            throw new Error(`File changed or could not be read: ${input.name}.`);
          }
          const { iv, ciphertext } = await encryptBinaryChunk(
            cryptoSession.aesKey,
            plainChunk,
            fileIdx,
            chunkIdx
          );
          const innerFrame = encodeEncryptedChunkFrame({
            transferId: session.transferId,
            fileIndex: fileIdx,
            chunkIndex: chunkIdx,
            iv,
            ciphertext,
          });
          return { plainChunk, innerFrame };
        })();
        // If the transfer is cancelled before this chunk is consumed, its
        // rejection must not surface as an unhandled rejection.
        task.catch(() => {});
        preparedChunks.set(chunkIdx, task);
      };
      for (let i = 0; i < Math.min(ENCRYPT_PIPELINE_DEPTH, meta.totalChunks - resumeFrom); i++) {
        launchPrepare(resumeFrom + i);
      }

      const maxUnacked = windowChunksFor(meta.chunkSize);
      for (let chunkIdx = resumeFrom; chunkIdx < meta.totalChunks; chunkIdx++) {
        if (sendState.cancelled) return;

        // Respect receiver-confirmed work. If ACKs stop, surface the stall as
        // recoverable so the same transfer ID can renegotiate and resume.
        while (!sendState.cancelled && globalSentChunks - sendState.ackedGlobalChunks >= maxUnacked) {
          await this.waitForChunkAckProgress(sendState, peer.peerId);
        }
        if (sendState.cancelled) return;
        sendState.ackWaitStartedAt = undefined;

        const { plainChunk, innerFrame } = await preparedChunks.get(chunkIdx)!;
        preparedChunks.delete(chunkIdx);
        launchPrepare(chunkIdx + ENCRYPT_PIPELINE_DEPTH);

        fileHasher.update(plainChunk);

        // Send over WebRTC DataChannel if open; seamlessly fall back to WS Binary Relay if closed!
        if (transport === 'webrtc' && this.isRtcOpen(peer.peerId)) {
          try {
            await this.sendRtcBinaryWithBackpressure(peer.peerId, innerFrame);
          } catch {
            // Channel died (or the frame exceeds this browser's SCTP
            // maxMessageSize): relay this and every later chunk over WS.
            transport = 'ws-relay';
            session.transport = 'ws-relay';
            await this.sendWsRelayBinaryWithBackpressure(peer.peerId, innerFrame);
          }
        } else {
          if (transport === 'webrtc') {
            transport = 'ws-relay';
            session.transport = 'ws-relay';
          }
          await this.sendWsRelayBinaryWithBackpressure(peer.peerId, innerFrame);
        }

        globalSentChunks++;
        sendState.sentGlobalChunks = globalSentChunks;
        sendState.sentChunksByFile[fileIdx] = (sendState.sentChunksByFile[fileIdx] ?? 0) + 1;
      }

      this.assertTransferPeerConnected(sendState, peer.peerId);
      const digest = fileHasher.hex();
      sendState.fileDigests?.set(fileIdx, digest);
      await this.sendControlMessage(
        peer.peerId,
        {
          kind: 'file-complete',
          transferId: session.transferId,
          fileIndex: fileIdx,
          sha256: digest,
        },
        true
      );
    }

    // Do not report bytes as received merely because send() queued them. All
    // transports now wait for receiver-durable chunk ACKs before finalizing.
    sendState.ackWaitStartedAt = undefined;
    await this.waitForAllChunkAcks(sendState, globalSentChunks, peer.peerId);
    if (sendState.cancelled) return;

    const completion = await this.waitForTransferCompletionAck(sendState, peer.peerId);
    if (!completion.verified) {
      throw new Error(completion.reason || 'The receiver could not verify this transfer.');
    }

    session.transferredBytes = session.totalBytes;
    session.etaSeconds = 0;
    session.status = 'completed';
    session.completedAt = Date.now();
    this.outgoingStates.delete(session.transferId);
    this.sortTransfers();
    this.persistTransferHistory();
    this.emit();
    this.opts.onTransferCompleted?.(session);
    this.syncHistoryWithPeer(peer).catch(() => {});
  }

  private waitForAckSignal(sendState: InternalSendState, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = sendState.ackWaiters.indexOf(waiter);
        if (index >= 0) sendState.ackWaiters.splice(index, 1);
        resolve();
      };
      const waiter = () => finish();
      const timer = setTimeout(finish, timeoutMs);
      sendState.ackWaiters.push(waiter);
    });
  }

  private assertTransferPeerConnected(sendState: InternalSendState, peerId: string): void {
    if (sendState.cancelled) return;
    if (this.destroyed || this.ws?.readyState !== WebSocket.OPEN ||
        (sendState.connection && sendState.connection !== this.ws)) {
      throw new TransferConnectionInterruptedError('Signaling connection lost; resuming transfer.');
    }
    const peer = this.peers.find(
      (candidate) =>
        candidate.peerId === peerId &&
        this.matchesTransferPeerIdentity(candidate, sendState.peerPublicKey, sendState.peerIdentityKey),
    );
    if (!peer || (sendState.peerConnectedAt !== undefined && peer.connectedAt !== sendState.peerConnectedAt)) {
      throw new TransferConnectionInterruptedError('Receiver disconnected; waiting to resume.');
    }
  }

  private async waitForChunkAckProgress(
    sendState: InternalSendState,
    peerId: string,
  ): Promise<void> {
    this.assertTransferPeerConnected(sendState, peerId);
    if (sendState.cancelled) return;
    sendState.ackWaitStartedAt ??= Date.now();
    const elapsed = Date.now() - Math.max(sendState.lastAckAt, sendState.ackWaitStartedAt);
    if (elapsed >= ACK_STALL_TIMEOUT_MS) {
      throw new TransferConnectionInterruptedError('Receiver stopped acknowledging; resuming transfer.');
    }
    await this.waitForAckSignal(sendState, Math.min(250, ACK_STALL_TIMEOUT_MS - elapsed));
    this.assertTransferPeerConnected(sendState, peerId);
    if (Date.now() - Math.max(sendState.lastAckAt, sendState.ackWaitStartedAt) >= ACK_STALL_TIMEOUT_MS) {
      throw new TransferConnectionInterruptedError('Receiver stopped acknowledging; resuming transfer.');
    }
  }

  private async waitForAllChunkAcks(
    sendState: InternalSendState,
    targetChunks: number,
    peerId: string,
  ): Promise<void> {
    while (!sendState.cancelled && sendState.ackedGlobalChunks < targetChunks) {
      await this.waitForChunkAckProgress(sendState, peerId);
    }
  }

  private async waitForTransferCompletionAck(
    sendState: InternalSendState,
    peerId: string,
  ): Promise<{ verified: boolean; reason?: string }> {
    for (let attempt = 0; attempt <= MAX_COMPLETE_ACK_RETRIES; attempt++) {
      if (sendState.completionResult) return sendState.completionResult;
      this.assertTransferPeerConnected(sendState, peerId);
      const response = new Promise<{ verified: boolean; reason?: string } | null>((resolve) => {
        let settled = false;
        const finish = (result: { verified: boolean; reason?: string } | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = sendState.completionAckWaiters.indexOf(waiter);
          if (index >= 0) sendState.completionAckWaiters.splice(index, 1);
          resolve(result);
        };
        const waiter = (result: { verified: boolean; reason?: string } | null) => finish(result);
        const timer = setTimeout(() => finish(null), COMPLETE_ACK_TIMEOUT_MS);
        sendState.completionAckWaiters.push(waiter);
        if (sendState.completionResult) finish(sendState.completionResult);
      });
      await this.sendControlMessage(
        peerId,
        { kind: 'transfer-complete', transferId: sendState.session.transferId },
        true,
      );
      const result = await response;
      this.assertTransferPeerConnected(sendState, peerId);
      if (result) return result;
      if (this.ws?.readyState !== WebSocket.OPEN || !this.peers.some((peer) => peer.peerId === peerId)) {
        throw new TransferConnectionInterruptedError('Connection lost while confirming transfer.');
      }
    }
    throw new TransferConnectionInterruptedError('Receiver confirmation timed out; resuming transfer.');
  }

  public async acceptIncomingTransfer(transferId: string): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState || recvState.session.status !== 'pending-accept') return;

    recvState.session.status = 'connecting';
    recvState.session.startedAt = Date.now();
    recvState.lastSpeedTs = Date.now();
    this.emit();

    try {
      let resumeFromChunks;
      if (this.canReceiveToDisk() && (await this.probeDiskApi())) {
        resumeFromChunks = await this.prepareDiskReceivers(recvState);
      } else if (this.canReceiveViaFileSystem()) {
        // Must be called synchronously within the user gesture — show the
        // picker before any other await so the browser treats it as a user
        // activation. If the user cancels or the API is unavailable, we fall
        // back to the in-memory browser download.
        const directoryHandle = await this.showDirectoryPicker();
        if (directoryHandle) {
          await this.prepareFileSystemReceivers(recvState, directoryHandle);
        }
      }

      if (this.incomingStates.get(transferId) !== recvState) {
        await this.disposeReceivers(recvState, true); return;
      }
      const peerId = recvState.session.peerId;
      if (!this.peers.some((peer) => peer.peerId === peerId &&
          this.matchesTransferPeerIdentity(peer, recvState.peerPublicKey, recvState.peerIdentityKey))) {
        throw new Error('Sender disconnected or its identity changed. Ask them to send the offer again.');
      }
      if (!recvState.diskReceivers?.size && !recvState.fileSystemReceivers?.size) {
        const reservedBytes = [...this.incomingStates.values()].filter((receive) =>
          !receive.diskReceivers?.size && !receive.fileSystemReceivers?.size &&
          (receive.session.status === 'transferring' || receive.session.status === 'connecting'),
        ).reduce((sum, receive) => sum + receive.session.totalBytes, 0);
        if (reservedBytes > MAX_BROWSER_BUFFERED_BYTES) {
          const reason = 'This browser cannot buffer more than 128 MiB. Use the native app or choose a disk-backed receive folder.';
          await this.declineIncomingTransfer(transferId).catch(() => {});
          throw new Error(reason);
        }
        this.trimBufferedHistory(MAX_BROWSER_BUFFERED_BYTES - reservedBytes);
      }
      const preferredTransport: TransportKind = this.canUseWebRtc() ? 'webrtc' : 'ws-relay';
      if (preferredTransport === 'webrtc') this.initiateWebRtcIfPossible(peerId);

      recvState.session.transferredBytes = recvState.bytesReceived;
      recvState.lastSpeedBytes = recvState.bytesReceived;
      recvState.lastSpeedTs = Date.now();
      recvState.session.status = 'transferring';
      this.emit();

      await this.sendControlMessage(
        peerId,
        {
          kind: 'transfer-accept',
          transferId,
          preferredTransport,
          ...(resumeFromChunks ? { resumeFromChunks } : {}),
          resumeBytesTotal: recvState.bytesReceived,
        },
        true
      );
    } catch (error) {
      if (this.incomingStates.get(transferId) === recvState && recvState.session.status === 'connecting') {
        recvState.session.status = 'pending-accept';
        this.emit();
      }
      throw error;
    }
  }

  /** True when this browser can hand received chunks straight to the local daemon. */
  private canReceiveToDisk(): boolean {
    return (
      this.localDaemon.enabled &&
      this.localDaemon.autoSaveToDownloads &&
      typeof fetch === 'function'
    );
  }

  /**
   * Confirm the daemon API is actually reachable before committing to the
   * disk path. `localDaemon.enabled` comes from the WebSocket layer, which
   * also treats a LAN-IP host browser as local; if the HTTP daemon routes
   * somehow refuse us (or the daemon is mid-restart), we fall back to the
   * in-memory browser download rather than failing every chunk post.
   */
  private async probeDiskApi(): Promise<boolean> {
    try {
      const resp = await fetch(
        `${this.apiBaseUrl()}/api/daemon/received?transferId=0000000000000000&fileIndex=0`
      );
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Base URL for the loopback daemon API. In a browser this is the page
   * origin; in tests (where there is no `window`) it is derived from the
   * WebSocket URL the client was pointed at.
   */
  private apiBaseUrl(): string {
    if (this.opts.wsUrl) {
      try {
        const u = new URL(this.opts.wsUrl);
        u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
        u.pathname = '';
        u.search = '';
        u.hash = '';
        return u.origin;
      } catch {
        // fall through to window
      }
    }
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    return '';
  }

  private async getReceiveResume(
    recvState: InternalReceiveState,
  ): Promise<{ resumeFromChunks: Record<number, number>; bytes: number }> {
    const oldDiskReceivers = recvState.diskReceivers;
    await Promise.all([
      ...(oldDiskReceivers?.values() ?? []),
      ...(recvState.fileSystemReceivers?.values() ?? []),
    ].map((receiver) => receiver.waitIdle()));

    // Re-query the daemon on reconnect instead of trusting only the WebView's
    // in-memory write set. This also handles a daemon restart, where a small
    // unjournaled batch may need to be retransmitted. Keep old state only if
    // the local query itself is unavailable; a 200 response without partial
    // data means the server has no resumable chunks for that file.
    if (oldDiskReceivers) {
      const nextDiskReceivers = new Map<number, DaemonReceiver>();
      await Promise.all(recvState.session.files.map(async (file) => {
        const previous = oldDiskReceivers.get(file.index);
        if (recvState.finalizedFiles.has(file.index) && previous) {
          nextDiskReceivers.set(file.index, previous);
          return;
        }
        const receiver = new DaemonReceiver(
          {
            transferId: recvState.session.transferId,
            fileIndex: file.index,
            name: file.name,
            size: file.size,
            chunkSize: file.chunkSize,
            totalChunks: file.totalChunks,
          },
          recvState.session.peerName,
          this.apiBaseUrl(),
          () => { this.transferChunkRetries += 1; },
        );
        const onDisk = await this.queryDiskPartial(recvState.session.transferId, file.index);
        if (onDisk === null && previous) {
          nextDiskReceivers.set(file.index, previous);
          return;
        }
        if (
          onDisk && onDisk.size === file.size &&
          onDisk.chunkSize === file.chunkSize && onDisk.totalChunks === file.totalChunks
        ) {
          for (const index of onDisk.receivedChunks) {
            if (Number.isInteger(index) && index >= 0 && index < file.totalChunks) {
              receiver.markReceived(index);
            }
          }
        }
        nextDiskReceivers.set(file.index, receiver);
      }));
      recvState.diskReceivers = nextDiskReceivers;
    }

    const resumeFromChunks: Record<number, number> = {};
    let bytes = 0;
    for (const file of recvState.session.files) {
      if (recvState.finalizedFiles.has(file.index)) {
        resumeFromChunks[file.index] = file.totalChunks;
        bytes += file.size;
        recvState.receivedChunkCounts[file.index] = file.totalChunks;
        recvState.nextContiguousChunks[file.index] = file.totalChunks;
        recvState.lastAckedChunks[file.index] = file.totalChunks - 1;
        continue;
      }
      const streamReceiver =
        recvState.diskReceivers?.get(file.index) ?? recvState.fileSystemReceivers?.get(file.index);
      const memoryChunks = recvState.fileChunks[file.index] ?? [];
      let count = 0;
      let contiguous = 0;
      for (let chunk = 0; chunk < file.totalChunks; chunk++) {
        const stored = streamReceiver
          ? streamReceiver.hasStored(chunk)
          : Boolean(memoryChunks[chunk]);
        if (stored) {
          count++;
          bytes += file.size === 0
            ? 0
            : Math.min(file.chunkSize, file.size - chunk * file.chunkSize);
        }
        if (chunk === contiguous && stored) contiguous++;
      }
      recvState.receivedChunkCounts[file.index] = count;
      recvState.nextContiguousChunks[file.index] = contiguous;
      recvState.lastAckedChunks[file.index] = contiguous - 1;
      if (contiguous > 0) resumeFromChunks[file.index] = contiguous;
    }
    recvState.bytesReceived = bytes;
    recvState.session.transferredBytes = bytes;
    recvState.session.speedBytesPerSec = 0;
    recvState.session.etaSeconds = null;
    recvState.lastSpeedBytes = bytes;
    recvState.lastSpeedTs = Date.now();
    this.emit();
    return { resumeFromChunks, bytes };
  }

  private async queryDiskPartial(
    transferId: string,
    fileIndex: number
  ): Promise<{
    name?: string;
    size?: number;
    chunkSize?: number;
    totalChunks?: number;
    receivedChunks: number[];
    receivedBytes: number;
    receivedCount: number;
  } | null> {
    try {
      const url = `${this.apiBaseUrl()}/api/daemon/received?transferId=${encodeURIComponent(transferId)}&fileIndex=${fileIndex}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        ok?: unknown;
        name?: unknown;
        size?: unknown;
        chunkSize?: unknown;
        totalChunks?: unknown;
        receivedChunks?: unknown;
        receivedBytes?: unknown;
        receivedCount?: unknown;
      };
      if (!Array.isArray(json.receivedChunks)) {
        if (json.ok !== true) return null;
        return { receivedChunks: [], receivedBytes: 0, receivedCount: 0 };
      }
      return {
        name: typeof json.name === 'string' ? json.name : undefined,
        size: Number.isFinite(Number(json.size)) ? Number(json.size) : undefined,
        chunkSize: Number.isFinite(Number(json.chunkSize)) ? Number(json.chunkSize) : undefined,
        totalChunks: Number.isInteger(Number(json.totalChunks)) ? Number(json.totalChunks) : undefined,
        receivedChunks: json.receivedChunks as number[],
        receivedBytes: Number(json.receivedBytes) || 0,
        receivedCount: Number(json.receivedCount) || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create one disk receiver per file and ask the daemon what (if anything)
   * is already on disk. Returns a per-file resume index (highest contiguous
   * chunk already written) so the sender can skip re-sending the prefix.
   */
  private async prepareDiskReceivers(
    recvState: InternalReceiveState
  ): Promise<Record<number, number> | undefined> {
    const receivers = new Map<number, DaemonReceiver>();
    const resume: Record<number, number> = {};
    let anyResume = false;

    // Resume probes are independent loopback reads. Doing up to 100 of them
    // serially added a visible per-file delay before every multi-file accept.
    const probes = await Promise.all(
      recvState.session.files.map(async (file) => {
        const receiver = new DaemonReceiver(
          {
            transferId: recvState.session.transferId,
            fileIndex: file.index,
            name: file.name,
            size: file.size,
            chunkSize: file.chunkSize,
            totalChunks: file.totalChunks,
          },
          recvState.session.peerName,
          this.apiBaseUrl(),
          () => { this.transferChunkRetries += 1; },
        );
        receivers.set(file.index, receiver);
        const onDisk = await this.queryDiskPartial(recvState.session.transferId, file.index);
        return { file, receiver, onDisk };
      }),
    );

    for (const { file, receiver, onDisk } of probes) {
      let resumeFrom = 0;
      const matchingPartial = Boolean(
        onDisk &&
        onDisk.size === file.size &&
        onDisk.chunkSize === file.chunkSize &&
        onDisk.totalChunks === file.totalChunks
      );
      if (matchingPartial && onDisk!.receivedChunks.length > 0) {
        const safeChunks = onDisk!.receivedChunks.filter(
          (index) => Number.isInteger(index) && index >= 0 && index < file.totalChunks,
        );
        const present = new Set(safeChunks);
        while (present.has(resumeFrom)) resumeFrom++;
        for (const idx of safeChunks) receiver.markReceived(idx);
        // Count the already-landed bytes so progress and completion checks
        // reflect the partial, not just the chunks received this session.
        recvState.receivedChunkCounts[file.index] = safeChunks.length;
        recvState.bytesReceived += safeChunks.reduce(
          (sum, index) => sum + (file.size === 0 ? 0 : Math.min(file.chunkSize, file.size - index * file.chunkSize)),
          0,
        );
      }
      recvState.nextContiguousChunks[file.index] = resumeFrom;
      recvState.lastAckedChunks[file.index] = resumeFrom - 1;
      if (resumeFrom > 0) {
        resume[file.index] = resumeFrom;
        anyResume = true;
      }
    }

    recvState.diskReceivers = receivers;
    return anyResume ? resume : undefined;
  }

  /** True when the browser can write received chunks to a real file via the File System Access API. */
  private canReceiveViaFileSystem(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof (
        window as unknown as { showDirectoryPicker?: ShowDirectoryPicker }
      ).showDirectoryPicker === 'function'
    );
  }

  /**
   * Show the directory picker. Returns null if the user cancels or the API
   * throws (e.g. permission denied), in which case we fall back to the
   * in-memory browser download.
   */
  private async showDirectoryPicker(): Promise<FsDirectoryHandle | null> {
    try {
      const picker = (
        window as unknown as { showDirectoryPicker: ShowDirectoryPicker }
      ).showDirectoryPicker;
      return await picker({ mode: 'readwrite' });
    } catch {
      return null;
    }
  }

  /**
   * Create one FileSystemReceiver per file, opening a writable stream in the
   * picked directory.
   */
  private async prepareFileSystemReceivers(
    recvState: InternalReceiveState,
    directoryHandle: FsDirectoryHandle,
  ): Promise<void> {
    const receivers = new Map<number, FileSystemReceiver>();
    const opened = await Promise.allSettled(
      recvState.session.files.map(async (file) => {
        const receiver = new FileSystemReceiver(
          {
            transferId: recvState.session.transferId,
            fileIndex: file.index,
            name: file.name,
            size: file.size,
            chunkSize: file.chunkSize,
            totalChunks: file.totalChunks,
          },
          directoryHandle,
        );
        receivers.set(file.index, receiver);
        await receiver.open();
      }),
    );
    recvState.fileSystemReceivers = receivers;
    const failed = opened.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      await Promise.all([...receivers.values()].map((receiver) => receiver.discard()));
      throw failed.reason;
    }
  }

  /**
   * Close (and optionally remove) any open disk receivers for a transfer that
   * is being cancelled or declined. File-System-Access receivers discard their
   * partial file from the user's picked directory; daemon receivers just close
   * their handles (the .part + manifest stay for partial recovery).
   */
  private async disposeReceivers(
    recvState: InternalReceiveState,
    discardFiles: boolean,
  ): Promise<void> {
    for (const r of recvState.fileSystemReceivers?.values() ?? []) {
      try {
        await r.discard();
      } catch {
        // ignore
      }
    }
    for (const r of recvState.diskReceivers?.values() ?? []) {
      try {
        if (discardFiles) await r.discard();
        else await r.dispose();
      } catch {
        // ignore
      }
    }
  }

  public async declineIncomingTransfer(transferId: string): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState) return;
    if (recvState.fallbackTimer) clearTimeout(recvState.fallbackTimer);
    recvState.session.status = 'declined';
    recvState.session.completedAt = Date.now();
    this.incomingStates.delete(transferId);
    this.sortTransfers();
    this.persistTransferHistory();
    this.emit();
    await this.disposeReceivers(recvState, true);

    await this.sendControlMessage(
      recvState.session.peerId,
      {
        kind: 'transfer-decline',
        transferId,
      },
      true
    );
  }

  public async cancelTransfer(transferId: string): Promise<void> {
    const sendState = this.outgoingStates.get(transferId);
    if (sendState) {
      sendState.cancelled = true;
      sendState.session.status = 'cancelled';
      sendState.session.completedAt = Date.now();
      sendState.acceptRejecter?.(new Error('Cancelled'));
      for (const w of sendState.ackWaiters.splice(0)) w();
      for (const resolve of sendState.completionAckWaiters.splice(0)) {
        resolve({ verified: false, reason: 'Transfer cancelled.' });
      }
      this.outgoingStates.delete(transferId);
      this.sortTransfers();
      this.persistTransferHistory();
      this.emit();
      await this.sendControlMessage(
        sendState.session.peerId,
        { kind: 'transfer-cancel', transferId },
        true
      ).catch(() => {});
      return;
    }

    const recvState = this.incomingStates.get(transferId);
    if (recvState) {
      if (recvState.fallbackTimer) clearTimeout(recvState.fallbackTimer);
      recvState.session.status = 'cancelled';
      recvState.session.completedAt = Date.now();
      this.incomingStates.delete(transferId);
      await this.disposeReceivers(recvState, true);
      this.sortTransfers();
      this.persistTransferHistory();
      this.emit();
      await this.sendControlMessage(
        recvState.session.peerId,
        { kind: 'transfer-cancel', transferId },
        true
      ).catch(() => {});
    }
  }

  // ==========================================================================
  // WebSocket Signaling & Binary Relay Connection
  // ==========================================================================

  private resolveWsUrl(): string {
    if (this.opts.wsUrl) return this.opts.wsUrl;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }

  private connectWebSocket(): void {
    if (this.destroyed) return;
    const url = this.resolveWsUrl();
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.destroyed || this.ws !== ws || !this.myDevice) return;
      this.vouchKey = null;
      this.admission = null;
      this.pakeParty = null;
      const joinMode = this.opts.joinMode ?? 'auto';
      const usePake = joinMode === 'pake' || (joinMode === 'auto' && !this.hubIsThisMachine(url));
      if (isValidPairCode(this.pairCode) && usePake) {
        // Prove the code without sending it (SPAKE2, shared/pairingProof.ts).
        this.pakeParty = new Spake2(
          'A',
          passwordScalar(this.pairCode),
          joinerSpake2Identity(this.myDevice.publicKey, this.myDevice.identityKey),
          HUB_SPAKE2_IDENTITY,
          JOIN_SPAKE2_AAD,
        );
        this.sendServer({
          type: 'hello',
          peerId: this.peerId,
          device: this.myDevice,
          visibility: this.visibility,
          pake: { v: JOIN_PROTOCOL_VERSION, nameplate: nameplateFor(this.pairCode), share: bytesToBase64Url(this.pakeParty.share()) },
        });
      } else {
        this.sendServer({
          type: 'hello',
          peerId: this.peerId,
          device: this.myDevice,
          pairCode: this.pairCode || undefined,
          visibility: this.visibility,
        });
      }
      this.emit();
    };

    ws.onmessage = (event) => {
      if (this.destroyed || this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as ServerToClientMessage;
          this.handleServerMessage(msg);
        } catch (err) {
          this.recordClientError('ws-json-parse', err);
        }
      } else if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (this.pendingBlobFrames > 0) {
          this.binaryFrameQueue = this.binaryFrameQueue
            .then(() => {
              this.processIncomingBinaryFrame(ws, bytes);
            })
            .catch((err: unknown) => {
              this.recordClientError('ws-arraybuffer-queue', err);
            });
        } else {
          this.processIncomingBinaryFrame(ws, bytes);
        }
      } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
        const blob = event.data;
        this.pendingBlobFrames++;
        this.binaryFrameQueue = this.binaryFrameQueue
          .then(() => blob.arrayBuffer())
          .then((ab) => {
            this.processIncomingBinaryFrame(ws, new Uint8Array(ab));
          })
          .catch((err: unknown) => {
            this.recordClientError('ws-blob-frame', err);
          })
          .finally(() => {
            this.pendingBlobFrames = Math.max(0, this.pendingBlobFrames - 1);
          });
      }
    };

    ws.onclose = (ev?: CloseEvent) => {
      if (this.destroyed || this.ws !== ws) return;
      this.lastWsCloseCode = typeof ev?.code === 'number' ? ev.code : null;
      this.lastWsCloseReason = typeof ev?.reason === 'string' ? ev.reason : '';
      this.connectionState = 'reconnecting';
      for (const sendState of this.outgoingStates.values()) {
        sendState.acceptRejecter?.(
          new TransferConnectionInterruptedError('Signaling connection lost while waiting for acceptance.'),
        );
        for (const wake of sendState.ackWaiters.splice(0)) wake();
        for (const wake of sendState.completionAckWaiters.splice(0)) {
          wake(null);
        }
      }
      this.vouchKey = null;
      this.admission = null;
      this.pakeParty = null;
      this.emit();
      // A rejected code would only be rejected again (and count as another guess).
      if (this.pairingError) { this.connectionState = 'disconnected'; this.emit(); return; }
      this.reconnectAttempts += 1;
      const delay = this.computeReconnectDelayMs();
      this.reconnectDelayMs = delay;
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
    };

    ws.onerror = () => {
      // Handled by onclose
    };
  }

  private processIncomingBinaryFrame(ws: WebSocket, bytes: Uint8Array): void {
    if (this.destroyed || this.ws !== ws) return;
    try {
      const { sourcePeerId, payload } = unwrapRoutedRelayFrame(bytes);
      if (payload[0] === FRAME_BINARY_SACK) {
        const sack = decodeBinarySackFrame(payload);
        this.applyChunkAck(sourcePeerId, { transferId: sack.transferId, fileIndex: sack.fileIndex, ackedChunkIndex: sack.chunkIndex });
      } else if (payload[0] === FRAME_SCREEN) {
        void this.continuity.handleScreenFrame(sourcePeerId, payload);
      } else if (payload[0] === FRAME_SCREEN_AUDIO) {
        void this.continuity.handleScreenAudioFrame(sourcePeerId, payload);
      } else if (payload[0] === FRAME_CALL_AUDIO) {
        void this.continuity.handleCallAudioFrame(sourcePeerId, payload);
      } else {
        this.handleIncomingEncryptedChunk(sourcePeerId, payload, 'ws-relay').catch((err: unknown) => {
          this.recordClientError('ws-chunk', err);
        });
      }
    } catch (err) {
      this.recordClientError('ws-binary-frame', err);
    }
  }

  private computeReconnectDelayMs(): number {
    if (this.rateLimitedReconnect) {
      this.rateLimitedReconnect = false;
      return 60_000;
    }
    const base = Math.min(15_000, 1_500 * Math.pow(2, Math.max(0, this.reconnectAttempts - 1)));
    const jitter = Math.floor(Math.random() * Math.min(400, Math.round(base * 0.1)));
    return base + jitter;
  }

  private handleServerMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case 'pake-challenge': {
        const party = this.pakeParty;
        this.pakeParty = null;
        if (!party) { this.ws?.close(); break; }
        let ok: boolean;
        let ke: Uint8Array | null = null;
        try {
          const result = party.finish(base64UrlToBytes(msg.share));
          ok = constantTimeEqual(result.expectedPeerConfirm, base64UrlToBytes(msg.confirm));
          if (ok) {
            ke = result.ke;
            this.sendServer({ type: 'pake-confirm', confirm: bytesToBase64Url(result.confirm) });
          }
        } catch {
          ok = false;
        }
        if (!ok || !ke) {
          this.failPairing("This computer doesn't know that pairing code. Check the code on its screen and enter it again.");
          break;
        }
        this.vouchKey = vouchKeyFrom(ke);
        break;
      }

      case 'welcome': {
        if (this.vouchKey && !verifyHubProof(this.vouchKey, { peerId: msg.peerId, pairCode: msg.pairCode, tlsPin: msg.tlsPin }, msg.hubProof)) {
          this.failPairing('Could not verify this computer: the connection may have been tampered with.');
          break;
        }
        this.admission = msg.admission ?? (this.vouchKey ? 'pake' : 'legacy');
        this.connectionNotice = null;
        this.connectionState = 'connected';
        this.reconnectAttempts = 0;
        this.reconnectDelayMs = 1_500;
        this.rateLimitedReconnect = false;
        this.serverVersion = msg.serverVersion ?? null;
        this.peerId = msg.peerId;
        this.persistPeerId(msg.peerId);
        this.pairCode = msg.pairCode;
        this.persistPairCode(msg.pairCode);
        this.lanUrls = msg.lanUrls;
        this.lanEndpoints = msg.lanEndpoints ?? [];
        this.tlsPin = msg.tlsPin ?? null;
        this.hostFirewall = msg.hostFirewall ?? null;
        this.localDaemon = msg.localDaemon;
        this.syncPeers(msg.peers);
        break;
      }

      case 'network': {
        // The computer joined/left a network (e.g. a phone hotspot): refresh
        // the endpoints so an open pairing QR is regenerated immediately.
        this.lanUrls = Array.isArray(msg.lanUrls) ? msg.lanUrls : [];
        this.lanEndpoints = Array.isArray(msg.lanEndpoints) ? msg.lanEndpoints : [];
        this.tlsPin = msg.tlsPin ?? null;
        this.hostFirewall = msg.hostFirewall ?? null;
        this.emit();
        break;
      }

      case 'pair-updated': {
        this.pairCode = msg.pairCode;
        this.persistPairCode(msg.pairCode);
        this.syncPeers(msg.peers);
        break;
      }

      case 'peers': {
        this.syncPeers(msg.peers);
        break;
      }

      case 'rtc-signal': {
        this.handleRtcSignal(msg.from, msg.signal).catch(() => {});
        break;
      }

      case 'transfer-control': {
        const connection = this.ws;
        const publicKey = this.peers.find((peer) => peer.peerId === msg.from)?.device.publicKey;
        const prev = this.peerControlQueues.get(msg.from) ?? Promise.resolve();
        const next = prev
          .then(() => {
            if (this.destroyed || this.ws !== connection || !publicKey ||
                !this.peers.some((peer) => peer.peerId === msg.from && peer.device.publicKey === publicKey)) return;
            return this.handleIncomingControl(msg.from, msg.envelope);
          })
          .catch(() => {});
        this.peerControlQueues.set(msg.from, next);
        void next.then(() => { if (this.peerControlQueues.get(msg.from) === next) this.peerControlQueues.delete(msg.from); });
        break;
      }

      case 'host-clipboard': {
        if (msg.imageDataUrl) {
          this.handleDetectedLocalClipboardImage(msg.imageDataUrl, msg.imageName).catch(() => {});
        } else if (typeof msg.text === 'string' && msg.text.length > 0) {
          this.handleDetectedLocalClipboard(msg.text).catch(() => {});
        }
        break;
      }

      case 'error': {
        if (msg.code === 'PAIR_CODE_MISMATCH') {
          this.failPairing("This computer doesn't know that pairing code. Check the code on its screen and enter it again.");
        } else if (msg.code === 'RATE_LIMITED') {
          this.connectionNotice = msg.message;
          this.rateLimitedReconnect = true;
          this.reconnectDelayMs = 60_000;
          this.emit();
        }
        break;
      }
    }
  }

  private reconnectDelayMs = 1_500;

  /** The page talks to the AirBridge service on this same machine. */
  private hubIsThisMachine(url: string): boolean {
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch {
      return false;
    }
  }

  private failPairing(message: string): void {
    this.pairingError = message;
    this.vouchKey = null;
    this.connectionState = 'disconnected';
    this.emit();
    try { this.ws?.close(4001, 'pairing failed'); } catch { /* ignore */ }
  }

  private reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try { ws.close(4000, 'pairing code changed'); } catch { /* ignore */ }
    } else {
      this.connectWebSocket();
    }
  }

  /**
   * Did the hub that knows the pairing code vouch for this peer's keys?
   * 'forged': the vouch is present but wrong — the entry was altered in
   * transit, so the peer is dropped entirely.
   */
  private peerVerification(peer: PeerSummary): 'verified' | 'unverified' | 'forged' {
    const attestation = peer.attestation;
    const admitted = attestation === 'pake' || attestation === 'host';
    if (this.vouchKey && this.admission === 'pake') {
      if (peer.vouch === undefined) return 'unverified';
      const ok = verifyPeerVouch(this.vouchKey, {
        peerId: peer.peerId,
        publicKey: peer.device?.publicKey,
        identityKey: peer.device?.identityKey,
        attestation: attestation ?? 'legacy',
      }, peer.vouch);
      if (!ok) return 'forged';
      return admitted ? 'verified' : 'unverified';
    }
    if (this.admission === 'host') return admitted ? 'verified' : 'unverified';
    return 'unverified';
  }

  private identityCacheKey(peer: PeerSummary): string | null {
    const { identityKey, identitySig, publicKey } = peer.device ?? ({} as Partial<DeviceProfile>);
    return identityKey && identitySig ? `${identityKey}|${identitySig}|${publicKey}` : null;
  }

  /** The peer's identity key once its signature over the session key checked out. */
  private provenIdentity(peer: PeerSummary): string | undefined {
    const key = this.identityCacheKey(peer);
    return key && this.identityChecks.get(key) === true ? peer.device?.identityKey : undefined;
  }

  private matchesTransferPeerIdentity(
    candidate: PeerSummary,
    expectedPublicKey?: string,
    expectedIdentityKey?: string,
  ): boolean {
    const proven = this.provenIdentity(candidate);
    if (expectedIdentityKey) {
      if (proven) return proven === expectedIdentityKey;
      return !!expectedPublicKey && candidate.device.publicKey === expectedPublicKey;
    }
    if (expectedPublicKey) {
      return candidate.device.publicKey === expectedPublicKey;
    }
    return true;
  }

  private trustKeyFor(peer: PeerSummary): string {
    return this.provenIdentity(peer) ?? peer.device?.publicKey;
  }

  private isPeerTrusted(peer: PeerSummary): boolean {
    const identity = this.provenIdentity(peer);
    if (identity) return this.trustedPeerKeys.has(identity);
    // A peer that claims an identity we could not (yet) prove is not trusted
    // through its session key either.
    if (peer.device?.identityKey) return false;
    return this.trustedPeerKeys.has(peer.device?.publicKey);
  }

  private async checkPeerIdentity(peer: PeerSummary): Promise<boolean> {
    const key = this.identityCacheKey(peer);
    if (!key) return false;
    const cached = this.identityChecks.get(key);
    if (cached !== undefined) return cached;
    const ok = await verifyIdentityBinding(peer.device.identityKey!, peer.device.identitySig!, peer.device.publicKey);
    if (this.identityChecks.size > 256) this.identityChecks.delete(this.identityChecks.keys().next().value!);
    this.identityChecks.set(key, ok);
    if (ok && peer.device.deviceId && !this.knownIdentities[peer.device.deviceId]) {
      this.knownIdentities[peer.device.deviceId] = peer.device.identityKey!;
      this.persistKnownIdentities();
    }
    return ok;
  }

  private persistKnownIdentities(): void {
    try {
      const entries = Object.entries(this.knownIdentities).slice(-256);
      this.knownIdentities = Object.fromEntries(entries);
      this.storage?.setItem(`${this.storagePrefix}:knownIdentities`, JSON.stringify(this.knownIdentities));
    } catch {
      // ignore
    }
  }

  private syncPeers(incoming: PeerSummary[]): void {
    const nextPeers = incoming.filter((peer) => this.peerVerification(peer) !== 'forged');
    if (nextPeers.length !== incoming.length) {
      this.connectionNotice = 'A device entry failed verification and was ignored. Someone may be tampering with this network.';
    }
    this.peers = nextPeers;
    this.continuity.onPeersChanged(
      nextPeers.map((p) => ({
        peerId: p.peerId,
        publicKey: p.device.publicKey,
        deviceId: p.device.deviceId,
        identityKey: this.provenIdentity(p) ?? undefined,
        name: p.device.name,
      })),
    );
    for (const peer of nextPeers) {
      const key = this.identityCacheKey(peer);
      if (!key || this.identityChecks.has(key) || this.identityPending.has(key)) continue;
      this.identityPending.add(key);
      void this.checkPeerIdentity(peer).finally(() => { this.identityPending.delete(key); this.emit(); });
    }
    const activeIds = new Set(nextPeers.map((p) => p.peerId));
    for (const id of this.cryptoSessions.keys()) if (!activeIds.has(id)) {
      this.cryptoSessions.delete(id); this.cryptoKeyFingerprints.delete(id); this.peerRttMs.delete(id);
    }
    for (const sendState of this.outgoingStates.values()) {
      const acceptingPeerId = sendState.acceptingPeerId ?? sendState.session.peerId;
      const activePeer = nextPeers.find((peer) => peer.peerId === acceptingPeerId);
      const peerLost =
        !activePeer ||
        !this.matchesTransferPeerIdentity(activePeer, sendState.peerPublicKey, sendState.peerIdentityKey) ||
        (sendState.peerConnectedAt !== undefined && activePeer.connectedAt !== sendState.peerConnectedAt);
      if (peerLost) {
        if (sendState.acceptRejecter) {
          sendState.acceptRejecter(
            new TransferConnectionInterruptedError('Receiver disconnected while waiting for acceptance.'),
          );
        }
        for (const waiter of [...sendState.ackWaiters]) waiter();
        for (const waiter of [...sendState.completionAckWaiters]) waiter(null);
      }
    }

    // Clean up disconnected RTC peers
    for (const id of this.rtcPeers.keys()) {
      if (!activeIds.has(id)) {
        this.rtcChannels.get(id)?.close();
        this.rtcPeers.get(id)?.close();
        this.rtcChannels.delete(id);
        this.rtcPeers.delete(id);
      }
    }

    // Derive E2EE sessions eagerly so SAS verification codes appear immediately on the radar!
    for (const peer of nextPeers) {
      this.ensureCryptoSession(peer)
        .then(() => {
          this.sendControlMessage(peer.peerId, { kind: 'ping', ts: Date.now() }, false).catch(
            () => {}
          );
          // Deterministically warm up P2P WebRTC DataChannel from the lower-peerId side
          if (this.canUseWebRtc() && this.peerId < peer.peerId) {
            this.initiateWebRtcIfPossible(peer.peerId);
          }
          // Reconcile recent transfer history over E2EE so Android & MacBook always match
          this.syncHistoryWithPeer(peer).catch(() => {});
          // Flush any clipboard text or image copied shortly before this peer woke up / reconnected
          if (this.pendingAutoClipboard && this.autoClipboardSync) {
            this.flushAutoClipboard().catch(() => {});
          }
          if (this.pendingAutoClipboardImage && this.autoClipboardSync) {
            this.flushAutoClipboardImage().catch(() => {});
          }
          this.emit();
        })
        .catch(() => {});
    }

    this.emit();
  }

  private async ensureCryptoSession(peer: PeerSummary): Promise<PeerCryptoSession> {
    if (!this.keys) {
      throw new Error('Keys not initialized');
    }
    const existingFp = this.cryptoKeyFingerprints.get(peer.peerId);
    const existing = this.cryptoSessions.get(peer.peerId);
    if (existing && existingFp === peer.device.publicKey) {
      return existing;
    }

    // Stable verification code: over the identity keys when both are proven.
    const peerIdentity = (await this.checkPeerIdentity(peer)) ? peer.device.identityKey : undefined;
    const myIdentity = this.myDevice?.identityKey;
    const session = await derivePeerSession(
      this.keys.privateKey,
      this.keys.publicKeyB64,
      peer.device.publicKey,
      myIdentity && peerIdentity ? { mine: myIdentity, peer: peerIdentity } : undefined,
    );
    if (this.destroyed || !this.peers.some((current) => current.peerId === peer.peerId && current.device.publicKey === peer.device.publicKey)) {
      throw new Error('Peer changed while establishing encryption.');
    }
    this.cryptoSessions.set(peer.peerId, session);
    this.cryptoKeyFingerprints.set(peer.peerId, peer.device.publicKey);
    return session;
  }

  private async sendControlMessage(
    peerId: string,
    payload: ControlPayload,
    encrypt: boolean
  ): Promise<void> {
    if (!encrypt) {
      if (!this.sendServer({
        type: 'transfer-control',
        to: peerId,
        envelope: { encrypted: false, payload },
      })) {
        throw new TransferConnectionInterruptedError('Signaling relay is unavailable; transfer will resume.');
      }
      return;
    }

    const connection = this.ws;
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      if ('transferId' in payload && this.outgoingStates.has(payload.transferId)) {
        throw new TransferConnectionInterruptedError('Receiver disconnected; waiting to resume.');
      }
      throw new Error('Missing peer encryption session');
    }
    if ('transferId' in payload) {
      const transfer = this.transfers.find((item) => item.transferId === payload.transferId);
      const binding = transfer ? this.receiveOfferBindings.get(transfer) : undefined;
      const sendState = this.outgoingStates.get(payload.transferId);
      const recvState = this.incomingStates.get(payload.transferId);
      const boundPublicKey = sendState?.peerPublicKey ?? recvState?.peerPublicKey ?? binding?.publicKey;
      const boundIdentityKey = sendState?.peerIdentityKey ?? recvState?.peerIdentityKey ?? binding?.identityKey;
      if ((boundPublicKey || boundIdentityKey) &&
          !this.matchesTransferPeerIdentity(peer, boundPublicKey, boundIdentityKey)) {
        throw new Error('Transfer peer identity changed.');
      }
    }
    const session = await this.ensureCryptoSession(peer);
    const envelope = await encryptControlPayload(session.aesKey, payload);
    if (this.destroyed || this.ws !== connection ||
        !this.peers.some((current) => current.peerId === peerId && current.device.publicKey === peer.device.publicKey)) {
      throw new TransferConnectionInterruptedError('Connection or peer identity changed while encrypting control.');
    }
    if (!this.sendServer({
      type: 'transfer-control',
      to: peerId,
      envelope,
    })) {
      throw new TransferConnectionInterruptedError('Signaling relay is unavailable; transfer will resume.');
    }
  }

  private async handleIncomingControl(
    fromPeerId: string,
    envelope:
      | { encrypted: true; iv: string; ciphertext: string }
      | { encrypted: false; payload: ControlPayload }
  ): Promise<void> {
    const connection = this.ws;
    const peer = this.peers.find((p) => p.peerId === fromPeerId);
    let payload: ControlPayload;

    if (envelope.encrypted) {
      if (!peer) return;
      const session = await this.ensureCryptoSession(peer);
      payload = await decryptControlPayload(session.aesKey, envelope);
      if (this.destroyed || this.ws !== connection ||
          !this.peers.some((current) => current.peerId === fromPeerId && current.device.publicKey === peer.device.publicKey)) return;
      if ('transferId' in payload) {
        const send = this.outgoingStates.get(payload.transferId);
        const recv = this.incomingStates.get(payload.transferId);
        if (send && (send.session.peerId !== fromPeerId || send.peerPublicKey !== peer.device.publicKey)) return;
        if (recv && recv.peerPublicKey !== peer.device.publicKey) return;
      }
    } else {
      // SECURITY: only the unauthenticated liveness ping/pong may travel in
      // plaintext. Everything else (offers, clipboard, accept/decline/cancel,
      // history) must prove possession of the ECDH session key via AES-GCM,
      // otherwise anyone able to relay a frame could forge it.
      if (envelope.payload?.kind !== 'ping' && envelope.payload?.kind !== 'pong') return;
      payload = envelope.payload;
    }

    if (await this.continuity.handleControl(fromPeerId, payload)) return;

    switch (payload.kind) {
      case 'ping': {
        await this.sendControlMessage(fromPeerId, { kind: 'pong', ts: payload.ts }, false);
        break;
      }

      case 'pong': {
        const rtt = Math.max(1, Date.now() - payload.ts);
        this.peerRttMs.set(fromPeerId, rtt);
        this.emit();
        break;
      }

      case 'notification-beam': {
        if (typeof payload.notificationId !== 'string') break;
        if (!this.notificationSharing) break;
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        const body = typeof payload.body === 'string' ? payload.body.trim() : '';
        const appName = typeof payload.appName === 'string' ? payload.appName.trim() : 'AirBridge';
        const packageName = typeof payload.packageName === 'string' ? payload.packageName : '';
        if (!title && !body) break;

        const notifItem: NotificationBeamItem = {
          notificationId: payload.notificationId,
          peerId: fromPeerId,
          peerName: peer?.device.name || 'Peer',
          title,
          body,
          appName,
          packageName,
          timestamp: payload.timestamp || Date.now(),
        };

        this.opts.onIncomingNotification?.(notifItem);
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification(`${appName}: ${title}`, { body });
          } catch {
            // ignore notification error
          }
        }
        break;
      }

      case 'clipboard-beam': {
        // Support both legacy text-only and new image-capable payloads
        if (typeof payload.beamId !== 'string') break;
        if (!this.clipboardReceiveEnabled) break;
        const hasText = typeof payload.text === 'string' && payload.text.trim().length > 0;
        const hasImage = typeof payload.imageDataUrl === 'string' && isValidClipboardImageDataUrl(payload.imageDataUrl);
        if (!hasText && !hasImage) break;
        // Legacy guard: text length check
        if (hasText && payload.text!.length > MAX_CLIPBOARD_TEXT) break;
        if (hasImage && payload.imageDataUrl!.length > MAX_CLIPBOARD_IMAGE_DATAURL_LENGTH) break;
        // Derive a unified key for dedup/throttle: text or image prefix
        const dedupKey = hasImage
          ? await sha256Hex([new TextEncoder().encode(payload.imageDataUrl!)])
          : payload.text!;
        if (!this.clipboardReceiveEnabled || this.destroyed || this.ws !== connection ||
            !this.peers.some((current) => current.peerId === fromPeerId && current.device.publicKey === peer?.device.publicKey)) break;
        if (this.seenBeamIds.has(payload.beamId)) break;
        const now = Date.now();
        if (
          this.lastIncomingClip &&
          this.lastIncomingClip.peerId === fromPeerId &&
          this.lastIncomingClip.text === dedupKey &&
          now - this.lastIncomingClip.ts < 1_500
        ) {
          break;
        }
        this.seenBeamIds.add(payload.beamId);
        if (this.seenBeamIds.size > 200) {
          const oldest = this.seenBeamIds.values().next().value;
          if (oldest) this.seenBeamIds.delete(oldest);
        }
        this.lastIncomingClip = { peerId: fromPeerId, text: dedupKey, ts: now };
        // Track hash/text to prevent feedback loops across host and peer clipboards
        if (hasText) this.lastSyncedClipboardText = payload.text!;
        if (hasImage) {
          this.lastSyncedClipboardText = payload.imageDataUrl!.slice(0, 1024);
          this.lastSyncedClipboardImageHash = dedupKey;
          this.clipboardImagesReceived += 1;
        }

        // Also update the host OS clipboard via loopback so pasting works immediately
        // in any app even if this browser tab is unfocused.
        if (this.opts.writeHostClipboard !== false && this.localDaemon.clipboardBridge) {
          if (hasImage) {
            this.sendServer({
              type: 'set-host-clipboard',
              imageDataUrl: payload.imageDataUrl,
              imageName: payload.imageName,
            });
          } else if (hasText) {
            this.sendServer({ type: 'set-host-clipboard', text: payload.text! });
          }
        }

        const session = this.cryptoSessions.get(fromPeerId);
        const isImageContent = payload.contentType === 'image' || hasImage;
        const rawContentType = isImageContent ? 'image' : (payload.contentType ?? 'text');
        const safeContentType =
          rawContentType === 'url' && (!hasText || !isSafeHttpUrl(payload.text!))
            ? 'text'
            : rawContentType;
        const item: ClipboardBeamItem = {
          beamId: payload.beamId,
          peerId: fromPeerId,
          peerName: peer?.device.name ?? 'Paired Device',
          direction: 'incoming',
          text: hasText ? payload.text! : (hasImage ? payload.imageDataUrl! : ''),
          imageDataUrl: hasImage ? payload.imageDataUrl : undefined,
          imageName: payload.imageName,
          contentType: safeContentType,
          timestamp: payload.timestamp,
          sasCode: session?.sasCode ?? '··· ···',
        };
        this.clipboardItems = [item, ...this.clipboardItems];
        this.pruneClipboardHistory();
        this.persistClipboardHistory();
        this.emit();
        this.opts.onIncomingClipboard?.(item);
        break;
      }

      case 'history-sync': {
        this.mergeSyncedHistory(fromPeerId, peer, payload.transfers);
        break;
      }

      case 'transfer-offer': {
        if (typeof payload.transferId !== 'string' || !/^[0-9a-f]{16}$/.test(payload.transferId)) break;
        // Validate BEFORE allocating per-chunk arrays: a hostile manifest
        // previously could declare billions of chunks and exhaust memory
        // before the user ever saw (let alone accepted) the offer.
        if (!isValidFileManifest(payload.files, payload.totalBytes)) break;
        if (peer && this.identityCacheKey(peer)) {
          await this.checkPeerIdentity(peer);
        }
        const existingReceive = this.incomingStates.get(payload.transferId);
        if (existingReceive) {
          const samePeer =
            existingReceive.session.peerId === fromPeerId ||
            Boolean(
              existingReceive.session.peerDeviceId &&
              peer?.device.deviceId === existingReceive.session.peerDeviceId,
            );
          const sameFiles = existingReceive.session.totalBytes === payload.totalBytes &&
            sameManifest(existingReceive.session.files, payload.files);
          if (!samePeer || !sameFiles || !peer ||
              !this.matchesTransferPeerIdentity(peer, existingReceive.peerPublicKey, existingReceive.peerIdentityKey)) break;
          existingReceive.peerPublicKey = peer.device.publicKey;
          existingReceive.peerIdentityKey = this.provenIdentity(peer) ?? existingReceive.peerIdentityKey;
          existingReceive.session.peerId = fromPeerId;
          if (peer) {
            existingReceive.session.peerDeviceId = peer.device.deviceId;
            existingReceive.session.peerName = peer.device.name;
            existingReceive.session.peerPlatform = peer.device.platform;
          }
          if (existingReceive.session.status === 'transferring') {
            // Pause chunk intake while reconciling durable state. Any in-flight
            // frame ignored in this short window will be requested again from
            // the freshly computed resume point.
            existingReceive.session.status = 'connecting';
            this.emit();
            try {
              const resume = await this.getReceiveResume(existingReceive);
              if (this.incomingStates.get(payload.transferId) !== existingReceive ||
                  existingReceive.session.status !== 'connecting' || this.ws !== connection ||
                  !this.peers.some((current) => current.peerId === fromPeerId &&
                    this.matchesTransferPeerIdentity(current, existingReceive.peerPublicKey, existingReceive.peerIdentityKey))) break;
              existingReceive.session.status = 'transferring';
              this.emit();
              await this.sendControlMessage(
                fromPeerId,
                {
                  kind: 'transfer-accept',
                  transferId: payload.transferId,
                  preferredTransport: this.canUseWebRtc() ? 'webrtc' : 'ws-relay',
                  ...(Object.keys(resume.resumeFromChunks).length
                    ? { resumeFromChunks: resume.resumeFromChunks }
                    : {}),
                  resumeBytesTotal: resume.bytes,
                },
                true,
              );
            } catch (error) {
              if (this.incomingStates.get(payload.transferId) === existingReceive &&
                  existingReceive.session.status === 'connecting') {
                existingReceive.session.status = 'transferring';
                this.emit();
              }
              throw error;
            }
          }
          break;
        }
        const terminalReceive = this.transfers.find(
          (transfer) => transfer.transferId === payload.transferId && transfer.direction === 'incoming',
        );
        if (terminalReceive && isTerminalTransferStatus(terminalReceive.status)) {
          const binding = this.receiveOfferBindings.get(terminalReceive);
          if (!binding || !peer ||
              !this.matchesTransferPeerIdentity(peer, binding.publicKey, binding.identityKey) ||
              binding.totalBytes !== payload.totalBytes || !sameManifest(binding.files, payload.files)) break;
          if (terminalReceive.status === 'completed') {
            const resumeFromChunks = Object.fromEntries(
              terminalReceive.files.map((file) => [file.index, file.totalChunks]),
            );
            await this.sendControlMessage(
              fromPeerId,
              {
                kind: 'transfer-accept',
                transferId: payload.transferId,
                preferredTransport: 'ws-relay',
                resumeFromChunks,
                resumeBytesTotal: terminalReceive.totalBytes,
              },
              true,
            );
            await this.sendControlMessage(
              fromPeerId,
              { kind: 'transfer-complete-ack', transferId: payload.transferId, verified: true },
              true,
            );
            break;
          }
          if (terminalReceive.status === 'declined' || terminalReceive.status === 'cancelled') break;
          // An incomplete or hash-failed transfer is offered again normally;
          // the receiver must accept the retry instead of claiming completion.
        }
        if (this.incomingStates.size + this.outgoingStates.size >= 16) {
          await this.sendControlMessage(fromPeerId, {
            kind: 'transfer-decline', transferId: payload.transferId,
          }, true);
          break;
        }
        const session = this.cryptoSessions.get(fromPeerId);
        const view: TransferSessionView = {
          transferId: payload.transferId,
          peerId: fromPeerId,
          peerDeviceId: peer?.device.deviceId,
          pairCode: this.pairCode || undefined,
          peerName: peer?.device.name ?? 'Nearby Device',
          peerPlatform: peer?.device.platform ?? 'unknown',
          sasCode: session?.sasCode ?? '··· ···',
          direction: 'incoming',
          status: 'pending-accept',
          transport: this.isRtcOpen(fromPeerId) ? 'webrtc' : 'ws-relay',
          files: payload.files,
          totalBytes: payload.totalBytes,
          transferredBytes: 0,
          speedBytesPerSec: 0,
          etaSeconds: null,
          startedAt: Date.now(),
          receivedFiles: [],
        };

        const recvState: InternalReceiveState = {
          session: view,
          fileChunks: payload.files.map(() => []),
          receivedChunkCounts: payload.files.map(() => 0),
          nextContiguousChunks: payload.files.map(() => 0),
          lastAckedChunks: payload.files.map(() => -1),
          bytesReceived: 0,
          lastSpeedTs: Date.now(),
          lastSpeedBytes: 0,
          fileCompletePayloads: new Map(),
          finalizedFiles: new Set(),
          peerPublicKey: peer?.device.publicKey,
          peerIdentityKey: peer ? this.provenIdentity(peer) : undefined,
          transferCompleteReceived: false,
          finalizeChain: Promise.resolve(),
          inFlightChunks: new Set(),
        };

        if (peer) this.receiveOfferBindings.set(view, {
          publicKey: peer.device.publicKey,
          identityKey: this.provenIdentity(peer),
          files: payload.files.map(stripPreviewDataUrl),
          totalBytes: payload.totalBytes,
        });
        this.incomingStates.set(payload.transferId, recvState);
        this.transfers = [
          view,
          ...this.transfers.filter((t) => t.transferId !== payload.transferId),
        ];
        this.sortTransfers();
        this.emit();
        this.opts.onIncomingTransfer?.(view);

        // Auto-accept if sender is marked as a Trusted Device (or autoAcceptAll enabled)
        const isTrusted =
          this.opts.autoAcceptAll ||
          (peer ? this.isPeerTrusted(peer) : false);
        if (isTrusted) {
          await this.acceptIncomingTransfer(payload.transferId);
        }
        break;
      }

      case 'transfer-accept': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState && sendState.session.peerId === fromPeerId) {
          sendState.resumeFromChunks = normalizeResumeChunks(
            payload.resumeFromChunks,
            sendState.session.files,
          );
          const calculatedResumeBytes = bytesForResumeChunks(
            sendState.session.files,
            sendState.resumeFromChunks,
          );
          sendState.resumeBytesTotal =
            typeof payload.resumeBytesTotal === 'number' &&
            Number.isInteger(payload.resumeBytesTotal) &&
            payload.resumeBytesTotal >= calculatedResumeBytes &&
            payload.resumeBytesTotal <= sendState.session.totalBytes
              ? payload.resumeBytesTotal
              : calculatedResumeBytes;
          sendState.session.transferredBytes = sendState.resumeBytesTotal;
          sendState.lastAckedBytes = sendState.resumeBytesTotal;
          sendState.lastAckAt = Date.now();
          sendState.lastSpeedTs = Date.now();
          sendState.lastSpeedBytes = sendState.resumeBytesTotal;
          sendState.sentGlobalChunks = 0;
          sendState.ackedGlobalChunks = 0;
          sendState.sentChunksByFile = sendState.session.files.map(() => 0);
          sendState.ackedChunksByFile = sendState.session.files.map(
            (file) => sendState.resumeFromChunks?.[file.index] ?? 0,
          );
          const resolve = sendState.acceptResolver;
          sendState.acceptResolver = undefined;
          sendState.acceptRejecter = undefined;
          sendState.acceptingPeerId = undefined;
          resolve?.(payload.preferredTransport);
          this.emit();
        }
        break;
      }

      case 'transfer-decline': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState && sendState.session.peerId !== fromPeerId) break;
        if (sendState) {
          sendState.cancelled = true;
          sendState.session.status = 'declined';
          sendState.session.completedAt = Date.now();
          sendState.acceptRejecter?.(new Error('Declined by recipient'));
          this.outgoingStates.delete(payload.transferId);
          this.sortTransfers();
          this.persistTransferHistory();
          this.emit();
        }
        break;
      }

      case 'transfer-cancel': {
        // Only the transfer's own peer may cancel it.
        {
          const s0 = this.outgoingStates.get(payload.transferId);
          const r0 = this.incomingStates.get(payload.transferId);
          if ((s0 && s0.session.peerId !== fromPeerId) || (r0 && r0.session.peerId !== fromPeerId)) break;
        }
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState) {
          sendState.cancelled = true;
          sendState.session.status = 'cancelled';
          sendState.session.completedAt = Date.now();
          sendState.acceptRejecter?.(new Error('Cancelled'));
          for (const w of sendState.ackWaiters.splice(0)) w();
          for (const resolve of sendState.completionAckWaiters.splice(0)) {
            resolve({ verified: false, reason: 'Transfer cancelled.' });
          }
          this.outgoingStates.delete(payload.transferId);
          this.sortTransfers();
          this.persistTransferHistory();
          this.emit();
        }
        const recvState = this.incomingStates.get(payload.transferId);
        if (recvState) {
          if (recvState.fallbackTimer) clearTimeout(recvState.fallbackTimer);
          recvState.session.status = 'cancelled';
          recvState.session.completedAt = Date.now();
          this.incomingStates.delete(payload.transferId);
          await this.disposeReceivers(recvState, true);
          this.sortTransfers();
          this.persistTransferHistory();
          this.emit();
        }
        break;
      }

      case 'chunk-ack': {
        this.applyChunkAck(fromPeerId, {
          transferId: payload.transferId,
          fileIndex: payload.fileIndex,
          ackedChunkIndex: payload.ackedChunkIndex,
          bytesReceivedTotal: payload.bytesReceivedTotal,
        });
        break;
      }

      case 'transfer-complete-ack': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (
          !sendState ||
          sendState.session.peerId !== fromPeerId ||
          typeof payload.verified !== 'boolean'
        ) break;
        const result = {
          verified: payload.verified,
          reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 512) : undefined,
        };
        sendState.completionResult = result;
        const waiters = sendState.completionAckWaiters.splice(0);
        for (const waiter of waiters) waiter(result);
        if (!result.verified) {
          sendState.session.status = 'error';
          sendState.session.errorMessage = result.reason || 'The receiver could not verify this transfer.';
          sendState.session.completedAt = Date.now();
          this.outgoingStates.delete(payload.transferId);
          this.sortTransfers();
          this.persistTransferHistory();
        }
        this.emit();
        break;
      }

      case 'file-complete': {
        const recvState = this.incomingStates.get(payload.transferId);
        if (!recvState || recvState.session.peerId !== fromPeerId) break;
        if (!Number.isInteger(payload.fileIndex) || payload.fileIndex < 0 || payload.fileIndex >= recvState.session.files.length) break;
        if (payload.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(payload.sha256)) break;
        recvState.fileCompletePayloads.set(payload.fileIndex, {
          sha256: payload.sha256,
        });
        recvState.diskReceivers?.get(payload.fileIndex)?.markComplete();
        recvState.fileSystemReceivers?.get(payload.fileIndex)?.markComplete();
        void this.scheduleReceiveFinalization(payload.transferId, false).catch(() => {});
        break;
      }

      case 'transfer-complete': {
        const recvState = this.incomingStates.get(payload.transferId);
        if (!recvState) {
          const terminalReceive = this.transfers.find(
            (transfer) => transfer.transferId === payload.transferId && transfer.direction === 'incoming',
          );
          const binding = terminalReceive && this.receiveOfferBindings.get(terminalReceive);
          if (peer && binding && this.identityCacheKey(peer)) {
            await this.checkPeerIdentity(peer);
          }
          const samePeer = binding && peer && this.matchesTransferPeerIdentity(peer, binding.publicKey, binding.identityKey);
          if (terminalReceive && samePeer && isTerminalTransferStatus(terminalReceive.status) &&
              terminalReceive.status !== 'declined' && terminalReceive.status !== 'cancelled') {
            await this.sendControlMessage(
              fromPeerId,
              {
                kind: 'transfer-complete-ack',
                transferId: payload.transferId,
                verified: terminalReceive.status === 'completed',
                ...(terminalReceive.status === 'error'
                  ? { reason: terminalReceive.errorMessage || 'The previous receive did not verify.' }
                  : {}),
              },
              true,
            ).catch(() => {});
          }
          break;
        }
        if (recvState.session.peerId !== fromPeerId) break;
        recvState.transferCompleteReceived = true;
        if (!recvState.fallbackTimer) {
          recvState.fallbackTimer = setTimeout(() => {
            this.fallbackTimerFires++;
            this.scheduleReceiveFinalization(payload.transferId, true).catch(() => {});
          }, 4_000);
        }
        void this.scheduleReceiveFinalization(payload.transferId, false).catch(() => {});
        break;
      }
    }
  }

  private applyChunkAck(
    fromPeerId: string,
    ack: { transferId: string; fileIndex: number; ackedChunkIndex: number; bytesReceivedTotal?: number },
  ): void {
    const sendState = this.outgoingStates.get(ack.transferId);
    if (!sendState || sendState.session.peerId !== fromPeerId) return;
    if (!Number.isInteger(ack.fileIndex) || ack.fileIndex < 0 || ack.fileIndex >= sendState.session.files.length) return;
    const file = sendState.session.files[ack.fileIndex];
    if (
      !file ||
      !Number.isInteger(ack.ackedChunkIndex) ||
      ack.ackedChunkIndex < 0 ||
      ack.ackedChunkIndex >= file.totalChunks
    ) return;
    if (
      ack.bytesReceivedTotal !== undefined &&
      (!Number.isInteger(ack.bytesReceivedTotal) ||
        ack.bytesReceivedTotal < 0 ||
        ack.bytesReceivedTotal > sendState.session.totalBytes)
    ) return;

    const receiverPrefix = ack.ackedChunkIndex + 1;
    const resumePrefix = sendState.resumeFromChunks?.[ack.fileIndex] ?? 0;
    const sentPrefix = resumePrefix + (sendState.sentChunksByFile[ack.fileIndex] ?? 0);
    // ACKs are per-file. Treating a later file's ACK as proof that all
    // earlier files were durable allowed multi-file sends to release
    // the window early and get ahead of the receiver.
    if (receiverPrefix > sentPrefix) return;

    const previousAckedChunks = sendState.ackedGlobalChunks;
    sendState.ackedChunksByFile[ack.fileIndex] = Math.max(
      sendState.ackedChunksByFile[ack.fileIndex] ?? resumePrefix,
      receiverPrefix,
    );
    const newlyAcked = countNewlyAcknowledgedChunks(
      sendState.ackedChunksByFile,
      sendState.resumeFromChunks,
    );
    sendState.ackedGlobalChunks = Math.min(sendState.sentGlobalChunks, newlyAcked);

    const now = Date.now();
    const previousConfirmedBytes = sendState.session.transferredBytes;
    const inferredConfirmed = sendState.session.files.reduce(
      (sum, f, idx) => sum + Math.min(f.size, (sendState.ackedChunksByFile[idx] ?? 0) * f.chunkSize),
      0,
    );
    const confirmedBytes = Math.max(
      previousConfirmedBytes,
      Math.min(
        sendState.session.totalBytes,
        ack.bytesReceivedTotal !== undefined ? ack.bytesReceivedTotal : inferredConfirmed,
      ),
    );
    if (confirmedBytes > sendState.lastAckedBytes) {
      const elapsed = Math.max((now - sendState.lastSpeedTs) / 1000, 0.001);
      const instant = (confirmedBytes - sendState.lastSpeedBytes) / elapsed;
      sendState.session.speedBytesPerSec =
        sendState.session.speedBytesPerSec === 0
          ? instant
          : sendState.session.speedBytesPerSec * 0.65 + instant * 0.35;
      sendState.lastAckedBytes = confirmedBytes;
      sendState.lastSpeedBytes = confirmedBytes;
      sendState.lastSpeedTs = now;
      sendState.session.transferredBytes = confirmedBytes;
      const remaining = Math.max(0, sendState.session.totalBytes - confirmedBytes);
      sendState.session.etaSeconds =
        sendState.session.speedBytesPerSec > 1024
          ? Math.ceil(remaining / sendState.session.speedBytesPerSec)
          : null;
    }
    if (
      sendState.ackedGlobalChunks > previousAckedChunks ||
      confirmedBytes > previousConfirmedBytes
    ) {
      sendState.lastAckAt = now;
    }
    const waiters = sendState.ackWaiters.splice(0, sendState.ackWaiters.length);
    for (const w of waiters) w();
    this.emit();
  }

  private scheduleReceiveFinalization(transferId: string, forceFallback: boolean): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState) return Promise.resolve();

    const next = recvState.finalizeChain
      .then(() => this.incomingStates.get(transferId) === recvState
        ? this.runReceiveFinalization(transferId, forceFallback) : undefined)
      .catch(() => {});
    recvState.finalizeChain = next;
    return next;
  }

  private async runReceiveFinalization(
    transferId: string,
    forceFallback: boolean
  ): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState) return;

    if (recvState.inFlightChunks.size > 0) {
      await Promise.allSettled([...recvState.inFlightChunks]);
      if (this.incomingStates.get(transferId) !== recvState) return;
    }

    const totalFiles = recvState.session.files.length;
    const finalizeStartMs = Date.now();
    let finalizedAnyFile = false;
    let hadDiskError = false;
    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
      if (recvState.finalizedFiles.has(fileIndex)) continue;

      const completeMeta = recvState.fileCompletePayloads.get(fileIndex);
      if (!completeMeta && !forceFallback) continue;

      const meta = recvState.session.files[fileIndex];
      if (!meta) continue;
      if (!completeMeta?.sha256 || !/^[0-9a-f]{64}$/.test(completeMeta.sha256)) {
        if (forceFallback) {
          hadDiskError = true;
          recvState.session.errorMessage = `Missing SHA-256 digest for ${meta.name}. The file was not saved.`;
          this.recordTransferError(transferId, 'finalize-missing-sha256', recvState.session.errorMessage);
        }
        continue;
      }

      const diskReceiver = recvState.diskReceivers?.get(fileIndex);
      const fsReceiver = recvState.fileSystemReceivers?.get(fileIndex);
      const streamReceiver = diskReceiver ?? fsReceiver;
      if (streamReceiver) {
        // Wait for any active or queued disk/FSA chunk writes to drain before
        // deciding whether all chunks arrived or evaluating forceFallback.
        await streamReceiver.waitIdle();
        await Promise.resolve();
        if (this.incomingStates.get(transferId) !== recvState) return;
      }

      const allChunksArrived =
        meta.size === 0 ||
        recvState.receivedChunkCounts[fileIndex] >= meta.totalChunks ||
        (streamReceiver ? streamReceiver.getStoredCount() >= meta.totalChunks : false);
      if (!allChunksArrived) {
        // A lost file-complete message may justify a fallback attempt, but
        // never invent missing chunks: that used to save a truncated video.
        if (forceFallback) {
          hadDiskError = true;
          recvState.session.errorMessage = `Transfer incomplete: ${meta.name} is missing chunks.`;
          this.recordTransferError(transferId, 'finalize-incomplete', recvState.session.errorMessage);
        }
        continue;
      }

      if (streamReceiver) {
        const receiver = streamReceiver;
        // Daemon publication and ordered FSA writes verify before commit.
        // Out-of-order FSA writes use a bounded readback hash after close and
        // remove a mismatched file; existing files are never overwritten.
        receiver.setExpectedSha256(completeMeta?.sha256);
        const diskResult = await receiver.finalizeIfReady(forceFallback);
        if (this.incomingStates.get(transferId) !== recvState) return;
        if (!diskResult) {
          const receiverError = receiver.getError();
          // A null result can simply mean "chunks are still in flight" on the
          // normal path. Only a real write/verification error (or the final
          // fallback attempt) is allowed to throw the partial away.
          if (receiverError || forceFallback) {
            await receiver.discard().catch(() => {});
            if (this.incomingStates.get(transferId) !== recvState) return;
            hadDiskError = true;
            recvState.session.errorMessage =
              receiverError || 'The receiver could not finalize this file.';
            this.recordTransferError(transferId, 'finalize-disk', recvState.session.errorMessage);
          }
          continue;
        }
        const verified = completeMeta?.sha256
          ? diskResult.sha256 === completeMeta.sha256
          : allChunksArrived;
        if (!verified) {
          await receiver.discard().catch(() => {});
          if (this.incomingStates.get(transferId) !== recvState) return;
          hadDiskError = true;
          recvState.session.errorMessage =
            `SHA-256 verification failed for ${meta.name}. The file was not saved.`;
          this.recordTransferError(transferId, 'finalize-sha256', recvState.session.errorMessage);
          continue;
        }
        recvState.session.receivedFiles.push({
          index: fileIndex,
          name: meta.name,
          relativePath: meta.relativePath,
          size: meta.size,
          mimeType: meta.mimeType,
          chunks: [],
          blobUrl: undefined,
          sha256: diskResult.sha256,
          verified: true,
          savedToMacPath: diskReceiver ? diskResult.savedPath : undefined,
          savedToDiskPath: fsReceiver ? diskResult.savedPath : undefined,
        });
        recvState.session.receivedFiles.sort((a, b) => a.index - b.index);
        recvState.finalizedFiles.add(fileIndex);
        finalizedAnyFile = true;
        this.emit();
        continue;
      }

      const rawChunks = recvState.fileChunks[fileIndex] ?? [];
      const cleanChunks: Uint8Array[] = new Array(meta.totalChunks);
      for (let i = 0; i < meta.totalChunks; i++) {
        cleanChunks[i] = rawChunks[i] ?? new Uint8Array(0);
      }

      const computedHash = await sha256Hex(cleanChunks);
      if (this.incomingStates.get(transferId) !== recvState) return;

      const verified = completeMeta?.sha256
        ? computedHash === completeMeta.sha256
        : allChunksArrived;
      if (!verified) {
        // Do not create a Blob, auto-save to Downloads, or expose a record:
        // a hash mismatch means these bytes are not the sender's file.
        hadDiskError = true;
        recvState.session.errorMessage =
          `SHA-256 verification failed for ${meta.name}. The file was not saved.`;
        this.recordTransferError(transferId, 'finalize-sha256', recvState.session.errorMessage);
        continue;
      }

      let blobUrl: string | undefined;
      if (
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function' &&
        typeof document !== 'undefined'
      ) {
        const blob = new Blob(cleanChunks as BlobPart[], { type: meta.mimeType });
        blobUrl = URL.createObjectURL(blob);
      }

      let savedToMacPath: string | undefined;
      if (
        this.localDaemon.enabled &&
        this.localDaemon.autoSaveToDownloads &&
        typeof fetch === 'function'
      ) {
        try {
          const blob = new Blob(cleanChunks as BlobPart[], { type: 'application/octet-stream' });
          const resp = await fetch(`${this.apiBaseUrl()}/api/daemon/save`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-AirBridge-Filename': encodeURIComponent(meta.name),
              'X-AirBridge-Sender': encodeURIComponent(recvState.session.peerName),
            },
            body: blob,
          });
          if (resp.ok) {
            const json = (await resp.json()) as { savedPath?: string };
            savedToMacPath = json.savedPath;
          }
        } catch {
          // fallback to standard browser download
        }
      }

      if (this.incomingStates.get(transferId) !== recvState) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }

      recvState.session.receivedFiles.push({
        index: fileIndex,
        name: meta.name,
        relativePath: meta.relativePath,
        size: meta.size,
        mimeType: meta.mimeType,
        chunks: cleanChunks,
        blobUrl,
        sha256: computedHash,
        verified: true,
        savedToMacPath,
      });
      recvState.session.receivedFiles.sort((a, b) => a.index - b.index);
      recvState.finalizedFiles.add(fileIndex);
      finalizedAnyFile = true;
      this.emit();
    }
    if (finalizedAnyFile) {
      this.lastFinalizeDurationMs = Math.max(0, Date.now() - finalizeStartMs);
    }

    if (recvState.transferCompleteReceived && this.incomingStates.get(transferId) === recvState) {
      let completionAck: { verified: boolean; reason?: string } | undefined;
      if (recvState.finalizedFiles.size === totalFiles) {
        if (recvState.fallbackTimer) {
          clearTimeout(recvState.fallbackTimer);
          recvState.fallbackTimer = undefined;
        }
        const failedFile = recvState.session.receivedFiles.find((file) => !file.verified);
        if (failedFile) {
          recvState.session.status = 'error';
          recvState.session.errorMessage = `SHA-256 verification failed for ${failedFile.name}.`;
          completionAck = { verified: false, reason: recvState.session.errorMessage };
        } else {
          recvState.session.transferredBytes = recvState.session.totalBytes;
          recvState.session.etaSeconds = 0;
          recvState.session.status = 'completed';
          completionAck = { verified: true };
        }
        recvState.session.completedAt = Date.now();
        this.incomingStates.delete(transferId);
        this.sortTransfers();
        this.persistTransferHistory();
        this.emit();
        if (completionAck.verified) this.opts.onTransferCompleted?.(recvState.session);
        const senderPeer = this.peers.find((p) => p.peerId === recvState.session.peerId);
        if (senderPeer) this.syncHistoryWithPeer(senderPeer).catch(() => {});
      } else if (hadDiskError) {
        if (recvState.fallbackTimer) {
          clearTimeout(recvState.fallbackTimer);
          recvState.fallbackTimer = undefined;
        }
        recvState.session.status = 'error';
        recvState.session.completedAt = Date.now();
        completionAck = {
          verified: false,
          reason: recvState.session.errorMessage || 'The receiver could not finalize all files.',
        };
        this.incomingStates.delete(transferId);
        await this.disposeReceivers(recvState, true);
        this.sortTransfers();
        this.persistTransferHistory();
        this.emit();
      }
      if (completionAck) {
        await this.sendControlMessage(
          recvState.session.peerId,
          {
            kind: 'transfer-complete-ack',
            transferId,
            ...completionAck,
          },
          true,
        ).catch(() => {});
      }
    }
  }

  private async handleIncomingEncryptedChunk(
    fromPeerId: string,
    innerPayload: Uint8Array,
    transport: TransportKind
  ): Promise<void> {
    const connection = this.ws;
    const decoded = decodeEncryptedChunkFrame(innerPayload);
    const recvState = this.incomingStates.get(decoded.transferId);
    if (!recvState || recvState.session.peerId !== fromPeerId ||
        !this.peers.some((peer) => peer.peerId === fromPeerId &&
          this.matchesTransferPeerIdentity(peer, recvState.peerPublicKey, recvState.peerIdentityKey))) return;
    // SECURITY: nothing is decrypted or stored before the user accepts the
    // transfer — a nearby stranger could otherwise fill device memory with
    // unsolicited "chunks" for an offer that is still awaiting consent.
    if (recvState.session.status !== 'transferring') return;
    const meta0 = recvState.session.files[decoded.fileIndex];
    if (!meta0 || !Number.isInteger(decoded.chunkIndex) || decoded.chunkIndex < 0 || decoded.chunkIndex >= meta0.totalChunks) return;

    const cryptoSession = this.cryptoSessions.get(fromPeerId);
    if (!cryptoSession) return;

    const declaredSize = meta0.size === 0 ? 0 : Math.min(meta0.chunkSize, meta0.size - decoded.chunkIndex * meta0.chunkSize);
    if (decoded.ciphertext.byteLength !== declaredSize + 16) return;

    let shouldFinalize = false;
    const task = (async () => {
      const plainBytes = await decryptBinaryChunk(
        cryptoSession.aesKey,
        decoded.iv,
        decoded.ciphertext
      );

      if (this.incomingStates.get(decoded.transferId) !== recvState || recvState.session.status !== 'transferring' ||
          this.ws !== connection || !this.peers.some((peer) => peer.peerId === fromPeerId &&
            this.matchesTransferPeerIdentity(peer, recvState.peerPublicKey, recvState.peerIdentityKey))) return;
      // Each chunk must be exactly the size the manifest promises for its slot,
      // sized by the sender's declared chunkSize (validated in the manifest).
      const declaredChunkSize =
        typeof meta0.chunkSize === 'number' && meta0.chunkSize > 0 ? meta0.chunkSize : CHUNK_SIZE;
      const expectedSize =
        meta0.size === 0
          ? 0
          : Math.min(declaredChunkSize, meta0.size - decoded.chunkIndex * declaredChunkSize);
      if (plainBytes.byteLength !== expectedSize) return;

      recvState.session.transport = transport;

      const fileIndex = decoded.fileIndex;
      const chunkIndex = decoded.chunkIndex;
      const diskReceiver = recvState.diskReceivers?.get(fileIndex);
      const fsReceiver = recvState.fileSystemReceivers?.get(fileIndex);
      const streamReceiver = diskReceiver ?? fsReceiver;
      if (streamReceiver) {
        const alreadyQueued = streamReceiver.hasReceived(chunkIndex);
        if (!alreadyQueued) streamReceiver.push(chunkIndex, plainBytes);
        // Queueing is not receiving: only durable bytes may advance progress or
        // release the sender's sliding window. This is the backpressure signal
        // that keeps a slow disk from accumulating an unbounded invisible queue.
        const stored = await streamReceiver.waitUntilStored(chunkIndex);
        if (!stored || this.incomingStates.get(decoded.transferId) !== recvState) return;
        if (!alreadyQueued) {
          recvState.receivedChunkCounts[fileIndex]++;
          recvState.bytesReceived += plainBytes.byteLength;
        }
      } else {
        let fileArr = recvState.fileChunks[fileIndex];
        if (!fileArr) {
          fileArr = [];
          recvState.fileChunks[fileIndex] = fileArr;
        }
        if (!fileArr[chunkIndex]) {
          fileArr[chunkIndex] = plainBytes;
          recvState.receivedChunkCounts[fileIndex]++;
          recvState.bytesReceived += plainBytes.byteLength;
        }
      }

      const meta = recvState.session.files[fileIndex];
      if (!meta) return;
      recvState.session.transferredBytes = recvState.bytesReceived;

      const isChunkStored = (index: number): boolean =>
        streamReceiver
          ? streamReceiver.hasStored(index)
          : Boolean(recvState.fileChunks[fileIndex]?.[index]);
      let nextContiguous = recvState.nextContiguousChunks[fileIndex];
      while (nextContiguous < meta.totalChunks && isChunkStored(nextContiguous)) {
        nextContiguous++;
      }
      recvState.nextContiguousChunks[fileIndex] = nextContiguous;
      const contiguousAck = nextContiguous - 1;
      const lastAck = recvState.lastAckedChunks[fileIndex];
      const ackNow = Date.now();
      const ackTimes = recvState.lastAckTimes ??= recvState.session.files.map(() => 0);
      const ackInterval = ackIntervalFor(meta.chunkSize);
      if (
        contiguousAck > lastAck &&
        (contiguousAck - lastAck >= ackInterval || nextContiguous === meta.totalChunks ||
          ackNow - ackTimes[fileIndex] >= ACK_MAX_DELAY_MS)
      ) {
        recvState.lastAckedChunks[fileIndex] = contiguousAck;
        ackTimes[fileIndex] = ackNow;
        // ACK only a contiguous durable prefix. Decrypts and writes can finish
        // out of order, so acknowledging an arbitrary completed chunk would
        // incorrectly release earlier chunks that are still in flight.
        const binaryAck =
          transport === 'ws-relay' && this.ws?.readyState === WebSocket.OPEN
            ? encodeBinarySackFrame({
                transferId: decoded.transferId,
                fileIndex,
                chunkIndex: contiguousAck,
              })
            : null;
        if (binaryAck && this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(wrapRoutedRelayFrame(fromPeerId, this.peerId, binaryAck));
          } catch {
            // Fall through cleanly if the socket closed concurrently
          }
        } else {
          void this.sendControlMessage(
            fromPeerId,
            {
              kind: 'chunk-ack',
              transferId: decoded.transferId,
              fileIndex,
              ackedChunkIndex: contiguousAck,
              bytesReceivedTotal: recvState.bytesReceived,
            },
            true
          ).catch(() => {});
        }
      }

      const fileStored = recvState.receivedChunkCounts[fileIndex] >= meta.totalChunks;
      const now = Date.now();
      const elapsed = (now - recvState.lastSpeedTs) / 1000;
      // Include the last chunk so batches of small files do not finish while the
      // receiver still displays 0 B/s merely because no 150 ms tick elapsed.
      if (elapsed >= 0.15 || fileStored) {
        const instant =
          (recvState.bytesReceived - recvState.lastSpeedBytes) / Math.max(elapsed, 0.001);
        recvState.session.speedBytesPerSec =
          recvState.session.speedBytesPerSec === 0
            ? instant
            : recvState.session.speedBytesPerSec * 0.65 + instant * 0.35;
        const remaining = Math.max(0, recvState.session.totalBytes - recvState.bytesReceived);
        recvState.session.etaSeconds =
          recvState.session.speedBytesPerSec > 1024
            ? Math.ceil(remaining / recvState.session.speedBytesPerSec)
            : null;
        recvState.lastSpeedTs = now;
        recvState.lastSpeedBytes = recvState.bytesReceived;
        this.emit();
      }

      if (
        fileStored &&
        (recvState.fileCompletePayloads.has(fileIndex) || recvState.transferCompleteReceived)
      ) {
        shouldFinalize = true;
      }
    })();

    recvState.inFlightChunks.add(task);
    try {
      await task;
    } finally {
      recvState.inFlightChunks.delete(task);
    }
    if (shouldFinalize) {
      await this.scheduleReceiveFinalization(decoded.transferId, false);
    }
  }

  // ==========================================================================
  // WebRTC P2P DataChannel Transport + Backpressure Helpers
  // ==========================================================================

  private canUseWebRtc(): boolean {
    if (this.opts.enableWebRtc === false) return false;
    return typeof RTCPeerConnection !== 'undefined';
  }

  private isRtcOpen(peerId: string): boolean {
    return this.rtcChannels.get(peerId)?.readyState === 'open';
  }

  private getOrCreatePeerConnection(peerId: string): RTCPeerConnection {
    const existing = this.rtcPeers.get(peerId);
    if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
      return existing;
    }

    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers ?? [],
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sendServer({
          type: 'rtc-signal',
          to: peerId,
          signal: { candidate: ev.candidate.toJSON() },
        });
      }
    };

    pc.ondatachannel = (ev) => {
      this.attachDataChannel(peerId, ev.channel);
    };

    pc.onconnectionstatechange = () => {
      this.emit();
    };

    this.rtcPeers.set(peerId, pc);
    return pc;
  }

  private attachDataChannel(peerId: string, dc: RTCDataChannel): void {
    const existing = this.rtcChannels.get(peerId);
    if (existing && existing !== dc) {
      existing.onopen = null;
      existing.onclose = null;
      existing.onmessage = null;
      try {
        existing.close();
      } catch {
        // ignore close error on replaced DataChannel
      }
    }
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    this.rtcChannels.set(peerId, dc);

    dc.onopen = () => {
      this.emit();
    };
    dc.onclose = () => {
      this.emit();
    };
    dc.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.handleIncomingEncryptedChunk(peerId, new Uint8Array(ev.data), 'webrtc').catch(
          (err: unknown) => {
            this.recordClientError('rtc-chunk', err);
          }
        );
      }
    };
  }

  private initiateWebRtcIfPossible(peerId: string): void {
    if (!this.canUseWebRtc()) return;
    if (this.isRtcOpen(peerId)) return;
    const existingPc = this.rtcPeers.get(peerId);
    if (existingPc && existingPc.signalingState !== 'stable') return;
    if (this.rtcChannels.has(peerId) && this.rtcChannels.get(peerId)?.readyState === 'connecting') {
      return;
    }

    const pc = this.getOrCreatePeerConnection(peerId);
    const dc = pc.createDataChannel('airbridge-warp', { ordered: true });
    this.attachDataChannel(peerId, dc);

    this.rtcMakingOffer.set(peerId, true);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        if (pc.localDescription) {
          this.sendServer({
            type: 'rtc-signal',
            to: peerId,
            signal: { description: pc.localDescription.toJSON() },
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        this.rtcMakingOffer.set(peerId, false);
      });
  }

  private async handleRtcSignal(
    fromPeerId: string,
    signal: Record<string, unknown>
  ): Promise<void> {
    if (!this.canUseWebRtc()) return;
    const pc = this.getOrCreatePeerConnection(fromPeerId);
    const polite = this.peerId > fromPeerId;

    if (signal.description) {
      const desc = signal.description as RTCSessionDescriptionInit;
      const offerCollision =
        desc.type === 'offer' &&
        (this.rtcMakingOffer.get(fromPeerId) || pc.signalingState !== 'stable');

      if (offerCollision && !polite) {
        return;
      }

      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pc.localDescription) {
          this.sendServer({
            type: 'rtc-signal',
            to: fromPeerId,
            signal: { description: pc.localDescription.toJSON() },
          });
        }
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate as RTCIceCandidateInit);
      } catch {
        // ignore benign late candidate errors
      }
    }
  }

  private waitForRtcChannel(peerId: string, timeoutMs: number): Promise<boolean> {
    if (this.isRtcOpen(peerId) || this.destroyed) return Promise.resolve(this.isRtcOpen(peerId));
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      let settled = false;
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.rtcWaitTimers.delete(timer);
        resolve(opened);
      };
      const timer = setInterval(() => {
        if (this.destroyed) {
          finish(false);
        } else if (this.isRtcOpen(peerId)) {
          finish(true);
        } else if (Date.now() - start >= timeoutMs) {
          finish(false);
        }
      }, 40);
      this.rtcWaitTimers.set(timer, () => finish(false));
    });
  }

  private async sendRtcBinaryWithBackpressure(peerId: string, frame: Uint8Array): Promise<void> {
    const dc = this.rtcChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') {
      throw new Error('RTCDataChannel closed');
    }
    // A 256 KiB chunk frame can exceed a browser's negotiated SCTP
    // maxMessageSize (256 KiB in some Chrome builds). Throwing here makes
    // the caller relay this chunk over WebSocket instead of killing the
    // channel mid-transfer.
    const maxMessageSize = this.rtcPeers.get(peerId)?.sctp?.maxMessageSize ?? 0;
    if (maxMessageSize > 0 && frame.byteLength > maxMessageSize) {
      throw new Error(`RTCDataChannel maxMessageSize ${maxMessageSize} < frame ${frame.byteLength}`);
    }
    while (dc.bufferedAmount > MAX_BUFFER_HIGH_WATER) {
      await new Promise<void>((resolve) => {
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(() => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        }, 100);
        dc.addEventListener('bufferedamountlow', onLow);
      });
      if (dc.readyState !== 'open') {
        throw new Error('RTCDataChannel closed');
      }
    }
    // send() copies into the SCTP queue synchronously — no extra copy here.
    dc.send(frame as Uint8Array<ArrayBuffer>);
  }

  private async sendWsRelayBinaryWithBackpressure(
    targetPeerId: string,
    innerFrame: Uint8Array
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new TransferConnectionInterruptedError('Signaling relay socket disconnected; resuming transfer.');
    }
    while (this.ws.bufferedAmount > MAX_BUFFER_HIGH_WATER) {
      if (this.ws.readyState !== WebSocket.OPEN) {
        throw new TransferConnectionInterruptedError('Signaling relay socket disconnected; resuming transfer.');
      }
      const rawSocket = (
        this.ws as unknown as {
          _socket?: {
            once?: (event: string, listener: () => void) => void;
            removeListener?: (event: string, listener: () => void) => void;
          };
        }
      )?._socket;
      const sock = rawSocket;
      const onceFn = sock?.once;
      if (sock && typeof onceFn === 'function') {
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const onDrain = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            const removeFn = sock.removeListener;
            if (typeof removeFn === 'function') {
              removeFn.call(sock, 'drain', onDrain);
            }
            resolve();
          }, 10);
          onceFn.call(sock, 'drain', onDrain);
        });
      } else {
        // Fast poll in browser environments where WebSocket exposes no drain event
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    const routed = wrapRoutedRelayFrame(targetPeerId, this.peerId, innerFrame);
    try {
      this.ws.send(routed);
    } catch {
      throw new TransferConnectionInterruptedError('Signaling relay socket disconnected; resuming transfer.');
    }
  }

  private sendServer(msg: ClientToServerMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private async syncHistoryWithPeer(peer: PeerSummary): Promise<void> {
    if (this.destroyed || this.connectionState !== 'connected') return;

    const relevant = this.transfers.filter((t) => {
      if (!isTerminalTransferStatus(t.status)) return false;
      if (peer.device.deviceId && t.peerDeviceId === peer.device.deviceId) {
        return true;
      }
      if (
        peer.discoveryScope === 'paired' &&
        (t.peerPlatform === peer.device.platform || t.peerName === peer.device.name)
      ) {
        return true;
      }
      if (t.peerName === peer.device.name && t.peerPlatform === peer.device.platform) {
        return true;
      }
      return false;
    });

    if (relevant.length === 0) return;

    const summaries: HistoricalTransferSummary[] = relevant.slice(0, 40).map((t) => ({
      transferId: t.transferId,
      peerDeviceId: t.peerDeviceId,
      peerName: this.myDevice?.name ?? 'Paired Device',
      peerPlatform: this.myDevice?.platform ?? 'unknown',
      direction: t.direction,
      status: t.status as HistoricalTransferSummary['status'],
      transport: t.transport,
      files: t.files.map(stripPreviewDataUrl),
      totalBytes: t.totalBytes,
      transferredBytes: t.transferredBytes,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      sasCode: t.sasCode,
    }));

    await this.sendControlMessage(
      peer.peerId,
      {
        kind: 'history-sync',
        transfers: summaries,
      },
      true
    );
  }

  private mergeSyncedHistory(
    fromPeerId: string,
    peer: PeerSummary | undefined,
    incomingSummaries: HistoricalTransferSummary[]
  ): void {
    if (!Array.isArray(incomingSummaries) || incomingSummaries.length === 0) return;
    let changed = false;

    for (const item of incomingSummaries) {
      if (!item || typeof item.transferId !== 'string' || !Array.isArray(item.files)) continue;
      if (!isTerminalTransferStatus(item.status)) continue;

      if (!isValidFileManifest(item.files, item.totalBytes)) continue;
      const localDirection: TransferDirection =
        item.direction === 'outgoing' ? 'incoming' : 'outgoing';
      const existingIdx = this.transfers.findIndex((t) => t.transferId === item.transferId);
      // A peer may only reconcile its own transfers — otherwise any peer
      // could cancel/complete another peer's live transfer by guessing its ID.
      if (existingIdx !== -1 && this.transfers[existingIdx].peerId !== fromPeerId) continue;

      if (existingIdx === -1) {
        const reconstructed: TransferSessionView = {
          transferId: item.transferId,
          peerId: fromPeerId,
          peerDeviceId: peer?.device.deviceId ?? item.peerDeviceId,
          pairCode: this.pairCode || undefined,
          peerName: peer?.device.name ?? item.peerName,
          peerPlatform: peer?.device.platform ?? item.peerPlatform,
          sasCode: item.sasCode || this.cryptoSessions.get(fromPeerId)?.sasCode || '··· ···',
          direction: localDirection,
          status: item.status,
          transport: item.transport,
          files: item.files,
          totalBytes: item.totalBytes,
          transferredBytes:
            item.status === 'completed' ? item.totalBytes : item.transferredBytes,
          speedBytesPerSec: 0,
          etaSeconds: item.status === 'completed' ? 0 : null,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
          receivedFiles: [],
        };
        this.transfers.push(reconstructed);
        changed = true;
      } else {
        const existing = this.transfers[existingIdx];
        const isLocalNonTerminal = !isTerminalTransferStatus(existing.status);
        const hasLiveSession =
          this.incomingStates.has(item.transferId) ||
          this.outgoingStates.has(item.transferId);

        // Live transfers have authenticated cancel/decline/completion controls.
        // Reconciliation must not dispose their storage or manufacture receipts.
        if (isLocalNonTerminal && !hasLiveSession && existing.direction === localDirection &&
            existing.totalBytes === item.totalBytes && sameManifest(existing.files, item.files)) {
          existing.status = item.status;
          existing.completedAt = item.completedAt ?? Date.now();
          if (item.status === 'completed') {
            existing.transferredBytes = existing.totalBytes;
            existing.etaSeconds = 0;
          }
          changed = true;
        }
      }
    }

    if (changed) {
      this.sortTransfers();
      this.persistTransferHistory();
      this.emit();
    }
  }

  private trimBufferedHistory(budget: number): void {
    let retained = 0;
    for (const transfer of this.transfers) {
      if (!isTerminalTransferStatus(transfer.status)) continue;
      const bytes = (transfer.receivedFiles ?? []).reduce((sum, file) =>
        sum + (file.chunks ?? []).reduce((total, chunk) => total + chunk.byteLength, 0), 0);
      if (retained + bytes <= budget) { retained += bytes; continue; }
      transfer.receivedFiles = transfer.receivedFiles.filter((file) => {
        if (!file.chunks.length) return true;
        if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
        file.blobUrl = undefined;
        file.chunks = [];
        return Boolean(file.savedToMacPath || file.savedToDiskPath);
      });
    }
  }

  private sortTransfers(): void {
    this.transfers.sort((a, b) => {
      const aActive = !isTerminalTransferStatus(a.status);
      const bActive = !isTerminalTransferStatus(b.status);
      if (aActive !== bActive) {
        return aActive ? -1 : 1;
      }
      const aTs = a.completedAt ?? a.startedAt;
      const bTs = b.completedAt ?? b.startedAt;
      return bTs - aTs;
    });
    const active = this.transfers.filter((transfer) => !isTerminalTransferStatus(transfer.status));
    const terminal = this.transfers.filter((transfer) => isTerminalTransferStatus(transfer.status));
    for (const old of terminal.slice(60)) {
      for (const file of old.receivedFiles ?? []) if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
    }
    this.transfers = [...active, ...terminal.slice(0, 60)];
    const reserved = [...this.incomingStates.values()].filter((receive) =>
      !receive.diskReceivers?.size && !receive.fileSystemReceivers?.size &&
      (receive.session.status === 'transferring' || receive.session.status === 'connecting'),
    ).reduce((sum, receive) => sum + receive.session.totalBytes, 0);
    this.trimBufferedHistory(Math.max(0, MAX_BROWSER_BUFFERED_BYTES - reserved));
  }

  private persistTransferHistory(): void {
    try {
      const storage = this.storage;
      if (storage) {
        const serializable = this.transfers
          .filter((t) => isTerminalTransferStatus(t.status))
          .slice(0, 50)
          .map((t) => ({
            ...t,
            files: t.files.map(stripPreviewDataUrl),
            receivedFiles: [],
          }));
        storage.setItem(
          `${this.storagePrefix}:transferHistory`,
          JSON.stringify(serializable)
        );
      }
    } catch {
      // ignore storage quota errors
    }
  }

  private pruneClipboardHistory(): void {
    // A count alone allowed fifty 5 MiB image data URLs (plus their JSON
    // copies) to accumulate. Keep a byte budget as well, admitting one large
    // newest item so an otherwise valid image still reaches the user.
    let chars = 0;
    this.clipboardItems = this.clipboardItems.filter((item, index) => {
      if (index >= 50) return false;
      const cost = item.text.length + (item.imageDataUrl?.length ?? 0);
      if (index > 0 && chars + cost > 8_000_000) return false;
      chars += cost;
      return true;
    });
  }

  private persistClipboardHistory(): void {
    try {
      const storage = this.storage;
      if (storage) {
        const serializable = this.clipboardItems
          .filter((c) => {
            // Do not stringify multi-megabyte images into synchronous
            // localStorage on every clipboard event (quota and UI stalls).
            if (c.contentType === 'image') return (c.imageDataUrl?.length ?? c.text.length) <= 128_000;
            return c.text.length <= 32_000;
          })
          .slice(0, 50);
        storage.setItem(
          `${this.storagePrefix}:clipboardHistory`,
          JSON.stringify(serializable)
        );
      }
    } catch {
      // ignore storage quota errors
    }
  }

  private persistPairCode(code: string): void {
    try {
      const storage = this.storage;
      if (storage && code) {
        storage.setItem(`${this.storagePrefix}:pairCode`, code);
      }
    } catch {
      // ignore
    }
  }

  private persistPeerId(peerId: string): void {
    if (!/^[0-9a-f]{16}$/.test(peerId)) return;
    try {
      this.storage?.setItem(`${this.storagePrefix}:peerId`, peerId);
    } catch {
      // Stable ids improve reconnect recovery, but are not required to connect.
    }
  }

  /**
   * Speeds are sampled from ACKs (sender) and stored chunks (receiver), but a
   * paused transfer emits neither. Refresh on a slow heartbeat so both devices
   * stop advertising a stale rate, drop an impossible ETA, and then recover a
   * clean baseline when bytes start moving again.
   */
  private refreshLiveTransferSpeeds(): void {
    if (this.destroyed) return;
    const now = Date.now();
    const liveIds = new Set<string>();
    let changed = false;

    for (const transfer of this.transfers) {
      if (transfer.status !== 'transferring') continue;
      const receiveState = this.incomingStates.get(transfer.transferId);
      const sendState = this.outgoingStates.get(transfer.transferId);
      if (transfer.direction === 'incoming' ? !receiveState : !sendState) continue;
      liveIds.add(transfer.transferId);

      const sample = this.speedProgress.get(transfer.transferId);
      if (!sample || sample.bytes !== transfer.transferredBytes) {
        this.speedProgress.set(transfer.transferId, {
          bytes: transfer.transferredBytes,
          at: now,
        });
        const remaining = Math.max(0, transfer.totalBytes - transfer.transferredBytes);
        const eta =
          transfer.speedBytesPerSec > 1024 && remaining > 0
            ? Math.ceil(remaining / transfer.speedBytesPerSec)
            : null;
        if (transfer.etaSeconds !== eta) {
          transfer.etaSeconds = eta;
          changed = true;
        }
        continue;
      }

      if (now - sample.at < SPEED_STALE_TIMEOUT_MS) continue;
      // All bytes have crossed; the remaining pause is SHA-256 verification /
      // the final completion ACK, not a stalled data stream. Keep the last
      // measured rate so a completed transfer can still report its speed.
      const allBytesTransferred =
        transfer.totalBytes > 0 && transfer.transferredBytes >= transfer.totalBytes;
      if (!allBytesTransferred && transfer.speedBytesPerSec !== 0) {
        transfer.speedBytesPerSec = 0;
        changed = true;
      }
      if (transfer.etaSeconds !== null) {
        transfer.etaSeconds = null;
        changed = true;
      }
      // Restart the next instant-rate window at the stalled byte count; the
      // ACK-stall timer (`lastAckAt`) is deliberately left untouched.
      if (receiveState) {
        receiveState.lastSpeedTs = now;
        receiveState.lastSpeedBytes = receiveState.bytesReceived;
      }
      if (sendState) {
        sendState.lastSpeedTs = now;
        sendState.lastSpeedBytes = sendState.session.transferredBytes;
      }
    }

    for (const id of Array.from(this.speedProgress.keys())) {
      if (!liveIds.has(id)) this.speedProgress.delete(id);
    }
    if (changed) this.emit();
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}
