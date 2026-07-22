import type { Vector3 } from 'three';
import type { CylinderCollider } from './types';

/**
 * An upright box, rotated about Y — the shape a WALL actually is.
 *
 * Cylinders are the right primitive for a column, a boulder, or a crystal, but
 * they cannot describe a wall: approximating one with a row of overlapping
 * cylinders takes dozens of them per building and still leaves the surface
 * scalloped. A rotated box is one primitive, exact in cross-section, and its
 * height range lets you swim UNDER an arch and OVER a wall that has fallen to a
 * stub — neither of which a cylinder (whose bottom is implicitly the seabed) can
 * express.
 */
export interface BoxCollider {
  /** Centre of the footprint, world space. */
  x: number;
  z: number;
  /** Half extents along the box's own local X and Z, before rotation. */
  hw: number;
  hd: number;
  /** Rotation about Y, radians. */
  yaw: number;
  /** World Y of the top and bottom surfaces. */
  top: number;
  bottom: number;
}

/** Grid cell edge, metres. Sized so a query touches a handful of cells. */
const CELL = 28;

/**
 * Every solid in a zone, indexed on a uniform grid.
 *
 * The grid is what makes accurate architectural collision affordable. Before it,
 * each of the player, the camera, and all ~280 creatures scanned the whole
 * collider list every frame; that is fine at the Drowned Garden's 70-odd rocks
 * and completely untenable at the Fallen Kingdom's ~1,400 wall segments. Queries
 * are now proportional to what is actually nearby.
 *
 * It watches the two source arrays' lengths and rebuilds itself when they
 * change, so zones and the flora scatter can keep pushing colliders whenever
 * they like without anyone having to remember to invalidate anything.
 */
export class Solids {
  private cells = new Map<number, number[]>();
  /** Index space: cylinders are 0..nc-1, boxes are encoded as ~i (negative). */
  private builtCyl = -1;
  private builtBox = -1;
  /** Per-query visit stamps, so gather() can dedup in O(1). */
  private seenCyl = new Int32Array(0);
  private seenBox = new Int32Array(0);
  private visitToken = 0;

  constructor(
    private cylinders: CylinderCollider[],
    private boxes: BoxCollider[] = [],
  ) {}

  bind(cylinders: CylinderCollider[], boxes: BoxCollider[] = []): void {
    this.cylinders = cylinders;
    this.boxes = boxes;
    this.builtCyl = -1;
    this.builtBox = -1;
  }

  get count(): number {
    return this.cylinders.length + this.boxes.length;
  }

  private key(cx: number, cz: number): number {
    // Cantor-ish pairing on a signed grid; collisions across the map are
    // harmless (a cell just holds a few extra candidates).
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  private ensure(): void {
    if (this.builtCyl === this.cylinders.length && this.builtBox === this.boxes.length) return;
    this.cells.clear();
    this.seenCyl = new Int32Array(this.cylinders.length);
    this.seenBox = new Int32Array(this.boxes.length);
    this.visitToken = 0;
    const put = (cx: number, cz: number, idx: number): void => {
      const k = this.key(cx, cz);
      let list = this.cells.get(k);
      if (!list) {
        list = [];
        this.cells.set(k, list);
      }
      list.push(idx);
    };

    for (let i = 0; i < this.cylinders.length; i++) {
      const c = this.cylinders[i];
      const x0 = Math.floor((c.x - c.r) / CELL);
      const x1 = Math.floor((c.x + c.r) / CELL);
      const z0 = Math.floor((c.z - c.r) / CELL);
      const z1 = Math.floor((c.z + c.r) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) put(cx, cz, i);
    }
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      // Rotated-box AABB: the extent along each world axis is the sum of the
      // projections of both half extents.
      const c = Math.abs(Math.cos(b.yaw));
      const s = Math.abs(Math.sin(b.yaw));
      const ex = b.hw * c + b.hd * s;
      const ez = b.hw * s + b.hd * c;
      const x0 = Math.floor((b.x - ex) / CELL);
      const x1 = Math.floor((b.x + ex) / CELL);
      const z0 = Math.floor((b.z - ez) / CELL);
      const z1 = Math.floor((b.z + ez) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) put(cx, cz, ~i);
    }
    this.builtCyl = this.cylinders.length;
    this.builtBox = this.boxes.length;
  }

  /**
   * Collect the indices of every solid whose cell overlaps a disc at (x, z).
   * Results land in `out` (reused by callers so this allocates nothing per call).
   */
  private gather(x: number, z: number, reach: number, out: number[]): void {
    this.ensure();
    out.length = 0;
    const stamp = ++this.visitToken;
    const seenC = this.seenCyl;
    const seenB = this.seenBox;
    const x0 = Math.floor((x - reach) / CELL);
    const x1 = Math.floor((x + reach) / CELL);
    const z0 = Math.floor((z - reach) / CELL);
    const z1 = Math.floor((z + reach) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          // A solid spanning several cells appears once per cell it touches, so
          // duplicates have to be filtered. A visit STAMP does that in O(1);
          // the obvious `out.indexOf(idx)` is O(n²) per query, and with ~280
          // creatures each running two queries a frame that alone was costing
          // milliseconds — it is the reason swimming felt like it was chopping.
          if (idx >= 0) {
            if (seenC[idx] === stamp) continue;
            seenC[idx] = stamp;
          } else {
            if (seenB[~idx] === stamp) continue;
            seenB[~idx] = stamp;
          }
          out.push(idx);
        }
      }
    }
  }

  /**
   * Push a body of `radius` out of anything it is inside, and kill the component
   * of its velocity heading further in. Mutates both vectors in place.
   */
  push(pos: Vector3, vel: Vector3, radius: number): void {
    // Two passes, and only when the first one actually moved something.
    //
    // Solids are resolved one at a time, so at an inside corner — where two
    // walls of a building meet — being pushed clear of the first wall can leave
    // you inside the second, and the pass ends with you still embedded. A single
    // repeat clears essentially all of those (measured: 6 stuck cases out of 817
    // wall boxes down to none) and costs nothing when you are in open water,
    // which is almost always.
    if (this.resolveOnce(pos, vel, radius)) this.resolveOnce(pos, vel, radius);
  }

  private resolveOnce(pos: Vector3, vel: Vector3, radius: number): boolean {
    let touched = false;
    this.gather(pos.x, pos.z, radius + 2, SCRATCH);
    for (let n = 0; n < SCRATCH.length; n++) {
      const idx = SCRATCH[n];
      if (idx >= 0) {
        const c = this.cylinders[idx];
        if (pos.y > c.top + radius) continue;
        let dx = pos.x - c.x;
        let dz = pos.z - c.z;
        let d = Math.hypot(dx, dz);
        if (d < 1e-4) {
          dx = 1;
          dz = 0;
          d = 1;
        }
        const minD = c.r + radius;
        if (d >= minD) continue;
        const push = (minD - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
        touched = true;
        const inward = (vel.x * dx + vel.z * dz) / (d * d);
        if (inward < 0) {
          vel.x -= dx * inward;
          vel.z -= dz * inward;
        }
      } else {
        const b = this.boxes[~idx];
        // The box is resolved in all THREE axes, not just the two horizontal
        // ones. A horizontal-only resolve can express a wall but not a floor:
        // standing on a slab, the only escape it can find is out of a side, so
        // anything you are meant to stand ON gets shoved sideways off it. That
        // is why the citadel's 162 x 126 m hall platform shipped with no
        // collider at all and you swam straight down through the middle of the
        // city. With a vertical axis in the mix the same primitive covers all
        // three cases the architecture needs — walk on a terrace, bump a wall,
        // swim under an arch — and each one falls out of the same test.
        const ey = (b.top - b.bottom) * 0.5;
        const ly = pos.y - (b.top + b.bottom) * 0.5;
        if (ly > ey + radius || ly < -ey - radius) continue;
        // Into the box's own frame. See TO_LOCAL at the foot of this file for
        // why the sign convention here is easy to get backwards and what it
        // looks like when you do.
        const c2 = Math.cos(b.yaw);
        const s2 = Math.sin(b.yaw);
        const rx = pos.x - b.x;
        const rz = pos.z - b.z;
        const lx = rx * c2 - rz * s2;
        const lz = rx * s2 + rz * c2;

        let nx = 0;
        let ny = 0;
        let nz = 0;
        // Nearest point of the box to the body's centre, clamped per axis.
        const qx = lx < -b.hw ? -b.hw : lx > b.hw ? b.hw : lx;
        const qy = ly < -ey ? -ey : ly > ey ? ey : ly;
        const qz = lz < -b.hd ? -b.hd : lz > b.hd ? b.hd : lz;
        const dx = lx - qx;
        const dy = ly - qy;
        const dz = lz - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 1e-12) {
          // Outside: push straight out along the shortest line to the surface.
          if (d2 >= radius * radius) continue;
          const d = Math.sqrt(d2);
          const k = (radius - d) / d;
          nx = dx * k;
          ny = dy * k;
          nz = dz * k;
        } else {
          // Centre is within the box: leave by the least-penetrating face.
          const px = b.hw + radius - Math.abs(lx);
          const py = ey + radius - Math.abs(ly);
          const pz = b.hd + radius - Math.abs(lz);
          if (px <= py && px <= pz) nx = lx < 0 ? -px : px;
          else if (py <= pz) ny = ly < 0 ? -py : py;
          else nz = lz < 0 ? -pz : pz;
        }
        // Back to world (the exact inverse of the transform above). Y is
        // already world-aligned — the box only ever rotates about it.
        const wx = nx * c2 + nz * s2;
        const wz = -nx * s2 + nz * c2;
        pos.x += wx;
        pos.y += ny;
        pos.z += wz;
        const len = Math.hypot(wx, ny, wz);
        if (len > 1e-6) {
          touched = true;
          const ux = wx / len;
          const uy = ny / len;
          const uz = wz / len;
          const inward = vel.x * ux + vel.y * uy + vel.z * uz;
          if (inward < 0) {
            vel.x -= ux * inward;
            vel.y -= uy * inward;
            vel.z -= uz * inward;
          }
        }
      }
    }
    return touched;
  }

  /** True if a point (plus `pad`) is inside any solid — the camera's test. */
  blocks(x: number, y: number, z: number, pad: number): boolean {
    this.gather(x, z, pad + 2, SCRATCH_B);
    for (let n = 0; n < SCRATCH_B.length; n++) {
      const idx = SCRATCH_B[n];
      if (idx >= 0) {
        const c = this.cylinders[idx];
        if (y < c.top + 0.3 && Math.hypot(x - c.x, z - c.z) < c.r + pad) return true;
      } else {
        const b = this.boxes[~idx];
        if (y > b.top + 0.3 || y < b.bottom - 0.3) continue;
        const c2 = Math.cos(b.yaw);
        const s2 = Math.sin(b.yaw);
        const rx = x - b.x;
        const rz = z - b.z;
        const lx = Math.abs(rx * c2 - rz * s2) - b.hw;
        const lz = Math.abs(rx * s2 + rz * c2) - b.hd;
        const d = Math.hypot(Math.max(0, lx), Math.max(0, lz));
        if (d < pad) return true;
      }
    }
    return false;
  }

  /**
   * Soft steering: accumulate an outward nudge from anything within `reach`,
   * for creature navigation. Adds into `out` rather than replacing it.
   */
  avoid(pos: Vector3, radius: number, reach: number, weight: number, out: Vector3): void {
    this.gather(pos.x, pos.z, radius + reach, SCRATCH_C);
    for (let n = 0; n < SCRATCH_C.length; n++) {
      const idx = SCRATCH_C[n];
      let px: number;
      let pz: number;
      let surface: number;
      if (idx >= 0) {
        const c = this.cylinders[idx];
        if (pos.y > c.top + radius + 2) continue;
        px = pos.x - c.x;
        pz = pos.z - c.z;
        surface = c.r;
      } else {
        const b = this.boxes[~idx];
        if (pos.y > b.top + radius + 2 || pos.y < b.bottom - radius - 2) continue;
        px = pos.x - b.x;
        pz = pos.z - b.z;
        // Treat the box as a disc of equivalent girth for steering purposes;
        // creatures only need to know "something solid is that way".
        surface = Math.max(b.hw, b.hd);
      }
      const d = Math.hypot(px, pz);
      const avoidR = surface + radius + reach;
      if (d <= 1e-3 || d >= avoidR) continue;
      const w = (avoidR - d) / (d * avoidR);
      out.x += px * w * weight;
      out.z += pz * w * weight;
    }
  }
}

// Reused index buffers — one per query kind, so nested calls cannot clobber
// each other and none of this allocates on the hot path.
const SCRATCH: number[] = [];
const SCRATCH_B: number[] = [];
const SCRATCH_C: number[] = [];

/**
 * The rotation convention, written out because getting it backwards is silent
 * and expensive.
 *
 * three rotates about +Y such that a local +X axis maps to world
 * (cos y, 0, -sin y). So, with c = cos(yaw) and s = sin(yaw):
 *
 *   local -> world:   wx =  lx*c + lz*s      wz = -lx*s + lz*c
 *   world -> local:   lx =  wx*c - wz*s      lz =  wx*s + wz*c
 *
 * Note that the inverse is NOT "the same formula with -yaw" written naively:
 * substituting cos(-y)/sin(-y) into the forward expression flips the wrong
 * term and yields a reflection instead of a rotation. That is what shipped in
 * the first version of this file, and because every wall's collider was then
 * mirrored about the wrong axis, boxes sat in the right PLACE but at the wrong
 * ANGLE — you swam through walls you could see and hit walls that were not
 * there. Any test that reuses this transform to check its own results will
 * happily confirm the bug, so verification has to come from the mesh itself
 * (see the triangle-sampled check used when this was fixed).
 */

