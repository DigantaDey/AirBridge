import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAirBridgeServer,
  type AirBridgeServerInstance,
} from '../src/server/index.js';
import {
  CHUNK_SIZE,
  WarpClient,
  type SendableFileInput,
  type TransferSessionView,
} from '../src/client/engine/warpClient.js';
import { Sha256Stream } from '../src/client/engine/sha256Stream.js';

function waitForCondition(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 10);
  });
}

async function refSha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// In-memory mock of the File System Access API
// ---------------------------------------------------------------------------

class MockWritableStream {
  private buffer = new Uint8Array(0);
  async write(data: Uint8Array, options?: { at?: number }): Promise<void> {
    const at = options?.at ?? this.buffer.byteLength;
    if (at + data.byteLength > this.buffer.byteLength) {
      const next = new Uint8Array(at + data.byteLength);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer.set(data, at);
  }
  async close(): Promise<void> {}
  getBuffer(): Uint8Array {
    return this.buffer;
  }
}

class MockFileHandle {
  readonly name: string;
  private readonly stream = new MockWritableStream();
  constructor(name: string) {
    this.name = name;
  }
  async createWritable(): Promise<MockWritableStream> {
    return this.stream;
  }
  async getFile(): Promise<{ size: number; stream: () => ReadableStream<Uint8Array> }> {
    const buffer = this.stream.getBuffer();
    return {
      size: buffer.byteLength,
      stream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(buffer.slice());
            controller.close();
          },
        }),
    };
  }
  getBuffer(): Uint8Array {
    return this.stream.getBuffer();
  }
}

class MockDirectoryHandle {
  name = 'AirBridge';
  private readonly files = new Map<string, MockFileHandle>();
  async getFileHandle(name: string): Promise<MockFileHandle> {
    if (!this.files.has(name)) this.files.set(name, new MockFileHandle(name));
    return this.files.get(name)!;
  }
  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }
  getFile(name: string): MockFileHandle | undefined {
    return this.files.get(name);
  }
}

describe('Sha256Stream', () => {
  it('matches crypto.subtle.digest across sizes and chunk boundaries', async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 37 + n) & 0xff;
      const sha = new Sha256Stream();
      const feed = [1, 7, 63, 64, 100];
      let off = 0;
      let si = 0;
      while (off < data.byteLength) {
        const k = Math.min(feed[si % feed.length], data.byteLength - off);
        sha.update(data.subarray(off, off + k));
        off += k;
        si++;
      }
      expect(sha.hex()).toBe(await refSha256(data));
    }
  });
});

describe('phone disk-backed receive (File System Access API)', () => {
  let server: AirBridgeServerInstance;
  let wsUrl: string;
  let base: string;
  let downloadDir: string;
  let mockDir: MockDirectoryHandle;
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeAll(async () => {
    downloadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-phone-'));
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: { enabled: false, downloadDir, autoSaveToDownloads: false },
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    base = `http://127.0.0.1:${server.port}`;
    mockDir = new MockDirectoryHandle();
    (globalThis as { window?: unknown }).window = {
      showDirectoryPicker: () => Promise.resolve(mockDir),
      location: { origin: base },
    };
  });

  afterAll(async () => {
    (globalThis as { window?: unknown }).window = originalWindow;
    await server.close();
    await fs.promises.rm(downloadDir, { recursive: true, force: true });
  });

  async function makePair(autoAccept = true) {
    let receiverCompleted: TransferSessionView | null = null;
    const receiver = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'Pixel 9 · Phone',
        platform: 'android',
        model: 'Pixel',
        formFactor: 'phone',
      },
      onIncomingTransfer: (offer) => {
        if (autoAccept) void receiver.acceptIncomingTransfer(offer.transferId);
      },
      onTransferCompleted: (t) => {
        if (t.direction === 'incoming') receiverCompleted = t;
      },
    });
    const sender = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'MacBook Pro',
        platform: 'macos',
        model: 'MacBook',
        formFactor: 'laptop',
      },
    });
    await receiver.start();
    await sender.start();
    await waitForCondition(
      () => sender.getSnapshot().peers.length === 1 && receiver.getSnapshot().peers.length === 1,
    );
    // The phone has no local daemon, so the disk path must come from the
    // File System Access API, not the daemon.
    expect(receiver.getSnapshot().localDaemon.enabled).toBe(false);
    return {
      sender,
      receiver,
      senderPeerTarget: sender.getSnapshot().peers[0].peerId,
      getReceiverCompleted: () => receiverCompleted,
      stop: () => {
        sender.stop();
        receiver.stop();
      },
    };
  }

  it('streams a multi-chunk file into a picked directory without buffering it in memory', async () => {
    const pair = await makePair();
    try {
      const size = 2 * 1024 * 1024 + 456;
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 13 + 5) & 0xff;
      const input: SendableFileInput = {
        name: 'Holiday-Photos.zip',
        size,
        type: 'application/zip',
        async sliceBytes(start, end) {
          return raw.slice(start, end);
        },
      };

      await pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() => pair.getReceiverCompleted() !== null);

      const done = pair.getReceiverCompleted()!;
      expect(done.status).toBe('completed');
      expect(done.receivedFiles).toHaveLength(1);
      const record = done.receivedFiles[0];

      // Nothing held in browser memory; the file landed in the picked directory.
      expect(record.chunks).toHaveLength(0);
      expect(record.savedToDiskPath).toBeTruthy();
      expect(record.savedToMacPath).toBeUndefined();
      expect(record.verified).toBe(true);
      expect(record.sha256).toHaveLength(64);
      expect(record.sha256).toBe(await refSha256(raw));

      const written = mockDir.getFile('Holiday-Photos.zip')!.getBuffer();
      expect(Buffer.compare(Buffer.from(written), Buffer.from(raw))).toBe(0);
    } finally {
      pair.stop();
    }
  });

  it('removes the partial file from the picked directory when cancelled', async () => {
    const pair = await makePair(false);
    try {
      const size = CHUNK_SIZE * 4;
      const raw = new Uint8Array(size);
      const input: SendableFileInput = {
        name: 'cancel-me.bin',
        size,
        type: 'application/octet-stream',
        async sliceBytes(start, end) {
          return raw.slice(start, end);
        },
      };

      const sendPromise = pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() =>
        pair.receiver.getSnapshot().transfers.some((t) => t.status === 'pending-accept'),
      );
      const offer = pair.receiver
        .getSnapshot()
        .transfers.find((t) => t.status === 'pending-accept')!;

      // Accept, then wait until the file has been created in the directory.
      await pair.receiver.acceptIncomingTransfer(offer.transferId);
      await waitForCondition(() => Boolean(mockDir.getFile('cancel-me.bin')));

      // Cancelling should discard the partial file.
      await pair.receiver.cancelTransfer(offer.transferId);
      await waitForCondition(() => !mockDir.getFile('cancel-me.bin'));

      await sendPromise.catch(() => {});
      expect(pair.getReceiverCompleted()).toBeNull();
    } finally {
      pair.stop();
    }
  });
});
