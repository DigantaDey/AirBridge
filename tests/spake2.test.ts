import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Spake2, Spake2Error, SPAKE2_M, SPAKE2_N, constantTimeEqual } from '../src/shared/spake2';

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

// RFC 9382 Appendix B, SPAKE2-P256-SHA256-HKDF-HMAC (A = "server", B = "client").
const RFC = {
  w: '2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f',
  x: '43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729',
  pA: '04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c',
  y: 'dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be',
  pB: '0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7',
  hashTT: '0e0672dc86f8e45565d338b0540abe6915bdf72e2b35b5c9e5663168e960a91b',
  confirmA: '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0',
  confirmB: 'd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b',
};

describe('SPAKE2 (RFC 9382, P-256)', () => {
  it('uses the RFC M and N constants (seeded hash-to-curve outputs)', () => {
    expect(SPAKE2_M.toHex(true)).toBe('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f');
    expect(SPAKE2_N.toHex(true)).toBe('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49');
  });

  it('reproduces the RFC 9382 test vector bit for bit', () => {
    const w = BigInt('0x' + RFC.w);
    const a = new Spake2('A', w, utf8('server'), utf8('client'), new Uint8Array(0), BigInt('0x' + RFC.x));
    const b = new Spake2('B', w, utf8('server'), utf8('client'), new Uint8Array(0), BigInt('0x' + RFC.y));
    expect(toHex(a.share())).toBe(RFC.pA);
    expect(toHex(b.share())).toBe(RFC.pB);
    const ra = a.finish(b.share());
    const rb = b.finish(a.share());
    expect(toHex(sha256(ra.transcript))).toBe(RFC.hashTT);
    expect(toHex(ra.ke)).toBe(RFC.hashTT.slice(0, 32));
    expect(toHex(ra.confirm)).toBe(RFC.confirmA);
    expect(toHex(rb.confirm)).toBe(RFC.confirmB);
    expect(constantTimeEqual(ra.expectedPeerConfirm, rb.confirm)).toBe(true);
    expect(constantTimeEqual(rb.expectedPeerConfirm, ra.confirm)).toBe(true);
  });

  it('agrees on a key only when the passwords match', () => {
    const idA = utf8('phone');
    const idB = utf8('hub');
    const aad = utf8('test');
    const a = new Spake2('A', 12345n, idA, idB, aad);
    const b = new Spake2('B', 12345n, idA, idB, aad);
    const ra = a.finish(b.share());
    const rb = b.finish(a.share());
    expect(toHex(ra.ke)).toBe(toHex(rb.ke));

    const c = new Spake2('A', 12345n, idA, idB, aad);
    const wrong = new Spake2('B', 12346n, idA, idB, aad);
    const rc = c.finish(wrong.share());
    const rw = wrong.finish(c.share());
    expect(constantTimeEqual(rc.expectedPeerConfirm, rw.confirm)).toBe(false);
    expect(toHex(rc.ke)).not.toBe(toHex(rw.ke));
  });

  it('binds identities and AAD into the confirmation', () => {
    const a = new Spake2('A', 7n, utf8('phone'), utf8('hub'), utf8('x'));
    const b = new Spake2('B', 7n, utf8('phone-evil'), utf8('hub'), utf8('x'));
    expect(constantTimeEqual(a.finish(b.share()).expectedPeerConfirm, b.finish(a.share()).confirm)).toBe(false);
    const c = new Spake2('A', 7n, utf8('phone'), utf8('hub'), utf8('x'));
    const d = new Spake2('B', 7n, utf8('phone'), utf8('hub'), utf8('y'));
    expect(constantTimeEqual(c.finish(d.share()).expectedPeerConfirm, d.finish(c.share()).confirm)).toBe(false);
  });

  it('rejects invalid, identity and off-curve shares and single-use violations', () => {
    const mk = () => new Spake2('A', 9n, utf8('a'), utf8('b'));
    expect(() => mk().finish(new Uint8Array(65))).toThrow(Spake2Error);
    const offCurve = hex(RFC.pB);
    offCurve[64] ^= 1;
    expect(() => mk().finish(offCurve)).toThrow(Spake2Error);
    expect(() => mk().finish(SPAKE2_N.toBytes(true))).toThrow(Spake2Error);
    // pB = w*N exactly would make K the identity for this w.
    const party = mk();
    expect(() => party.finish(SPAKE2_N.multiply(9n).toBytes(false))).toThrow(Spake2Error);
    const used = mk();
    used.finish(p256.Point.BASE.multiply(5n).toBytes(false));
    expect(() => used.finish(p256.Point.BASE.multiply(5n).toBytes(false))).toThrow(/already finished/);
  });
});
