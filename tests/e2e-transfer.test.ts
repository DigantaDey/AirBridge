import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAirBridgeServer,
  type AirBridgeServerInstance,
} from "../src/server/index.js";
import type { HostClipboardProvider } from "../src/server/hostClipboard.js";
import {
  derivePeerSession,
  encryptBinaryChunk,
  encryptControlPayload,
  generateIdentityKeyPair,
  sha256Hex,
} from "../src/client/engine/crypto.js";
import {
  type ControlPayload,
  encodeEncryptedChunkFrame,
  wrapRoutedRelayFrame,
} from "../src/shared/protocol.js";
import {
  WarpClient,
  type ClipboardBeamItem,
  type SendableFileInput,
  type TransferSessionView,
} from "../src/client/engine/warpClient.js";

function createMemoryFile(
  name: string,
  sizeBytes: number,
  mimeType = "application/octet-stream",
): {
  input: SendableFileInput;
  raw: Uint8Array;
} {
  const raw = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    raw[i] = (i * 31 + 17) & 0xff;
  }
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

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
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
    }, 25);
  });
}

describe("End-to-End Android <-> MacBook Discovery, E2EE Clipboard & Multi-Chunk File Transfer", () => {
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

  it("discovers peers automatically, verifies matching SAS codes, beams E2EE clipboard, and transfers multi-chunk files bidirectionally", async () => {
    let macReceivedClip: ClipboardBeamItem | null = null;
    let macIncomingOffer: TransferSessionView | null = null;
    let macCompletedTransfer: TransferSessionView | null = null;
    let androidCompletedTransfer: TransferSessionView | null = null;

    const macClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: "MacBook Pro · Studio",
        platform: "macos",
        model: "MacBook",
        formFactor: "laptop",
      },
      onIncomingClipboard: (item) => {
        macReceivedClip = item;
      },
      onIncomingTransfer: (offer) => {
        macIncomingOffer = offer;
        // Simulate user clicking "Accept" on MacBook AirDrop modal
        macClient.acceptIncomingTransfer(offer.transferId);
      },
      onTransferCompleted: (done) => {
        if (done.direction === "incoming") {
          macCompletedTransfer = done;
        }
      },
    });

    const androidClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      autoAcceptAll: true, // Trusted auto-accept for reverse MacBook -> Android test
      deviceOverride: {
        name: "Pixel 9 Pro · Pocket",
        platform: "android",
        model: "Pixel 9 Pro",
        formFactor: "phone",
      },
      onTransferCompleted: (done) => {
        if (done.direction === "incoming") {
          androidCompletedTransfer = done;
        }
      },
    });

    await macClient.start();
    await androidClient.start();

    // 1. Automatic nearby discovery & matching E2EE SAS verification codes
    await waitForCondition(
      () =>
        macClient.getSnapshot().peers.length === 1 &&
        androidClient.getSnapshot().peers.length === 1 &&
        macClient.getSnapshot().peerSecurity[androidClient.getSnapshot().peerId]
          ?.sasCode !== "··· ···",
    );

    const macSnap = macClient.getSnapshot();
    const androidSnap = androidClient.getSnapshot();

    expect(macSnap.peers[0].device.name).toBe("Pixel 9 Pro · Pocket");
    expect(androidSnap.peers[0].device.name).toBe("MacBook Pro · Studio");
    expect(macSnap.peerSecurity[androidSnap.peerId].sasCode).toBe(
      androidSnap.peerSecurity[macSnap.peerId].sasCode,
    );

    // 2. Universal Clipboard E2EE Beam (Android -> MacBook)
    await androidClient.sendClipboard(
      macSnap.peerId,
      "https://developer.android.com/jetpack",
    );
    await waitForCondition(() => macReceivedClip !== null);
    expect(macReceivedClip!.text).toBe("https://developer.android.com/jetpack");
    expect(macReceivedClip!.contentType).toBe("url");

    // 3. Multi-chunk multi-file E2EE transfer (Android -> MacBook: 380 KB video + 12 KB photo)
    const videoFile = createMemoryFile(
      "PXL_20261024_4K.mp4",
      380 * 1024,
      "video/mp4",
    );
    const photoFile = createMemoryFile(
      "PXL_20261024_PORTRAIT.jpg",
      12 * 1024 + 333,
      "image/jpeg",
    );

    await androidClient.sendFiles(macSnap.peerId, [
      videoFile.input,
      photoFile.input,
    ]);
    await waitForCondition(() => macCompletedTransfer !== null);

    expect(macIncomingOffer).not.toBeNull();
    expect(macCompletedTransfer!.status).toBe("completed");
    expect(macCompletedTransfer!.receivedFiles).toHaveLength(2);
    expect(macCompletedTransfer!.receivedFiles[0].verified).toBe(true);
    expect(macCompletedTransfer!.receivedFiles[1].verified).toBe(true);

    const reassembledVideo = Buffer.concat(
      macCompletedTransfer!.receivedFiles[0].chunks.map((c) => Buffer.from(c)),
    );
    expect(Buffer.compare(reassembledVideo, Buffer.from(videoFile.raw))).toBe(
      0,
    );

    // 4. Reverse direction (MacBook -> Android: DMG / APK / PDF)
    const pdfFile = createMemoryFile(
      "Architecture-Spec.pdf",
      150 * 1024,
      "application/pdf",
    );
    await macClient.sendFiles(androidSnap.peerId, [pdfFile.input]);
    await waitForCondition(() => androidCompletedTransfer !== null);

    expect(androidCompletedTransfer!.status).toBe("completed");
    expect(androidCompletedTransfer!.receivedFiles[0].verified).toBe(true);
    const reassembledPdf = Buffer.concat(
      androidCompletedTransfer!.receivedFiles[0].chunks.map((c) =>
        Buffer.from(c),
      ),
    );
    expect(Buffer.compare(reassembledPdf, Buffer.from(pdfFile.raw))).toBe(0);

    macClient.stop();
    androidClient.stop();
  });

  it("pairs across separate networks via 6-char Warp Code in paired-only visibility mode and handles decline cleanly", async () => {
    const macClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: "MacBook Air M3",
        platform: "macos",
        model: "MacBook",
        formFactor: "laptop",
      },
      onIncomingTransfer: (offer) => {
        macClient.declineIncomingTransfer(offer.transferId);
      },
    });

    const androidClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: "Galaxy S25 Ultra",
        platform: "android",
        model: "Galaxy",
        formFactor: "phone",
      },
    });

    await macClient.start();
    await androidClient.start();

    await waitForCondition(() => macClient.getSnapshot().pairCode.length === 6);
    macClient.setVisibility("paired-only");
    androidClient.setVisibility("paired-only");

    // In paired-only mode with distinct default pair codes, neither sees the other yet
    await waitForCondition(() => macClient.getSnapshot().peers.length === 0);

    // Android scans QR / enters MacBook's 6-char pair code
    const macPairCode = macClient.getSnapshot().pairCode;
    androidClient.joinPairCode(macPairCode);

    await waitForCondition(
      () =>
        macClient.getSnapshot().peers.length === 1 &&
        androidClient.getSnapshot().peers.length === 1,
    );
    expect(macClient.getSnapshot().peers[0].discoveryScope).toBe("paired");

    // Test transfer decline flow
    const sample = createMemoryFile("test.apk", 4096);
    const result = await androidClient.sendFiles(
      macClient.getSnapshot().peerId,
      [sample.input],
    );
    expect(result.status).toBe("declined");

    macClient.stop();
    androidClient.stop();
  });
  it("honors a QR invitation on initial startup with nearby discovery disabled", async () => {
    const host = new WarpClient({ wsUrl, enableWebRtc: false });
    let phone: WarpClient | undefined;
    try {
      await host.start();
      await waitForCondition(() => host.getSnapshot().pairCode.length === 6);
      host.setVisibility("paired-only");
      phone = new WarpClient({
        wsUrl,
        enableWebRtc: false,
        initialPairCode: host.getSnapshot().pairCode,
        deviceOverride: {
          name: "Real Android",
          platform: "android",
          model: "Android",
          formFactor: "phone",
        },
      });
      await phone.start();
      phone.setVisibility("paired-only");
      await waitForCondition(
        () =>
          host.getSnapshot().peers.length === 1 &&
          phone!.getSnapshot().peers.length === 1,
      );
      expect(host.getSnapshot().peers[0].device.name).toBe("Real Android");
      expect(host.getSnapshot().peers[0].discoveryScope).toBe("paired");
      expect(phone.getSnapshot().pairCode).toBe(host.getSnapshot().pairCode);
    } finally {
      phone?.stop();
      host.stop();
    }
  });

  it("does not reconnect a client stopped while async key generation is pending", async () => {
    const client = new WarpClient({ wsUrl, enableWebRtc: false });
    const startup = client.start();
    client.stop();
    await startup;
    expect(client.getSnapshot().connectionState).toBe("disconnected");
    // A canceled start must not reach hello/registration on the server.
    expect(client.getSnapshot().pairCode).toBe("");
  });

  it("auto-beams copied text in the background without returning to the browser page and syncs incoming clipboard back to host OS", async () => {
    let macOsClipboard = "Initial clipboard before AirBridge";
    const provider: HostClipboardProvider = {
      isSupported: () => true,
      readText: async () => macOsClipboard,
      writeText: async (text: string) => {
        macOsClipboard = text;
        return true;
      },
    };

    const clipServer = await createAirBridgeServer({
      port: 0,
      host: "127.0.0.1",
      mode: "test",
      enableMdns: false,
      hostClipboard: provider,
      hostClipboardPollMs: 120,
    });
    const clipWsUrl = `ws://127.0.0.1:${clipServer.port}/ws`;

    const receivedOnAndroid: ClipboardBeamItem[] = [];
    const outgoingAutoOnMac: ClipboardBeamItem[] = [];
    const receivedOnMac: ClipboardBeamItem[] = [];

    const macClient = new WarpClient({
      wsUrl: clipWsUrl,
      enableWebRtc: false,
      deviceOverride: {
        deviceId: "1111222233334444",
        name: "MacBook Pro · Zenith",
        platform: "macos",
        model: "MacBook",
        formFactor: "laptop",
      },
      onOutgoingAutoClipboard: (item) => outgoingAutoOnMac.push(item),
      onIncomingClipboard: (item) => receivedOnMac.push(item),
    });

    const androidClient = new WarpClient({
      wsUrl: clipWsUrl,
      enableWebRtc: false,
      deviceOverride: {
        deviceId: "5555666677778888",
        name: "Pixel 9 Pro · Solstice",
        platform: "android",
        model: "Pixel",
        formFactor: "phone",
      },
      onIncomingClipboard: (item) => receivedOnAndroid.push(item),
    });

    try {
      await macClient.start();
      await waitForCondition(() => macClient.getSnapshot().pairCode.length === 6);
      androidClient.joinPairCode(macClient.getSnapshot().pairCode);
      await androidClient.start();

      await waitForCondition(
        () =>
          macClient.getSnapshot().peers.length === 1 &&
          androidClient.getSnapshot().peers.length === 1,
      );
      expect(macClient.getSnapshot().localDaemon.clipboardBridge).toBe(true);
      expect(androidClient.getSnapshot().localDaemon.clipboardBridge).toBeFalsy();

      // Wait for initial OS clipboard seed, then copy in another macOS app without touching AirBridge UI
      await new Promise((r) => setTimeout(r, 160));
      macOsClipboard = "https://arena.ai/docs/zero-click-universal-clipboard";

      await waitForCondition(() => receivedOnAndroid.length === 1);
      expect(receivedOnAndroid[0].text).toBe(
        "https://arena.ai/docs/zero-click-universal-clipboard",
      );
      expect(outgoingAutoOnMac).toHaveLength(1);

      // Android beams text back -> MacBook receives it AND writes directly to macOS clipboard without echo loop
      await androidClient.handleDetectedLocalClipboard("OTP 948271 from Android");
      await waitForCondition(() => receivedOnMac.length === 1);
      expect(receivedOnMac[0].text).toBe("OTP 948271 from Android");
      await waitForCondition(() => macOsClipboard === "OTP 948271 from Android");

      // Wait two poll cycles to verify zero echo loop back to Android
      await new Promise((r) => setTimeout(r, 280));
      expect(receivedOnAndroid).toHaveLength(1);
    } finally {
      macClient.stop();
      androidClient.stop();
      await clipServer.close();
    }
  });

  it("completes Android incoming transfers cleanly even when file-complete and transfer-complete arrive before binary chunks", async () => {
    // Guard against sparse array crashes in sha256Hex
    const sparse = new Array<Uint8Array | undefined>(2);
    sparse[1] = new Uint8Array([1, 2, 3]);
    const digest = await sha256Hex(sparse);
    expect(digest).toHaveLength(64);

    let androidCompleted: TransferSessionView | null = null;
    const androidClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        deviceId: "aaaa2222cccc4444",
        name: "Pixel 9 · Pulse",
        platform: "android",
        model: "Pixel",
        formFactor: "phone",
      },
      onIncomingTransfer: (offer) => {
        androidClient.acceptIncomingTransfer(offer.transferId);
      },
      onTransferCompleted: (session) => {
        androidCompleted = session;
      },
    });

    const WebSocketImpl = (await import("ws")).default;
    const senderIdentity = await generateIdentityKeyPair();
    let senderWs: InstanceType<typeof WebSocketImpl> | null = null;

    try {
      await androidClient.start();
      await waitForCondition(() => androidClient.getSnapshot().pairCode.length === 6);
      const roomCode = androidClient.getSnapshot().pairCode;
      const androidPeerId = androidClient.getSnapshot().peerId;

      senderWs = new WebSocketImpl(wsUrl);
      let senderPeerId = "";
      let acceptedResolve!: () => void;
      const acceptedPromise = new Promise<void>((resolve) => {
        acceptedResolve = resolve;
      });

      const senderSessionReady = new Promise<{
        aesKey: CryptoKey;
      }>((resolve, reject) => {
        senderWs!.on("error", reject);
        senderWs!.on("message", async (raw, isBinary) => {
          if (isBinary) return;
          const msg = JSON.parse(raw.toString());
          if (msg.type === "welcome") {
            senderPeerId = msg.peerId;
            const androidPeer = msg.peers.find(
              (p: { peerId: string }) => p.peerId === androidPeerId,
            );
            if (androidPeer) {
              const session = await derivePeerSession(
                senderIdentity.privateKey,
                senderIdentity.publicKeyB64,
                androidPeer.device.publicKey,
              );
              resolve(session);
            }
          } else if (msg.type === "transfer-control" && msg.from === androidPeerId) {
            acceptedResolve();
          }
        });
      });

      senderWs.on("open", () => {
        senderWs!.send(
          JSON.stringify({
            type: "hello",
            pairCode: roomCode,
            visibility: "nearby",
            device: {
              deviceId: "bbbb3333dddd5555",
              name: "MacBook Pro · Horizon",
              platform: "macos",
              model: "MacBook",
              formFactor: "laptop",
              publicKey: senderIdentity.publicKeyB64,
            },
          }),
        );
      });

      const { aesKey } = await senderSessionReady;
      const rawBytes = new Uint8Array(96 * 1024);
      for (let i = 0; i < rawBytes.length; i++) rawBytes[i] = (i * 13 + 7) & 0xff;
      const expectedSha = await sha256Hex([rawBytes]);
      // Fixed 16-char ASCII ID matching protocol chunk header format
      const transferId = "facefeed12345678";

      const sendEncryptedControl = async (payload: ControlPayload) => {
        const envelope = await encryptControlPayload(aesKey, payload);
        senderWs!.send(
          JSON.stringify({
            type: "transfer-control",
            to: androidPeerId,
            envelope,
          }),
        );
      };

      await sendEncryptedControl({
        kind: "transfer-offer",
        transferId,
        totalBytes: rawBytes.byteLength,
        createdAt: Date.now(),
        files: [
          {
            index: 0,
            name: "Delayed-WebRTC.bin",
            size: rawBytes.byteLength,
            mimeType: "application/octet-stream",
            totalChunks: 2,
            chunkSize: 64 * 1024,
          },
        ],
      });

      await acceptedPromise;

      // Simulate fast WebSocket control messages arriving BEFORE delayed WebRTC binary chunks!
      await sendEncryptedControl({
        kind: "file-complete",
        transferId,
        fileIndex: 0,
        sha256: expectedSha,
      });
      await sendEncryptedControl({
        kind: "transfer-complete",
        transferId,
      });

      // Deliver chunk 1 then chunk 0 out-of-order 40ms later
      await new Promise((r) => setTimeout(r, 40));
      const slice0 = rawBytes.slice(0, 64 * 1024);
      const slice1 = rawBytes.slice(64 * 1024);

      for (const [idx, slice] of [
        [1, slice1],
        [0, slice0],
      ] as const) {
        const encChunk = await encryptBinaryChunk(aesKey, slice, 0, idx);
        const inner = encodeEncryptedChunkFrame({
          transferId,
          fileIndex: 0,
          chunkIndex: idx,
          iv: encChunk.iv,
          ciphertext: encChunk.ciphertext,
        });
        const relay = wrapRoutedRelayFrame(androidPeerId, senderPeerId, inner);
        senderWs!.send(relay);
      }

      await waitForCondition(() => androidCompleted !== null);
      expect(androidCompleted!.status).toBe("completed");
      expect(androidCompleted!.receivedFiles).toHaveLength(1);
      expect(androidCompleted!.receivedFiles[0].verified).toBe(true);
      expect(androidCompleted!.receivedFiles[0].sha256).toBe(expectedSha);
      expect(androidClient.getSnapshot().transfers[0].status).toBe("completed");
    } finally {
      senderWs?.close();
      androidClient.stop();
    }
  });

  it("persists Android transfer history across reloads and reconciles missing history from MacBook via E2EE history-sync", async () => {
    const createMockStorage = (): Storage => {
      const map = new Map<string, string>();
      return {
        get length() {
          return map.size;
        },
        clear: () => map.clear(),
        getItem: (key: string) => map.get(key) ?? null,
        key: (index: number) => Array.from(map.keys())[index] ?? null,
        removeItem: (key: string) => {
          map.delete(key);
        },
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
      };
    };

    const previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
    const androidStorage = createMockStorage();
    const freshPwaStorage = createMockStorage();

    let macClient: WarpClient | null = null;
    let androidClient1: WarpClient | null = null;
    let androidClientReloaded: WarpClient | null = null;
    let androidFreshPwa: WarpClient | null = null;

    try {
      (globalThis as { localStorage?: Storage }).localStorage = androidStorage;

      macClient = new WarpClient({
        wsUrl,
        enableWebRtc: false,
        storagePrefix: "mac-browser",
        deviceOverride: {
          deviceId: "1010101020202020",
          name: "MacBook Pro · Nova",
          platform: "macos",
          model: "MacBook",
          formFactor: "laptop",
        },
      });

      await macClient.start();
      await waitForCondition(() => macClient!.getSnapshot().pairCode.length === 6);
      const pairCode = macClient.getSnapshot().pairCode;

      androidClient1 = new WarpClient({
        wsUrl,
        enableWebRtc: false,
        storagePrefix: "android-browser",
        initialPairCode: pairCode,
        deviceOverride: {
          deviceId: "3030303040404040",
          name: "Pixel 9 Pro · Relay",
          platform: "android",
          model: "Pixel",
          formFactor: "phone",
        },
        onIncomingTransfer: (offer) => {
          androidClient1?.acceptIncomingTransfer(offer.transferId);
        },
      });

      await androidClient1.start();

      await waitForCondition(
        () =>
          macClient!.getSnapshot().peers.length === 1 &&
          androidClient1!.getSnapshot().peers.length === 1,
      );

      const firstFile = createMemoryFile("First-Receipt.pdf", 8192, "application/pdf");
      const secondFile = createMemoryFile("Second-Deck.pptx", 12288, "application/octet-stream");

      await macClient.sendFiles(androidClient1.getSnapshot().peerId, [firstFile.input]);
      await waitForCondition(
        () =>
          androidClient1!.getSnapshot().transfers.some(
            (t) => t.files[0]?.name === "First-Receipt.pdf" && t.status === "completed",
          ),
      );

      // Ensure distinct timestamps so newest-first ordering is deterministic
      await new Promise((r) => setTimeout(r, 15));
      await macClient.sendFiles(androidClient1.getSnapshot().peerId, [secondFile.input]);
      await waitForCondition(
        () =>
          androidClient1!.getSnapshot().transfers.filter((t) => t.status === "completed")
            .length === 2,
      );

      const androidList1 = androidClient1.getSnapshot().transfers;
      expect(androidList1.map((t) => t.files[0].name)).toEqual([
        "Second-Deck.pptx",
        "First-Receipt.pdf",
      ]);

      // 1. Simulate Android page reload / Share Sheet redirect using persisted localStorage
      androidClient1.stop();
      androidClientReloaded = new WarpClient({
        wsUrl,
        enableWebRtc: false,
        storagePrefix: "android-browser",
        deviceOverride: {
          deviceId: "3030303040404040",
          name: "Pixel 9 Pro · Relay",
          platform: "android",
          model: "Pixel",
          formFactor: "phone",
        },
      });
      expect(
        androidClientReloaded.getSnapshot().transfers.map((t) => t.files[0].name),
      ).toEqual(["Second-Deck.pptx", "First-Receipt.pdf"]);
      expect(androidClientReloaded.getSnapshot().transfers[0].direction).toBe("incoming");
      androidClientReloaded.stop();

      // 2. Simulate opening Android in a fresh PWA / cleared browser storage context and pairing with MacBook:
      // MacBook automatically reconciles missing transfer history onto Android over E2EE history-sync!
      (globalThis as { localStorage?: Storage }).localStorage = freshPwaStorage;
      androidFreshPwa = new WarpClient({
        wsUrl,
        enableWebRtc: false,
        storagePrefix: "android-pwa",
        initialPairCode: pairCode,
        deviceOverride: {
          deviceId: "9999888877776666",
          name: "Pixel 9 Pro · Fresh",
          platform: "android",
          model: "Pixel",
          formFactor: "phone",
        },
      });
      expect(androidFreshPwa.getSnapshot().transfers).toHaveLength(0);

      await androidFreshPwa.start();
      await waitForCondition(
        () => androidFreshPwa!.getSnapshot().transfers.length === 2,
      );

      const syncedTransfers = androidFreshPwa.getSnapshot().transfers;
      expect(syncedTransfers.map((t) => t.files[0].name)).toEqual([
        "Second-Deck.pptx",
        "First-Receipt.pdf",
      ]);
      expect(syncedTransfers.every((t) => t.direction === "incoming")).toBe(true);
      expect(syncedTransfers.every((t) => t.status === "completed")).toBe(true);
    } finally {
      macClient?.stop();
      androidClient1?.stop();
      androidClientReloaded?.stop();
      androidFreshPwa?.stop();
      if (previousStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        (globalThis as { localStorage?: Storage }).localStorage = previousStorage;
      }
    }
  });
});
