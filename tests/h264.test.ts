import { describe, expect, it } from 'vitest';
import { h264CodecFromAnnexB } from '../src/client/engine/h264.js';

describe('H.264 codec identifier', () => {
  it('reads the codec profile and level from an Annex-B SPS with either start-code size', () => {
    expect(h264CodecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e]))).toBe('avc1.42001e');
    expect(h264CodecFromAnnexB(new Uint8Array([0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0, 0, 1, 0x68, 0]))).toBe('avc1.640028');
  });

  it('ignores access units that do not carry an SPS', () => {
    expect(h264CodecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]))).toBeNull();
    expect(h264CodecFromAnnexB(new Uint8Array())).toBeNull();
  });
});
