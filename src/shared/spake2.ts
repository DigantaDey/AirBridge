/**
 * SPAKE2 (RFC 9382) over P-256 with SHA-256, HKDF-SHA256 and HMAC-SHA256.
 *
 * A balanced password-authenticated key exchange: both sides know a short
 * secret (the AirBridge pairing code) and end up with a strong shared key
 * only if their secrets match. An eavesdropper learns nothing, and an active
 * attacker gets exactly one guess per protocol run, so a 6-character code is
 * safe against offline brute force even though it is short.
 *
 * Interop contract (mirrored by android/engine/.../Spake2.kt):
 *  - M, N: the RFC 9382 P-256 constants (seeded hash-to-curve, compressed below).
 *  - Shares are uncompressed SEC1 points (65 bytes).
 *  - TT = len(A)‖A‖len(B)‖B‖len(pA)‖pA‖len(pB)‖pB‖len(K)‖K‖len(w)‖w with
 *    8-byte little-endian lengths; w is the 32-byte big-endian scalar.
 *  - Ke‖Ka = SHA-256(TT) (16 + 16 bytes); KcA‖KcB = HKDF(salt = ∅, Ka,
 *    "ConfirmationKeys" ‖ AAD, 32); confirmations are HMAC-SHA256(Kc, TT).
 * The RFC's own test vectors are checked in tests/spake2.test.ts and in the
 * Kotlin vector test.
 */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';

type P256Point = InstanceType<typeof p256.Point>;
const Point = p256.Point;
export const P256_ORDER: bigint = Point.Fn.ORDER;

export const SPAKE2_M = Point.fromHex('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f');
export const SPAKE2_N = Point.fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49');

export type Spake2Role = 'A' | 'B';

export interface Spake2Result {
  /** 16-byte shared secret for the application (RFC "Ke"). */
  ke: Uint8Array;
  /** Confirmation MAC this side sends. */
  confirm: Uint8Array;
  /** Confirmation MAC the other side must send. Compare with [constantTimeEqual]. */
  expectedPeerConfirm: Uint8Array;
  /** Full transcript (for tests and diagnostics). */
  transcript: Uint8Array;
}

export class Spake2Error extends Error {}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function bigIntTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Spake2Error('scalar does not fit in 32 bytes');
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function lenLe8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

function withLen(part: Uint8Array): Uint8Array {
  return concat(lenLe8(part.length), part);
}

/** Uniform random scalar in [1, n-1]. */
export function randomScalar(): bigint {
  for (;;) {
    const bytes = new Uint8Array(48);
    globalThis.crypto.getRandomValues(bytes);
    const v = bytesToBigInt(bytes) % P256_ORDER;
    if (v !== 0n) return v;
  }
}

/** Decode and validate a peer share: on the curve, not the identity. */
function decodeShare(share: Uint8Array): P256Point {
  if (share.length !== 65 || share[0] !== 0x04) throw new Spake2Error('share must be an uncompressed P-256 point');
  let p: P256Point;
  try {
    p = Point.fromBytes(share);
    p.assertValidity();
  } catch {
    throw new Spake2Error('share is not a valid P-256 point');
  }
  if (p.is0()) throw new Spake2Error('share is the identity point');
  return p;
}

/**
 * One SPAKE2 party. `scalar` is only for deterministic test vectors; real
 * runs draw it from the platform CSPRNG.
 */
export class Spake2 {
  private readonly own: Uint8Array;
  private finished = false;

  constructor(
    private readonly role: Spake2Role,
    private readonly w: bigint,
    private readonly idA: Uint8Array,
    private readonly idB: Uint8Array,
    private readonly aad: Uint8Array = new Uint8Array(0),
    private readonly scalar: bigint = randomScalar(),
  ) {
    if (w <= 0n || w >= P256_ORDER) throw new Spake2Error('password scalar out of range');
    if (scalar <= 0n || scalar >= P256_ORDER) throw new Spake2Error('ephemeral scalar out of range');
    const blind = role === 'A' ? SPAKE2_M : SPAKE2_N;
    this.own = Point.BASE.multiply(scalar).add(blind.multiply(w)).toBytes(false);
  }

  /** This side's public share (pA for role A, pB for role B). */
  share(): Uint8Array {
    return this.own.slice();
  }

  /** Combine with the peer's share. Single use: a party never finishes twice. */
  finish(peerShare: Uint8Array): Spake2Result {
    if (this.finished) throw new Spake2Error('SPAKE2 party already finished');
    this.finished = true;
    const peer = decodeShare(peerShare);
    const peerBlind = this.role === 'A' ? SPAKE2_N : SPAKE2_M;
    // P-256 has cofactor 1, so K = x * (peer - w * blind).
    const unblinded = peer.subtract(peerBlind.multiply(this.w));
    if (unblinded.is0()) throw new Spake2Error('degenerate share');
    const k = unblinded.multiply(this.scalar);
    if (k.is0()) throw new Spake2Error('degenerate shared point');
    const pA = this.role === 'A' ? this.own : peerShare;
    const pB = this.role === 'A' ? peerShare : this.own;
    const transcript = concat(
      withLen(this.idA),
      withLen(this.idB),
      withLen(pA),
      withLen(pB),
      withLen(k.toBytes(false)),
      withLen(bigIntTo32(this.w)),
    );
    const hashTT = sha256(transcript);
    const ke = hashTT.slice(0, 16);
    const ka = hashTT.slice(16, 32);
    const info = concat(new TextEncoder().encode('ConfirmationKeys'), this.aad);
    const kc = hkdf(sha256, ka, undefined, info, 32);
    const confirmA = hmac(sha256, kc.slice(0, 16), transcript);
    const confirmB = hmac(sha256, kc.slice(16, 32), transcript);
    return {
      ke,
      confirm: this.role === 'A' ? confirmA : confirmB,
      expectedPeerConfirm: this.role === 'A' ? confirmB : confirmA,
      transcript,
    };
  }
}
