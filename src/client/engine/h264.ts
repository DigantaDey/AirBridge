/** Extract an RFC 6381 AVC codec identifier from an Annex-B SPS NAL unit. */
export function h264CodecFromAnnexB(data: Uint8Array): string | null {
  const startCodes: Array<{ offset: number; length: number }> = [];
  for (let i = 0; i + 2 < data.length;) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      startCodes.push({ offset: i, length: 3 });
      i += 3;
    } else if (i + 3 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      startCodes.push({ offset: i, length: 4 });
      i += 4;
    } else {
      i += 1;
    }
  }

  for (let i = 0; i < startCodes.length; i += 1) {
    const { offset, length } = startCodes[i]!;
    const nalStart = offset + length;
    const nalEnd = startCodes[i + 1]?.offset ?? data.length;
    if (nalStart + 3 >= nalEnd || (data[nalStart]! & 0x1f) !== 7) continue;
    const profile = data[nalStart + 1]!;
    const constraints = data[nalStart + 2]!;
    const level = data[nalStart + 3]!;
    return `avc1.${[profile, constraints, level].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}
