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
 * daemon keeps its own ECDH identity, peer id and pair code across restarts
 * so it does not look like a brand-new device every time the service starts.
 */
class BackgroundStorage implements Storage {
  private data: Record<string, string>;

  constructor(private readonly filePath: string) {
    this.data = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
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
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
    } catch {
      // Persistence is best effort; the in-memory copy still works this run.
    }
  }
}

/** Overridable for tests; defaults to ~/.airbridge/background-peer.json. */
export function createBackgroundStorage(storagePath?: string | null): Storage {
  const target = storagePath ?? path.join(os.homedir(), '.airbridge', 'background-peer.json');
  return new BackgroundStorage(target);
}

function installGlobalLocalStorage(storage: Storage): void {
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  } catch {
    (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  }
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

  constructor(private readonly opts: BackgroundClipboardOptions) {
    this.storage = createBackgroundStorage(opts.storagePath);
    installGlobalLocalStorage(this.storage);
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
      enableWebRtc: false,
      deviceOverride: device,
      autoClipboardSync: true,
      onIncomingClipboard: (item: ClipboardBeamItem) => {
        if (item.contentType === 'image' || !item.text) return;
        const text = item.text.trim();
        if (!text) return;
        client.markClipboardSynced(text);
        void this.opts.writeClipboard(text).catch(() => {});
      },
    });
    this.client = client;

    void client.start().then(() => {
      if (this.stopped) {
        client.stop();
        return;
      }
      client.setAutoClipboardSync(true);
      client.setClipboardReceiveEnabled(true);
      client.setVisibility('paired-only');
    }).catch(() => {
      // WarpClient reconnects on its own; the daemon must not crash if WebCrypto
      // or the loopback socket is briefly unavailable.
    });
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
