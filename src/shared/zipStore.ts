/**
 * Zero-dependency PKZIP Archive Builder (STORE mode, method 0).
 * Bundles multiple received files (or folder hierarchies) into a single .zip
 * in milliseconds without re-compressing already-compressed media (.jpg, .mp4, .pdf).
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(chunks: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.byteLength; i++) {
      crc = CRC32_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInputEntry {
  path: string; // e.g. "Photos/IMG_001.jpg" or "notes.txt"
  chunks: Uint8Array[];
  lastModified?: Date;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

export function buildZipArchiveParts(entries: ZipInputEntry[]): Uint8Array[] {
  const encoder = new TextEncoder();
  const outputParts: Uint8Array[] = [];
  const centralDirParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Strip drive/absolute prefixes and any '..' segments so a hostile
    // relativePath in a manifest cannot become a path-traversal entry when
    // the archive is extracted on the receiving device.
    const cleanPath = entry.path.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/') || 'file';
    const nameBytes = encoder.encode(cleanPath);
    const totalSize = entry.chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const checksum = crc32(entry.chunks);
    const { dosTime, dosDate } = toDosDateTime(entry.lastModified ?? new Date());

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // General purpose bit flag: UTF-8 filename
    lv.setUint16(8, 0, true); // Compression method: 0 = STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, totalSize, true); // Compressed size
    lv.setUint32(22, totalSize, true); // Uncompressed size
    lv.setUint16(26, nameBytes.byteLength, true);
    lv.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    const localHeaderOffset = offset;
    outputParts.push(localHeader);
    offset += localHeader.byteLength;

    for (const chunk of entry.chunks) {
      outputParts.push(chunk);
      offset += chunk.byteLength;
    }

    // Central directory file header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central file header signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 flag
    cv.setUint16(10, 0, true); // Method: STORE
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, totalSize, true);
    cv.setUint32(24, totalSize, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint16(30, 0, true); // Extra length
    cv.setUint16(32, 0, true); // Comment length
    cv.setUint16(34, 0, true); // Disk number
    cv.setUint16(36, 0, true); // Internal attrs
    cv.setUint32(38, 0, true); // External attrs
    cv.setUint32(42, localHeaderOffset, true);
    centralHeader.set(nameBytes, 46);

    centralDirParts.push(centralHeader);
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const cd of centralDirParts) {
    outputParts.push(cd);
    centralDirSize += cd.byteLength;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);
  ev.setUint16(20, 0, true);
  outputParts.push(eocd);

  return outputParts;
}
