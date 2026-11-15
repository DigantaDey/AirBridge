import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  corruptFrameType,
  decodeEncryptedChunkFrame,
  encodeEncryptedChunkFrame,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  truncateFrame,
  unwrapRoutedRelayFrame,
  wrapRoutedRelayFrame,
} from '../harness/index.js';

describe('Tier 2 Boundary: Malformed JSON, Pre-Hello & Binary Framing Faults', () => {
  it('returns BAD_JSON without crashing the hub when receiving invalid JSON syntax', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const ws = new WebSocket(server.wsUrl);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      const replyPromise = new Promise<{ type: string; code: string }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send('{invalid-json');
      const reply = await replyPromise;
      expect(reply.type).toBe('error');
      expect(reply.code).toBe('BAD_JSON');
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('returns BAD_JSON when JSON primitive or missing-type object is sent', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const ws = new WebSocket(server.wsUrl);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      const replyPromise = new Promise<{ type: string; code: string }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(JSON.stringify({ noTypeField: 123 }));
      const reply = await replyPromise;
      expect(reply.code).toBe('BAD_JSON');
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('rejects any client command before hello registration with NOT_REGISTERED', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const ws = new WebSocket(server.wsUrl);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      const replyPromise = new Promise<{ type: string; code: string }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(JSON.stringify({ type: 'join-pair', pairCode: 'AAA222' }));
      const reply = await replyPromise;
      expect(reply.type).toBe('error');
      expect(reply.code).toBe('NOT_REGISTERED');
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('ignores pre-hello binary frames silently and keeps the server healthy', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const ws = new WebSocket(server.wsUrl);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      ws.send(new Uint8Array([0x02, 1, 2, 3, 4]));
      const health = await fetch(`${server.httpUrl}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('strips non-hex deviceId strings during hello device sanitization', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const phone = await OpaquePeer.create({
      name: 'InvalidIdPhone',
      deviceId: 'not-valid-hex-id!',
      pairCode: 'DID222',
    });
    const mac = await OpaquePeer.create({ name: 'Mac', pairCode: 'DID222' });
    try {
      await Promise.all([phone.connect(server.wsUrl), mac.connect(server.wsUrl)]);
      const seen = await mac.waitForPeer((p) => p.peerId === phone.peerId);
      expect(seen.device.deviceId).toBeUndefined();
    } finally {
      await phone.disconnect().catch(() => {});
      await mac.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('drops short (< 33 byte) routed binary relay frames without crashing or forwarding', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'Sender', pairCode: 'FRM111' });
    const receiver = await OpaquePeer.create({ name: 'Receiver', pairCode: 'FRM111' });
    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      sender.sendRaw(new Uint8Array(20).fill(0x02));
      sender.sendRaw(new Uint8Array(0));
      // Subsequent valid ping/control still succeeds
      await sender.sendControl(receiver.peerId, {
        kind: 'clipboard-beam',
        beamId: 'after-short-binary',
        contentType: 'text',
        text: 'still-alive',
        timestamp: Date.now(),
      });
      const rx = await receiver.waitForControl(
        (e) => e.payload.kind === 'clipboard-beam' && e.payload.beamId === 'after-short-binary',
      );
      expect(rx.payload.kind).toBe('clipboard-beam');
    } finally {
      await sender.disconnect().catch(() => {});
      await receiver.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('drops binary frames with non-0x02 top-level routing opcode', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'Sender', pairCode: 'OP0099' });
    const receiver = await OpaquePeer.create({ name: 'Receiver', pairCode: 'OP0099' });
    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      const validRelay = wrapRoutedRelayFrame(receiver.peerId, sender.peerId, new Uint8Array([0x01]));
      sender.sendRaw(corruptFrameType(validRelay, 0x7f));
      const health = await fetch(`${server.httpUrl}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      await sender.disconnect().catch(() => {});
      await receiver.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rejects truncated 0x01 chunk frames in decodeEncryptedChunkFrame', () => {
    const valid = encodeEncryptedChunkFrame({
      transferId: randomTransferId(),
      fileIndex: 0,
      chunkIndex: 0,
      iv: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    });
    expect(() => decodeEncryptedChunkFrame(truncateFrame(valid, 36))).toThrow();
    expect(() => decodeEncryptedChunkFrame(truncateFrame(valid, 10))).toThrow();
    expect(() => decodeEncryptedChunkFrame(corruptFrameType(valid, 0x09))).toThrow();
  });

  it('rejects truncated 0x02 relay headers in unwrapRoutedRelayFrame', () => {
    const valid = wrapRoutedRelayFrame('0123456789abcdef', 'fedcba9876543210', new Uint8Array([1, 2]));
    expect(() => unwrapRoutedRelayFrame(truncateFrame(valid, 32))).toThrow();
    expect(() => unwrapRoutedRelayFrame(corruptFrameType(valid, 0x01))).toThrow();
  });

  it('ignores malformed transfer-control messages missing encrypted flag or oversized ciphertext', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const sender = await OpaquePeer.create({ name: 'Sender', pairCode: 'CTL111' });
    const receiver = await OpaquePeer.create({ name: 'Receiver', pairCode: 'CTL111' });
    try {
      await Promise.all([sender.connect(server.wsUrl), receiver.connect(server.wsUrl)]);
      await sender.waitForPeer((p) => p.peerId === receiver.peerId);
      sender.ws!.send(JSON.stringify({ type: 'transfer-control', to: receiver.peerId, envelope: null }));
      sender.ws!.send(
        JSON.stringify({
          type: 'transfer-control',
          to: receiver.peerId,
          envelope: { encrypted: true, ciphertext: 'X'.repeat(10_000_005) },
        }),
      );
      await sender.sendControl(receiver.peerId, { kind: 'ping', ts: 9876 }, true);
      const ping = await receiver.waitForControl(
        (e) => e.payload.kind === 'ping' && e.payload.ts === 9876,
      );
      expect(ping.payload.kind).toBe('ping');
    } finally {
      await sender.disconnect().catch(() => {});
      await receiver.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('ignores malformed rtc-signal frames exceeding 64 KB or missing signal object', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'RTC111' });
    const b = await OpaquePeer.create({ name: 'B', pairCode: 'RTC111' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await a.waitForPeer((p) => p.peerId === b.peerId);
      a.ws!.send(JSON.stringify({ type: 'rtc-signal', to: b.peerId, signal: 'not-an-object' }));
      a.ws!.send(
        JSON.stringify({
          type: 'rtc-signal',
          to: b.peerId,
          signal: { sdp: 'S'.repeat(70_000) },
        }),
      );
      a.ws!.send(JSON.stringify({ type: 'rtc-signal', to: b.peerId, signal: { type: 'offer', sdp: 'ok' } }));
      const validSignal = await b.waitForMessage((m) => m.type === 'rtc-signal');
      expect(validSignal.type).toBe('rtc-signal');
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('ignores non-object or unknown client message types cleanly after registration', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'UNK111' });
    try {
      await a.connect(server.wsUrl);
      a.ws!.send(JSON.stringify({ type: 'totally-unknown-opcode', payload: 123 }));
      const code = await a.rotatePair();
      expect(code).toHaveLength(6);
    } finally {
      await a.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rejects malformed HTTP JSON bodies with HTTP 400 rather than leaking stack traces', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/received-folder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      });
      expect(res.status).toBe(400);
      const txt = await res.text();
      expect(txt).not.toContain('SyntaxError:');
      expect(txt).not.toContain('at ');
    } finally {
      await server.close();
    }
  });

  it('silently drops invalid update-profile messages with blank device names or bad visibility', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'ValidName', pairCode: 'PRF999' });
    const b = await OpaquePeer.create({ name: 'Observer', pairCode: 'PRF999' });
    try {
      await Promise.all([a.connect(server.wsUrl), b.connect(server.wsUrl)]);
      await b.waitForPeer((p) => p.peerId === a.peerId);
      a.ws!.send(JSON.stringify({ type: 'update-profile', device: { name: 'Bad' }, visibility: 'nearby' }));
      const nextCode = await a.rotatePair();
      expect(nextCode).toHaveLength(6);
      const stillValid = b.discoveredPeers.find((p) => p.peerId === a.peerId);
      expect(stillValid?.device.name).toBe('ValidName');
    } finally {
      await a.disconnect().catch(() => {});
      await b.disconnect().catch(() => {});
      await server.close();
    }
  });
});
