import {
  BufferAttribute,
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  type Vector3,
} from 'three';
import type { TerrainLike, TerrainMaps } from './types';

/**
 * The Fallen Kingdom's shape: a wide, upright CYLINDER — a drowned well — open at
 * the top (where you drop in) and the bottom (where you descend on). Unlike the
 * open shelf or the domed cave, this zone's defining feature is a genuinely
 * VERTICAL wall running its whole height, which a single-valued heightfield floor
 * cannot express. So the wall is not terrain at all: it is a real cylinder mesh
 * (built by FallenKingdom) plus a radial containment function ({@link containAt})
 * the swim controller applies at every height. This class owns only the analytic
 * FLOOR — a rubble basin that funnels down into the central exit shaft — and the
 * floor mesh. The roof is deliberately absent: the top is open sky.
 */

// ---- shaft dimensions (metres) -------------------------------------------

export const SHAFT = {
  /** Inner wall radius. Diameter 440 — wide, and about half the Garden's span. */
  radius: 220,
  /** Floor baseline the rubble sits around. */
  floorY: 0,
  /** Top of the stone wall — the play cap sits just above it (open top). */
  wallTop: 420,
  /** Hard upward cap for bounds; a hair over the wall so the rim reads as a lip. */
  ceilingY: 432,
  /** The central exit shaft: swim down its throat to descend to the next zone. */
  exit: { x: 0, z: 0, radius: 46 },
  /** You arrive high in the well, off-centre, so the whole drop is below you. */
  spawn: { x: 34, z: 150, y: 372 },
  softMargin: 30,
} as const;

// ---- deterministic value noise (same recipe as the other zones) ----------

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

export class ShaftTerrain implements TerrainLike {
  floorMesh!: Mesh;
  private readonly disposables: { dispose(): void }[] = [];

  // ---- analytic shape ----------------------------------------------------

  /** World-space floor height at (x, z). Inside the exit it plunges away. */
  heightAt(x: number, z: number): number {
    const ex = SHAFT.exit;
    const r = Math.hypot(x - ex.x, z - ex.z);

    // The exit shaft: a dark central throat you descend on. Deep and steep so it
    // reads as a way DOWN rather than a dent in the floor.
    if (r < ex.radius) return SHAFT.floorY - 120;

    // Broken rubble basin — low dunes plus a ridged fracture component, so the
    // floor of the sunken kingdom reads as shattered flagstones and silt.
    let y = SHAFT.floorY + 1 + fbm(x * 0.008 + 4.1, z * 0.008 + 9.3, 4) * 12;
    const rn = fbm(x * 0.02 + 17.7, z * 0.02 + 3.1, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    y += ridged * ridged * 7;

    // Funnel: the whole basin dishes gently down toward the exit throat, so the
    // water — and the eye — is drawn to the way out at the very bottom-centre.
    const funnel = 1 - smoothstep(ex.radius, ex.radius * 4.0, r);
    y -= Math.pow(funnel, 1.6) * 34;

    // Skirt: the floor lifts to meet the foot of the wall, so basin and wall join
    // in a bank of rubble rather than a visible seam. Beyond the wall the floor
    // keeps climbing (hidden behind the opaque wall) so nothing shows through it.
    const rad = Math.hypot(x, z);
    y += smoothstep(SHAFT.radius * 0.84, SHAFT.radius, rad) * 12;
    y += smoothstep(SHAFT.radius, SHAFT.radius + 40, rad) * 160;

    return y;
  }

  slopeAt(x: number, z: number): number {
    const e = 1.5;
    const dhx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dhz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dhx, dhz) / (2 * e);
  }

  /**
   * Push the host radially back inside the cylinder wall, at any height. Mirrors
   * the swim controller's own box-bounds clamp: a soft margin that nudges the
   * velocity inward, then a hard clamp once the host has pushed past it. Fitted to
   * the body via `radius` so it stops flush against the wall, not floating off it.
   */
  containAt(pos: Vector3, vel: Vector3, radius: number, dt: number): void {
    // wall = the max distance from the axis at which the body's edge just touches
    // the stone at SHAFT.radius. The soft margin is INSIDE that (unlike the box
    // clamp, whose margin sits outside its bound) because here the wall is a solid
    // visual surface: the host must never be pushed PAST it, only up to it.
    const wall = SHAFT.radius - radius;
    const soft = wall - SHAFT.softMargin;
    const r = Math.hypot(pos.x, pos.z);
    if (r <= soft) return;
    const nx = r > 1e-4 ? pos.x / r : 1;
    const nz = r > 1e-4 ? pos.z / r : 0;
    const push = Math.min(1, (r - soft) / SHAFT.softMargin);
    vel.x -= nx * push * 20 * dt;
    vel.z -= nz * push * 20 * dt;
    if (r > wall) {
      pos.x = nx * wall;
      pos.z = nz * wall;
    }
  }

  // ---- floor mesh --------------------------------------------------------

  build(maps?: TerrainMaps): { floor: Mesh } {
    this.floorMesh = this.buildFloor(maps);
    return { floor: this.floorMesh };
  }

  private buildFloor(maps?: TerrainMaps): Mesh {
    const segs = 200;
    const span = (SHAFT.radius + 30) * 2;
    const geo = new PlaneGeometry(span, span, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const textured = !!maps;

    // A cold stone basin, tinted toward the crystal palette so the floor belongs
    // to the same place as the gems growing out of it.
    const stoneLight = textured ? new Color(0.86, 0.9, 1.0) : new Color(0x545e6e);
    const stoneDark = textured ? new Color(0.4, 0.43, 0.52) : new Color(0x262b36);
    const violet = textured ? new Color(0.5, 0.42, 0.68) : new Color(0x2c2340);
    const black = textured ? new Color(0.05, 0.06, 0.09) : new Color(0x05070c);
    const tmp = new Color();
    const tmp2 = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.heightAt(x, z);
      pos.setY(i, y);

      // Banded strata for a sedimentary, built-then-drowned look.
      const band = Math.sin(y * 0.4 + fbm(x * 0.02, z * 0.02, 2) * 3.0);
      tmp.copy(stoneDark).lerp(stoneLight, smoothstep(-0.4, 0.7, band));
      // A faint amethyst wash, clustered, hinting at the crystal beneath.
      const vt = smoothstep(0.66, 0.86, fbm(x * 0.026 + 51.1, z * 0.026 + 12.4, 3));
      tmp.lerp(tmp2.copy(violet), vt * 0.5);
      tmp.multiplyScalar(0.84 + fbm(x * 0.1, z * 0.1, 2) * 0.3);
      // Darken toward the exit throat so the depths read as a mystery below.
      const r = Math.hypot(x - SHAFT.exit.x, z - SHAFT.exit.z);
      tmp.lerp(tmp2.copy(black), (1 - smoothstep(SHAFT.exit.radius, SHAFT.exit.radius * 3.6, r)) * 0.7);
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
      emissive: new Color(0x161a30),
      emissiveIntensity: 0.8,
    });
    if (maps) {
      const tile = (src: typeof maps.map, n: number): typeof maps.map => {
        const t = src.clone();
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(n, n);
        t.needsUpdate = true;
        this.disposables.push(t);
        return t;
      };
      mat.map = tile(maps.map, 60);
      mat.normalMap = tile(maps.normalMap, 60);
      mat.normalScale.set(0.85, 0.85);
      if (maps.armMap) {
        const arm = tile(maps.armMap, 60);
        mat.aoMap = arm;
        mat.roughnessMap = arm;
        mat.metalnessMap = arm;
        mat.roughness = 1;
        mat.metalness = 1;
      }
    }

    this.disposables.push(geo, mat);
    const mesh = new Mesh(geo, mat);
    mesh.name = 'shaft-floor';
    return mesh;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
