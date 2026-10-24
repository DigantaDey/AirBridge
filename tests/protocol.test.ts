import { describe, expect, it } from 'vitest';
import {
  classifyTextPayload,
  decodeEncryptedChunkFrame,
  encodeEncryptedChunkFrame,
  formatPairCode,
  generatePairCode,
  isValidPairCode,
  normalizePairCode,
  overwriteRoutedSourcePeerId,
  unwrapRoutedRelayFrame,
  wrapRoutedRelayFrame,
} from '../src/shared/protocol.js';

describe('Warp Protocol v1 Codecs & Utilities', () => {
  it('generates, normalizes, and formats unambiguous 6-char pair codes', () => {
    const code = generatePairCode(new Uint8Array([0, 7, 15, 22, 31, 9]));
    expect(code).toHaveLength(6);
    expect(isValidPairCode(code)).toBe(true);
    expect(formatPairCode(code)).toMatch(/^[2-9A-Z]{3}-[2-9A-Z]{3}$/);

    // Ambiguous 0/O/1/I characters normalize safely
    const normalized = normalizePairCode('k7m-01i');
    expect(normalized).toBe('K7M2LJ');
    expect(isValidPairCode(normalized)).toBe(true);
  });

  it('encodes and decodes 0x01 encrypted binary chunk frames losslessly', () => {
    const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const ciphertext = new Uint8Array([99, 88, 77, 66, 55, 44, 33]);
    const encoded = encodeEncryptedChunkFrame({
      transferId: 'a1b2c3d4e5f60718',
      fileIndex: 3,
      chunkIndex: 42,
      iv,
      ciphertext,
    });

    const decoded = decodeEncryptedChunkFrame(encoded);
    expect(decoded.transferId).toBe('a1b2c3d4e5f60718');
    expect(decoded.fileIndex).toBe(3);
    expect(decoded.chunkIndex).toBe(42);
    expect(Array.from(decoded.iv)).toEqual(Array.from(iv));
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ciphertext));
  });

  it('wraps, stamps sender identity, and unwraps 0x02 WS relay frames', () => {
    const inner = new Uint8Array([0x01, 0xaa, 0xbb, 0xcc]);
    const wrapped = wrapRoutedRelayFrame('1111222233334444', '0000000000000000', inner);
    overwriteRoutedSourcePeerId(wrapped, '9999888877776666');

    const unwrapped = unwrapRoutedRelayFrame(wrapped);
    expect(unwrapped.targetPeerId).toBe('1111222233334444');
    expect(unwrapped.sourcePeerId).toBe('9999888877776666');
    expect(Array.from(unwrapped.payload)).toEqual([0x01, 0xaa, 0xbb, 0xcc]);
  });

  it('classifies clipboard text payloads accurately (URL, OTP, code, text)', () => {
    expect(classifyTextPayload('https://github.com/DigantaDey/android-to-mac')).toBe('url');
    expect(classifyTextPayload('482910')).toBe('otp');
    expect(classifyTextPayload('Your verification code is 739201')).toBe('otp');
    expect(classifyTextPayload('const x = () => {\n  return 42;\n};')).toBe('code');
    expect(classifyTextPayload('Dinner at Park Street around 8pm?')).toBe('text');
  });
});
