// Encode PBR source maps (JPG/PNG) to GPU-compressed KTX2 (Basis UASTC + Zstd
// supercompression, with mipmaps). UASTC is near-lossless, so the runtime gets
// ~4x smaller VRAM (BC7/ASTC stays compressed on the GPU) with no noticeable
// quality drop.
//
// Usage: node scripts/encode-ktx2.mjs            (every set below)
//        node scripts/encode-ktx2.mjs lichen_rock  (one set, by folder name)
import { encodeToKTX2 } from 'ktx2-encoder';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every PBR set the game ships. Each folder holds a `textures/` directory of
 * sources and gets a sibling `ktx2/` directory of encoded output; the runtime
 * only ever imports from `ktx2/`.
 */
const SETS = [
  { dir: 'assets/textures/coast_sand_rocks_02_1k', prefix: 'coast_sand_rocks_02' },
  { dir: 'assets/textures/lichen_rock_1k', prefix: 'lichen_rock' },
  // The Fallen Kingdom's own pair: coursed masonry for everything that was
  // BUILT, and a hard fractured rock for the cavern it was built inside.
  { dir: 'assets/textures/castle_wall_slates_1k', prefix: 'castle_wall_slates' },
  { dir: 'assets/textures/aerial_rocks_04_1k', prefix: 'aerial_rocks_04' },
];

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

/** The four maps every set provides, with the right encoder profile for each. */
function jobsFor(prefix) {
  return [
    { in: `${prefix}_diff_1k.jpg`, opts: COLOR },
    { in: `${prefix}_nor_gl_1k.png`, opts: NORMAL },
    { in: `${prefix}_arm_1k.png`, opts: DATA },
    { in: `${prefix}_disp_1k.png`, opts: DATA },
  ].map((j) => ({ ...j, out: j.in.replace(/\.(jpg|png)$/, '.ktx2') }));
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const only = process.argv[2];
let srcTotal = 0;
let outTotal = 0;

for (const set of SETS) {
  if (only && !set.dir.includes(only) && set.prefix !== only) continue;
  const srcDir = join(set.dir, 'textures');
  const outDir = join(set.dir, 'ktx2');
  mkdirSync(outDir, { recursive: true });
  console.log(`\n== ${set.prefix} ==`);

  for (const job of jobsFor(set.prefix)) {
    const srcPath = join(srcDir, job.in);
    let srcBuf;
    try {
      srcBuf = readFileSync(srcPath);
    } catch {
      console.log(`${job.in.padEnd(34)}   (missing, skipped)`);
      continue;
    }
    const srcSize = statSync(srcPath).size;
    const t0 = Date.now();
    const ktx2 = await encodeToKTX2(new Uint8Array(srcBuf), job.opts);
    writeFileSync(join(outDir, job.out), ktx2);
    const outSize = ktx2.byteLength;
    srcTotal += srcSize;
    outTotal += outSize;
    console.log(
      `${job.in.padEnd(34)} ${kb(srcSize).padStart(9)}  ->  ${kb(outSize).padStart(9)}` +
        `   (${((outSize / srcSize) * 100).toFixed(0)}%, ${Date.now() - t0}ms)`,
    );
  }
}

console.log('-'.repeat(72));
console.log(`TOTAL on disk${''.padEnd(21)} ${kb(srcTotal).padStart(9)}  ->  ${kb(outTotal).padStart(9)}`);
