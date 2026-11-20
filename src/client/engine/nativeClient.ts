import type { DeviceProfile, VisibilityMode } from '../../shared/protocol.js';
import { WarpClient, type ClipboardBeamItem, type SendableFileInput, type TransferSessionView, type WarpClientDiagnostics, type WarpClientOptions, type WarpClientSnapshot } from './warpClient.js';
import type { AirBridgeNativeBridge } from './nativeShell.js';
import type { CallAudioFrame, CallCommandResult, ContactShareItem, ContactsQueryResult, ScreenFrameSource } from './continuity.js';

/** Public client contract shared by the browser peer and Android's metadata UI. */
export type AirBridgeClient = Pick<WarpClient, keyof WarpClient>;

export function hasNativeEngine(): boolean {
  return typeof window !== 'undefined' && window.AirBridgeAndroid?.nativeEngineVersion?.() === 1;
}

export function createAirBridgeClient(options: WarpClientOptions): AirBridgeClient {
  return hasNativeEngine() ? new NativeClient(window.AirBridgeAndroid!, options) : new WarpClient(options);
}

/**
 * No sockets, crypto, file chunks, or transfer timers live here. Suspending or
 * destroying this UI only detaches a subscriber from the service-owned peer.
 */
export class NativeClient implements AirBridgeClient {
  private readonly listeners = new Set<(snapshot: WarpClientSnapshot) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private seeded = false;
  private lastJson = '';
  private revision = -1;
  private clipboardRevision = -1;
  private lastSynced = '';
  private snapshot: WarpClientSnapshot = {
    connectionState: 'connecting', peerId: '', pairCode: '', formattedPairCode: '', visibility: 'nearby',
    myDevice: null, lanUrls: [], localDaemon: { enabled: false, platform: 'android', hostname: '', autoSaveToDownloads: true, clipboardBridge: true },
    peers: [], peerSecurity: {}, transfers: [], clipboardItems: [], trustedPeerKeys: [], autoClipboardSync: true, clipboardReceiveEnabled: true, notificationSharing: true,
  };

  constructor(private readonly bridge: AirBridgeNativeBridge, private readonly options: WarpClientOptions = {}) {}

  async start(deviceFactory?: (publicKeyB64: string) => DeviceProfile): Promise<void> {
    void deviceFactory;
    this.stopped = false;
    if (!this.bridge.engineAttach?.()) throw new Error('Pair with a computer to start the native connection.');
    const deadline = Date.now() + 10_000;
    while (!this.stopped && !this.readSnapshot()) {
      if (Date.now() >= deadline) throw new Error('The Android connection service did not start. Reopen AirBridge.');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (this.stopped) return;
    if (this.options.initialPairCode) this.joinPairCode(this.options.initialPairCode);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    document.removeEventListener('visibilitychange', this.onVisibility);
    // Intentionally no engine-stop command. React remounts, Back and renderer
    // recovery must never cancel a service-owned transfer.
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible' && !this.stopped) this.readSnapshot();
  };

  private schedule(): void {
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      if (document.visibilityState !== 'hidden') this.readSnapshot();
      this.schedule();
    }, 250);
  }

  private readSnapshot(): boolean {
    try {
      const raw = this.bridge.engineSnapshot?.(this.revision, this.clipboardRevision) || '';
      if (!raw) return this.seeded;
      if (raw === this.lastJson) return this.seeded;
      const next = JSON.parse(raw) as WarpClientSnapshot & { ready?: boolean; revision?: number; clipboardRevision?: number };
      if (!next.ready) return false;
      const previous = this.snapshot;
      if (!next.clipboardItems) next.clipboardItems = previous.clipboardItems;
      this.revision = next.revision ?? this.revision;
      this.clipboardRevision = next.clipboardRevision ?? this.clipboardRevision;
      this.snapshot = next;
      this.lastJson = raw;
      for (const transfer of next.transfers) {
        const old = previous.transfers.find((item) => item.transferId === transfer.transferId);
        if (transfer.direction === 'incoming' && transfer.status === 'pending-accept' && !old) {
          this.options.onIncomingTransfer?.(transfer);
        }
        if (this.seeded && transfer.status === 'completed' && old?.status !== 'completed') {
          this.options.onTransferCompleted?.(transfer);
        }
      }
      if (this.seeded) for (const item of [...next.clipboardItems].reverse()) {
        if (previous.clipboardItems.some((old) => old.beamId === item.beamId)) continue;
        this.lastSynced = item.text;
        if (item.direction === 'incoming') this.options.onIncomingClipboard?.(item);
        else this.options.onOutgoingAutoClipboard?.(item);
      }
      this.seeded = true;
      for (const listener of this.listeners) listener(next);
      return true;
    } catch {
      // A stopped/restarting Android service is transient; its peer reconnects
      // without replacing this UI with a competing JavaScript connection.
      return false;
    }
  }

  private command<T = void>(method: string, args: Record<string, unknown> = {}): T {
    const raw = this.bridge.engineCommand?.(JSON.stringify({ method, ...args }));
    if (!raw) throw new Error('The Android connection service is unavailable.');
    const response = JSON.parse(raw) as { ok: boolean; result: T; error?: string };
    if (!response.ok) throw new Error(response.error || 'Native operation failed.');
    this.readSnapshot();
    return response.result;
  }

  subscribe(listener: (snapshot: WarpClientSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }
  getSnapshot(): WarpClientSnapshot { return this.snapshot; }
  getDiagnostics(): WarpClientDiagnostics {
    return {
      wsCloseCode: null,
      wsCloseReason: '',
      reconnectAttempts: 0,
      rtcState: {},
      transferErrors: [],
      fallbackTimerFires: 0,
      clientErrorRing: [],
      transferResumes: 0,
      transferChunkRetries: 0,
      lastFinalizeDurationMs: null,
      screenShare: {
        activeSessions: 0,
        decoderMode: null,
        codec: null,
        framesDecoded: 0,
        decodeErrors: 0,
        keyframesReceived: 0,
        pliSent: 0,
        pliReceived: 0,
      },
      contacts: {
        savedCount: this.snapshot.continuity?.savedContacts?.length ?? 0,
        removedByUser: 0,
        clearedOnDisconnect: 0,
      },
      callAudio: {
        active: false,
        route: 'phone',
        muted: false,
        framesSent: 0,
        framesReceived: 0,
        packetsDropped: 0,
        lastError: null,
      },
      clipboardBridge: {
        imagesSent: 0,
        imagesReceived: 0,
        autoSyncEnabled: this.snapshot.autoClipboardSync,
        receiveEnabled: this.snapshot.clipboardReceiveEnabled,
      },
    };
  }
  recordTransferError(): void {}
  recordClientError(): void {}
  updateDeviceName(name: string): void { this.command('rename', { name }); }
  setVisibility(value: VisibilityMode): void { this.command('visibility', { value }); }
  setNotificationSharing(value: boolean): void { this.snapshot.notificationSharing = value; }
  getNotificationSharing(): boolean { return this.snapshot.notificationSharing; }
  async sendNotification(): Promise<boolean> { return false; }
  joinPairCode(value: string): void { this.command('pair', { value }); }
  rotatePairCode(): void { this.command('rotatePair'); }
  toggleTrustedPeer(key: string, value: boolean): void { this.command('trust', { key, value }); }
  setAutoClipboardSync(value: boolean): void { this.command('autoClipboard', { value }); }
  setClipboardReceiveEnabled(value: boolean): void { this.command('receiveClipboard', { value }); }
  markClipboardSynced(text: string): void { this.lastSynced = text; this.command('markClipboard', { text }); }
  getLastSyncedClipboardText(): string { return this.lastSynced; }
  async handleDetectedLocalClipboard(text: string): Promise<ClipboardBeamItem[]> { return this.command('detectedClipboard', { text }); }
  async handleDetectedLocalClipboardImage(imageDataUrl: string, imageName?: string): Promise<ClipboardBeamItem[]> {
    return this.command('detectedClipboardImage', { imageDataUrl, imageName });
  }
  async sendClipboard(peerId: string, text: string): Promise<ClipboardBeamItem> {
    return this.command('clipboard', { peerId, text });
  }
  async sendClipboardImage(peerId: string, dataUrl: string): Promise<ClipboardBeamItem> {
    return this.command('clipboardImage', { peerId, dataUrl });
  }
  async sendFiles(peerId: string, inputs: SendableFileInput[]): Promise<TransferSessionView> {
    if (!inputs.length || inputs.some((input) => !input.nativeSourceId)) {
      throw new Error('Choose the files with AirBridge’s file picker so Android can read them in the background.');
    }
    return this.command('sendFiles', { peerId, files: inputs.map((input) => ({ sourceId: input.nativeSourceId, size: input.size })) });
  }
  async acceptIncomingTransfer(transferId: string): Promise<void> { this.command('accept', { transferId }); }
  async declineIncomingTransfer(transferId: string): Promise<void> { this.command('decline', { transferId }); }
  async cancelTransfer(transferId: string): Promise<void> { this.command('cancel', { transferId }); }
  async updateReceivedFolder(): Promise<string> { throw new Error('Android saves verified files to Downloads/AirBridge.'); }
  async openReceivedFolder(): Promise<void> { throw new Error('Open Downloads/AirBridge in your Android Files app.'); }
  // Phone continuity lives in the native Compose app (the phone is the
  // provider there); this legacy WebView bridge does not drive it.
  async requestContacts(): Promise<ContactsQueryResult> { throw new Error(CONTINUITY_NATIVE); }
  async shareContacts(): Promise<ContactShareItem> { throw new Error(CONTINUITY_NATIVE); }
  clearSharedContacts(): void {}
  removeSavedContact(): boolean { return false; }
  clearSavedContacts(): number { return 0; }
  async startCallAudio(): Promise<void> { throw new Error(CONTINUITY_NATIVE); }
  async stopCallAudio(): Promise<void> {}
  async setCallAudioMuted(): Promise<void> {}
  async sendCallAudio(): Promise<boolean> { return false; }
  subscribeCallAudio(_callId: string, _listener: (frame: CallAudioFrame) => void): () => void {
    void _callId; void _listener;
    return () => {};
  }
  async answerCall(): Promise<CallCommandResult> { throw new Error(CONTINUITY_NATIVE); }
  async rejectCall(): Promise<CallCommandResult> { throw new Error(CONTINUITY_NATIVE); }
  async hangUpCall(): Promise<CallCommandResult> { throw new Error(CONTINUITY_NATIVE); }
  async dialNumber(): Promise<CallCommandResult> { throw new Error(CONTINUITY_NATIVE); }
  publishCallState(): void {}
  requestScreenShare(): string { throw new Error(CONTINUITY_NATIVE); }
  acceptScreenShare(_sessionId: string, source: ScreenFrameSource): void { void _sessionId; source.stop(); throw new Error(CONTINUITY_NATIVE); }
  declineScreenShare(): void {}
  stopScreenShare(): void {}
  requestScreenKeyframe(): void {}
  recordScreenViewerStats(): void {}
  subscribeScreenFrames(): () => void { return () => {}; }
  subscribeScreenVideo(): () => void { return () => {}; }
  subscribeScreenAudio(): () => void { return () => {}; }
  configureContinuity(): void {}
}

const CONTINUITY_NATIVE = 'Contacts, calls and screen sharing are handled by the AirBridge app on this phone.';
