// Encode the seabed PBR source maps (JPG/PNG) to GPU-compressed KTX2 (Basis
// UASTC + Zstd supercompression, with mipmaps). UASTC is near-lossless, so the
// runtime gets ~4x smaller VRAM (BC7/ASTC stays compressed on the GPU) with no
// noticeable quality drop.
//
// Usage: node scripts/encode-ktx2.mjs
import { encodeToKTX2 } from 'ktx2-encoder';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = 'assets/textures/coast_sand_rocks_02_1k/textures';
const OUT_DIR = 'assets/textures/coast_sand_rocks_02_1k/ktx2';
mkdirSync(OUT_DIR, { recursive: true });

// Decode a JPG or PNG file buffer to raw RGBA (top-left first), as the Basis
// encoder wants for RAW slices.
function imageDecoder(buffer) {
  const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50;
  if (isPNG) {
    const png = PNG.sync.read(Buffer.from(buffer));
    return Promise.resolve({ width: png.width, height: png.height, data: png.data });
  }
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  return Promise.resolve({ width: img.width, height: img.height, data: img.data });
}

// Shared UASTC settings: high-quality pack, Zstd supercompression, mipmaps.
const base = {
  isUASTC: true,
  isKTX2File: true,
  generateMipmap: true,
  needSupercompression: true,
  uastcLDRQualityLevel: 3, // 0-4; 3 = high quality
  imageDecoder,
};

// diffuse = sRGB colour; the rest are linear data maps (no sRGB transfer).
const COLOR = { ...base, isPerceptual: true, isSetKTX2SRGBTransferFunc: true };
const DATA = { ...base, isPerceptual: false, isSetKTX2SRGBTransferFunc: false };
const NORMAL = { ...DATA, isNormalMap: true };

const jobs = [
  { in: 'coast_sand_rocks_02_diff_1k.jpg', out: 'coast_sand_rocks_02_diff_1k.ktx2', opts: COLOR },
  { in: 'coast_sand_rocks_02_nor_gl_1k.png', out: 'coast_sand_rocks_02_nor_gl_1k.ktx2', opts: NORMAL },
  { in: 'coast_sand_rocks_02_arm_1k.png', out: 'coast_sand_rocks_02_arm_1k.ktx2', opts: DATA },
  { in: 'coast_sand_rocks_02_disp_1k.png', out: 'coast_sand_rocks_02_disp_1k.ktx2', opts: DATA },
];

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
let srcTotal = 0;
let outTotal = 0;

for (const job of jobs) {
  const srcPath = join(SRC_DIR, job.in);
  const outPath = join(OUT_DIR, job.out);
  const srcBuf = readFileSync(srcPath);
  const srcSize = statSync(srcPath).size;
  const t0 = Date.now();
  const ktx2 = await encodeToKTX2(new Uint8Array(srcBuf), job.opts);
  writeFileSync(outPath, ktx2);
  const outSize = ktx2.byteLength;
  srcTotal += srcSize;
  outTotal += outSize;
  console.log(
    `${job.in.padEnd(34)} ${kb(srcSize).padStart(9)}  ->  ${kb(outSize).padStart(9)}` +
      `   (${((outSize / srcSize) * 100).toFixed(0)}%, ${Date.now() - t0}ms)`,
  );
}

console.log('-'.repeat(72));
console.log(`TOTAL on disk${''.padEnd(21)} ${kb(srcTotal).padStart(9)}  ->  ${kb(outTotal).padStart(9)}`);
