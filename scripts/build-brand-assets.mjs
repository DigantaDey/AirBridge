/**
 * Regenerate every AirBridge brand asset from the brand sheet artwork.
 *
 * Sources (committed, extracted from the brand sheet):
 *   assets/brand/mark.png     — the gradient mark, cut out with transparency
 *   assets/brand/wordmark.png — the "AirBridge" wordmark, cut out
 *
 * Outputs (all committed; CI never runs this script):
 *   public/icon.svg, website/icon.svg        — app tile (dark rounded square + mark)
 *   website/favicon-32.png                   — tile at favicon size
 *   website/apple-touch-icon.png             — full-bleed tile, 180px
 *   website/og.png                           — 1200x630 social card (mark + wordmark + screenshot)
 *   macos/AirBridge.icns                     — 128/256/512/1024 tile entries
 *   android/.../ic_launcher_foreground.xml   — traced vector mark, radial gradient
 *   android/.../values/colors.xml            — launcher background (brand navy)
 *   assets/brand/lockup-mono.svg             — one-colour lockup for docs/print
 *
 * The vector mark is traced from the raster artwork (scripts/brand/trace-mark.mjs)
 * and self-checked: the traced path is re-rasterised and must cover >= 98% of
 * the original shape (IoU) or the script fails.
 *
 * Requires ImageMagick (`convert`/`identify`) on the maintainer machine only.
 *
 * Usage: npm run brand:assets
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceMarkPath } from './brand/trace-mark.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'assets', 'brand');
const MARK_PNG = join(BRAND, 'mark.png');
const WORDMARK_PNG = join(BRAND, 'wordmark.png');
const TMP = join(tmpdir(), 'airbridge-brand');
mkdirSync(TMP, { recursive: true });

// Brand palette, sampled from the brand sheet.
const TILE = '#0F1222'; // dark navy app tile
const INK = '#111111'; // wordmark / monochrome
const GRADIENT_STOPS = [
  [0, '#7239e2'],
  [0.35, '#4227bb'],
  [0.55, '#1f3fbd'],
  [0.8, '#178fcb'],
  [1, '#6fe7df'],
];
const ANDROID_GRADIENT_START = '#7A3BF5';
const ANDROID_GRADIENT_END = '#35D6D6';

function im(args) {
  execFileSync('convert', args, { stdio: 'inherit' });
}

function pngSize(path) {
  const out = execFileSync('identify', ['-format', '%w %h', path], { encoding: 'utf8' }).trim();
  const [w, h] = out.split(' ').map(Number);
  return { w, h };
}

function assertSize(path, w, h) {
  const actual = pngSize(path);
  if (actual.w !== w || actual.h !== h) {
    throw new Error(`${path}: expected ${w}x${h}, got ${actual.w}x${actual.h}`);
  }
}

/** Scale/translate a traced `M..L..Z` path string. Coordinates alternate x,y. */
function scalePath(d, sx, sy, tx, ty) {
  let axis = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (match) => {
    const v = Number(match);
    const out = axis === 0 ? v * sx + tx : v * sy + ty;
    axis = 1 - axis;
    return String(Math.round(out * 10) / 10);
  });
}

function gradientDef(id) {
  const stops = GRADIENT_STOPS.map(
    ([offset, color]) => `      <stop offset="${offset}" stop-color="${color}"/>`,
  ).join('\n');
  return `    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">\n${stops}\n    </linearGradient>`;
}

// ---------------------------------------------------------------------------
// 1. Trace the mark and self-check it.
// ---------------------------------------------------------------------------
const traced = traceMarkPath(MARK_PNG, { width: 1024, epsilon: 1.0 });
console.log(`traced mark: ${traced.contours} contours, IoU ${traced.score.toFixed(4)}`);
if (traced.score < 0.98) {
  throw new Error(`traced mark only covers ${(traced.score * 100).toFixed(1)}% of the artwork`);
}

// ---------------------------------------------------------------------------
// 2. SVG app tile (public/icon.svg + website/icon.svg).
// ---------------------------------------------------------------------------
const TILE_SIZE = 512;
const TILE_MARK_WIDTH = 320;
const tileScale = TILE_MARK_WIDTH / traced.width;
const tileTx = (TILE_SIZE - TILE_MARK_WIDTH) / 2;
const tileTy = (TILE_SIZE - traced.height * tileScale) / 2;
const tilePath = scalePath(traced.d, tileScale, tileScale, tileTx, tileTy);

const tileSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}">
  <defs>
${gradientDef('mark')}
  </defs>
  <rect width="${TILE_SIZE}" height="${TILE_SIZE}" rx="112" fill="${TILE}"/>
  <path d="${tilePath}" fill="url(#mark)" fill-rule="evenodd"/>
</svg>
`;

for (const target of [join(ROOT, 'public', 'icon.svg'), join(ROOT, 'website', 'icon.svg')]) {
  writeFileSync(target, tileSvg);
  console.log(`wrote ${target}`);
}

// ---------------------------------------------------------------------------
// 3. One-colour lockup (mark over wordmark) for docs/print.
// ---------------------------------------------------------------------------
const lockupScale = 700 / traced.width;
const lockupPath = scalePath(traced.d, lockupScale, lockupScale, 15, 8);
const lockupSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 730 800">
  <path d="${lockupPath}" fill="${INK}" fill-rule="evenodd"/>
  <text x="365" y="748" text-anchor="middle" font-family="'Poppins','Montserrat','Segoe UI',system-ui,-apple-system,sans-serif" font-size="120" font-weight="600" fill="${INK}">AirBridge</text>
</svg>
`;
writeFileSync(join(BRAND, 'lockup-mono.svg'), lockupSvg);
console.log('wrote assets/brand/lockup-mono.svg');

// ---------------------------------------------------------------------------
// 4. In-app logo path module (imported by src/client/components/DeviceIcons).
// ---------------------------------------------------------------------------
{
  const stops = GRADIENT_STOPS.map(
    ([offset, color]) => `  { offset: ${offset}, color: '${color}' },`,
  ).join('\n');
  const mod = `/**
 * GENERATED by scripts/build-brand-assets.mjs from assets/brand/mark.png.
 * Do not edit by hand — re-run \`npm run brand:assets\`.
 */
export const AIRBRIDGE_MARK_PATH = '${traced.d}';
export const AIRBRIDGE_MARK_VIEWBOX = '0 0 ${traced.width} ${traced.height}';
export const AIRBRIDGE_MARK_GRADIENT_STOPS = [
${stops}
] as const;
`;
  const target = join(ROOT, 'src', 'client', 'components', 'brandMarkPath.ts');
  writeFileSync(target, mod);
  console.log(`wrote ${target}`);
}

// ---------------------------------------------------------------------------
// 5. Raster tiles: favicon, apple-touch-icon, icns entries.
// ---------------------------------------------------------------------------
function tilePng(size, out, { rounded = true } = {}) {
  const tile = join(TMP, `tile-${size}.png`);
  const r = Math.round(size * 0.22);
  if (rounded) {
    im(['-size', `${size}x${size}`, 'xc:none', '-fill', TILE, '-draw',
      `roundrectangle 0,0,${size - 1},${size - 1},${r},${r}`, tile]);
  } else {
    im(['-size', `${size}x${size}`, `xc:${TILE}`, tile]);
  }
  const markW = Math.round(size * 0.62);
  const markH = Math.round((markW * 624) / 730);
  const resized = join(TMP, `mark-${size}.png`);
  im([MARK_PNG, '-resize', `${markW}x`, resized]);
  const dx = Math.round((size - markW) / 2);
  const dy = Math.round((size - markH) / 2);
  im([tile, resized, '-geometry', `+${dx}+${dy}`, '-composite', out]);
  assertSize(out, size, size);
  console.log(`wrote ${out}`);
}

tilePng(32, join(ROOT, 'website', 'favicon-32.png'));
tilePng(180, join(ROOT, 'website', 'apple-touch-icon.png'), { rounded: false });

// ---------------------------------------------------------------------------
// 6. macOS .icns (PNG entries: ic07=128, ic08=256, ic09=512, ic10=1024).
// ---------------------------------------------------------------------------
const icnsEntries = [];
for (const [type, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
  const png = join(TMP, `icns-${size}.png`);
  tilePng(size, png);
  icnsEntries.push({ type, data: readFileSync(png) });
}
{
  const total = 8 + icnsEntries.reduce((sum, e) => sum + 8 + e.data.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  const parts = [header];
  for (const e of icnsEntries) {
    const h = Buffer.alloc(8);
    h.write(e.type, 0, 'ascii');
    h.writeUInt32BE(8 + e.data.length, 4);
    parts.push(h, e.data);
  }
  const icnsPath = join(ROOT, 'macos', 'AirBridge.icns');
  writeFileSync(icnsPath, Buffer.concat(parts));
  const back = readFileSync(icnsPath);
  if (back.toString('ascii', 0, 4) !== 'icns' || back.readUInt32BE(4) !== back.length) {
    throw new Error('icns self-check failed');
  }
  console.log(`wrote ${icnsPath} (${back.length} bytes)`);
}

// ---------------------------------------------------------------------------
// 7. Open Graph card: mark + wordmark + real screenshot on the sheet's paper.
// ---------------------------------------------------------------------------
{
  const og = join(TMP, 'og-base.png');
  const shot = join(TMP, 'og-shot.png');
  const mark = join(TMP, 'og-mark.png');
  const word = join(TMP, 'og-word.png');
  im(['-size', '1200x630', 'xc:#f7f7f7', og]);
  im([join(ROOT, 'website', 'screenshots', 'desktop-file-transfer.jpg'),
    '-resize', '570x', '-border', '1', '-bordercolor', '#d9dee6', shot]);
  im([MARK_PNG, '-resize', '150x', mark]);
  im([WORDMARK_PNG, '-resize', '450x', word]);
  const step1 = join(TMP, 'og-1.png');
  const step2 = join(TMP, 'og-2.png');
  const step3 = join(TMP, 'og-3.png');
  im([og, shot, '-geometry', '+590+143', '-composite', step1]);
  im([step1, mark, '-geometry', '+60+40', '-composite', step2]);
  im([step2, word, '-geometry', '+58+184', '-composite', step3]);
  const out = join(ROOT, 'website', 'og.png');
  im([step3,
    '-font', 'DejaVu-Sans-Bold', '-pointsize', '20', '-fill', '#2d6348',
    '-annotate', '+60+322', 'OPEN SOURCE · NO ACCOUNT · NO CLOUD',
    '-font', 'DejaVu-Sans', '-pointsize', '36', '-fill', '#17221e',
    '-annotate', '+60+372', 'Android to Mac, Windows',
    '-annotate', '+60+418', 'and Linux — privately.',
    '-pointsize', '26', '-fill', '#46564d',
    '-annotate', '+60+466', 'End-to-end encrypted file transfer,',
    '-annotate', '+60+502', 'clipboard sync and screen sharing.',
    '-font', 'DejaVu-Sans-Bold', '-pointsize', '24', '-fill', '#2d6348',
    '-annotate', '+60+566', 'airbridge.fyi',
    out]);
  assertSize(out, 1200, 630);
  console.log(`wrote ${out}`);
}

// ---------------------------------------------------------------------------
// 8. Android adaptive-icon foreground (vector) + background colour.
// ---------------------------------------------------------------------------
{
  const VIEW = 108;
  const MARK_W = 66;
  const s = MARK_W / traced.width;
  const tx = (VIEW - MARK_W) / 2;
  const ty = (VIEW - traced.height * s) / 2;
  const path = scalePath(traced.d, s, s, tx, ty);
  // Radial gradient in viewport space: violet over the mark's top arc,
  // cyan at the bottom-right tip.
  const cx = tx + 0.25 * MARK_W;
  const cy = ty + 0.15 * traced.height * s;
  const tipX = tx + 0.95 * MARK_W;
  const tipY = ty + 0.92 * traced.height * s;
  const radius = Math.round(Math.hypot(tipX - cx, tipY - cy));
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- AirBridge brand mark. Traced from assets/brand/mark.png by
     scripts/build-brand-assets.mjs; do not hand-edit the path data. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:pathData="${path}"
        android:fillType="evenOdd">
        <aapt:attr name="android:fillColor">
        <gradient
            android:type="radial"
            android:centerX="${Math.round(cx * 10) / 10}"
            android:centerY="${Math.round(cy * 10) / 10}"
            android:gradientRadius="${radius}"
            android:startColor="${ANDROID_GRADIENT_START}"
            android:endColor="${ANDROID_GRADIENT_END}" />
        </aapt:attr>
    </path>
</vector>
`;
  const target = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_launcher_foreground.xml');
  writeFileSync(target, xml);
  console.log(`wrote ${target}`);

  const colorsPath = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'colors.xml');
  const colors = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Brand navy from the app tile (assets/brand/README.md). -->
    <color name="ic_launcher_background">${TILE}</color>
</resources>
`;
  writeFileSync(colorsPath, colors);
  console.log(`wrote ${colorsPath}`);
}

console.log('brand assets regenerated.');
