/**
 * Code-authenticated joining ("secure code exchange").
 *
 * The pairing code shown on the computer is a room secret. Older clients sent
 * it to the hub in the clear inside `hello`, so whoever answered the socket
 * (an impostor on the LAN, a wrong address, a relay) learned it and could sit
 * in the middle of the end-to-end key exchange.
 *
 * Version 1 of the join protocol never sends the code. The joining device
 * (role A) and the hub (role B) run SPAKE2 keyed by the code:
 *
 *   joiner → hub   hello { device, pake: { v: 1, nameplate, share: pA } }
 *   hub → joiner   pake-challenge { share: pB, confirm: cB }
 *   joiner → hub   pake-confirm { confirm: cA }           (only if cB verified)
 *   hub → joiner   welcome { …, admission: 'pake', hubProof, peers[i].vouch }
 *
 *  - Wrong code: both confirmations fail, nobody learns the code, and an
 *    impostor hub has had one online guess (≈ 1 in 4 million).
 *  - The joiner's device keys are part of the SPAKE2 identity, so a relay or
 *    proxy cannot swap them while forwarding the exchange.
 *  - From Ke both sides derive a vouch key. The hub MACs every peer it lists
 *    (peer id, session key, identity key, how that peer was admitted) and the
 *    TLS anchor it serves. The joiner therefore knows that every key it uses
 *    for end-to-end encryption was admitted by the computer that knows the
 *    code — not substituted by whoever carried the traffic.
 *
 * The nameplate (8 bits of a hash of the code) only selects among the hub's
 * active rooms; the remaining ~22 bits stay protected by SPAKE2.
 *
 * Interop contract (byte-for-byte mirrored in PairingProof.kt; vectors in
 * scripts/gen-test-vectors.ts).
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { type Admission, bytesToBase64Url, normalizePairCode } from './protocol.js';
import { P256_ORDER, bytesToBigInt, constantTimeEqual } from './spake2.js';

export const JOIN_PROTOCOL_VERSION = 1;

const enc = new TextEncoder();
export const HUB_SPAKE2_IDENTITY = enc.encode('airbridge-hub-v1');
export const JOIN_SPAKE2_AAD = enc.encode('airbridge-join-v1');

export type { Admission } from './protocol.js';

export function nameplateFor(code: string): string {
  const digest = sha256(enc.encode(`airbridge-nameplate-v1:${normalizePairCode(code)}`));
  return digest[0].toString(16).padStart(2, '0');
}

/** SPAKE2 password scalar w for a pairing code, uniform in [1, n-1]. */
export function passwordScalar(code: string): bigint {
  const okm = hkdf(sha256, enc.encode(normalizePairCode(code)), enc.encode('airbridge-spake2-password-v1'), enc.encode('w'), 48);
  const w = bytesToBigInt(okm) % P256_ORDER;
  return w === 0n ? 1n : w;
}

/** SPAKE2 identity of the joining device: binds its session and identity keys. */
export function joinerSpake2Identity(publicKey: string, identityKey?: string): Uint8Array {
  return enc.encode(`airbridge-joiner-v1\n${publicKey}\n${identityKey ?? ''}`);
}

export function vouchKeyFrom(ke: Uint8Array): Uint8Array {
  return hkdf(sha256, ke, undefined, enc.encode('airbridge-vouch-v1'), 32);
}

export interface VouchSubject {
  peerId: string;
  publicKey: string;
  identityKey?: string;
  attestation: Admission;
}

/** 128-bit MAC the hub attaches to each peer it lists for a PAKE-admitted viewer. */
export function peerVouch(vouchKey: Uint8Array, s: VouchSubject): string {
  const msg = ['peer', s.peerId, s.publicKey, s.identityKey ?? '', s.attestation].join('\n');
  return bytesToBase64Url(hmac(sha256, vouchKey, enc.encode(msg)).slice(0, 16));
}

export function verifyPeerVouch(vouchKey: Uint8Array, s: VouchSubject, vouch: string | undefined): boolean {
  if (!vouch) return false;
  return constantTimeEqual(enc.encode(peerVouch(vouchKey, s)), enc.encode(vouch));
}

export interface HubProofSubject {
  peerId: string;
  pairCode: string;
  tlsPin: string | null | undefined;
}

/** Authenticates the welcome: admission, assigned peer id, room and the TLS anchor. */
export function hubProof(vouchKey: Uint8Array, s: HubProofSubject): string {
  const msg = ['hub', s.peerId, normalizePairCode(s.pairCode), s.tlsPin ?? ''].join('\n');
  return bytesToBase64Url(hmac(sha256, vouchKey, enc.encode(msg)));
}

export function verifyHubProof(vouchKey: Uint8Array, s: HubProofSubject, proof: string | undefined): boolean {
  if (!proof) return false;
  return constantTimeEqual(enc.encode(hubProof(vouchKey, s)), enc.encode(proof));
}

/**
 * What a device's long-term identity key signs: its per-session ECDH key.
 * Session keys stay ephemeral (forward secrecy); the identity key gives the
 * device a stable, pinnable name across restarts.
 */
export function identityBindingMessage(publicKey: string): Uint8Array {
  return enc.encode(`airbridge-device-binding-v1\n${publicKey}`);
}

/**
 * Binds the computer's handoff key and Bluetooth tag secret to a
 * code-authenticated session (see HandoffInfo in protocol.ts).
 */
export function handoffProof(vouchKey: Uint8Array, input: { peerId: string; key: string; beacon: string }): string {
  return bytesToBase64Url(hmac(sha256, vouchKey, enc.encode(`handoff\n${input.peerId}\n${input.key}\n${input.beacon}`)));
}

export function verifyHandoffProof(vouchKey: Uint8Array, input: { peerId: string; key: string; beacon: string }, proof: string | undefined | null): boolean {
  if (!proof) return false;
  return constantTimeEqual(enc.encode(handoffProof(vouchKey, input)), enc.encode(proof));
}
