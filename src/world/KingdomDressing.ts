import {
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { RockPack, type RockPiece } from './RockPack';
import { SHAFT, type ShaftTerrain } from './ShaftTerrain';
import type { AssetLoaderLike, CylinderCollider } from './types';

import columnUrl from '../../assets/fallen kingdom/column_compressed.glb?url';
import castleUrl from '../../assets/fallen kingdom/column_._column_with_arch._stone_column_compressed.glb?url';
import gemsLowUrl from '../../assets/fallen kingdom/gemstone_crystals_asset_pack_verylowpoly.glb?url';
import gemsMedUrl from '../../assets/fallen kingdom/stylized_crystal_gem_pack_mediumpoly.glb?url';
import bigCrystalUrl from '../../assets/fallen kingdom/stylized_crystal.glb?url';

/**
 * The Fallen Kingdom's content: structure, ruin, and crystal.
 *
 * Four colossal columns hold the walls of the well apart, floor to sky — the
 * things that convey the shaft's height from inside it. Around and between them,
 * the drowned architecture of a kingdom: a ring of broken columns, tumbled
 * blocks, ledges of collapsed floor hanging off the walls, and a pair of great
 * arches marking the relay precincts. Growing out of all of it, and clinging to
 * the walls at every height, crystal — placed in flowering bursts from single
 * points so it reads as living geode rather than scattered rock, and self-lit so
 * it is the only real colour in the deep.
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

/** The five crystal hues. Diffuse is a dark base; the glow is the emissive. */
const CRYSTAL_HUES = [
  0x9b5cff, // amethyst
  0x46d6ff, // cyan
  0xff5c8f, // rose
  0xffd166, // gold
  0x54ffb0, // emerald
];

/** A crystal cluster to instance: which shard shape, which hue, and its matrix. */
interface CrystalPlacement {
  shape: number;
  hue: number;
  m: Matrix4;
}

export class KingdomDressing {
  private readonly disposables: { dispose(): void }[] = [];
  private packs: RockPack[] = [];
  private crystalMats: MeshStandardMaterial[] = [];
  readonly colliders: CylinderCollider[] = [];
  tris = 0;
  drawCalls = 0;

  constructor(
    private readonly group: Group,
    private readonly terrain: ShaftTerrain,
  ) {}

  async build(loader: AssetLoaderLike): Promise<void> {
    const [column, castle, gemsLow, gemsMed, bigCrystal] = await Promise.all([
      RockPack.load(loader, columnUrl),
      RockPack.load(loader, castleUrl),
      RockPack.load(loader, gemsLowUrl),
      RockPack.load(loader, gemsMedUrl),
      RockPack.load(loader, bigCrystalUrl),
    ]);
    this.packs.push(column, castle, gemsLow, gemsMed, bigCrystal);

    this.buildSupportColumns(column);
    this.buildRuins(castle);
    this.buildCrystals(gemsLow);
    this.buildGemAccents(gemsMed);
    this.buildBigCrystals(bigCrystal);
  }

  // ---- the four colossal support columns ----------------------------------

  /**
   * Four giant columns spanning the whole well, floor to top. The single-piece
   * column model is only ~3.3× as tall as it is wide, so each support is a STACK
   * of several segments — that keeps the stone at a believable proportion instead
   * of one grotesquely stretched pillar, and the seams read as drum joints.
   */
  private buildSupportColumns(pack: RockPack): void {
    const piece = pack.pieces[0];
    if (!piece) return;
    const rand = mulberry32(8080);
    const ringR = SHAFT.radius * 0.66;
    const width = 30;
    const segH = piece.unitHeight * width; // ~100 m per segment
    const span = SHAFT.wallTop - (SHAFT.floorY - 20);
    const segs = Math.ceil(span / segH) + 1;

    const count = 4 * segs;
    const src = piece.material as MeshStandardMaterial;
    const mat = new MeshStandardMaterial({
      color: new Color(0x9aa4bc),
      map: src && src.map ? src.map : undefined,
      roughness: 0.9,
      metalness: 0,
      emissive: new Color(0x1a2138),
      emissiveIntensity: 0.7,
    });
    this.disposables.push(mat);
    const mesh = new InstancedMesh(piece.geometry, mat, count);
    mesh.name = 'kingdom-support';
    const m = new Matrix4();
    const q = new Quaternion();
    const scl = new Vector3();
    const p = new Vector3();
    const tint = new Color();
    let idx = 0;

    for (let c = 0; c < 4; c++) {
      const a = (c / 4) * Math.PI * 2 + 0.6;
      const x = Math.cos(a) * ringR;
      const z = Math.sin(a) * ringR;
      const floor = this.terrain.heightAt(x, z);
      for (let s = 0; s < segs; s++) {
        // Slight per-segment taper and spin so the stack is not a mirror-repeat.
        const t = s / segs;
        const w = width * (1 - t * 0.12);
        scl.set(w, segH * 1.02, w); // 2% overlap hides the seams
        q.setFromAxisAngle(UP, rand() * Math.PI * 2);
        p.set(x, floor - 6 + s * segH, z);
        m.compose(p, q, scl);
        mesh.setMatrixAt(idx, m);
        const v = 0.4 + rand() * 0.22;
        tint.setRGB(v, v * 1.02, v * 1.12);
        mesh.setColorAt(idx, tint);
        idx++;
      }
      // One full-height collider per column.
      this.colliders.push({ x, z, r: width * 0.5, top: floor + span });
    }
    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.drawCalls++;
    this.tris += piece.tris * idx;
  }

  // ---- the ruins ----------------------------------------------------------

  /** Accumulator so every ruin piece becomes ONE instanced draw, not hundreds. */
  private readonly ruinBuckets = new Map<RockPiece, { tint: number; mats: Matrix4[] }>();

  private buildRuins(castle: RockPack): void {
    const columns = castle.matching('Cylinder');
    const blocks = castle.matching('Box');
    // Wide-but-not-flat gate/arch pieces (excludes the very flat Loft platforms
    // and the tall columns). ~0.5 aspect is the big Line arch.
    const arches = castle.pieces.filter((p) => p.tris > 250 && p.unitHeight > 0.3 && p.unitHeight < 0.72);
    const slabs = castle.matching('Loft');

    if (columns.length) this.ruinColonnade(columns);
    if (blocks.length) this.ruinRubble(blocks);
    if (slabs.length) this.ruinLedges(slabs);
    if (arches.length) this.ruinArches(arches);
    this.flushRuins();
  }

  /** A drowned ring of broken columns around the basin — a sunken peristyle. */
  private ruinColonnade(columns: RockPiece[]): void {
    const rand = mulberry32(4711);
    const N = 26;
    const ringR = SHAFT.radius * 0.82;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + (rand() - 0.5) * 0.14;
      const rr = ringR - rand() * 40;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (this.inExit(x, z)) continue;
      const piece = columns[i % columns.length];
      const width = 7 + rand() * 7;
      const floor = this.terrain.heightAt(x, z);
      // Two thirds stand (tall), the rest are snapped short or toppled.
      const standing = rand() < 0.62;
      const h = standing ? width * piece.unitHeight * (0.7 + rand() * 0.5) : width * piece.unitHeight * (0.2 + rand() * 0.25);
      const tilt = standing ? (rand() - 0.5) * 0.1 : (rand() - 0.5) * 1.6;
      this.addRuin(piece, 0x7a8290, x, floor - 3, z, width, h / (width * piece.unitHeight), rand() * Math.PI * 2, tilt);
      if (standing) this.colliders.push({ x, z, r: width * 0.45, top: floor + h * 0.85 });
    }
  }

  /** Tumbled blocks strewn across the basin and heaped at the columns' feet. */
  private ruinRubble(blocks: RockPiece[]): void {
    const rand = mulberry32(6262);
    for (let i = 0; i < 90; i++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * SHAFT.radius * 0.9;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (this.inExit(x, z)) continue;
      const piece = blocks[i % blocks.length];
      const size = 3 + rand() * rand() * 12;
      const floor = this.terrain.heightAt(x, z);
      this.addRuin(piece, 0x767d88, x, floor - size * 0.2, z, size, 0.7 + rand() * 0.7, rand() * Math.PI * 2, (rand() - 0.5) * 0.8);
      if (size > 8) this.colliders.push({ x, z, r: size * 0.4, top: floor + size * 0.7 });
    }
  }

  /**
   * Ledges of collapsed floor jutting off the wall at varied heights — the
   * broken storeys of the drowned castle, and perches to fight from on the way
   * down. Each is a big flat slab tucked against the wall with a collider.
   */
  private ruinLedges(slabs: RockPiece[]): void {
    const rand = mulberry32(9099);
    const slab = slabs.reduce((a, b) => (b.tris > a.tris ? b : a)); // the big platform
    const N = 7;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + rand() * 0.5;
      const h = SHAFT.floorY + 60 + rand() * (SHAFT.wallTop - 140);
      const rr = SHAFT.radius - 18 - rand() * 20;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const size = 26 + rand() * 22;
      this.addRuin(slab, 0x6f7682, x, h, z, size, 0.14 + rand() * 0.06, a + Math.PI / 2, (rand() - 0.5) * 0.12);
      this.colliders.push({ x, z, r: size * 0.42, top: h + size * 0.12 });
    }
  }

  /** Two great arches marking the relay precincts (near the carrier anchors). */
  private ruinArches(arches: RockPiece[]): void {
    const rand = mulberry32(3131);
    const arch = arches.reduce((a, b) => (b.tris > a.tris ? b : a));
    const spots: [number, number][] = [
      [118, -70],
      [-128, 96],
    ];
    for (const [x, z] of spots) {
      const floor = this.terrain.heightAt(x, z);
      const size = 96 + rand() * 20;
      const yaw = Math.atan2(-z, -x); // face the arch inward, toward the centre
      this.addRuin(arch, 0x808895, x, floor - 4, z, size, 1, yaw, 0);
      this.colliders.push({ x: x + Math.cos(yaw) * size * 0.3, z: z + Math.sin(yaw) * size * 0.3, r: size * 0.12, top: floor + size * 0.4 });
      this.colliders.push({ x: x - Math.cos(yaw) * size * 0.3, z: z - Math.sin(yaw) * size * 0.3, r: size * 0.12, top: floor + size * 0.4 });
    }
  }

  /**
   * Queue one ruin piece placement. `size` sets the footprint width; `heightScale`
   * multiplies the piece's own normalised height (so heightScale=1 keeps its
   * proportions). Baked into a per-piece bucket, flushed as one InstancedMesh.
   */
  private addRuin(
    piece: RockPiece,
    tint: number,
    x: number,
    y: number,
    z: number,
    size: number,
    heightScale: number,
    yaw: number,
    tilt: number,
  ): void {
    const q = new Quaternion().setFromAxisAngle(UP, yaw);
    if (tilt) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt));
    const m = new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(size, size * heightScale, size));
    let bucket = this.ruinBuckets.get(piece);
    if (!bucket) {
      bucket = { tint, mats: [] };
      this.ruinBuckets.set(piece, bucket);
    }
    bucket.mats.push(m);
  }

  /** Bake every queued ruin into one instanced draw per piece type. */
  private flushRuins(): void {
    const rand = mulberry32(9001);
    const tintC = new Color();
    for (const [piece, bucket] of this.ruinBuckets) {
      const src = piece.material as MeshStandardMaterial;
      const mat = new MeshStandardMaterial({
        color: new Color(bucket.tint),
        map: src && src.map ? src.map : undefined,
        roughness: 0.94,
        metalness: 0,
        side: FrontSide,
        emissive: new Color(0x161c30),
        emissiveIntensity: 0.6,
      });
      this.disposables.push(mat);
      const im = new InstancedMesh(piece.geometry, mat, bucket.mats.length);
      im.name = 'kingdom-ruin';
      for (let i = 0; i < bucket.mats.length; i++) {
        im.setMatrixAt(i, bucket.mats[i]);
        const v = 0.82 + rand() * 0.36; // subtle per-stone value variation
        im.setColorAt(i, tintC.setRGB(v, v, v * 1.03));
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.group.add(im);
      this.drawCalls++;
      this.tris += piece.tris * bucket.mats.length;
    }
    this.ruinBuckets.clear();
  }

  // ---- crystal (the vegetation) -------------------------------------------

  /**
   * The crystal vegetation: flowering bursts of shards from single points, on the
   * floor, over the ruins, and — most of all — clinging to the walls at every
   * height so the descent sinks through a growing geode. Each burst picks one hue;
   * the shards fan out around a surface normal with random spin and tilt.
   */
  private buildCrystals(gemsLow: RockPack): void {
    const shapes = gemsLow.pieces;
    if (!shapes.length) return;
    for (const hue of CRYSTAL_HUES) {
      const c = new Color(hue);
      const mat = new MeshStandardMaterial({
        color: c.clone().multiplyScalar(0.4),
        emissive: c,
        emissiveIntensity: 1.9,
        roughness: 0.3,
        metalness: 0.1,
        flatShading: true,
      });
      this.disposables.push(mat);
      this.crystalMats.push(mat);
    }

    const rand = mulberry32(2024);
    const placements: CrystalPlacement[] = [];

    const burst = (base: Vector3, normal: Vector3, n: number, sizeMin: number, sizeMax: number, hue: number): void => {
      const nrm = normal.clone().normalize();
      for (let i = 0; i < n; i++) {
        const shape = Math.floor(rand() * shapes.length);
        const size = sizeMin + rand() * (sizeMax - sizeMin);
        // Point the shard's up-axis roughly along the surface normal, then splay.
        const dir = nrm
          .clone()
          .add(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.9))
          .normalize();
        const q = new Quaternion().setFromUnitVectors(UP, dir);
        const off = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(size * 0.4);
        const scl = new Vector3(size * (0.6 + rand() * 0.5), size * (1 + rand() * 1.4), size * (0.6 + rand() * 0.5));
        const m = new Matrix4().compose(base.clone().add(off), q, scl);
        placements.push({ shape, hue, m });
      }
    };

    // Floor bursts, drawn toward the crystal precincts and thinning between.
    for (let i = 0; i < 150; i++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * SHAFT.radius * 0.94;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (this.inExit(x, z)) continue;
      const base = new Vector3(x, this.terrain.heightAt(x, z) - 1, z);
      burst(base, UP, 3 + Math.floor(rand() * 5), 1.4, 5.5, Math.floor(rand() * CRYSTAL_HUES.length));
    }

    // Wall bursts, at every height, pointing inward — the geode you fall through.
    for (let i = 0; i < 240; i++) {
      const a = rand() * Math.PI * 2;
      const h = SHAFT.floorY + 10 + rand() * (SHAFT.wallTop - 30);
      const rr = SHAFT.radius - 4;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const base = new Vector3(x, h, z);
      const inward = new Vector3(-Math.cos(a), (rand() - 0.4) * 0.5, -Math.sin(a));
      burst(base, inward, 3 + Math.floor(rand() * 5), 1.2, 5.0, Math.floor(rand() * CRYSTAL_HUES.length));
    }

    if (!placements.length) return;

    // One InstancedMesh per (shape, hue) — a handful of draws for thousands of
    // cheap 52-tri shards.
    const buckets = new Map<number, Matrix4[]>();
    for (const pl of placements) {
      const key = pl.shape * 10 + pl.hue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(pl.m);
    }
    for (const [key, mats] of buckets) {
      const shape = Math.floor(key / 10);
      const hue = key % 10;
      const im = new InstancedMesh(shapes[shape].geometry, this.crystalMats[hue], mats.length);
      im.name = 'crystal';
      for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.drawCalls++;
      this.tris += shapes[shape].tris * mats.length;
    }
  }

  /**
   * Larger faceted gem spears (the medium-poly, unlit pack) as accents — a few
   * big colour statements jutting from the ruins and the wall crystal nodes.
   */
  private buildGemAccents(gemsMed: RockPack): void {
    const pieces = gemsMed.pieces;
    if (!pieces.length) return;
    const rand = mulberry32(5150);
    const buckets = pieces.map(() => [] as Matrix4[]);

    const put = (base: Vector3, dir: Vector3, size: number): void => {
      const pi = Math.floor(rand() * pieces.length);
      const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
      const scl = new Vector3(size, size, size);
      buckets[pi].push(new Matrix4().compose(base, q, scl));
    };

    // Jutting from the wall at random heights.
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2;
      const h = SHAFT.floorY + 30 + rand() * (SHAFT.wallTop - 80);
      const x = Math.cos(a) * (SHAFT.radius - 6);
      const z = Math.sin(a) * (SHAFT.radius - 6);
      const dir = new Vector3(-Math.cos(a), (rand() - 0.5) * 0.6, -Math.sin(a));
      put(new Vector3(x, h, z), dir, 1.2 + rand() * 2.2);
    }
    // A few clusters on the floor.
    for (let i = 0; i < 16; i++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand()) * SHAFT.radius * 0.85;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (this.inExit(x, z)) continue;
      const dir = new Vector3((rand() - 0.5) * 0.8, 1, (rand() - 0.5) * 0.8);
      put(new Vector3(x, this.terrain.heightAt(x, z), z), dir, 1.4 + rand() * 2.6);
    }

    for (let pi = 0; pi < pieces.length; pi++) {
      const mats = buckets[pi];
      if (!mats.length) continue;
      const im = new InstancedMesh(pieces[pi].geometry, pieces[pi].material, mats.length);
      im.name = 'gem-accent';
      for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      this.drawCalls++;
      this.tris += pieces[pi].tris * mats.length;
    }
  }

  /**
   * The colossal landmark crystals: the single big crystal bunch, placed huge
   * against the wall at a handful of points around the well, at varied heights,
   * so each reads as a mountain of gem you navigate by.
   */
  private buildBigCrystals(pack: RockPack): void {
    const piece = pack.pieces[0];
    if (!piece) return;
    const rand = mulberry32(1717);
    const mat = new MeshStandardMaterial({
      color: new Color(0x8a6cff).multiplyScalar(0.45),
      emissive: new Color(0x7a5cff),
      emissiveIntensity: 1.5,
      roughness: 0.35,
      metalness: 0.15,
      side: DoubleSide,
    });
    this.disposables.push(mat);
    const N = 9;
    const im = new InstancedMesh(piece.geometry, mat, N);
    im.name = 'big-crystal';
    const m = new Matrix4();
    const q = new Quaternion();
    const scl = new Vector3();
    const p = new Vector3();
    const hues = [0x9b5cff, 0x46d6ff, 0x54ffb0, 0xff5c8f, 0xffd166];
    const tint = new Color();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + rand() * 0.4;
      const h = i % 2 === 0 ? SHAFT.floorY + rand() * 40 : SHAFT.floorY + 90 + rand() * (SHAFT.wallTop - 200);
      const rr = SHAFT.radius - 10;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const size = 34 + rand() * 30;
      // Grow out of the wall, tilted up into the shaft.
      const dir = new Vector3(-Math.cos(a), 0.7 + rand() * 0.5, -Math.sin(a)).normalize();
      q.setFromUnitVectors(UP, dir);
      scl.set(size, size * (0.9 + rand() * 0.5), size);
      p.set(x, h, z);
      m.compose(p, q, scl);
      im.setMatrixAt(i, m);
      tint.setHex(hues[i % hues.length]).multiplyScalar(0.9);
      im.setColorAt(i, tint);
      // A soft collider so you can perch on the big ones, but not on tiny tips.
      this.colliders.push({ x, z, r: size * 0.28, top: h + size * 0.5 });
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    this.group.add(im);
    this.drawCalls++;
    this.tris += piece.tris * N;
  }

  // ---- helpers ------------------------------------------------------------

  private inExit(x: number, z: number): boolean {
    const ex = SHAFT.exit;
    return Math.hypot(x - ex.x, z - ex.z) < ex.radius * 2.0;
  }

  dispose(): void {
    for (const p of this.packs) p.dispose();
    this.packs.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.crystalMats.length = 0;
    this.colliders.length = 0;
  }
}
