// Per-model cost table for every creature .glb the game can spawn.
// Usage: node scripts/creature-cost.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { statSync } from 'node:fs';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const FILES = process.argv.slice(2);

const rows = [];
for (const file of FILES) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  let tris = 0;
  let verts = 0;
  const mats = new Set();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += Math.round((idx ? idx.getCount() : pos.getCount()) / 3);
      verts += pos ? pos.getCount() : 0;
      const m = prim.getMaterial();
      if (m) mats.add(m.getName() || '(unnamed)');
    }
  }
  let texKB = 0;
  for (const t of root.listTextures()) {
    const img = t.getImage();
    if (img) texKB += img.byteLength / 1024;
  }
  rows.push({
    file: file.replace(/\\/g, '/').replace(/^assets\//, ''),
    tris,
    verts,
    mats: mats.size,
    bones: root.listSkins().reduce((s, k) => s + k.listJoints().length, 0),
    clips: root.listAnimations().length,
    texKB: Math.round(texKB),
    diskKB: Math.round(statSync(file).size / 1024),
  });
}

rows.sort((a, b) => b.tris - a.tris);
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
console.log(
  pad('model', 52) + rpad('tris', 8) + rpad('verts', 8) + rpad('mats', 6) +
  rpad('bones', 7) + rpad('clips', 7) + rpad('texKB', 8) + rpad('diskKB', 8),
);
console.log('-'.repeat(104));
for (const r of rows) {
  console.log(
    pad(r.file, 52) + rpad(r.tris, 8) + rpad(r.verts, 8) + rpad(r.mats, 6) +
    rpad(r.bones, 7) + rpad(r.clips, 7) + rpad(r.texKB, 8) + rpad(r.diskKB, 8),
  );
}
