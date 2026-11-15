import type { FileManifestItem } from '../../../src/shared/protocol.js';
import { sha256Hex } from './wireCrypto.js';

/**
 * Creates a deterministic synthetic binary buffer of arbitrary size.
 */
export function createSyntheticBuffer(sizeBytes: number, seed = 0): Uint8Array {
  const buffer = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buffer[i] = (i * 31 + 17 + seed) & 0xff;
  }
  return buffer;
}

/**
 * Splits a total size into an array of synthetic chunks matching the specified chunkSize.
 */
export function createSyntheticChunks(
  totalBytes: number,
  chunkSize = 1024 * 1024,
  seed = 0
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let remaining = totalBytes;
  let offset = 0;

  while (remaining > 0) {
    const currentChunkSize = Math.min(remaining, chunkSize);
    const chunk = new Uint8Array(currentChunkSize);
    for (let i = 0; i < currentChunkSize; i++) {
      chunk[i] = ((offset + i) * 31 + 17 + seed) & 0xff;
    }
    chunks.push(chunk);
    offset += currentChunkSize;
    remaining -= currentChunkSize;
  }

  return chunks;
}

/**
 * Generates an AsyncIterable stream of chunks simulating streaming from disk or network.
 */
export async function* createAsyncByteStream(
  totalBytes: number,
  chunkSize = 64 * 1024,
  seed = 0
): AsyncIterable<Uint8Array> {
  const chunks = createSyntheticChunks(totalBytes, chunkSize, seed);
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Creates a valid FileManifestItem for protocol offers.
 */
export function createSyntheticFileManifest(
  name: string,
  sizeBytes: number,
  chunkSize = 1024 * 1024,
  mimeType = 'application/octet-stream',
  previewDataUrl?: string
): FileManifestItem {
  const totalChunks = Math.max(1, Math.ceil(sizeBytes / chunkSize));
  return {
    index: 0,
    name,
    size: sizeBytes,
    mimeType,
    totalChunks,
    chunkSize,
    previewDataUrl,
  };
}

/**
 * Creates a random byte buffer using crypto.getRandomValues.
 */
export function createRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Returns a new buffer with one or more bytes corrupted at corruptOffset.
 */
export function createCorruptedBuffer(original: Uint8Array, corruptOffset = 0): Uint8Array {
  const copy = new Uint8Array(original);
  if (copy.byteLength > 0) {
    const target = Math.min(Math.max(0, corruptOffset), copy.byteLength - 1);
    copy[target] ^= 0xff;
  }
  return copy;
}

/**
 * Returns a malformed JSON string for testing parser resilience.
 */
export function createInvalidJsonString(): string {
  return '{"type":"transfer-control","to":"abc", "broken": [1,2,';
}

/**
 * Polling helper that waits until predicate returns true or timeout expires.
 */
export function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
  timeoutMsg = 'Timed out waiting for condition'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const result = await predicate();
        if (result) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`${timeoutMsg} (after ${timeoutMs}ms)`));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, intervalMs);
  });
}

/**
 * Asserts two Uint8Arrays have identical byte content.
 */
export function assertBuffersEqual(actual: Uint8Array, expected: Uint8Array, msg = 'Buffers do not match'): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`${msg}: byteLength mismatch (actual: ${actual.byteLength}, expected: ${expected.byteLength})`);
  }
  for (let i = 0; i < actual.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${msg}: byte mismatch at index ${i} (actual: 0x${actual[i].toString(16)}, expected: 0x${expected[i].toString(16)})`);
    }
  }
}

/**
 * Validates 6-digit SAS code format: "XXX · YYY" where X and Y are digits.
 */
export function isValidSasCode(code: string): boolean {
  return /^\d{3}\s*·\s*\d{3}$/.test(code.trim());
}

/**
 * Validates 6-character Crockford pair code: "XXXXXX" or "XXX-XXX".
 */
export function isValidPairCode(code: string): boolean {
  const cleaned = code.replace(/-/g, '').trim().toUpperCase();
  if (cleaned.length !== 6) return false;
  return /^[2-9A-HJ-NP-Z]{6}$/.test(cleaned);
}

/**
 * Computes the SHA-256 hex digest of a Uint8Array.
 */
export async function computeSha256(data: Uint8Array): Promise<string> {
  return sha256Hex(data);
}
