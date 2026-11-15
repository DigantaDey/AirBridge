import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  corruptAuthTag,
  corruptIv,
  createSyntheticBuffer,
  decryptBinaryChunk,
  decryptControlPayload,
  derivePeerSession,
  encodeEncryptedChunkFrame,
  encryptBinaryChunk,
  encryptControlPayload,
  generateIdentityKeyPair,
  OpaquePeer,
  randomTransferId,
  startTestServer,
  tamperRoutingSource,
  tamperRoutingTarget,
  withPairedEnv,
  wrapRoutedRelayFrame,
} from '../harness/index.js';

describe('Tier 2 Boundary: Cryptographic Integrity & Auth Tampering', () => {
  it('fails AES-256-GCM decryption when any bit of the auth tag is flipped', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const aliceSess = await derivePeerSession(alice.privateKey, alice.publicKeyB64, bob.publicKeyB64);
    const bobSess = await derivePeerSession(bob.privateKey, bob.publicKeyB64, alice.publicKeyB64);

    const { iv, ciphertext } = await encryptBinaryChunk(
      aliceSess.aesKey,
      createSyntheticBuffer(1024, 1),
    );
    const wire = corruptAuthTag(
      encodeEncryptedChunkFrame({ transferId: randomTransferId(), fileIndex: 0, chunkIndex: 0, iv, ciphertext }),
    );
    await expect(
      decryptBinaryChunk(bobSess.aesKey, wire.subarray(25, 37), wire.subarray(37)),
    ).rejects.toThrow();
  });

  it('fails AES-256-GCM decryption when the 12-byte IV is altered in flight', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const aliceSess = await derivePeerSession(alice.privateKey, alice.publicKeyB64, bob.publicKeyB64);
    const bobSess = await derivePeerSession(bob.privateKey, bob.publicKeyB64, alice.publicKeyB64);

    const { iv, ciphertext } = await encryptBinaryChunk(
      aliceSess.aesKey,
      createSyntheticBuffer(1024, 2),
    );
    const wire = corruptIv(
      encodeEncryptedChunkFrame({ transferId: randomTransferId(), fileIndex: 0, chunkIndex: 0, iv, ciphertext }),
    );
    await expect(
      decryptBinaryChunk(bobSess.aesKey, wire.subarray(25, 37), wire.subarray(37)),
    ).rejects.toThrow();
  });

  it('rejects control envelope decryption using an unrelated third-party session key', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const eve = await generateIdentityKeyPair();
    const ab = await derivePeerSession(alice.privateKey, alice.publicKeyB64, bob.publicKeyB64);
    const eb = await derivePeerSession(eve.privateKey, eve.publicKeyB64, bob.publicKeyB64);

    const env = await encryptControlPayload(ab.aesKey, {
      kind: 'clipboard-beam',
      beamId: 'secret-01',
      contentType: 'text',
      text: 'classified secret',
      timestamp: Date.now(),
    });
    await expect(decryptControlPayload(eb.aesKey, env)).rejects.toThrow();
  });

  it('produces identical SAS codes for matching peers and distinct SAS codes on MITM key substitution', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const mallory = await generateIdentityKeyPair();

    const ab = await derivePeerSession(alice.privateKey, alice.publicKeyB64, bob.publicKeyB64);
    const ba = await derivePeerSession(bob.privateKey, bob.publicKeyB64, alice.publicKeyB64);
    const am = await derivePeerSession(alice.privateKey, alice.publicKeyB64, mallory.publicKeyB64);

    expect(ab.sasCode).toBe(ba.sasCode);
    expect(ab.sasCode).not.toBe(am.sasCode);
  });

  it('rejects unencrypted transfer-control payloads other than ping/pong with ENCRYPTION_REQUIRED', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      await androidPeer.sendControl(
        desktopPeer.peerId,
        {
          kind: 'clipboard-beam',
          beamId: 'forged-plain',
          contentType: 'text',
          text: 'forged plaintext beam',
          timestamp: Date.now(),
        },
        true,
      );
      const err = await androidPeer.waitForMessage(
        (m) => m.type === 'error' && m.code === 'ENCRYPTION_REQUIRED',
      );
      expect(err.type).toBe('error');
    });
  });

  it('still permits unencrypted ping and pong control heartbeats per protocol', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      await androidPeer.sendControl(desktopPeer.peerId, { kind: 'ping', ts: 4242 }, true);
      const rx = await desktopPeer.waitForControl(
        (e) => e.payload.kind === 'ping' && e.payload.ts === 4242,
      );
      expect(rx.payload.kind).toBe('ping');
    });
  });

  it('overwrites forged sourcePeerId headers on binary relay frames with the authenticated sender peerId', async () => {
    await withPairedEnv(async ({ androidPeer, desktopPeer }) => {
      const transferId = randomTransferId();
      const data = createSyntheticBuffer(4096, 8);
      const session = await androidPeer.getSession(desktopPeer.peerId);
      const { iv, ciphertext } = await encryptBinaryChunk(session.aesKey, data);
      const inner = encodeEncryptedChunkFrame({ transferId, fileIndex: 0, chunkIndex: 0, iv, ciphertext });
      const spoofed = tamperRoutingSource(
        wrapRoutedRelayFrame(desktopPeer.peerId, androidPeer.peerId, inner),
        'ffffffffffffffff',
      );
      androidPeer.sendRaw(spoofed);

      const rx = await desktopPeer.waitForChunk((c) => c.frame.transferId === transferId);
      expect(rx.sourcePeerId).toBe(androidPeer.peerId);
    });
  });

  it('isolates binary and control traffic between separate paired rooms (cross-room target spoofing blocked)', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const roomA = await OpaquePeer.create({ name: 'A1', pairCode: 'AAA222', visibility: 'paired-only' });
    const roomB = await OpaquePeer.create({ name: 'B1', pairCode: 'BBB333', visibility: 'paired-only' });
    try {
      await Promise.all([roomA.connect(server.wsUrl), roomB.connect(server.wsUrl)]);
      const tid = randomTransferId();
      const spoofedRelay = tamperRoutingTarget(
        wrapRoutedRelayFrame(roomB.peerId, roomA.peerId, new Uint8Array(40)),
        roomB.peerId,
      );
      roomA.sendRaw(spoofedRelay);
      await roomA.sendControl(roomB.peerId, { kind: 'ping', ts: 777 }, true);
      await expect(
        roomB.waitForControl((e) => e.payload.kind === 'ping' && e.payload.ts === 777, 150),
      ).rejects.toThrow(/Timed out/);
      void tid;
    } finally {
      await roomA.disconnect().catch(() => {});
      await roomB.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('rejects hello with invalid/short P-256 SPKI publicKey and closes with WebSocket code 1008', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const ws = new WebSocket(server.wsUrl);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      const closeCode = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
      });
      const errMsg = new Promise<{ code: string }>((resolve) => {
        ws.once('message', (d) => resolve(JSON.parse(d.toString())));
      });
      ws.send(
        JSON.stringify({
          type: 'hello',
          visibility: 'nearby',
          device: {
            name: 'BadKey',
            platform: 'android',
            model: 'Pixel',
            formFactor: 'phone',
            publicKey: 'not-valid-base64-key',
          },
        }),
      );
      expect((await errMsg).code).toBe('INVALID_DEVICE');
      expect(await closeCode).toBe(1008);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('rejects tampered encrypted envelope with altered base64 ciphertext on receiver decrypt', async () => {
    const alice = await generateIdentityKeyPair();
    const bob = await generateIdentityKeyPair();
    const ab = await derivePeerSession(alice.privateKey, alice.publicKeyB64, bob.publicKeyB64);
    const ba = await derivePeerSession(bob.privateKey, bob.publicKeyB64, alice.publicKeyB64);
    const env = await encryptControlPayload(ab.aesKey, { kind: 'ping', ts: 1 });
    const chars = env.ciphertext.split('');
    chars[chars.length - 2] = chars[chars.length - 2] === 'A' ? 'B' : 'A';
    await expect(
      decryptControlPayload(ba.aesKey, { ...env, ciphertext: chars.join('') }),
    ).rejects.toThrow();
  });

  it('rejects invalid base64 public keys in derivePeerSession', async () => {
    const alice = await generateIdentityKeyPair();
    await expect(
      derivePeerSession(alice.privateKey, alice.publicKeyB64, 'invalid!!!key'),
    ).rejects.toThrow();
  });

  it('prevents peers in hidden visibility mode from receiving relayed controls from discoverers', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const visible = await OpaquePeer.create({ name: 'Visible', pairCode: 'HID111', visibility: 'nearby' });
    const stealth = await OpaquePeer.create({ name: 'Stealth', pairCode: 'HID111', visibility: 'hidden' });
    try {
      await Promise.all([visible.connect(server.wsUrl), stealth.connect(server.wsUrl)]);
      expect(visible.discoveredPeers).toHaveLength(0);
      await visible.sendControl(stealth.peerId, { kind: 'ping', ts: 999 }, true);
      await expect(
        stealth.waitForControl((e) => e.payload.kind === 'ping' && e.payload.ts === 999, 150),
      ).rejects.toThrow(/Timed out/);
    } finally {
      await visible.disconnect().catch(() => {});
      await stealth.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('reassigns colliding hello peerIds cleanly so a newcomer cannot hijack an active peerId', async () => {
    const server = await startTestServer({ enableMdns: false, hostClipboard: false });
    const leg = await OpaquePeer.create({ name: 'Legit', pairCode: 'HIJ222' });
    const hijack = await OpaquePeer.create({ name: 'Hijacker', pairCode: 'HIJ222' });
    try {
      await leg.connect(server.wsUrl);
      await hijack.connect(server.wsUrl, leg.peerId);
      expect(hijack.peerId).not.toBe(leg.peerId);
    } finally {
      await leg.disconnect().catch(() => {});
      await hijack.disconnect().catch(() => {});
      await server.close();
    }
  });

  it('blocks remote non-self set-host-clipboard attempts from non-desktop or wrong clients', async () => {
    let written: string | null = null;
    const server = await startTestServer({
      enableMdns: false,
      backgroundClipboard: false,
      hostClipboard: {
        isSupported: () => true,
        readText: async () => null,
        writeText: async (text: string) => {
          written = text;
          return true;
        },
      },
    });
    const android = await OpaquePeer.create({ name: 'Phone', platform: 'android', pairCode: 'CLP111' });
    try {
      await android.connect(server.wsUrl);
      android.ws!.send(JSON.stringify({ type: 'set-host-clipboard', text: 'malicious-overwrite' }));
      await android.rotatePair();
      expect(written).toBeNull();
    } finally {
      await android.disconnect().catch(() => {});
      await server.close();
    }
  });
});
