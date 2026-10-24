import { describe, expect, it } from 'vitest';
import { buildZipArchiveParts, crc32 } from '../src/shared/zipStore.js';

describe('Zero-Dependency PKZIP Archive Builder', () => {
  it('computes standard IEEE 802.3 CRC-32 accurately', () => {
    const encoder = new TextEncoder();
    const check = crc32([encoder.encode('123456789')]);
    expect(check).toBe(0xcbf43926);
  });

  it('builds a valid PKZIP archive with local headers, central directory, and EOCD', () => {
    const encoder = new TextEncoder();
    const parts = buildZipArchiveParts([
      {
        path: 'AndroidCamera/IMG_001.txt',
        chunks: [encoder.encode('Hello from Pixel 9 Pro!')],
      },
      {
        path: 'AndroidCamera/notes.md',
        chunks: [encoder.encode('# MacBook Notes\nFast transfer.')],
      },
    ]);

    const merged = Buffer.concat(parts.map((p) => Buffer.from(p)));
    // Local File Header magic PK\x03\x04
    expect(merged.readUInt32LE(0)).toBe(0x04034b50);
    // End of Central Directory magic PK\x05\x06 at the end (22 bytes from end)
    expect(merged.readUInt32LE(merged.length - 22)).toBe(0x06054b50);
    // Entry count = 2
    expect(merged.readUInt16LE(merged.length - 12)).toBe(2);
    expect(merged.includes(Buffer.from('AndroidCamera/IMG_001.txt'))).toBe(true);
    expect(merged.includes(Buffer.from('Hello from Pixel 9 Pro!'))).toBe(true);
  });
});
