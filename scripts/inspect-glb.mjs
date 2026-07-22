// Temporary asset inspector: dumps every mesh node in a .glb with its world-space
// size, so zone code can key on real node names and place pieces at real scale.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import path from 'node:path';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

function mul(m, v) {
  // column-major 4x4 * vec3(point)
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}
function compose(t, r, s) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function mmul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  console.log(`\n=== ${path.basename(file)} ===`);
  let total = 0;
  const rows = [];
  const walk = (node, parent) => {
    const world = mmul(parent, compose(node.getTranslation(), node.getRotation(), node.getScale()));
    const mesh = node.getMesh();
    if (mesh) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      let tris = 0;
      const mats = new Set();
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        tris += (idx ? idx.getCount() : pos.getCount()) / 3;
        const m = prim.getMaterial();
        if (m) mats.add(m.getName() || '(unnamed)');
        for (let i = 0; i < pos.getCount(); i++) {
          const p = mul(world, pos.getElement(i, [0, 0, 0]));
          for (let k = 0; k < 3; k++) {
            if (p[k] < min[k]) min[k] = p[k];
            if (p[k] > max[k]) max[k] = p[k];
          }
        }
      }
      total += tris;
      rows.push({
        name: node.getName() || mesh.getName() || '(unnamed)',
        tris: Math.round(tris),
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        mats: [...mats].join(','),
      });
    }
    for (const child of node.listChildren()) walk(child, world);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const scene of doc.getRoot().listScenes())
    for (const node of scene.listChildren()) walk(node, I);

  rows.sort((a, b) => b.tris - a.tris);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(42)} ${String(r.tris).padStart(7)}t  ` +
        `${r.size.map((v) => v.toFixed(1).padStart(7)).join(' x ')}   [${r.mats}]`,
    );
  }
  console.log(`-- ${rows.length} meshes, ${Math.round(total)} tris total`);
  const texes = doc.getRoot().listTextures().map((t) => `${t.getName() || '?'}(${t.getMimeType()})`);
  console.log(`-- materials: ${doc.getRoot().listMaterials().map((m) => m.getName() || '?').join(', ')}`);
  console.log(`-- textures: ${texes.join(', ') || 'none'}`);
}
