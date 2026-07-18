import {
  Box3,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  type Scene,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '../config';
import type { AssetLoader } from '../core/AssetLoader';
import type { CylinderCollider, PopulationArea, TerrainLike } from './types';

import lowPolyPlantUrl from '../../assets/low-poly_plant.glb?url';
import lowPolyShrubUrl from '../../assets/low_poly_shrub.glb?url';
import lowpolyMarinePlantUrl from '../../assets/lowpoly_marine_plant.glb?url';
import marinePlantUrl from '../../assets/marine_plant.glb?url';
import luminescentPlantsUrl from '../../assets/luminescent_plants.glb?url';
import coral1Url from '../../assets/coral_1.glb?url';
import coral2Url from '../../assets/coral_2.glb?url';
import coralPieceUrl from '../../assets/coral_piece.glb?url';
import spikedRedCoralUrl from '../../assets/spiked_red_coral.glb?url';

/**
 * Global density dial for the whole seabed forest. Plant/coral counts scale with
 * this; bump it up for a denser jungle if the GPU has headroom, down if fps dips.
 */
export const FLORA_DENSITY = 2.0;

interface FloraKind {
  id: string;
  url: string;
  /** Base instance count (multiplied by FLORA_DENSITY). Fixed for big corals. */
  count: number;
  /** Target height range in meters (each instance scaled to a value in-range). */
  minH: number;
  maxH: number;
  /** Sway strength in meters at the tip; 0 = rigid (coral). */
  sway: number;
  /** Max terrain slope it will grow on. */
  slopeMax: number;
  /** Fraction of instances that clump into patches (rest are scattered). */
  cluster: number;
  /** Register each instance as a solid obstacle (big corals only). */
  collider?: boolean;
  /** Bioluminescent glow colour. */
  emissive?: number;
  emissiveIntensity?: number;
}

// The seabed forest. Cheap species get high counts (the carpet); heavy ones
// (luminescent 26k tris, big corals 7k) are kept sparse. All GPU-instanced, so
// each kind is ~1 draw call no matter the count.
// Heights span a wide ~5× range per kind (minH → maxH), so instances vary from
// small to several times larger. Uniform scale (scaling adds no triangles), with
// the giant corals capped below the water surface (y=45) so they don't poke through.
const KINDS: FloraKind[] = [
  // ---- dense plant carpet (the "forest") — cheapest per instance, kept high ----
  { id: 'lowplant', url: lowPolyPlantUrl, count: 2000, minH: 0.7, maxH: 3.6, sway: 0.18, slopeMax: 3.2, cluster: 0.7 },
  { id: 'shrub', url: lowPolyShrubUrl, count: 300, minH: 1.0, maxH: 5.2, sway: 0.12, slopeMax: 3.6, cluster: 0.6 },
  { id: 'marineLow', url: lowpolyMarinePlantUrl, count: 50, minH: 2.2, maxH: 11.0, sway: 0.3, slopeMax: 4.0, cluster: 0.5 },
  { id: 'marine', url: marinePlantUrl, count: 100, minH: 2.2, maxH: 12.0, sway: 0.32, slopeMax: 4.0, cluster: 0.5 },
  // ---- bioluminescent accents (26k tris each: keep sparse) ----
  { id: 'lumin', url: luminescentPlantsUrl, count: 7, minH: 2.6, maxH: 13.0, sway: 0.22, slopeMax: 5.0, cluster: 0.3, emissive: 0x2effe0, emissiveIntensity: 1.7 },
  // ---- corals: standard ~3× bigger, up to ~10× the small base (giant corals are
  //      auto-capped to the water column in scatter() so they stay under the surface) ----
  { id: 'coral2', url: coral2Url, count: 150, minH: 2.4, maxH: 8.0, sway: 0, slopeMax: 6.0, cluster: 0.6 },
  { id: 'spiked', url: spikedRedCoralUrl, count: 240, minH: 1.5, maxH: 5.0, sway: 0, slopeMax: 7.0, cluster: 0.7 },
  { id: 'coral1', url: coral1Url, count: 5, minH: 10.0, maxH: 30.0, sway: 0, slopeMax: 8.0, cluster: 0, collider: true },
  { id: 'coralPiece', url: coralPieceUrl, count: 6, minH: 8.0, maxH: 26.0, sway: 0, slopeMax: 8.0, cluster: 0, collider: true },
];

/** A merged geometry + its (cloned, possibly sway-enabled) material. */
interface FloraPart {
  geo: BufferGeometry;
  mat: Material;
}

/** A loaded, normalized flora model (base at y=0, centred in x/z). */
interface FloraTemplate {
  kind: FloraKind;
  parts: FloraPart[];
  /** Native height (m) before scaling — used to compute per-instance scale. */
  nativeH: number;
  /** Native horizontal radius (m) — used for collider size. */
  nativeR: number;
}

/**
 * The seabed forest: GPU-instanced plants and corals scattered across the shelf.
 * Loads each .glb once (templates persist across zones), then stamps thousands of
 * instances as a handful of draw calls. Plants sway with the current; big corals
 * become solid obstacles. Mirrors the Ecosystem's load-once / bind-per-zone shape.
 */
export class Flora {
  private readonly group = new Group();
  private readonly templates = new Map<string, FloraTemplate>();
  private readonly meshes: InstancedMesh[] = [];
  private readonly swayShaders: { uniforms: { uTime: { value: number } } }[] = [];
  private time = 0;
  private instanceCount = 0;

  constructor(
    private readonly loader: AssetLoader,
    scene: Scene,
  ) {
    this.group.name = 'flora';
    scene.add(this.group);
  }

  get count(): number {
    return this.instanceCount;
  }

  async load(): Promise<void> {
    await Promise.all(KINDS.map((k) => this.loadKind(k)));
  }

  private async loadKind(kind: FloraKind): Promise<void> {
    const gltf = await this.loader.loadGLB(kind.url);
    const template = this.prepare(gltf.scene, kind);
    if (template) this.templates.set(kind.id, template);
  }

  /** Merge a model's meshes (per material), normalize to base y=0, centred. */
  private prepare(root: Object3D, kind: FloraKind): FloraTemplate | null {
    root.updateMatrixWorld(true);
    const byMat = new Map<Material, BufferGeometry[]>();
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      }
      const list = byMat.get(mat) ?? [];
      list.push(g);
      byMat.set(mat, list);
    });
    if (byMat.size === 0) return null;

    // Measure the combined bounds to normalize placement.
    const box = new Box3();
    let first = true;
    const merged: { geo: BufferGeometry; srcMat: Material }[] = [];
    for (const [mat, geos] of byMat) {
      const m = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!m) continue;
      merged.push({ geo: m, srcMat: mat });
      m.computeBoundingBox();
      if (m.boundingBox) {
        if (first) {
          box.copy(m.boundingBox);
          first = false;
        } else {
          box.union(m.boundingBox);
        }
      }
    }
    if (merged.length === 0) return null;

    const size = new Vector3();
    box.getSize(size);
    const nativeH = Math.max(size.y, 1e-3);
    const nativeR = Math.max(size.x, size.z) * 0.5;
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;

    const parts: FloraPart[] = merged.map(({ geo, srcMat }) => {
      geo.translate(-cx, -box.min.y, -cz); // base on the seabed, centred
      return { geo, mat: this.makeMaterial(srcMat, kind, nativeH) };
    });
    return { kind, parts, nativeH, nativeR };
  }

  /** Clone the GLB material and add sway (plants) or glow (luminescent). */
  private makeMaterial(src: Material, kind: FloraKind, nativeH: number): Material {
    const base = src.clone() as MeshStandardMaterial;
    // Foliage/coral often use alpha-cutout leaf textures. Rendering them as
    // alpha-tested cutouts (not blended, not force-opaque) discards transparent
    // texels instead of drawing them as solid black quads, and sorts correctly.
    const hadAlpha = base.transparent || (base.alphaTest ?? 0) > 0 || !!base.alphaMap;
    if (kind.sway > 0 || hadAlpha) {
      base.alphaTest = Math.max(0.5, base.alphaTest ?? 0);
      base.side = DoubleSide; // thin fronds/leaves read from both sides
    }
    base.transparent = false;
    base.depthWrite = true;
    if (kind.emissive !== undefined) {
      base.emissive = new Color(kind.emissive);
      base.emissiveIntensity = kind.emissiveIntensity ?? 1.5;
      if (base.map && !base.emissiveMap) base.emissiveMap = base.map;
    }
    if (kind.sway > 0) this.applySway(base, kind.sway, nativeH);
    return base;
  }

  /** Inject a height-weighted sinusoidal sway into an instanced material. */
  private applySway(mat: MeshStandardMaterial, strength: number, nativeH: number): void {
    const H = nativeH.toFixed(3);
    const STR = strength.toFixed(3);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: this.time };
      this.swayShaders.push(shader as unknown as { uniforms: { uTime: { value: number } } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
          {
            vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
            float ph = ip.x * 0.37 + ip.y * 0.53;
            float f = clamp(position.y / ${H}, 0.0, 1.0);
            f = f * f;
            transformed.x += sin(uTime * 0.9 + ph) * ${STR} * f;
            transformed.z += cos(uTime * 0.72 + ph * 1.3) * ${STR} * f;
          }
          #endif
          `,
        );
    };
  }

  /** Build the forest for a zone's shelf. Pushes big-coral colliders in place. */
  bindZone(terrain: TerrainLike, area: PopulationArea, colliders: CylinderCollider[]): void {
    this.unbind();
    const rand = mulberry32(13337);
    for (const kind of KINDS) {
      const t = this.templates.get(kind.id);
      if (t) this.scatter(t, terrain, area, colliders, rand);
    }
  }

  private scatter(
    t: FloraTemplate,
    terrain: TerrainLike,
    area: PopulationArea,
    colliders: CylinderCollider[],
    rand: () => number,
  ): void {
    const kind = t.kind;
    const target = kind.collider ? kind.count : Math.round(kind.count * FLORA_DENSITY);
    const placements = this.placements(kind, terrain, area, target, rand);
    if (placements.length === 0) return;

    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const posV = new Vector3();

    // One InstancedMesh per material part; all parts share the same transforms
    // so multi-material models stay assembled.
    const meshes = t.parts.map((part) => {
      const mesh = new InstancedMesh(part.geo, part.mat, placements.length);
      mesh.frustumCulled = false; // instances span the whole shelf
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    });

    placements.forEach((pl, i) => {
      const gy = terrain.heightAt(pl.x, pl.z);
      // Never let a tall instance poke through the water surface: cap its height
      // to the water column at this spot (matters on high mesa tops).
      const headroom = WORLD.surfaceY - gy - 2;
      const h = Math.min(pl.h, Math.max(headroom, kind.minH * 0.5));
      const s = h / t.nativeH;
      scl.set(s * (0.9 + rand() * 0.2), s, s * (0.9 + rand() * 0.2));
      q.setFromAxisAngle(up, pl.yaw);
      posV.set(pl.x, gy - t.nativeH * s * 0.04, pl.z); // root just under the seabed
      m.compose(posV, q, scl);
      for (const mesh of meshes) mesh.setMatrixAt(i, m);
      if (kind.collider) {
        colliders.push({ x: pl.x, z: pl.z, r: Math.max(t.nativeR * s, 1.5), top: gy + h * 0.85 });
      }
    });

    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this.instanceCount += placements.length;
  }

  /** Pick valid shelf spots (slope-limited), mixing patches and open scatter. */
  private placements(
    kind: FloraKind,
    terrain: TerrainLike,
    area: PopulationArea,
    target: number,
    rand: () => number,
  ): { x: number; z: number; h: number; yaw: number }[] {
    const out: { x: number; z: number; h: number; yaw: number }[] = [];
    // Cluster seeds: dense patches of this kind for a patchy, natural forest.
    const seeds: { x: number; z: number }[] = [];
    const seedCount = Math.max(6, Math.round(target * 0.04));
    for (let i = 0; i < seedCount; i++) {
      seeds.push({
        x: area.minX + rand() * (area.maxX - area.minX),
        z: area.minZ + rand() * (area.maxZ - area.minZ),
      });
    }

    let guard = 0;
    while (out.length < target && guard < target * 8) {
      guard++;
      let x: number;
      let z: number;
      if (rand() < kind.cluster && seeds.length) {
        const s = seeds[Math.floor(rand() * seeds.length)];
        const a = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * (5 + rand() * 9);
        x = s.x + Math.cos(a) * rr;
        z = s.z + Math.sin(a) * rr;
      } else {
        x = area.minX + rand() * (area.maxX - area.minX);
        z = area.minZ + rand() * (area.maxZ - area.minZ);
      }
      if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) continue;
      if (terrain.slopeAt(x, z) > kind.slopeMax) continue;
      out.push({ x, z, h: kind.minH + rand() * (kind.maxH - kind.minH), yaw: rand() * Math.PI * 2 });
    }
    return out;
  }

  update(dt: number): void {
    this.time += dt;
    for (const s of this.swayShaders) s.uniforms.uTime.value = this.time;
  }

  /** Tear down the current zone's instances (templates persist). */
  unbind(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.dispose(); // frees instance buffers, not the shared geometry/material
    }
    this.meshes.length = 0;
    this.swayShaders.length = 0;
    this.instanceCount = 0;
  }

  dispose(): void {
    this.unbind();
    for (const t of this.templates.values()) {
      for (const part of t.parts) {
        part.geo.dispose();
        const mat = part.mat as MeshStandardMaterial;
        mat.map?.dispose();
        mat.normalMap?.dispose();
        mat.emissiveMap?.dispose();
        mat.dispose();
      }
    }
    this.templates.clear();
    this.group.parent?.remove(this.group);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
