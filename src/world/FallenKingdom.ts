import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  RepeatWrapping,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { KINGDOM, KingdomTerrain } from './KingdomTerrain';
import { KingdomDressing } from './KingdomDressing';
import type {
  AssetLoaderLike,
  CarrierSpec,
  CylinderCollider,
  DescentInfo,
  PopulationArea,
  TerrainMaps,
  Zone,
  ZoneBounds,
} from './types';
import type { BoxCollider } from './Solids';
import { FALLEN_KINGDOM_POP } from '../data/creatures';
import type { PopEntry } from '../data/creatures';
import type { CarrierVariant } from '../entities/SignalCarrier';
import heraldUrl from '../../assets/fallen kingdom/hsw_boss_colossal_squid_lot_of_animations.glb?url';

/**
 * How wide a ring the Herald patrols around the throat: tight enough that it is
 * unmistakably guarding the hole rather than wandering the basin, and low enough
 * that it stays down inside the collapse with you.
 */
const HERALD_ORBIT = 38;

/**
 * The Drowned Herald: the colossal squid that holds the way out.
 *
 * It is a Signal Carrier — same nodes, same aura, same Dead Signal Field when
 * it dies — but it behaves like the animal it is. It patrols a ring above the
 * collapse rather than hovering, it never leaves that ring to chase, and
 * anything that swims inside its arms gets lashed. Five shield nodes instead of
 * three, because at 46 m it is nearly three times the size of the relay upstairs
 * and three nodes read as sparse on a body that big.
 *
 * Its real weight is the seal: while it lives, the throat at the bottom of the
 * geode is shut, so this is not an optional encounter. You leave through it.
 */
const HERALD: CarrierVariant = {
  modelUrl: heraldUrl,
  title: 'The Drowned Herald',
  roam: { radius: HERALD_ORBIT, speed: 5.2, rise: 4 },
  // Long arms, a slow telegraph, and a hit that genuinely hurts an apex host.
  melee: { range: 42, damage: 46, cooldown: 3.4, windup: 0.75 },
  clips: {
    idle: /A_Idle$/i,
    swim: /A_Swim$/i,
    fast: /SwimFast/i,
    attack: /A_Attack$/i,
    death: /Death/i,
  },
  nodeCount: 5,
  sealsDescent: true,
  radiusFactor: 0.3,
  // The pack ships the boss in a Christmas hat. It is not staying.
  hideMeshes: /xmashat/i,
};

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The Fallen Kingdom — a drowned city under a collapsed cavern roof.
 *
 * You arrive by falling through the BREACH: the hole where the vault gave way
 * directly above the citadel, 250 m over the acropolis. A single shaft of pale
 * light comes down it and lands on the throne, and everything else is lit by the
 * crystal that has eaten the place. Sinking down that shaft, past the rim, and
 * watching a whole city resolve out of the dark below you is the entire point of
 * the zone's first thirty seconds.
 *
 * Shape and ground plan live in {@link KingdomTerrain}; the city itself in
 * {@link KingdomDressing}. This class owns atmosphere, lighting, and lifecycle.
 *
 * Lighting is what this zone gets wrong most easily, so the reasoning is
 * recorded here. A city is made of VERTICAL surfaces, and light coming straight
 * down the breach barely grazes any of them — a top-down key alone renders the
 * whole town as black silhouettes standing on a lit floor, which is exactly how
 * the previous version of this zone failed. So the rig is four parts: a strong
 * downward key for the citadel, two nearly-horizontal rakes from opposite
 * quarters so every wall face catches something, a bright hemisphere for base
 * readability at range, and emissive on the stone itself. No point lights — they
 * fall off as 1/d² and this map is 760 m across, so they contribute nothing.
 */
export class FallenKingdom implements Zone {
  readonly displayName = 'The Fallen Kingdom';
  readonly group = new Group();
  readonly terrain = new KingdomTerrain();
  readonly colliders: CylinderCollider[] = [];
  /**
   * Wall solids. This is the only zone with architecture, and a wall is the one
   * obstacle a cylinder cannot describe — see {@link BoxCollider}.
   */
  readonly boxColliders: BoxCollider[] = [];
  particleCount = 0;

  private readonly scene: Scene;
  private time = 0;
  private fog!: FogExp2;
  private hemi!: HemisphereLight;
  private shaftLight!: DirectionalLight;
  private rakeA!: DirectionalLight;
  private rakeB!: DirectionalLight;
  private glowFill!: DirectionalLight;
  private beam!: Mesh;
  private beamMat!: ShaderMaterial;
  private particleMat!: ShaderMaterial;
  private particles!: Points;
  private masonryTexture: Texture | null = null;
  private city: KingdomDressing | null = null;
  private readonly disposables: { dispose(): void }[] = [];
  /** The membrane over the throat, and whether it is currently up. */
  private sealMesh: Mesh | null = null;
  private sealMat: ShaderMaterial | null = null;
  private sealed = true;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  build(
    _renderer: WebGLRenderer,
    particleScale: number,
    maps?: TerrainMaps,
    trimMaps?: TerrainMaps,
  ): void {
    // Deep cold water with a mineral cast. Density is deliberately LIGHTER than
    // the Drowned Garden's: that zone is about not seeing what is around you,
    // this one is about reading a city plan across 600 m. It still closes in as
    // you drop into the geode (see update).
    this.fog = new FogExp2(0x071019, 0.0034);
    this.scene.fog = this.fog;
    this.scene.background = new Color(0x04080e);

    // Base readability. A hemisphere is the only light that reaches the far side
    // of a 760 m map for free, so it carries the load. Sky term is the breach
    // and the crystal; ground term is warm silt rather than black — a cold sky
    // over a cold ground made every surface in the zone the same blue and the
    // city read as one flat teal mass, and the warm bounce is what separates a
    // lit face from a shadowed one at distance.
    this.hemi = new HemisphereLight(0x6f9dc4, 0x241d16, 2.7);
    this.group.add(this.hemi);

    // The key: light pouring down the breach. Aimed slightly off vertical so the
    // citadel's columns throw their length across the plateau instead of pooling
    // straight down at their own feet.
    this.shaftLight = new DirectionalLight(0xbfe6ff, 5.4);
    this.shaftLight.position.set(KINGDOM.breach.x + 60, 700, KINGDOM.breach.z - 90);
    this.shaftLight.target.position.set(0, KINGDOM.acropolis.height, 0);
    this.group.add(this.shaftLight, this.shaftLight.target);

    // The two rakes: nearly horizontal, from opposite quarters, cool on one side
    // and warm on the other. This is what gives every wall in the town a lit
    // face and a shadowed face, and therefore what makes the city read as solid.
    this.rakeA = new DirectionalLight(0x9ccbe2, 2.0);
    this.rakeA.position.set(-600, 150, -320);
    this.rakeA.target.position.set(0, 40, 0);
    this.group.add(this.rakeA, this.rakeA.target);

    this.rakeB = new DirectionalLight(0xffb070, 2.1);
    this.rakeB.position.set(560, 120, 420);
    this.rakeB.target.position.set(0, 40, 0);
    this.group.add(this.rakeB, this.rakeB.target);

    // A cold up-light out of the geode, as though the crystal down there burns.
    this.glowFill = new DirectionalLight(0x4fd8e8, 1.1);
    this.glowFill.position.set(KINGDOM.geode.x, -120, KINGDOM.geode.z);
    this.glowFill.target.position.set(KINGDOM.geode.x * 0.3, 90, KINGDOM.geode.z * 0.3);
    this.group.add(this.glowFill, this.glowFill.target);

    if (maps) {
      const tile = (src: Texture, n: number, m = n): Texture => {
        const t = src.clone();
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(n, m);
        t.needsUpdate = true;
        this.disposables.push(t);
        return t;
      };
      const shell: TerrainMaps = { map: tile(maps.map, 80), normalMap: tile(maps.normalMap, 80) };
      if (maps.armMap) shell.armMap = tile(maps.armMap, 80);
      // Masonry tiles far tighter than terrain. A course of stone is ~1.7 m and
      // the pieces are a few metres across, so the slate has to repeat at
      // roughly that rate or a wall reads as one smeared sheet of rock instead
      // of as laid blocks.
      this.masonryTexture = tile((trimMaps ?? maps).map, 3, 3);
      const { floor, roof } = this.terrain.build(shell);
      this.group.add(floor, roof);
    } else {
      const { floor, roof } = this.terrain.build();
      this.group.add(floor, roof);
    }

    this.buildBeam();
    this.buildExitThroat();
    this.buildSeal();
    this.buildParticles(particleScale);

    this.scene.add(this.group);
  }

  async dressing(loader: AssetLoaderLike, densityScale = 1): Promise<void> {
    this.city = new KingdomDressing(this.group, this.terrain, this.masonryTexture, densityScale);
    await this.city.build(loader);
    for (const c of this.city.colliders) this.colliders.push(c);
    for (const b of this.city.boxes) this.boxColliders.push(b);
    console.log(
      `[404hz] fallen kingdom dressing: +${this.city.drawCalls} draw calls, ` +
        `+${(this.city.tris / 1000).toFixed(0)}k tris, ` +
        `${this.colliders.length} cylinders + ${this.boxColliders.length} wall boxes`,
    );
  }

  // ---- the shaft of light ---------------------------------------------------

  /**
   * The god-ray coming down the breach: one open-ended cone, additive, no depth
   * write.
   *
   * Alpha is keyed on |dot(normal, view)| rather than on the usual rim term, and
   * that inversion is the whole trick. On a hollow cone the eye looks through
   * the MOST water where the surface faces it head-on and through the least at
   * the silhouette, so |N·V| stands in for path length through the volume. The
   * result is a soft-edged column of light instead of a lit tube with a hard
   * outline — which is what gave the last attempt's beam its decal look.
   */
  private buildBeam(): void {
    const topY = KINGDOM.sky + 40;
    const botY = KINGDOM.acropolis.height - 34; // ends inside the mesa: no visible cap
    const h = topY - botY;
    const geo = new CylinderGeometry(
      KINGDOM.breach.r * 0.86,
      KINGDOM.breach.r * 0.72,
      h,
      40,
      1,
      true,
    );
    geo.translate(KINGDOM.breach.x, botY + h / 2, KINGDOM.breach.z);

    this.beamMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: topY },
        uBot: { value: botY },
        uIntensity: { value: 1 },
        uCentre: { value: new Vector3(KINGDOM.breach.x, 0, KINGDOM.breach.z) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vNrm;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vNrm = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uTop;
        uniform float uBot;
        uniform float uIntensity;
        uniform vec3 uCentre;
        varying vec3 vWorld;
        varying vec3 vNrm;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }

        void main() {
          vec3 V = normalize(cameraPosition - vWorld);
          // Path length through the volume. Raised to a power so the falloff
          // toward the silhouette is steep: at a linear falloff the cone keeps a
          // visible hard rim and reads as a frosted glass tube rather than as
          // light, which is exactly how the first pass looked.
          float facing = abs(dot(normalize(vNrm), V));
          float thickness = pow(smoothstep(0.0, 0.92, facing), 2.2);

          float t = clamp((vWorld.y - uBot) / (uTop - uBot), 0.0, 1.0);
          // Absorbed away as it sinks, and eased out at BOTH ends so neither the
          // rim nor the far top of the shaft shows a cut edge.
          float depthFade = pow(1.0 - t, 0.7) * smoothstep(0.0, 0.14, t) * smoothstep(1.0, 0.62, t);

          // Slow vertical striations, so the shaft moves like real water.
          float a = atan(vWorld.z - uCentre.z, vWorld.x - uCentre.x);
          float striate = 0.6 + 0.4 * vnoise(vec2(a * 2.4, vWorld.y * 0.012 - uTime * 0.05));

          float alpha = thickness * depthFade * striate * 0.24 * uIntensity;
          vec3 col = mix(vec3(0.42, 0.68, 0.95), vec3(0.78, 0.9, 1.0), depthFade);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this.beam = new Mesh(geo, this.beamMat);
    this.beam.name = 'breach-beam';
    this.beam.renderOrder = 4;
    this.group.add(this.beam);
    this.disposables.push(geo, this.beamMat);
  }

  // ---- the way down ---------------------------------------------------------

  /** A dark throat at the bottom of the geode. */
  private buildExitThroat(): void {
    const e = KINGDOM.exit;
    const floor = this.terrain.heightAt(e.x, e.z);

    const poolGeo = new CircleGeometry(e.radius, 40);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = new MeshBasicMaterial({ color: 0x02090f, fog: false });
    const pool = new Mesh(poolGeo, poolMat);
    pool.position.set(e.x, floor - 1.5, e.z);
    pool.name = 'kingdom-exit';
    this.group.add(pool);
    this.disposables.push(poolGeo, poolMat);

    const wallGeo = new CylinderGeometry(e.radius, e.radius * 0.84, 30, 40, 1, true);
    const wallMat = new MeshStandardMaterial({
      color: 0x16222b,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
      map: this.masonryTexture ?? undefined,
      emissive: new Color(0x0a1a24),
    });
    const wall = new Mesh(wallGeo, wallMat);
    wall.position.set(e.x, floor - 16, e.z);
    wall.name = 'kingdom-exit-shaft';
    this.group.add(wall);
    this.disposables.push(wallGeo, wallMat);
  }

  // ---- suspended motes ------------------------------------------------------

  private buildParticles(scale: number): void {
    const count = Math.floor(3600 * scale);
    this.particleCount = count;
    const box = 46;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const rand = mulberry32(9071);
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
        varying float vTint;
        void main() {
          vec3 p = position;
          // Motes RISE here (the drowned city is outgassing), against the
          // Garden's silt that sinks. A small thing, but it makes the two zones
          // feel like different water.
          p.x += sin(uTime * 0.13 + aSeed * 1.9) * 1.6;
          p.y += sin(uTime * 0.1 + aSeed * 2.1) * 1.1 + uTime * 0.5;
          p.z += cos(uTime * 0.12 + aSeed * 1.3) * 1.6;
          vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCamPos + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = -mv.z;
          vAlpha = (1.0 - smoothstep(uBox * 0.26, uBox * 0.5, dist)) * 0.8;
          vTint = fract(aSeed * 3.7);
          gl_PointSize = (18.0 / dist) * (0.45 + fract(aSeed) * 1.3) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying float vTint;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.06, d) * vAlpha;
          // A few motes carry the crystal's colour rather than the water's.
          vec3 col = mix(vec3(0.62, 0.78, 0.88), vec3(0.55, 0.92, 1.0), step(0.82, vTint));
          gl_FragColor = vec4(col, a * 0.5);
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

  // ---- Zone interface -------------------------------------------------------

  getSpawn(out: Vector3): Vector3 {
    return out.set(KINGDOM.spawn.x, KINGDOM.spawn.y, KINGDOM.spawn.z);
  }

  /**
   * A downward shove on arrival. You did not swim into this place, you fell into
   * it through a hole in the roof, and the first second should say so.
   */
  getSpawnImpulse(out: Vector3): Vector3 {
    return out.set(0, -22, 6);
  }

  getBounds(): ZoneBounds {
    return {
      // Well above the breach, so the shaft is genuinely open at the top.
      ceilingY: KINGDOM.sky + 60,
      minX: KINGDOM.minX,
      maxX: KINGDOM.maxX,
      minZ: KINGDOM.minZ,
      maxZ: KINGDOM.maxZ,
      softMargin: KINGDOM.softMargin,
    };
  }

  getPopulationArea(): PopulationArea {
    return {
      minX: KINGDOM.minX + 110,
      maxX: KINGDOM.maxX - 110,
      minZ: KINGDOM.minZ + 110,
      maxZ: KINGDOM.maxZ - 110,
    };
  }

  getPopulation(): PopEntry[] {
    return FALLEN_KINGDOM_POP;
  }

  /** The kingdom grows its own crystal and weed; the shared reef scatter must not run. */
  getFloraArea(): PopulationArea | null {
    return null;
  }

  /**
   * TWO carriers, and they are the level's whole arc.
   *
   * The first is the relay in the nave, at the top of the city — the thing you
   * fall past the breach to find. The second is the Drowned Herald, a colossal
   * squid coiled over the collapse, and it is the reason the way down is shut.
   * There is nothing else to do in this zone: climb to the throne, then fight
   * your way out through the bottom.
   *
   * (This replaces three district relays. A third made the level a checklist;
   * two make it a route.)
   */
  /**
   * Unused by this zone — {@link getCarrierSpecs} supersedes it — but the Zone
   * interface requires it, and returning the specs' anchors keeps the two in
   * step for anything that reads anchors generically.
   */
  getCarrierAnchors(): Vector3[] {
    return this.getCarrierSpecs().map((s) => s.anchor.clone());
  }

  getCarrierSpecs(): CarrierSpec[] {
    const at = (x: number, z: number): Vector3 => new Vector3(x, this.terrain.heightAt(x, z), z);
    const e = KINGDOM.exit;
    return [
      {
        // In the NAVE, in front of the throne — not on it. The throne crystal is
        // 82 m across and sits dead centre, so a carrier at (0,0) spawned inside
        // it: invisible, unreachable, and unkillable.
        anchor: at(-52, 0),
        size: 17,
        health: 5000,
      },
      {
        // Anchored to the highest ground its own patrol crosses, not to the
        // floor beneath the throat. The geode is a bowl: at the Herald's orbit
        // radius the floor has already climbed 97 m from the centre, so hovering
        // a fixed height above the CENTRE buried a third of the circuit in the
        // crater wall (measured: 26.6 m inside the rock).
        anchor: new Vector3(e.x, this.ringCeilingY(e.x, e.z, HERALD_ORBIT), e.z),
        size: 46,
        health: 9000,
        variant: HERALD,
      },
    ];
  }

  /** Highest terrain anywhere on a patrol ring, so a roamer clears all of it. */
  private ringCeilingY(cx: number, cz: number, radius: number): number {
    let top = -Infinity;
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      // The orbit radius breathes between 0.82x and 1.0x (see SignalCarrier), so
      // sample the whole band it can actually reach.
      for (const r of [radius * 0.82, radius * 0.91, radius]) {
        top = Math.max(top, this.terrain.heightAt(cx + Math.cos(th) * r, cz + Math.sin(th) * r));
      }
    }
    return top;
  }

  getDescentInfo(): DescentInfo {
    return { targetName: 'The Cold Below', recommendedDominance: 'Apex' };
  }

  /**
   * The throat at the bottom of the geode. Gated on height as well as footprint:
   * the vault here is 250 m up, so an x/z-only test would fire on a player
   * swimming high over the basin who never went near the hole.
   */
  isInDescentZone(pos: Vector3): boolean {
    const e = KINGDOM.exit;
    if (Math.hypot(pos.x - e.x, pos.z - e.z) > e.radius * 0.55) return false;
    return pos.y < this.terrain.heightAt(e.x, e.z) + 40;
  }

  repelFromDescent(pos: Vector3, vel: Vector3, dt: number): boolean {
    const e = KINGDOM.exit;
    const dx = pos.x - e.x;
    const dz = pos.z - e.z;
    const d = Math.hypot(dx, dz);
    const lipY = this.terrain.heightAt(e.x, e.z) + 46;
    if (d > e.radius * 1.6 && pos.y > lipY - 8) return true;
    vel.y += 52 * dt;
    if (d < 1e-3) {
      vel.x += 40 * dt;
      return false;
    }
    vel.x += (dx / d) * 72 * dt;
    vel.z += (dz / d) * 72 * dt;
    return false;
  }

  // ---- the Herald's seal ----------------------------------------------------

  /**
   * The membrane across the throat.
   *
   * A dome rather than a flat disc: swum at from the basin floor you meet a
   * surface that curves away from you, which reads as "closed" from any angle,
   * where a disc seen edge-on reads as nothing at all. Rendered back-side-first
   * with additive blending and no depth write, so it glows over the crystal
   * below instead of z-fighting the rock it is anchored in.
   */
  private buildSeal(): void {
    const e = KINGDOM.exit;
    const y = this.terrain.heightAt(e.x, e.z);
    const geo = new SphereGeometry(e.radius * 1.25, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.5);
    this.sealMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
      vertexShader: `
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vP = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uFade;
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          // Rim-bright, so the dome's edge draws the eye to how big the hole is.
          float fres = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.0);
          // Two counter-running bands of interference: a signal, not a forcefield.
          float band = sin(vP.y * 0.35 - uTime * 1.7) * 0.5 + 0.5;
          float band2 = sin(vP.y * 0.11 + uTime * 0.9) * 0.5 + 0.5;
          float a = (0.10 + fres * 0.72) * (0.55 + band * 0.3 + band2 * 0.25);
          vec3 col = mix(vec3(0.32, 0.86, 1.0), vec3(0.75, 0.42, 1.0), band2);
          gl_FragColor = vec4(col * (0.7 + fres * 1.6), a * uFade);
        }
      `,
    });
    this.sealMesh = new Mesh(geo, this.sealMat);
    this.sealMesh.name = 'kingdom-descent-seal';
    this.sealMesh.position.set(e.x, y - 6, e.z);
    this.sealMesh.renderOrder = 3;
    this.group.add(this.sealMesh);
    this.disposables.push(geo, this.sealMat);
  }

  /** Raise or drop the membrane. Driven by the Herald's life, from GameApp. */
  setDescentSealed(sealed: boolean): void {
    this.sealed = sealed;
    if (this.sealMesh) this.sealMesh.visible = sealed;
  }

  /** True while the Herald still holds the throat shut. */
  get descentSealed(): boolean {
    return this.sealed;
  }

  // ---- frame update ---------------------------------------------------------

  update(dt: number, camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    this.time += dt;
    if (this.sealMat && this.sealed) this.sealMat.uniforms.uTime.value = this.time;
    this.particleMat.uniforms.uTime.value = this.time;
    this.particleMat.uniforms.uCamPos.value.copy(camera.position);
    this.particleMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    this.beamMat.uniforms.uTime.value = this.time;

    const y = camera.position.y;

    // How deep into the city you are: 0 up in the breach, 1 down on the streets.
    const sunk = 1 - smoothstep(KINGDOM.acropolis.height, KINGDOM.vault * 1.4, y);
    // And how far into the geode, which is darker and thicker than anywhere else.
    const g = KINGDOM.geode;
    const geodeD = Math.hypot(camera.position.x - g.x, camera.position.z - g.z);
    const inGeode = (1 - smoothstep(g.r * 0.4, g.r, geodeD)) * (1 - smoothstep(-10, 60, y));

    // Water clears as you rise toward the breach and thickens in the basin, so
    // height itself becomes a navigational cue.
    this.fog.density = 0.0034 + sunk * 0.0016 + inGeode * 0.0055;
    this.hemi.intensity = 2.9 - sunk * 0.5 - inGeode * 0.9;
    // Down in the geode the surface light is gone and only the crystal is left.
    this.glowFill.intensity = 1.1 + inGeode * 2.4;
    this.rakeA.intensity = 2.2 - inGeode * 1.1;
    this.rakeB.intensity = 1.35 - inGeode * 0.8;

    // The shaft breathes, and fades once you are down in the basin where you
    // would be looking at it through half a city anyway.
    const shimmer = 0.88 + Math.sin(this.time * 0.31) * 0.07 + Math.sin(this.time * 0.77) * 0.05;
    this.beamMat.uniforms.uIntensity.value = shimmer * (1 - inGeode * 0.8);
    this.shaftLight.intensity = 5.4 * (0.82 + shimmer * 0.2) * (1 - inGeode * 0.55);

    this.city?.update(camera);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh || (obj as Points).type === 'Points') mesh.geometry?.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.city?.dispose();
    this.city = null;
    this.terrain.dispose();
  }
}
