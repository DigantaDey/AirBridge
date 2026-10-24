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
const MAX_UNACKED_CHUNKS = 256; // 64 MiB sliding window at 256 KiB chunks — never let ACK RTT throttle a fast LAN link
const ACK_INTERVAL_CHUNKS = 32; // receiver ACKs at most every 32 chunks (8 MiB) + on each file's last chunk
const ENCRYPT_PIPELINE_DEPTH = 8; // file reads + AES-GCM encrypts kept in flight ahead of the socket (2 MiB of frames)
const MAX_BUFFER_HIGH_WATER = 16 * 1024 * 1024; // 16 MiB socket buffer threshold — deep enough to keep the pipe full
const BUFFER_LOW_WATER = 4 * 1024 * 1024; // resume sending once a drained socket falls to 4 MiB

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
  bytesReceived: number;
  lastSpeedTs: number;
  lastSpeedBytes: number;
  fileCompletePayloads: Map<number, { sha256?: string }>;
  finalizedFiles: Set<number>;
  transferCompleteReceived: boolean;
  finalizeChain: Promise<void>;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  /** Disk-backed receivers, one per file, when the host daemon is enabled. */
  diskReceivers?: Map<number, DiskFileReceiver>;
}

interface InternalSendState {
  session: TransferSessionView;
  inputs: SendableFileInput[];
  ackedGlobalChunks: number;
  ackWaiters: Array<() => void>;
  cancelled: boolean;
  acceptResolver?: (transport: TransportKind) => void;
  acceptRejecter?: (reason: Error) => void;
  /** Highest contiguous chunk index the receiver already has on disk, per file. */
  resumeFromChunks?: Record<number, number>;
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

/**
 * Streams decrypted chunks to the local AirBridge daemon over loopback as
 * they arrive, so a large inbound file is written to disk incrementally
 * instead of being buffered in browser memory. Writes are idempotent and
 * resumable: a chunk already on disk is a no-op, and the daemon keeps a
 * manifest of what landed so a re-established transfer can skip the prefix.
 */
class DiskFileReceiver {
  private readonly queue: Array<{ chunkIndex: number; data: Uint8Array }> = [];
  private readonly received = new Set<number>();
  private pending = 0;
  private complete = false;
  private finalized = false;
  private result?: DiskFinalizeResult;
  private error?: string;
  private finalizePromise?: Promise<DiskFinalizeResult | null>;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly meta: DiskReceiveMeta,
    private readonly senderName: string,
    private readonly apiBase: string,
  ) {}

  hasReceived(chunkIndex: number): boolean {
    return this.received.has(chunkIndex);
  }

  markReceived(chunkIndex: number): void {
    this.received.add(chunkIndex);
  }

  markComplete(): void {
    this.complete = true;
  }

  push(chunkIndex: number, data: Uint8Array): void {
    if (this.received.has(chunkIndex)) return;
    this.received.add(chunkIndex);
    this.queue.push({ chunkIndex, data });
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.pending < DISK_SEND_WINDOW) {
      const item = this.queue.shift()!;
      this.pending++;
      void this.sendChunk(item)
        .catch((err) => {
          // A chunk that never landed on disk must not count as received,
          // or finalization would hash a truncated file as complete.
          this.received.delete(item.chunkIndex);
          this.error =
            this.error ||
            (err instanceof Error ? err.message : 'Failed to write chunk to disk.');
        })
        .finally(() => {
          this.pending--;
          this.pump();
          this.maybeNotifyIdle();
        });
    }
  }

  private async sendChunk(item: { chunkIndex: number; data: Uint8Array }): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-AirBridge-Transfer': this.meta.transferId,
      'X-AirBridge-File': String(this.meta.fileIndex),
      'X-AirBridge-Chunk': String(item.chunkIndex),
      'X-AirBridge-Name': encodeURIComponent(this.meta.name),
      'X-AirBridge-Size': String(this.meta.size),
      'X-AirBridge-Chunk-Size': String(this.meta.chunkSize),
      'X-AirBridge-Total-Chunks': String(this.meta.totalChunks),
    };
    if (this.senderName) headers['X-AirBridge-Sender'] = encodeURIComponent(this.senderName);
    const resp = await fetch(`${this.apiBase}/api/daemon/receive-chunk`, {
      method: 'POST',
      headers,
      body: item.data as unknown as BodyInit,
    });
    if (!resp.ok) {
      throw new Error(`chunk ${item.chunkIndex} rejected (HTTP ${resp.status})`);
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
    const result = await this.finalize();
    if (result) {
      this.finalized = true;
      this.result = result;
    }
    return result;
  }

  getError(): string | undefined {
    return this.error;
  }

  private async finalize(): Promise<DiskFinalizeResult | null> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = (async () => {
      try {
        const resp = await fetch(`${this.apiBase}/api/daemon/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transferId: this.meta.transferId,
            fileIndex: this.meta.fileIndex,
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
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
      ackedGlobalChunks: 0,
      ackWaiters: [],
      cancelled: false,
    };

    this.outgoingStates.set(transferId, sendState);
    this.transfers = [session, ...this.transfers];
    this.sortTransfers();
    this.emit();

    const acceptPromise = new Promise<TransportKind>((resolve, reject) => {
      sendState.acceptResolver = resolve;
      sendState.acceptRejecter = reject;
    });

    await this.sendControlMessage(
      peerId,
      {
        kind: 'transfer-offer',
        transferId,
        files: manifest,
        totalBytes,
        createdAt: Date.now(),
      },
      true
    );

    let negotiatedTransport: TransportKind;
    try {
      negotiatedTransport = await acceptPromise;
    } catch (err) {
      return session;
    }

    // Wait briefly (up to 1.2s) if recipient preferred WebRTC and ICE is mid-handshake
    let activeTransport: TransportKind = 'ws-relay';
    if (negotiatedTransport === 'webrtc' && this.canUseWebRtc()) {
      const opened = await this.waitForRtcChannel(peerId, 1_200);
      activeTransport = opened ? 'webrtc' : 'ws-relay';
    }

    session.status = 'transferring';
    session.transport = activeTransport;
    session.startedAt = Date.now();
    this.emit();

    try {
      await this.streamOutgoingFiles(peer, cryptoSession, sendState, activeTransport);
    } catch (err) {
      if (!sendState.cancelled) {
        session.status = 'error';
        session.completedAt = Date.now();
        session.errorMessage = err instanceof Error ? err.message : 'Transfer interrupted';
        this.sortTransfers();
        this.persistTransferHistory();
        this.emit();
      }
    }

    return session;
  }

  private async streamOutgoingFiles(
    peer: PeerSummary,
    cryptoSession: PeerCryptoSession,
    sendState: InternalSendState,
    initialTransport: TransportKind
  ): Promise<void> {
    const { session, inputs } = sendState;
    const resumeFromChunks = sendState.resumeFromChunks;
    let transport = initialTransport;
    let globalSentChunks = 0;
    let bytesSent = 0;
    let lastTickTs = Date.now();
    let lastTickBytes = 0;

    for (let fileIdx = 0; fileIdx < inputs.length; fileIdx++) {
      const input = inputs[fileIdx];
      const meta = session.files[fileIdx];
      // Highest contiguous chunk the receiver already has on disk; chunks
      // below it are skipped so an interrupted transfer resumes instead of
      // starting over.
      const resumeFrom = resumeFromChunks?.[fileIdx] ?? 0;
      const filePlainChunksForHash: Uint8Array[] = [];
      const canKeepFullHashInRam = input.size <= 128 * 1024 * 1024; // 128 MB

      // The declared digest must cover the whole file, so hash the skipped
      // prefix separately and prepend it to the chunks collected below.
      if (canKeepFullHashInRam && resumeFrom > 0) {
        for (let c = 0; c < resumeFrom; c++) {
          const start = c * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, input.size);
          filePlainChunksForHash.push(
            input.size === 0 ? new Uint8Array(0) : await input.sliceBytes(start, end)
          );
        }
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
          const start = chunkIdx * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, input.size);
          const plainChunk =
            input.size === 0 ? new Uint8Array(0) : await input.sliceBytes(start, end);
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

        // Respect socket buffer + receiver sliding-window backpressure
        while (!sendState.cancelled && globalSentChunks - sendState.ackedGlobalChunks >= MAX_UNACKED_CHUNKS) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 250);
            sendState.ackWaiters.push(() => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }
        if (sendState.cancelled) return;

        const { plainChunk, innerFrame } = await preparedChunks.get(chunkIdx)!;
        preparedChunks.delete(chunkIdx);
        launchPrepare(chunkIdx + ENCRYPT_PIPELINE_DEPTH);

        if (canKeepFullHashInRam) {
          filePlainChunksForHash.push(plainChunk);
        }

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
        bytesSent += plainChunk.byteLength;

        const now = Date.now();
        const elapsed = (now - lastTickTs) / 1000;
        if (elapsed >= 0.15 || chunkIdx === meta.totalChunks - 1) {
          const instantSpeed = elapsed > 0 ? (bytesSent - lastTickBytes) / elapsed : 0;
          session.speedBytesPerSec =
            session.speedBytesPerSec === 0
              ? instantSpeed
              : session.speedBytesPerSec * 0.65 + instantSpeed * 0.35;
          session.transferredBytes = Math.max(session.transferredBytes, bytesSent);
          const remaining = Math.max(0, session.totalBytes - session.transferredBytes);
          session.etaSeconds =
            session.speedBytesPerSec > 1024 ? Math.ceil(remaining / session.speedBytesPerSec) : null;
          lastTickTs = now;
          lastTickBytes = bytesSent;
          this.emit();
        }
      }

      const digest = canKeepFullHashInRam ? await sha256Hex(filePlainChunksForHash) : undefined;
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

    // When chunks streamed over WebRTC DataChannel, wait briefly for final receiver ACK
    // so control finalization over WebSocket does not outrace in-flight SCTP packets.
    if (transport === 'webrtc' && !sendState.cancelled && sendState.ackedGlobalChunks < globalSentChunks) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1_200);
        const checkAck = () => {
          if (sendState.cancelled || sendState.ackedGlobalChunks >= globalSentChunks) {
            clearTimeout(timeout);
            resolve();
          } else {
            sendState.ackWaiters.push(checkAck);
          }
        };
        sendState.ackWaiters.push(checkAck);
      });
    }
    if (sendState.cancelled) return;

    await this.sendControlMessage(
      peer.peerId,
      {
        kind: 'transfer-complete',
        transferId: session.transferId,
      },
      true
    );

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

  public async acceptIncomingTransfer(transferId: string): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState || recvState.session.status !== 'pending-accept') return;

    const peerId = recvState.session.peerId;
    const preferredTransport: TransportKind = this.canUseWebRtc() ? 'webrtc' : 'ws-relay';
    if (preferredTransport === 'webrtc') {
      this.initiateWebRtcIfPossible(peerId);
    }

    recvState.session.status = 'transferring';
    recvState.session.startedAt = Date.now();
    recvState.lastSpeedTs = Date.now();
    this.emit();

    let resumeFromChunks;
    if (this.canReceiveToDisk() && (await this.probeDiskApi())) {
      resumeFromChunks = await this.prepareDiskReceivers(recvState);
    }

    await this.sendControlMessage(
      peerId,
      {
        kind: 'transfer-accept',
        transferId,
        preferredTransport,
        ...(resumeFromChunks ? { resumeFromChunks } : {}),
      },
      true
    );
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

  private async queryDiskPartial(
    transferId: string,
    fileIndex: number
  ): Promise<{ receivedChunks: number[]; receivedBytes: number; receivedCount: number } | null> {
    try {
      const url = `${this.apiBaseUrl()}/api/daemon/received?transferId=${encodeURIComponent(transferId)}&fileIndex=${fileIndex}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        receivedChunks?: unknown;
        receivedBytes?: unknown;
        receivedCount?: unknown;
      };
      if (!Array.isArray(json.receivedChunks)) return null;
      return {
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
    const receivers = new Map<number, DiskFileReceiver>();
    const resume: Record<number, number> = {};
    let anyResume = false;

    for (const file of recvState.session.files) {
      const receiver = new DiskFileReceiver(
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
      let resumeFrom = 0;
      if (onDisk && onDisk.receivedChunks.length > 0) {
        const present = new Set(onDisk.receivedChunks);
        while (present.has(resumeFrom)) resumeFrom++;
        for (const idx of onDisk.receivedChunks) receiver.markReceived(idx);
        // Count the already-landed bytes so progress and completion checks
        // reflect the partial, not just the chunks received this session.
        recvState.receivedChunkCounts[file.index] = onDisk.receivedCount;
        recvState.bytesReceived += onDisk.receivedBytes;
      }
      if (resumeFrom > 0) {
        resume[file.index] = resumeFrom;
        anyResume = true;
      }
      receivers.set(file.index, receiver);
    }

    recvState.diskReceivers = receivers;
    return anyResume ? resume : undefined;
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
      for (const w of sendState.ackWaiters) w();
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
      this.sendServer({
        type: 'transfer-control',
        to: peerId,
        envelope: { encrypted: false, payload },
      });
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
    this.sendServer({
      type: 'transfer-control',
      to: peerId,
      envelope,
    });
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
        if (this.incomingStates.has(payload.transferId)) break;
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
          if (payload.resumeFromChunks && typeof payload.resumeFromChunks === 'object') {
            sendState.resumeFromChunks = payload.resumeFromChunks;
          }
          sendState.acceptResolver?.(payload.preferredTransport);
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
          for (const w of sendState.ackWaiters) w();
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
          // Compute cumulative global chunks acknowledged up to (fileIndex, ackedChunkIndex)
          let globalAcked = 0;
          for (let i = 0; i < payload.fileIndex; i++) {
            globalAcked += sendState.session.files[i]?.totalChunks ?? 0;
          }
          globalAcked += payload.ackedChunkIndex + 1;
          sendState.ackedGlobalChunks = Math.max(sendState.ackedGlobalChunks, globalAcked);
          sendState.session.transferredBytes = Math.max(
            sendState.session.transferredBytes,
            payload.bytesReceivedTotal
          );
          const waiters = sendState.ackWaiters.splice(0, sendState.ackWaiters.length);
          for (const w of waiters) w();
          this.emit();
        }
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
        await this.scheduleReceiveFinalization(payload.transferId, false);
        break;
      }

      case 'transfer-complete': {
        const recvState = this.incomingStates.get(payload.transferId);
        if (!recvState || recvState.session.peerId !== fromPeerId) break;
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
      if (!allChunksArrived && !forceFallback) continue;

      const diskReceiver = recvState.diskReceivers?.get(fileIndex);
      if (diskReceiver) {
        const diskResult = await diskReceiver.finalizeIfReady(forceFallback);
        if (!this.incomingStates.has(transferId)) return;
        if (!diskResult) {
          if (forceFallback) {
            hadDiskError = true;
            recvState.session.errorMessage =
              diskReceiver.getError() || 'Transfer incomplete: some chunks never arrived.';
          }
          continue;
        }
        const verified = completeMeta?.sha256
          ? diskResult.sha256 === completeMeta.sha256
          : allChunksArrived;
        recvState.session.receivedFiles.push({
          index: fileIndex,
          name: meta.name,
          relativePath: meta.relativePath,
          size: meta.size,
          mimeType: meta.mimeType,
          chunks: [],
          blobUrl: undefined,
          sha256: diskResult.sha256,
          verified,
          savedToMacPath: diskResult.savedPath,
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
        verified,
        savedToMacPath,
      });
      recvState.session.receivedFiles.sort((a, b) => a.index - b.index);
      recvState.finalizedFiles.add(fileIndex);
      this.emit();
    }

    if (recvState.transferCompleteReceived && this.incomingStates.has(transferId)) {
      if (recvState.finalizedFiles.size === totalFiles) {
        if (recvState.fallbackTimer) {
          clearTimeout(recvState.fallbackTimer);
          recvState.fallbackTimer = undefined;
        }
        recvState.session.transferredBytes = recvState.session.totalBytes;
        recvState.session.etaSeconds = 0;
        recvState.session.status = 'completed';
        recvState.session.completedAt = Date.now();
        this.incomingStates.delete(transferId);
        this.sortTransfers();
        this.persistTransferHistory();
        this.emit();
        this.opts.onTransferCompleted?.(recvState.session);
        const senderPeer = this.peers.find((p) => p.peerId === recvState.session.peerId);
        if (senderPeer) {
          this.syncHistoryWithPeer(senderPeer).catch(() => {});
        }
      } else if (hadDiskError) {
        if (recvState.fallbackTimer) {
          clearTimeout(recvState.fallbackTimer);
          recvState.fallbackTimer = undefined;
        }
        recvState.session.status = 'error';
        recvState.session.completedAt = Date.now();
        this.incomingStates.delete(transferId);
        this.sortTransfers();
        this.persistTransferHistory();
        this.emit();
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

    const diskReceiver = recvState.diskReceivers?.get(decoded.fileIndex);
    if (diskReceiver) {
      if (!diskReceiver.hasReceived(decoded.chunkIndex)) {
        diskReceiver.push(decoded.chunkIndex, plainBytes);
        recvState.receivedChunkCounts[decoded.fileIndex]++;
        recvState.bytesReceived += plainBytes.byteLength;
      }
    } else {
      const fileArr = recvState.fileChunks[decoded.fileIndex];
      if (!fileArr) return;

      if (!fileArr[decoded.chunkIndex]) {
        fileArr[decoded.chunkIndex] = plainBytes;
        recvState.receivedChunkCounts[decoded.fileIndex]++;
        recvState.bytesReceived += plainBytes.byteLength;
      }
    }

    recvState.session.transferredBytes = recvState.bytesReceived;

    const now = Date.now();
    const elapsed = (now - recvState.lastSpeedTs) / 1000;
    if (elapsed >= 0.15) {
      const instant = (recvState.bytesReceived - recvState.lastSpeedBytes) / elapsed;
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

    const meta = recvState.session.files[decoded.fileIndex];
    const isLastChunk = meta && decoded.chunkIndex === meta.totalChunks - 1;
    if (decoded.chunkIndex % ACK_INTERVAL_CHUNKS === 0 || isLastChunk) {
      // Fire-and-forget: ACKs are infrequent now (every 8 MiB), and awaiting
      // their AES-GCM encryption here would stall this chunk's decrypt slot
      // in the receive pipeline behind control-channel latency.
      void this.sendControlMessage(
        fromPeerId,
        {
          kind: 'chunk-ack',
          transferId: decoded.transferId,
          fileIndex: decoded.fileIndex,
          ackedChunkIndex: decoded.chunkIndex,
          bytesReceivedTotal: recvState.bytesReceived,
        },
        true
      ).catch(() => {});
    }

    if (
      meta &&
      recvState.receivedChunkCounts[decoded.fileIndex] >= meta.totalChunks &&
      (recvState.fileCompletePayloads.has(decoded.fileIndex) || recvState.transferCompleteReceived)
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
      throw new Error('Signaling relay socket disconnected');
    }
    while (this.ws.bufferedAmount > MAX_BUFFER_HIGH_WATER) {
      if (this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('Signaling relay socket disconnected');
      }
      // Short poll: browsers expose no drain event for WebSocket, and a
      // 15 ms nap here used to cap relay throughput far below link speed.
      await new Promise((r) => setTimeout(r, 3));
    }
    const routed = wrapRoutedRelayFrame(targetPeerId, this.peerId, innerFrame);
    this.ws.send(routed);
  }

  private sendServer(msg: ClientToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
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

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}
