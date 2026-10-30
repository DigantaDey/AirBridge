import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAirBridgeServer,
  type AirBridgeServerInstance,
} from "../src/server/index.js";
import {
  CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  WarpClient,
  isValidFileManifest,
  type SendableFileInput,
  type TransferSessionView,
} from "../src/client/engine/warpClient.js";

function waitForCondition(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for condition"));
      }
    }, 10);
  });
}

describe("manifest chunk-size negotiation", () => {
  const manifestWith = (size: number, chunkSize: number) => [
    {
      index: 0,
      name: "a.bin",
      size,
      mimeType: "application/octet-stream",
      totalChunks: Math.max(1, Math.ceil(size / chunkSize)),
      chunkSize,
    },
  ];

  it("accepts the current CHUNK_SIZE and larger declared chunk sizes", () => {
    expect(isValidFileManifest(manifestWith(CHUNK_SIZE * 3, CHUNK_SIZE), CHUNK_SIZE * 3)).toBe(true);
    expect(isValidFileManifest(manifestWith(MAX_CHUNK_SIZE * 2, MAX_CHUNK_SIZE), MAX_CHUNK_SIZE * 2)).toBe(true);
  });

  it("still accepts legacy 64 KiB senders", () => {
    const legacy = 64 * 1024;
    expect(isValidFileManifest(manifestWith(legacy * 2 + 7, legacy), legacy * 2 + 7)).toBe(true);
  });

  it("rejects out-of-bounds or self-inconsistent chunk sizes", () => {
    expect(isValidFileManifest(manifestWith(1024, MAX_CHUNK_SIZE * 2), 1024)).toBe(false);
    expect(isValidFileManifest(manifestWith(1024, 1024), 1024)).toBe(false); // below minimum
    // totalChunks that does not match size / declared chunkSize
    const bad = manifestWith(CHUNK_SIZE * 2, CHUNK_SIZE);
    bad[0].totalChunks = 99;
    expect(isValidFileManifest(bad, CHUNK_SIZE * 2)).toBe(false);
  });
});

describe("high-throughput transfer pipeline", () => {
  let server: AirBridgeServerInstance;
  let wsUrl: string;

  beforeAll(async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: "127.0.0.1",
      mode: "test",
      enableMdns: false,
      hostClipboard: false,
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterAll(async () => {
    await server.close();
  });

  async function makePair(prefix: string) {
    let completed: TransferSessionView | null = null;
    const receiver = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      storagePrefix: `${prefix}-rx`,
      deviceOverride: { name: "Receiver Mac", platform: "macos", model: "Mac", formFactor: "laptop" },
      onIncomingTransfer: (offer) => {
        void receiver.acceptIncomingTransfer(offer.transferId);
      },
      onTransferCompleted: (t) => {
        if (t.direction === "incoming") completed = t;
      },
    });
    const sender = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      storagePrefix: `${prefix}-tx`,
      deviceOverride: { name: "Sender Phone", platform: "android", model: "Pixel", formFactor: "phone" },
    });
    await receiver.start();
    await sender.start();
    await waitForCondition(
      () => sender.getSnapshot().peers.length === 1 && receiver.getSnapshot().peers.length === 1,
    );
    return {
      sender,
      receiver,
      senderPeerTarget: sender.getSnapshot().peers[0].peerId,
      getCompleted: () => completed,
      stop: () => {
        sender.stop();
        receiver.stop();
      },
    };
  }

  it("encrypts ahead concurrently instead of one chunk at a time", async () => {
    const pair = await makePair("speed-pipeline");
    try {
      const size = 4 * 1024 * 1024;
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 31 + 17) & 0xff;

      let inFlightReads = 0;
      let maxInFlightReads = 0;
      const input: SendableFileInput = {
        name: "pipeline.bin",
        size,
        type: "application/octet-stream",
        async sliceBytes(start, end) {
          inFlightReads++;
          maxInFlightReads = Math.max(maxInFlightReads, inFlightReads);
          await new Promise((r) => setTimeout(r, 2));
          inFlightReads--;
          return raw.slice(start, end);
        },
      };

      await pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() => pair.getCompleted() !== null);

      // The old serial loop could never exceed 1 read in flight.
      expect(maxInFlightReads).toBeGreaterThanOrEqual(4);
      expect(pair.getCompleted()!.status).toBe("completed");
      expect(pair.getCompleted()!.receivedFiles[0].verified).toBe(true);
    } finally {
      pair.stop();
    }
  });

  it("moves a 16 MiB file end-to-end, verified and byte-identical", async () => {
    const pair = await makePair("speed-large");
    try {
      const size = 16 * 1024 * 1024;
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 131 + 7) & 0xff;
      const input: SendableFileInput = {
        name: "large.bin",
        size,
        type: "application/octet-stream",
        async sliceBytes(start, end) {
          return raw.slice(start, end);
        },
      };

      const started = performance.now();
      await pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() => pair.getCompleted() !== null, 30000);
      const elapsedSec = (performance.now() - started) / 1000;

      const done = pair.getCompleted()!;
      expect(done.status).toBe("completed");
      expect(done.files[0].chunkSize).toBe(CHUNK_SIZE);
      expect(done.files[0].totalChunks).toBe(size / CHUNK_SIZE);
      expect(done.receivedFiles).toHaveLength(1);
      expect(done.receivedFiles[0].verified).toBe(true);

      const received = Buffer.concat(done.receivedFiles[0].chunks.map((c) => Buffer.from(c)));
      expect(Buffer.compare(received, Buffer.from(raw))).toBe(0);

      // Generous sanity bound (not a CI perf gate): the pipelined path
      // completes this in well under a second locally; 15 s only catches
      // a regression back to stall-bound chunk pumping.
      expect(elapsedSec).toBeLessThan(15);
      console.log(
        `16 MiB transfer: ${elapsedSec.toFixed(2)}s (${(size / 1048576 / elapsedSec).toFixed(1)} MiB/s end-to-end incl. SHA-256 verify)`,
      );
    } finally {
      pair.stop();
    }
  });
});
