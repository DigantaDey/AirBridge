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

function waitForCondition(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A binary file whose slices are views into a larger, unaligned buffer. */
function createOffsetViewFile(
  name: string,
  size: number,
  mimeType = 'application/octet-stream',
): { input: SendableFileInput; raw: Uint8Array } {
  const raw = new Uint8Array(size);
  for (let i = 0; i < size; i++) raw[i] = (i * 31 + 17) & 0xff;
  const padded = new Uint8Array(size + 73);
  padded.set(raw, 37);
  const view = padded.subarray(37, 37 + size);
  return {
    raw,
    input: {
      name,
      size,
      type: mimeType,
      async sliceBytes(start, end) {
        return view.subarray(start, end);
      },
    },
  };
}

type BinaryFrameRouter = (sender: unknown, data: unknown) => void;

function interceptBinaryFrames(
  hub: AirBridgeServerInstance['hub'],
  dropIndex: number,
): { count: () => number; restore: () => void } {
  const target = hub as unknown as { routeBinaryFrame: BinaryFrameRouter };
  const original = target.routeBinaryFrame.bind(target);
  let count = 0;
  target.routeBinaryFrame = (sender, data) => {
    count += 1;
    if (count === dropIndex) return; // lose exactly one encrypted chunk
    original(sender, data);
  };
  return {
    count: () => count,
    restore: () => {
      target.routeBinaryFrame = original;
    },
  };
}

describe('file transfer binary integrity', () => {
  let server: AirBridgeServerInstance;
  let wsUrl: string;
  let downloadDir: string;
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeAll(async () => {
    // Force the in-memory receive path: no daemon, no File System Access API.
    delete (globalThis as { window?: unknown }).window;
    downloadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'airbridge-integrity-'));
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      https: false,
      enableMdns: false,
      hostClipboard: false,
      backgroundClipboard: false,
      receivedFolderSettingsPath: null,
      daemonConfig: {
        enabled: false,
        downloadDir,
        autoSaveToDownloads: false,
      },
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterAll(async () => {
    await server.close();
    await fs.promises.rm(downloadDir, { recursive: true, force: true });
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  async function makePair() {
    let completed: TransferSessionView | null = null;
    const receiver = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      autoAcceptAll: true,
      deviceOverride: {
        name: 'Integrity receiver',
        platform: 'macos',
        model: 'MacBook',
        formFactor: 'laptop',
      },
      onTransferCompleted: (transfer) => {
        if (transfer.direction === 'incoming') completed = transfer;
      },
    });
    const sender = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'Integrity sender',
        platform: 'android',
        model: 'Pixel',
        formFactor: 'phone',
      },
    });
    await receiver.start();
    await sender.start();
    await waitForCondition(
      () =>
        sender.getSnapshot().peers.length === 1 &&
        receiver.getSnapshot().peers.length === 1,
    );
    return {
      sender,
      receiver,
      targetPeerId: sender.getSnapshot().peers[0].peerId,
      getCompleted: () => completed,
      stop: () => {
        sender.stop();
        receiver.stop();
      },
    };
  }

  it('keeps every byte intact for multi-chunk binary views with non-zero byteOffset', async () => {
    const pair = await makePair();
    try {
      const size = CHUNK_SIZE * 2 + 123;
      const file = createOffsetViewFile('Offset-Video.mp4', size, 'video/mp4');
      await pair.sender.sendFiles(pair.targetPeerId, [file.input]);
      await waitForCondition(() => pair.getCompleted() !== null);

      const done = pair.getCompleted()!;
      expect(done.status).toBe('completed');
      expect(done.receivedFiles).toHaveLength(1);
      expect(done.receivedFiles[0].verified).toBe(true);
      const joined = Buffer.concat(
        done.receivedFiles[0].chunks.map((chunk) => Buffer.from(chunk)),
      );
      expect(Buffer.compare(joined, Buffer.from(file.raw))).toBe(0);
    } finally {
      pair.stop();
    }
  }, 15000);

  it('does not conjure a truncated file when file-complete is lost and fallback fires', async () => {
    const pair = await makePair();
    const frames = interceptBinaryFrames(server.hub, 2);
    let sendPromise: Promise<TransferSessionView | void> | null = null;
    try {
      const size = CHUNK_SIZE * 2 + 123;
      const file = createOffsetViewFile('Fallback-Video.mp4', size, 'video/mp4');
      sendPromise = pair.sender.sendFiles(pair.targetPeerId, [file.input]).catch(() => {});

      // All three chunks were queued; chunk 1 was dropped at the relay.
      await waitForCondition(() => frames.count() >= 3);
      await waitForCondition(() =>
        pair.sender.getSnapshot().transfers.some((transfer) => transfer.direction === 'outgoing'),
      );
      const outgoing = pair.sender.getSnapshot().transfers.find(
        (transfer) => transfer.direction === 'outgoing',
      )!;
      // Let the per-file file-complete digest arrive before forcing the
      // transfer-complete fallback the receiver starts when control frames lag.
      await sleep(250);
      await (pair.sender as unknown as {
        sendControlMessage: (
          peerId: string,
          payload: { kind: 'transfer-complete'; transferId: string },
          encrypt: boolean,
        ) => Promise<void>;
      }).sendControlMessage(
        pair.targetPeerId,
        { kind: 'transfer-complete', transferId: outgoing.transferId },
        true,
      );

      await waitForCondition(() =>
        pair.receiver.getSnapshot().transfers.some(
          (transfer) => transfer.transferId === outgoing.transferId && transfer.status === 'error',
        ),
      );

      const failed = pair.receiver.getSnapshot().transfers.find(
        (transfer) => transfer.transferId === outgoing.transferId,
      )!;
      expect(failed.status).toBe('error');
      expect(failed.receivedFiles).toHaveLength(0);
      expect(failed.errorMessage).toMatch(/incomplete|verification/i);
      expect(pair.getCompleted()).toBeNull();
    } finally {
      if (sendPromise) {
        const failed = pair.sender.getSnapshot().transfers.find(
          (transfer) => transfer.direction === 'outgoing',
        );
        if (failed) void pair.sender.cancelTransfer(failed.transferId).catch(() => {});
      }
      frames.restore();
      pair.stop();
    }
  }, 15000);

  it('rejects a SHA-256 mismatch before creating a blob or auto-saving', async () => {
    const pair = await makePair();
    const senderAny = pair.sender as unknown as {
      sendControlMessage: (
        peerId: string,
        payload: unknown,
        encrypt: boolean,
      ) => Promise<void>;
    };
    const originalSend = senderAny.sendControlMessage.bind(pair.sender);
    senderAny.sendControlMessage = async (peerId, payload, encrypt) => {
      const altered =
        payload && typeof payload === 'object' &&
        (payload as { kind?: string }).kind === 'file-complete'
          ? { ...(payload as Record<string, unknown>), sha256: '0'.repeat(64) }
          : payload;
      return originalSend(peerId, altered, encrypt);
    };

    const sendPromise = pair.sender
      .sendFiles(pair.targetPeerId, [
        createOffsetViewFile('Bad-Hash.bin', CHUNK_SIZE + 77).input,
      ])
      .catch(() => {});
    try {
      await waitForCondition(() =>
        pair.receiver.getSnapshot().transfers.some(
          (transfer) => transfer.direction === 'incoming' && transfer.status === 'error',
        ),
      );
      const failed = pair.receiver.getSnapshot().transfers.find(
        (transfer) => transfer.direction === 'incoming',
      )!;
      expect(failed.status).toBe('error');
      expect(failed.receivedFiles).toHaveLength(0);
      expect(failed.errorMessage).toMatch(/SHA-256/i);
      expect(pair.getCompleted()).toBeNull();
      await sendPromise;
    } finally {
      pair.stop();
    }
  }, 15000);
});
