/**
 * Long-term device identity (ECDSA P-256).
 *
 * Every connection still uses a fresh ECDH key for end-to-end encryption, so
 * recorded traffic stays safe even if a device is later compromised (forward
 * secrecy). The identity key only signs that session key. It is what peers
 * remember as "trusted", survives restarts and lets AirBridge notice when a
 * known device suddenly presents a different key.
 *
 * Browsers keep the private key in IndexedDB as a non-extractable CryptoKey:
 * page script can use it to sign but can never read the key material.
 */
import { base64UrlToBytes, bytesToBase64Url } from '../../shared/protocol.js';
import { identityBindingMessage } from '../../shared/pairingProof.js';

export interface DeviceIdentity {
  /** base64url raw (65-byte uncompressed) P-256 public key. */
  publicKeyB64: string;
  /** Signs `identityBindingMessage(sessionPublicKey)`; returns base64url raw r‖s. */
  signBinding(sessionPublicKeyB64: string): Promise<string>;
  /** True when the key survives restarts (false = in-memory fallback). */
  persistent: boolean;
}

export interface StoredIdentityKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** Pluggable persistence (headless peers store a JWK on disk instead of IndexedDB). */
export interface IdentityStore {
  load(): Promise<StoredIdentityKeys | null>;
  save(keys: StoredIdentityKeys): Promise<void>;
  /** Whether keys must be extractable to be saved (e.g. written to a file). */
  needsExtractable?: boolean;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

function toBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

async function fromKeys(keys: StoredIdentityKeys, persistent: boolean): Promise<DeviceIdentity> {
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keys.publicKey));
  return {
    publicKeyB64: bytesToBase64Url(raw),
    persistent,
    async signBinding(sessionPublicKeyB64: string) {
      const sig = await globalThis.crypto.subtle.sign(SIGN, keys.privateKey, toBuffer(identityBindingMessage(sessionPublicKeyB64)));
      return bytesToBase64Url(new Uint8Array(sig));
    },
  };
}

export async function loadOrCreateDeviceIdentity(store: IdentityStore | null): Promise<DeviceIdentity> {
  if (store) {
    try {
      const existing = await store.load();
      if (existing) return await fromKeys(existing, true);
    } catch {
      // Corrupt or unreadable store: fall through and create a new identity.
    }
  }
  const generated = (await globalThis.crypto.subtle.generateKey(ECDSA, !!store?.needsExtractable, ['sign', 'verify'])) as CryptoKeyPair;
  const keys = { privateKey: generated.privateKey, publicKey: generated.publicKey };
  let persistent = false;
  if (store) {
    try {
      await store.save(keys);
      persistent = true;
    } catch {
      persistent = false;
    }
  }
  return fromKeys(keys, persistent);
}

/** Verify that `identityKey` signed `sessionPublicKey`. Never throws. */
export async function verifyIdentityBinding(identityKeyB64: string, signatureB64: string, sessionPublicKeyB64: string): Promise<boolean> {
  try {
    const raw = base64UrlToBytes(identityKeyB64);
    const sig = base64UrlToBytes(signatureB64);
    if (raw.length !== 65 || raw[0] !== 0x04 || sig.length !== 64) return false;
    const key = await globalThis.crypto.subtle.importKey('raw', toBuffer(raw), ECDSA, false, ['verify']);
    return await globalThis.crypto.subtle.verify(SIGN, key, toBuffer(sig), toBuffer(identityBindingMessage(sessionPublicKeyB64)));
  } catch {
    return false;
  }
}

/** IndexedDB-backed store; null where IndexedDB is unavailable (private mode, Node). */
export function indexedDbIdentityStore(name: string): IdentityStore | null {
  const idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(`${name}:identity`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction('keys', mode);
          const req = fn(tx.objectStore('keys'));
          tx.oncomplete = () => { db.close(); resolve(req.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        }),
    );
  return {
    async load() {
      const value = (await run('readonly', (s) => s.get('device'))) as StoredIdentityKeys | undefined;
      return value?.privateKey && value?.publicKey ? value : null;
    },
    async save(keys) {
      await run('readwrite', (s) => s.put(keys, 'device'));
    },
  };
}

/** Store that serializes the key pair as JWK through a string getter/setter (headless peers). */
export function jwkIdentityStore(read: () => string | null, write: (value: string) => void): IdentityStore {
  return {
    needsExtractable: true,
    async load() {
      const text = read();
      if (!text) return null;
      const parsed = JSON.parse(text) as { privateKey: JsonWebKey; publicKey: JsonWebKey };
      const privateKey = await globalThis.crypto.subtle.importKey('jwk', parsed.privateKey, ECDSA, false, ['sign']);
      const publicKey = await globalThis.crypto.subtle.importKey('jwk', parsed.publicKey, ECDSA, true, ['verify']);
      return { privateKey, publicKey };
    },
    async save(keys) {
      const privateKey = await globalThis.crypto.subtle.exportKey('jwk', keys.privateKey);
      const publicKey = await globalThis.crypto.subtle.exportKey('jwk', keys.publicKey);
      write(JSON.stringify({ privateKey, publicKey }));
    },
  };
}
