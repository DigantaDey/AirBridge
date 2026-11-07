import { describe, expect, it } from 'vitest';
import {
  decryptBinaryChunk,
  decryptControlPayload,
  derivePeerSession,
  encryptBinaryChunk,
  encryptControlPayload,
  generateIdentityKeyPair,
  sha256Hex,
} from '../src/client/engine/crypto.js';

describe('incremental SHA-256', () => {
  it('matches WebCrypto across empty, boundary-sized, and arbitrarily split input', async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 1025, 1024 * 1024 + 13]) {
      const raw = new Uint8Array(size);
      for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) & 0xff;
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < raw.length;) {
        const next = Math.min(raw.length, offset + 1 + (offset % 79));
        chunks.push(raw.slice(offset, next));
        offset = next;
      }
      const expected = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', raw));
      const expectedHex = Array.from(expected).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(await sha256Hex(chunks)).toBe(expectedHex);
    }
  });

  it('uses the incremental path for files larger than the bounded native-digest buffer', async () => {
    const raw = new Uint8Array(9 * 1024 * 1024 + 13);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 23 + 5) & 0xff;
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < raw.length; offset += 256 * 1024) {
      chunks.push(raw.slice(offset, Math.min(raw.length, offset + 256 * 1024)));
    }
    const expected = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', raw));
    const expectedHex = Array.from(expected).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(await sha256Hex(chunks)).toBe(expectedHex);
  });
});

describe('E2EE WebCrypto ECDH P-256 + AES-256-GCM', () => {
  it('derives identical AES-256-GCM keys and 6-digit SAS codes on Android & MacBook', async () => {
    const androidKeys = await generateIdentityKeyPair();
    const macKeys = await generateIdentityKeyPair();

    const androidSession = await derivePeerSession(
      androidKeys.privateKey,
      androidKeys.publicKeyB64,
      macKeys.publicKeyB64
    );

    const macSession = await derivePeerSession(
      macKeys.privateKey,
      macKeys.publicKeyB64,
      androidKeys.publicKeyB64
    );

    expect(androidSession.sasCode).toBe(macSession.sasCode);
    expect(androidSession.sasCode).toMatch(/^\d{3} · \d{3}$/);
    expect(androidSession.fingerprintHex).toBe(macSession.fingerprintHex);

    // Control message encryption roundtrip
    const env = await encryptControlPayload(androidSession.aesKey, {
      kind: 'clipboard-beam',
      beamId: '1234567890abcdef',
      text: 'Secret OTP 918273',
      contentType: 'otp',
      timestamp: 1700000000000,
    });

    const decrypted = await decryptControlPayload(macSession.aesKey, env);
    expect(decrypted.kind).toBe('clipboard-beam');
    if (decrypted.kind === 'clipboard-beam') {
      expect(decrypted.text).toBe('Secret OTP 918273');
    }

    // Binary file chunk encryption roundtrip + tamper rejection
    const sampleBytes = new Uint8Array(65536);
    for (let i = 0; i < sampleBytes.length; i++) sampleBytes[i] = i & 0xff;

    const { iv, ciphertext } = await encryptBinaryChunk(macSession.aesKey, sampleBytes, 0, 7);
    const plain = await decryptBinaryChunk(androidSession.aesKey, iv, ciphertext);
    expect(Buffer.compare(Buffer.from(plain), Buffer.from(sampleBytes))).toBe(0);

    // Flipping 1 bit in ciphertext must fail GCM authentication
    const tampered = new Uint8Array(ciphertext);
    tampered[10] ^= 0xff;
    await expect(decryptBinaryChunk(androidSession.aesKey, iv, tampered)).rejects.toThrow();
  });
});
