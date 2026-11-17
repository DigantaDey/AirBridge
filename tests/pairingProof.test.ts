/**
 * Join-protocol building blocks: nameplates, vouches, the hub's proof and
 * long-term identity bindings. Cross-language agreement is covered by the
 * shared vectors (android/engine/src/test/resources/vectors.json).
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  hubProof,
  joinerSpake2Identity,
  nameplateFor,
  passwordScalar,
  peerVouch,
  verifyHubProof,
  verifyPeerVouch,
  vouchKeyFrom,
  type VouchSubject,
} from '../src/shared/pairingProof.js';
import { loadOrCreateDeviceIdentity, jwkIdentityStore, verifyIdentityBinding } from '../src/client/engine/identity.js';

const vk = vouchKeyFrom(new Uint8Array(32).fill(7));

describe('nameplates and passwords', () => {
  it('nameplates are one byte (256 buckets): they route, never identify, the code', () => {
    const plates = new Set<string>();
    for (let i = 0; i < 2000; i++) plates.add(nameplateFor(`${100000 + i}`));
    expect([...plates].every((p) => /^[0-9a-f]{2}$/.test(p))).toBe(true);
    expect(plates.size).toBeGreaterThan(200);
    expect(plates.size).toBeLessThanOrEqual(256);
  });

  it('the password scalar ignores formatting and is never zero', () => {
    expect(passwordScalar('abc-234')).toBe(passwordScalar('ABC234'));
    expect(passwordScalar('ABC234')).not.toBe(passwordScalar('ABC235'));
    expect(passwordScalar('ABC234') > 0n).toBe(true);
  });

  it('the joiner identity binds both keys into the exchange', () => {
    const a = new TextDecoder().decode(joinerSpake2Identity('pk', 'idk'));
    expect(a).toBe('airbridge-joiner-v1\npk\nidk');
    expect(new TextDecoder().decode(joinerSpake2Identity('pk'))).toBe('airbridge-joiner-v1\npk\n');
  });
});

describe('peer vouches', () => {
  const subject: VouchSubject = { peerId: 'p1', publicKey: 'session-key', identityKey: 'id-key', attestation: 'pake' };

  it('verify for exactly the vouched fields', () => {
    const v = peerVouch(vk, subject);
    expect(v).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyPeerVouch(vk, subject, v)).toBe(true);
    for (const tampered of [
      { ...subject, peerId: 'p2' },
      { ...subject, publicKey: 'evil' },
      { ...subject, identityKey: 'evil' },
      { ...subject, identityKey: undefined },
      { ...subject, attestation: 'legacy' as const },
    ]) {
      expect(verifyPeerVouch(vk, tampered, v)).toBe(false);
    }
    expect(verifyPeerVouch(vouchKeyFrom(new Uint8Array(32)), subject, v)).toBe(false);
    expect(verifyPeerVouch(vk, subject, undefined)).toBe(false);
    expect(verifyPeerVouch(vk, subject, '')).toBe(false);
  });
});

describe("the hub's proof", () => {
  it('binds peer id, room and TLS anchor', () => {
    const s = { peerId: 'p1', pairCode: 'ABC234', tlsPin: 'pin' };
    const proof = hubProof(vk, s);
    expect(verifyHubProof(vk, s, proof)).toBe(true);
    expect(verifyHubProof(vk, { ...s, pairCode: 'abc-234' }, proof)).toBe(true); // normalized
    expect(verifyHubProof(vk, { ...s, tlsPin: 'other' }, proof)).toBe(false);
    expect(verifyHubProof(vk, { ...s, tlsPin: null }, proof)).toBe(false);
    expect(verifyHubProof(vk, { ...s, peerId: 'p2' }, proof)).toBe(false);
    expect(verifyHubProof(vk, { ...s, pairCode: 'ABC235' }, proof)).toBe(false);
    expect(verifyHubProof(vk, s, undefined)).toBe(false);
  });
});

describe('long-term device identity', () => {
  it('signs session keys; signatures verify only for that key and identity', async () => {
    const id = await loadOrCreateDeviceIdentity(null);
    expect(id.persistent).toBe(false);
    const session = Buffer.from(randomBytes(65)).toString('base64url');
    const sig = await id.signBinding(session);
    expect(await verifyIdentityBinding(id.publicKeyB64, sig, session)).toBe(true);
    expect(await verifyIdentityBinding(id.publicKeyB64, sig, Buffer.from(randomBytes(65)).toString('base64url'))).toBe(false);
    const other = await loadOrCreateDeviceIdentity(null);
    expect(await verifyIdentityBinding(other.publicKeyB64, sig, session)).toBe(false);
    expect(await verifyIdentityBinding('garbage', sig, session)).toBe(false);
  });

  it('a file-backed store keeps the same identity across restarts', async () => {
    let saved: string | null = null;
    const store = jwkIdentityStore(() => saved, (v) => { saved = v; });
    const first = await loadOrCreateDeviceIdentity(store);
    expect(first.persistent).toBe(true);
    expect(saved).toBeTruthy();
    const second = await loadOrCreateDeviceIdentity(store);
    expect(second.publicKeyB64).toBe(first.publicKeyB64);
    const session = Buffer.from(randomBytes(65)).toString('base64url');
    expect(await verifyIdentityBinding(first.publicKeyB64, await second.signBinding(session), session)).toBe(true);
  });
});
