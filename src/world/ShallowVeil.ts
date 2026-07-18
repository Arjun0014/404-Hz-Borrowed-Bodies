import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
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
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { FOG, WORLD } from '../config';
import { Terrain } from './Terrain';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The Shallow Veil zone: terrain, lighting, fog, surface, ambient particles,
 * rocks, kelp, distant silhouettes, and the descent-point placeholder.
 * Owns everything zone-scoped and can fully dispose itself (Phase 2 depends on it).
 */
export class ShallowVeil {
  readonly group = new Group();
  readonly terrain = new Terrain();
  particleCount = 0;

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
  private kelpMats: MeshStandardMaterial[] = [];
  private markerRing!: Mesh;
  private markerLight!: PointLight;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  build(_renderer: WebGLRenderer, particleScale: number): void {
    this.fog = new FogExp2(FOG.shallowColor, FOG.density);
    this.scene.fog = this.fog;
    // scene.background is tone-mapped like fogged geometry (setClearColor is
    // not), so distant objects dissolve into the backdrop seamlessly.
    this.scene.background = this.fogNow.copy(this.fogShallow);

    this.hemi = new HemisphereLight(0xa5dcec, 0x14323d, 1.05);
    this.group.add(this.hemi);
    const sun = new DirectionalLight(0xd8f0f4, 1.5);
    sun.position.set(60, 160, 30);
    this.group.add(sun);

    this.group.add(this.terrain.build());

    this.buildSurface();
    this.buildParticles(particleScale);
    this.buildRocks();
    this.buildKelp();
    this.buildSilhouettes();
    this.buildDescentMarker();

    this.scene.add(this.group);
  }

  // ---- surface -------------------------------------------------------------

  private buildSurface(): void {
    const geo = new PlaneGeometry(1400, 1400, 1, 1);
    geo.rotateX(Math.PI / 2); // faces downward (visible from below)
    this.surfaceMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
      },
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
        void main() {
          vec2 p = vWorld.xz * 0.05;
          float w = sin(p.x * 2.1 + uTime * 0.9) * sin(p.y * 1.7 - uTime * 0.7);
          w += sin((p.x + p.y) * 3.3 + uTime * 1.3) * 0.5;
          w = w * 0.5 + 0.5;
          vec3 col = mix(vec3(0.13, 0.35, 0.42), vec3(0.55, 0.85, 0.9), w * 0.55);
          float dist = length(vWorld.xz);
          float fade = 1.0 - smoothstep(250.0, 650.0, dist);
          gl_FragColor = vec4(col, (0.28 + w * 0.22) * fade);
        }
      `,
    });
    const surface = new Mesh(geo, this.surfaceMat);
    surface.position.y = WORLD.surfaceY;
    surface.renderOrder = 2;
    this.group.add(surface);
    this.disposables.push(geo, this.surfaceMat);

    // Soft sun glow seen through the surface.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(230, 250, 245, 0.9)');
    grad.addColorStop(0.35, 'rgba(160, 225, 220, 0.35)');
    grad.addColorStop(1, 'rgba(120, 200, 210, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const glowTex = new CanvasTexture(canvas);
    const glowMat = new SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    const glow = new Sprite(glowMat);
    glow.scale.setScalar(220);
    glow.position.set(60, WORLD.surfaceY + 30, 30);
    this.group.add(glow);
    this.disposables.push(glowTex, glowMat);
  }

  // ---- suspended particles -------------------------------------------------

  private buildParticles(scale: number): void {
    const count = Math.floor(1500 * scale);
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
          // Wrap the cloud around the camera so it is always present.
          vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCamPos + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = -mv.z;
          vAlpha = (1.0 - smoothstep(uBox * 0.32, uBox * 0.5, dist)) * 0.5;
          gl_PointSize = (36.0 / dist) * (1.2 + fract(aSeed) * 1.6) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vAlpha;
          gl_FragColor = vec4(0.75, 0.9, 0.88, a * 0.4);
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

  // ---- rocks ---------------------------------------------------------------

  private buildRocks(): void {
    const rand = mulberry32(9001);
    const mat = new MeshStandardMaterial({ color: 0x5a626b, roughness: 1 });
    this.disposables.push(mat);
    const variants = 3;
    const perVariant = 46;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const posV = new Vector3();

    for (let v = 0; v < variants; v++) {
      const geo = new IcosahedronGeometry(1, 2);
      const p = geo.attributes.position as BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const n = 0.72 + mulberry32(i * 31 + v * 977)() * 0.55;
        p.setXYZ(i, p.getX(i) * n, p.getY(i) * n * 0.82, p.getZ(i) * n);
      }
      geo.computeVertexNormals();
      this.disposables.push(geo);

      const mesh = new InstancedMesh(geo, mat, perVariant + (v === 0 ? 6 : 0));
      let idx = 0;
      for (let i = 0; i < perVariant; i++) {
        const { x, z } = this.pickSpot(rand, 30);
        const s = 0.9 + rand() * rand() * 5.5;
        scl.set(s * (0.8 + rand() * 0.5), s * (0.7 + rand() * 0.5), s * (0.8 + rand() * 0.5));
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        posV.set(x, this.terrain.heightAt(x, z) + s * 0.18, z);
        m.compose(posV, q, scl);
        mesh.setMatrixAt(idx++, m);
      }
      // A few giant landmark rocks on variant 0.
      if (v === 0) {
        for (let i = 0; i < 6; i++) {
          const { x, z } = this.pickSpot(rand, 60);
          const s = 10 + rand() * 8;
          scl.set(s, s * (0.9 + rand() * 0.6), s);
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          posV.set(x, this.terrain.heightAt(x, z) + s * 0.1, z);
          m.compose(posV, q, scl);
          mesh.setMatrixAt(idx++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  /** Random placement avoiding the pit, the spawn area, and the outer wall. */
  private pickSpot(rand: () => number, dropMargin: number): { x: number; z: number } {
    for (let tries = 0; tries < 40; tries++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (WORLD.playableRadius - 12);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const dDrop = Math.hypot(x - WORLD.dropCenter.x, z - WORLD.dropCenter.z);
      const dSpawn = Math.hypot(x - WORLD.spawn.x, z - WORLD.spawn.z);
      if (dDrop > WORLD.dropRadius + dropMargin && dSpawn > 22) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  // ---- kelp ----------------------------------------------------------------

  private buildKelp(): void {
    const rand = mulberry32(4242);
    const configs = [
      { height: 4.5, width: 0.42, count: 110, color: 0x2e5b3a },
      { height: 7.5, width: 0.55, count: 70, color: 0x27503c },
    ];
    for (const cfg of configs) {
      const geo = new PlaneGeometry(cfg.width, cfg.height, 1, 7);
      geo.translate(0, cfg.height / 2, 0);
      const mat = new MeshStandardMaterial({
        color: cfg.color,
        roughness: 0.9,
        side: DoubleSide,
      });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        (mat.userData as { shader?: unknown }).shader = shader;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `
            #include <begin_vertex>
            #ifdef USE_INSTANCING
            {
              vec2 ipos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
              float ph = ipos.x * 0.37 + ipos.y * 0.53;
              float f = pow(uv.y, 1.7);
              transformed.x += sin(uTime * 0.85 + ph) * 0.55 * f;
              transformed.z += cos(uTime * 0.63 + ph * 1.3) * 0.4 * f;
            }
            #endif
            `,
          );
      };
      this.kelpMats.push(mat);
      this.disposables.push(geo, mat);

      const mesh = new InstancedMesh(geo, mat, cfg.count);
      const m = new Matrix4();
      const q = new Quaternion();
      const up = new Vector3(0, 1, 0);
      const s = new Vector3();
      const p = new Vector3();
      // Clustered placement: pick cluster centers, scatter strands around them.
      const clusters = Math.ceil(cfg.count / 14);
      let idx = 0;
      for (let c = 0; c < clusters && idx < cfg.count; c++) {
        const center = this.pickSpot(rand, 40);
        for (let i = 0; i < 14 && idx < cfg.count; i++) {
          const x = center.x + (rand() - 0.5) * 16;
          const z = center.z + (rand() - 0.5) * 16;
          const sc = 0.7 + rand() * 0.7;
          s.set(sc, sc * (0.8 + rand() * 0.5), sc);
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          p.set(x, this.terrain.heightAt(x, z) - 0.1, z);
          m.compose(p, q, s);
          mesh.setMatrixAt(idx++, m);
        }
      }
      mesh.count = idx;
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  // ---- distant silhouettes -------------------------------------------------

  private buildSilhouettes(): void {
    const rand = mulberry32(777);
    const mat = new MeshBasicMaterial({ color: 0x143540 });
    this.disposables.push(mat);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rand() * 0.5;
      // Skip the drop-off direction so the pit's darkness reads clean.
      const dropA = Math.atan2(WORLD.dropCenter.z, WORLD.dropCenter.x);
      if (Math.abs(Math.atan2(Math.sin(a - dropA), Math.cos(a - dropA))) < 0.5) continue;
      const geo = new ConeGeometry(30 + rand() * 35, 45 + rand() * 55, 5);
      this.disposables.push(geo);
      const mesh = new Mesh(geo, mat);
      const r = 300 + rand() * 45;
      mesh.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      mesh.rotation.y = rand() * Math.PI;
      this.group.add(mesh);
    }
  }

  // ---- descent marker (placeholder for Phase 2) ----------------------------

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

  // ---- frame update --------------------------------------------------------

  update(dt: number, camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    this.time += dt;
    this.terrain.update(dt);

    this.particleMat.uniforms.uTime.value = this.time;
    this.particleMat.uniforms.uCamPos.value.copy(camera.position);
    this.particleMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    this.surfaceMat.uniforms.uTime.value = this.time;

    for (const mat of this.kelpMats) {
      const shader = (mat.userData as { shader?: { uniforms: { uTime: { value: number } } } }).shader;
      if (shader) shader.uniforms.uTime.value = this.time;
    }

    // Depth-graded water colour: darker as the camera sinks.
    // fogNow is also the scene.background instance, so mutating it updates both.
    const depth01 = Math.min(1, Math.max(0, (WORLD.surfaceY - camera.position.y) / 90));
    this.fogNow.copy(this.fogShallow).lerp(this.fogDeep, depth01 * depth01 * 0.9 + depth01 * 0.1);
    this.fog.color.copy(this.fogNow);
    this.hemi.intensity = 1.05 - depth01 * 0.45;

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
