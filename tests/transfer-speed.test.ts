import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAirBridgeServer,
  type AirBridgeServerInstance,
} from "../src/server/index.js";
import {
  CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  WarpClient,
  countNewlyAcknowledgedChunks,
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

interface SpeedTestInternals {
  transfers: TransferSessionView[];
  outgoingStates: Map<string, {
    session: TransferSessionView;
    lastSpeedTs: number;
    lastSpeedBytes: number;
    ackWaiters: Array<() => void>;
    completionAckWaiters: Array<(result: { verified: boolean; reason?: string }) => void>;
    cancelled: boolean;
  }>;
  incomingStates: Map<string, {
    session: TransferSessionView;
    bytesReceived: number;
    lastSpeedTs: number;
    lastSpeedBytes: number;
  }>;
  speedProgress: Map<string, { bytes: number; at: number }>;
  refreshLiveTransferSpeeds(): void;
}

function liveSpeedView(direction: "incoming" | "outgoing"): TransferSessionView {
  return {
    transferId: `live-${direction}`,
    peerId: "1122334455667788",
    peerName: "Test device",
    peerPlatform: "android",
    sasCode: "123 · 456",
    direction,
    status: "transferring",
    transport: "ws-relay",
    files: [{
      index: 0,
      name: "live.bin",
      size: 4096,
      mimeType: "application/octet-stream",
      totalChunks: 1,
      chunkSize: 256 * 1024,
    }],
    totalBytes: 4096,
    transferredBytes: 512,
    speedBytesPerSec: 8 * 1024 * 1024,
    etaSeconds: 42,
    startedAt: Date.now(),
    receivedFiles: [],
  };
}

describe("live speed heartbeat on both peers", () => {
  it("clears a stale rate and ETA when neither device reports progress", () => {
    const client = new WarpClient({ enableWebRtc: false, storagePrefix: "speed-heartbeat" });
    const internal = client as unknown as SpeedTestInternals;
    const outgoing = liveSpeedView("outgoing");
    const incoming = liveSpeedView("incoming");
    internal.transfers = [outgoing, incoming];
    internal.outgoingStates.set(outgoing.transferId, {
      session: outgoing,
      lastSpeedTs: 0,
      lastSpeedBytes: 0,
      ackWaiters: [],
      completionAckWaiters: [],
      cancelled: false,
    });
    internal.incomingStates.set(incoming.transferId, {
      session: incoming,
      bytesReceived: 512,
      lastSpeedTs: 0,
      lastSpeedBytes: 0,
    });
    for (const view of [outgoing, incoming]) {
      internal.speedProgress.set(view.transferId, {
        bytes: 512,
        at: Date.now() - 2_000,
      });
    }

    internal.refreshLiveTransferSpeeds();

    expect(outgoing.speedBytesPerSec).toBe(0);
    expect(incoming.speedBytesPerSec).toBe(0);
    expect(outgoing.etaSeconds).toBeNull();
    expect(incoming.etaSeconds).toBeNull();
    expect(internal.outgoingStates.get(outgoing.transferId)!.lastSpeedBytes).toBe(512);
    expect(internal.incomingStates.get(incoming.transferId)!.lastSpeedBytes).toBe(512);
    client.stop();
  });

  it("keeps a fresh rate and recalculates ETA while bytes are moving", () => {
    const client = new WarpClient({ enableWebRtc: false, storagePrefix: "speed-heartbeat-live" });
    const internal = client as unknown as SpeedTestInternals;
    const outgoing = liveSpeedView("outgoing");
    outgoing.transferredBytes = 1024;
    internal.transfers = [outgoing];
    internal.outgoingStates.set(outgoing.transferId, {
      session: outgoing,
      lastSpeedTs: Date.now(),
      lastSpeedBytes: 1024,
      ackWaiters: [],
      completionAckWaiters: [],
      cancelled: false,
    });
    internal.speedProgress.set(outgoing.transferId, {
      bytes: 512,
      at: Date.now(),
    });

    internal.refreshLiveTransferSpeeds();

    expect(outgoing.speedBytesPerSec).toBe(8 * 1024 * 1024);
    expect(outgoing.etaSeconds).toBe(1);
    expect(internal.speedProgress.get(outgoing.transferId)!.bytes).toBe(1024);
    client.stop();
  });

  it("preserves the final rate while the receiver verifies and ACKs completion", () => {
    const client = new WarpClient({ enableWebRtc: false, storagePrefix: "speed-heartbeat-final" });
    const internal = client as unknown as SpeedTestInternals;
    const incoming = liveSpeedView("incoming");
    incoming.transferredBytes = incoming.totalBytes;
    internal.transfers = [incoming];
    internal.incomingStates.set(incoming.transferId, {
      session: incoming,
      bytesReceived: incoming.totalBytes,
      lastSpeedTs: 0,
      lastSpeedBytes: 0,
    });
    internal.speedProgress.set(incoming.transferId, {
      bytes: incoming.totalBytes,
      at: Date.now() - 2_000,
    });

    internal.refreshLiveTransferSpeeds();

    expect(incoming.speedBytesPerSec).toBe(8 * 1024 * 1024);
    expect(incoming.etaSeconds).toBeNull();
    client.stop();
  });
});

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

describe("per-file receiver ACK accounting", () => {
  it("does not treat a later file's ACK as proof that earlier files are durable", () => {
    // File 1 has ACKed all three chunks, while file 0 has not acknowledged any.
    // A single concatenated/global-index calculation would incorrectly count
    // file 0 as complete merely because file 1 produced an ACK.
    expect(countNewlyAcknowledgedChunks([0, 3, 0], undefined)).toBe(3);
    expect(countNewlyAcknowledgedChunks([2, 3, 1], undefined)).toBe(6);
  });

  it("counts only newly transferred chunks when files have durable resume prefixes", () => {
    expect(countNewlyAcknowledgedChunks([6, 4, 2], { 0: 4, 1: 4, 2: 1 })).toBe(3);
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

  async function makePair(prefix: string, autoAccept = true) {
    let completed: TransferSessionView | null = null;
    let incomingOffer: TransferSessionView | null = null;
    const receiver = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      storagePrefix: `${prefix}-rx`,
      deviceOverride: { name: "Receiver Mac", platform: "macos", model: "Mac", formFactor: "laptop" },
      onIncomingTransfer: (offer) => {
        incomingOffer = offer;
        if (autoAccept) void receiver.acceptIncomingTransfer(offer.transferId);
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
      getIncomingOffer: () => incomingOffer,
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

  it("keeps multi-file batches verified and reports live speed on both devices", async () => {
    const pair = await makePair("speed-multi-file");
    try {
      const files = Array.from({ length: 40 }, (_, fileIndex) => {
        const size = CHUNK_SIZE * 2 + fileIndex * 97;
        const raw = new Uint8Array(size);
        for (let i = 0; i < size; i++) raw[i] = (i * 17 + fileIndex * 31) & 0xff;
        const input: SendableFileInput = {
          name: `batch-${fileIndex}.bin`,
          size,
          type: "application/octet-stream",
          async sliceBytes(start, end) {
            return raw.slice(start, end);
          },
        };
        return { input, raw };
      });

      const senderDone = await pair.sender.sendFiles(
        pair.senderPeerTarget,
        files.map((f) => f.input),
      );
      await waitForCondition(() => pair.getCompleted() !== null);
      const receiverDone = pair.getCompleted()!;

      expect(senderDone.status).toBe("completed");
      expect(receiverDone.receivedFiles).toHaveLength(files.length);
      expect(senderDone.speedBytesPerSec).toBeGreaterThan(0);
      expect(receiverDone.speedBytesPerSec).toBeGreaterThan(0);
      for (const [index, file] of files.entries()) {
        const received = receiverDone.receivedFiles[index];
        expect(received.verified).toBe(true);
        expect(Buffer.compare(
          Buffer.concat(received.chunks.map((chunk) => Buffer.from(chunk))),
          Buffer.from(file.raw),
        )).toBe(0);
      }
    } finally {
      pair.stop();
    }
  });

  it("retries the initial offer after the signaling socket drops", async () => {
    const pair = await makePair("resume-initial-offer", false);
    try {
      const raw = new Uint8Array(CHUNK_SIZE + 37).fill(91);
      const input: SendableFileInput = {
        name: "waiting-offer.bin",
        size: raw.byteLength,
        type: "application/octet-stream",
        async sliceBytes(start, end) { return raw.slice(start, end); },
      };
      const sending = pair.sender.sendFiles(pair.senderPeerTarget, [input]);
      await waitForCondition(() => pair.getIncomingOffer() !== null);

      const senderSocket = (pair.sender as unknown as { ws: WebSocket }).ws;
      senderSocket.close();
      await waitForCondition(() => pair.sender.getSnapshot().connectionState === "reconnecting");
      await waitForCondition(
        () => pair.sender.getSnapshot().connectionState === "connected" &&
          pair.sender.getSnapshot().peers.length === 1,
        15_000,
      );
      await pair.receiver.acceptIncomingTransfer(pair.getIncomingOffer()!.transferId);

      const senderDone = await sending;
      await waitForCondition(() => pair.getCompleted() !== null);
      expect(senderDone.status).toBe("completed");
      expect(pair.getCompleted()!.receivedFiles[0].verified).toBe(true);
      expect(Buffer.compare(
        Buffer.concat(pair.getCompleted()!.receivedFiles[0].chunks.map((chunk) => Buffer.from(chunk))),
        Buffer.from(raw),
      )).toBe(0);
    } finally {
      pair.stop();
    }
  }, 25_000);

  it("resumes a multi-file transfer from receiver-stored chunks after a connection drop", async () => {
    const pair = await makePair("resume-mid-transfer");
    try {
      const files = Array.from({ length: 30 }, (_, fileIndex) => {
        const size = CHUNK_SIZE * 3 + fileIndex;
        const raw = new Uint8Array(size);
        for (let i = 0; i < size; i++) raw[i] = (i * 19 + fileIndex * 43) & 0xff;
        return {
          raw,
          input: {
            name: `resume-${fileIndex}.bin`,
            size,
            type: "application/octet-stream",
            async sliceBytes(start: number, end: number) {
              await new Promise((resolve) => setTimeout(resolve, 1));
              return raw.slice(start, end);
            },
          } satisfies SendableFileInput,
        };
      });
      const sending = pair.sender.sendFiles(
        pair.senderPeerTarget,
        files.map(({ input }) => input),
      );
      await waitForCondition(() => {
        const active = pair.receiver.getSnapshot().transfers.find(
          (transfer) => transfer.direction === "incoming" && transfer.status === "transferring",
        );
        return Boolean(active && active.transferredBytes >= CHUNK_SIZE * 8);
      }, 15_000);

      (pair.sender as unknown as { ws: WebSocket }).ws.close();
      const senderDone = await sending;
      await waitForCondition(() => pair.getCompleted() !== null, 25_000);
      const receiverDone = pair.getCompleted()!;
      expect(senderDone.status).toBe("completed");
      expect(receiverDone.status).toBe("completed");
      expect(receiverDone.receivedFiles).toHaveLength(files.length);
      for (const [index, file] of files.entries()) {
        const received = receiverDone.receivedFiles[index];
        expect(received.verified).toBe(true);
        expect(Buffer.compare(
          Buffer.concat(received.chunks.map((chunk) => Buffer.from(chunk))),
          Buffer.from(file.raw),
        )).toBe(0);
      }
    } finally {
      pair.stop();
    }
  }, 35_000);

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
