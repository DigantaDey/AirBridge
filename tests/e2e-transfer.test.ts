import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirBridgeServer, type AirBridgeServerInstance } from '../src/server/index.js';
import {
  WarpClient,
  type ClipboardBeamItem,
  type SendableFileInput,
  type TransferSessionView,
} from '../src/client/engine/warpClient.js';

function createMemoryFile(name: string, sizeBytes: number, mimeType = 'application/octet-stream'): {
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
  timeoutMs = 5000
): Promise<void> {
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
    }, 25);
  });
}

describe('End-to-End Android <-> MacBook Discovery, E2EE Clipboard & Multi-Chunk File Transfer', () => {
  let server: AirBridgeServerInstance;
  let wsUrl: string;

  beforeAll(async () => {
    server = await createAirBridgeServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'test',
      enableMdns: false,
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('discovers peers automatically, verifies matching SAS codes, beams E2EE clipboard, and transfers multi-chunk files bidirectionally', async () => {
    let macReceivedClip: ClipboardBeamItem | null = null;
    let macIncomingOffer: TransferSessionView | null = null;
    let macCompletedTransfer: TransferSessionView | null = null;
    let androidCompletedTransfer: TransferSessionView | null = null;

    const macClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'MacBook Pro · Studio',
        platform: 'macos',
        model: 'MacBook',
        formFactor: 'laptop',
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
        if (done.direction === 'incoming') {
          macCompletedTransfer = done;
        }
      },
    });

    const androidClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      autoAcceptAll: true, // Trusted auto-accept for reverse MacBook -> Android test
      deviceOverride: {
        name: 'Pixel 9 Pro · Pocket',
        platform: 'android',
        model: 'Pixel 9 Pro',
        formFactor: 'phone',
      },
      onTransferCompleted: (done) => {
        if (done.direction === 'incoming') {
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
        macClient.getSnapshot().peerSecurity[androidClient.getSnapshot().peerId]?.sasCode !==
          '··· ···'
    );

    const macSnap = macClient.getSnapshot();
    const androidSnap = androidClient.getSnapshot();

    expect(macSnap.peers[0].device.name).toBe('Pixel 9 Pro · Pocket');
    expect(androidSnap.peers[0].device.name).toBe('MacBook Pro · Studio');
    expect(macSnap.peerSecurity[androidSnap.peerId].sasCode).toBe(
      androidSnap.peerSecurity[macSnap.peerId].sasCode
    );

    // 2. Universal Clipboard E2EE Beam (Android -> MacBook)
    await androidClient.sendClipboard(macSnap.peerId, 'https://developer.android.com/jetpack');
    await waitForCondition(() => macReceivedClip !== null);
    expect(macReceivedClip!.text).toBe('https://developer.android.com/jetpack');
    expect(macReceivedClip!.contentType).toBe('url');

    // 3. Multi-chunk multi-file E2EE transfer (Android -> MacBook: 380 KB video + 12 KB photo)
    const videoFile = createMemoryFile('PXL_20261024_4K.mp4', 380 * 1024, 'video/mp4');
    const photoFile = createMemoryFile('PXL_20261024_PORTRAIT.jpg', 12 * 1024 + 333, 'image/jpeg');

    await androidClient.sendFiles(macSnap.peerId, [videoFile.input, photoFile.input]);
    await waitForCondition(() => macCompletedTransfer !== null);

    expect(macIncomingOffer).not.toBeNull();
    expect(macCompletedTransfer!.status).toBe('completed');
    expect(macCompletedTransfer!.receivedFiles).toHaveLength(2);
    expect(macCompletedTransfer!.receivedFiles[0].verified).toBe(true);
    expect(macCompletedTransfer!.receivedFiles[1].verified).toBe(true);

    const reassembledVideo = Buffer.concat(
      macCompletedTransfer!.receivedFiles[0].chunks.map((c) => Buffer.from(c))
    );
    expect(Buffer.compare(reassembledVideo, Buffer.from(videoFile.raw))).toBe(0);

    // 4. Reverse direction (MacBook -> Android: DMG / APK / PDF)
    const pdfFile = createMemoryFile('Architecture-Spec.pdf', 150 * 1024, 'application/pdf');
    await macClient.sendFiles(androidSnap.peerId, [pdfFile.input]);
    await waitForCondition(() => androidCompletedTransfer !== null);

    expect(androidCompletedTransfer!.status).toBe('completed');
    expect(androidCompletedTransfer!.receivedFiles[0].verified).toBe(true);
    const reassembledPdf = Buffer.concat(
      androidCompletedTransfer!.receivedFiles[0].chunks.map((c) => Buffer.from(c))
    );
    expect(Buffer.compare(reassembledPdf, Buffer.from(pdfFile.raw))).toBe(0);

    macClient.stop();
    androidClient.stop();
  });

  it('pairs across separate networks via 6-char Warp Code in paired-only visibility mode and handles decline cleanly', async () => {
    const macClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'MacBook Air M3',
        platform: 'macos',
        model: 'MacBook',
        formFactor: 'laptop',
      },
      onIncomingTransfer: (offer) => {
        macClient.declineIncomingTransfer(offer.transferId);
      },
    });

    const androidClient = new WarpClient({
      wsUrl,
      enableWebRtc: false,
      deviceOverride: {
        name: 'Galaxy S25 Ultra',
        platform: 'android',
        model: 'Galaxy',
        formFactor: 'phone',
      },
    });

    await macClient.start();
    await androidClient.start();

    await waitForCondition(() => macClient.getSnapshot().pairCode.length === 6);
    macClient.setVisibility('paired-only');
    androidClient.setVisibility('paired-only');

    // In paired-only mode with distinct default pair codes, neither sees the other yet
    await waitForCondition(() => macClient.getSnapshot().peers.length === 0);

    // Android scans QR / enters MacBook's 6-char pair code
    const macPairCode = macClient.getSnapshot().pairCode;
    androidClient.joinPairCode(macPairCode);

    await waitForCondition(
      () =>
        macClient.getSnapshot().peers.length === 1 &&
        androidClient.getSnapshot().peers.length === 1
    );
    expect(macClient.getSnapshot().peers[0].discoveryScope).toBe('paired');

    // Test transfer decline flow
    const sample = createMemoryFile('test.apk', 4096);
    const result = await androidClient.sendFiles(macClient.getSnapshot().peerId, [sample.input]);
    expect(result.status).toBe('declined');

    macClient.stop();
    androidClient.stop();
  });
});
