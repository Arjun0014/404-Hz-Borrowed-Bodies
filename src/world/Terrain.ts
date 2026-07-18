import {
  BufferAttribute,
  Color,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
} from 'three';
import { WORLD } from '../config';
import type { TerrainLike, TerrainMaps } from './types';

// ---- deterministic value noise -------------------------------------------

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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---- rock formations --------------------------------------------------------

export interface Formation {
  x: number;
  z: number;
  r: number;
  h: number;
  kind: 'mesa' | 'pinnacle';
}

/**
 * Large formations baked into the heightfield so player AND camera collision
 * work automatically. All sit on the shelf (x < edgeX); the open deep beyond
 * the cliff is kept clear. Mesas are broad flat-top hills to swim over;
 * pinnacles are steep towers to weave between.
 */
export const FORMATIONS: Formation[] = [
  { x: -60, z: -120, r: 27, h: 13, kind: 'mesa' },
  { x: -150, z: -60, r: 31, h: 15, kind: 'mesa' },
  { x: -200, z: 70, r: 25, h: 12, kind: 'mesa' },
  { x: -95, z: 115, r: 29, h: 14, kind: 'mesa' },
  { x: 8, z: -150, r: 23, h: 12, kind: 'mesa' },
  { x: -30, z: 55, r: 26, h: 13, kind: 'mesa' },
  { x: -110, z: -10, r: 10, h: 20, kind: 'pinnacle' },
  { x: 22, z: 18, r: 11, h: 22, kind: 'pinnacle' },
  { x: -175, z: 140, r: 9, h: 18, kind: 'pinnacle' },
  { x: -215, z: -130, r: 10, h: 21, kind: 'pinnacle' },
  { x: 32, z: 128, r: 11, h: 19, kind: 'pinnacle' },
  { x: -60, z: 175, r: 10, h: 18, kind: 'pinnacle' },
  { x: -132, z: 175, r: 9, h: 17, kind: 'pinnacle' },
  { x: -42, z: -55, r: 11, h: 20, kind: 'pinnacle' },
];

interface Ridge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  w: number;
  h: number;
}

const RIDGES: Ridge[] = [
  { ax: -150, az: -15, bx: -55, bz: -85, w: 13, h: 11 },
  { ax: -30, az: 62, bx: 34, bz: 26, w: 12, h: 12 },
  { ax: -80, az: 188, bx: 12, bz: 148, w: 12, h: 10 },
];

/** Terraced descent floor level by x: shelf lip → steps → deep basin. */
function stairProfile(x: number): number {
  const e = WORLD.edgeX;
  let y = 4;
  y -= smoothstep(e - 2, e + 22, x) * 26; // step 1  → ~-22
  y -= smoothstep(e + 40, e + 64, x) * 34; // step 2 → ~-56
  y -= smoothstep(e + 80, e + 130, x) * 55; // slope → ~-111
  y -= smoothstep(e + 150, e + 230, x) * 66; // deep  → ~-177 (into dark fog)
  return y;
}

function segDist(px: number, pz: number, r: Ridge): number {
  const dx = r.bx - r.ax;
  const dz = r.bz - r.az;
  const len2 = dx * dx + dz * dz;
  let t = ((px - r.ax) * dx + (pz - r.az) * dz) / len2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (r.ax + dx * t), pz - (r.az + dz * t));
}

// ---- terrain ------------------------------------------------------------------

/**
 * Analytic heightfield for the Shallow Veil. Height is a pure function so
 * rendering and collision always agree — including every mesa and pinnacle.
 */
export class Terrain implements TerrainLike {
  mesh!: Mesh;
  private readonly uniforms = { uTime: { value: 0 } };

  /** World-space seabed height at (x, z). */
  heightAt(x: number, z: number): number {
    // --- shelf surface: dunes + ridges + formations ---
    let shelf = 6 + fbm(x * 0.008 + 11.7, z * 0.008 + 3.1, 4) * 9;
    const rn = fbm(x * 0.014 + 31.2, z * 0.014 + 17.6, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    shelf += ridged * ridged * ridged * 8;
    shelf += fbm(x * 0.05 + 7.3, z * 0.05 + 9.9, 3) * 1.4;

    for (const f of FORMATIONS) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < f.r) {
        const t = 1 - smoothstep(f.r * (f.kind === 'mesa' ? 0.38 : 0.16), f.r, d);
        shelf += f.h * Math.pow(t, f.kind === 'mesa' ? 1.1 : 1.5);
      }
    }
    for (const rg of RIDGES) {
      const d = segDist(x, z, rg);
      if (d < rg.w) {
        const t = 1 - smoothstep(rg.w * 0.25, rg.w, d);
        shelf += rg.h * Math.pow(t, 1.2);
      }
    }

    // Enclosing walls on the back (-X) and the two sides (±Z). The +X side is
    // deliberately open — that is the sea edge leading into the deep.
    const backWall = (1 - smoothstep(WORLD.minX + 8, WORLD.minX + 48, x)) * 46;
    const sideWall =
      ((1 - smoothstep(WORLD.minZ + 8, WORLD.minZ + 48, z)) +
        smoothstep(WORLD.maxZ - 48, WORLD.maxZ - 8, z)) *
      42;
    shelf += backWall + sideWall;

    // --- deep floor: terraced staircase dropping into the abyss ---
    let floor = stairProfile(x);
    const deepNoise = 1 - smoothstep(-30, -90, floor); // less relief when very deep
    floor += fbm(x * 0.03 + 2.2, z * 0.03 + 5.5, 3) * 6 * deepNoise;

    // Blend shelf → deep across the cliff lip.
    const t = smoothstep(WORLD.edgeX - 14, WORLD.edgeX + 8, x);
    return lerp(shelf, floor, t);
  }

  /** Approximate slope magnitude (for placement rules and colouring). */
  slopeAt(x: number, z: number): number {
    const e = 1.5;
    const dhx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dhz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dhx, dhz) / (2 * e);
  }

  build(maps?: TerrainMaps): Mesh {
    const segs = 300;
    const geo = new PlaneGeometry(WORLD.size, WORLD.size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const textured = !!maps;

    // With a texture, vertex colours act as tint modulation around white.
    // Without one, they carry the full colour (fallback palette).
    const sandLight = textured ? new Color(1.08, 1.03, 0.9) : new Color(0x84775a).multiplyScalar(1.28);
    const sandDark = textured ? new Color(0.82, 0.78, 0.68) : new Color(0x6f6248);
    const algae = textured ? new Color(0.5, 0.72, 0.5) : new Color(0x3f5c40);
    const rock = textured ? new Color(0.68, 0.72, 0.78) : new Color(0x565e63);
    // Near-black so the descent floor + cliff face read as a deep dark abyss.
    const deep = textured ? new Color(0.03, 0.06, 0.09) : new Color(0x03090e);
    const tmp = new Color();
    const tmp2 = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);

      const patchN = fbm(x * 0.022 + 4.4, z * 0.022 + 8.8, 3);
      tmp.copy(sandDark).lerp(sandLight, smoothstep(0.3, 0.7, patchN));
      const algaeT = smoothstep(0.6, 0.78, fbm(x * 0.017 + 21.3, z * 0.017 + 2.7, 3));
      tmp.lerp(tmp2.copy(algae), algaeT * 0.85);
      const rockT = smoothstep(0.5, 1.15, this.slopeAt(x, z));
      tmp.lerp(tmp2.copy(rock), rockT);
      tmp.multiplyScalar(0.9 + fbm(x * 0.09, z * 0.09, 2) * 0.2);
      tmp.lerp(tmp2.copy(deep), smoothstep(6, -60, h));

      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
    });
    if (maps) {
      // 600 m plane, tile every ~5.5 m.
      maps.map.wrapS = maps.map.wrapT = RepeatWrapping;
      maps.map.repeat.set(110, 110);
      maps.normalMap.wrapS = maps.normalMap.wrapT = RepeatWrapping;
      maps.normalMap.repeat.set(110, 110);
      mat.map = maps.map;
      mat.normalMap = maps.normalMap;
      mat.normalScale.set(0.75, 0.75);
    }
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWorldPos;
          uniform float uTime;
          float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float tNoise(vec2 p) {
            vec2 i = floor(p); vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = tHash(i), b = tHash(i + vec2(1.0, 0.0));
            float c = tHash(i + vec2(0.0, 1.0)), d = tHash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // Close-range grain so the seabed never reads flat.
          {
            float detailFade = 1.0 - smoothstep(14.0, 60.0, length(vViewPosition));
            if (detailFade > 0.001) {
              float grain = tNoise(vWorldPos.xz * 3.4) * 0.6 + tNoise(vWorldPos.xz * 11.0) * 0.4;
              diffuseColor.rgb *= mix(1.0, 0.92 + grain * 0.16, detailFade);
            }
          }
          // Abyssal darkening: geometry below the shelf plunges toward black,
          // so the cliff face and deep basin read as a very deep, dark drop-off
          // regardless of where you view them from.
          diffuseColor.rgb *= mix(1.0, 0.05, smoothstep(2.0, -42.0, vWorldPos.y));`,
        )
        .replace(
          '#include <dithering_fragment>',
          `
          // Animated caustic light ripples, fading with depth and distance.
          // NOTE: "patch" is a reserved word in GLSL ES 3.0 — never use it.
          {
            vec2 cuv = vWorldPos.xz;
            float c1 = sin(cuv.x * 0.31 + uTime * 0.9) * sin(cuv.y * 0.36 + uTime * 0.7);
            float c2 = sin((cuv.x + cuv.y) * 0.23 - uTime * 1.1);
            float c3 = sin(cuv.x * 0.13 - cuv.y * 0.17 + uTime * 0.55);
            float caust = pow(max(c1 * c2, 0.0), 2.0) + pow(max(c2 * c3, 0.0), 2.6) * 0.5;
            float patchy = 0.55 + 0.45 * sin(cuv.x * 0.045 + cuv.y * 0.038 + uTime * 0.12);
            float depthFade = clamp((vWorldPos.y + 4.0) / 26.0, 0.0, 1.0);
            float distFade = 1.0 - smoothstep(35.0, 110.0, length(vViewPosition));
            gl_FragColor.rgb += vec3(0.55, 0.85, 0.8) * caust * patchy * depthFade * distFade * 0.2;
          }
          #include <dithering_fragment>
          `,
        );
    };

    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'terrain';
    return this.mesh;
  }

  update(dt: number): void {
    this.uniforms.uTime.value += dt;
  }

  dispose(): void {
    // Textures are the zone's cloned maps; the owning zone disposes them.
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}
