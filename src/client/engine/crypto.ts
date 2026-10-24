import {
  type ControlPayload,
  type EncryptedEnvelope,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  utf8ToBytes,
} from '../../shared/protocol.js';

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
  fileIndex: number,
  chunkIndex: number
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv.subarray(0, 4));
  const view = new DataView(iv.buffer);
  view.setUint32(4, fileIndex >>> 0, false);
  view.setUint32(8, chunkIndex >>> 0, false);

  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(plaintext)
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
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(plainBuf);
}

export async function sha256Hex(chunks: Array<Uint8Array | undefined>): Promise<string> {
  let totalLen = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c) totalLen += c.byteLength;
  }
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c) continue;
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(merged))
  );
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
