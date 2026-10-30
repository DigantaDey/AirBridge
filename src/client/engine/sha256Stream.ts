/**
 * Incremental SHA-256.
 *
 * Web Crypto's `subtle.digest` requires the whole input in memory, which is
 * exactly what we are trying to avoid for a multi-gigabyte receive. This class
 * accepts data in arbitrary chunks and produces the same hex digest as
 * `crypto.subtle.digest('SHA-256', …)` for any total length, with a buffer
 * bounded to one 64-byte block.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export class Sha256Stream {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalBytes = 0;

  update(data: Uint8Array): void {
    this.totalBytes += data.byteLength;
    let offset = 0;

    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, data.byteLength);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen === 64) {
        this.compress(new DataView(this.block.buffer), 0);
        this.blockLen = 0;
      }
    }

    if (offset < data.byteLength) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      while (offset + 64 <= data.byteLength) {
        this.compress(view, offset);
        offset += 64;
      }
      if (offset < data.byteLength) {
        this.block.set(data.subarray(offset), 0);
        this.blockLen = data.byteLength - offset;
      }
    }
  }

  hex(): string {
    const bitLen = this.totalBytes * 8;
    // 0x80 terminator, then zero padding up to 56 bytes, then the 64-bit
    // big-endian original length.
    this.update(new Uint8Array([0x80]));
    while (this.blockLen !== 56) {
      this.update(new Uint8Array(1));
    }
    const lenBytes = new Uint8Array(8);
    const lenView = new DataView(lenBytes.buffer);
    lenView.setUint32(0, Math.floor(bitLen / 0x100000000));
    lenView.setUint32(4, bitLen >>> 0);
    this.update(lenBytes);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, this.h[i] >>> 0);
    }
    return Array.from(out)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private compress(view: DataView, offset: number): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let h = this.h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }
}

/** Hash a ReadableStream<Uint8Array> incrementally, returning hex SHA-256. */
export async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const sha = new Sha256Stream();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sha.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return sha.hex();
}
