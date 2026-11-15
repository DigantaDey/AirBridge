import WebSocket from 'ws';
import type {
  ClientToServerMessage,
  ControlPayload,
  DeviceProfile,
  EncryptedEnvelope,
  FormFactor,
  PeerSummary,
  PlatformType,
  ServerToClientMessage,
  VisibilityMode,
} from '../../../src/shared/protocol.js';
import {
  derivePeerSession,
  generateIdentityKeyPair,
  encryptControlPayload,
  decryptControlPayload,
  encryptBinaryChunk,
  decryptBinaryChunk,
  type IdentityKeys,
  type PeerCryptoSession,
} from './wireCrypto.js';
import {
  decodeBinarySackFrame,
  decodeCanonicalBinarySackFrame,
  decodeEncryptedChunkFrame,
  encodeBinarySackFrame,
  encodeCanonicalBinarySackFrame,
  encodeEncryptedChunkFrame,
  FRAME_ENCRYPTED_CHUNK,
  FRAME_ROUTED_RELAY,
  isBinarySackFrame,
  unwrapRoutedRelayFrame,
  wrapRoutedRelayFrame,
  type BinarySackFrame,
  type EncryptedChunkFrame,
} from './frameCodec.js';

export interface OpaquePeerOptions {
  name?: string;
  platform?: PlatformType;
  model?: string;
  formFactor?: FormFactor;
  deviceId?: string;
  pairCode?: string;
  visibility?: VisibilityMode;
  identity?: IdentityKeys;
}

export interface DecryptedControlEvent {
  from: string;
  payload: ControlPayload;
}

export interface DecryptedChunkEvent {
  sourcePeerId: string;
  frame: EncryptedChunkFrame;
  plaintext: Uint8Array;
}

export interface BinarySackEvent {
  sourcePeerId: string;
  frame: BinarySackFrame;
  canonical?: BinarySackFrame;
  rawBytes?: Uint8Array;
}

function randomHex(lengthBytes: number): string {
  const bytes = new Uint8Array(lengthBytes);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * An opaque, network-level test peer simulating Android native clients
 * or Desktop clients communicating over WebSocket and protocol framing.
 */
export class OpaquePeer {
  public peerId = '';
  public pairCode = '';
  public visibility: VisibilityMode;
  public device: DeviceProfile;
  public identity: IdentityKeys;
  public ws: WebSocket | null = null;
  public isConnected = false;
  public discoveredPeers: PeerSummary[] = [];

  private sessions = new Map<string, PeerCryptoSession>();
  private controlHistory: DecryptedControlEvent[] = [];
  private chunkHistory: DecryptedChunkEvent[] = [];
  private sackHistory: BinarySackEvent[] = [];
  private rawMessageHistory: ServerToClientMessage[] = [];

  private pendingControlWaiters: Array<{
    predicate: (event: DecryptedControlEvent) => boolean;
    resolve: (val: DecryptedControlEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private pendingChunkWaiters: Array<{
    predicate: (event: DecryptedChunkEvent) => boolean;
    resolve: (val: DecryptedChunkEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private pendingSackWaiters: Array<{
    predicate: (event: BinarySackEvent) => boolean;
    resolve: (val: BinarySackEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private pendingMessageWaiters: Array<{
    predicate: (msg: ServerToClientMessage) => boolean;
    resolve: (val: ServerToClientMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private pendingPeerWaiters: Array<{
    predicate: (peer: PeerSummary) => boolean;
    resolve: (val: PeerSummary) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(options: {
    device: DeviceProfile;
    identity: IdentityKeys;
    visibility: VisibilityMode;
    pairCode?: string;
  }) {
    this.device = options.device;
    this.identity = options.identity;
    this.visibility = options.visibility;
    this.pairCode = options.pairCode ?? '';
  }

  /**
   * Factory method to construct and initialize an OpaquePeer with fresh P-256 keys.
   */
  public static async create(options: OpaquePeerOptions = {}): Promise<OpaquePeer> {
    const identity = options.identity ?? (await generateIdentityKeyPair());
    const platform = options.platform ?? 'android';
    const formFactor = options.formFactor ?? (platform === 'android' ? 'phone' : 'laptop');
    const deviceId = options.deviceId ?? randomHex(8);
    const name = options.name ?? (platform === 'android' ? 'Pixel 9 Pro · Pocket' : 'MacBook Pro · Studio');
    const model = options.model ?? (platform === 'android' ? 'Pixel 9 Pro' : 'MacBook');

    const device: DeviceProfile = {
      name,
      platform,
      model,
      formFactor,
      publicKey: identity.publicKeyB64,
      deviceId,
    };

    return new OpaquePeer({
      device,
      identity,
      visibility: options.visibility ?? 'nearby',
      pairCode: options.pairCode,
    });
  }

  /**
   * Connects to the WebSocket server at wsUrl and completes the `hello` / `welcome` handshake.
   */
  public async connect(
    wsUrl: string,
    preferredPeerId?: string,
    wsOptions?: WebSocket.ClientOptions
  ): Promise<ServerToClientMessage & { type: 'welcome' }> {
    return new Promise<ServerToClientMessage & { type: 'welcome' }>((resolve, reject) => {
      const ws = wsOptions ? new WebSocket(wsUrl, wsOptions) : new WebSocket(wsUrl);
      this.ws = ws;

      const connectTimeout = setTimeout(() => {
        reject(new Error(`OpaquePeer connection to ${wsUrl} timed out after 5000ms`));
        try {
          ws.close();
        } catch (_err) {}
      }, 5000);

      ws.on('open', () => {
        this.isConnected = true;
        const helloMsg: ClientToServerMessage = {
          type: 'hello',
          ...(preferredPeerId ? { peerId: preferredPeerId } : {}),
          device: this.device,
          visibility: this.visibility,
          pairCode: this.pairCode || undefined,
        };
        ws.send(JSON.stringify(helloMsg));
      });

      ws.on('error', (err) => {
        if (!this.isConnected) {
          clearTimeout(connectTimeout);
          reject(err);
        }
      });

      ws.on('close', () => {
        this.isConnected = false;
      });

      ws.on('message', async (data: WebSocket.RawData, isBinary: boolean) => {
        try {
          if (!isBinary) {
            const rawText = data.toString('utf8');
            const msg = JSON.parse(rawText) as ServerToClientMessage;

            if (msg.type === 'welcome') {
              clearTimeout(connectTimeout);
              this.peerId = msg.peerId;
              this.pairCode = msg.pairCode;
              this.discoveredPeers = msg.peers;
              await this.deriveSessionsForPeers(msg.peers);
              this.dispatchPeerWaiters(msg.peers);
              resolve(msg);
            } else if (msg.type === 'peers') {
              this.discoveredPeers = msg.peers;
              await this.deriveSessionsForPeers(msg.peers);
              this.dispatchPeerWaiters(msg.peers);
            } else if (msg.type === 'pair-updated') {
              this.pairCode = msg.pairCode;
              this.discoveredPeers = msg.peers;
              await this.deriveSessionsForPeers(msg.peers);
              this.dispatchPeerWaiters(msg.peers);
            } else if (msg.type === 'transfer-control') {
              await this.handleIncomingControl(msg.from, msg.envelope);
            }

            this.rawMessageHistory.push(msg);
            this.dispatchMessageWaiters(msg);
          } else {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
            await this.handleIncomingBinary(bytes);
          }
        } catch (err) {
          console.error('[OpaquePeer] Error handling incoming WebSocket message:', err);
        }
      });
    });
  }

  private async deriveSessionsForPeers(peers: PeerSummary[]): Promise<void> {
    for (const peer of peers) {
      if (peer.peerId !== this.peerId && !this.sessions.has(peer.peerId)) {
        try {
          const session = await derivePeerSession(
            this.identity.privateKey,
            this.identity.publicKeyB64,
            peer.device.publicKey
          );
          this.sessions.set(peer.peerId, session);
        } catch (_err) {
          // If public key is invalid or peer has not yet provided ECDH key
        }
      }
    }
  }

  private async handleIncomingControl(
    from: string,
    envelope: EncryptedEnvelope | { encrypted: false; payload: ControlPayload }
  ): Promise<void> {
    let payload: ControlPayload;
    if (envelope.encrypted) {
      const session = await this.getSession(from);
      payload = await decryptControlPayload(session.aesKey, envelope);
    } else {
      payload = envelope.payload;
    }

    const event: DecryptedControlEvent = { from, payload };
    this.controlHistory.push(event);

    for (let i = this.pendingControlWaiters.length - 1; i >= 0; i--) {
      const waiter = this.pendingControlWaiters[i];
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        this.pendingControlWaiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  }

  private async handleIncomingBinary(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength >= 33 && bytes[0] === FRAME_ROUTED_RELAY) {
      const routed = unwrapRoutedRelayFrame(bytes);
      const inner = routed.payload;

      if (inner.byteLength >= 37 && inner[0] === FRAME_ENCRYPTED_CHUNK) {
        const frame = decodeEncryptedChunkFrame(inner);
        const session = await this.getSession(routed.sourcePeerId);
        const plaintext = await decryptBinaryChunk(session.aesKey, frame.iv, frame.ciphertext);
        const event: DecryptedChunkEvent = {
          sourcePeerId: routed.sourcePeerId,
          frame,
          plaintext,
        };
        this.chunkHistory.push(event);

        for (let i = this.pendingChunkWaiters.length - 1; i >= 0; i--) {
          const waiter = this.pendingChunkWaiters[i];
          if (waiter.predicate(event)) {
            clearTimeout(waiter.timer);
            this.pendingChunkWaiters.splice(i, 1);
            waiter.resolve(event);
          }
        }
      } else if (isBinarySackFrame(inner)) {
        const frame = decodeBinarySackFrame(inner);
        let canonical: BinarySackFrame | undefined;
        try {
          canonical = decodeCanonicalBinarySackFrame(inner);
        } catch {
          canonical = undefined;
        }
        const event: BinarySackEvent = {
          sourcePeerId: routed.sourcePeerId,
          frame,
          canonical,
          rawBytes: inner,
        };
        this.sackHistory.push(event);

        for (let i = this.pendingSackWaiters.length - 1; i >= 0; i--) {
          const waiter = this.pendingSackWaiters[i];
          if (waiter.predicate(event)) {
            clearTimeout(waiter.timer);
            this.pendingSackWaiters.splice(i, 1);
            waiter.resolve(event);
          }
        }
      }
    }
  }

  private dispatchPeerWaiters(peers: PeerSummary[]): void {
    for (const peer of peers) {
      for (let i = this.pendingPeerWaiters.length - 1; i >= 0; i--) {
        const waiter = this.pendingPeerWaiters[i];
        if (waiter.predicate(peer)) {
          clearTimeout(waiter.timer);
          this.pendingPeerWaiters.splice(i, 1);
          waiter.resolve(peer);
        }
      }
    }
  }

  private dispatchMessageWaiters(msg: ServerToClientMessage): void {
    for (let i = this.pendingMessageWaiters.length - 1; i >= 0; i--) {
      const waiter = this.pendingMessageWaiters[i];
      if (waiter.predicate(msg)) {
        clearTimeout(waiter.timer);
        this.pendingMessageWaiters.splice(i, 1);
        waiter.resolve(msg);
      }
    }
  }

  /**
   * Retrieves or derives the E2EE session for the given peerId.
   */
  public async getSession(peerId: string): Promise<PeerCryptoSession> {
    const existing = this.sessions.get(peerId);
    if (existing) return existing;

    const peer = this.discoveredPeers.find((p) => p.peerId === peerId);
    if (!peer) {
      throw new Error(`Cannot derive session: peer ${peerId} is not in discovered peers`);
    }

    const session = await derivePeerSession(
      this.identity.privateKey,
      this.identity.publicKeyB64,
      peer.device.publicKey
    );
    this.sessions.set(peerId, session);
    return session;
  }

  /**
   * Returns the SAS code derived between this peer and the target peer.
   */
  public async getSasCode(peerId: string): Promise<string> {
    const session = await this.getSession(peerId);
    return session.sasCode;
  }

  /**
   * Joins a room by pair code and returns the updated room code.
   */
  public async joinPair(pairCode: string): Promise<{ pairCode: string }> {
    if (!this.ws) throw new Error('Not connected');
    this.ws.send(JSON.stringify({ type: 'join-pair', pairCode }));
    const msg = (await this.waitForMessage(
      (m) => m.type === 'pair-updated' && m.pairCode === pairCode
    )) as ServerToClientMessage & { type: 'pair-updated' };
    return { pairCode: msg.pairCode };
  }

  /**
   * Requests a pair rotation and returns the new 6-character room code.
   */
  public async rotatePair(): Promise<string> {
    if (!this.ws) throw new Error('Not connected');
    this.ws.send(JSON.stringify({ type: 'rotate-pair' }));
    const msg = (await this.waitForMessage(
      (m) => m.type === 'pair-updated'
    )) as ServerToClientMessage & { type: 'pair-updated' };
    return msg.pairCode;
  }

  /** Convenience wrapper returning `{ pairCode }` for pairing-dock tests. */
  public async rotatePairCode(): Promise<{ pairCode: string }> {
    const pairCode = await this.rotatePair();
    return { pairCode };
  }

  /** Updates this peer's announced profile and visibility with the signaling hub. */
  public async updateProfile(
    patch: Partial<Pick<DeviceProfile, 'name' | 'model' | 'formFactor'>> & {
      visibility?: VisibilityMode;
    }
  ): Promise<void> {
    if (!this.ws) throw new Error('Not connected');
    this.device = {
      ...this.device,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.formFactor !== undefined ? { formFactor: patch.formFactor } : {}),
    };
    if (patch.visibility !== undefined) {
      this.visibility = patch.visibility;
    }
    this.ws.send(
      JSON.stringify({
        type: 'update-profile',
        device: this.device,
        visibility: this.visibility,
      } satisfies ClientToServerMessage)
    );
  }

  /**
   * Sends an encrypted or unencrypted transfer-control message to the target peer.
   */
  public async sendControl(
    targetPeerId: string,
    payload: ControlPayload,
    unencrypted = false
  ): Promise<void> {
    if (!this.ws) throw new Error('Not connected');
    if (unencrypted) {
      this.ws.send(
        JSON.stringify({
          type: 'transfer-control',
          to: targetPeerId,
          envelope: { encrypted: false, payload },
        })
      );
    } else {
      const session = await this.getSession(targetPeerId);
      const envelope = await encryptControlPayload(session.aesKey, payload);
      this.ws.send(
        JSON.stringify({
          type: 'transfer-control',
          to: targetPeerId,
          envelope,
        })
      );
    }
  }

  /**
   * Encrypts and transmits a binary chunk payload wrapped in a 0x02 routed relay frame.
   */
  public async sendChunk(
    targetPeerId: string,
    transferId: string,
    fileIndex: number,
    chunkIndex: number,
    plaintext: Uint8Array
  ): Promise<void> {
    if (!this.ws) throw new Error('Not connected');
    const session = await this.getSession(targetPeerId);
    const { iv, ciphertext } = await encryptBinaryChunk(session.aesKey, plaintext);
    const chunkFrame = encodeEncryptedChunkFrame({
      transferId,
      fileIndex,
      chunkIndex,
      iv,
      ciphertext,
    });
    const routed = wrapRoutedRelayFrame(targetPeerId, this.peerId, chunkFrame);
    this.ws.send(routed);
  }

  /**
   * Sends a 16-byte compact binary SACK frame wrapped in a 0x02 routed relay frame.
   */
  public async sendBinarySack(
    targetPeerId: string,
    transferId: string,
    fileIndex: number,
    chunkIndex: number,
    windowSize: number,
    bitmask = 0
  ): Promise<void> {
    if (!this.ws) throw new Error('Not connected');
    const sackPayload = encodeBinarySackFrame({
      fileIndex,
      chunkIndex,
      windowSize,
      bitmask,
    });
    const routed = wrapRoutedRelayFrame(targetPeerId, this.peerId, sackPayload);
    this.ws.send(routed);
  }

  /**
   * Sends a canonical wire 16-byte binary SACK frame (0x03) wrapped in 0x02 relay.
   */
  public async sendCanonicalBinarySack(
    targetPeerId: string,
    transferId: string,
    fileIndex: number,
    chunkIndex: number,
    bitmask = 0
  ): Promise<void> {
    if (!this.ws) throw new Error('Not connected');
    const sackPayload = encodeCanonicalBinarySackFrame({
      transferId,
      fileIndex,
      chunkIndex,
      bitmask,
    });
    if (!sackPayload) {
      throw new Error(`Invalid canonical SACK parameters: transferId=${transferId}`);
    }
    const routed = wrapRoutedRelayFrame(targetPeerId, this.peerId, sackPayload);
    this.ws.send(routed);
  }

  /**
   * Sends raw string or binary buffer directly onto the wire (e.g. for malformed/tampered tests).
   */
  public sendRaw(data: string | Uint8Array): void {
    if (!this.ws) throw new Error('Not connected');
    this.ws.send(data);
  }

  /**
   * Waits for a peer matching the predicate to be discovered in this room.
   */
  public async waitForPeer(
    predicate: (peer: PeerSummary) => boolean,
    timeoutMs = 5000
  ): Promise<PeerSummary> {
    const existing = this.discoveredPeers.find(predicate);
    if (existing) return existing;

    return new Promise<PeerSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingPeerWaiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.pendingPeerWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for peer matching condition after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingPeerWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Waits for an incoming decrypted transfer-control payload matching the predicate.
   */
  public async waitForControl(
    predicate: (event: DecryptedControlEvent) => boolean,
    timeoutMs = 5000
  ): Promise<DecryptedControlEvent> {
    const existing = this.controlHistory.find(predicate);
    if (existing) return existing;

    return new Promise<DecryptedControlEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingControlWaiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.pendingControlWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for control message after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingControlWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Waits for an incoming decrypted binary chunk matching the predicate.
   */
  public async waitForChunk(
    predicate: (event: DecryptedChunkEvent) => boolean,
    timeoutMs = 5000
  ): Promise<DecryptedChunkEvent> {
    const existing = this.chunkHistory.find(predicate);
    if (existing) return existing;

    return new Promise<DecryptedChunkEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingChunkWaiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.pendingChunkWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for binary chunk after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingChunkWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Waits for an incoming binary SACK frame matching the predicate.
   */
  public async waitForSack(
    predicate: (event: BinarySackEvent) => boolean,
    timeoutMs = 5000
  ): Promise<BinarySackEvent> {
    const existing = this.sackHistory.find(predicate);
    if (existing) return existing;

    return new Promise<BinarySackEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingSackWaiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.pendingSackWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for binary SACK frame after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingSackWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Waits for a server message matching the predicate.
   */
  public async waitForMessage(
    predicate: (msg: ServerToClientMessage) => boolean,
    timeoutMs = 5000
  ): Promise<ServerToClientMessage> {
    const existing = this.rawMessageHistory.find(predicate);
    if (existing) return existing;

    return new Promise<ServerToClientMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingMessageWaiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.pendingMessageWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for server message after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingMessageWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Cleanly disconnects the peer and cancels any pending waiters.
   */
  public async disconnect(): Promise<void> {
    for (const w of this.pendingControlWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Peer disconnected'));
    }
    this.pendingControlWaiters = [];

    for (const w of this.pendingChunkWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Peer disconnected'));
    }
    this.pendingChunkWaiters = [];

    for (const w of this.pendingSackWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Peer disconnected'));
    }
    this.pendingSackWaiters = [];

    for (const w of this.pendingMessageWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Peer disconnected'));
    }
    this.pendingMessageWaiters = [];

    for (const w of this.pendingPeerWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Peer disconnected'));
    }
    this.pendingPeerWaiters = [];

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_err) {}
      this.ws = null;
    }
    this.isConnected = false;
  }
}
