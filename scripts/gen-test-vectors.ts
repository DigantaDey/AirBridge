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
