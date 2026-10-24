import {
  type ClientToServerMessage,
  type ControlPayload,
  type DeviceProfile,
  type FileManifestItem,
  type LocalDaemonStatus,
  type PeerSummary,
  type ServerToClientMessage,
  type TransportKind,
  type VisibilityMode,
  classifyTextPayload,
  decodeEncryptedChunkFrame,
  encodeEncryptedChunkFrame,
  formatPairCode,
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

export const CHUNK_SIZE = 64 * 1024; // 64 KB optimal for both WebRTC SCTP & WS Binary Relay
const MAX_UNACKED_CHUNKS = 48; // 3 MB sliding window
const ACK_INTERVAL_CHUNKS = 8;
const MAX_BUFFER_HIGH_WATER = 2 * 1024 * 1024; // 2 MB socket buffer threshold

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
  contentType: 'url' | 'otp' | 'code' | 'text';
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
}

export interface WarpClientOptions {
  wsUrl?: string;
  initialPairCode?: string;
  storagePrefix?: string;
  deviceOverride?: Omit<DeviceProfile, 'publicKey'>;
  enableWebRtc?: boolean;
  autoAcceptAll?: boolean;
  onIncomingTransfer?: (transfer: TransferSessionView) => void;
  onIncomingClipboard?: (item: ClipboardBeamItem) => void;
  onTransferCompleted?: (transfer: TransferSessionView) => void;
}

interface InternalReceiveState {
  session: TransferSessionView;
  fileChunks: Uint8Array[][];
  receivedChunkCounts: number[];
  bytesReceived: number;
  lastSpeedTs: number;
  lastSpeedBytes: number;
}

interface InternalSendState {
  session: TransferSessionView;
  inputs: SendableFileInput[];
  ackedGlobalChunks: number;
  ackWaiters: Array<() => void>;
  cancelled: boolean;
  acceptResolver?: (transport: TransportKind) => void;
  acceptRejecter?: (reason: Error) => void;
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

  constructor(opts: WarpClientOptions = {}) {
    this.opts = opts;
    this.storagePrefix = opts.storagePrefix ?? 'airbridge';

    // Restore persisted pairCode & trusted devices if in browser
    try {
      if (typeof localStorage !== 'undefined') {
        const storedPair = localStorage.getItem(`${this.storagePrefix}:pairCode`);
        if (opts.initialPairCode) {
          this.pairCode = normalizePairCode(opts.initialPairCode);
        } else if (storedPair) {
          this.pairCode = normalizePairCode(storedPair);
        }
        const trustedRaw = localStorage.getItem(`${this.storagePrefix}:trustedKeys`);
        if (trustedRaw) {
          for (const k of JSON.parse(trustedRaw) as string[]) {
            this.trustedPeerKeys.add(k);
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

    if (this.opts.deviceOverride) {
      this.myDevice = {
        ...this.opts.deviceOverride,
        publicKey: this.keys.publicKeyB64,
      };
    } else if (deviceFactory) {
      this.myDevice = deviceFactory(this.keys.publicKeyB64);
    } else {
      this.myDevice = {
        name: 'AirBridge Peer',
        platform: 'unknown',
        model: 'Device',
        formFactor: 'laptop',
        publicKey: this.keys.publicKeyB64,
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
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          `${this.storagePrefix}:trustedKeys`,
          JSON.stringify(Array.from(this.trustedPeerKeys))
        );
      }
    } catch {
      // ignore
    }
    this.emit();
  }

  // ==========================================================================
  // Universal Clipboard / Text & Link Instant Beam
  // ==========================================================================

  public async sendClipboard(peerId: string, text: string): Promise<ClipboardBeamItem> {
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      throw new Error('Selected peer is no longer online.');
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Cannot beam empty text.');
    }

    const cryptoSession = await this.ensureCryptoSession(peer);
    const beamId = randomHex16();
    const contentType = classifyTextPayload(trimmed);
    const timestamp = Date.now();

    await this.sendControlMessage(
      peerId,
      {
        kind: 'clipboard-beam',
        beamId,
        text: trimmed,
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
      contentType,
      timestamp,
      sasCode: cryptoSession.sasCode,
    };
    this.clipboardItems = [item, ...this.clipboardItems].slice(0, 50);
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
        session.errorMessage = err instanceof Error ? err.message : 'Transfer interrupted';
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
    let transport = initialTransport;
    let globalSentChunks = 0;
    let bytesSent = 0;
    let lastTickTs = Date.now();
    let lastTickBytes = 0;

    for (let fileIdx = 0; fileIdx < inputs.length; fileIdx++) {
      const input = inputs[fileIdx];
      const meta = session.files[fileIdx];
      const filePlainChunksForHash: Uint8Array[] = [];
      const canKeepFullHashInRam = input.size <= 128 * 1024 * 1024; // 128 MB

      for (let chunkIdx = 0; chunkIdx < meta.totalChunks; chunkIdx++) {
        if (sendState.cancelled) return;

        const start = chunkIdx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, input.size);
        const plainChunk =
          input.size === 0 ? new Uint8Array(0) : await input.sliceBytes(start, end);

        if (canKeepFullHashInRam) {
          filePlainChunksForHash.push(plainChunk);
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

        // Send over WebRTC DataChannel if open; seamlessly fall back to WS Binary Relay if closed!
        if (transport === 'webrtc' && this.isRtcOpen(peer.peerId)) {
          await this.sendRtcBinaryWithBackpressure(peer.peerId, innerFrame);
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
    this.emit();
    this.opts.onTransferCompleted?.(session);
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

    await this.sendControlMessage(
      peerId,
      {
        kind: 'transfer-accept',
        transferId,
        preferredTransport,
      },
      true
    );
  }

  public async declineIncomingTransfer(transferId: string): Promise<void> {
    const recvState = this.incomingStates.get(transferId);
    if (!recvState) return;
    recvState.session.status = 'declined';
    this.incomingStates.delete(transferId);
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
      sendState.acceptRejecter?.(new Error('Cancelled'));
      for (const w of sendState.ackWaiters) w();
      this.outgoingStates.delete(transferId);
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
      recvState.session.status = 'cancelled';
      this.incomingStates.delete(transferId);
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
      this.connectionState = 'connected';
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
        this.handleIncomingControl(msg.from, msg.envelope).catch(() => {});
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
        const session = this.cryptoSessions.get(fromPeerId);
        const item: ClipboardBeamItem = {
          beamId: payload.beamId,
          peerId: fromPeerId,
          peerName: peer?.device.name ?? 'Paired Device',
          direction: 'incoming',
          text: payload.text,
          contentType: payload.contentType,
          timestamp: payload.timestamp,
          sasCode: session?.sasCode ?? '··· ···',
        };
        this.clipboardItems = [item, ...this.clipboardItems].slice(0, 50);
        this.emit();
        this.opts.onIncomingClipboard?.(item);
        break;
      }

      case 'transfer-offer': {
        const session = this.cryptoSessions.get(fromPeerId);
        const view: TransferSessionView = {
          transferId: payload.transferId,
          peerId: fromPeerId,
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
          fileChunks: payload.files.map((f) => new Array<Uint8Array>(f.totalChunks)),
          receivedChunkCounts: payload.files.map(() => 0),
          bytesReceived: 0,
          lastSpeedTs: Date.now(),
          lastSpeedBytes: 0,
        };

        this.incomingStates.set(payload.transferId, recvState);
        this.transfers = [view, ...this.transfers];
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
        if (sendState) {
          sendState.acceptResolver?.(payload.preferredTransport);
        }
        break;
      }

      case 'transfer-decline': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState) {
          sendState.cancelled = true;
          sendState.session.status = 'declined';
          sendState.acceptRejecter?.(new Error('Declined by recipient'));
          this.outgoingStates.delete(payload.transferId);
          this.emit();
        }
        break;
      }

      case 'transfer-cancel': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState) {
          sendState.cancelled = true;
          sendState.session.status = 'cancelled';
          sendState.acceptRejecter?.(new Error('Cancelled'));
          for (const w of sendState.ackWaiters) w();
          this.outgoingStates.delete(payload.transferId);
          this.emit();
        }
        const recvState = this.incomingStates.get(payload.transferId);
        if (recvState) {
          recvState.session.status = 'cancelled';
          this.incomingStates.delete(payload.transferId);
          this.emit();
        }
        break;
      }

      case 'chunk-ack': {
        const sendState = this.outgoingStates.get(payload.transferId);
        if (sendState) {
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
        if (!recvState) break;
        const meta = recvState.session.files[payload.fileIndex];
        const chunks = recvState.fileChunks[payload.fileIndex] ?? [];
        const cleanChunks = chunks.map((c) => c ?? new Uint8Array(0));
        const computedHash = await sha256Hex(cleanChunks);
        const verified = payload.sha256 ? computedHash === payload.sha256 : true;

        let blobUrl: string | undefined;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof document !== 'undefined') {
          const blob = new Blob(cleanChunks as BlobPart[], { type: meta.mimeType });
          blobUrl = URL.createObjectURL(blob);
        }

        let savedToMacPath: string | undefined;
        if (this.localDaemon.enabled && this.localDaemon.autoSaveToDownloads && typeof fetch === 'function') {
          try {
            const blob = new Blob(cleanChunks as BlobPart[], { type: 'application/octet-stream' });
            const resp = await fetch('/api/daemon/save', {
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

        recvState.session.receivedFiles.push({
          index: payload.fileIndex,
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
        this.emit();
        break;
      }

      case 'transfer-complete': {
        const recvState = this.incomingStates.get(payload.transferId);
        if (!recvState) break;
        recvState.session.transferredBytes = recvState.session.totalBytes;
        recvState.session.etaSeconds = 0;
        recvState.session.status = 'completed';
        recvState.session.completedAt = Date.now();
        this.incomingStates.delete(payload.transferId);
        this.emit();
        this.opts.onTransferCompleted?.(recvState.session);
        break;
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

    const cryptoSession = this.cryptoSessions.get(fromPeerId);
    if (!cryptoSession) return;

    const plainBytes = await decryptBinaryChunk(
      cryptoSession.aesKey,
      decoded.iv,
      decoded.ciphertext
    );

    recvState.session.transport = transport;
    const fileArr = recvState.fileChunks[decoded.fileIndex];
    if (!fileArr) return;

    if (!fileArr[decoded.chunkIndex]) {
      fileArr[decoded.chunkIndex] = plainBytes;
      recvState.receivedChunkCounts[decoded.fileIndex]++;
      recvState.bytesReceived += plainBytes.byteLength;
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
      await this.sendControlMessage(
        fromPeerId,
        {
          kind: 'chunk-ack',
          transferId: decoded.transferId,
          fileIndex: decoded.fileIndex,
          ackedChunkIndex: decoded.chunkIndex,
          bytesReceivedTotal: recvState.bytesReceived,
        },
        true
      );
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
    dc.bufferedAmountLowThreshold = 512 * 1024;
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
    if (dc.bufferedAmount > MAX_BUFFER_HIGH_WATER) {
      await new Promise<void>((resolve) => {
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(() => {
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        }, 200);
        dc.addEventListener('bufferedamountlow', onLow);
      });
    }
    const copy = new Uint8Array(frame.byteLength);
    copy.set(frame);
    dc.send(copy.buffer);
  }

  private async sendWsRelayBinaryWithBackpressure(
    targetPeerId: string,
    innerFrame: Uint8Array
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Signaling relay socket disconnected');
    }
    while (this.ws.bufferedAmount > MAX_BUFFER_HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 15));
    }
    const routed = wrapRoutedRelayFrame(targetPeerId, this.peerId, innerFrame);
    this.ws.send(routed);
  }

  private sendServer(msg: ClientToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private persistPairCode(code: string): void {
    try {
      if (typeof localStorage !== 'undefined' && code) {
        localStorage.setItem(`${this.storagePrefix}:pairCode`, code);
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
