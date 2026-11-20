import {
  decodeBinarySackFrame as decodeProtocolBinarySack,
  encodeBinarySackFrame as encodeProtocolBinarySack,
  type BinarySackFrame as ProtocolBinarySackFrame,
} from '../../../src/shared/protocol.js';

export const FRAME_ENCRYPTED_CHUNK = 0x01;
export const FRAME_ROUTED_RELAY = 0x02;
export const FRAME_BINARY_SACK = 0x03; // Compact 16-byte binary SACK opcode (unambiguous inside 0x02 relay)
export const FRAME_CHUNK_ACK_V2 = 0x03; // Protocol wire opcode alias

export const ID_ASCII_LENGTH = 16;
export const GCM_IV_LENGTH = 12;
export const GCM_TAG_LENGTH = 16;
export const CHUNK_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + 4 + 4 + GCM_IV_LENGTH; // 37 bytes
export const ROUTING_HEADER_LENGTH = 1 + ID_ASCII_LENGTH + ID_ASCII_LENGTH; // 33 bytes
export const BINARY_SACK_LENGTH = 16; // 16 bytes compact

const textDecoder = new TextDecoder();

export interface EncryptedChunkFrame {
  transferId: string;
  fileIndex: number;
  chunkIndex: number;
  iv: Uint8Array; // 12 bytes
  ciphertext: Uint8Array; // Includes 16-byte GCM auth tag
}

export interface RoutedRelayFrame {
  targetPeerId: string;
  sourcePeerId: string;
  payload: Uint8Array;
}

export interface BinarySackFrame {
  opcode?: number;
  fileIndex: number;
  chunkIndex: number;
  windowSize?: number;
  bitmask?: number;
  transferId?: string;
}

function writeFixedAsciiId(target: Uint8Array, offset: number, id: string): void {
  const padded = id.slice(0, ID_ASCII_LENGTH).padEnd(ID_ASCII_LENGTH, '0');
  for (let i = 0; i < ID_ASCII_LENGTH; i++) {
    target[offset + i] = padded.charCodeAt(i) & 0x7f;
  }
}

function readFixedAsciiId(source: Uint8Array, offset: number): string {
  return textDecoder.decode(source.subarray(offset, offset + ID_ASCII_LENGTH));
}

/**
 * Encodes a 0x01 encrypted chunk frame:
 * [0x01(1B) | transferId(16B) | fileIndex(4B BE) | chunkIndex(4B BE) | iv(12B) | ciphertext(...)]
 */
export function encodeEncryptedChunkFrame(frame: EncryptedChunkFrame): Uint8Array {
  if (frame.iv.byteLength !== GCM_IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${GCM_IV_LENGTH}, got ${frame.iv.byteLength}`);
  }
  const out = new Uint8Array(CHUNK_HEADER_LENGTH + frame.ciphertext.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = FRAME_ENCRYPTED_CHUNK;
  writeFixedAsciiId(out, 1, frame.transferId);
  view.setUint32(17, frame.fileIndex >>> 0, false);
  view.setUint32(21, frame.chunkIndex >>> 0, false);
  out.set(frame.iv, 25);
  out.set(frame.ciphertext, CHUNK_HEADER_LENGTH);

  return out;
}

/**
 * Decodes a 0x01 encrypted chunk frame.
 */
export function decodeEncryptedChunkFrame(bytes: Uint8Array): EncryptedChunkFrame {
  if (bytes.byteLength < CHUNK_HEADER_LENGTH) {
    throw new Error(`Chunk frame too short: ${bytes.byteLength} bytes (expected >= ${CHUNK_HEADER_LENGTH})`);
  }
  if (bytes[0] !== FRAME_ENCRYPTED_CHUNK) {
    throw new Error(`Unexpected chunk frame type: 0x${bytes[0].toString(16)} (expected 0x01)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const transferId = readFixedAsciiId(bytes, 1);
  const fileIndex = view.getUint32(17, false);
  const chunkIndex = view.getUint32(21, false);
  const iv = bytes.slice(25, 37);
  const ciphertext = bytes.subarray(CHUNK_HEADER_LENGTH);

  return {
    transferId,
    fileIndex,
    chunkIndex,
    iv,
    ciphertext,
  };
}

/**
 * Wraps an inner payload into a 0x02 routed relay frame:
 * [0x02(1B) | targetPeerId(16B) | sourcePeerId(16B) | payload(...)]
 */
export function wrapRoutedRelayFrame(
  targetPeerId: string,
  sourcePeerId: string,
  innerPayload: Uint8Array
): Uint8Array {
  const out = new Uint8Array(ROUTING_HEADER_LENGTH + innerPayload.byteLength);
  out[0] = FRAME_ROUTED_RELAY;
  writeFixedAsciiId(out, 1, targetPeerId);
  writeFixedAsciiId(out, 17, sourcePeerId);
  out.set(innerPayload, ROUTING_HEADER_LENGTH);
  return out;
}

/**
 * Unwraps a 0x02 routed relay frame.
 */
export function unwrapRoutedRelayFrame(bytes: Uint8Array): RoutedRelayFrame {
  if (bytes.byteLength < ROUTING_HEADER_LENGTH) {
    throw new Error(`Routed frame too short: ${bytes.byteLength} bytes (expected >= ${ROUTING_HEADER_LENGTH})`);
  }
  if (bytes[0] !== FRAME_ROUTED_RELAY) {
    throw new Error(`Unexpected routed frame type: 0x${bytes[0].toString(16)} (expected 0x02)`);
  }
  const targetPeerId = readFixedAsciiId(bytes, 1);
  const sourcePeerId = readFixedAsciiId(bytes, 17);
  const payload = bytes.subarray(ROUTING_HEADER_LENGTH);

  return {
    targetPeerId,
    sourcePeerId,
    payload,
  };
}

/**
 * Overwrites the source peer ID in a routed relay frame with the authenticated sender's ID.
 */
export function overwriteRoutedSourcePeerId(bytes: Uint8Array, authenticatedPeerId: string): void {
  if (bytes.byteLength >= ROUTING_HEADER_LENGTH && bytes[0] === FRAME_ROUTED_RELAY) {
    writeFixedAsciiId(bytes, 17, authenticatedPeerId);
  }
}

/**
 * Canonical 16-byte wire SACK codec matching src/shared/protocol.ts & Frames.kt:
 * [0x03(1B) | transferId_hex64(8B) | fileIndex(2B BE) | chunkIndex(4B BE) | bitmask(1B)]
 */
export function encodeCanonicalBinarySackFrame(frame: ProtocolBinarySackFrame): Uint8Array | null {
  return encodeProtocolBinarySack(frame);
}

export function decodeCanonicalBinarySackFrame(bytes: Uint8Array): ProtocolBinarySackFrame {
  return decodeProtocolBinarySack(bytes);
}

/**
 * Encodes a 16-byte compact binary SACK frame (canonical hex-packed when a
 * 16-hex transferId is supplied without windowSize, or legacy harness mode).
 */
export function encodeBinarySackFrame(frame: BinarySackFrame): Uint8Array {
  if (
    frame.transferId &&
    frame.windowSize === undefined &&
    /^[0-9a-f]{16}$/i.test(frame.transferId)
  ) {
    const canonical = encodeProtocolBinarySack({
      transferId: frame.transferId.toLowerCase(),
      fileIndex: frame.fileIndex,
      chunkIndex: frame.chunkIndex,
      bitmask: frame.bitmask ?? 0,
    });
    if (canonical) return canonical;
  }

  const out = new Uint8Array(BINARY_SACK_LENGTH);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  const opcode = frame.opcode ?? FRAME_BINARY_SACK;
  out[0] = opcode;

  if (frame.transferId) {
    // 8-byte transferId mode
    const tid = frame.transferId.slice(0, 8).padEnd(8, '0');
    for (let i = 0; i < 8; i++) {
      out[1 + i] = tid.charCodeAt(i) & 0x7f;
    }
    view.setUint16(9, frame.fileIndex & 0xffff, false);
    view.setUint32(11, frame.chunkIndex >>> 0, false);
    out[15] = (frame.bitmask ?? 0) & 0xff;
  } else {
    // Standard 16-byte compact SACK: fileIndex, chunkIndex, windowSize, bitmask
    view.setUint32(1, frame.fileIndex >>> 0, false);
    view.setUint32(5, frame.chunkIndex >>> 0, false);
    view.setUint32(9, (frame.windowSize ?? 16) >>> 0, false);
    out[13] = (frame.bitmask ?? 0) & 0xff;
    out[14] = 0;
    out[15] = 0;
  }

  return out;
}

/**
 * Decodes a 16-byte compact binary SACK frame.
 */
export function decodeBinarySackFrame(bytes: Uint8Array, expectTransferId = false): BinarySackFrame {
  if (bytes.byteLength < BINARY_SACK_LENGTH) {
    throw new Error(`Binary SACK frame too short: ${bytes.byteLength} bytes (expected ${BINARY_SACK_LENGTH})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opcode = bytes[0];
  if (expectTransferId) {
    const transferId = textDecoder.decode(bytes.subarray(1, 9));
    return {
      opcode,
      transferId,
      fileIndex: view.getUint16(9, false),
      chunkIndex: view.getUint32(11, false),
      bitmask: bytes[15],
    };
  }

  return {
    opcode,
    fileIndex: view.getUint32(1, false),
    chunkIndex: view.getUint32(5, false),
    windowSize: view.getUint32(9, false),
    bitmask: bytes[13],
  };
}

/**
 * Checks whether the buffer represents a 16-byte binary SACK frame.
 */
export function isBinarySackFrame(bytes: Uint8Array): boolean {
  return bytes.byteLength === BINARY_SACK_LENGTH && (bytes[0] === FRAME_BINARY_SACK || bytes[0] === FRAME_CHUNK_ACK_V2);
}

// ============================================================================
// Tampering Helpers for Boundary & Adversarial Testing
// ============================================================================

/**
 * Corrupts the 16-byte GCM authentication tag at the end of the ciphertext.
 */
export function corruptAuthTag(frame: Uint8Array, offsetFromEnd = 1): Uint8Array {
  const copy = new Uint8Array(frame);
  const targetOffset = copy.byteLength - Math.max(1, Math.min(GCM_TAG_LENGTH, offsetFromEnd));
  copy[targetOffset] ^= 0xff;
  return copy;
}

/**
 * Flips a single bit at the specified byte offset.
 */
export function flipBit(frame: Uint8Array, byteOffset: number, bitIndex = 0): Uint8Array {
  const copy = new Uint8Array(frame);
  if (byteOffset >= 0 && byteOffset < copy.byteLength) {
    copy[byteOffset] ^= 1 << (bitIndex % 8);
  }
  return copy;
}

/**
 * Truncates the frame to an invalid shorter length.
 */
export function truncateFrame(frame: Uint8Array, newLength: number): Uint8Array {
  return frame.slice(0, Math.max(0, newLength));
}

/**
 * Appends extra bytes to the end of the frame.
 */
export function expandFrame(frame: Uint8Array, extraBytes: number, fill = 0xaa): Uint8Array {
  const copy = new Uint8Array(frame.byteLength + extraBytes);
  copy.set(frame, 0);
  copy.fill(fill, frame.byteLength);
  return copy;
}

/**
 * Corrupts the frame opcode (byte 0) to an unknown or invalid type.
 */
export function corruptFrameType(frame: Uint8Array, invalidType = 0xff): Uint8Array {
  const copy = new Uint8Array(frame);
  if (copy.byteLength > 0) {
    copy[0] = invalidType;
  }
  return copy;
}

/**
 * Corrupts the 12-byte IV in an encrypted chunk frame.
 */
export function corruptIv(frame: Uint8Array, ivOffset = 25): Uint8Array {
  const copy = new Uint8Array(frame);
  if (copy.byteLength >= ivOffset + GCM_IV_LENGTH) {
    copy[ivOffset] ^= 0xff;
  }
  return copy;
}

/**
 * Modifies the transferId field in an encrypted chunk frame.
 */
export function tamperTransferId(frame: Uint8Array, invalidId: string): Uint8Array {
  const copy = new Uint8Array(frame);
  if (copy.byteLength >= 1 + ID_ASCII_LENGTH) {
    writeFixedAsciiId(copy, 1, invalidId);
  }
  return copy;
}

/**
 * Modifies the target peer ID in a routed relay frame.
 */
export function tamperRoutingTarget(frame: Uint8Array, forgedTargetId: string): Uint8Array {
  const copy = new Uint8Array(frame);
  if (copy.byteLength >= ROUTING_HEADER_LENGTH) {
    writeFixedAsciiId(copy, 1, forgedTargetId);
  }
  return copy;
}

/**
 * Modifies the source peer ID in a routed relay frame to test sender spoofing.
 */
export function tamperRoutingSource(frame: Uint8Array, forgedSourceId: string): Uint8Array {
  const copy = new Uint8Array(frame);
  if (copy.byteLength >= ROUTING_HEADER_LENGTH) {
    writeFixedAsciiId(copy, 17, forgedSourceId);
  }
  return copy;
}
