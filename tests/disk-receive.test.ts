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

function createMemoryFile(
  name: string,
  sizeBytes: number,
  mimeType = 'application/octet-stream',
): { input: SendableFileInput; raw: Uint8Array } {
  const raw = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) raw[i] = (i * 31 + 17) & 0xff;
  return {
    raw,
    input: {
      name,
      size: sizeBytes,
      type: mimeType,
      async sliceBytes(start, end) {
        return raw.slice(start, end);
      },
    },
  };
}

describe('disk-backed receive endpoints', () => {
  let server: AirBridgeServerInstance;
  let base: string;
  let downloadDir: string;

  beforeAll(async () => {
    downloadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-disk-'));
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: {
        enabled: true,
        downloadDir,
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await fs.promises.rm(downloadDir, { recursive: true, force: true });
  });

  const chunkHeaders = (over: Record<string, string>) => ({
    'Content-Type': 'application/octet-stream',
    'X-AirBridge-Transfer': 'aaaaaaaaaaaaaaaa',
    'X-AirBridge-File': '0',
    'X-AirBridge-Name': encodeURIComponent('part.bin'),
    'X-AirBridge-Size': '10',
    'X-AirBridge-Chunk-Size': String(CHUNK_SIZE),
    'X-AirBridge-Total-Chunks': '1',
    ...over,
  });

  it('writes chunks at their declared offsets, idempotently, and finalizes a verified file', async () => {
    const transferId = 'bbbbbbbbbbbbbbbb';
    const size = CHUNK_SIZE * 2;
    const raw = new Uint8Array(size);
    for (let i = 0; i < size; i++) raw[i] = (i * 7 + 1) & 0xff;

    // Deliver the second chunk first (out of order) then the first.
    const second = raw.slice(CHUNK_SIZE);
    const first = raw.slice(0, CHUNK_SIZE);
    const h2 = chunkHeaders({
      'X-AirBridge-Transfer': transferId,
      'X-AirBridge-Chunk': '1',
      'X-AirBridge-Size': String(size),
      'X-AirBridge-Total-Chunks': '2',
      'X-AirBridge-Name': encodeURIComponent('ordered.bin'),
    });
    const r2 = await fetch(`${base}/api/daemon/receive-chunk`, {
      method: 'POST',
      headers: h2,
      body: Buffer.from(second),
    });
    expect(r2.status).toBe(200);

    const h1 = chunkHeaders({
      'X-AirBridge-Transfer': transferId,
      'X-AirBridge-Chunk': '0',
      'X-AirBridge-Size': String(size),
      'X-AirBridge-Total-Chunks': '2',
      'X-AirBridge-Name': encodeURIComponent('ordered.bin'),
    });
    const r1 = await fetch(`${base}/api/daemon/receive-chunk`, {
      method: 'POST',
      headers: h1,
      body: Buffer.from(first),
    });
    expect(r1.status).toBe(200);

    // Re-delivering chunk 0 is a no-op, not an error.
    const r1again = await fetch(`${base}/api/daemon/receive-chunk`, {
      method: 'POST',
      headers: h1,
      body: Buffer.from(first),
    });
    expect(r1again.status).toBe(200);

    const summary = (await (
      await fetch(`${base}/api/daemon/received?transferId=${transferId}&fileIndex=0`)
    ).json()) as { complete: boolean; receivedChunks: number[]; receivedBytes: number };
    expect(summary.complete).toBe(true);
    expect(summary.receivedChunks).toEqual([0, 1]);
    expect(summary.receivedBytes).toBe(size);

    const fin = await fetch(`${base}/api/daemon/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, fileIndex: 0 }),
    });
    expect(fin.status).toBe(200);
    const json = (await fin.json()) as {
      savedPath: string;
      finalName: string;
      sha256: string;
      bytes: number;
    };
    expect(json.bytes).toBe(size);
    expect(json.sha256).toHaveLength(64);

    const saved = await fs.promises.readFile(json.savedPath);
    expect(Buffer.compare(saved, Buffer.from(raw))).toBe(0);

    // The temp file and manifest are cleaned up after finalize.
    const leftover = await fs.promises.readdir(path.join(downloadDir, '.airbridge-partial'));
    expect(leftover).toEqual([]);
  });

  it('rejects a chunk whose byte length disagrees with the manifest', async () => {
    const transferId = 'cccccccccccccccc';
    const r = await fetch(`${base}/api/daemon/receive-chunk`, {
      method: 'POST',
      headers: chunkHeaders({
        'X-AirBridge-Transfer': transferId,
        'X-AirBridge-Chunk': '0',
        'X-AirBridge-Size': String(CHUNK_SIZE),
        'X-AirBridge-Total-Chunks': '1',
      }),
      body: Buffer.alloc(10),
    });
    expect(r.status).toBe(400);
  });

  it('refuses the daemon API when the local daemon is disabled', async () => {
    const disabled = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: { enabled: false, downloadDir, autoSaveToDownloads: false },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${disabled.port}/api/daemon/receive-chunk`, {
        method: 'POST',
        headers: chunkHeaders({ 'X-AirBridge-Transfer': 'dddddddddddddddd' }),
        body: Buffer.alloc(4),
      });
      expect(r.status).toBe(403);
    } finally {
      await disabled.close();
    }
  });
});

describe('disk-backed streaming receive (end-to-end)', () => {
  let server: AirBridgeServerInstance;
  let wsUrl: string;
  let base: string;
  let downloadDir: string;

  beforeAll(async () => {
    downloadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-disk-e2e-'));
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
      hostClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: {
        enabled: true,
        downloadDir,
        autoSaveToDownloads: true,
        notifyOnReceive: false,
      },
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await fs.promises.rm(downloadDir, { recursive: true, force: true });
  });

  async function makePair(autoAccept = true) {
    let receiverCompleted: TransferSessionView | null = null;
    const receiver = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'MacBook Pro · Disk',
        platform: 'macos',
        model: 'MacBook',
        formFactor: 'laptop',
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
        name: 'Pixel 9 · Disk',
        platform: 'android',
        model: 'Pixel',
        formFactor: 'phone',
      },
    });
    await receiver.start();
    await sender.start();
    await waitForCondition(
      () => sender.getSnapshot().peers.length === 1 && receiver.getSnapshot().peers.length === 1,
    );
    expect(receiver.getSnapshot().localDaemon.enabled).toBe(true);
    expect(sender.getSnapshot().localDaemon.enabled).toBe(false);
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

  it('streams a multi-chunk file to disk without buffering it in memory', async () => {
    const pair = await makePair();
    try {
      const size = 2 * 1024 * 1024 + 123;
      const file = createMemoryFile('Big-Video.mp4', size, 'video/mp4');
      await pair.sender.sendFiles(pair.senderPeerTarget, [file.input]);
      await waitForCondition(() => pair.getReceiverCompleted() !== null);

      const done = pair.getReceiverCompleted()!;
      expect(done.status).toBe('completed');
      expect(done.receivedFiles).toHaveLength(1);
      const record = done.receivedFiles[0];

      // The whole point: nothing is held in browser memory, the file lands on disk.
      expect(record.chunks).toHaveLength(0);
      expect(record.savedToMacPath).toBeTruthy();
      expect(record.verified).toBe(true);
      expect(record.sha256).toHaveLength(64);

      const saved = await fs.promises.readFile(record.savedToMacPath!);
      expect(Buffer.compare(saved, Buffer.from(file.raw))).toBe(0);

      // No temp files left behind after a successful finalize.
      const partialDir = path.join(downloadDir, '.airbridge-partial');
      const leftover = await fs.promises.readdir(partialDir).catch(() => []);
      expect(leftover).toEqual([]);
    } finally {
      pair.stop();
    }
  });

  it('resumes an interrupted transfer from disk instead of restarting', async () => {
    const pair = await makePair(false);
    try {
      const size = CHUNK_SIZE * 3;
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 13 + 7) & 0xff;
      const input: SendableFileInput = {
        name: 'resume.bin',
        size,
        type: 'application/octet-stream',
        async sliceBytes(start, end) {
          return raw.slice(start, end);
        },
      };

      // Start the send; it blocks until the receiver accepts.
      const sendPromise = pair.sender.sendFiles(pair.senderPeerTarget, [input]);

      // The offer is visible before acceptance, so we can read its transferId.
      await waitForCondition(() =>
        pair.receiver.getSnapshot().transfers.some((t) => t.status === 'pending-accept'),
      );
      const offer = pair.receiver
        .getSnapshot()
        .transfers.find((t) => t.status === 'pending-accept')!;
      const transferId = offer.transferId;
      const meta = offer.files[0];

      // Pretend chunk 0 already landed on disk from an earlier attempt.
      const seedResp = await fetch(`${base}/api/daemon/receive-chunk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-AirBridge-Transfer': transferId,
          'X-AirBridge-File': '0',
          'X-AirBridge-Chunk': '0',
          'X-AirBridge-Name': encodeURIComponent(meta.name),
          'X-AirBridge-Size': String(meta.size),
          'X-AirBridge-Chunk-Size': String(meta.chunkSize),
          'X-AirBridge-Total-Chunks': String(meta.totalChunks),
        },
        body: Buffer.from(raw.slice(0, CHUNK_SIZE)),
      });
      expect(seedResp.status).toBe(200);

      // Accept: the receiver sees the partial and asks the sender to resume
      // from chunk 1.
      await pair.receiver.acceptIncomingTransfer(transferId);
      await sendPromise;
      await waitForCondition(() => pair.getReceiverCompleted() !== null);

      const done = pair.getReceiverCompleted()!;
      expect(done.status).toBe('completed');
      const record = done.receivedFiles[0];
      expect(record.savedToMacPath).toBeTruthy();
      expect(record.chunks).toHaveLength(0);
      expect(record.verified).toBe(true);

      const saved = await fs.promises.readFile(record.savedToMacPath!);
      expect(Buffer.compare(saved, Buffer.from(raw))).toBe(0);
    } finally {
      pair.stop();
    }
  });
});
