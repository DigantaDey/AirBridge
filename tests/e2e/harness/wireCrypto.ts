import { webcrypto } from 'node:crypto';
import type {
  ControlPayload,
  EncryptedEnvelope,
} from '../../../src/shared/protocol.js';

const subtle = globalThis.crypto?.subtle ?? (webcrypto as unknown as Crypto).subtle;
const getRandomValues =
  globalThis.crypto?.getRandomValues?.bind(globalThis.crypto) ??
  webcrypto.getRandomValues.bind(webcrypto);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface IdentityKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string; // Base64URL 65-byte uncompressed P-256 point starting with 0x04
  rawPublicKey: Uint8Array;
}

export interface PeerCryptoSession {
  aesKey: CryptoKey;
  sasCode: string; // e.g. "849 · 210"
  fingerprintHex: string; // e.g. "9F2A:4C11:88E0"
  rawSharedBits?: Uint8Array;
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function utf8ToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/**
 * Generates an ephemeral NIST curve P-256 ECDH keypair and exports the 65-byte
 * uncompressed public key formatted as canonical Base64URL.
 */
export async function generateIdentityKeyPair(): Promise<IdentityKeys> {
  const kp = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const rawPub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyB64: bytesToBase64Url(rawPub),
    rawPublicKey: rawPub,
  };
}

/**
 * Derives a 6-digit SAS code and hex fingerprint from two public keys.
 */
export async function deriveSasCode(
  pubKeyA: string,
  pubKeyB: string
): Promise<{ sasCode: string; fingerprintHex: string }> {
  const sortedPubs = [pubKeyA, pubKeyB].sort().join(':');
  const sasDigest = new Uint8Array(
    await subtle.digest(
      'SHA-256',
      toArrayBuffer(utf8ToBytes(`airbridge-sas-v1:${sortedPubs}`))
    )
  );
  const view = new DataView(sasDigest.buffer, sasDigest.byteOffset, sasDigest.byteLength);
  const sixDigits = String(view.getUint32(0, false) % 1_000_000).padStart(6, '0');
  const sasCode = `${sixDigits.slice(0, 3)} · ${sixDigits.slice(3, 6)}`;

  const fpParts: string[] = [];
  for (let i = 4; i < 10; i += 2) {
    const word = ((sasDigest[i] << 8) | sasDigest[i + 1])
      .toString(16)
      .toUpperCase()
      .padStart(4, '0');
    fpParts.push(word);
  }

  return {
    sasCode,
    fingerprintHex: fpParts.join(':'),
  };
}

/**
 * Performs ECDH P-256 key agreement and HKDF-SHA-256 derivation to obtain
 * an AES-256-GCM session key and SAS code, identical to Android and Desktop engines.
 */
export async function derivePeerSession(
  myPrivateKey: CryptoKey,
  myPublicKeyB64: string,
  peerPublicKeyB64: string
): Promise<PeerCryptoSession> {
  const peerRaw = base64UrlToBytes(peerPublicKeyB64);
  const peerPubKey = await subtle.importKey(
    'raw',
    toArrayBuffer(peerRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const sharedBits = await subtle.deriveBits(
    { name: 'ECDH', public: peerPubKey },
    myPrivateKey,
    256
  );

  const sortedPubs = [myPublicKeyB64, peerPublicKeyB64].sort().join(':');
  const saltDigest = await subtle.digest(
    'SHA-256',
    toArrayBuffer(utf8ToBytes(`airbridge-salt:${sortedPubs}`))
  );

  const hkdfBase = await subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey']
  );

  const aesKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltDigest,
      info: toArrayBuffer(utf8ToBytes('airbridge-warp-e2ee-v1')),
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const { sasCode, fingerprintHex } = await deriveSasCode(myPublicKeyB64, peerPublicKeyB64);

  return {
    aesKey,
    sasCode,
    fingerprintHex,
    rawSharedBits: new Uint8Array(sharedBits),
  };
}

/**
 * Encrypts a JSON control payload into an AES-GCM encrypted envelope.
 */
export async function encryptControlPayload(
  aesKey: CryptoKey,
  payload: ControlPayload
): Promise<EncryptedEnvelope> {
  const iv = new Uint8Array(12);
  getRandomValues(iv);
  const plainBytes = utf8ToBytes(JSON.stringify(payload));

  const cipherBuf = await subtle.encrypt(
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

/**
 * Decrypts an AES-GCM encrypted envelope into a JSON control payload.
 */
export async function decryptControlPayload(
  aesKey: CryptoKey,
  envelope: EncryptedEnvelope
): Promise<ControlPayload> {
  const iv = base64UrlToBytes(envelope.iv);
  const cipher = base64UrlToBytes(envelope.ciphertext);

  const plainBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(cipher)
  );

  const json = bytesToUtf8(new Uint8Array(plainBuf));
  return JSON.parse(json) as ControlPayload;
}

/**
 * Encrypts a binary chunk with a 12-byte random IV and AES-256-GCM.
 * Ciphertext contains the appended 16-byte GCM authentication tag.
 */
export async function encryptBinaryChunk(
  aesKey: CryptoKey,
  plaintext: Uint8Array
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = new Uint8Array(12);
  getRandomValues(iv);

  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(plaintext)
  );

  return {
    iv,
    ciphertext: new Uint8Array(cipherBuf),
  };
}

/**
 * Decrypts an AES-256-GCM binary chunk using the 12-byte IV.
 * Throws an error if the authentication tag is invalid or tampered.
 */
export async function decryptBinaryChunk(
  aesKey: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const plainBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(plainBuf);
}

/**
 * Exports an AES CryptoKey as 32 raw bytes.
 */
export async function exportRawAesKey(aesKey: CryptoKey): Promise<Uint8Array> {
  const raw = await subtle.exportKey('raw', aesKey);
  return new Uint8Array(raw);
}

/**
 * Imports 32 raw bytes into an AES-GCM CryptoKey.
 */
export async function importRawAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return await subtle.importKey(
    'raw',
    toArrayBuffer(rawKey),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Computes SHA-256 hex digest of a byte buffer or array of byte buffers.
 */
export async function sha256Hex(data: Uint8Array | Uint8Array[]): Promise<string> {
  let combined: Uint8Array;
  if (Array.isArray(data)) {
    const totalLength = data.reduce((acc, c) => acc + (c ? c.byteLength : 0), 0);
    combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of data) {
      if (chunk) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } else {
    combined = data;
  }

  const digest = new Uint8Array(
    await subtle.digest('SHA-256', toArrayBuffer(combined))
  );
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
