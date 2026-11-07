import {
  type ClientToServerMessage,
  type ControlPayload,
  type DeviceProfile,
  type FileManifestItem,
  type HistoricalTransferSummary,
  type LocalDaemonStatus,
  type PeerSummary,
  type ServerToClientMessage,
  type TransportKind,
  type VisibilityMode,
  classifyTextPayload,
  decodeEncryptedChunkFrame,
  encodeEncryptedChunkFrame,
  formatPairCode,
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
import { hashStream, Sha256Stream } from './sha256Stream.js';

export const CHUNK_SIZE = 256 * 1024; // 256 KiB — 4× fewer read/encrypt/frame/ACK round-trips per byte than the old 64 KiB
export const MIN_CHUNK_SIZE = 16 * 1024; // smallest per-file chunk size a peer may declare (legacy peers use 64 KiB)
export const MAX_CHUNK_SIZE = 1024 * 1024; // largest per-file chunk size a peer may declare
export const MAX_FILES_PER_TRANSFER = 100;
export const MAX_CHUNKS_PER_TRANSFER = 262_144; // 64 GiB at 256 KiB chunks — a manifest sanity ceiling, not a product limit
export const MAX_CLIPBOARD_TEXT = 256_000;
export const MAX_CLIPBOARD_IMAGE_DATAURL_LENGTH = MAX_CLIPBOARD_IMAGE_DATAURL;

export function isValidFileManifest(files: unknown, totalBytes: unknown): files is FileManifestItem[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_TRANSFER) return false;
  if (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes < 0) return false;
  let sum = 0; let chunks = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as FileManifestItem;
    if (!f || f.index !== i || typeof f.name !== 'string' || f.name.length === 0 || f.name.length > 512) return false;
    if (typeof f.size !== 'number' || !Number.isFinite(f.size) || f.size < 0) return false;
    // Honor the sender's declared chunk size (bounded) instead of demanding
    // our own: legacy 64 KiB peers and future larger-chunk peers both work,
    // and the receiver sizes/validates every chunk against this declaration.
    if (typeof f.chunkSize !== 'number' || f.chunkSize < MIN_CHUNK_SIZE || f.chunkSize > MAX_CHUNK_SIZE) return false;
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

const MAX_UNACKED_CHUNKS = 64; // 16 MiB of receiver-confirmed work: deep for LAN RTTs without hiding a slow disk
const ACK_INTERVAL_CHUNKS = 8; // 2 MiB ACK cadence keeps both devices' progress closely aligned
const ACK_STALL_TIMEOUT_MS = 15_000;
// Keep the displayed rate truthful when disk writes or the network pause.
const SPEED_SAMPLE_INTERVAL_MS = 250;
const SPEED_STALE_TIMEOUT_MS = 1_500;
const COMPLETE_ACK_TIMEOUT_MS = 60_000;
const MAX_COMPLETE_ACK_RETRIES = 2;
const ENCRYPT_PIPELINE_DEPTH = 8; // file reads + AES-GCM encrypts kept in flight ahead of the socket (2 MiB of frames)
const MAX_BUFFER_HIGH_WATER = 4 * 1024 * 1024; // cap queued bytes so other apps are not stuck behind a huge Wi-Fi buffer
const BUFFER_LOW_WATER = 1024 * 1024; // resume after the socket has drained below 1 MiB

export interface SendableFileInput {
  name: string;
  relativePath?: string;
  size: number;
  type: string;
  sliceBytes: (start: number, end: number) => Promise<Uint8Array>;
  rawBlob?: Blob;
}

export function wrapBrowserFile(file: File, relativePath?: string): SendableFileInput {
  return {
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
}

export interface WarpClientSnapshot {
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  peerId: string;
  pairCode: string;
  formattedPairCode: string;
  visibility: VisibilityMode;
  myDevice: DeviceProfile | null;
  lanUrls: string[];
  localDaemon: LocalDaemonStatus;
  peers: PeerSummary[];
  peerSecurity: Record<string, PeerSecurityInfo>;
  transfers: TransferSessionView[];
  clipboardItems: ClipboardBeamItem[];
  trustedPeerKeys: string[];
  autoClipboardSync: boolean;
  clipboardReceiveEnabled: boolean;
}

export interface WarpClientOptions {
  wsUrl?: string;
  initialPairCode?: string;
  storagePrefix?: string;
  deviceOverride?: Omit<DeviceProfile, 'publicKey'>;
  enableWebRtc?: boolean;
  autoAcceptAll?: boolean;
  autoClipboardSync?: boolean;
  onIncomingTransfer?: (transfer: TransferSessionView) => void;
  onIncomingClipboard?: (item: ClipboardBeamItem) => void;
  onOutgoingAutoClipboard?: (item: ClipboardBeamItem) => void;
  onTransferCompleted?: (transfer: TransferSessionView) => void;
}

interface InternalReceiveState {
  session: TransferSessionView;
  fileChunks: Array<Array<Uint8Array | undefined>>;
  receivedChunkCounts: number[];
  /** First chunk not yet stored contiguously, and last ACK sent, per file. */
  nextContiguousChunks: number[];
  lastAckedChunks: number[];
  bytesReceived: number;
  lastSpeedTs: number;
  lastSpeedBytes: number;
  fileCompletePayloads: Map<number, { sha256?: string }>;
  finalizedFiles: Set<number>;
  transferCompleteReceived: boolean;
  finalizeChain: Promise<void>;
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
  completionAckWaiters: Array<(result: { verified: boolean; reason?: string }) => void>;
  acceptingPeerId?: string;
}

class TransferConnectionInterruptedError extends Error {
  constructor(message = 'Transfer connection interrupted; waiting to resume.') {
    super(message);
    this.name = 'TransferConnectionInterruptedError';
  }
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

function loadOrCreatePeerId(storagePrefix: string): string {
  const key = `${storagePrefix}:peerId`;
  const storage = getSafeLocalStorage();
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

  markReceived(chunkIndex: number): void {
    this.received.add(chunkIndex);
    this.stored.add(chunkIndex);
  }

  /** Resolve only after this chunk's disk write has succeeded. */
  waitUntilStored(chunkIndex: number): Promise<boolean> {
    if (this.stored.has(chunkIndex)) return Promise.resolve(true);
    if (this.error && !this.received.has(chunkIndex)) return Promise.resolve(false);
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

  /** Sender-declared full-file digest, checked before any file is saved. */
  setExpectedSha256(sha256: string | undefined): void {
    this.expectedSha256 = sha256;
  }

  getError(): string | undefined {
    return this.error;
  }

  push(chunkIndex: number, data: Uint8Array): void {
    if (this.received.has(chunkIndex)) return;
    this.received.add(chunkIndex);
    this.queue.push({ chunkIndex, data });
    this.pump();
  }

  protected abstract writeChunk(chunkIndex: number, data: Uint8Array): Promise<void>;
  protected abstract finalize(): Promise<DiskFinalizeResult | null>;
  /** Remove any partial/final file when verification fails or the transfer is dropped. */
  abstract discard(): Promise<void>;
  /** Close any open resources (streams/handles). Safe to call multiple times. */
  async dispose(): Promise<void> {}

  protected pump(): void {
    while (this.queue.length > 0 && this.pending < this.windowSize) {
      const item = this.queue.shift()!;
      this.pending++;
      void this.writeChunk(item.chunkIndex, item.data)
        .then(() => {
          this.stored.add(item.chunkIndex);
          this.notifyStored(item.chunkIndex, true);
          // A later successful re-delivery heals an earlier write failure.
          if (this.received.size === this.meta.totalChunks) this.error = undefined;
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
    if (!this.complete && !forceFallback) return null;
    if (this.received.size < this.meta.totalChunks && !forceFallback) return null;
    await this.waitIdle();
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
    const resp = await fetch(`${this.apiBase}/api/daemon/receive-chunk`, {
      method: 'POST',
      headers,
      body: data as unknown as BodyInit,
    });
    if (!resp.ok) {
      throw new Error(`chunk ${chunkIndex} rejected (HTTP ${resp.status})`);
    }
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
  private stream?: FsWritableStream;
  private fileHandle?: FsFileHandle;
  private readonly directoryHandle: FsDirectoryHandle;

  constructor(meta: DiskReceiveMeta, directoryHandle: FsDirectoryHandle) {
    // Writes to a single WritableFileStream must be serialized.
    super(meta, 1);
    this.directoryHandle = directoryHandle;
  }

  async open(): Promise<void> {
    this.fileHandle = await this.directoryHandle.getFileHandle(this.meta.name, { create: true });
    this.stream = await this.fileHandle.createWritable();
    // createWritable() starts with an empty temp file; sizing it up front makes
    // every declared chunk offset valid and removes any stale trailing bytes
    // from a previous file with the same name.
    await this.stream.truncate(this.meta.size);
  }

  protected async writeChunk(chunkIndex: number, data: Uint8Array): Promise<void> {
    await this.stream!.write({
      type: 'write',
      position: chunkIndex * this.meta.chunkSize,
      data,
    } as WriteParams);
  }

  protected async finalize(): Promise<DiskFinalizeResult | null> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = (async () => {
      try {
        await this.stream?.close();
        this.stream = undefined;
        const file = await this.fileHandle!.getFile();
        const sha256 = await hashStream(file.stream());
        const finalName = this.fileHandle!.name || this.meta.name;
        if (this.expectedSha256 && sha256 !== this.expectedSha256) {
          await this.discard();
          this.error = 'SHA-256 verification failed; the partial file was discarded.';
          return null;
        }
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
    try {
      await this.stream?.close();
    } catch {
      // ignore
    }
    this.stream = undefined;
  }

  /** Remove the partial file (used when a transfer is cancelled/declined). */
  async discard(): Promise<void> {
    await this.dispose();
    try {
      await this.directoryHandle.removeEntry(this.fileHandle?.name ?? this.meta.name);
    } catch {
      // ignore
    }
  }
}

export class WarpClient {
  private readonly opts: WarpClientOptions;
  private readonly storagePrefix: string;
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

  // Active & historical transfers / clipboard
  private transfers: TransferSessionView[] = [];
  private incomingStates = new Map<string, InternalReceiveState>();
  private outgoingStates = new Map<string, InternalSendState>();
  private clipboardItems: ClipboardBeamItem[] = [];
  private trustedPeerKeys = new Set<string>();

  // Automatic universal clipboard sync state
  private autoClipboardSync = true;
  private clipboardReceiveEnabled = true;
  private lastSyncedClipboardText = '';
  private seenBeamIds = new Set<string>();
  private lastIncomingClip: { peerId: string; text: string; ts: number } | null = null;
  private pendingAutoClipboard: { text: string; capturedAt: number } | null = null;

  constructor(opts: WarpClientOptions = {}) {
    this.opts = opts;
    this.storagePrefix = opts.storagePrefix ?? 'airbridge';
    this.peerId = loadOrCreatePeerId(this.storagePrefix);
    if (opts.autoClipboardSync !== undefined) {
      this.autoClipboardSync = opts.autoClipboardSync;
    }

    // Restore persisted pairCode, trusted devices, auto-clipboard pref & transfer/clipboard history
    try {
      const storage = getSafeLocalStorage();
      if (storage) {
        const storedPair = storage.getItem(`${this.storagePrefix}:pairCode`);
        if (opts.initialPairCode) {
          this.pairCode = normalizePairCode(opts.initialPairCode);
        } else if (storedPair) {
          this.pairCode = normalizePairCode(storedPair);
        }
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
              .slice(0, 50);
            for (const c of this.clipboardItems) {
              this.seenBeamIds.add(c.beamId);
            }
            if (this.clipboardItems[0]) {
              this.lastSyncedClipboardText = this.clipboardItems[0].text.trim();
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
      };
    } else if (deviceFactory) {
      const profile = deviceFactory(this.keys.publicKeyB64);
      this.myDevice = {
        deviceId: fallbackDeviceId,
        ...profile,
      };
    } else {
      this.myDevice = {
        name: 'AirBridge Peer',
        platform: 'unknown',
        model: 'Device',
        formFactor: 'laptop',
        publicKey: this.keys.publicKeyB64,
        deviceId: fallbackDeviceId,
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
    }
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
      peerSecurity[peer.peerId] = {
        sasCode: crypto?.sasCode ?? '··· ···',
        fingerprintHex: crypto?.fingerprintHex ?? '',
        rtcConnected: dc?.readyState === 'open',
        rttMs: this.peerRttMs.get(peer.peerId) ?? null,
      };
    }

    return {
      connectionState: this.connectionState,
      peerId: this.peerId,
      pairCode: this.pairCode,
      formattedPairCode: formatPairCode(this.pairCode),
      visibility: this.visibility,
      myDevice: this.myDevice,
      lanUrls: this.lanUrls,
      localDaemon: this.localDaemon,
      peers: [...this.peers],
      peerSecurity,
      transfers: [...this.transfers],
      clipboardItems: [...this.clipboardItems],
      trustedPeerKeys: Array.from(this.trustedPeerKeys),
      autoClipboardSync: this.autoClipboardSync,
      clipboardReceiveEnabled: this.clipboardReceiveEnabled,
    };
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
    this.sendServer({ type: 'join-pair', pairCode: clean });
    this.emit();
  }

  public rotatePairCode(): void {
    this.sendServer({ type: 'rotate-pair' });
  }

  public toggleTrustedPeer(publicKey: string, trusted: boolean): void {
    if (trusted) {
      this.trustedPeerKeys.add(publicKey);
    } else {
      this.trustedPeerKeys.delete(publicKey);
    }
    try {
      const storage = getSafeLocalStorage();
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
      const storage = getSafeLocalStorage();
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
      const storage = getSafeLocalStorage();
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
      this.lastSyncedClipboardText = trimmed;
    }
  }

  public getLastSyncedClipboardText(): string {
    return this.lastSyncedClipboardText;
  }

  /**
   * Automatically beams newly copied clipboard text to connected peer(s)
   * (preferring paired devices when present) without requiring manual interaction.
   */
  public async handleDetectedLocalClipboard(rawText: string): Promise<ClipboardBeamItem[]> {
    if (!this.autoClipboardSync || this.destroyed) return [];
    const trimmed = rawText.trim();
    if (!trimmed || trimmed.length > 256_000) return [];
    if (trimmed === this.lastSyncedClipboardText) return [];

    const pairedPeers = this.peers.filter((p) => p.discoveryScope === 'paired');
    const targets = pairedPeers.length > 0 ? pairedPeers : [...this.peers];

    if (this.connectionState !== 'connected' || targets.length === 0) {
      this.pendingAutoClipboard = { text: trimmed, capturedAt: Date.now() };
      return [];
    }

    this.lastSyncedClipboardText = trimmed;
    this.pendingAutoClipboard = null;

    const results: ClipboardBeamItem[] = [];
    for (const peer of targets) {
      try {
        const sent = await this.sendClipboard(peer.peerId, trimmed, { isAuto: true });
        results.push(sent);
      } catch {
        // ignore transient send failure on individual peer
      }
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
    if (trimmed.length > MAX_CLIPBOARD_TEXT && !isValidClipboardImageDataUrl(trimmed)) {
      throw new Error('Text too large to beam.');
    }

    const cryptoSession = await this.ensureCryptoSession(peer);
    const beamId = randomHex16();
    const contentType = classifyTextPayload(trimmed);
    const timestamp = Date.now();

    // Distinguish text vs image data URL payloads
    const isImage = isValidClipboardImageDataUrl(trimmed) || contentType === 'image';
    this.lastSyncedClipboardText = trimmed;
    this.seenBeamIds.add(beamId);

    await this.sendControlMessage(
      peerId,
      {
        kind: 'clipboard-beam',
        beamId,
        text: isImage ? undefined : trimmed,
        imageDataUrl: isImage ? trimmed : undefined,
        imageName: isImage ? `clipboard-image-${Date.now()}.png` : undefined,
        contentType,
        timestamp,
      },
      true
    );

    const item: ClipboardBeamItem = {
      beamId,
      peerId,
      peerName: peer.device.name,
      direction: 'outgoing',
      text: trimmed,
      imageDataUrl: isImage ? trimmed : undefined,
      contentType,
      timestamp,
      sasCode: cryptoSession.sasCode,
    };
    this.clipboardItems = [item, ...this.clipboardItems].slice(0, 50);
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
    imageName?: string
  ): Promise<ClipboardBeamItem> {
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) throw new Error('Selected peer is no longer online.');
    if (!isValidClipboardImageDataUrl(imageDataUrl)) throw new Error('Invalid image data. Use a PNG/JPEG/WebP image under 5 MB.');
    const cryptoSession = await this.ensureCryptoSession(peer);
    const beamId = randomHex16();
    const timestamp = Date.now();
    this.seenBeamIds.add(beamId);
    // Use the image data as the deduplication key as well
    this.lastSyncedClipboardText = imageDataUrl.slice(0, 1024);

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
    this.clipboardItems = [item, ...this.clipboardItems].slice(0, 50);
    this.persistClipboardHistory();
    this.emit();
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
    if (inputs.length === 0) {
      throw new Error('No files selected.');
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
  ): Promise<{ peer: PeerSummary; cryptoSession: PeerCryptoSession; preferredTransport: TransportKind }> {
    let peer = initialPeer;
    let cryptoSession = initialCryptoSession;
    while (!sendState.cancelled && !this.destroyed) {
      try {
        const preferredTransport = await this.requestTransferAccept(sendState, peer);
        return { peer, cryptoSession, preferredTransport };
      } catch (error) {
        if (!(error instanceof TransferConnectionInterruptedError)) throw error;
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
  ): Promise<TransportKind> {
    const acceptPromise = new Promise<TransportKind>((resolve, reject) => {
      sendState.acceptResolver = resolve;
      sendState.acceptRejecter = reject;
      sendState.acceptingPeerId = peer.peerId;
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
    while (!sendState.cancelled && !this.destroyed) {
      if (this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
        const peer = this.peers.find((candidate) =>
          sendState.session.peerDeviceId
            ? candidate.device.deviceId === sendState.session.peerDeviceId
            : candidate.peerId === sendState.session.peerId,
        );
        if (peer) {
          sendState.session.peerId = peer.peerId;
          sendState.session.peerName = peer.device.name;
          sendState.session.peerPlatform = peer.device.platform;
          return peer;
        }
      }
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
      // A receiver only skips the highest contiguous durable prefix, so every
      // byte still contributes exactly once to the full-file digest.
      const resumeFrom = Math.min(meta.totalChunks, resumeFromChunks?.[fileIdx] ?? 0);
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

      for (let chunkIdx = resumeFrom; chunkIdx < meta.totalChunks; chunkIdx++) {
        if (sendState.cancelled) return;

        // Respect receiver-confirmed work. If ACKs stop, surface the stall as
        // recoverable so the same transfer ID can renegotiate and resume.
        while (!sendState.cancelled && globalSentChunks - sendState.ackedGlobalChunks >= MAX_UNACKED_CHUNKS) {
          await this.waitForChunkAckProgress(sendState, peer.peerId);
        }
        if (sendState.cancelled) return;

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

      const digest = fileHasher.hex();
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
    if (this.destroyed || this.ws?.readyState !== WebSocket.OPEN) {
      throw new TransferConnectionInterruptedError('Signaling connection lost; resuming transfer.');
    }
    if (!this.peers.some((peer) => peer.peerId === peerId)) {
      throw new TransferConnectionInterruptedError('Receiver disconnected; waiting to resume.');
    }
  }

  private async waitForChunkAckProgress(
    sendState: InternalSendState,
    peerId: string,
  ): Promise<void> {
    this.assertTransferPeerConnected(sendState, peerId);
    if (sendState.cancelled) return;
    const elapsed = Date.now() - sendState.lastAckAt;
    if (elapsed >= ACK_STALL_TIMEOUT_MS) {
      throw new TransferConnectionInterruptedError('Receiver stopped acknowledging; resuming transfer.');
    }
    await this.waitForAckSignal(sendState, Math.min(250, ACK_STALL_TIMEOUT_MS - elapsed));
    this.assertTransferPeerConnected(sendState, peerId);
    if (Date.now() - sendState.lastAckAt >= ACK_STALL_TIMEOUT_MS) {
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
        const waiter = (result: { verified: boolean; reason?: string }) => finish(result);
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

      if (this.incomingStates.get(transferId) !== recvState) return;
      const peerId = recvState.session.peerId;
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
    await Promise.all(
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
        await receiver.open();
        receivers.set(file.index, receiver);
      }),
    );
    recvState.fileSystemReceivers = receivers;
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
        if (discardFiles) await r.discard();
        else await r.dispose();
      } catch {
        // ignore
      }
    }
    for (const r of recvState.diskReceivers?.values() ?? []) {
      try {
        await r.dispose();
      } catch {
        // ignore
      }
    }
  }

  public async declineIncomingTransfer(transferId: string): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState) return;
    if (recvState.fallbackTimer) clearTimeout(recvState.fallbackTimer);
    await this.disposeReceivers(recvState, true);
    recvState.session.status = 'declined';
    recvState.session.completedAt = Date.now();
    this.incomingStates.delete(transferId);
    this.sortTransfers();
    this.persistTransferHistory();
    this.emit();

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
      await this.disposeReceivers(recvState, true);
      recvState.session.status = 'cancelled';
      recvState.session.completedAt = Date.now();
      this.incomingStates.delete(transferId);
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
      if (this.destroyed || !this.myDevice) return;
      this.sendServer({
        type: 'hello',
        peerId: this.peerId,
        device: this.myDevice,
        pairCode: this.pairCode || undefined,
        visibility: this.visibility,
      });
      this.emit();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as ServerToClientMessage;
          this.handleServerMessage(msg);
        } catch {
          // ignore malformed
        }
      } else if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        const { sourcePeerId, payload } = unwrapRoutedRelayFrame(bytes);
        this.handleIncomingEncryptedChunk(sourcePeerId, payload, 'ws-relay').catch(() => {});
      } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
        event.data.arrayBuffer().then((ab) => {
          const bytes = new Uint8Array(ab);
          const { sourcePeerId, payload } = unwrapRoutedRelayFrame(bytes);
          this.handleIncomingEncryptedChunk(sourcePeerId, payload, 'ws-relay').catch(() => {});
        });
      }
    };

    ws.onclose = () => {
      if (this.destroyed) return;
      this.connectionState = 'reconnecting';
      for (const sendState of this.outgoingStates.values()) {
        sendState.acceptRejecter?.(
          new TransferConnectionInterruptedError('Signaling connection lost while waiting for acceptance.'),
        );
        for (const wake of sendState.ackWaiters.splice(0)) wake();
      }
      this.emit();
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 1_500);
    };

    ws.onerror = () => {
      // Handled by onclose
    };
  }

  private handleServerMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.connectionState = 'connected';
        this.peerId = msg.peerId;
        this.persistPeerId(msg.peerId);
        this.pairCode = msg.pairCode;
        this.persistPairCode(msg.pairCode);
        this.lanUrls = msg.lanUrls;
        this.localDaemon = msg.localDaemon;
        this.syncPeers(msg.peers);
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
        const prev = this.peerControlQueues.get(msg.from) ?? Promise.resolve();
        const next = prev
          .then(() => this.handleIncomingControl(msg.from, msg.envelope))
          .catch(() => {});
        this.peerControlQueues.set(msg.from, next);
        break;
      }

      case 'host-clipboard': {
        this.handleDetectedLocalClipboard(msg.text).catch(() => {});
        break;
      }

      case 'error': {
        break;
      }
    }
  }

  private syncPeers(nextPeers: PeerSummary[]): void {
    this.peers = nextPeers;
    const activeIds = new Set(nextPeers.map((p) => p.peerId));
    for (const sendState of this.outgoingStates.values()) {
      const acceptingPeerId = sendState.acceptingPeerId ?? sendState.session.peerId;
      if (sendState.acceptRejecter && !activeIds.has(acceptingPeerId)) {
        sendState.acceptRejecter(
          new TransferConnectionInterruptedError('Receiver disconnected while waiting for acceptance.'),
        );
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
          // Flush any clipboard text copied shortly before this peer woke up / reconnected
          if (
            this.pendingAutoClipboard &&
            this.autoClipboardSync &&
            Date.now() - this.pendingAutoClipboard.capturedAt <= 60_000
          ) {
            const pendingText = this.pendingAutoClipboard.text;
            this.pendingAutoClipboard = null;
            this.handleDetectedLocalClipboard(pendingText).catch(() => {});
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

    const session = await derivePeerSession(
      this.keys.privateKey,
      this.keys.publicKeyB64,
      peer.device.publicKey
    );
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

    const peer = this.peers.find((p) => p.peerId === peerId);
    let session = this.cryptoSessions.get(peerId);
    if (!session && peer) {
      session = await this.ensureCryptoSession(peer);
    }
    if (!session) {
      throw new Error('Missing peer encryption session');
    }

    const envelope = await encryptControlPayload(session.aesKey, payload);
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
    const peer = this.peers.find((p) => p.peerId === fromPeerId);
    let payload: ControlPayload;

    if (envelope.encrypted) {
      let session = this.cryptoSessions.get(fromPeerId);
      if (!session && peer) {
        session = await this.ensureCryptoSession(peer);
      }
      if (!session) return;
      payload = await decryptControlPayload(session.aesKey, envelope);
    } else {
      // SECURITY: only the unauthenticated liveness ping/pong may travel in
      // plaintext. Everything else (offers, clipboard, accept/decline/cancel,
      // history) must prove possession of the ECDH session key via AES-GCM,
      // otherwise anyone able to relay a frame could forge it.
      if (envelope.payload?.kind !== 'ping' && envelope.payload?.kind !== 'pong') return;
      payload = envelope.payload;
    }

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
        const dedupKey = hasImage ? payload.imageDataUrl!.slice(0, 256) : payload.text!.trim();
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
        // For text beams still track lastSyncedClipboardText to prevent echo
        if (hasText) this.lastSyncedClipboardText = payload.text!.trim();
        else if (hasImage) this.lastSyncedClipboardText = payload.imageDataUrl!.slice(0, 1024);

        // Also update the host OS clipboard (e.g. macOS pbcopy) via loopback so
        // pasting works immediately in any app even if this browser tab is unfocused.
        // Only for text - image clipboard bridge is not yet supported on host.
        if (this.localDaemon.clipboardBridge && hasText) {
          this.sendServer({ type: 'set-host-clipboard', text: payload.text! });
        }

        const session = this.cryptoSessions.get(fromPeerId);
        const isImageContent = payload.contentType === 'image' || hasImage;
        const item: ClipboardBeamItem = {
          beamId: payload.beamId,
          peerId: fromPeerId,
          peerName: peer?.device.name ?? 'Paired Device',
          direction: 'incoming',
          text: hasText ? payload.text! : (hasImage ? payload.imageDataUrl! : ''),
          imageDataUrl: hasImage ? payload.imageDataUrl : undefined,
          imageName: payload.imageName,
          contentType: isImageContent ? 'image' : (payload.contentType ?? 'text'),
          timestamp: payload.timestamp,
          sasCode: session?.sasCode ?? '··· ···',
        };
        this.clipboardItems = [item, ...this.clipboardItems].slice(0, 50);
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
        const existingReceive = this.incomingStates.get(payload.transferId);
        if (existingReceive) {
          const samePeer =
            existingReceive.session.peerId === fromPeerId ||
            Boolean(
              existingReceive.session.peerDeviceId &&
              peer?.device.deviceId === existingReceive.session.peerDeviceId,
            );
          const sameFiles = existingReceive.session.files.length === payload.files.length &&
            existingReceive.session.files.every((file, index) => {
              const offered = payload.files[index];
              return Boolean(
                offered && file.index === offered.index && file.name === offered.name &&
                file.size === offered.size && file.chunkSize === offered.chunkSize &&
                file.totalChunks === offered.totalChunks && file.mimeType === offered.mimeType,
              );
            });
          if (!samePeer || !sameFiles) break;
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
              if (this.incomingStates.get(payload.transferId) !== existingReceive) break;
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
          const samePeer =
            terminalReceive.peerId === fromPeerId ||
            Boolean(terminalReceive.peerDeviceId && peer?.device.deviceId === terminalReceive.peerDeviceId);
          if (samePeer && terminalReceive.status === 'completed') {
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
          fileChunks: payload.files.map((f) =>
            Array.from({ length: f.totalChunks }, () => undefined)
          ),
          receivedChunkCounts: payload.files.map(() => 0),
          nextContiguousChunks: payload.files.map(() => 0),
          lastAckedChunks: payload.files.map(() => -1),
          bytesReceived: 0,
          lastSpeedTs: Date.now(),
          lastSpeedBytes: 0,
          fileCompletePayloads: new Map(),
          finalizedFiles: new Set(),
          transferCompleteReceived: false,
          finalizeChain: Promise.resolve(),
        };

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
          (peer ? this.trustedPeerKeys.has(peer.device.publicKey) : false);
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
          await this.disposeReceivers(recvState, true);
          recvState.session.status = 'cancelled';
          recvState.session.completedAt = Date.now();
          this.incomingStates.delete(payload.transferId);
          this.sortTransfers();
          this.persistTransferHistory();
          this.emit();
        }
        break;
      }

      case 'chunk-ack': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState && sendState.session.peerId === fromPeerId) {
          if (!Number.isInteger(payload.fileIndex) || payload.fileIndex < 0 || payload.fileIndex >= sendState.session.files.length) break;
          const file = sendState.session.files[payload.fileIndex];
          if (
            !file ||
            !Number.isInteger(payload.ackedChunkIndex) ||
            payload.ackedChunkIndex < 0 ||
            payload.ackedChunkIndex >= file.totalChunks ||
            !Number.isInteger(payload.bytesReceivedTotal) ||
            payload.bytesReceivedTotal < 0 ||
            payload.bytesReceivedTotal > sendState.session.totalBytes
          ) break;
          const receiverPrefix = payload.ackedChunkIndex + 1;
          const resumePrefix = sendState.resumeFromChunks?.[payload.fileIndex] ?? 0;
          const sentPrefix = resumePrefix + (sendState.sentChunksByFile[payload.fileIndex] ?? 0);
          // ACKs are per-file. Treating a later file's ACK as proof that all
          // earlier files were durable allowed multi-file sends to release
          // the 16 MiB window early and get tens of MiB ahead of the receiver.
          if (receiverPrefix > sentPrefix) break;
          const previousAckedChunks = sendState.ackedGlobalChunks;
          sendState.ackedChunksByFile[payload.fileIndex] = Math.max(
            sendState.ackedChunksByFile[payload.fileIndex] ?? resumePrefix,
            receiverPrefix,
          );
          const newlyAcked = countNewlyAcknowledgedChunks(
            sendState.ackedChunksByFile,
            sendState.resumeFromChunks,
          );
          sendState.ackedGlobalChunks = Math.min(sendState.sentGlobalChunks, newlyAcked);

          const now = Date.now();
          const previousConfirmedBytes = sendState.session.transferredBytes;
          const confirmedBytes = Math.max(
            previousConfirmedBytes,
            Math.min(sendState.session.totalBytes, payload.bytesReceivedTotal),
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
        await this.scheduleReceiveFinalization(payload.transferId, false);
        break;
      }

      case 'transfer-complete': {
        const recvState = this.incomingStates.get(payload.transferId);
        if (!recvState) {
          const terminalReceive = this.transfers.find(
            (transfer) => transfer.transferId === payload.transferId && transfer.direction === 'incoming',
          );
          const peer = this.peers.find((candidate) => candidate.peerId === fromPeerId);
          const samePeer = terminalReceive && (
            terminalReceive.peerId === fromPeerId ||
            Boolean(terminalReceive.peerDeviceId && peer?.device.deviceId === terminalReceive.peerDeviceId)
          );
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
            this.scheduleReceiveFinalization(payload.transferId, true).catch(() => {});
          }, 4_000);
        }
        await this.scheduleReceiveFinalization(payload.transferId, false);
        break;
      }
    }
  }

  private scheduleReceiveFinalization(transferId: string, forceFallback: boolean): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState) return Promise.resolve();

    const next = recvState.finalizeChain
      .then(() => this.runReceiveFinalization(transferId, forceFallback))
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

    const totalFiles = recvState.session.files.length;
    let hadDiskError = false;
    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
      if (recvState.finalizedFiles.has(fileIndex)) continue;

      const completeMeta = recvState.fileCompletePayloads.get(fileIndex);
      if (!completeMeta && !forceFallback) continue;

      const meta = recvState.session.files[fileIndex];
      if (!meta) continue;

      const allChunksArrived =
        meta.size === 0 || recvState.receivedChunkCounts[fileIndex] >= meta.totalChunks;
      if (!allChunksArrived) {
        // A lost file-complete message may justify a fallback attempt, but
        // never invent missing chunks: that used to save a truncated video.
        if (forceFallback) {
          hadDiskError = true;
          recvState.session.errorMessage = `Transfer incomplete: ${meta.name} is missing chunks.`;
        }
        continue;
      }

      const diskReceiver = recvState.diskReceivers?.get(fileIndex);
      const fsReceiver = recvState.fileSystemReceivers?.get(fileIndex);
      if (diskReceiver || fsReceiver) {
        const receiver = diskReceiver ?? fsReceiver!;
        // Verify before the daemon renames the .part file or the File System
        // stream closes a final file into the user's picked directory.
        receiver.setExpectedSha256(completeMeta?.sha256);
        const diskResult = await receiver.finalizeIfReady(forceFallback);
        if (!this.incomingStates.has(transferId)) return;
        if (!diskResult) {
          const receiverError = receiver.getError();
          // A null result can simply mean "chunks are still in flight" on the
          // normal path. Only a real write/verification error (or the final
          // fallback attempt) is allowed to throw the partial away.
          if (receiverError || forceFallback) {
            await receiver.discard().catch(() => {});
            hadDiskError = true;
            recvState.session.errorMessage =
              receiverError || 'The receiver could not finalize this file.';
          }
          continue;
        }
        const verified = completeMeta?.sha256
          ? diskResult.sha256 === completeMeta.sha256
          : allChunksArrived;
        if (!verified) {
          await receiver.discard().catch(() => {});
          hadDiskError = true;
          recvState.session.errorMessage =
            `SHA-256 verification failed for ${meta.name}. The file was not saved.`;
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
        this.emit();
        continue;
      }

      const rawChunks = recvState.fileChunks[fileIndex] ?? [];
      const cleanChunks: Uint8Array[] = new Array(meta.totalChunks);
      for (let i = 0; i < meta.totalChunks; i++) {
        cleanChunks[i] = rawChunks[i] ?? new Uint8Array(0);
      }

      const computedHash = await sha256Hex(cleanChunks);
      if (!this.incomingStates.has(transferId)) return;

      const verified = completeMeta?.sha256
        ? computedHash === completeMeta.sha256
        : allChunksArrived;
      if (!verified) {
        // Do not create a Blob, auto-save to Downloads, or expose a record:
        // a hash mismatch means these bytes are not the sender's file.
        hadDiskError = true;
        recvState.session.errorMessage =
          `SHA-256 verification failed for ${meta.name}. The file was not saved.`;
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

      if (!this.incomingStates.has(transferId)) return;

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
      this.emit();
    }

    if (recvState.transferCompleteReceived && this.incomingStates.has(transferId)) {
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
    const decoded = decodeEncryptedChunkFrame(innerPayload);
    const recvState = this.incomingStates.get(decoded.transferId);
    if (!recvState || recvState.session.peerId !== fromPeerId) return;
    // SECURITY: nothing is decrypted or stored before the user accepts the
    // transfer — a nearby stranger could otherwise fill device memory with
    // unsolicited "chunks" for an offer that is still awaiting consent.
    if (recvState.session.status !== 'transferring') return;
    const meta0 = recvState.session.files[decoded.fileIndex];
    if (!meta0 || !Number.isInteger(decoded.chunkIndex) || decoded.chunkIndex < 0 || decoded.chunkIndex >= meta0.totalChunks) return;

    const cryptoSession = this.cryptoSessions.get(fromPeerId);
    if (!cryptoSession) return;

    const plainBytes = await decryptBinaryChunk(
      cryptoSession.aesKey,
      decoded.iv,
      decoded.ciphertext
    );

    if (!this.incomingStates.has(decoded.transferId)) return;
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
      const fileArr = recvState.fileChunks[fileIndex];
      if (!fileArr) return;
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
    if (
      contiguousAck > lastAck &&
      (contiguousAck - lastAck >= ACK_INTERVAL_CHUNKS || nextContiguous === meta.totalChunks)
    ) {
      recvState.lastAckedChunks[fileIndex] = contiguousAck;
      // ACK only a contiguous durable prefix. Decrypts and writes can finish
      // out of order, so acknowledging an arbitrary completed chunk would
      // incorrectly release earlier chunks that are still in flight.
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
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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
          () => {}
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
    if (this.isRtcOpen(peerId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (this.isRtcOpen(peerId)) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 40);
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
      // Short poll: browsers expose no drain event for WebSocket, and a
      // 15 ms nap here used to cap relay throughput far below link speed.
      await new Promise((r) => setTimeout(r, 3));
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
      files: t.files.map(({ previewDataUrl: _preview, ...rest }) => rest),
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

        if (
          isLocalNonTerminal &&
          (!hasLiveSession || item.status === 'cancelled' || item.status === 'declined')
        ) {
          if (hasLiveSession && (item.status === 'cancelled' || item.status === 'declined')) {
            const recv = this.incomingStates.get(item.transferId);
            if (recv?.fallbackTimer) clearTimeout(recv.fallbackTimer);
            this.incomingStates.delete(item.transferId);
            const send = this.outgoingStates.get(item.transferId);
            if (send) {
              send.cancelled = true;
              for (const w of send.ackWaiters) w();
              this.outgoingStates.delete(item.transferId);
            }
          }
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
    if (this.transfers.length > 60) {
      this.transfers = this.transfers.slice(0, 60);
    }
  }

  private persistTransferHistory(): void {
    try {
      const storage = getSafeLocalStorage();
      if (storage) {
        const serializable = this.transfers
          .filter((t) => isTerminalTransferStatus(t.status))
          .slice(0, 50)
          .map((t) => ({
            ...t,
            files: t.files.map(({ previewDataUrl: _preview, ...rest }) => rest),
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

  private persistClipboardHistory(): void {
    try {
      const storage = getSafeLocalStorage();
      if (storage) {
        const serializable = this.clipboardItems
          .filter((c) => {
            if (c.contentType === 'image') return (c.imageDataUrl?.length ?? c.text.length) <= MAX_CLIPBOARD_IMAGE_DATAURL_LENGTH;
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
      const storage = getSafeLocalStorage();
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
      getSafeLocalStorage()?.setItem(`${this.storagePrefix}:peerId`, peerId);
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
