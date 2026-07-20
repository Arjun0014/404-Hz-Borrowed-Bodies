import {
  Box3,
  type BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RockPack, type RockPiece } from './RockPack';
import { CAVE, type CaveTerrain } from './CaveTerrain';
import type { AssetLoaderLike, CylinderCollider } from './types';

import rockPackUrl from '../../assets/drowned garden/bone_rock_collection_pack.glb?url';
import dinoBonesUrl from '../../assets/drowned garden/stylized_dinosaur_bones_asset_pack.glb?url';
import boneChillerUrl from '../../assets/drowned garden/bone_chiller_statue.glb?url';
import algae1Url from '../../assets/drowned garden/algae_verylowpoly_1.glb?url';
import algae2Url from '../../assets/drowned garden/algae_verylowpoly_2.glb?url';
import seaweed1Url from '../../assets/drowned garden/seaweed_verylowpoly.glb?url';
import seaweed2Url from '../../assets/drowned garden/seaweed_2.glb?url';
import luminescentUrl from '../../assets/luminescent_plants.glb?url';
import marinePlantUrl from '../../assets/lowpoly_marine_plant.glb?url';

/**
 * The Drowned Garden's content: rock, bone, and growth.
 *
 * Composed as PLACES, not as a scatter. The cavern is a handful of distinct
 * sites you can navigate by — a ring of standing stones, a bone graveyard, a
 * statue on the north wall, a kelp bowl — separated by open water and sparse
 * ambient dressing. An even scatter across the floor was the previous approach
 * and it produced a uniform carpet with nothing to steer toward and nothing to
 * remember; density everywhere reads as density nowhere.
 *
 * Two rules keep it affordable:
 *  - Vegetation is ALPHA-TESTED, never alpha-blended (see makePlantMaterial).
 *  - Rock is merged per material per chunk; plants stay instanced.
 */

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UP = new Vector3(0, 1, 0);
const XAXIS = new Vector3(1, 0, 0);

/** Chunk edge for merged rock, metres — sized against the cave's ~200 m fog. */
const CHUNK = 300;

/**
 * The cavern's landmark sites. Positions are hand-placed to feel found rather
 * than gridded: they sit at varied distances and angles off the entrance axis,
 * none of them line up, and the gaps between them are deliberately empty so the
 * cavern breathes. Radii are the cleared "precinct" each one owns.
 */
type SiteKind = 'stonehenge' | 'graveyard' | 'statue' | 'archfield' | 'kelpbowl' | 'boulders' | 'glowgrove';
interface Site {
  kind: SiteKind;
  x: number;
  z: number;
  r: number;
}
const SITES: Site[] = [
  // The stone circle is the cavern's centrepiece and holds the Signal Carrier
  // in its middle, so it is by far the largest precinct.
  { kind: 'stonehenge', x: 150, z: -50, r: 118 },
  { kind: 'graveyard', x: 380, z: 200, r: 96 },
  { kind: 'statue', x: 20, z: -300, r: 70 },
  { kind: 'archfield', x: 420, z: -250, r: 78 },
  { kind: 'kelpbowl', x: -40, z: 190, r: 72 },
  { kind: 'boulders', x: 250, z: 340, r: 70 },
  { kind: 'glowgrove', x: 520, z: 60, r: 62 },
  { kind: 'boulders', x: -80, z: -160, r: 58 },
  { kind: 'glowgrove', x: 260, z: -370, r: 54 },
  { kind: 'kelpbowl', x: 480, z: 330, r: 60 },
  { kind: 'graveyard', x: 90, z: 330, r: 66 },
];

/** The stone circle's centre — the Signal Carrier stands here. */
export const HENGE_CENTRE = SITES[0];

export class GardenDressing {
  private readonly disposables: { dispose(): void }[] = [];
  private packs: RockPack[] = [];
  readonly colliders: CylinderCollider[] = [];
  tris = 0;
  drawCalls = 0;

  /**
   * Everything that belongs to the ENTRANCE. Held separately so it can be
   * hidden wholesale once the player is deep inside — from the back of the
   * cavern the mouth is 500 m away through fog and contributes nothing but
   * cost.
   */
  readonly entranceGroup = new Group();

  private readonly pending: { piece: RockPiece; matrix: Matrix4; chunk: number; tag: string }[] = [];

  constructor(
    private readonly group: Group,
    private readonly terrain: CaveTerrain,
  ) {
    this.entranceGroup.name = 'garden-entrance';
    this.group.add(this.entranceGroup);
  }

  async build(loader: AssetLoaderLike): Promise<void> {
    const [rocks, bones] = await Promise.all([
      RockPack.load(loader, rockPackUrl),
      RockPack.load(loader, dinoBonesUrl),
    ]);
    this.packs.push(rocks, bones);

    this.weatherBones(bones);
    this.buildEntrance(rocks);
    this.buildSites(rocks, bones);
    this.buildAmbientRock(rocks);
    this.flushMerged();
    await this.buildStatue(loader);
    await this.buildVegetation(loader);
  }

  /**
   * Age the dinosaur bones. They ship bright bleached white, which in a lightless
   * flooded cavern read as clean plastic props dropped on the floor — nothing
   * else in the zone is remotely that bright. Dulling them toward a damp
   * grey-brown and roughening the surface settles them into the silt.
   */
  private weatherBones(pack: RockPack): void {
    const done = new Set<string>();
    for (const piece of pack.pieces) {
      const mat = piece.material as MeshStandardMaterial;
      if (!mat || done.has(mat.uuid)) continue;
      done.add(mat.uuid);
      // Multiplies the diffuse map, so this darkens and yellows whatever the
      // texture already is rather than flattening it to a colour.
      mat.color = new Color(0.42, 0.39, 0.32);
      mat.roughness = 1;
      mat.metalness = 0;
    }
  }

  // ---- placement helpers --------------------------------------------------

  /** Queue a rock placement for merging. */
  private place(
    piece: RockPiece,
    x: number,
    z: number,
    size: number,
    rand: () => number,
    opts: { bury?: number; tilt?: number; solid?: boolean; yOverride?: number; yaw?: number } = {},
  ): void {
    const m = new Matrix4();
    const q = new Quaternion();
    const lean = new Quaternion();
    const scl = new Vector3();
    const p = new Vector3();

    if (this.inWhirlpool(x, z)) return; // never block the way out
    const floor = opts.yOverride ?? this.terrain.heightAt(x, z);
    scl.set(size, size * (0.85 + rand() * 0.4), size);
    q.setFromAxisAngle(UP, opts.yaw ?? rand() * Math.PI * 2);
    if (opts.tilt) {
      lean.setFromAxisAngle(XAXIS, (rand() - 0.5) * opts.tilt);
      q.multiply(lean);
    }
    p.set(x, floor - piece.unitHeight * scl.y * (opts.bury ?? 0.15), z);
    m.compose(p, q, scl);

    const cx = Math.floor((x - CAVE.minX) / CHUNK);
    const cz = Math.floor((z - CAVE.minZ) / CHUNK);
    this.pending.push({ piece, matrix: m, chunk: cz * 64 + cx, tag: 'i' });

    if (opts.solid) {
      this.colliders.push({ x, z, r: size * 0.4, top: floor + piece.unitHeight * scl.y * 0.8 });
    }
    this.tris += piece.tris;
  }

  /** True if (x,z) falls inside any site's precinct — used to keep ambient out. */
  private inAnySite(x: number, z: number, pad = 0): boolean {
    for (const s of SITES) {
      if (Math.hypot(x - s.x, z - s.z) < s.r + pad) return true;
    }
    return false;
  }

  /**
   * The whirlpool's basin must stay completely clear. Rocks and plants placed on
   * its slope were what the player kept snagging on trying to reach the exit.
   */
  private inWhirlpool(x: number, z: number): boolean {
    const w = CAVE.whirlpool;
    return Math.hypot(x - w.x, z - w.z) < w.radius * 3.8;
  }

  private get interior() {
    return {
      minX: CAVE.mouthX + CAVE.mouthThickness + 30,
      maxX: CAVE.maxX - 90,
      minZ: CAVE.minZ + 90,
      maxZ: CAVE.maxZ - 90,
    };
  }

  // ---- the entrance -------------------------------------------------------

  /** Rock framing the mouth, kept in its own group so it can be culled inside. */
  private buildEntrance(pack: RockPack): void {
    const rand = mulberry32(31337);
    const baseY = this.terrain.heightAt(CAVE.mouthX, 0);
    const halfW = CAVE.archHalfWidth;

    const archBottom = pack.get('BigArchBottom');
    const archTop = pack.get('BigArchTop');
    for (const side of [-1, 1]) {
      if (!archBottom) break;
      const mesh = new Mesh(archBottom.geometry, archBottom.material);
      mesh.name = 'entrance-jamb';
      const w = halfW * 0.8;
      mesh.scale.set(w, w * 1.15, w * 0.9);
      mesh.position.set(CAVE.mouthX - 10, baseY - 6, side * halfW * 0.95);
      mesh.rotation.y = side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      this.entranceGroup.add(mesh);
      this.tris += archBottom.tris;
      this.drawCalls++;
    }
    if (archTop) {
      const mesh = new Mesh(archTop.geometry, archTop.material);
      mesh.name = 'entrance-crown';
      const w = halfW * 1.4;
      mesh.scale.set(w, w * 0.65, w * 0.8);
      mesh.position.set(CAVE.mouthX - 8, baseY + CAVE.archHeight * 0.74, 0);
      this.entranceGroup.add(mesh);
      this.tris += archTop.tris;
      this.drawCalls++;
    }

    // Rubble bedded at the foot of the cliff, both sides. All ON the seabed —
    // the previous pass lifted some up the cliff face where, with the wall
    // rendering dark, they read as rocks hanging in open water.
    const rubble = [...pack.matching('SmallRock'), ...pack.matching('FlatRock')];
    const geos: BufferGeometry[] = [];
    const matByUuid = new Map<string, BufferGeometry[]>();
    for (const piece of rubble) {
      for (let i = 0; i < 7; i++) {
        const side = rand() < 0.5 ? -1 : 1;
        const z = side * halfW * (1.0 + rand() * 1.9);
        const x = CAVE.mouthX - CAVE.mouthThickness - 6 - rand() * 26;
        const size = 6 + rand() * rand() * 20;
        const geo = piece.geometry.clone();
        for (const n of Object.keys(geo.attributes)) {
          if (n !== 'position' && n !== 'normal' && n !== 'uv') geo.deleteAttribute(n);
        }
        const m = new Matrix4();
        const q = new Quaternion().setFromAxisAngle(UP, rand() * Math.PI * 2);
        const s = new Vector3(size, size * (0.7 + rand() * 0.6), size);
        m.compose(new Vector3(x, this.terrain.heightAt(x, z) - size * 0.18, z), q, s);
        geo.applyMatrix4(m);
        const key = piece.material.uuid;
        if (!matByUuid.has(key)) matByUuid.set(key, []);
        matByUuid.get(key)!.push(geo);
        geos.push(geo);
        this.tris += piece.tris;
      }
    }
    for (const [uuid, list] of matByUuid) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) continue;
      const mat = rubble.find((p) => p.material.uuid === uuid)!.material;
      const mesh = new Mesh(merged, mat);
      mesh.name = 'entrance-rubble';
      this.entranceGroup.add(mesh);
      this.disposables.push(merged);
      this.drawCalls++;
    }
    for (const g of geos) if (!this.disposables.includes(g)) g.dispose();
  }

  // ---- the landmark sites -------------------------------------------------

  private buildSites(rocks: RockPack, bones: RockPack): void {
    let seed = 700;
    for (const site of SITES) {
      const rand = mulberry32(seed++);
      switch (site.kind) {
        case 'stonehenge':
          this.siteStonehenge(site, rocks, rand);
          break;
        case 'graveyard':
          this.siteGraveyard(site, bones, rocks, rand);
          break;
        case 'archfield':
          this.siteArchField(site, rocks, rand);
          break;
        case 'boulders':
          this.siteBoulders(site, rocks, rand);
          break;
        case 'statue':
        case 'kelpbowl':
        case 'glowgrove':
          // These are defined by their vegetation / hero piece; the rock pass
          // only lays a light foundation of slabs so the ground reads as built.
          this.siteApron(site, rocks, rand);
          break;
      }
    }
  }

  /**
   * A ring of standing stones with lintels across the tallest pairs. The
   * cavern's most deliberate-looking place — it should read as something that
   * was raised, not something that fell.
   */
  private siteStonehenge(site: Site, pack: RockPack, rand: () => number): void {
    const p1 = pack.get('SinglePillar1');
    const p2 = pack.get('SinglePillar2');
    const lintel = pack.get('FlatRock2') ?? pack.get('FlatRock1');
    if (!p1 || !p2) return;

    const N = 14;
    const ringR = site.r * 0.72;
    const uprights: { x: number; z: number; size: number; top: number }[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + rand() * 0.08;
      const x = site.x + Math.cos(a) * ringR;
      const z = site.z + Math.sin(a) * ringR;
      const size = 26 + rand() * 20;
      const piece = i % 2 === 0 ? p1 : p2;
      // Face each stone toward the ring's centre, as a raised circle would be.
      this.place(piece, x, z, size, rand, { bury: 0.05, tilt: 0.04, solid: true, yaw: -a });
      uprights.push({ x, z, size, top: this.terrain.heightAt(x, z) + piece.unitHeight * size * 0.9 });
    }
    // Lintels bridging alternate pairs, laid flat and spanning the gap.
    if (lintel) {
      for (let i = 0; i < N; i += 2) {
        const a = uprights[i];
        const b = uprights[(i + 1) % N];
        const mx = (a.x + b.x) / 2;
        const mz = (a.z + b.z) / 2;
        const span = Math.hypot(b.x - a.x, b.z - a.z);
        this.place(lintel, mx, mz, span * 0.9, rand, {
          bury: 0,
          yOverride: Math.min(a.top, b.top),
          yaw: Math.atan2(b.x - a.x, b.z - a.z),
        });
      }
    }
    // A single fallen stone, for the story.
    this.place(p2, site.x + ringR * 0.55, site.z - ringR * 0.75, 30, rand, { bury: 0.4, tilt: 1.4 });
  }

  /** A bone field: the dino pack concentrated, half-buried, with rock debris. */
  private siteGraveyard(site: Site, bones: RockPack, rocks: RockPack, rand: () => number): void {
    for (const piece of bones.pieces) {
      // Ribcages and tails read as a scatter; skulls are the focal points.
      const focal = /Skull|Neck/.test(piece.name);
      const n = focal ? 3 : 7;
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * site.r * 0.85;
        const x = site.x + Math.cos(a) * r;
        const z = site.z + Math.sin(a) * r;
        const size = focal ? 16 + rand() * 18 : 8 + rand() * 14;
        this.place(piece, x, z, size, rand, { bury: focal ? 0.2 : 0.35, tilt: focal ? 0.2 : 0.7 });
      }
    }
    // A few slabs among the bones so it reads as ground, not a display case.
    for (const piece of rocks.matching('FlatRock')) {
      for (let i = 0; i < 3; i++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * site.r;
        this.place(piece, site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, 10 + rand() * 14, rand, {
          bury: 0.3,
          tilt: 0.2,
        });
      }
    }
  }

  /** Broken arches standing in a loose line, like a collapsed colonnade. */
  private siteArchField(site: Site, pack: RockPack, rand: () => number): void {
    const bottom = pack.get('BigArchBottom');
    const top = pack.get('BigArchTop');
    if (!bottom) return;
    const dir = rand() * Math.PI * 2;
    for (let i = 0; i < 5; i++) {
      const t = (i / 4 - 0.5) * site.r * 1.5;
      const x = site.x + Math.cos(dir) * t + (rand() - 0.5) * 14;
      const z = site.z + Math.sin(dir) * t + (rand() - 0.5) * 14;
      const size = 30 + rand() * 26;
      const standing = rand() < 0.6;
      this.place(standing ? bottom : (top ?? bottom), x, z, size, rand, {
        bury: standing ? 0.08 : 0.35,
        tilt: standing ? 0.06 : 1.1,
        solid: standing,
      });
    }
  }

  /** A tumble of boulders and slabs — a rockfall, not a pattern. */
  private siteBoulders(site: Site, pack: RockPack, rand: () => number): void {
    const pieces = [...pack.matching('SmallRock'), ...pack.matching('FlatRock')];
    for (const piece of pieces) {
      for (let i = 0; i < 4; i++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * site.r;
        // Sizes vary hard within a site so it never reads as one repeated prop.
        const size = 4 + rand() * rand() * 30;
        this.place(piece, site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, size, rand, {
          bury: 0.22,
          tilt: 0.35,
          solid: size > 20,
        });
      }
    }
  }

  /** A light foundation of slabs, for sites whose character is vegetation. */
  private siteApron(site: Site, pack: RockPack, rand: () => number): void {
    for (const piece of pack.matching('FlatRock')) {
      for (let i = 0; i < 3; i++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * site.r * 0.9;
        this.place(piece, site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, 8 + rand() * 20, rand, {
          bury: 0.34,
          tilt: 0.1,
        });
      }
    }
  }

  /**
   * Sparse rock BETWEEN the sites. Deliberately thin — this is the open water
   * that makes the sites read as places, so it only needs enough to stop the
   * floor looking swept.
   */
  private buildAmbientRock(pack: RockPack): void {
    const rand = mulberry32(4242);
    const area = this.interior;
    const pieces = [...pack.matching('SmallRock'), ...pack.matching('FlatRock')];
    for (const piece of pieces) {
      let placed = 0;
      for (let tries = 0; tries < 120 && placed < 9; tries++) {
        const x = area.minX + rand() * (area.maxX - area.minX);
        const z = area.minZ + rand() * (area.maxZ - area.minZ);
        if (this.inAnySite(x, z, 14)) continue;
        if (this.terrain.slopeAt(x, z) > 1.5) continue;
        this.place(piece, x, z, 3 + rand() * rand() * 16, rand, { bury: 0.24, tilt: 0.3 });
        placed++;
      }
    }
  }

  /** Bake queued rock into one merged mesh per material per chunk. */
  private flushMerged(): void {
    const groups = new Map<string, { material: Material; geos: BufferGeometry[] }>();
    for (const p of this.pending) {
      const key = `${p.chunk}|${p.piece.material.uuid}`;
      let g = groups.get(key);
      if (!g) {
        g = { material: p.piece.material, geos: [] };
        groups.set(key, g);
      }
      const geo = p.piece.geometry.clone();
      for (const n of Object.keys(geo.attributes)) {
        if (n !== 'position' && n !== 'normal' && n !== 'uv') geo.deleteAttribute(n);
      }
      geo.applyMatrix4(p.matrix);
      g.geos.push(geo);
    }
    for (const [key, g] of groups) {
      const merged = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false);
      if (g.geos.length > 1) for (const geo of g.geos) geo.dispose();
      if (!merged) continue;
      const mesh = new Mesh(merged, g.material);
      mesh.name = `rockchunk-${key.split('|')[0]}`;
      this.group.add(mesh);
      this.disposables.push(merged);
      this.drawCalls++;
    }
    this.pending.length = 0;
  }

  // ---- the statue ---------------------------------------------------------

  private async buildStatue(loader: AssetLoaderLike): Promise<void> {
    const site = SITES.find((s) => s.kind === 'statue')!;
    try {
      const gltf = await loader.loadGLB(boneChillerUrl);
      const model = gltf.scene;
      const holder = normalizeToLongest(model, 86);
      holder.position.set(site.x, this.terrain.heightAt(site.x, site.z) - 5, site.z);
      holder.rotation.y = Math.PI * 0.15;
      holder.name = 'bone-chiller-statue';
      this.group.add(holder);
      this.tris += countTris(model);
      this.drawCalls += countMeshes(model);
      this.colliders.push({
        x: site.x,
        z: site.z,
        r: 20,
        top: this.terrain.heightAt(site.x, site.z) + 60,
      });
    } catch (err) {
      console.warn('[404hz] bone chiller statue failed to load', err);
    }
  }

  // ---- vegetation ---------------------------------------------------------

  /**
   * Fix the plant materials before anything is placed with them.
   *
   * These models ship alpha-BLENDED (transparent, depthWrite off, double-sided).
   * With thousands of instances that is ruinous: no early-z rejection, so every
   * leaf fragment shades even when hidden behind rock; forced back-to-front
   * sorting; and double-sided doubling the fragment count again. It measured out
   * as 30-40 fps with stutter on movement.
   *
   * Leaf cutouts want alpha TESTING, not blending — an opaque draw that discards
   * transparent texels. That restores early-z and depth-write, removes sorting
   * entirely, and lets the plants render essentially for free.
   */
  private makePlantMaterial(src: MeshStandardMaterial, glow = false): MeshStandardMaterial {
    const mat = src.clone();
    mat.transparent = false;
    mat.alphaTest = 0.45;
    mat.depthWrite = true;
    if (glow) {
      // The luminescent plants are the cavern's only native light. Emissive
      // costs nothing (no extra lights, no shadows) and gives the glow groves a
      // real presence to navigate by in an otherwise unlit cave.
      mat.emissive = new Color(0x2fd8c0);
      mat.emissiveMap = mat.map;
      mat.emissiveIntensity = 2.4;
    }
    // Fronds are flat cards, so they do need both faces — but a single-sided
    // plant is invisible from behind, so this one stays.
    mat.side = DoubleSide;
    mat.roughness = 0.95;
    mat.metalness = 0;
    this.disposables.push(mat);
    return mat;
  }

  private async buildVegetation(loader: AssetLoaderLike): Promise<void> {
    // Far fewer plants, far wider size range, and clustered at sites rather
    // than carpeting the floor. The garden should be something you come across.
    // Counts are per-species and cost-aware. `home` is how many go at a site
    // that species belongs to, `fringe` how many trim every other site, and
    // `ambient` how many are scattered between them. These MUST scale inversely
    // with the model's triangle count: using one shared count put ~378
    // luminescent plants (26,367 tris each) in the cavern for 9.9M triangles.
    const specs = [
      { url: algae1Url, seed: 1101, home: 70, fringe: 12, ambient: 150, small: [2, 7], big: [14, 26], bigChance: 0.06 },
      { url: algae2Url, seed: 1102, home: 70, fringe: 12, ambient: 150, small: [2, 7], big: [14, 26], bigChance: 0.06 },
      { url: seaweed1Url, seed: 1103, home: 70, fringe: 12, ambient: 130, small: [3, 11], big: [22, 40], bigChance: 0.08 },
      { url: seaweed2Url, seed: 1104, home: 70, fringe: 12, ambient: 130, small: [3, 11], big: [22, 40], bigChance: 0.08 },
      { url: marinePlantUrl, seed: 1106, home: 6, fringe: 1, ambient: 14, small: [8, 18], big: [26, 40], bigChance: 0.25 },
      { url: luminescentUrl, seed: 1105, home: 2, fringe: 0, ambient: 4, small: [18, 30], big: [40, 62], bigChance: 0.4 },
    ];

    await Promise.all(
      specs.map(async (spec) => {
        try {
          const gltf = await loader.loadGLB(spec.url);
          gltf.scene.updateMatrixWorld(true);
          let src: Mesh | null = null;
          gltf.scene.traverse((o) => {
            const mesh = o as Mesh;
            if (!src && mesh.isMesh && mesh.geometry) src = mesh;
          });
          if (!src) return;
          const mesh = src as Mesh;
          const geo = mesh.geometry.clone();
          geo.applyMatrix4(mesh.matrixWorld);
          const box = new Box3().setFromBufferAttribute(geo.attributes.position as never);
          const size = box.getSize(new Vector3());
          const center = box.getCenter(new Vector3());
          const s = 1 / Math.max(size.y, 1e-4);
          geo.translate(-center.x, -box.min.y, -center.z);
          geo.scale(s, s, s);
          this.disposables.push(geo);

          const rawMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
          const mat = this.makePlantMaterial(rawMat, spec.url === luminescentUrl);
          const idx = geo.index;
          const per = Math.round((idx ? idx.count : (geo.attributes.position as { count: number }).count) / 3);
          this.plantSpecies(spec, geo, mat, per);
        } catch (err) {
          console.warn('[404hz] vegetation failed to load', spec.url, err);
        }
      }),
    );
  }

  /** Place one plant species: dense at its home sites, thin everywhere else. */
  private plantSpecies(
    spec: { seed: number; home: number; fringe: number; ambient: number; small: number[]; big: number[]; bigChance: number },
    geo: BufferGeometry,
    mat: MeshStandardMaterial,
    triPer: number,
  ): void {
    const rand = mulberry32(spec.seed);
    const placements: { m: Matrix4; c: Color }[] = [];
    const m = new Matrix4();
    const q = new Quaternion();
    const scl = new Vector3();
    const p = new Vector3();
    const area = this.interior;

    const put = (x: number, z: number, forceBig = false): void => {
      if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) return;
      if (this.inWhirlpool(x, z)) return;
      if (this.terrain.slopeAt(x, z) > 1.6) return;
      const big = forceBig || rand() < spec.bigChance;
      const range = big ? spec.big : spec.small;
      const h = range[0] + rand() * (range[1] - range[0]);
      scl.set(h, h, h);
      q.setFromAxisAngle(UP, rand() * Math.PI * 2);
      p.set(x, this.terrain.heightAt(x, z) - h * 0.03, z);
      m.compose(p, q, scl);
      const v = 0.45 + rand() * 0.7;
      placements.push({ m: m.clone(), c: new Color(v * 0.62, v, v * 0.78) });
    };

    // Home sites: kelp bowls and glow groves get real thickets; every other
    // site gets a light fringe so it looks lived-in without being buried.
    for (const site of SITES) {
      const home = site.kind === 'kelpbowl' || site.kind === 'glowgrove';
      const n = home ? spec.home : spec.fringe;
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * site.r * (home ? 0.95 : 1.15);
        put(site.x + Math.cos(a) * r, site.z + Math.sin(a) * r);
      }
      // Each home site gets a giant as its silhouette — but only for species
      // cheap enough to afford one, or the "hero plant" becomes the whole budget.
      if (home && spec.home > 4) {
        for (let i = 0; i < 2; i++) {
          const a = rand() * Math.PI * 2;
          const r = rand() * site.r * 0.4;
          put(site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, true);
        }
      }
    }

    // Sparse ambient, in small loose patches, avoiding the sites.
    let placedAmbient = 0;
    for (let tries = 0; tries < spec.ambient * 12 && placedAmbient < spec.ambient; tries++) {
      const cx = area.minX + rand() * (area.maxX - area.minX);
      const cz = area.minZ + rand() * (area.maxZ - area.minZ);
      if (this.inAnySite(cx, cz, 10)) continue;
      const clump = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < clump && placedAmbient < spec.ambient; k++) {
        put(cx + (rand() - 0.5) * 22, cz + (rand() - 0.5) * 22);
        placedAmbient++;
      }
    }

    if (placements.length === 0) return;
    // Chunked so distant thickets cull.
    const buckets = new Map<number, { m: Matrix4; c: Color }[]>();
    for (const pl of placements) {
      const x = pl.m.elements[12];
      const z = pl.m.elements[14];
      const key = Math.floor((z - CAVE.minZ) / CHUNK) * 64 + Math.floor((x - CAVE.minX) / CHUNK);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(pl);
    }
    for (const bucket of buckets.values()) {
      const im = new InstancedMesh(geo, mat, bucket.length);
      im.name = 'plant';
      for (let i = 0; i < bucket.length; i++) {
        im.setMatrixAt(i, bucket[i].m);
        im.setColorAt(i, bucket[i].c);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.group.add(im);
      this.drawCalls++;
    }
    this.tris += triPer * placements.length;
  }

  dispose(): void {
    for (const p of this.packs) p.dispose();
    this.packs.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.colliders.length = 0;
  }
}

// ---- helpers --------------------------------------------------------------

/** Wrap a model so its LONGEST axis is `size` metres, based at y=0. */
function normalizeToLongest(model: Object3D, size_: number): Object3D {
  const holder = new Object3D();
  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  const scale = size_ / Math.max(size.x, size.y, size.z, 1e-4);
  model.scale.setScalar(scale);
  const center = box.getCenter(new Vector3()).multiplyScalar(scale);
  model.position.set(-center.x, -box.min.y * scale, -center.z);
  // Hero props are viewed from all sides; front-face only is correct and halves
  // their fragment cost.
  model.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mm of mats as MeshStandardMaterial[]) if (mm) mm.side = FrontSide;
  });
  holder.add(model);
  return holder;
}

function countTris(root: Object3D): number {
  let t = 0;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const idx = mesh.geometry.index;
    t += (idx ? idx.count : (mesh.geometry.attributes.position as { count: number }).count) / 3;
  });
  return Math.round(t);
}

function countMeshes(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as Mesh).isMesh) n++;
  });
  return n;
}
