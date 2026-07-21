import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Points,
  RepeatWrapping,
  type Scene,
  ShaderMaterial,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { SHAFT, ShaftTerrain } from './ShaftTerrain';
import { KingdomDressing } from './KingdomDressing';
import type {
  AssetLoaderLike,
  CylinderCollider,
  DescentInfo,
  PopulationArea,
  TerrainMaps,
  Zone,
  ZoneBounds,
} from './types';
import { FALLEN_KINGDOM_POP } from '../data/creatures';
import type { PopEntry } from '../data/creatures';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The Fallen Kingdom — a drowned cathedral-well.
 *
 * A wide, upright stone cylinder open at the top (a shaft of pale light pours in
 * where you drop through) and at the bottom (the black throat you descend on).
 * Where the Garden was a horizontal cavern, this zone is VERTICAL: its whole
 * character is height, so the space is read by falling through it past four
 * colossal columns that hold the walls apart, ledges of ruined architecture, and
 * — the point of the place — crystal. Gems grow everywhere in flowering bursts,
 * self-lit, the only real colour in the gloom, so the descent feels like sinking
 * into a geode.
 *
 * Shape and radial containment live in {@link ShaftTerrain}; the modelled content
 * (columns, ruins, crystals) in {@link KingdomDressing}. This class owns the wall
 * shell, the light, the atmosphere, and the lifecycle.
 */
export class FallenKingdom implements Zone {
  readonly displayName = 'The Fallen Kingdom';
  readonly group = new Group();
  readonly terrain = new ShaftTerrain();
  readonly colliders: CylinderCollider[] = [];
  particleCount = 0;

  private readonly scene: Scene;
  private time = 0;
  private fog!: FogExp2;
  private hemi!: HemisphereLight;
  private topLight!: DirectionalLight;
  private coreLight!: PointLight;
  private shaftMat!: ShaderMaterial;
  private particleMat!: ShaderMaterial;
  private particles!: Points;
  private wallTexture: Texture | null = null;
  private dressing_: KingdomDressing | null = null;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  build(_renderer: WebGLRenderer, particleScale: number, maps?: TerrainMaps): void {
    // Deep indigo water, a touch of violet — the colour the crystals throw back.
    // Fog is kept THIN: the well is 440 m across and the far wall has to read, or
    // the whole zone collapses to crystals floating in black.
    this.fog = new FogExp2(0x0b0e22, 0.0032);
    this.scene.fog = this.fog;
    this.scene.background = new Color(0x080816);

    // Ambient. The ground colour is deliberately NOT black: a hemisphere light
    // shades a vertical surface with the sky/ground blend, so a black ground
    // leaves the tall walls unlit. Lifting both, and the intensity, is what makes
    // the far stone read across a 440 m well.
    this.hemi = new HemisphereLight(0xb4c6ff, 0x3a3260, 4.6);
    this.group.add(this.hemi);

    // The shaft of light from the open top: a strong, pale key raking straight
    // down the centre of the well — lights the floor and the horizontal ledges,
    // and makes arriving read as dropping into somewhere sacred, lit from a sky
    // you can no longer reach.
    this.topLight = new DirectionalLight(0xdce8ff, 5.0);
    this.topLight.position.set(0, SHAFT.wallTop + 160, 0);
    this.topLight.target.position.set(0, SHAFT.floorY, 0);
    this.group.add(this.topLight, this.topLight.target);

    // Point lights strung down the central axis. A top-down key barely touches a
    // vertical wall, so these radial sources are what actually reveal the walls,
    // the four columns, and the ruins at every height — cool where the light
    // enters up top, warming into crystal-violet as you sink.
    this.coreLight = new PointLight(0xbcd6ff, 900, 700, 1.3);
    this.coreLight.position.set(0, SHAFT.wallTop - 20, 0);
    this.group.add(this.coreLight);
    const midLight = new PointLight(0x9a7cff, 650, 560, 1.5);
    midLight.position.set(0, SHAFT.wallTop * 0.5, 0);
    this.group.add(midLight);
    const lowLight = new PointLight(0x7f9cff, 480, 460, 1.6);
    lowLight.position.set(0, SHAFT.floorY + 80, 0);
    this.group.add(lowLight);

    if (maps) {
      const tile = (src: Texture, n: number, m = n): Texture => {
        const t = src.clone();
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(n, m);
        t.needsUpdate = true;
        this.disposables.push(t);
        return t;
      };
      this.wallTexture = tile(maps.map, 10, 22); // many courses up the tall wall
      const { floor } = this.terrain.build(maps);
      this.group.add(floor);
    } else {
      const { floor } = this.terrain.build();
      this.group.add(floor);
    }

    this.buildWall(maps);
    this.buildLightShaft();
    this.buildParticles(particleScale);

    this.scene.add(this.group);
  }

  /** Second phase: the modelled kingdom — columns, ruins, crystal. */
  async dressing(loader: AssetLoaderLike): Promise<void> {
    this.dressing_ = new KingdomDressing(this.group, this.terrain);
    await this.dressing_.build(loader);
    for (const c of this.dressing_.colliders) this.colliders.push(c);
    console.log(
      `[404hz] fallen kingdom dressing: +${this.dressing_.drawCalls} draw calls, ` +
        `+${(this.dressing_.tris / 1000).toFixed(0)}k tris`,
    );
  }

  // ---- the cylinder wall --------------------------------------------------

  /**
   * The well's wall: a tall open-ended cylinder seen from the inside. Displaced
   * with value noise so it reads as ancient hewn stone rather than a machined
   * tube, and vertex-shaded in horizontal courses that darken into the depths and
   * warm toward the light above.
   *
   * Displacement is biased OUTWARD (it only rarely pushes in, and never by more
   * than a body's width) so the visible rock never crosses the radial containment
   * line the host is stopped at — you press against the wall, you don't clip it.
   */
  private buildWall(maps?: TerrainMaps): void {
    const R = SHAFT.radius;
    const bottom = SHAFT.floorY - 24;
    const top = SHAFT.wallTop;
    const height = top - bottom;
    const radialSegs = 128;
    const heightSegs = 64;
    const geo = new CylinderGeometry(R, R, height, radialSegs, heightSegs, true);
    geo.translate(0, bottom + height / 2, 0);

    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const textured = !!maps;
    const light = textured ? new Color(0.95, 0.98, 1.12) : new Color(0x4c5570);
    const dark = textured ? new Color(0.46, 0.49, 0.6) : new Color(0x1a1d2b);
    const violet = textured ? new Color(0.54, 0.42, 0.76) : new Color(0x241b38);
    const deep = textured ? new Color(0.1, 0.11, 0.18) : new Color(0x05060c);
    const tmp = new Color();
    const tmp2 = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const ang = Math.atan2(z, x);
      // Craggy relief: layered noise around the ring and up the wall.
      const u = (ang / Math.PI) * 12;
      const v = y * 0.03;
      const n =
        noise2(u, v) * 0.6 + noise2(u * 2.3 + 11, v * 2.1 + 5) * 0.3 + noise2(u * 5 + 3, v * 4 + 9) * 0.1;
      // Biased outward: range about -2.5 .. +7.5 m.
      const disp = (n - 0.25) * 10;
      const inv = (R + disp) / R;
      pos.setX(i, x * inv);
      pos.setZ(i, z * inv);

      // Horizontal courses (built stone), plus the outward relief catching light.
      const course = 0.5 + 0.5 * Math.sin(y * 0.16 + noise2(u * 0.5, v) * 2.0);
      tmp.copy(dark).lerp(light, smoothstep(0.2, 0.9, course) * (0.5 + n * 0.6));
      const vt = smoothstep(0.62, 0.9, noise2(u * 0.7 + 20, v * 0.6 + 4));
      tmp.lerp(tmp2.copy(violet), vt * 0.5);
      // Height gradient: bright and cool at the top where light enters, darker
      // (but never black — the walls must still read) toward the depths.
      const hT = smoothstep(bottom, top, y);
      tmp.multiplyScalar(0.58 + hT * 0.55);
      tmp.lerp(tmp2.copy(deep), (1 - hT) * (1 - hT) * 0.4);
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
      side: BackSide, // seen from inside the tube
      map: this.wallTexture ?? undefined,
      // A faint self-glow so the far wall never falls to pure black — reads as
      // ancient stone soaked in the crystal light, independent of distance/fog.
      emissive: new Color(0x1c2444),
      emissiveIntensity: 0.9,
    });
    this.disposables.push(geo, mat);
    const mesh = new Mesh(geo, mat);
    mesh.name = 'shaft-wall';
    this.group.add(mesh);
  }

  // ---- the shaft of light -------------------------------------------------

  /**
   * A soft volumetric column of light down the centre of the well — the god-ray
   * from the open top. A cylinder rendered additively with a shader that fades to
   * nothing at its edge and toward the floor, and drifts slowly, so it reads as
   * hanging light in dusty water rather than a solid object. Deliberately faint;
   * the real brightness is the directional key and the emissive crystal.
   */
  private buildLightShaft(): void {
    const R = SHAFT.radius * 0.5;
    const bottom = SHAFT.floorY + 20;
    const top = SHAFT.wallTop + 40;
    const height = top - bottom;
    const geo = new CylinderGeometry(R * 0.7, R, height, 40, 1, true);
    geo.translate(0, bottom + height / 2, 0);

    this.shaftMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uBottom: { value: bottom },
        uTop: { value: top },
        uColor: { value: new Color(0x8fb4ff) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uBottom;
        uniform float uTop;
        uniform vec3 uColor;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          // Fade in from the sides (edges of the tube face the camera thinnest).
          float edge = sin(vUv.x * 3.14159);
          // Brightest near the top where the light enters, fading down the well.
          float h = clamp((vWorld.y - uBottom) / (uTop - uBottom), 0.0, 1.0);
          float vert = pow(h, 1.6);
          float shimmer = 0.85 + 0.15 * sin(vWorld.y * 0.05 + uTime * 0.6);
          float a = edge * edge * vert * shimmer * 0.16;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    const mesh = new Mesh(geo, this.shaftMat);
    mesh.name = 'light-shaft';
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, this.shaftMat);
  }

  // ---- suspended motes ----------------------------------------------------

  private buildParticles(scale: number): void {
    const count = Math.floor(3600 * scale);
    this.particleCount = count;
    const box = 44;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const rand = mulberry32(4242);
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
      blending: AdditiveBlending,
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
          // Motes drift gently UPWARD — dust rising into the light from the top.
          p.x += sin(uTime * 0.14 + aSeed * 1.7) * 1.4;
          p.y += mod(uTime * 0.5 + aSeed * 3.1, uBox);
          p.z += cos(uTime * 0.13 + aSeed * 1.1) * 1.4;
          vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCamPos + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = -mv.z;
          vAlpha = (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, dist)) * 0.7;
          gl_PointSize = (18.0 / dist) * (0.4 + fract(aSeed) * 1.2) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d) * vAlpha;
          gl_FragColor = vec4(0.72, 0.82, 1.0, a * 0.5);
        }
      `,
    });
    this.particles = new Points(geo, this.particleMat);
    this.particles.frustumCulled = false;
    this.group.add(this.particles);
    this.disposables.push(geo, this.particleMat);
  }

  setParticleScale(scale: number): void {
    this.group.remove(this.particles);
    this.particles.geometry.dispose();
    this.particleMat.dispose();
    this.buildParticles(scale);
  }

  // ---- Zone interface -----------------------------------------------------

  /** A gentle draw toward the centre and down — you are sinking into the well. */
  getSpawnImpulse(out: Vector3): Vector3 {
    return out.set(-5, -12, -18);
  }

  getSpawn(out: Vector3): Vector3 {
    return out.set(SHAFT.spawn.x, SHAFT.spawn.y, SHAFT.spawn.z);
  }

  getBounds(): ZoneBounds {
    // A square backstop just outside the circle; the real wall is the radial
    // containAt, which holds the host at every height where a box cannot.
    const b = SHAFT.radius + 30;
    return {
      ceilingY: SHAFT.ceilingY,
      minX: -b,
      maxX: b,
      minZ: -b,
      maxZ: b,
      softMargin: SHAFT.softMargin,
    };
  }

  /** Radial containment inside the cylinder wall (delegated to the terrain). */
  containAt(pos: Vector3, vel: Vector3, radius: number, dt: number): void {
    this.terrain.containAt(pos, vel, radius, dt);
  }

  getPopulationArea(): PopulationArea {
    // Kept well inside the circle so nothing spawns in the wall; the ecosystem's
    // roaming bubble spreads them through the shaft from there.
    const r = SHAFT.radius * 0.62;
    return { minX: -r, maxX: r, minZ: -r, maxZ: r };
  }

  getPopulation(): PopEntry[] {
    return FALLEN_KINGDOM_POP;
  }

  /** The kingdom grows its own crystal; the shared reef flora must not plant here. */
  getFloraArea(): PopulationArea | null {
    return null;
  }

  /**
   * TWO Signal Carriers, on the basin floor at opposite sides of the well, each
   * in its own crystal precinct. Clearing both is the Kingdom's objective.
   */
  getCarrierAnchors(): Vector3[] {
    const spots: [number, number][] = [
      [118, -70],
      [-128, 96],
    ];
    return spots.map(([x, z]) => new Vector3(x, this.terrain.heightAt(x, z), z));
  }

  /** The deepest relays yet — bigger and tougher than the Garden's. */
  getCarrierConfig(): { size: number; health: number } {
    return { size: 17, health: 5200 };
  }

  getDescentInfo(): DescentInfo {
    return { targetName: 'The Abyss', recommendedDominance: 'Apex' };
  }

  /** The way down is the black throat at the centre of the basin. */
  isInDescentZone(pos: Vector3): boolean {
    const ex = SHAFT.exit;
    return Math.hypot(pos.x - ex.x, pos.z - ex.z) < ex.radius * 0.8 && pos.y < SHAFT.floorY + 24;
  }

  /**
   * Declining the descent lifts the host up out of the throat and off-centre, so
   * it climbs back into the well rather than being left wedged in the exit.
   */
  repelFromDescent(pos: Vector3, vel: Vector3, dt: number): boolean {
    const ex = SHAFT.exit;
    const dx = pos.x - ex.x;
    const dz = pos.z - ex.z;
    const d = Math.hypot(dx, dz);
    if (d > ex.radius * 1.6 && pos.y > SHAFT.floorY + 30) return true;
    vel.y += 52 * dt; // rise first — being down the throat is what traps you
    if (d < 1e-3) {
      vel.x += 40 * dt;
      return false;
    }
    vel.x += (dx / d) * 60 * dt;
    vel.z += (dz / d) * 60 * dt;
    return false;
  }

  // ---- frame update -------------------------------------------------------

  update(dt: number, camera: PerspectiveCamera, _renderer: WebGLRenderer): void {
    this.time += dt;
    this.particleMat.uniforms.uTime.value = this.time;
    this.particleMat.uniforms.uCamPos.value.copy(camera.position);
    this.particleMat.uniforms.uPixelRatio.value = _renderer.getPixelRatio();
    this.shaftMat.uniforms.uTime.value = this.time;

    // Depth cue: the deeper you sink, the murkier and darker the water, and the
    // less the light from the open top reaches you.
    const down = smoothstep(SHAFT.wallTop, SHAFT.floorY + 40, camera.position.y);
    this.fog.density = 0.0028 + down * 0.0035;
    this.topLight.intensity = 5.0 * (1 - down * 0.45);
    this.hemi.intensity = 4.6 - down * 1.3;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh || (obj as Points).type === 'Points') mesh.geometry?.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.dressing_?.dispose();
    this.dressing_ = null;
    this.terrain.dispose();
  }
}
