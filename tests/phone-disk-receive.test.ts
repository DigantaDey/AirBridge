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

let mockWriteHook: (() => Promise<void>) | null = null;

class MockWritableStream {
  private buffer = new Uint8Array(0);
  private cursor = 0;
  constructor(private readonly commit: (data: Uint8Array) => void) {}

  private resize(size: number): void {
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, Math.min(size, this.buffer.byteLength)));
    this.buffer = next;
  }

  private static async bytesFrom(
    data: BufferSource | Blob | string | null | undefined,
  ): Promise<Uint8Array> {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error('Unsupported write payload');
  }

  async write(chunk: FileSystemWriteChunkType): Promise<void> {
    if (mockWriteHook) await mockWriteHook();
    let data: Uint8Array;
    let at = this.cursor;
    if (chunk && typeof chunk === 'object' && 'type' in chunk) {
      const params = chunk as WriteParams;
      if (params.type === 'seek') {
        this.cursor = params.position ?? 0;
        return;
      }
      if (params.type === 'truncate') {
        this.resize(params.size ?? 0);
        this.cursor = Math.min(this.cursor, this.buffer.byteLength);
        return;
      }
      if (params.type !== 'write') throw new Error('Unsupported write command');
      data = await MockWritableStream.bytesFrom(params.data);
      at = params.position ?? this.cursor;
    } else {
      data = await MockWritableStream.bytesFrom(chunk as BufferSource | Blob | string);
    }
    if (at + data.byteLength > this.buffer.byteLength) {
      this.resize(at + data.byteLength);
    }
    this.buffer.set(data, at);
    this.cursor = at + data.byteLength;
  }

  async truncate(size: number): Promise<void> {
    this.resize(size);
    this.cursor = Math.min(this.cursor, size);
  }

  async close(): Promise<void> {
    this.commit(this.buffer.slice());
  }
  getBuffer(): Uint8Array {
    return this.buffer;
  }
}

class MockFileHandle {
  readonly name: string;
  private buffer: Uint8Array;
  constructor(name: string, initial: Uint8Array = new Uint8Array(0)) {
    this.name = name;
    this.buffer = initial.slice();
  }
  async createWritable(): Promise<MockWritableStream> {
    // Matches createWritable()'s default keepExistingData=false: a fresh,
    // empty temp stream that commits its bytes to this handle on close().
    return new MockWritableStream((final) => {
      this.buffer = final;
    });
  }
  async getFile(): Promise<{ size: number; stream: () => ReadableStream<Uint8Array> }> {
    const buffer = this.buffer.slice();
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
    return this.buffer;
  }
}

class MockDirectoryHandle {
  name = 'AirBridge';
  private readonly files = new Map<string, MockFileHandle>();
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
      this.files.set(name, new MockFileHandle(name));
    }
    return this.files.get(name)!;
  }
  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }
  seedFile(name: string, data: Uint8Array): void {
    this.files.set(name, new MockFileHandle(name, data));
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

  it('does not advance progress or ACK storage before the disk write completes', async () => {
    const pair = await makePair();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let writesStarted = 0;
    mockWriteHook = async () => {
      writesStarted++;
      await writeGate;
    };
    try {
      const size = 2 * 1024 * 1024;
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 19 + 3) & 0xff;
      const input: SendableFileInput = {
        name: 'durable-ack.bin',
        size,
        type: 'application/octet-stream',
        async sliceBytes(start, end) {
          return raw.slice(start, end);
        },
      };

      const sendPromise = pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() => writesStarted > 0);
      const duringWrite = pair.receiver.getSnapshot().transfers.find(
        (transfer) => transfer.files[0]?.name === input.name,
      );
      expect(duringWrite?.status).toBe('transferring');
      // The old implementation counted bytes as soon as they entered the
      // write queue, hiding disk lag and releasing the sender prematurely.
      expect(duringWrite?.transferredBytes).toBe(0);

      releaseWrite();
      await sendPromise;
      await waitForCondition(() => pair.getReceiverCompleted() !== null);
      expect(pair.getReceiverCompleted()!.receivedFiles[0].verified).toBe(true);
    } finally {
      mockWriteHook = null;
      releaseWrite();
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

  it('preserves an existing file and saves a collision-free name with exact absolute chunk positions', async () => {
    const pair = await makePair();
    try {
      const size = CHUNK_SIZE * 2 + 123;
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 41 + 19) & 0xff;
      const stale = new Uint8Array(size + 777);
      stale.fill(0x5a);
      mockDir.seedFile('overwrite-long.bin', stale);

      const input: SendableFileInput = {
        name: 'overwrite-long.bin',
        size,
        type: 'video/mp4',
        async sliceBytes(start, end) {
          return raw.slice(start, end);
        },
      };

      await pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() => pair.getReceiverCompleted() !== null);
      const done = pair.getReceiverCompleted()!;
      expect(done.status).toBe('completed');
      expect(done.receivedFiles).toHaveLength(1);
      expect(done.receivedFiles[0].verified).toBe(true);
      expect(done.receivedFiles[0].sha256).toBe(await refSha256(raw));

      expect(mockDir.getFile('overwrite-long.bin')!.getBuffer()).toEqual(stale);
      const written = mockDir.getFile('overwrite-long (1).bin')!.getBuffer();
      expect(written.byteLength).toBe(size);
      expect(Buffer.compare(Buffer.from(written), Buffer.from(raw))).toBe(0);
    } finally {
      pair.stop();
    }
  });
  it('marks cancellation immediately during a blocked disk write and never deletes an existing same-name file', async () => {
    const pair = await makePair();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockWriteHook = async () => { entered = true; await gate; };
    const original = Uint8Array.of(9, 8, 7);
    mockDir.seedFile('keep-original.bin', original);
    const input: SendableFileInput = { name: 'keep-original.bin', size: CHUNK_SIZE, type: 'x',
      sliceBytes: async (start, end) => new Uint8Array(end - start) };
    const sending = pair.sender.sendFiles(pair.senderPeerTarget, [input]);
    try {
      await waitForCondition(() => entered);
      const id = pair.receiver.getSnapshot().transfers.find((transfer) => transfer.direction === 'incoming')!.transferId;
      const cancelling = pair.receiver.cancelTransfer(id);
      expect(pair.receiver.getSnapshot().transfers.find((transfer) => transfer.transferId === id)?.status).toBe('cancelled');
      release();
      await cancelling;
      await sending;
      expect(mockDir.getFile('keep-original.bin')!.getBuffer()).toEqual(original);
      expect(mockDir.getFile('keep-original (1).bin')).toBeUndefined();
      expect(pair.getReceiverCompleted()).toBeNull();
    } finally { release(); mockWriteHook = null; pair.stop(); await sending; }
  }, 15_000);

});
