import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CircleGeometry, RepeatWrapping, type Texture } from 'three';
import { FOG, WORLD } from '../config';
import { FORMATIONS, Terrain, type TerrainMaps } from './Terrain';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SwayMat extends MeshStandardMaterial {
  userData: { shader?: { uniforms: { uTime: { value: number } } } };
}

/**
 * The Shallow Veil: sunlit blue-green shelf with seagrass meadows, boulder
 * fields, coral reefs, kelp stands, god rays, and the descent pit.
 * Owns everything zone-scoped and can fully dispose itself.
 */
export interface CylinderCollider {
  x: number;
  z: number;
  r: number;
  top: number;
}

export class ShallowVeil {
  readonly group = new Group();
  readonly terrain = new Terrain();
  /** Solid obstacles (spires, landmark boulders) for player + camera collision. */
  readonly colliders: CylinderCollider[] = [];
  particleCount = 0;
  private rockTexture: Texture | null = null;

  private readonly scene: Scene;
  private time = 0;
  private readonly fogShallow = new Color(FOG.shallowColor);
  private readonly fogDeep = new Color(FOG.deepColor);
  private readonly fogNow = new Color();
  private fog!: FogExp2;
  private hemi!: HemisphereLight;

  private particleMat!: ShaderMaterial;
  private particles!: Points;
  private surfaceMat!: ShaderMaterial;
  private raySpriteMat!: SpriteMaterial;
  private raySprite!: Sprite;
  private swayMats: SwayMat[] = [];
  private markerRing!: Mesh;
  private markerLight!: PointLight;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  build(_renderer: WebGLRenderer, particleScale: number, maps?: TerrainMaps): void {
    this.fog = new FogExp2(FOG.shallowColor, FOG.density);
    this.scene.fog = this.fog;
    // scene.background is tone-mapped like fogged geometry (setClearColor is
    // not), so distant objects dissolve into the backdrop seamlessly.
    this.scene.background = this.fogNow.copy(this.fogShallow);

    this.hemi = new HemisphereLight(0xbfe8f5, 0x33554a, 1.15);
    this.group.add(this.hemi);
    const sun = new DirectionalLight(0xfff1d6, 1.9);
    sun.position.set(80, 150, 40);
    this.group.add(sun);

    if (maps) {
      // Separate transform for rocks/spires (clone shares the image data).
      this.rockTexture = maps.map.clone();
      this.rockTexture.wrapS = this.rockTexture.wrapT = RepeatWrapping;
      this.rockTexture.repeat.set(2.5, 2);
      this.rockTexture.needsUpdate = true;
      this.disposables.push(this.rockTexture);
    }

    this.group.add(this.terrain.build(maps));

    this.buildSurface();
    this.buildGodRays();
    this.buildParticles(particleScale);
    this.buildRocks();
    this.buildSpires();
    this.buildSeagrass();
    this.buildCoral();
    this.buildKelp();
    this.buildSilhouettes();
    this.buildDescentMarker();

    this.scene.add(this.group);
  }

  // ---- shared sway material -------------------------------------------------

  /**
   * Standard material whose instances sway sinusoidally, phase from position.
   * Base colour stays white: instanceColor MULTIPLIES with material colour, so
   * a coloured base + coloured tint = near black.
   */
  private makeSwayMaterial(strengthX: number, strengthZ: number, speed: number): SwayMat {
    const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: DoubleSide }) as SwayMat;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      mat.userData.shader = shader as unknown as SwayMat['userData']['shader'];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
          {
            vec2 ipos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
            float ph = ipos.x * 0.41 + ipos.y * 0.57;
            float f = pow(uv.y, 1.6);
            transformed.x += sin(uTime * ${speed.toFixed(2)} + ph) * ${strengthX.toFixed(2)} * f;
            transformed.z += cos(uTime * ${(speed * 0.74).toFixed(2)} + ph * 1.3) * ${strengthZ.toFixed(2)} * f;
          }
          #endif
          `,
        );
    };
    this.swayMats.push(mat);
    this.disposables.push(mat);
    return mat;
  }

  // ---- surface + god rays ---------------------------------------------------

  private buildSurface(): void {
    const geo = new PlaneGeometry(1400, 1400, 1, 1);
    geo.rotateX(Math.PI / 2);
    this.surfaceMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorld;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        // Domain-warped ridged noise → organic caustic cells (not sine bands).
        float caustic(vec2 uv, float t) {
          vec2 w = vec2(noise(uv * 1.1 + t), noise(uv * 1.1 - t + 4.3));
          float n = noise(uv + w * 0.7);
          float ridged = 1.0 - abs(n * 2.0 - 1.0);
          return pow(ridged, 2.2);
        }

        void main() {
          vec2 uv = vWorld.xz * 0.045;
          float t = uTime * 0.09;
          // Two octaves drifting in different directions for shimmer.
          float c = caustic(uv, t) * 0.65 + caustic(uv * 2.3 + 7.0, -t * 1.4) * 0.35;

          vec3 deep = vec3(0.13, 0.36, 0.44);
          vec3 bright = vec3(0.78, 0.96, 0.99);
          vec3 col = mix(deep, bright, c);

          float dist = length(vWorld.xz);
          float fade = 1.0 - smoothstep(180.0, 560.0, dist);
          gl_FragColor = vec4(col, (0.22 + c * 0.42) * fade);
        }
      `,
    });
    const surface = new Mesh(geo, this.surfaceMat);
    surface.position.y = WORLD.surfaceY;
    surface.renderOrder = 2;
    this.group.add(surface);
    this.disposables.push(geo, this.surfaceMat);
    // The sun disc + glow is provided by the radial god-ray sprite
    // (buildGodRays), so no separate glow sprite here.
  }

  private buildGodRays(): void {
    // God rays as a single camera-FACING sprite anchored in the sun's
    // direction. A sprite always faces the camera, so it can never go edge-on
    // or change brightness as the player orbits the mouse — the previous flat
    // planes flickered badly when looking straight up at the sun. The radial
    // streaks emanate from the sun disc, which is exactly what you should see
    // when directly below the sun.
    // A clean, soft sun glow — no hard radial spokes (those read as an ugly
    // pinwheel underwater). Just a bright core diffusing smoothly into a wide
    // halo, which is what sunlight through water actually looks like.
    const size = 512;
    const c = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';

    // Wide, very soft outer halo.
    const halo = ctx.createRadialGradient(c, c, 4, c, c, c);
    halo.addColorStop(0, 'rgba(210, 240, 240, 0.5)');
    halo.addColorStop(0.4, 'rgba(190, 228, 232, 0.14)');
    halo.addColorStop(1, 'rgba(180, 220, 228, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // Bright, tight core.
    const core = ctx.createRadialGradient(c, c, 1, c, c, c * 0.3);
    core.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    core.addColorStop(0.3, 'rgba(240, 250, 248, 0.5)');
    core.addColorStop(1, 'rgba(220, 242, 242, 0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);

    const tex = new CanvasTexture(canvas);
    this.raySpriteMat = new SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true, // real geometry (rocks/formations) can occlude the sun
      blending: AdditiveBlending,
      fog: false,
      opacity: 0,
    });
    this.disposables.push(tex, this.raySpriteMat);

    this.raySprite = new Sprite(this.raySpriteMat);
    this.raySprite.scale.setScalar(190);
    // The existing dedicated sun-glow sprite (buildSurface) is now redundant
    // with this; keep only this radial one to avoid a double-bright disc.
    this.group.add(this.raySprite);
  }

  /** Direction to the sun, matching the directional light in build(). */
  private readonly sunDir = new Vector3(80, 150, 40).normalize();

  // ---- suspended particles ---------------------------------------------------

  private buildParticles(scale: number): void {
    const count = Math.floor(1600 * scale);
    this.particleCount = count;
    const box = 46;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const rand = mulberry32(1337);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * box;
      positions[i * 3 + 1] = (rand() - 0.5) * box;
      positions[i * 3 + 2] = (rand() - 0.5) * box;
      seeds[i] = rand() * 100;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 1));

    this.particleMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new Vector3() },
        uBox: { value: box },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uCamPos;
        uniform float uBox;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.22 + aSeed * 1.7) * 1.6;
          p.y += sin(uTime * 0.16 + aSeed * 2.3) * 1.1 - uTime * 0.12;
          p.z += cos(uTime * 0.19 + aSeed * 1.1) * 1.6;
          vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCamPos + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = -mv.z;
          vAlpha = (1.0 - smoothstep(uBox * 0.32, uBox * 0.5, dist)) * 0.55;
          gl_PointSize = (42.0 / dist) * (1.2 + fract(aSeed) * 1.6) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vAlpha;
          gl_FragColor = vec4(0.82, 0.94, 0.92, a * 0.45);
        }
      `,
    });
    this.particles = new Points(geo, this.particleMat);
    this.particles.frustumCulled = false;
    this.group.add(this.particles);
    this.disposables.push(geo, this.particleMat);
  }

  /** Called by Quality changes: rebuild the mote cloud at a new density. */
  setParticleScale(scale: number): void {
    this.group.remove(this.particles);
    this.particles.geometry.dispose();
    this.particleMat.dispose();
    this.buildParticles(scale);
  }

  // ---- placement helpers ------------------------------------------------------

  /** Random spot avoiding the pit, the outer wall, and optionally steep ground. */
  private pickSpot(
    rand: () => number,
    dropMargin: number,
    maxSlope = 10,
  ): { x: number; z: number } {
    for (let tries = 0; tries < 60; tries++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (WORLD.playableRadius - 12);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const dDrop = Math.hypot(x - WORLD.dropCenter.x, z - WORLD.dropCenter.z);
      if (dDrop < WORLD.dropRadius + dropMargin) continue;
      if (maxSlope < 10 && this.terrain.slopeAt(x, z) > maxSlope) continue;
      return { x, z };
    }
    return { x: 0, z: 0 };
  }

  // ---- rocks -------------------------------------------------------------------

  private buildRocks(): void {
    const rand = mulberry32(9001);
    const mat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      map: this.rockTexture ?? undefined,
    });
    this.disposables.push(mat);
    const tint = new Color();
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const posV = new Vector3();

    for (let v = 0; v < 3; v++) {
      // Smooth boulders: gentle low-frequency displacement only.
      const geo = new IcosahedronGeometry(1, 2);
      const p = geo.attributes.position as BufferAttribute;
      const vr = mulberry32(v * 977 + 5);
      const nx = vr() * 7;
      const nz = vr() * 7;
      for (let i = 0; i < p.count; i++) {
        const dir = new Vector3(p.getX(i), p.getY(i), p.getZ(i)).normalize();
        const n =
          1 +
          (Math.sin(dir.x * 2.4 + nx) * Math.sin(dir.z * 2.1 + nz) * 0.5 +
            Math.sin(dir.y * 3.1 + nx) * 0.5) *
            0.2;
        p.setXYZ(i, dir.x * n, dir.y * n * 0.72, dir.z * n);
      }
      geo.computeVertexNormals();
      this.disposables.push(geo);

      const count = 60 + (v === 0 ? 6 : 0);
      const mesh = new InstancedMesh(geo, mat, count);
      let idx = 0;
      for (let i = 0; i < 60; i++) {
        const { x, z } = this.pickSpot(rand, 25);
        const s = 0.7 + rand() * rand() * 4.5;
        scl.set(s * (0.85 + rand() * 0.4), s * (0.7 + rand() * 0.4), s * (0.85 + rand() * 0.4));
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        posV.set(x, this.terrain.heightAt(x, z) + s * 0.12, z);
        m.compose(posV, q, scl);
        mesh.setMatrixAt(idx, m);
        // Grey-green tint variation.
        tint.setHSL(0.3 + rand() * 0.1, 0.1 + rand() * 0.12, 0.28 + rand() * 0.14);
        mesh.setColorAt(idx, tint);
        idx++;
      }
      if (v === 0) {
        // Landmark monoliths (registered as solid obstacles).
        for (let i = 0; i < 6; i++) {
          const { x, z } = this.pickSpot(rand, 55);
          const s = 9 + rand() * 8;
          const sy = s * (1.1 + rand() * 0.7);
          scl.set(s, sy, s);
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          const gy = this.terrain.heightAt(x, z);
          posV.set(x, gy + s * 0.1, z);
          m.compose(posV, q, scl);
          mesh.setMatrixAt(idx, m);
          tint.setHSL(0.5, 0.12, 0.33);
          mesh.setColorAt(idx, tint);
          this.colliders.push({ x, z, r: s * 0.82, top: gy + sy * 0.75 });
          idx++;
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  // ---- rock spires (broken-tower clusters around the formations) -------------

  private buildSpires(): void {
    const rand = mulberry32(2718);
    const mat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      map: this.rockTexture ?? undefined,
    });
    this.disposables.push(mat);

    // Tapered, gently-distorted column.
    const geo = new CylinderGeometry(0.42, 1, 1, 7, 5);
    const p = geo.attributes.position as BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const wob = 1 + Math.sin(y * 9.1 + p.getX(i) * 4.7) * 0.12 + Math.sin(y * 4.3) * 0.1;
      p.setX(i, p.getX(i) * wob);
      p.setZ(i, p.getZ(i) * wob);
    }
    geo.translate(0, 0.5, 0); // pivot at base
    geo.computeVertexNormals();
    this.disposables.push(geo);

    // Collect valid placements first so the instance count is exact.
    const spots: { x: number; z: number; height: number; width: number }[] = [];
    for (let tries = 0; tries < 90 && spots.length < 34; tries++) {
      // Cluster around a formation's skirt so towers frame the big shapes.
      const f = FORMATIONS[Math.floor(rand() * FORMATIONS.length)];
      const a = rand() * Math.PI * 2;
      const rr = f.r * (1.15 + rand() * 0.8);
      const x = f.x + Math.cos(a) * rr;
      const z = f.z + Math.sin(a) * rr;
      const dSpawn = Math.hypot(x - WORLD.spawn.x, z - WORLD.spawn.z);
      const dDrop = Math.hypot(x - WORLD.dropCenter.x, z - WORLD.dropCenter.z);
      if (dSpawn < 25 || dDrop < WORLD.dropRadius + 15 || Math.hypot(x, z) > WORLD.playableRadius) {
        continue;
      }
      spots.push({ x, z, height: 7 + rand() * 12, width: 1.6 + rand() * 2.2 });
    }

    const mesh = new InstancedMesh(geo, mat, spots.length);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const posV = new Vector3();
    const tint = new Color();

    spots.forEach((sp, i) => {
      scl.set(sp.width, sp.height, sp.width);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      const gy = this.terrain.heightAt(sp.x, sp.z);
      posV.set(sp.x, gy - 0.5, sp.z);
      m.compose(posV, q, scl);
      mesh.setMatrixAt(i, m);
      tint.setHSL(0.35 + rand() * 0.15, 0.1 + rand() * 0.1, 0.3 + rand() * 0.16);
      mesh.setColorAt(i, tint);
      this.colliders.push({ x: sp.x, z: sp.z, r: sp.width * 0.85, top: gy + sp.height * 0.98 });
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  // ---- seagrass meadows ----------------------------------------------------------

  private buildSeagrass(): void {
    const rand = mulberry32(6060);
    const geo = new PlaneGeometry(0.11, 0.95, 1, 3);
    geo.translate(0, 0.48, 0);
    const mat = this.makeSwayMaterial(0.3, 0.22, 1.35);
    this.disposables.push(geo);

    const patches = 52;
    const perPatch = 60;
    const mesh = new InstancedMesh(geo, mat, patches * perPatch);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const s = new Vector3();
    const p = new Vector3();
    const tint = new Color();
    let idx = 0;

    // One guaranteed meadow just ahead of spawn; several skirting formations.
    const centers: { x: number; z: number }[] = [
      { x: WORLD.spawn.x + 14, z: WORLD.spawn.z + 2 },
    ];
    for (const f of FORMATIONS) {
      const a = rand() * Math.PI * 2;
      const rr = f.r * (1.35 + rand() * 0.6);
      const x = f.x + Math.cos(a) * rr;
      const z = f.z + Math.sin(a) * rr;
      if (
        this.terrain.slopeAt(x, z) < 0.5 &&
        Math.hypot(x - WORLD.dropCenter.x, z - WORLD.dropCenter.z) > WORLD.dropRadius + 20
      ) {
        centers.push({ x, z });
      }
    }
    while (centers.length < patches) centers.push(this.pickSpot(rand, 30, 0.5));

    for (const c of centers) {
      for (let i = 0; i < perPatch; i++) {
        const a = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * (3.5 + rand() * 4);
        const x = c.x + Math.cos(a) * rr;
        const z = c.z + Math.sin(a) * rr;
        const sc = 0.7 + rand() * 0.9;
        s.set(sc, sc * (0.75 + rand() * 0.7), sc);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        p.set(x, this.terrain.heightAt(x, z) - 0.03, z);
        m.compose(p, q, s);
        mesh.setMatrixAt(idx, m);
        tint.setHSL(0.24 + rand() * 0.09, 0.5, 0.38 + rand() * 0.22);
        mesh.setColorAt(idx, tint);
        idx++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  // ---- coral reefs -----------------------------------------------------------------

  private buildCoral(): void {
    const rand = mulberry32(3131);

    // Branch coral: merged cones fanning upward.
    const branchParts: BufferGeometry[] = [];
    const br = mulberry32(88);
    for (let k = 0; k < 6; k++) {
      const g = new ConeGeometry(0.05 + br() * 0.04, 0.55 + br() * 0.5, 5);
      const mm = new Matrix4();
      const qq = new Quaternion();
      qq.setFromAxisAngle(new Vector3(1, 0, 0), (br() - 0.5) * 1.1);
      const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), br() * Math.PI * 2);
      yaw.multiply(qq);
      mm.compose(new Vector3((br() - 0.5) * 0.3, 0.3 + br() * 0.2, (br() - 0.5) * 0.3), yaw, new Vector3(1, 1, 1));
      g.applyMatrix4(mm);
      branchParts.push(g);
    }
    const branchGeo = mergeGeometries(branchParts);
    for (const g of branchParts) g.dispose();

    // Tube coral: merged upright cylinders.
    const tubeParts: BufferGeometry[] = [];
    const tr = mulberry32(99);
    for (let k = 0; k < 5; k++) {
      const h = 0.28 + tr() * 0.5;
      const g = new CylinderGeometry(0.07 + tr() * 0.05, 0.11 + tr() * 0.05, h, 6);
      g.translate((tr() - 0.5) * 0.42, h / 2, (tr() - 0.5) * 0.42);
      tubeParts.push(g);
    }
    const tubeGeo = mergeGeometries(tubeParts);
    for (const g of tubeParts) g.dispose();

    // Mound coral: squashed sphere.
    const moundGeo = new SphereGeometry(0.5, 9, 7);
    moundGeo.scale(1, 0.55, 1);

    // Fan coral: three flat arcs at slight angles.
    const fanParts: BufferGeometry[] = [];
    const fr = mulberry32(77);
    for (let k = 0; k < 3; k++) {
      const g = new CircleGeometry(0.45 + fr() * 0.25, 7, Math.PI * 0.08, Math.PI * 0.84);
      const mm = new Matrix4();
      const qq = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), fr() * Math.PI);
      mm.compose(new Vector3((fr() - 0.5) * 0.25, 0.05, (fr() - 0.5) * 0.25), qq, new Vector3(1, 1, 1));
      g.applyMatrix4(mm);
      fanParts.push(g);
    }
    const fanGeo = mergeGeometries(fanParts);
    for (const g of fanParts) g.dispose();

    const sets: {
      geo: BufferGeometry;
      color: number;
      count: number;
      hue: number;
      hueSpread: number;
      doubleSided?: boolean;
    }[] = [
      { geo: branchGeo, color: 0xc7603c, count: 110, hue: 0.05, hueSpread: 0.1 },
      { geo: tubeGeo, color: 0x9a5fb8, count: 95, hue: 0.78, hueSpread: 0.12 },
      { geo: moundGeo, color: 0xd88f7a, count: 90, hue: 0.07, hueSpread: 0.16 },
      { geo: fanGeo, color: 0xe08aa0, count: 70, hue: 0.93, hueSpread: 0.1, doubleSided: true },
    ];

    // Reef cluster centers: one at spawn, most hugging formation skirts (the
    // rich-ecosystem look), the rest scattered on open flats.
    const reefCenters: { x: number; z: number }[] = [
      { x: WORLD.spawn.x + 20, z: WORLD.spawn.z - 6 },
    ];
    for (const f of FORMATIONS) {
      const a = rand() * Math.PI * 2;
      const rr = f.r * (1.2 + rand() * 0.5);
      const x = f.x + Math.cos(a) * rr;
      const z = f.z + Math.sin(a) * rr;
      if (Math.hypot(x - WORLD.dropCenter.x, z - WORLD.dropCenter.z) > WORLD.dropRadius + 20) {
        reefCenters.push({ x, z });
      }
    }
    while (reefCenters.length < 28) reefCenters.push(this.pickSpot(rand, 30, 0.55));

    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const s = new Vector3();
    const p = new Vector3();
    const tint = new Color();

    for (const set of sets) {
      const mat = new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.8,
        side: set.doubleSided ? DoubleSide : undefined,
      });
      const mesh = new InstancedMesh(set.geo, mat, set.count);
      this.disposables.push(set.geo, mat);
      const base = new Color(set.color);
      for (let i = 0; i < set.count; i++) {
        const c = reefCenters[Math.floor(rand() * reefCenters.length)];
        const a = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * 7.5;
        const x = c.x + Math.cos(a) * rr;
        const z = c.z + Math.sin(a) * rr;
        const sc = 0.8 + rand() * 1.7;
        s.set(sc, sc * (0.8 + rand() * 0.5), sc);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        p.set(x, this.terrain.heightAt(x, z) + 0.02, z);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        // Tint carries the colour (white-base material): base hue ± spread.
        tint.copy(base).offsetHSL((rand() - 0.5) * set.hueSpread, (rand() - 0.5) * 0.15, (rand() - 0.5) * 0.18);
        mesh.setColorAt(i, tint);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  // ---- kelp stands ------------------------------------------------------------------

  private buildKelp(): void {
    const rand = mulberry32(4242);
    const configs = [
      { height: 5, width: 0.55, count: 120, sway: 0.55 },
      { height: 8.5, width: 0.7, count: 80, sway: 0.7 },
    ];
    for (const cfg of configs) {
      const geo = new PlaneGeometry(cfg.width, cfg.height, 1, 8);
      geo.translate(0, cfg.height / 2, 0);
      const mat = this.makeSwayMaterial(cfg.sway, cfg.sway * 0.7, 0.85);
      this.disposables.push(geo);

      const mesh = new InstancedMesh(geo, mat, cfg.count);
      const m = new Matrix4();
      const q = new Quaternion();
      const up = new Vector3(0, 1, 0);
      const s = new Vector3();
      const p = new Vector3();
      const tint = new Color();
      const clusters = Math.ceil(cfg.count / 16);
      let idx = 0;
      for (let c = 0; c < clusters && idx < cfg.count; c++) {
        const center = this.pickSpot(rand, 35, 0.6);
        for (let i = 0; i < 16 && idx < cfg.count; i++) {
          const x = center.x + (rand() - 0.5) * 14;
          const z = center.z + (rand() - 0.5) * 14;
          const sc = 0.7 + rand() * 0.7;
          s.set(sc, sc * (0.8 + rand() * 0.5), sc);
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          p.set(x, this.terrain.heightAt(x, z) - 0.1, z);
          m.compose(p, q, s);
          mesh.setMatrixAt(idx, m);
          tint.setHSL(0.3 + rand() * 0.07, 0.45, 0.34 + rand() * 0.16);
          mesh.setColorAt(idx, tint);
          idx++;
        }
      }
      mesh.count = idx;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  // ---- distant silhouettes -------------------------------------------------------------

  private buildSilhouettes(): void {
    const rand = mulberry32(777);
    const mat = new MeshBasicMaterial({ color: 0x1a4050 });
    this.disposables.push(mat);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rand() * 0.5;
      const dropA = Math.atan2(WORLD.dropCenter.z, WORLD.dropCenter.x);
      if (Math.abs(Math.atan2(Math.sin(a - dropA), Math.cos(a - dropA))) < 0.5) continue;
      const geo = new ConeGeometry(35 + rand() * 40, 50 + rand() * 55, 6);
      this.disposables.push(geo);
      const mesh = new Mesh(geo, mat);
      const r = 315 + rand() * 45;
      mesh.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      mesh.rotation.y = rand() * Math.PI;
      this.group.add(mesh);
    }
  }

  // ---- descent marker (placeholder for Phase 2) ------------------------------------------

  private buildDescentMarker(): void {
    const rimX = WORLD.dropCenter.x - WORLD.dropRadius * 0.72;
    const rimZ = WORLD.dropCenter.z;
    const y = this.terrain.heightAt(rimX, rimZ) + 3;

    const geo = new TorusGeometry(4, 0.14, 10, 48);
    geo.rotateX(Math.PI / 2);
    const mat = new MeshBasicMaterial({ color: 0x6cf5df, transparent: true, opacity: 0.8 });
    this.markerRing = new Mesh(geo, mat);
    this.markerRing.position.set(rimX, y, rimZ);
    this.group.add(this.markerRing);
    this.disposables.push(geo, mat);

    this.markerLight = new PointLight(0x5df0d8, 40, 46, 1.8);
    this.markerLight.position.set(rimX, y + 2, rimZ);
    this.group.add(this.markerLight);
  }

  /** World position of the descent placeholder (for proximity hints). */
  getMarkerPosition(out: Vector3): Vector3 {
    return out.copy(this.markerRing.position);
  }

  // ---- frame update ------------------------------------------------------------------------

  update(dt: number, camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    this.time += dt;
    this.terrain.update(dt);

    this.particleMat.uniforms.uTime.value = this.time;
    this.particleMat.uniforms.uCamPos.value.copy(camera.position);
    this.particleMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    this.surfaceMat.uniforms.uTime.value = this.time;

    for (const mat of this.swayMats) {
      if (mat.userData.shader) mat.userData.shader.uniforms.uTime.value = this.time;
    }

    // Depth-graded water colour: darker as the camera sinks.
    // fogNow is also the scene.background instance, so mutating it updates both.
    const depth01 = Math.min(1, Math.max(0, (WORLD.surfaceY - camera.position.y) / 90));
    this.fogNow.copy(this.fogShallow).lerp(this.fogDeep, depth01 * depth01 * 0.9 + depth01 * 0.1);
    this.fog.color.copy(this.fogNow);
    this.hemi.intensity = 1.15 - depth01 * 0.45;

    // God-ray sprite: anchored in the sun's DIRECTION at a large fixed
    // distance so it behaves like an infinitely distant sun (no parallax as
    // the player swims). As a camera-facing sprite it looks identical from
    // every view angle — no flicker when orbiting or looking straight up.
    this.raySprite.position.copy(camera.position).addScaledVector(this.sunDir, 340);
    const shallowness = Math.pow(1 - depth01, 1.3);
    this.raySpriteMat.opacity = (0.5 + Math.sin(this.time * 0.6) * 0.05) * shallowness;

    // Marker pulse.
    const pulse = 0.5 + Math.sin(this.time * 2.2) * 0.5;
    this.markerLight.intensity = 25 + pulse * 30;
    (this.markerRing.material as MeshBasicMaterial).opacity = 0.5 + pulse * 0.45;
    this.markerRing.rotation.y = this.time * 0.4;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.fog = null;
    this.scene.background = null;
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh || (obj as Points).type === 'Points') {
        mesh.geometry?.dispose();
      }
    });
    for (const d of this.disposables) d.dispose();
    this.terrain.dispose();
  }
}
