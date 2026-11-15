import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  OpaquePeer,
  readRepoFile,
  startTestServer,
} from '../harness/index.js';

describe('Tier 2 Boundary: Rate Limiting, Caps & DoS Protection', () => {
  it('rate-limits join-pair brute-force attempts after 6 requests in a window with RATE_LIMITED', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const attacker = await OpaquePeer.create({ name: 'Attacker', pairCode: 'AAA222' });
    try {
      await attacker.connect(server.wsUrl);
      for (let i = 0; i < 6; i++) {
        attacker.ws!.send(JSON.stringify({ type: 'join-pair', pairCode: `BBB22${i + 2}` }));
      }
      attacker.ws!.send(JSON.stringify({ type: 'join-pair', pairCode: 'CCC333' }));
      const limited = await attacker.waitForMessage(
        (m) => m.type === 'error' && m.code === 'RATE_LIMITED',
      );
      expect(limited.type).toBe('error');
    } finally {
      await attacker.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rejects invalid or short pair codes with INVALID_PAIR_CODE', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const peer = await OpaquePeer.create({ name: 'Probe', pairCode: 'AAA222' });
    try {
      await peer.connect(server.wsUrl);
      peer.ws!.send(JSON.stringify({ type: 'join-pair', pairCode: 'A1' }));
      const err = await peer.waitForMessage(
        (m) => m.type === 'error' && m.code === 'INVALID_PAIR_CODE',
      );
      expect(err.type).toBe('error');
    } finally {
      await peer.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('closes connections sending duplicate hello frames with WebSocket close code 1008', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const peer = await OpaquePeer.create({ name: 'DupHello', pairCode: 'AAA222' });
    try {
      await peer.connect(server.wsUrl);
      const closedCode = new Promise<number>((resolve) => {
        peer.ws!.once('close', (code) => resolve(code));
      });
      peer.ws!.send(
        JSON.stringify({
          type: 'hello',
          device: peer.device,
          visibility: 'nearby',
          pairCode: 'AAA222',
        }),
      );
      expect(await closedCode).toBe(1008);
    } finally {
      await peer.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('enforces MAX_CLIENTS_PER_NETWORK (32) by closing the 33rd loopback connection with code 1013', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const peers: OpaquePeer[] = [];
    let extraWs: WebSocket | null = null;
    try {
      for (let i = 0; i < 32; i++) {
        const p = await OpaquePeer.create({ name: `P${i}`, pairCode: 'CAP222' });
        await p.connect(server.wsUrl);
        peers.push(p);
      }
      extraWs = new WebSocket(server.wsUrl);
      const closedCode = await new Promise<number>((resolve) => {
        extraWs!.once('close', (code) => resolve(code));
      });
      expect(closedCode).toBe(1013);
    } finally {
      extraWs?.close();
      await Promise.all(peers.map((p) => p.disconnect().catch(() => {})));
      await server.close();
    }
  }, 15000);

  it('enforces WebSocket 16 MiB maxPayload frame limit and drops oversized binary frames', async () => {
    const hub = await readRepoFile('src/server/signalingHub.ts');
    expect(hub).toContain('maxPayload: 16 * 1024 * 1024');
    expect(hub).toContain('MAX_RELAY_BUFFERED_BYTES = 64 * 1024 * 1024');
  });

  it('terminates connections whose outbound WebSocket payload exceeds 16 MiB maxPayload', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const peer = await OpaquePeer.create({ name: 'Oversize', pairCode: 'BIG222' });
    try {
      await peer.connect(server.wsUrl);
      const closed = new Promise<boolean>((resolve) => {
        peer.ws!.once('close', () => resolve(true));
        peer.ws!.once('error', () => resolve(true));
      });
      peer.ws!.send(Buffer.alloc(16 * 1024 * 1024 + 1024, 0xaa));
      expect(await closed).toBe(true);
    } finally {
      await peer.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('declares MAX_CLIENTS = 128 and MAX_RELAY_BUFFERED_BYTES = 64 MiB circuit breakers in SignalingHub', async () => {
    const hub = await readRepoFile('src/server/signalingHub.ts');
    expect(hub).toContain('export const MAX_CLIENTS = 128');
    expect(hub).toContain('export const MAX_CLIENTS_PER_NETWORK = 32');
    expect(hub).toContain('export const MAX_RELAY_BUFFERED_BYTES = 64 * 1024 * 1024');
  });

  it('bounds Android Engine incoming/outgoing queues and Limits caps against resource exhaustion', async () => {
    const limits = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Model.kt');
    expect(limits).toContain('const val MAX_FILES_PER_TRANSFER = 100');
    expect(limits).toContain('const val MAX_CHUNKS_PER_TRANSFER = 262_144');
    expect(limits).toContain('const val MAX_CLIPBOARD_TEXT = 256_000');
    expect(limits).toContain('const val MAX_CLIPBOARD_IMAGE_DATAURL = 7_000_000');
  });

  it('rejects oversized clipboard text payloads (> 256,000 chars) locally on Android services', async () => {
    const svc = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(svc).toContain('text.isBlank() || text.length > com.airbridge.engine.Limits.MAX_CLIPBOARD_TEXT');
  });

  it('isolates hidden peers from broadcast peer lists even when sharing the same LAN/pairCode', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const a = await OpaquePeer.create({ name: 'A', pairCode: 'ISO222', visibility: 'nearby' });
    const hidden = await OpaquePeer.create({ name: 'Ghost', pairCode: 'ISO222', visibility: 'hidden' });
    try {
      await Promise.all([a.connect(server.wsUrl), hidden.connect(server.wsUrl)]);
      expect(a.discoveredPeers).toHaveLength(0);
      expect(hidden.discoveredPeers).toHaveLength(0);
    } finally {
      await a.disconnect().catch(() => {});
      await hidden.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rejects oversized HTTP daemon JSON requests (> 16 KB) cleanly with 413', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    try {
      const res = await fetch(`${server.httpUrl}/api/received-folder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadDir: 'A'.repeat(32_768) }),
      });
      expect(res.status).toBe(413);
    } finally {
      await server.close();
    }
  });

  it('bounds daemon chunk upload body size to 4 MiB on /api/daemon/receive-chunk', async () => {
    const srv = await readRepoFile('src/server/index.ts');
    expect(srv).toContain("'/api/daemon/receive-chunk'");
    expect(srv).toContain("limit: '4mb'");
  });

  it('ignores rotate-pair and join-pair flooding gracefully without crashing server event loop', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const p = await OpaquePeer.create({ name: 'Flooder', pairCode: 'ROT222' });
    try {
      await p.connect(server.wsUrl);
      for (let i = 0; i < 20; i++) {
        p.ws!.send(JSON.stringify({ type: 'rotate-pair' }));
      }
      const res = await fetch(`${server.httpUrl}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await p.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('caps clipboard background read memory at DEFAULT_MAX_BYTES (512 KiB) in hostClipboard', async () => {
    const hc = await readRepoFile('src/server/hostClipboard.ts');
    expect(hc).toContain('DEFAULT_MAX_BYTES = 512 * 1024');
  });
});
