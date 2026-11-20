/** Split an H.264 Annex-B byte stream into individual NAL units (without start codes). */
export function splitAnnexBNalus(data: Uint8Array): Uint8Array[] {
  const startCodes: Array<{ offset: number; length: number }> = [];
  for (let i = 0; i + 2 < data.length;) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      startCodes.push({ offset: i, length: 3 });
      i += 3;
    } else if (
      i + 3 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    ) {
      startCodes.push({ offset: i, length: 4 });
      i += 4;
    } else {
      i += 1;
    }
  }

  const nalus: Uint8Array[] = [];
  for (let i = 0; i < startCodes.length; i += 1) {
    const { offset, length } = startCodes[i]!;
    const nalStart = offset + length;
    const nalEnd = startCodes[i + 1]?.offset ?? data.length;
    if (nalEnd > nalStart) {
      nalus.push(data.subarray(nalStart, nalEnd));
    }
  }
  return nalus;
}

/** Extract the first SPS (NAL type 7) and PPS (NAL type 8) from an Annex-B buffer. */
export function extractSpsPps(data: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const nalu of splitAnnexBNalus(data)) {
    const nalType = nalu[0]! & 0x1f;
    if (nalType === 7 && nalu.byteLength >= 4 && !sps) {
      sps = nalu;
    } else if (nalType === 8 && nalu.byteLength >= 1 && !pps) {
      pps = nalu;
    }
    if (sps && pps) return { sps, pps };
  }
  return null;
}

/** Prepend cached Annex-B codec config (SPS/PPS) when an access unit lacks them. */
export function prependSpsPpsIfMissing(accessUnit: Uint8Array, codecConfig: Uint8Array): Uint8Array {
  if (codecConfig.byteLength === 0) return accessUnit;
  const existing = extractSpsPps(accessUnit);
  if (existing) return accessUnit;
  const needsStartCode =
    accessUnit.byteLength < 3 ||
    !(
      (accessUnit[0] === 0 && accessUnit[1] === 0 && accessUnit[2] === 1) ||
      (accessUnit.byteLength >= 4 && accessUnit[0] === 0 && accessUnit[1] === 0 && accessUnit[2] === 0 && accessUnit[3] === 1)
    );
  const configHasTrailingStart = false;
  void configHasTrailingStart;
  const pad = needsStartCode ? 4 : 0;
  const out = new Uint8Array(codecConfig.byteLength + pad + accessUnit.byteLength);
  out.set(codecConfig, 0);
  if (needsStartCode) {
    out[codecConfig.byteLength] = 0;
    out[codecConfig.byteLength + 1] = 0;
    out[codecConfig.byteLength + 2] = 0;
    out[codecConfig.byteLength + 3] = 1;
  }
  out.set(accessUnit, codecConfig.byteLength + pad);
  return out;
}

/**
 * Build an ISO/IEC 14496-15 AVCDecoderConfigurationRecord (`avcC`) for WebCodecs
 * `VideoDecoder.configure({ codec, description })`. Required on macOS WKWebView /
 * Safari WebKit H.264 decoders.
 */
export function buildAvcDecoderConfigurationRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  if (sps.byteLength < 4 || pps.byteLength < 1) {
    throw new Error('Invalid SPS/PPS lengths for avcC record');
  }
  const out = new Uint8Array(11 + sps.byteLength + pps.byteLength);
  out[0] = 0x01; // configurationVersion
  out[1] = sps[1]!; // AVCProfileIndication
  out[2] = sps[2]!; // profile_compatibility
  out[3] = sps[3]!; // AVCLevelIndication
  out[4] = 0xff; // 6 bits reserved (1) + lengthSizeMinusOne (3 -> 4 bytes)
  out[5] = 0xe1; // 3 bits reserved (1) + numOfSequenceParameterSets (1)
  out[6] = (sps.byteLength >>> 8) & 0xff;
  out[7] = sps.byteLength & 0xff;
  out.set(sps, 8);
  const ppsOffset = 8 + sps.byteLength;
  out[ppsOffset] = 0x01; // numOfPictureParameterSets
  out[ppsOffset + 1] = (pps.byteLength >>> 8) & 0xff;
  out[ppsOffset + 2] = pps.byteLength & 0xff;
  out.set(pps, ppsOffset + 3);
  return out;
}

/** Convert an Annex-B access unit into 4-byte length-prefixed AVCC sample bytes. */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  const allNalus = splitAnnexBNalus(data);
  if (allNalus.length === 0) return data;
  // Strip SPS (7), PPS (8), and AUD (9) parameter sets once supplied out-of-band in avcC description,
  // provided slice/SEI NAL units remain in the access unit.
  const sliceNalus = allNalus.filter((nalu) => {
    const t = nalu[0]! & 0x1f;
    return t !== 7 && t !== 8 && t !== 9;
  });
  const selected = sliceNalus.length > 0 ? sliceNalus : allNalus;
  const totalBytes = selected.reduce((sum, nalu) => sum + 4 + nalu.byteLength, 0);
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const nalu of selected) {
    view.setUint32(offset, nalu.byteLength >>> 0, false);
    offset += 4;
    out.set(nalu, offset);
    offset += nalu.byteLength;
  }
  return out;
}

/** Extract an RFC 6381 AVC codec identifier from an Annex-B SPS NAL unit. */
export function h264CodecFromAnnexB(data: Uint8Array): string | null {
  for (const nalu of splitAnnexBNalus(data)) {
    if (nalu.byteLength < 4 || (nalu[0]! & 0x1f) !== 7) continue;
    const profile = nalu[1]!;
    const constraints = nalu[2]!;
    const level = nalu[3]!;
    return `avc1.${[profile, constraints, level].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

export const avcCodecStringFromAnnexB = h264CodecFromAnnexB;
