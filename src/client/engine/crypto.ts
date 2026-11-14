import {
  type ControlPayload,
  type EncryptedEnvelope,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  utf8ToBytes,
} from '../../shared/protocol.js';
import { Sha256Stream } from './sha256Stream.js';

export interface IdentityKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string;
}

export interface PeerCryptoSession {
  aesKey: CryptoKey;
  sasCode: string; // e.g. "849 · 210"
  fingerprintHex: string; // e.g. "9F2A:4C11:88E0"
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

/**
 * WebCrypto accepts any ArrayBufferView and respects its byteOffset/length,
 * so chunk data (often a subarray of a received frame, or a fresh file slice)
 * can be handed over as-is. The previous code copied every chunk into a new
 * ArrayBuffer before each encrypt/decrypt — at 256 KiB per chunk that copy
 * was pure memory-bandwidth overhead on the hot path.
 */
function asBufferSource(u8: Uint8Array): BufferSource {
  return u8 as unknown as BufferSource;
}

export async function generateIdentityKeyPair(): Promise<IdentityKeys> {
  // crypto.subtle only exists in secure contexts (HTTPS or localhost).
  // Without this guard an http://<LAN-IP> page fails with an opaque
  // "Cannot read properties of undefined (reading 'generateKey')".
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'WebCrypto is unavailable because this page is not a secure context. ' +
        'Open AirBridge over HTTPS (or http://localhost) — browsers block ' +
        'crypto.subtle on plain-HTTP LAN addresses.'
    );
  }
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyB64: bytesToBase64Url(rawPub),
  };
}

export async function derivePeerSession(
  myPrivateKey: CryptoKey,
  myPublicKeyB64: string,
  peerPublicKeyB64: string
): Promise<PeerCryptoSession> {
  const peerRaw = base64UrlToBytes(peerPublicKeyB64);
  const peerPubKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(peerRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPubKey },
    myPrivateKey,
    256
  );

  const sortedPubs = [myPublicKeyB64, peerPublicKeyB64].sort().join(':');
  const saltDigest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    toArrayBuffer(utf8ToBytes(`airbridge-salt:${sortedPubs}`))
  );

  const hkdfBase = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey']
  );

  const aesKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltDigest,
      info: toArrayBuffer(utf8ToBytes('airbridge-warp-e2ee-v1')),
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // Derive 6-digit SAS verification code & hex fingerprint from sorted public keys + shared key confirmation
  const sasDigest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(utf8ToBytes(`airbridge-sas-v1:${sortedPubs}`))
    )
  );
  const view = new DataView(sasDigest.buffer);
  const sixDigits = String(view.getUint32(0, false) % 1_000_000).padStart(6, '0');
  const sasCode = `${sixDigits.slice(0, 3)} · ${sixDigits.slice(3, 6)}`;

  const fpParts: string[] = [];
  for (let i = 4; i < 10; i += 2) {
    const word = ((sasDigest[i] << 8) | sasDigest[i + 1]).toString(16).toUpperCase().padStart(4, '0');
    fpParts.push(word);
  }

  return {
    aesKey,
    sasCode,
    fingerprintHex: fpParts.join(':'),
  };
}

export async function encryptControlPayload(
  aesKey: CryptoKey,
  payload: ControlPayload
): Promise<EncryptedEnvelope> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const plainBytes = utf8ToBytes(JSON.stringify(payload));

  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(plainBytes)
  );

  return {
    encrypted: true,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(cipherBuf)),
  };
}

export async function decryptControlPayload(
  aesKey: CryptoKey,
  envelope: EncryptedEnvelope
): Promise<ControlPayload> {
  const iv = base64UrlToBytes(envelope.iv);
  const cipher = base64UrlToBytes(envelope.ciphertext);

  const plainBuf = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(cipher)
  );

  const json = bytesToUtf8(new Uint8Array(plainBuf));
  return JSON.parse(json) as ControlPayload;
}

export async function encryptBinaryChunk(
  aesKey: CryptoKey,
  plaintext: Uint8Array,
  _fileIndex: number,
  _chunkIndex: number
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  // File/chunk indexes repeat across transfers and reconnects. Encoding them
  // in 8 nonce bytes left just 32 random bits for the same position under a
  // long-lived peer key. All 96 bits must be fresh randomness instead.
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);

  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    asBufferSource(plaintext)
  );

  return {
    iv,
    ciphertext: new Uint8Array(cipherBuf),
  };
}

export async function decryptBinaryChunk(
  aesKey: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const plainBuf = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    asBufferSource(ciphertext)
  );
  return new Uint8Array(plainBuf);
}

export async function sha256Hex(chunks: Array<Uint8Array | undefined>): Promise<string> {
  // Keep ordinary files on WebCrypto's native implementation. The merge is
  // capped at 8 MiB; larger receives use the incremental path below and never
  // allocate another whole-file buffer.
  const NATIVE_DIGEST_LIMIT = 8 * 1024 * 1024;
  let totalBytes = 0;
  let onlyChunk: Uint8Array | undefined;
  let presentCount = 0;
  for (const chunk of chunks) {
    if (chunk) {
      totalBytes += chunk.byteLength;
      onlyChunk = chunk;
      presentCount++;
    }
  }
  if (totalBytes <= NATIVE_DIGEST_LIMIT) {
    let data: Uint8Array;
    if (presentCount === 1 && onlyChunk) {
      data = onlyChunk;
    } else {
      data = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        if (!chunk) continue;
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', asBufferSource(data)),
    );
    return Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Missing slots represent absent chunks in an incomplete receive and are
  // intentionally skipped; completion verification separately requires every
  // chunk to exist. Incremental hashing avoids a second full-file allocation.
  const hash = new Sha256Stream();
  let bytesSinceYield = 0;
  for (const chunk of chunks) {
    if (chunk) {
      hash.update(chunk);
      bytesSinceYield += chunk.byteLength;
    }
    // Yield after a bounded amount of hashing rather than a fixed number of
    // array slots: callers may provide very small or sparse chunks.
    if (bytesSinceYield >= 4 * 1024 * 1024) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      bytesSinceYield = 0;
    }
  }
  return hash.hex();
}
