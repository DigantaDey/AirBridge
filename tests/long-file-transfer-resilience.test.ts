import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarpClient } from '../src/client/engine/warpClient.js';
import { jwkIdentityStore } from '../src/client/engine/identity.js';
import { PartialReceiveStore } from '../src/server/partialReceive.js';
import {
  MAX_RELAY_BUFFERED_BYTES,
  RELAY_BACKPRESSURE_HIGH_WATER,
  SignalingHub,
} from '../src/server/signalingHub.js';
import { FRAME_ROUTED_RELAY } from '../src/shared/protocol.js';

function peerRoutedHeader(targetId: string, sourceId: string): Buffer {
  const buf = Buffer.alloc(1 + 16 + 16 + 64);
  buf[0] = FRAME_ROUTED_RELAY;
  buf.write(targetId, 1, 'ascii');
  buf.write(sourceId, 17, 'ascii');
  return buf;
}

describe('Long file transfer resilience (server relay + WarpClient resume + PartialReceiveStore)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('tolerates 2 missed ping ticks before dropping and pauses/resumes saturated TCP relay sockets cleanly', () => {
    vi.useFakeTimers();
    const hub = new SignalingHub({
      getLanUrls: () => ['http://127.0.0.1:4100'],
      getDaemonStatus: () => ({ enabled: false, platform: 'test', hostname: 'h', autoSaveToDownloads: false, clipboardBridge: false }),
      isLocalMachine: () => true,
    });
    cleanups.push(() => hub.close());

    expect(MAX_RELAY_BUFFERED_BYTES).toBe(64 * 1024 * 1024);

    // Inject two registered clients via private clients map through fake sockets to unit-test heartbeat + TCP backpressure cleanly
    class FakeRawSock extends EventEmitter {
      pause = vi.fn();
      resume = vi.fn();
      destroyed = false;
      bytesWritten = 1000;
    }
    class FakeWs extends EventEmitter {
      readyState = 1;
      bufferedAmount = 0;
      _socket = new FakeRawSock();
      ping = vi.fn();
      send = vi.fn();
      terminate = vi.fn(() => { this.readyState = 3; });
      close = vi.fn(() => { this.readyState = 3; });
    }

    const senderWs = new FakeWs();
    const targetWs = new FakeWs();
    const clients = (hub as unknown as { clients: Map<string, Record<string, unknown>> }).clients;
    clients.set('aaaaaaaaaaaaaaaa', {
      peerId: 'aaaaaaaaaaaaaaaa',
      ws: senderWs,
      networkKey: 'net:1',
      isLoopback: true,
      pairCode: 'ABC-DEF',
      visibility: 'nearby',
      device: { name: 'Mac', platform: 'macos', model: 'Mac', formFactor: 'laptop', publicKey: 'pk1' },
      connectedAt: 1,
      isAlive: false,
      missedPings: 0,
      lastBytesWritten: 1000,
      joinPairAttempts: [],
      remoteAddress: '127.0.0.1',
      admission: 'host',
      viaReverse: false,
      viaRelayed: false,
    });
    clients.set('bbbbbbbbbbbbbbbb', {
      peerId: 'bbbbbbbbbbbbbbbb',
      ws: targetWs,
      networkKey: 'net:1',
      isLoopback: false,
      pairCode: 'ABC-DEF',
      visibility: 'nearby',
      device: { name: 'Phone', platform: 'android', model: 'Phone', formFactor: 'phone', publicKey: 'pk2' },
      connectedAt: 2,
      isAlive: true,
      missedPings: 0,
      lastBytesWritten: 0,
      joinPairAttempts: [],
      remoteAddress: '192.168.1.20',
      admission: 'pake',
      viaReverse: false,
      viaRelayed: false,
    });

    // Advance 25s (1 missed ping): must NOT terminate sender!
    vi.advanceTimersByTime(25_000);
    expect(senderWs.terminate).not.toHaveBeenCalled();

    // Simulate active draining on target while isAlive=false -> must also tolerate!
    const targetEntry = clients.get('bbbbbbbbbbbbbbbb')!;
    targetEntry.isAlive = false;
    targetWs.bufferedAmount = 1024;
    targetWs._socket.bytesWritten = 50_000;
    vi.advanceTimersByTime(25_000);
    expect(targetWs.terminate).not.toHaveBeenCalled();

    // Advance sender past 3 missed pings with zero buffered progress -> terminates cleanly
    targetWs.bufferedAmount = 0;
    vi.advanceTimersByTime(50_000);
    expect(senderWs.terminate).toHaveBeenCalledTimes(1);
    expect(hub.getTelemetry().heartbeatTimeouts).toBeGreaterThanOrEqual(1);

    // Now test TCP pause/drain backpressure below 64 MiB
    senderWs.readyState = 1;
    targetWs.readyState = 1;
    senderWs.terminate.mockClear();
    targetWs.terminate.mockClear();
    targetWs.send.mockClear();
    clients.set('aaaaaaaaaaaaaaaa', {
      peerId: 'aaaaaaaaaaaaaaaa',
      ws: senderWs,
      networkKey: 'net:1',
      isLoopback: true,
      pairCode: 'ABC-DEF',
      visibility: 'nearby',
      device: { name: 'Mac', platform: 'macos', model: 'Mac', formFactor: 'laptop', publicKey: 'pk1' },
      connectedAt: 1,
      isAlive: true,
      missedPings: 0,
      lastBytesWritten: 1000,
      joinPairAttempts: [],
      remoteAddress: '127.0.0.1',
      admission: 'host',
      viaReverse: false,
      viaRelayed: false,
    });
    targetWs.bufferedAmount = RELAY_BACKPRESSURE_HIGH_WATER;
    const frame = peerRoutedHeader('bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa');
    (hub as unknown as { routeBinaryFrame: (c: unknown, d: Buffer) => void }).routeBinaryFrame(clients.get('aaaaaaaaaaaaaaaa'), frame);
    expect(targetWs.send).toHaveBeenCalledTimes(1);
    expect(senderWs._socket.pause).toHaveBeenCalledTimes(1);
    expect(hub.getTelemetry().relayBackpressurePauses).toBe(1);

    // Drain target below LOW_WATER -> resumes sender socket!
    targetWs.bufferedAmount = 0;
    targetWs._socket.emit('drain');
    expect(senderWs._socket.resume).toHaveBeenCalledTimes(1);
    expect(hub.getTelemetry().relayBackpressureResumes).toBe(1);
  });

  it('PartialReceiveStore finalizes both in-order and out-of-order chunks accurately and records finalize/rehash telemetry', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-pr-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const store = new PartialReceiveStore({ enabled: true, downloadDir: tmp, autoSaveToDownloads: true, notifyOnReceive: false, revealInFinder: false });
    const c0 = Buffer.alloc(16 * 1024, 0xaa);
    const c1 = Buffer.alloc(16 * 1024, 0xbb);
    const c2 = Buffer.alloc(1024, 0xcc);
    const expectedSha = crypto.createHash('sha256').update(c0).update(c1).update(c2).digest('hex');

    // 1. In-order delivery: hashes incrementally without disk rehash
    const inOrderMeta = { transferId: '1234567890abcdef', fileIndex: 0, name: 'inorder.bin', size: c0.length + c1.length + c2.length, chunkSize: 16 * 1024, totalChunks: 3 };
    await store.writeChunk(inOrderMeta, 0, c0);
    await store.writeChunk(inOrderMeta, 1, c1);
    await store.writeChunk(inOrderMeta, 2, c2);
    const finalizedInOrder = await store.finalize(inOrderMeta.transferId, 0, expectedSha);
    expect(finalizedInOrder.sha256).toBe(expectedSha);
    expect(fs.existsSync(finalizedInOrder.savedPath)).toBe(true);
    let stats = store.getStats();
    expect(stats.finalizeCount).toBe(1);
    expect(stats.finalizeRehashCount).toBe(0);
    expect(stats.lastFinalizeDurationMs).not.toBeNull();

    // 2. Out-of-order delivery: falls back cleanly to disk rehash on finalize
    const oooMeta = { transferId: 'abcdef1234567890', fileIndex: 0, name: 'movie.bin', size: c0.length + c1.length + c2.length, chunkSize: 16 * 1024, totalChunks: 3 };
    await store.writeChunk(oooMeta, 2, c2);
    await store.writeChunk(oooMeta, 1, c1);
    await store.writeChunk(oooMeta, 0, c0);
    const finalizedOoo = await store.finalize(oooMeta.transferId, 0, expectedSha);
    expect(finalizedOoo.sha256).toBe(expectedSha);
    expect(fs.existsSync(finalizedOoo.savedPath)).toBe(true);
    stats = store.getStats();
    expect(stats.finalizeCount).toBe(2);
    expect(stats.finalizeRehashCount).toBe(1);
    expect(stats.lastFinalizeDurationMs).not.toBeNull();
  });

  it('DaemonReceiver retries transient HTTP 503 chunk writes and WarpClient resumes near-completion transfers across identity-proven key refresh', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airbridge-resilience-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    let port = 0;
    const hub = new SignalingHub({
      getLanUrls: () => [`http://127.0.0.1:${port}`],
      getDaemonStatus: () => ({ enabled: false, platform: 'test', hostname: 'h', autoSaveToDownloads: false, clipboardBridge: false }),
      isLocalMachine: () => true,
    });

    // Local HTTP endpoint that returns transient HTTP 503 on first chunk attempt, then 200 OK via real PartialReceiveStore
    const partialStore = new PartialReceiveStore({ enabled: true, downloadDir: path.join(tmp, 'downloads'), autoSaveToDownloads: true, notifyOnReceive: false, revealInFinder: false });
    let failFirstChunk = true;
    const server = http.createServer(async (req, res) => {
      if (req.url === '/api/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.startsWith('/api/daemon/received')) {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        const tid = u.searchParams.get('transferId') || '';
        const fidx = Number(u.searchParams.get('fileIndex') || '0');
        const summary = await partialStore.listReceived(tid, fidx);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(summary ? { ok: true, ...summary } : { ok: true, complete: false }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const body = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/daemon/receive-chunk') {
        if (failFirstChunk) {
          failFirstChunk = false;
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'transient' }));
          return;
        }
        await partialStore.writeChunk(
          {
            transferId: String(req.headers['x-airbridge-transfer']),
            fileIndex: Number(req.headers['x-airbridge-file']),
            name: decodeURIComponent(String(req.headers['x-airbridge-name'])),
            size: Number(req.headers['x-airbridge-size']),
            chunkSize: Number(req.headers['x-airbridge-chunk-size']),
            totalChunks: Number(req.headers['x-airbridge-total-chunks']),
          },
          Number(req.headers['x-airbridge-chunk']),
          body,
        );
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/api/daemon/finalize') {
        const parsed = JSON.parse(body.toString('utf8')) as { transferId: string; fileIndex: number; expectedSha256?: string };
        const result = await partialStore.finalize(parsed.transferId, parsed.fileIndex, parsed.expectedSha256);
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.on('upgrade', (req, sock, head) => {
      hub.wss.handleUpgrade(req, sock, head, (ws) => {
        hub.wss.emit('connection', ws, req);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    cleanups.push(() => {
      hub.close();
      return new Promise((r) => server.close(() => r()));
    });

    let senderIdJson: string | null = null;
    let receiverIdJson: string | null = null;
    const sender = new WarpClient({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      initialPairCode: hub.getDefaultPairCode(),
      enableWebRtc: false,
      identityStore: jwkIdentityStore(() => senderIdJson, (v) => { senderIdJson = v; }),
    });
    const receiver = new WarpClient({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      initialPairCode: hub.getDefaultPairCode(),
      enableWebRtc: false,
      autoAcceptAll: true,
      identityStore: jwkIdentityStore(() => receiverIdJson, (v) => { receiverIdJson = v; }),
    });
    cleanups.push(() => { sender.stop(); receiver.stop(); });
    // Enable localDaemon on receiver so DaemonReceiver exercises real HTTP retry path!
    (receiver as unknown as { localDaemon: Record<string, unknown>; apiBaseUrl: () => string }).apiBaseUrl = () => `http://127.0.0.1:${port}`;
    await sender.start();
    await receiver.start();
    // Wait until paired peers discover each other
    const waitPeer = async (client: WarpClient) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const peer = client.getSnapshot().peers[0];
        if (peer) return peer;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('peer timeout');
    };
    const rcvPeer = await waitPeer(sender);
    await waitPeer(receiver);
    (receiver as unknown as { localDaemon: Record<string, unknown> }).localDaemon = {
      enabled: true, platform: 'macos', hostname: 'h', autoSaveToDownloads: true, clipboardBridge: false,
    };

    const payload = crypto.randomBytes(256 * 1024 + 4096);
    const session = await sender.sendFiles(rcvPeer.peerId, [{
      name: 'resilience.bin',
      size: payload.byteLength,
      type: 'application/octet-stream',
      sliceBytes: async (start, end) => payload.subarray(start, end),
    }]);
    expect(session.status).toBe('completed');
    expect(receiver.getDiagnostics().transferChunkRetries).toBeGreaterThanOrEqual(1);
    expect(receiver.getDiagnostics().lastFinalizeDurationMs).not.toBeNull();
  });

  it('matchesTransferPeerIdentity allows refreshed ephemeral publicKey under verified identityKey and ws.onclose resolves pending completionAckWaiters with null', async () => {
    const client = new WarpClient({
      wsUrl: 'ws://127.0.0.1:1/ws',
      initialPairCode: 'ABC-DEF',
      enableWebRtc: false,
    });
    cleanups.push(() => client.stop());

    const priv = client as unknown as {
      identityChecks: Map<string, boolean>;
      matchesTransferPeerIdentity: (
        candidate: { peerId: string; device: { name: string; platform: string; model: string; formFactor: string; publicKey: string; identityKey?: string; identitySig?: string } },
        expectedPublicKey?: string,
        expectedIdentityKey?: string,
      ) => boolean;
      outgoingStates: Map<string, {
        cancelled: boolean;
        ackWaiters: Array<() => void>;
        completionAckWaiters: Array<(res: { verified: boolean; reason?: string } | null) => void>;
      }>;
    };

    // 1. Proven identity allows refreshed ephemeral publicKey while rejecting changed identityKey or unauthenticated publicKey change
    priv.identityChecks.set('id-trusted|sig-new|pk-ephemeral-2', true);
    priv.identityChecks.set('id-attacker|sig-bad|pk-ephemeral-2', true);

    expect(
      priv.matchesTransferPeerIdentity(
        {
          peerId: 'p2',
          device: {
            name: 'Phone',
            platform: 'android',
            model: 'Pixel',
            formFactor: 'phone',
            publicKey: 'pk-ephemeral-2',
            identityKey: 'id-trusted',
            identitySig: 'sig-new',
          },
        },
        'pk-ephemeral-1',
        'id-trusted',
      ),
    ).toBe(true);

    expect(
      priv.matchesTransferPeerIdentity(
        {
          peerId: 'p3',
          device: {
            name: 'Phone',
            platform: 'android',
            model: 'Pixel',
            formFactor: 'phone',
            publicKey: 'pk-ephemeral-2',
            identityKey: 'id-attacker',
            identitySig: 'sig-bad',
          },
        },
        'pk-ephemeral-1',
        'id-trusted',
      ),
    ).toBe(false);

    expect(
      priv.matchesTransferPeerIdentity(
        {
          peerId: 'p4',
          device: {
            name: 'Phone',
            platform: 'android',
            model: 'Pixel',
            formFactor: 'phone',
            publicKey: 'pk-ephemeral-2',
          },
        },
        'pk-ephemeral-1',
        undefined,
      ),
    ).toBe(false);

    // 2. ws.onclose resolves pending completionAckWaiters with null (resumable retry)
    const waiterResults: Array<{ verified: boolean; reason?: string } | null> = [];
    const origWs = globalThis.WebSocket;
    const captured: { ws: { onclose?: (ev?: { code?: number; reason?: string }) => void } | null } = { ws: null };
    class MockWs {
      readyState = 1;
      bufferedAmount = 0;
      binaryType = 'arraybuffer';
      onopen?: () => void;
      onmessage?: (ev: { data: unknown }) => void;
      onerror?: () => void;
      onclose?: (ev?: { code?: number; reason?: string }) => void;
      send = vi.fn();
      close = vi.fn(() => { this.readyState = 3; });
      constructor() {
        captured.ws = this;
      }
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWs;
    try {
      const wsClient = new WarpClient({
        wsUrl: 'ws://127.0.0.1:1/ws',
        initialPairCode: 'ABC-DEF',
        enableWebRtc: false,
      });
      cleanups.push(() => wsClient.stop());
      await wsClient.start();
      const privWs = wsClient as unknown as typeof priv;
      privWs.outgoingStates.set('fedcba0987654321', {
        cancelled: false,
        ackWaiters: [],
        completionAckWaiters: [(res) => waiterResults.push(res)],
      });
      expect(captured.ws?.onclose).toBeTypeOf('function');
      captured.ws?.onclose?.({ code: 1006, reason: 'network drop' });
      expect(waiterResults).toEqual([null]);
      wsClient.stop();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWs;
    }
  });

  it('retries a timed-out resumed transfer-offer without hanging and completes once the peer confirms', async () => {
    let port = 0;
    const hub = new SignalingHub({
      getLanUrls: () => [`http://127.0.0.1:${port}`],
      getDaemonStatus: () => ({ enabled: false, platform: 'test', hostname: 'h', autoSaveToDownloads: false, clipboardBridge: false }),
      isLocalMachine: () => true,
    });
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on('upgrade', (req, sock, head) => {
      hub.wss.handleUpgrade(req, sock, head, (ws) => {
        hub.wss.emit('connection', ws, req);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    cleanups.push(() => {
      hub.close();
      return new Promise((r) => server.close(() => r()));
    });

    const sender = new WarpClient({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      initialPairCode: hub.getDefaultPairCode(),
      enableWebRtc: false,
    });
    const receiver = new WarpClient({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      initialPairCode: hub.getDefaultPairCode(),
      enableWebRtc: false,
      autoAcceptAll: true,
    });
    cleanups.push(() => { sender.stop(); receiver.stop(); });
    await sender.start();
    await receiver.start();

    const waitPeer = async (client: WarpClient) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const peer = client.getSnapshot().peers[0];
        if (peer) return peer;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('peer timeout');
    };
    const rcvPeer = await waitPeer(sender);
    await waitPeer(receiver);

    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const senderPriv = sender as unknown as {
      ws: { close: (code?: number, reason?: string) => void } | null;
      sendControlMessage: (to: string, payload: Record<string, unknown>, encrypt: boolean) => Promise<void>;
      sendWsRelayBinaryWithBackpressure: (to: string, innerFrame: Uint8Array) => Promise<void>;
    };
    const origSendControl = senderPriv.sendControlMessage.bind(sender);
    const origSendBinary = senderPriv.sendWsRelayBinaryWithBackpressure.bind(sender);

    let offerCount = 0;
    let simulatedDrop = false;
    senderPriv.sendControlMessage = async (to, payload, encrypt) => {
      if (payload.kind === 'transfer-offer') {
        offerCount += 1;
        // Drop ONLY the 1st resumed transfer-offer (attempt #2) so resume accept times out at 10s
        if (offerCount === 2) {
          return;
        }
      }
      return origSendControl(to, payload, encrypt);
    };
    senderPriv.sendWsRelayBinaryWithBackpressure = async (to, innerFrame) => {
      await origSendBinary(to, innerFrame);
      if (!simulatedDrop) {
        simulatedDrop = true;
        // Force a real WS disconnect right after chunk 0 so streamOutgoingFiles enters resume flow
        senderPriv.ws?.close(4005, 'simulated mid-transfer drop');
      }
    };

    const payload = crypto.randomBytes(1280 * 1024); // 2 chunks (1 MiB + 256 KiB)
    const sendPromise = sender.sendFiles(rcvPeer.peerId, [{
      name: 'resume-offer-timeout.bin',
      size: payload.byteLength,
      type: 'application/octet-stream',
      sliceBytes: async (start, end) => payload.subarray(start, end),
    }]);

    let completed = false;
    const watched = sendPromise.then((res) => {
      completed = true;
      return res;
    });

    const tickDeadline = Date.now() + 12_000;
    while (!completed && Date.now() < tickDeadline) {
      await new Promise((r) => realSetTimeout(r, 10));
      if (completed) break;
      await vi.advanceTimersByTimeAsync(1_000);
    }

    const session = await watched;
    expect(session.status).toBe('completed');
    expect(offerCount).toBe(3);
    expect(sender.getDiagnostics().transferResumes).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
