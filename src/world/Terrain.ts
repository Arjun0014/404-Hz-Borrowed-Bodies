import {
  BufferAttribute,
  Color,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import { WORLD } from '../config';

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

// ---- terrain --------------------------------------------------------------

/**
 * Analytic heightfield for the Shallow Veil: sand dunes, rocky ridges, rising
 * edge walls, and a deep drop-off pit at the future descent point. Height is a
 * pure function so rendering and collision always agree.
 */
export class Terrain {
  mesh!: Mesh;
  private readonly uniforms = { uTime: { value: 0 } };

  /** World-space seabed height at (x, z). */
  heightAt(x: number, z: number): number {
    // Rolling dunes.
    let h = 6 + fbm(x * 0.008 + 11.7, z * 0.008 + 3.1, 4) * 9;
    // Rocky ridge lines rising out of the sand.
    const rn = fbm(x * 0.014 + 31.2, z * 0.014 + 17.6, 3);
    const ridged = 1 - Math.abs(2 * rn - 1);
    h += ridged * ridged * ridged * 7;
    // Fine relief.
    h += fbm(x * 0.05 + 7.3, z * 0.05 + 9.9, 3) * 1.4;

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

  build(): Mesh {
    const segs = 288;
    const geo = new PlaneGeometry(WORLD.size, WORLD.size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const sandLight = new Color(0x84775a).multiplyScalar(1.28);
    const sandDark = new Color(0x6f6248);
    const algae = new Color(0x3f5c40);
    const rock = new Color(0x565e63);
    const deep = new Color(0x0a1c26);
    const tmp = new Color();
    const tmp2 = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);

      // Sand: light/dark patchwork.
      const patch = fbm(x * 0.022 + 4.4, z * 0.022 + 8.8, 3);
      tmp.copy(sandDark).lerp(sandLight, smoothstep(0.3, 0.7, patch));
      // Algae mats on some flats.
      const algaeT = smoothstep(0.6, 0.78, fbm(x * 0.017 + 21.3, z * 0.017 + 2.7, 3));
      tmp.lerp(tmp2.copy(algae), algaeT * 0.85);
      // Exposed rock on slopes.
      const rockT = smoothstep(0.45, 1.05, this.slopeAt(x, z));
      tmp.lerp(tmp2.copy(rock), rockT);
      // Grain variation.
      tmp.multiplyScalar(0.9 + fbm(x * 0.09, z * 0.09, 2) * 0.2);
      // Fade to abyss colour toward the pit.
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
          // Close-range sand grain + ripple detail so the seabed never reads flat.
          {
            float detailFade = 1.0 - smoothstep(14.0, 60.0, length(vViewPosition));
            if (detailFade > 0.001) {
              float grain = tNoise(vWorldPos.xz * 3.4) * 0.6 + tNoise(vWorldPos.xz * 11.0) * 0.4;
              float ripple = sin(vWorldPos.x * 4.2 + vWorldPos.z * 1.3 + tNoise(vWorldPos.xz * 0.4) * 7.0);
              diffuseColor.rgb *= mix(1.0, 0.9 + grain * 0.2 + ripple * 0.05, detailFade);
            }
          }`,
        )
        .replace(
          '#include <dithering_fragment>',
          `
          // Animated caustic light ripples, fading with depth and distance.
          {
            vec2 cuv = vWorldPos.xz;
            float c1 = sin(cuv.x * 0.31 + uTime * 0.9) * sin(cuv.y * 0.36 + uTime * 0.7);
            float c2 = sin((cuv.x + cuv.y) * 0.23 - uTime * 1.1);
            float c3 = sin(cuv.x * 0.13 - cuv.y * 0.17 + uTime * 0.55);
            float caust = pow(max(c1 * c2, 0.0), 2.0) + pow(max(c2 * c3, 0.0), 2.6) * 0.5;
            // NOTE: "patch" is a reserved word in GLSL ES 3.0 — never use it.
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
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}
