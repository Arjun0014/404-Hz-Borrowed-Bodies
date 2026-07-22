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
 * The Fallen Kingdom's shape: a drowned CITY, not a cave and not a shaft.
 *
 * The zone's whole premise is that you can read the ground plan of a place that
 * was built. That is a terrain problem before it is a dressing problem — a city
 * sits on a site, and the site is what makes the buildings legible:
 *
 *  - an ACROPOLIS in the middle, a terraced mesa lifting the citadel 116 m over
 *    everything else, so you always know which way is "up-city";
 *  - stepped TERRACES ringing it, so the lower town is built on shelves rather
 *    than scattered on a plain;
 *  - a PROCESSIONAL AVENUE cut through those terraces as a dead-straight ramp
 *    from the great gate up to the citadel — the single strongest signal in the
 *    zone that people made this;
 *  - the GEODE, a collapse basin that ate the city's east quarter and exposed
 *    the crystal underneath. The way down is at the bottom of it.
 *
 * Overhead there is a real vault, and punched through it directly above the
 * acropolis is the BREACH: the hole the cavern roof fell in through, and the way
 * you arrive. Inside the breach the roof jumps to open black water, so the
 * heightfield's near-vertical transition becomes the shaft wall you sink past.
 * This is the same single-valued-heightfield trick the Drowned Garden uses for
 * its arch, and it is why this zone does NOT need the radial-containment hook
 * the cylinder version added: floor + roof + a box is enough to hold a city.
 */

// ---- the plan (metres) -----------------------------------------------------

export const KINGDOM = {
  /**
   * Playable box: 760 x 760, a little under half the Drowned Garden's area, as
   * asked. The height is where this zone spends instead — ~320 m from the geode
   * floor to the vault, against the Garden's 96 m.
   */
  minX: -380,
  maxX: 380,
  minZ: -380,
  maxZ: 380,
  softMargin: 26,

  /** The citadel's mesa. `plateauR` is the flat top the great hall stands on. */
  acropolis: { x: 0, z: 0, r: 172, plateauR: 94, height: 116 },

  /** The hole in the cavern roof above the acropolis: the way in. */
  breach: { x: 0, z: -20, r: 130 },

  /** Absolute roof height over the town, and inside the breach. */
  vault: 252,
  sky: 620,

  /**
   * The processional avenue: a straight ramp running out along -X from the
   * acropolis foot down to the great gate, cutting through every terrace.
   */
  avenue: { halfWidth: 34, innerX: -168, outerX: -352, innerY: 62, outerY: 6 },
  gate: { x: -300, z: 0 },

  /** The curtain wall's ring radius (the wall itself is built by the dressing). */
  wallR: 318,

  /**
   * The sunken cathedral: where the ground gave way, took the east quarter of
   * the town with it, and laid the crystal bare. The descent is at its bottom.
   */
  geode: { x: 236, z: 222, r: 122, depth: 74 },
  exit: { x: 236, z: 222, radius: 30 },

  /** You arrive inside the breach, high above the citadel. */
  spawn: { x: 0, z: -104, y: 372 },
} as const;

/** Ground kinds, so the dressing and the vertex colours agree on what is paved. */
export const enum Ground {
  Rock = 0,
  Paved = 1,
}

// ---- deterministic value noise (same recipe as the other zones) ------------

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
  return sum;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Quantise a 0..1 ramp into `steps` flat treads with steep risers, then bleed a
 * little of the smooth ramp back in.
 *
 * This one function is what makes the site read as ARCHITECTURE rather than as
 * a hill. A smooth mesa is a geological feature; a stepped one is a thing that
 * was cut, and the eye picks that up instantly. The `blend` term matters as much
 * as the quantisation: a heightfield cannot express a truly vertical riser, so a
 * pure step produces a diagonal ramp between treads anyway — mixing a fraction
 * of the smooth ramp in makes that unavoidable slope look intentional (a worn
 * revetment) instead of like a failed step.
 */
function terrace(t: number, steps: number, blend = 0.16): number {
  const q = Math.ceil(clamp01(t) * steps) / steps;
  return q * (1 - blend) + clamp01(t) * blend;
}

// ---- named districts, so the dressing can ask where things are -------------

/** How far a point is along the avenue: 0 at the gate, 1 at the acropolis. */
export function avenueT(x: number): number {
  const a = KINGDOM.avenue;
  return clamp01((x - a.outerX) / (a.innerX - a.outerX));
}

/** 1 inside the avenue corridor, easing to 0 just outside its kerb. */
export function avenueMask(x: number, z: number): number {
  const a = KINGDOM.avenue;
  if (x < a.outerX - 30 || x > a.innerX + 24) return 0;
  const along =
    smoothstep(a.outerX - 30, a.outerX + 6, x) * (1 - smoothstep(a.innerX - 8, a.innerX + 24, x));
  const across = 1 - smoothstep(a.halfWidth * 0.72, a.halfWidth, Math.abs(z));
  return along * across;
}

export class KingdomTerrain implements TerrainLike {
  floorMesh!: Mesh;
  roofMesh!: Mesh;
  private readonly disposables: { dispose(): void }[] = [];

  // ---- analytic shape ----------------------------------------------------

  /**
   * Distance from the acropolis axis, warped so none of the terraces are true
   * circles. Without this the citadel reads as a wedding cake; with it, as a
   * ruin whose revetments have slumped unevenly.
   */
  private acroDist(x: number, z: number): number {
    const a = KINGDOM.acropolis;
    const dx = x - a.x;
    const dz = z - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return 0;
    const ang = Math.atan2(dz, dx);
    const warp = 1 + Math.sin(ang * 3.1 + 0.7) * 0.055 + Math.sin(ang * 5.7 - 2.1) * 0.035;
    return d / warp;
  }

  heightAt(x: number, z: number): number {
    const K = KINGDOM;

    // --- the natural cavern floor the city was built on ---------------------
    let y = 2 + fbm(x * 0.0075 + 4.1, z * 0.0075 + 9.3, 4) * 12;
    const rn = fbm(x * 0.017 + 31.7, z * 0.017 + 6.2, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    y += ridged * ridged * 7;
    y += fbm(x * 0.06 + 2.2, z * 0.06 + 8.8, 3) * 1.6;

    const d = this.acroDist(x, z);

    // --- the lower town's terraces ------------------------------------------
    // Three broad shelves climbing from the curtain wall inward to the foot of
    // the acropolis. The town is built ON these, which is why its buildings sit
    // in ranks instead of scattered across a plain.
    if (d < K.wallR) {
      const t = clamp01((K.wallR - d) / (K.wallR - K.acropolis.r));
      y += terrace(t, 3, 0.22) * 40;
    }

    // --- the acropolis -------------------------------------------------------
    if (d < K.acropolis.r) {
      const a = K.acropolis;
      // Flat on top, terraced down the flanks in five cut steps.
      const t = d <= a.plateauR ? 1 : 1 - (d - a.plateauR) / (a.r - a.plateauR);
      y += terrace(t, 5, 0.14) * a.height;
    }

    // --- the processional avenue --------------------------------------------
    // A dead-straight ramp that cuts THROUGH the terraces. Blended rather than
    // stamped, so its kerbs bed into the shelves either side.
    const av = avenueMask(x, z);
    if (av > 0) {
      const a = K.avenue;
      const ramp = lerp(a.outerY, a.innerY, avenueT(x));
      // A shallow camber, so it drains like a road and never looks like a
      // rectangle of flat ground.
      const camber = -Math.pow(Math.abs(z) / a.halfWidth, 2) * 2.2;
      y = lerp(y, ramp + camber, av);
    }

    // --- the geode: the collapse that ate the east quarter -------------------
    {
      const g = K.geode;
      const gd = Math.hypot(x - g.x, z - g.z);
      if (gd < g.r) {
        const t = 1 - smoothstep(0, g.r, gd);
        // Steep-sided but not a funnel: a broken crust, so the rim is a cliff
        // you swim over and the floor at the bottom is wide enough to fight in.
        y -= Math.pow(t, 1.5) * g.depth;
      }
      // The throat itself, dropping out of the bottom.
      const e = K.exit;
      const ed = Math.hypot(x - e.x, z - e.z);
      if (ed < e.radius * 2.4) {
        y -= (1 - smoothstep(0, e.radius * 2.4, ed)) * 22;
      }
    }

    // --- the cavern seals at the map edge ------------------------------------
    y += this.edgeLift(x, z);
    return y;
  }

  /**
   * How much the sealing rock lifts the floor near the map boundary.
   *
   * The band is kept NARROW (56 m) on purpose. At 88 m the rock started rising
   * before the curtain wall's radius, so the whole ring of ground outside the
   * wall — which is what makes a wall read as a boundary — was buried in the
   * cavern's edge, and the corners closed to an unswimmable slot.
   */
  private edgeLift(x: number, z: number): number {
    const K = KINGDOM;
    const m = 56;
    const t = Math.max(
      1 - smoothstep(K.minX + 4, K.minX + m, x),
      smoothstep(K.maxX - m, K.maxX - 4, x),
      1 - smoothstep(K.minZ + 4, K.minZ + m, z),
      smoothstep(K.maxZ - m, K.maxZ - 4, z),
    );
    return Math.pow(t, 1.5) * 190;
  }

  /**
   * The cavern vault, and the breach punched through it.
   *
   * Deliberately absolute rather than floor-relative: this zone's floor swings
   * 190 m between the geode bottom and the citadel plateau, and a floor-relative
   * roof would ride that swing — giving constant headroom everywhere, which is
   * exactly what kills the sense of height. A fixed vault means the citadel
   * genuinely crowds the ceiling while the geode falls away into the dark.
   */
  ceilingAt(x: number, z: number): number {
    const K = KINGDOM;

    // Annotated: KINGDOM is `as const`, so this would otherwise infer the
    // literal type of the vault height and reject every adjustment below.
    let roof: number = K.vault;
    roof += swellAt(ROOF_DOMES, x, z, 1.1);
    roof -= swellAt(ROOF_SAGS, x, z, 1.3);
    roof += fbm(x * 0.011 + 17.3, z * 0.011 + 41.9, 4) * 22;
    roof += fbm(x * 0.043 + 6.1, z * 0.043 + 22.7, 3) * 5;

    // The breach: a ragged hole above the citadel, opening to black water.
    // Its edge is warped by the same angular trick as the acropolis so the two
    // do not read as concentric circles stamped from the same die.
    {
      const b = K.breach;
      const dx = x - b.x;
      const dz = z - b.z;
      const dist = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      const ragged =
        b.r * (1 + Math.sin(ang * 2.3 + 1.4) * 0.1 + Math.sin(ang * 4.9 - 0.6) * 0.06);
      // A SHORT transition (~14 m). Stretched out, the rim becomes a shallow
      // cone whose normals face away from the shaft and it renders as an
      // unlit smear; compressed, it swings round into a near-vertical cliff
      // that catches the light coming down and reads as broken rock.
      const t = 1 - smoothstep(ragged - 14, ragged, dist);
      roof = lerp(roof, K.sky, t);
    }

    // The vault comes down to meet the floor at the map edge, sealing the
    // cavern. Uses the floor WITHOUT the edge lift plus the lift itself, so the
    // two surfaces close on each other exactly.
    const seal = Math.max(
      1 - smoothstep(K.minX + 4, K.minX + 46, x),
      smoothstep(K.maxX - 46, K.maxX - 4, x),
      1 - smoothstep(K.minZ + 4, K.minZ + 46, z),
      smoothstep(K.maxZ - 46, K.maxZ - 4, z),
    );
    if (seal > 0) {
      const floor = this.heightAt(x, z);
      roof = lerp(roof, floor - 6, seal);
    }
    return roof;
  }

  slopeAt(x: number, z: number): number {
    const e = 1.5;
    const dhx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dhz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dhx, dhz) / (2 * e);
  }

  /** Vertical clearance between floor and vault. */
  clearanceAt(x: number, z: number): number {
    return this.ceilingAt(x, z) - this.heightAt(x, z);
  }

  /** True where the ground is (or was) the city's pavement rather than rock. */
  groundAt(x: number, z: number): Ground {
    if (avenueMask(x, z) > 0.5) return Ground.Paved;
    return this.acroDist(x, z) < KINGDOM.acropolis.plateauR ? Ground.Paved : Ground.Rock;
  }

  /** Distance from the acropolis axis (warped) — the dressing lays out by this. */
  acropolisDist(x: number, z: number): number {
    return this.acroDist(x, z);
  }

  // ---- meshes ------------------------------------------------------------

  build(maps?: TerrainMaps, pavingMaps?: TerrainMaps): { floor: Mesh; roof: Mesh } {
    this.floorMesh = this.buildShell('floor', maps, pavingMaps);
    this.roofMesh = this.buildShell('roof', maps);
    return { floor: this.floorMesh, roof: this.roofMesh };
  }

  /**
   * One shell of the cavern. Floor and roof are the same displaced plane; the
   * roof is DoubleSide for the same reason the cave's is — where it plunges to
   * the map edge, and around the breach, it stops being a ceiling and becomes a
   * cliff seen from the other side.
   */
  private buildShell(kind: 'floor' | 'roof', maps?: TerrainMaps, _paving?: TerrainMaps): Mesh {
    const K = KINGDOM;
    const segs = 216;
    const w = K.maxX - K.minX;
    const d = K.maxZ - K.minZ;
    const geo = new PlaneGeometry(w, d, segs, segs);
    geo.rotateX(-Math.PI / 2);
    geo.translate((K.minX + K.maxX) / 2, 0, (K.minZ + K.maxZ) / 2);

    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const textured = !!maps;
    const roof = kind === 'roof';

    // Two palettes, and which one a vertex gets is the point: the natural rock
    // of the cavern is cold and dark, the city's paving is a paler, warmer
    // dressed stone. Painting them into the same mesh means the ground itself
    // tells you where the city was, all the way to the horizon, for free.
    const rockLight = textured ? new Color(0.78, 0.82, 0.9) : new Color(0x525a64);
    const rockDark = textured ? new Color(0.34, 0.37, 0.44) : new Color(0x252b33);
    const paveLight = textured ? new Color(1.0, 0.97, 0.88) : new Color(0x7d7566);
    const paveDark = textured ? new Color(0.6, 0.57, 0.5) : new Color(0x453f36);
    const crystalStain = textured ? new Color(0.5, 0.72, 0.95) : new Color(0x2b4c6e);
    const tmp = new Color();
    const tmp2 = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = roof ? this.ceilingAt(x, z) : this.heightAt(x, z);
      pos.setY(i, y);

      if (roof) {
        // The vault is cold, dark, and in its own shadow.
        const band = Math.sin(y * 0.3 + fbm(x * 0.02, z * 0.02, 2) * 3.0);
        tmp.copy(rockDark).lerp(rockLight, smoothstep(-0.5, 0.7, band));
        tmp.multiplyScalar(0.5 + fbm(x * 0.09, z * 0.09, 2) * 0.2);
      } else {
        // How "built" this patch of ground is: 1 on the avenue and the citadel
        // plateau, easing off down the acropolis flanks and out into the town.
        const ad = this.acroDist(x, z);
        const built = Math.max(
          avenueMask(x, z),
          1 - smoothstep(K.acropolis.plateauR * 0.8, K.acropolis.r, ad),
          (1 - smoothstep(K.wallR * 0.62, K.wallR, ad)) * 0.42,
        );
        const band = Math.sin(y * 0.36 + fbm(x * 0.02, z * 0.02, 2) * 3.2);
        tmp.copy(rockDark).lerp(rockLight, smoothstep(-0.4, 0.7, band));
        tmp2.copy(paveDark).lerp(paveLight, smoothstep(-0.3, 0.6, band));
        tmp.lerp(tmp2, built);
        // Wear: the paving is broken and silted, so mottle it hard.
        tmp.multiplyScalar(0.82 + fbm(x * 0.11, z * 0.11, 2) * 0.34);

        // Crystal bleeds a cold stain into the rock as you near the geode —
        // the mineral is coming UP through the city, and the floor shows it
        // before you ever see a shard.
        const g = K.geode;
        const gd = Math.hypot(x - g.x, z - g.z);
        const stain = (1 - smoothstep(g.r * 0.5, g.r * 1.5, gd)) * 0.55;
        if (stain > 0.01) tmp.lerp(tmp2.copy(crystalStain), stain);
      }

      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      side: DoubleSide,
    });
    if (maps) {
      mat.map = maps.map;
      mat.normalMap = maps.normalMap;
      mat.normalScale.set(0.85, 0.85);
      if (maps.armMap) {
        mat.aoMap = maps.armMap;
        mat.roughnessMap = maps.armMap;
        mat.metalnessMap = maps.armMap;
        mat.roughness = 1;
        mat.metalness = 1;
      }
    }
    // A little self-illumination on the rock. This zone's only real light comes
    // down one shaft in the middle; without a floor of emissive the whole outer
    // town renders at single-digit luminance and the city may as well not be
    // there. Modulated by the vertex colour, so it lifts the stone without
    // flattening the paved/natural split into a single glow.
    mat.emissive = new Color(0x0d151d);
    mat.emissiveIntensity = 1;

    this.disposables.push(geo, mat);
    const mesh = new Mesh(geo, mat);
    mesh.name = `kingdom-${kind}`;
    return mesh;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

// ---- vault relief ----------------------------------------------------------

interface Swell {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** Domes lifted into the vault, so the ceiling is not one flat lid. */
const ROOF_DOMES: Swell[] = [
  { x: -230, z: -140, r: 150, h: 44 },
  { x: -180, z: 210, r: 140, h: 38 },
  { x: 250, z: -230, r: 150, h: 42 },
  { x: 210, z: 250, r: 130, h: 34 },
  { x: -40, z: 320, r: 120, h: 30 },
  { x: 320, z: 40, r: 118, h: 28 },
  { x: -320, z: 20, r: 116, h: 30 },
];

/** Places the vault sags low, pinching the space between districts. */
const ROOF_SAGS: Swell[] = [
  { x: -150, z: -260, r: 92, h: 46 },
  { x: 120, z: -300, r: 84, h: 40 },
  { x: -290, z: 250, r: 88, h: 44 },
  { x: 60, z: 300, r: 80, h: 36 },
  { x: 300, z: -80, r: 86, h: 40 },
  { x: -60, z: -330, r: 78, h: 34 },
];

function swellAt(list: readonly Swell[], x: number, z: number, power: number): number {
  let sum = 0;
  for (const s of list) {
    const dx = x - s.x;
    const dz = z - s.z;
    const d = Math.hypot(dx, dz);
    if (d < s.r) sum += s.h * Math.pow(1 - smoothstep(s.r * 0.25, s.r, d), power);
  }
  return sum;
}
