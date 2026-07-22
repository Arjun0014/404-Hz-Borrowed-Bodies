import {
  BoxGeometry,
  type BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural masonry: the Fallen Kingdom builds its own ruins.
 *
 * Every archetype here is generated from blocks rather than imported, and that
 * is a deliberate call. An imported ruin is one fixed silhouette — place it
 * twice and the eye instantly reads "asset", which is precisely what made the
 * previous version of this zone feel like props dropped on a surface. Masonry
 * generated course by course gives three things a model cannot:
 *
 *  1. **Damage that means something.** A wall knows where its own top is, so it
 *     can decay along its length, lose a merlon, or be sheared open by a breach
 *     at a specific place. Ruin is authored, not baked.
 *  2. **Unlimited silhouettes for one memory cost.** A dozen variants per
 *     archetype cover a whole city; every instance is a different building.
 *  3. **Correct scale everywhere.** Courses stay ~1.6 m whatever the wall's
 *     size, so a 12 m hut and a 40 m tower are built out of the same stone and
 *     read against each other properly.
 *
 * Conventions every generator obeys, so callers can place blindly:
 *  - the piece sits ON y = 0 (base at the origin plane), centred on x/z;
 *  - dimensions are REAL METRES, not normalised — instance scale is for
 *    variation only and should stay near 1, or the courses stop reading as
 *    stone of a consistent size;
 *  - output carries position/normal/uv only, so anything here can be merged
 *    with anything else here.
 */

// ---- shared helpers --------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);
const FWD = new Vector3(0, 0, 1);

/** Push one transformed box into an accumulator. The workhorse of this module. */
function block(
  out: BufferGeometry[],
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  rand: () => number,
  jitter = 1,
): void {
  const g = new BoxGeometry(w, h, d);
  // Every stone is cut and set slightly wrong: that irregularity, at ~3% of the
  // block size, is the whole difference between "masonry" and "brick texture".
  const m = new Matrix4();
  const q = new Quaternion();
  const tilt = new Quaternion();
  q.setFromAxisAngle(UP, (rand() - 0.5) * 0.06 * jitter);
  tilt.setFromAxisAngle(RIGHT, (rand() - 0.5) * 0.05 * jitter);
  q.multiply(tilt);
  tilt.setFromAxisAngle(FWD, (rand() - 0.5) * 0.05 * jitter);
  q.multiply(tilt);
  m.compose(
    new Vector3(
      x + (rand() - 0.5) * w * 0.05 * jitter,
      y + (rand() - 0.5) * h * 0.06 * jitter,
      z + (rand() - 0.5) * d * 0.05 * jitter,
    ),
    q,
    new Vector3(1, 1, 1),
  );
  g.applyMatrix4(m);
  out.push(g);
}

/** Merge an accumulator into one geometry and free the parts. */
function finish(parts: BufferGeometry[]): BufferGeometry {
  if (parts.length === 0) return new BufferGeometry();
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
  if (parts.length > 1) for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** Smooth 1-D value noise on a 0..1 parameter — used for ruin profiles. */
function ridge(u: number, seed: number, freq: number): number {
  const h = (i: number): number => {
    let n = (i * 374761393 + seed * 668265263) | 0;
    n = (n ^ (n >> 13)) | 0;
    n = Math.imul(n, 1274126177);
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };
  const t = u * freq;
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * s;
}

// ---- coursed walls ---------------------------------------------------------

export interface WallOpts {
  length: number;
  height: number;
  thickness: number;
  /** 0 = intact, 1 = barely a footing. Drives how much of the top is missing. */
  ruin?: number;
  /** Add merlons along whatever of the top survives. */
  crenellated?: boolean;
  /** Fractional position (0..1) of a hole punched clean through, if any. */
  breachAt?: number;
  breachWidth?: number;
  /** Window openings: rows of gaps left in the courses. */
  windows?: boolean;
  courseHeight?: number;
}

/**
 * A wall built course by course, running along X and centred on the origin.
 *
 * The ruin profile is the interesting part. Rather than shaving a flat
 * percentage off the top, the surviving height is driven by two octaves of
 * 1-D noise along the wall's length, biased by `ruin`. That produces the real
 * signature of a collapsed wall — tall stubs where the masonry was keyed into
 * something, long low runs where it simply fell — instead of a uniform sawtooth.
 */
export function makeWall(seed: number, opts: WallOpts): BufferGeometry {
  const rand = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  const {
    length,
    height,
    thickness,
    ruin = 0.3,
    crenellated = false,
    breachAt = -1,
    breachWidth = 0.16,
    windows = false,
    courseHeight = 1.7,
  } = opts;

  const courses = Math.max(1, Math.round(height / courseHeight));
  const ch = height / courses;

  // Surviving height at a fractional position along the wall.
  const topAt = (u: number): number => {
    const n = ridge(u, seed, 3.5) * 0.65 + ridge(u, seed + 91, 9) * 0.35;
    // `ruin` sets how far down the noise can bite; the 0.25 floor keeps a
    // footing everywhere so the wall never fully disappears mid-run.
    const keep = 1 - ruin * (0.35 + n * 0.9);
    return Math.max(0.12, Math.min(1, keep));
  };

  for (let c = 0; c < courses; c++) {
    const y = c * ch + ch / 2;
    const cu = (c + 0.5) / courses;
    // Alternate courses are offset by half a block: the bond pattern is what
    // makes stacked boxes read as masonry rather than as a grid.
    const blockW = 2.5 + rand() * 1.3;
    const n = Math.max(1, Math.round(length / blockW));
    const bw = length / n;
    const offset = c % 2 === 0 ? 0 : bw * 0.5;

    for (let i = 0; i <= n; i++) {
      const x = -length / 2 + offset + i * bw + bw / 2;
      if (x - bw / 2 < -length / 2 - 0.1 || x + bw / 2 > length / 2 + 0.1) continue;
      const u = (x + length / 2) / length;

      if (cu > topAt(u)) continue; // above the surviving line: this stone is gone
      // A clean breach punched through the full height.
      if (breachAt >= 0 && Math.abs(u - breachAt) < breachWidth) {
        // Ragged jambs rather than a rectangular doorway.
        const edge = Math.abs(u - breachAt) / breachWidth;
        if (cu < 0.55 + edge * 0.5) continue;
      }
      // Windows: a band of openings on one course row, regularly spaced.
      if (windows && c === Math.floor(courses * 0.55) && i % 3 === 1) continue;
      if (windows && c === Math.floor(courses * 0.55) + 1 && i % 3 === 1 && rand() < 0.7) continue;

      // Stones nearer the broken top have spalled and sit loose.
      const decay = cu / Math.max(0.01, topAt(u));
      const shrink = 1 - decay * decay * 0.18 * (0.4 + rand());
      block(
        parts,
        x,
        y,
        0,
        bw * 0.96 * shrink,
        ch * 0.94,
        thickness * (0.9 + rand() * 0.18) * shrink,
        rand,
        1 + decay,
      );
    }
  }

  // Merlons on whatever runs still reach near full height.
  if (crenellated) {
    const mw = 2.6;
    const n = Math.floor(length / (mw * 2));
    for (let i = 0; i < n; i++) {
      const x = -length / 2 + mw + i * mw * 2 + mw / 2;
      const u = (x + length / 2) / length;
      if (topAt(u) < 0.94) continue; // only where the parapet survived
      if (rand() < 0.22) continue; // and a few knocked out anyway
      block(parts, x, height + ch * 0.9, 0, mw, ch * 1.8, thickness * 0.85, rand);
    }
  }

  return finish(parts);
}

// ---- columns ---------------------------------------------------------------

export interface ColumnOpts {
  height: number;
  radius: number;
  /** 0 = whole, 1 = a stump. Snaps the shaft off partway up. */
  ruin?: number;
  /** Square plinth under the shaft. */
  plinth?: boolean;
  /** Abacus block on top (skipped automatically if the shaft is broken). */
  capital?: boolean;
  fluted?: boolean;
}

/**
 * A drum-built column: plinth, stacked drums, capital.
 *
 * Assembled from separate drums rather than one tapered cylinder so a broken
 * column can shear at a joint — which is how real columns fail, and it means
 * the drums lying beside a fallen one are literally the same geometry.
 */
export function makeColumn(seed: number, opts: ColumnOpts): BufferGeometry {
  const rand = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  const { height, radius, ruin = 0, plinth = true, capital = true, fluted = true } = opts;

  const broken = ruin > 0.02;
  // Break at a drum joint, never mid-drum.
  const shaftH = height * (broken ? 0.18 + (1 - ruin) * 0.72 : 1);

  let y = 0;
  if (plinth) {
    const ph = radius * 0.5;
    block(parts, 0, ph / 2, 0, radius * 2.6, ph, radius * 2.6, rand, 0.4);
    y += ph;
  }

  const drumH = radius * 1.55;
  const drums = Math.max(1, Math.round((shaftH - y) / drumH));
  const dh = (shaftH - y) / drums;
  for (let i = 0; i < drums; i++) {
    const t = i / drums;
    // Entasis: a real column swells slightly low and tapers to the neck.
    const rTop = radius * (1 - (t + 1 / drums) * 0.16) * (1 + Math.sin((t + 0.1) * 2.2) * 0.02);
    const rBot = radius * (1 - t * 0.16) * (1 + Math.sin(t * 2.2) * 0.02);
    const g = new CylinderGeometry(rTop, rBot, dh * 0.99, fluted ? 14 : 9, 1);
    if (fluted) {
      // Pull alternate radial columns of vertices inward. At 14 segments that
      // is 7 flutes, which at these radii is the density that still reads as
      // fluting from across a plaza rather than dissolving into noise.
      const pos = g.attributes.position as BufferAttribute;
      for (let v = 0; v < pos.count; v++) {
        const px = pos.getX(v);
        const pz = pos.getZ(v);
        const r = Math.hypot(px, pz);
        if (r < 1e-4) continue;
        const a = Math.atan2(pz, px);
        const f = 1 - Math.abs(Math.cos(a * 7)) * 0.09;
        pos.setX(v, (px / r) * r * f);
        pos.setZ(v, (pz / r) * r * f);
      }
    }
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(UP, rand() * Math.PI * 2);
    const tilt = new Quaternion().setFromAxisAngle(RIGHT, (rand() - 0.5) * 0.02);
    q.multiply(tilt);
    // Drums slip a little on their beds as the building settles.
    m.compose(
      new Vector3((rand() - 0.5) * radius * 0.08, y + dh / 2, (rand() - 0.5) * radius * 0.08),
      q,
      new Vector3(1, 1, 1),
    );
    g.applyMatrix4(m);
    parts.push(g);
    y += dh;
  }

  if (capital && !broken) {
    const cr = radius * 1.35;
    block(parts, 0, y + cr * 0.22, 0, cr * 1.7, cr * 0.45, cr * 1.7, rand, 0.4);
    block(parts, 0, y + cr * 0.62, 0, cr * 2.1, cr * 0.35, cr * 2.1, rand, 0.4);
  }

  return finish(parts);
}

/** A single fallen column drum, for the rubble that pools around a broken shaft. */
export function makeDrum(seed: number, radius: number): BufferGeometry {
  const rand = mulberry32(seed);
  const h = radius * 1.55;
  const g = new CylinderGeometry(radius * 0.97, radius, h, 12, 1);
  const pos = g.attributes.position as BufferAttribute;
  for (let v = 0; v < pos.count; v++) {
    const px = pos.getX(v);
    const pz = pos.getZ(v);
    const r = Math.hypot(px, pz);
    if (r < 1e-4) continue;
    const a = Math.atan2(pz, px);
    const f = 1 - Math.abs(Math.cos(a * 7)) * 0.09 + (rand() - 0.5) * 0.05;
    pos.setX(v, px * f);
    pos.setZ(v, pz * f);
  }
  // Laid on its SIDE and rolled to rest: this is a drum that has fallen.
  g.rotateX(Math.PI / 2);
  g.translate(0, radius, 0);
  g.computeVertexNormals();
  return g;
}

// ---- arches ----------------------------------------------------------------

export interface ArchOpts {
  span: number;
  /** Height of the springing line — where the piers stop and the curve starts. */
  pierHeight: number;
  thickness: number;
  width: number;
  /** 0 = complete, 1 = only the piers left. Voussoirs drop off from one side. */
  ruin?: number;
}

/**
 * A free-standing arch: two piers and a semicircular ring of voussoirs.
 *
 * Voussoirs are laid on the arc with their long axis radial, which is what makes
 * an arch look structural instead of like a bent tube. Ruin removes them from
 * one haunch inward, so a half-fallen arch keeps a plausible cantilever rather
 * than losing stones at random.
 */
export function makeArch(seed: number, opts: ArchOpts): BufferGeometry {
  const rand = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  const { span, pierHeight, thickness, width, ruin = 0 } = opts;
  const r = span / 2;

  // Piers, built as proper coursed masonry so they match the walls.
  for (const side of [-1, 1]) {
    const courses = Math.max(2, Math.round(pierHeight / 1.7));
    const ch = pierHeight / courses;
    for (let c = 0; c < courses; c++) {
      block(parts, side * (r + width / 2), c * ch + ch / 2, 0, width, ch * 0.95, thickness, rand);
    }
  }

  // The ring. `keep` walks in from the +X haunch as ruin rises.
  const N = Math.max(7, Math.round((Math.PI * r) / 2.6));
  const keep = 1 - ruin;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N; // 0 at +X springing, 1 at -X springing
    if (t > keep) continue;
    const a = t * Math.PI;
    const cx = Math.cos(a) * (r + width / 2);
    const cy = pierHeight + Math.sin(a) * (r + width / 2);
    const g = new BoxGeometry((Math.PI * r) / N, width, thickness);
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(FWD, a + Math.PI / 2);
    m.compose(new Vector3(cx, cy, 0), q, new Vector3(1, 1, 1));
    g.applyMatrix4(m);
    parts.push(g);
    // The stone that was next to the break is always half out of its seat.
    if (t > keep - 0.06 && rand() < 0.5) {
      const gg = new BoxGeometry((Math.PI * r) / N * 0.8, width * 0.8, thickness * 0.8);
      const mm = new Matrix4();
      const qq = new Quaternion().setFromAxisAngle(FWD, a + Math.PI / 2 + 0.3);
      mm.compose(new Vector3(cx - 1.2, cy - 1.6, 0.4), qq, new Vector3(1, 1, 1));
      gg.applyMatrix4(mm);
      parts.push(gg);
    }
  }

  return finish(parts);
}

// ---- buildings -------------------------------------------------------------

export interface BuildingOpts {
  width: number;
  depth: number;
  height: number;
  ruin?: number;
  /** Leave one corner sheared away entirely. */
  collapsedCorner?: boolean;
  /** Interior cross-walls, so a bigger shell reads as rooms. */
  rooms?: boolean;
}

/**
 * A roofless building shell: four coursed walls around a footprint.
 *
 * The town is made of these, and their job is to read as STREETS from above.
 * Each gets a doorway on one face, window openings, an uneven ruin line, and
 * optionally a sheared corner — enough variation that a dozen variants tile a
 * whole district without repeating visibly.
 */
export function makeBuilding(seed: number, opts: BuildingOpts): BufferGeometry {
  const rand = mulberry32(seed);
  const { width, depth, height, ruin = 0.4, collapsedCorner = false, rooms = false } = opts;
  const parts: BufferGeometry[] = [];
  const th = 1.1 + rand() * 0.5;

  // Which face gets the door, and which corner (if any) is gone.
  const doorFace = Math.floor(rand() * 4);
  const goneCorner = collapsedCorner ? Math.floor(rand() * 4) : -1;

  const faces: { len: number; x: number; z: number; rot: number }[] = [
    { len: width, x: 0, z: -depth / 2, rot: 0 },
    { len: width, x: 0, z: depth / 2, rot: 0 },
    { len: depth, x: -width / 2, z: 0, rot: Math.PI / 2 },
    { len: depth, x: width / 2, z: 0, rot: Math.PI / 2 },
  ];

  faces.forEach((f, i) => {
    // A corner collapse takes the ends off the two walls that met there.
    let localRuin = ruin;
    if (goneCorner >= 0 && (i === goneCorner % 4 || i === (goneCorner + 2) % 4)) {
      localRuin = Math.min(0.92, ruin + 0.4);
    }
    const wall = makeWall(seed * 31 + i * 7, {
      length: f.len,
      height: height * (0.85 + rand() * 0.3),
      thickness: th,
      ruin: localRuin,
      windows: true,
      breachAt: i === doorFace ? 0.5 : -1,
      breachWidth: i === doorFace ? 0.14 : 0,
      courseHeight: 1.5,
    });
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(UP, f.rot);
    m.compose(new Vector3(f.x, 0, f.z), q, new Vector3(1, 1, 1));
    wall.applyMatrix4(m);
    parts.push(wall);
  });

  if (rooms && width > 16) {
    const wall = makeWall(seed * 77, {
      length: depth * 0.9,
      height: height * 0.6,
      thickness: th * 0.8,
      ruin: Math.min(0.95, ruin + 0.25),
      courseHeight: 1.5,
    });
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(UP, Math.PI / 2);
    m.compose(new Vector3((rand() - 0.5) * width * 0.3, 0, 0), q, new Vector3(1, 1, 1));
    wall.applyMatrix4(m);
    parts.push(wall);
  }

  // Rubble pooled inside, from the roof and the missing courses.
  const heaps = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < heaps; i++) {
    const s = 1 + rand() * 2.4;
    block(
      parts,
      (rand() - 0.5) * width * 0.7,
      s * 0.3,
      (rand() - 0.5) * depth * 0.7,
      s * 2,
      s,
      s * 1.6,
      rand,
      3,
    );
  }

  return finish(parts);
}

/** A square tower: taller, thicker-walled, crenellated, on the curtain wall. */
export function makeTower(seed: number, side: number, height: number, ruin = 0.3): BufferGeometry {
  const rand = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  const th = 2.2 + rand() * 0.8;
  for (let i = 0; i < 4; i++) {
    const rot = (i * Math.PI) / 2;
    const wall = makeWall(seed * 13 + i * 5, {
      length: side,
      height: height * (0.9 + rand() * 0.2),
      thickness: th,
      ruin: ruin * (0.6 + rand() * 0.8),
      crenellated: true,
      windows: i % 2 === 0,
    });
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(UP, rot);
    m.compose(
      new Vector3(Math.sin(rot) * (side / 2), 0, -Math.cos(rot) * (side / 2)),
      q,
      new Vector3(1, 1, 1),
    );
    wall.applyMatrix4(m);
    parts.push(wall);
  }
  // A batter (flared skirt) at the base — reads as fortification, not a box.
  const courses = 3;
  for (let c = 0; c < courses; c++) {
    const y = c * 1.8;
    const flare = side + (courses - c) * 2.2;
    for (let i = 0; i < 4; i++) {
      const rot = (i * Math.PI) / 2;
      const g = new BoxGeometry(flare, 1.75, th * 1.4);
      const m = new Matrix4();
      const q = new Quaternion().setFromAxisAngle(UP, rot);
      m.compose(
        new Vector3(Math.sin(rot) * (flare / 2), y + 0.9, -Math.cos(rot) * (flare / 2)),
        q,
        new Vector3(1, 1, 1),
      );
      g.applyMatrix4(m);
      parts.push(g);
    }
  }
  return finish(parts);
}

// ---- stairs ----------------------------------------------------------------

/**
 * A flight of steps, climbing along +Z from y=0. Used to walk the acropolis
 * terraces, so the citadel has a way up that was clearly built rather than
 * eroded.
 */
export function makeStairs(
  seed: number,
  width: number,
  steps: number,
  rise: number,
  run: number,
): BufferGeometry {
  const rand = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    // A few treads are cracked out of line, and a few missing entirely.
    if (rand() < 0.06) continue;
    const w = width * (0.94 + rand() * 0.1);
    // Each tread is a slab sitting on the fill below it, so the flight has mass.
    block(parts, 0, (i + 0.5) * rise, (i + 0.5) * run, w, rise, run * 1.05, rand, 1.4);
    if (rand() < 0.35) {
      // A broken-off corner slab tumbled onto the flight.
      const s = rise * (1.4 + rand() * 1.6);
      block(
        parts,
        (rand() - 0.5) * w * 0.8,
        (i + 1) * rise + s * 0.4,
        (i + 0.5) * run,
        s,
        s * 0.6,
        s,
        rand,
        4,
      );
    }
  }
  // Cheek walls either side, so the flight is contained.
  for (const side of [-1, 1]) {
    for (let i = 0; i < steps; i++) {
      if (rand() < 0.25) continue;
      block(
        parts,
        (side * width) / 2 + side * 1.2,
        (i + 0.5) * rise + rise * 0.9,
        (i + 0.5) * run,
        2.4,
        rise * 2.2,
        run,
        rand,
        1.6,
      );
    }
  }
  return finish(parts);
}

// ---- natural rock ----------------------------------------------------------

/**
 * An angular rock chunk. A displaced icosahedron rather than a smoothed blob:
 * this cavern's stone is fractured, and flat facets meeting at hard edges is
 * what sells that. Base sits on y=0, footprint normalised to 1 so instance
 * scale reads directly as metres across.
 */
export function makeRubble(seed: number, detail = 0): BufferGeometry {
  const rand = mulberry32(seed);
  const g = new IcosahedronGeometry(0.5, detail);
  const pos = g.attributes.position as BufferAttribute;
  // Per-vertex radial displacement, plus a global squash so chunks are slabby
  // rather than spherical.
  const sx = 0.7 + rand() * 0.7;
  const sy = 0.4 + rand() * 0.6;
  const sz = 0.7 + rand() * 0.7;
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Shared vertices must move together or the hull tears open.
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let f = seen.get(key);
    if (f === undefined) {
      f = 0.72 + rand() * 0.56;
      seen.set(key, f);
    }
    pos.setX(i, x * f * sx);
    pos.setY(i, y * f * sy);
    pos.setZ(i, z * f * sz);
  }
  g.computeVertexNormals();
  // Normalise: base on y=0, longest horizontal axis 1.
  const box = new Vector3();
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < pos.count; i++) {
    min.x = Math.min(min.x, pos.getX(i));
    min.y = Math.min(min.y, pos.getY(i));
    min.z = Math.min(min.z, pos.getZ(i));
    max.x = Math.max(max.x, pos.getX(i));
    max.y = Math.max(max.y, pos.getY(i));
    max.z = Math.max(max.z, pos.getZ(i));
  }
  box.subVectors(max, min);
  const s = 1 / Math.max(box.x, box.z, 1e-4);
  g.translate(-(min.x + max.x) / 2, -min.y, -(min.z + max.z) / 2);
  g.scale(s, s, s);
  return g;
}

/**
 * A tilted rock SLAB — a sheet of bedrock levered up out of the floor. These do
 * the job that boulders cannot: they give the cavern floor strong diagonal
 * lines, which is what stops a wide open plain reading as flat.
 */
export function makeSlab(seed: number): BufferGeometry {
  const rand = mulberry32(seed);
  const parts: BufferGeometry[] = [];
  const layers = 2 + Math.floor(rand() * 3);
  let y = 0;
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const w = 1 - t * (0.2 + rand() * 0.3);
    const h = 0.1 + rand() * 0.16;
    const g = new BoxGeometry(w, h, w * (0.6 + rand() * 0.5));
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(UP, rand() * Math.PI * 2);
    const tilt = new Quaternion().setFromAxisAngle(RIGHT, (rand() - 0.5) * 0.5);
    q.multiply(tilt);
    m.compose(new Vector3((rand() - 0.5) * 0.12, y + h / 2, (rand() - 0.5) * 0.12), q, new Vector3(1, 1, 1));
    g.applyMatrix4(m);
    parts.push(g);
    y += h * 0.85;
  }
  const merged = finish(parts);
  // Normalise to unit height so instance scale.y maps to metres.
  merged.scale(1, 1 / Math.max(y, 1e-4), 1);
  return merged;
}
