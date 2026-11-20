/**
 * Trace the brand mark into an SVG path.
 *
 * The brand sheet ships as a raster (the artwork was drawn and exported as
 * PNG). App icons, social cards and store listings only need bitmaps, but the
 * web UI, the favicon and the Android monochrome layer want a vector. Rather
 * than hand-drawing an approximation, this module recovers the outline from the
 * artwork's alpha channel with marching squares and simplifies it (Ramer-
 * Douglas-Peucker), then re-rasterises the result to prove the traced path
 * still covers the original shape.
 *
 * Runs under `node scripts/build-brand-assets.mjs`; requires ImageMagick on the
 * maintainer machine only. Nothing in CI depends on it — the generated files are
 * committed.
 */
import { execFileSync } from 'node:child_process';

/** Read a PNG's alpha channel as a binary mask at `width` pixels wide. */
export function alphaMask(pngPath, width) {
  const size = execFileSync('identify', ['-format', '%w %h', pngPath], { encoding: 'utf8' }).trim();
  const [w, h] = size.split(' ').map(Number);
  const targetH = Math.round((h * width) / w);
  const raw = execFileSync(
    'convert',
    [pngPath, '-resize', `${width}x`, '-alpha', 'extract', '-threshold', '50%', '-depth', '8', 'gray:-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (raw.length !== width * targetH) {
    throw new Error(`expected ${width * targetH} mask bytes, got ${raw.length}`);
  }
  const mask = new Uint8Array(width * targetH);
  for (let i = 0; i < mask.length; i += 1) mask[i] = raw[i] > 127 ? 1 : 0;
  return { mask, width, height: targetH };
}

/**
 * Marching squares over a binary mask. Returns closed contours in pixel
 * coordinates (corner-based, so cells span [x, x+1] x [y, y+1]).
 */
export function traceContours({ mask, width, height }) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x]);
  const key = (p) => `${p[0]},${p[1]}`;
  const next = new Map();

  // Edge midpoints, keyed by global coordinates so that the east edge of one
  // cell and the west edge of its neighbour are the same node and the segments
  // chain into closed loops.
  const N = (x, y) => [x + 0.5, y];
  const E = (x, y) => [x + 1, y + 0.5];
  const S = (x, y) => [x + 0.5, y + 1];
  const W = (x, y) => [x, y + 0.5];

  // Every crossed cell yields one or two segments plus the covered corner(s),
  // which are used to orient the segment: walking with the covered side on the
  // left makes the two segments meeting at each midpoint agree on direction.
  const segments = [];
  for (let y = -1; y <= height; y += 1) {
    for (let x = -1; x <= width; x += 1) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const code = tl | (tr << 1) | (br << 2) | (bl << 3);
      const TL = [x, y];
      const TR = [x + 1, y];
      const BR = [x + 1, y + 1];
      const BL = [x, y + 1];
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      switch (code) {
        case 1: segments.push([W(x, y), N(x, y), TL]); break;
        case 2: segments.push([N(x, y), E(x, y), TR]); break;
        case 3: segments.push([W(x, y), E(x, y), mid(TL, TR)]); break;
        case 4: segments.push([E(x, y), S(x, y), BR]); break;
        case 5: segments.push([W(x, y), N(x, y), TL], [E(x, y), S(x, y), BR]); break;
        case 6: segments.push([N(x, y), S(x, y), mid(TR, BR)]); break;
        case 7: segments.push([S(x, y), W(x, y), mid(BR, BL)]); break;
        case 8: segments.push([S(x, y), W(x, y), BL]); break;
        case 9: segments.push([N(x, y), S(x, y), mid(TL, BL)]); break;
        case 10: segments.push([N(x, y), E(x, y), TR], [S(x, y), W(x, y), BL]); break;
        case 11: segments.push([E(x, y), S(x, y), mid(TR, BR)]); break;
        case 12: segments.push([E(x, y), W(x, y), mid(BL, BR)]); break;
        case 13: segments.push([N(x, y), E(x, y), mid(TL, TR)]); break;
        case 14: segments.push([W(x, y), N(x, y), mid(TL, BL)]); break;
      }
    }
  }

  for (const [a, b, inside] of segments) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const cross = dx * (inside[1] - a[1]) - dy * (inside[0] - a[0]);
    // Screen coordinates: y grows downwards, so cross < 0 keeps the covered
    // side on the left of travel.
    const [from, to] = cross < 0 ? [a, b] : [b, a];
    if (!next.has(key(from))) next.set(key(from), to);
  }

  const contours = [];
  const seen = new Set();
  for (const startKey of next.keys()) {
    if (seen.has(startKey)) continue;
    const contour = [];
    let cursor = startKey;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const [cx, cy] = cursor.split(',').map(Number);
      contour.push([cx, cy]);
      cursor = next.has(cursor) ? key(next.get(cursor)) : undefined;
    }
    if (contour.length >= 4) contours.push(contour);
  }
  return contours;
}

/** Ramer-Douglas-Peucker simplification for a closed contour. */
export function simplify(contour, epsilon) {
  if (contour.length < 4) return contour;
  const sqDist = (p, a, b) => {
    let x = a[0];
    let y = a[1];
    let dx = b[0] - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
  };
  const rdp = (points) => {
    if (points.length < 3) return points;
    let index = -1;
    let maxDist = 0;
    const [first, last] = [points[0], points[points.length - 1]];
    for (let i = 1; i < points.length - 1; i += 1) {
      const d = sqDist(points[i], first, last);
      if (d > maxDist) { index = i; maxDist = d; }
    }
    if (maxDist <= epsilon * epsilon) return [first, last];
    return [...rdp(points.slice(0, index + 1)).slice(0, -1), ...rdp(points.slice(index))];
  };
  // Split the closed contour at two far-apart points so RDP has stable anchors.
  let far = 0;
  let farDist = 0;
  for (let i = 1; i < contour.length; i += 1) {
    const d = sqDist(contour[i], contour[0], contour[0]);
    if (d > farDist) { farDist = d; far = i; }
  }
  const head = rdp([...contour.slice(0, far + 1), contour[0]]);
  const tail = rdp([...contour.slice(far), contour[0]]);
  return [...head.slice(0, -1), ...tail.slice(0, -1)];
}

/** Rasterise contours with the even-odd rule; used to self-check the trace. */
export function rasteriseContours(contours, width, height) {
  const out = new Uint8Array(width * height);
  const edges = [];
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i += 1) {
      const a = contour[i];
      const b = contour[(i + 1) % contour.length];
      edges.push([a[0], a[1], b[0], b[1]]);
    }
  }
  for (let y = 0; y < height; y += 1) {
    const scan = y + 0.5;
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if (y1 === y2) continue;
      const yMin = Math.min(y1, y2);
      const yMax = Math.max(y1, y2);
      if (scan < yMin || scan >= yMax) continue;
      xs.push(x1 + ((scan - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.round(xs[i]));
      const to = Math.min(width, Math.round(xs[i + 1]));
      for (let x = from; x < to; x += 1) out[y * width + x] = 1;
    }
  }
  return out;
}

export function iou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) inter += 1;
    if (a[i] || b[i]) union += 1;
  }
  return union === 0 ? 1 : inter / union;
}

/** Trace an image's alpha into a single even-odd `<path d="...">` string. */
export function traceMarkPath(pngPath, { width = 512, epsilon = 0.9 } = {}) {
  const grid = alphaMask(pngPath, width);
  const raw = traceContours(grid);
  const simplified = raw.map((contour) => simplify(contour, epsilon)).filter((c) => c.length >= 3);
  const rendered = rasteriseContours(simplified, grid.width, grid.height);
  const score = iou(rendered, grid.mask);
  const d = simplified
    .map((contour) => {
      const points = contour.map(([x, y]) => `${round(x)},${round(y)}`);
      return `M${points.join('L')}Z`;
    })
    .join('');
  return { d, score, width: grid.width, height: grid.height, contours: simplified.length };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
