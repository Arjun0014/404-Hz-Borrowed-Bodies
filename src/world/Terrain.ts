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
 * work automatically. Mesas are broad flat-top hills to swim over; pinnacles
 * are steep towers to weave between; ridges form walls to cross or go around.
 * Kept clear of the spawn (-170,-55), the pit (225,10 r85), and the outer wall.
 */
export const FORMATIONS: Formation[] = [
  { x: -40, z: -120, r: 27, h: 13, kind: 'mesa' },
  { x: 80, z: -95, r: 31, h: 15, kind: 'mesa' },
  { x: -105, z: 60, r: 25, h: 12, kind: 'mesa' },
  { x: 30, z: 125, r: 29, h: 14, kind: 'mesa' },
  { x: 150, z: -155, r: 23, h: 12, kind: 'mesa' },
  { x: -195, z: 115, r: 26, h: 13, kind: 'mesa' },
  { x: -10, z: -30, r: 10, h: 20, kind: 'pinnacle' },
  { x: 62, z: 32, r: 11, h: 22, kind: 'pinnacle' },
  { x: -72, z: -58, r: 9, h: 18, kind: 'pinnacle' },
  { x: 118, z: 82, r: 10, h: 21, kind: 'pinnacle' },
  { x: -140, z: -150, r: 11, h: 19, kind: 'pinnacle' },
  { x: 2, z: -190, r: 10, h: 18, kind: 'pinnacle' },
  { x: 92, z: 172, r: 11, h: 20, kind: 'pinnacle' },
  { x: -58, z: 172, r: 9, h: 17, kind: 'pinnacle' },
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
  { ax: -120, az: -15, bx: -35, bz: -85, w: 13, h: 11 },
  { ax: 15, az: 62, bx: 118, bz: 28, w: 12, h: 12 },
  { ax: -30, az: 200, bx: 60, bz: 150, w: 12, h: 10 },
];

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
    // Rolling dunes.
    let h = 6 + fbm(x * 0.008 + 11.7, z * 0.008 + 3.1, 4) * 9;
    // Rocky ridge lines rising out of the sand.
    const rn = fbm(x * 0.014 + 31.2, z * 0.014 + 17.6, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    h += ridged * ridged * ridged * 8;
    // Fine relief.
    h += fbm(x * 0.05 + 7.3, z * 0.05 + 9.9, 3) * 1.4;

    // Large formations: mesas, pinnacles, ridge walls.
    for (const f of FORMATIONS) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < f.r) {
        const inner = f.r * (f.kind === 'mesa' ? 0.38 : 0.16);
        const t = 1 - smoothstep(inner, f.r, d);
        h += f.h * Math.pow(t, f.kind === 'mesa' ? 1.1 : 1.5);
      }
    }
    for (const rg of RIDGES) {
      const d = segDist(x, z, rg);
      if (d < rg.w) {
        const t = 1 - smoothstep(rg.w * 0.25, rg.w, d);
        h += rg.h * Math.pow(t, 1.2);
      }
    }

    const r = Math.hypot(x, z);
    const dx = x - WORLD.dropCenter.x;
    const dz = z - WORLD.dropCenter.z;
    const dropDist = Math.hypot(dx, dz);

    // Edge walls rise beyond the playable radius, suppressed near the drop.
    let wall = smoothstep(WORLD.playableRadius - 35, WORLD.hardRadius + 15, r) * 42;
    wall *= Math.min(1, dropDist / (WORLD.dropRadius * 1.9));
    h += wall;

    // Descent pit: seabed plunges into darkness.
    const dropT = 1 - smoothstep(WORLD.dropRadius * 0.18, WORLD.dropRadius, dropDist);
    h = lerp(h, -165, smoothstep(0.02, 1, dropT));

    return h;
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
    const deep = textured ? new Color(0.1, 0.22, 0.3) : new Color(0x0a1c26);
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
      tmp.lerp(tmp2.copy(deep), smoothstep(4, -32, h));

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
          }`,
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
