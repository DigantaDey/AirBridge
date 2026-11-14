import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WarpClient, type ClipboardBeamItem } from '../client/engine/warpClient.js';
import {
  generatePairCode,
  isValidPairCode,
  normalizePairCode,
  type DeviceProfile,
  type PlatformType,
} from '../shared/protocol.js';

const STORAGE_PREFIX = 'airbridge:background';

/**
 * A tiny persistent stand-in for the browser's localStorage. The desktop
 * daemon keeps its logical device id, peer id and pair code across restarts.
 * Session encryption keys are ephemeral and are never persisted here.
 */
class BackgroundStorage implements Storage {
  private data: Record<string, string>;

  constructor(private readonly filePath: string | null) {
    this.data = {};
    try {
      const parsed = JSON.parse(filePath ? fs.readFileSync(filePath, 'utf8') : '{}') as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') this.data[key] = value;
      }
    } catch {
      // First run, unwritable home, or a partially written file: start clean.
    }
  }

  get length(): number {
    return Object.keys(this.data).length;
  }

  key(index: number): string | null {
    return Object.keys(this.data)[index] ?? null;
  }

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = String(value);
    this.flush();
  }

  removeItem(key: string): void {
    delete this.data[key];
    this.flush();
  }

  clear(): void {
    this.data = {};
    this.flush();
  }

  private flush(): void {
    if (!this.filePath) return;
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* no temporary was created */ }
      // Persistence is best effort; the in-memory copy still works this run.
    }
  }
}

/** Overridable for tests; defaults to ~/.airbridge/background-peer.json. */
export function createBackgroundStorage(storagePath?: string | null): Storage {
  const target = storagePath === null ? null : storagePath ?? path.join(os.homedir(), '.airbridge', 'background-peer.json');
  return new BackgroundStorage(target);
}


function hostPlatform(): PlatformType {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

export interface BackgroundClipboardOptions {
  /** Loopback port the desktop server is listening on. */
  port: number;
  /** Pair code printed in the startup QR; used until the browser persists one. */
  defaultPairCode: string;
  /** Writes an incoming beam to the host OS clipboard. */
  writeClipboard: (text: string) => Promise<boolean>;
  /** Optional override for tests / portable installs. */
  storagePath?: string | null;
}

/**
 * A headless encrypted peer that lives inside the desktop daemon.
 *
 * The browser tab is normally the thing that holds the ECDH session and beams
 * OS clipboard changes to the phone. When every AirBridge tab is closed that
 * session disappears, so this peer keeps it alive. It connects over loopback,
 * joins the persisted pair code, and uses the exact same WarpClient/E2EE code
 * as the UI. The server still only ever sees encrypted control frames.
 */
export class BackgroundClipboardPeer {
  private readonly storage: Storage;
  private client: WarpClient | null = null;
  private stopped = false;
  private pendingWrite: string | null = null;
  private writing = false;

  constructor(private readonly opts: BackgroundClipboardOptions) {
    this.storage = createBackgroundStorage(opts.storagePath);
  }

  start(): void {
    if (this.stopped || this.client) return;

    const normalizedDefault = normalizePairCode(this.opts.defaultPairCode);
    const defaultPairCode = isValidPairCode(normalizedDefault)
      ? normalizedDefault
      : generatePairCode(crypto.randomBytes(6));
    const storedPairCode = normalizePairCode(this.storage.getItem(`${STORAGE_PREFIX}:pairCode`) ?? '');
    const pairCode = isValidPairCode(storedPairCode) ? storedPairCode : defaultPairCode;
    this.storage.setItem(`${STORAGE_PREFIX}:pairCode`, pairCode);

    let deviceId = this.storage.getItem(`${STORAGE_PREFIX}:deviceId`) ?? '';
    if (!/^[0-9a-f]{16}$/.test(deviceId)) {
      deviceId = crypto.randomBytes(8).toString('hex');
      this.storage.setItem(`${STORAGE_PREFIX}:deviceId`, deviceId);
    }

    const device = {
      name: 'AirBridge Background',
      platform: hostPlatform(),
      model: 'AirBridge service',
      formFactor: 'laptop' as const,
      deviceId,
    } satisfies Omit<DeviceProfile, 'publicKey'>;

    const client = new WarpClient({
      wsUrl: `ws://127.0.0.1:${this.opts.port}/ws`,
      initialPairCode: pairCode,
      storagePrefix: STORAGE_PREFIX,
      storage: this.storage,
      enableWebRtc: false,
      deviceOverride: device,
      writeHostClipboard: false,
      onIncomingClipboard: (item: ClipboardBeamItem) => {
        if (item.contentType === 'image' || !item.text) return;
        const text = item.text;
        if (!text.trim()) return;
        this.pendingWrite = text;
        void this.flushClipboardWrites();
      },
    });
    this.client = client;

    void client.start().then(() => {
      if (this.stopped) {
        client.stop();
        return;
      }
      client.setVisibility('paired-only');
    }).catch(() => {
      // WarpClient reconnects on its own; the daemon must not crash if WebCrypto
      // or the loopback socket is briefly unavailable.
    });
  }

  getPairCode(): string {
    return this.storage.getItem(`${STORAGE_PREFIX}:pairCode`) ?? '';
  }

  setPreferences(autoClipboard: boolean, receiveClipboard: boolean): void {
    this.client?.setAutoClipboardSync(autoClipboard);
    this.client?.setClipboardReceiveEnabled(receiveClipboard);
    if (!receiveClipboard) this.pendingWrite = null;
  }

  /** Bounded, ordered OS writes: only the in-flight and latest value survive. */
  private async flushClipboardWrites(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pendingWrite !== null && !this.stopped) {
        const text = this.pendingWrite;
        this.pendingWrite = null;
        if (!this.client?.getSnapshot().clipboardReceiveEnabled) continue;
        if (await this.opts.writeClipboard(text).catch(() => false)) this.client?.markClipboardSynced(text);
      }
    } finally { this.writing = false; }
  }

  /** The daemon owns OS capture even when a newer browser tab is suspended. */
  handleHostClipboard(text: string): void {
    if (!this.stopped) void this.client?.handleDetectedLocalClipboard(text).catch(() => {});
  }

  /** Called by the local browser when the user joins or rotates a pair code. */
  setPairCode(raw: string): void {
    const clean = normalizePairCode(raw);
    if (!isValidPairCode(clean)) return;
    this.storage.setItem(`${STORAGE_PREFIX}:pairCode`, clean);
    this.client?.joinPairCode(clean);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingWrite = null;
    this.client?.stop();
    this.client = null;
  }
}

export function startBackgroundClipboardPeer(
  opts: BackgroundClipboardOptions,
): BackgroundClipboardPeer {
  const peer = new BackgroundClipboardPeer(opts);
  peer.start();
  return peer;
}
