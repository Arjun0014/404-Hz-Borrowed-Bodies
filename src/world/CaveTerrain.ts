import {
  BufferAttribute,
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import type { TerrainLike, TerrainMaps } from './types';

/**
 * The Drowned Garden's cave shell: an analytic FLOOR and an analytic ROOF.
 *
 * The whole zone is one enormous flooded cavern entered through a colossal arch,
 * so unlike the Shallow Veil (open water under a flat surface) this zone needs a
 * roof that varies — and needs it to be a pure function, for the same reason the
 * shelf's floor is: rendering and collision read the same maths, so the vault you
 * can see is exactly the vault you bump into.
 *
 * The mouth is expressed as a pinch rather than as a hole cut in a wall. Near the
 * mouth plane the roof is driven down toward the floor by an elliptical arch
 * profile; inside the arch it stays high (open), outside it meets the floor
 * (solid rock). That gives a real archway silhouette, a rock curtain of genuine
 * thickness, and correct collision — with no boolean geometry anywhere.
 */

// ---- cave dimensions (metres) --------------------------------------------

export const CAVE = {
  /**
   * Playable box. -X is the open approach; the cavern runs away to +X.
   * The full-size cavern. The 30% reduction was reverted once the real cost was
   * traced to overdraw and stray Shallow Veil flora rather than to floor area —
   * with those fixed, the space is affordable and the extra room lets the
   * landmark sites sit far enough apart to be separate places.
   */
  minX: -340,
  maxX: 620,
  minZ: -460,
  maxZ: 460,
  softMargin: 26,

  /** The mouth plane: the rock curtain the arch is bored through. */
  mouthX: -120,
  /** Half-thickness of that curtain. */
  mouthThickness: 26,
  /**
   * Half-width of the opening. 72 → a 144 m wide arch. Deliberately narrower
   * than the first pass (92): at 184 × 92 the mouth was a 2:1 letterbox and
   * read as a rectangular hole no matter how the profile curved. Nearer square
   * is what makes it read as an ARCH, and it loses nothing in scale.
   */
  archHalfWidth: 72,
  /** Height of the arch crown above the floor at its centre. */
  archHeight: 112,

  /** Roof height above the floor, deep inside the cavern. */
  vaultHeight: 96,
  /**
   * Roof height out in the open water in front of the mouth. Very high on
   * purpose: at 210 this surface sat ~100 m over the approach and behaved as a
   * LID, occluding the entire cliff face above the arch from a swimmer's
   * eye-line — the mouth could never read because the rock above it was hidden
   * behind a ceiling. Pushed up here it is lost in fog and the approach reads as
   * open water, which is what it is meant to be.
   */
  outsideRoof: 520,

  /** Player arrives out in front of the mouth, looking into it. */
  spawn: { x: -262, z: 0 },
  /**
   * The whirlpool that leads down to the next zone. Deliberately NOT in a
   * corner: tucked against the sealing walls the player kept getting wedged in
   * rock trying to reach it. It now sits in open water at the far end of the
   * cavern with clear approach on every side, and CaveTerrain carves a basin
   * around it so the seabed slopes down into the throat.
   */
  whirlpool: { x: 430, z: -40, radius: 44 },
} as const;

// ---- deterministic value noise (same recipe as the shelf terrain) --------

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967295;
}

function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smoother(x - ix);
  const fz = smoother(z - iz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function fbm(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, z * freq) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum; // ~0..1
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * How strongly the mouth curtain acts at this x — 1 on the mouth plane, easing
 * to 0 either side. Shared by the floor and the roof so the curtain is one
 * coherent slab of rock rather than two features that happen to line up.
 */
function curtain(x: number): number {
  return 1 - smoothstep(0, CAVE.mouthThickness, Math.abs(x - CAVE.mouthX));
}

/** Elliptical arch: 1 at the centre of the opening, 0 at its edges and beyond. */
function archProfile(z: number): number {
  const t = Math.abs(z) / CAVE.archHalfWidth;
  if (t >= 1) return 0;
  return Math.sqrt(1 - t * t);
}

// ---- interior features ----------------------------------------------------

/** Broad floor swells and roof domes that give the cavern its internal shape. */
interface Swell {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** Raised rock shelves and rubble mounds on the cavern floor. */
const FLOOR_SWELLS: Swell[] = [
  { x: 10, z: -140, r: 78, h: 22 },
  { x: 150, z: 90, r: 88, h: 26 },
  { x: -30, z: 190, r: 66, h: 17 },
  { x: 280, z: -80, r: 74, h: 24 },
  { x: 110, z: -280, r: 62, h: 20 },
  { x: 360, z: 230, r: 70, h: 23 },
  { x: -70, z: -30, r: 50, h: 12 },
  { x: 470, z: -190, r: 80, h: 26 },
  { x: 250, z: 340, r: 68, h: 20 },
  { x: 540, z: 60, r: 72, h: 22 },
  { x: 60, z: 300, r: 58, h: 16 },
  { x: 400, z: -330, r: 64, h: 21 },
];

/** Domes lifted into the roof — the cavern's "sky" is not one flat slab. */
const ROOF_DOMES: Swell[] = [
  { x: 40, z: 0, r: 160, h: 42 },
  { x: 240, z: -140, r: 140, h: 36 },
  { x: 200, z: 200, r: 130, h: 32 },
  { x: -50, z: -220, r: 110, h: 24 },
  { x: 430, z: 40, r: 150, h: 38 },
  { x: 520, z: -260, r: 120, h: 30 },
  { x: 330, z: 360, r: 118, h: 28 },
  { x: 120, z: -360, r: 108, h: 26 },
];

/** Places the roof sags low — the passages that make the space feel navigated. */
const ROOF_SAGS: Swell[] = [
  { x: 100, z: -70, r: 72, h: 30 },
  { x: 20, z: 250, r: 68, h: 26 },
  { x: 330, z: -250, r: 66, h: 28 },
  { x: 210, z: 50, r: 58, h: 22 },
  { x: 470, z: 210, r: 70, h: 28 },
  { x: 380, z: -60, r: 60, h: 24 },
  { x: 150, z: 380, r: 62, h: 24 },
];

function swellAt(list: readonly Swell[], x: number, z: number, power: number): number {
  let sum = 0;
  for (const s of list) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.r) sum += s.h * Math.pow(1 - smoothstep(s.r * 0.25, s.r, d), power);
  }
  return sum;
}

export class CaveTerrain implements TerrainLike {
  floorMesh!: Mesh;
  roofMesh!: Mesh;
  private readonly disposables: { dispose(): void }[] = [];

  // ---- analytic shape ----------------------------------------------------

  /** World-space cavern floor height at (x, z). */
  heightAt(x: number, z: number): number {
    // Base rubble floor: broad dunes plus a ridged component so it reads as
    // fractured rock rather than sand.
    let y = 2 + fbm(x * 0.007 + 5.3, z * 0.007 + 12.9, 4) * 11;
    const rn = fbm(x * 0.016 + 22.1, z * 0.016 + 4.4, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    y += ridged * ridged * 9;
    y += fbm(x * 0.055 + 3.1, z * 0.055 + 7.7, 3) * 1.8;
    y += swellAt(FLOOR_SWELLS, x, z, 1.2);

    // Side and back walls seal the cavern. The -X side stays open: that is the
    // water you descended through to get here.
    const sideWall =
      ((1 - smoothstep(CAVE.minZ + 6, CAVE.minZ + 62, z)) +
        smoothstep(CAVE.maxZ - 62, CAVE.maxZ - 6, z)) *
      120;
    const backWall = smoothstep(CAVE.maxX - 70, CAVE.maxX - 6, x) * 130;
    y += sideWall + backWall;

    // In front of the mouth the floor falls away into the dark you came down
    // through, so the approach reads as open water rather than a corridor.
    const outside = 1 - smoothstep(CAVE.mouthX - 35, CAVE.mouthX - 8, x);
    y = lerp(y, y - 46, outside);

    // The whirlpool's basin: a wide, smooth bowl dishing down into the throat.
    // Without it the drain sat on whatever lumpy seabed happened to be there and
    // the player snagged on rock trying to swim into it; the bowl guarantees a
    // clean, open approach from every direction and makes the exit read as a
    // place the water drains toward.
    {
      const w = CAVE.whirlpool;
      const d = Math.hypot(x - w.x, z - w.z);
      const bowlR = w.radius * 3.4;
      if (d < bowlR) {
        const t = 1 - smoothstep(0, bowlR, d);
        y -= Math.pow(t, 1.7) * 26;
      }
    }

    // NOTE: the floor deliberately does NOT lift to form jambs beside the arch
    // any more. That was how the mouth was sealed before there was a real wall
    // mesh; now that DrownedGarden.buildMouthWall owns the curtain, lifting the
    // floor as well put two different pieces of rock in the same place and the
    // raised floor cut the wall's silhouette off partway across the map. The
    // wall seals the mouth visually; ceilingAt's arch pinch seals it for
    // collision.
    return y;
  }

  /**
   * World-space cavern ROOF height at (x, z). Always above heightAt by at least
   * a small margin except where the rock is deliberately solid (the curtain
   * outside the arch, and the sealing walls), where the two meet.
   */
  ceilingAt(x: number, z: number): number {
    const floor = this.baseFloor(x, z);

    // Deep interior: a vault that domes and sags.
    let roof = floor + CAVE.vaultHeight;
    roof += swellAt(ROOF_DOMES, x, z, 1.1);
    roof -= swellAt(ROOF_SAGS, x, z, 1.3);
    roof += fbm(x * 0.012 + 41.7, z * 0.012 + 19.3, 4) * 16;
    roof += fbm(x * 0.045 + 8.2, z * 0.045 + 33.1, 3) * 4;

    // The roof curves down to meet the floor at the sealing walls, so the
    // cavern is genuinely closed rather than a slab floating over a void.
    const sideSeal = Math.max(
      1 - smoothstep(CAVE.minZ + 6, CAVE.minZ + 70, z),
      smoothstep(CAVE.maxZ - 70, CAVE.maxZ - 6, z),
    );
    const backSeal = smoothstep(CAVE.maxX - 78, CAVE.maxX - 8, x);
    const seal = Math.max(sideSeal, backSeal);
    roof = lerp(roof, floor - 4, seal);

    // Out in front of the mouth there is no roof — open water overhead.
    //
    // This transition is VERY short (~9 m, about three grid quads) on purpose.
    // A heightfield cannot express a truly vertical face, so the cliff has to be
    // approximated by a near-vertical slope. Stretched over 50 m it came out at
    // ~30-60°, which from a swimmer's eye-line is a ceiling seen edge-on: its
    // normals point downward, it never catches the approach light, and the whole
    // cliff read as black. Compressed to 9 m the drop is ~80-87°, the normals
    // swing round to face the approach, and the rock above the arch finally
    // reads as a wall with an opening in it.
    // The drop from open water down to the vault is buried INSIDE the mouth
    // wall's thickness, so the steep ramp it produces is never visible from
    // either side — the wall mesh is what you actually see at the mouth.
    const outside = 1 - smoothstep(CAVE.mouthX - CAVE.mouthThickness, CAVE.mouthX + CAVE.mouthThickness * 0.5, x);
    roof = lerp(roof, floor + CAVE.outsideRoof, outside);

    // The mouth: an elliptical arch bored through the curtain. Inside the arch
    // the roof lifts to the crown; outside it, it drops to the floor and the
    // rock is solid. This pinch IS the opening — no geometry is cut anywhere.
    //
    // The arch REPLACES the local roof rather than being min()'d with it. Taking
    // the minimum let the interior vault cap the crown, which flattened the top
    // of the opening into a rectangle across its whole middle span and threw the
    // arch silhouette away.
    const c = curtain(x);
    if (c > 0) {
      const arch = archProfile(z);
      // A true ellipse (exponent 1). Anything below 1 flattens the crown, which
      // is exactly the rectangular read we are trying to get away from.
      const archRoof = floor + 5 + CAVE.archHeight * arch;
      roof = lerp(roof, archRoof, c);
    }
    return roof;
  }

  /**
   * Floor height WITHOUT the mouth curtain's solid-rock lift. The roof is built
   * on this so the arch crown is measured from the real cavern floor rather than
   * from the jamb the curtain raises beside it.
   */
  private baseFloor(x: number, z: number): number {
    let y = 2 + fbm(x * 0.007 + 5.3, z * 0.007 + 12.9, 4) * 11;
    const rn = fbm(x * 0.016 + 22.1, z * 0.016 + 4.4, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    y += ridged * ridged * 9;
    y += swellAt(FLOOR_SWELLS, x, z, 1.2);
    const outside = 1 - smoothstep(CAVE.mouthX - 35, CAVE.mouthX - 8, x);
    return lerp(y, y - 46, outside);
  }

  slopeAt(x: number, z: number): number {
    const e = 1.5;
    const dhx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dhz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dhx, dhz) / (2 * e);
  }

  /** Vertical clearance between floor and roof — used to place columns. */
  clearanceAt(x: number, z: number): number {
    return this.ceilingAt(x, z) - this.heightAt(x, z);
  }

  // ---- meshes ------------------------------------------------------------

  build(maps?: TerrainMaps): { floor: Mesh; roof: Mesh } {
    this.floorMesh = this.buildShell('floor', maps);
    this.roofMesh = this.buildShell('roof', maps);
    return { floor: this.floorMesh, roof: this.roofMesh };
  }

  /**
   * One shell of the cavern. The roof is the same displaced plane as the floor
   * with its winding flipped, so it lights from underneath — cheaper and far
   * more controllable than trying to model a closed cave volume.
   */
  private buildShell(kind: 'floor' | 'roof', maps?: TerrainMaps): Mesh {
    const segs = 190;
    const w = CAVE.maxX - CAVE.minX;
    const d = CAVE.maxZ - CAVE.minZ;
    const geo = new PlaneGeometry(w, d, segs, segs);
    geo.rotateX(-Math.PI / 2);
    geo.translate((CAVE.minX + CAVE.maxX) / 2, 0, (CAVE.minZ + CAVE.maxZ) / 2);

    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const textured = !!maps;
    const roof = kind === 'roof';

    // A cold, wet, near-black stone palette. With a texture these modulate a
    // white base; without one they carry the colour outright.
    const stoneLight = textured ? new Color(0.92, 0.95, 1.0) : new Color(0x5f676e);
    const stoneDark = textured ? new Color(0.46, 0.49, 0.54) : new Color(0x2e343a);
    const rust = textured ? new Color(0.62, 0.42, 0.26) : new Color(0x4a3320);
    const black = textured ? new Color(0.05, 0.06, 0.08) : new Color(0x05070a);
    const tmp = new Color();
    const tmp2 = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = roof ? this.ceilingAt(x, z) : this.heightAt(x, z);
      pos.setY(i, y);

      // Banded strata — the layered look of the reference, and it reads as
      // sedimentary rock rather than noise.
      const band = Math.sin(y * 0.42 + fbm(x * 0.02, z * 0.02, 2) * 3.2);
      tmp.copy(stoneDark).lerp(stoneLight, smoothstep(-0.4, 0.7, band));
      // Rust staining, sparse and clustered.
      const rustT = smoothstep(0.68, 0.86, fbm(x * 0.03 + 61.1, z * 0.03 + 12.4, 3));
      tmp.lerp(tmp2.copy(rust), rustT * 0.7);
      tmp.multiplyScalar(0.86 + fbm(x * 0.1, z * 0.1, 2) * 0.28);
      // The roof sits in its own shadow; the deep interior falls toward black.
      if (roof) tmp.multiplyScalar(0.62);
      tmp.lerp(tmp2.copy(black), smoothstep(60, 240, x) * 0.55);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    // DoubleSide rather than a flipped winding.
    //
    // The roof shell is not just a ceiling: where it plunges to meet the floor
    // it becomes the cavern's near-vertical outer CLIFF, and that face is viewed
    // from the opposite side to the vault. Flipping the winding to make the
    // vault light correctly from below therefore pointed the cliff's normals
    // into the rock — the approach was both unlit and backface-culled, which is
    // why the mouth looked like a lit hole floating in a void. DoubleSide lets
    // three.js flip the normal per-fragment via gl_FrontFacing instead, so both
    // faces of the same sheet light correctly. The floor shell gets it too: its
    // raised jambs beside the arch are seen from outside for the same reason.
    const mat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      side: DoubleSide,
    });
    if (maps) {
      mat.map = maps.map;
      mat.normalMap = maps.normalMap;
      mat.normalScale.set(0.9, 0.9);
      if (maps.armMap) {
        mat.aoMap = maps.armMap;
        mat.roughnessMap = maps.armMap;
        mat.metalnessMap = maps.armMap;
        mat.roughness = 1;
        mat.metalness = 1;
      }
      // No displacement map here: the shells already carry heavy analytic
      // relief, and vertex displacement would pull them out of agreement with
      // heightAt/ceilingAt, which is what collision reads.
    }

    this.disposables.push(geo, mat);
    const mesh = new Mesh(geo, mat);
    mesh.name = `cave-${kind}`;
    return mesh;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
