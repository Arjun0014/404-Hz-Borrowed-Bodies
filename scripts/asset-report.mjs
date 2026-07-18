// Asset report: inspects .glb files against the project performance budget.
// Usage: npm run asset-report [-- path/to/file.glb]  (defaults to all of assets/)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspect } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// Per-asset ceilings from IMPLEMENTATION_PLAN.md §3.1
const BUDGETS = {
  schoolFish: { tris: 800, materials: 1, bones: 0 },
  creature: { tris: 8000, materials: 2, bones: 40, texSize: 1024 },
  hero: { tris: 20000, materials: 3, bones: 60, texSize: 2048 },
  boss: { tris: 60000, materials: 6, bones: 120, texSize: 2048 },
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync('assets')
      .filter((f) => f.toLowerCase().endsWith('.glb'))
      .map((f) => join('assets', f));

for (const file of files) {
  const sizeMB = (statSync(file).size / 1024 / 1024).toFixed(2);
  const doc = await io.read(file);
  const report = inspect(doc);

  let tris = 0;
  for (const m of report.meshes.properties) tris += m.glPrimitives;
  const bones = doc
    .getRoot()
    .listSkins()
    .reduce((n, s) => Math.max(n, s.listJoints().length), 0);

  console.log(`\n=== ${basename(file)} (${sizeMB} MB) ===`);
  console.log(`extensions: ${doc.getRoot().listExtensionsUsed().map((e) => e.extensionName).join(', ') || 'none'}`);
  console.log(`triangles: ${tris}`);
  console.log(`meshes: ${report.meshes.properties.length}, materials: ${report.materials.properties.length}`);
  console.log(`max bones in a skin: ${bones}`);
  for (const t of report.textures.properties) {
    console.log(`texture: ${t.name || '(unnamed)'} ${t.resolution} ${t.mimeType} gpuSize=${(t.gpuSize / 1024 / 1024).toFixed(1)}MB`);
  }
  for (const a of report.animations.properties) {
    console.log(`animation: "${a.name}" ${a.channels} channels, ${a.keyframes} keyframes`);
  }
  if (report.animations.properties.length === 0) console.log('animation: NONE (procedural fallback will be used)');

  const b = BUDGETS.creature;
  if (tris > b.tris) console.log(`!! WARNING: ${tris} tris exceeds standard-creature budget (${b.tris})`);
  if (bones > b.bones) console.log(`!! WARNING: ${bones} bones exceeds standard-creature budget (${b.bones})`);
  if (report.materials.properties.length > b.materials)
    console.log(`!! WARNING: ${report.materials.properties.length} materials exceeds budget (${b.materials})`);
}
