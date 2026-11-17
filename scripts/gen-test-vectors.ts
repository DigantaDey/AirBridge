/**
 * Generates cross-implementation test vectors by exercising the REAL
 * TypeScript protocol/crypto reference implementations, then writes them to
 * android/engine/src/test/resources/vectors.json for the Kotlin engine test
 * runner (VectorsTest.kt).
 *
 * Run:  npx tsx scripts/gen-test-vectors.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hkdfSync } from 'node:crypto';

import {
  generateIdentityKeyPair,
  derivePeerSession,
  encryptControlPayload,
  encryptBinaryChunk,
} from '../src/client/engine/crypto';
import {
  generatePairCode,
  normalizePairCode,
  isValidPairCode,
  formatPairCode,
  encodeEncryptedChunkFrame,
  wrapRoutedRelayFrame,
  classifyTextPayload,
  utf8ToBytes,
} from '../src/shared/protocol';
import { isValidFileManifest } from '../src/client/engine/warpClient';
import { Spake2, bigIntTo32 } from '../src/shared/spake2';
import {
  HUB_SPAKE2_IDENTITY,
  JOIN_SPAKE2_AAD,
  hubProof,
  joinerSpake2Identity,
  nameplateFor,
  passwordScalar,
  peerVouch,
  vouchKeyFrom,
} from '../src/shared/pairingProof';
import { loadOrCreateDeviceIdentity } from '../src/client/engine/identity';

const b64url = (b: Uint8Array): string =>
  Buffer.from(b).toString('base64url');
const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
const sha256 = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b as unknown as BufferSource));
const exportPkcs8 = async (key: CryptoKey): Promise<string> =>
  b64url(new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', key)));
const deriveBits = async (priv: CryptoKey, pubRawB64: string): Promise<Uint8Array> => {
  const pub = await globalThis.crypto.subtle.importKey(
    'raw',
    Buffer.from(pubRawB64, 'base64url') as unknown as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256),
  );
};

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};

  // ---- identities + sessions (ECDH / HKDF / SAS / fingerprint) ----
  const A = await generateIdentityKeyPair();
  const B = await generateIdentityKeyPair();
  const pkcs8A = await exportPkcs8(A.privateKey);
  const pkcs8B = await exportPkcs8(B.privateKey);
  const pubA = A.publicKeyB64;
  const pubB = B.publicKeyB64;

  const sharedAB = await deriveBits(A.privateKey, pubB);
  const sharedBA = await deriveBits(B.privateKey, pubA);
  if (Buffer.compare(Buffer.from(sharedAB), Buffer.from(sharedBA)) !== 0) {
    throw new Error('ECDH shared secrets differ between directions');
  }

  const sortedPubs = [pubA, pubB].sort().join(':');
  const saltDigest = await sha256(utf8(`airbridge-salt:${sortedPubs}`));
  const hkdfKey = new Uint8Array(
    hkdfSync('sha256', sharedAB, saltDigest, utf8('airbridge-warp-e2ee-v1'), 32),
  );

  const sessionA = await derivePeerSession(A.privateKey, pubA, pubB);

  out.identities = [
    { pkcs8: pkcs8A, peerPub: pubB, sharedB64: b64url(sharedAB) },
    { pkcs8: pkcs8B, peerPub: pubA, sharedB64: b64url(sharedBA) },
  ];
  out.sessions = [
    {
      pkcs8: pkcs8A,
      pubA,
      pubB,
      sas: sessionA.sasCode,
      fingerprint: sessionA.fingerprintHex,
      hkdfKeyB64: b64url(hkdfKey),
    },
  ];

  // ---- control envelopes ----
  const payload = { kind: 'ping', ts: 1700000000000 };
  const plaintext = JSON.stringify(payload);
  const envelope = await encryptControlPayload(sessionA.aesKey, payload as never);
  out.envelopes = [
    { pkcs8: pkcs8A, pubA, pubB, plaintext, ivB64: envelope.iv, ciphertextB64: envelope.ciphertext },
  ];

  // ---- binary chunks (IV layout + GCM) ----
  const plain = new Uint8Array(517);
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 31 + 7) & 0xff;
  const fileIndex = 3;
  const chunkIndex = 41;
  const chunk = await encryptBinaryChunk(sessionA.aesKey, plain, fileIndex, chunkIndex);
  out.chunks = [
    {
      pkcs8: pkcs8A,
      pubA,
      pubB,
      fileIndex,
      chunkIndex,
      plainB64: b64url(plain),
      ivB64: b64url(chunk.iv),
      ciphertextB64: b64url(chunk.ciphertext),
    },
  ];

  // ---- frame codecs ----
  const transferId = '0123456789abcdef';
  const chunkFrame = encodeEncryptedChunkFrame({
    transferId,
    fileIndex,
    chunkIndex,
    iv: chunk.iv,
    ciphertext: chunk.ciphertext,
  });
  out.chunkFrames = [
    {
      transferId,
      fileIndex,
      chunkIndex,
      ivB64: b64url(chunk.iv),
      ciphertextB64: b64url(chunk.ciphertext),
      frameB64: b64url(chunkFrame),
    },
  ];

  const routedTarget = 'fedcba9876543210';
  const routedSource = '0123456789abcdef';
  const routedPayload = utf8('{"kind":"clipboard-beam","beamId":"00ffeeddccbbaa99"}');
  const routedFrame = wrapRoutedRelayFrame(routedTarget, routedSource, routedPayload);
  out.routedFrames = [
    {
      target: routedTarget,
      source: routedSource,
      payloadB64: b64url(routedPayload),
      frameB64: b64url(routedFrame),
    },
  ];

  // ---- pair codes ----
  const pairRandom = new Uint8Array([0xa1, 0x42, 0xff, 0x07, 0x19, 0x88, 0xc0, 0x01]);
  const pairInputs = ['ab-cd-ef', 'XY Z1-2', 'short', 'abcdefghij', '123456', '  mix ed 9 '];
  out.pairCodes = [
    { randomHex: Buffer.from(pairRandom).toString('hex'), code: generatePairCode(pairRandom) },
    ...pairInputs.map((raw) => ({
      raw,
      normalized: normalizePairCode(raw),
      formatted: formatPairCode(raw),
      valid: isValidPairCode(raw),
    })),
  ];

  // ---- clipboard classification ----
  const classifyInputs = [
    'https://example.com:8443/path?q=1',
    'http://192.168.1.10:3411/airbridge',
    'user@example.com',
    '491044',
    '12345678',
    'your verification code is 482913',
    'otp 1234',
    'hello world',
    'const x = 1;\nreturn x;',
    'curl -X POST http://localhost/v1\nnpm install -g airbridge',
    '{"a": 1}',
    '987654321012345',
    'PIN: 9921',
    'plain\nmulti line text without code markers',
  ];
  out.classify = classifyInputs.map((text) => ({
    text,
    kind: classifyTextPayload(text),
  }));

  // ---- manifests ----
  const mkFile = (index: number, name: string, size: number, chunkSize: number, extra: Record<string, unknown> = {}) => ({
    index,
    name,
    size,
    chunkSize,
    totalChunks: Math.max(1, Math.ceil(size / chunkSize)),
    ...extra,
  });
  const many = Array.from({ length: 101 }, (_, i) => mkFile(i, `f${i}.bin`, 1024, 65536));
  const manifestCases: Array<{ files: unknown; totalBytes: number | null; valid: boolean }> = [
    { files: [mkFile(0, 'a.bin', 1048576, 262144)], totalBytes: 1048576, valid: true },
    { files: [mkFile(0, 'empty.bin', 0, 65536)], totalBytes: 0, valid: true },
    { files: [mkFile(0, 'a.bin', 4096, 65536, { previewDataUrl: 'data:image/png;base64,iVBOR' })], totalBytes: 4096, valid: true },
    { files: [mkFile(1, 'a.bin', 4096, 65536)], totalBytes: 4096, valid: false }, // index mismatch
    { files: [mkFile(0, 'a.bin', 4096, 8192)], totalBytes: 4096, valid: false }, // chunkSize < 16 KiB
    { files: [{ ...mkFile(0, 'a.bin', 4096, 65536), totalChunks: 9 }], totalBytes: 4096, valid: false },
    { files: [mkFile(0, 'a.bin', 4096, 65536)], totalBytes: 4097, valid: false }, // sum mismatch
    { files: [], totalBytes: 0, valid: false },
    { files: [mkFile(0, 'a.bin', 4096, 65536, { previewDataUrl: 'data:text/plain;base64,SGk=' })], totalBytes: 4096, valid: false },
    { files: many, totalBytes: many.reduce((s, f) => s + (f as { size: number }).size, 0), valid: false }, // >100 files
    { files: [mkFile(0, 'a.bin', 4096, 65536)], totalBytes: null, valid: false },
    { files: [mkFile(0, 'x'.repeat(513), 4096, 65536)], totalBytes: 4096, valid: false }, // name > 512
  ];
  out.manifests = manifestCases.map((c) => ({
    filesJson: JSON.stringify(c.files),
    totalBytes: c.totalBytes,
    expected: c.valid,
    actualTs: isValidFileManifest(c.files, c.totalBytes as never),
  }));
  for (const m of out.manifests as Array<{ expected: boolean; actualTs: boolean }>) {
    if (m.expected !== m.actualTs) throw new Error('fixture generator disagrees with TS validator');
  }

  // ---- SPAKE2 (RFC 9382 vector + an AirBridge join run) ----
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const spakeRun = (w: bigint, x: bigint, y: bigint, idA: Uint8Array, idB: Uint8Array, aad: Uint8Array) => {
    const a = new Spake2('A', w, idA, idB, aad, x);
    const b = new Spake2('B', w, idA, idB, aad, y);
    const ra = a.finish(b.share());
    const rb = b.finish(a.share());
    if (hex(ra.ke) !== hex(rb.ke)) throw new Error('SPAKE2 sides disagree');
    return {
      wHex: hex(bigIntTo32(w)), xHex: hex(bigIntTo32(x)), yHex: hex(bigIntTo32(y)),
      idAB64: b64url(idA), idBB64: b64url(idB), aadB64: b64url(aad),
      pAHex: hex(a.share()), pBHex: hex(b.share()),
      keHex: hex(ra.ke), confirmAHex: hex(ra.confirm), confirmBHex: hex(rb.confirm),
    };
  };
  const rfcRun = spakeRun(
    BigInt('0x2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f'),
    BigInt('0x43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729'),
    BigInt('0xdcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be'),
    utf8('server'), utf8('client'), new Uint8Array(0),
  );
  if (rfcRun.confirmAHex !== '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0') {
    throw new Error('TS SPAKE2 no longer matches RFC 9382');
  }
  const deviceIdentity = await loadOrCreateDeviceIdentity(null);
  const joinRun = spakeRun(
    passwordScalar('K7Q2XP'),
    0x1234567890abcdefn,
    0xfedcba0987654321n,
    joinerSpake2Identity(pubA, deviceIdentity.publicKeyB64),
    HUB_SPAKE2_IDENTITY,
    JOIN_SPAKE2_AAD,
  );
  out.spake2 = [{ name: 'rfc9382', ...rfcRun }, { name: 'airbridge-join', code: 'K7Q2XP', ...joinRun }];

  // ---- pairing proof (nameplates, password scalars, vouches) ----
  const ke = Uint8Array.from(Buffer.from(joinRun.keHex, 'hex'));
  const vk = vouchKeyFrom(ke);
  out.pairingProof = ['K7Q2XP', 'k7q-2xp', '222222', 'ZZZZZZ'].map((code) => ({
    code,
    nameplate: nameplateFor(code),
    wHex: hex(bigIntTo32(passwordScalar(code))),
  }));
  out.vouches = [
    { keHex: joinRun.keHex, vouchKeyB64: b64url(vk), peerId: '0123456789abcdef', publicKey: pubB, identityKey: deviceIdentity.publicKeyB64, attestation: 'pake' },
    { keHex: joinRun.keHex, vouchKeyB64: b64url(vk), peerId: 'fedcba9876543210', publicKey: pubA, identityKey: null, attestation: 'host' },
  ].map((v) => ({ ...v, vouch: peerVouch(vk, { peerId: v.peerId, publicKey: v.publicKey, identityKey: v.identityKey ?? undefined, attestation: v.attestation as 'pake' | 'host' }) }));
  out.hubProofs = [
    { peerId: '0123456789abcdef', pairCode: 'K7Q2XP', tlsPin: 'pinpinpinpinpinpinpinpinpinpinpinpinpinpinp' },
    { peerId: '0123456789abcdef', pairCode: 'K7Q2XP', tlsPin: null },
  ].map((h) => ({ ...h, keHex: joinRun.keHex, proof: hubProof(vk, h) }));

  // ---- identity bindings (WebCrypto ECDSA, raw r||s) ----
  const goodSig = await deviceIdentity.signBinding(pubA);
  const badSig = goodSig.slice(0, 10) + (goodSig[10] === 'A' ? 'B' : 'A') + goodSig.slice(11);
  out.identityBindings = [
    { identityKey: deviceIdentity.publicKeyB64, sessionKey: pubA, sig: goodSig, valid: true },
    { identityKey: deviceIdentity.publicKeyB64, sessionKey: pubB, sig: goodSig, valid: false },
    { identityKey: deviceIdentity.publicKeyB64, sessionKey: pubA, sig: badSig, valid: false },
  ];

  // ---- v2 (identity-based) verification code ----
  const otherIdentity = await loadOrCreateDeviceIdentity(null);
  const sessionV2 = await derivePeerSession(A.privateKey, pubA, pubB, { mine: deviceIdentity.publicKeyB64, peer: otherIdentity.publicKeyB64 });
  out.sessionsV2 = [{
    pkcs8: pkcs8A, pubA, pubB, idMine: deviceIdentity.publicKeyB64, idPeer: otherIdentity.publicKeyB64,
    sas: sessionV2.sasCode, fingerprint: sessionV2.fingerprintHex,
  }];

  // ---- HKDF standalone ----
  const ikm = new Uint8Array(32).fill(0x5a);
  const salt = await sha256(utf8('airbridge-salt:0000000000000000:1111111111111111'));
  const info = 'airbridge-warp-e2ee-v1';
  out.hkdf = [
    {
      ikmB64: b64url(ikm),
      saltB64: b64url(salt),
      info,
      keyB64: b64url(new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(info), 32))),
    },
  ];

  const self = dirname(fileURLToPath(import.meta.url));
  const dest = resolve(self, '../android/engine/src/test/resources/vectors.json');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(out, null, 1));
  console.log(`wrote ${dest}`);
  for (const [k, v] of Object.entries(out)) {
    console.log(`  ${k}: ${(v as unknown[]).length}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
