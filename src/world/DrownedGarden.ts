import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  ExtrudeGeometry,
  MeshStandardMaterial,
  PerspectiveCamera,
  Path,
  Points,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
  type Scene,
  ShaderMaterial,
  Shape,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAVE, CaveTerrain } from './CaveTerrain';
import { GardenDressing, HENGE_CENTRE } from './GardenDressing';
import type {
  AssetLoaderLike,
  CylinderCollider,
  DescentInfo,
  PopulationArea,
  TerrainMaps,
  Zone,
  ZoneBounds,
} from './types';
import { DROWNED_GARDEN_POP } from '../data/creatures';
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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Interior region where rock dressing may be placed (clear of the walls). */
const INNER = {
  minX: CAVE.mouthX + CAVE.mouthThickness + 14,
  maxX: CAVE.maxX - 86,
  minZ: CAVE.minZ + 84,
  maxZ: CAVE.maxZ - 84,
};

/**
 * The Drowned Garden — one colossal flooded cavern, entered through an arch you
 * can see from the far side of the approach.
 *
 * The zone is deliberately just two things, per the brief: the OPENING and the
 * INSIDE. You arrive in open black water facing a 184 m wide, 88 m tall archway
 * bored through a rock curtain; everything past it is the map. Inside, the space
 * is articulated by stone rather than by walls — stalactites in curtains off the
 * vault, stalagmites climbing to meet them, layered drum-stacked boulders on the
 * floor, and full floor-to-ceiling columns that break the cavern into rooms and
 * give the fights something to weave through.
 *
 * Shape lives in {@link CaveTerrain} as analytic floor/roof functions; this class
 * owns the dressing, lighting, and lifecycle. All dressing is instanced, and the
 * columns are the only things that register colliders — the rest is silhouette.
 */
export class DrownedGarden implements Zone {
  readonly displayName = 'The Drowned Garden';
  readonly group = new Group();
  readonly terrain = new CaveTerrain();
  readonly colliders: CylinderCollider[] = [];
  particleCount = 0;

  private readonly scene: Scene;
  private time = 0;
  private fog!: FogExp2;
  private hemi!: HemisphereLight;
  private mouthLight!: DirectionalLight;
  private cliffLight!: DirectionalLight;
  private particleMat!: ShaderMaterial;
  private particles!: Points;
  private rockTexture: Texture | null = null;
  private garden: GardenDressing | null = null;
  private whirlMat!: ShaderMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  build(_renderer: WebGLRenderer, particleScale: number, maps?: TerrainMaps): void {
    // Cold black water. Density is deliberately LOW out at the approach: the
    // arch is 184 m across and has to read as a single enormous shape from well
    // back, and at the Shallow Veil's density it was simply a black wall. The
    // fog thickens as you swim in (see update), so the depth cue is earned by
    // travelling rather than paid for up front.
    this.fog = new FogExp2(0x050b12, 0.0062);
    this.scene.fog = this.fog;
    this.scene.background = new Color(0x03060a);

    // Intensities are high because this zone's fog and background are almost
    // black, so there is no bright base for the rock to sit against the way the
    // Shallow Veil's pale water gives one. Measured against the framebuffer: at
    // the first-pass values the mouth wall rendered at ~3/255 — a silhouette
    // with no surface at all. These land it around 60-90, which is dark and
    // moody but still reads as stone. The cavern's contrast comes from the mouth
    // light falling off with depth (see update), not from starving the ambient.
    this.hemi = new HemisphereLight(0x486e85, 0x090e14, 2.5);
    this.group.add(this.hemi);
    // The mouth light rakes in along +X, so the arch throws real directional
    // light down the throat of the cave and everything deep sits in shadow.
    this.mouthLight = new DirectionalLight(0x8fd8ee, 6.5);
    this.mouthLight.position.set(CAVE.mouthX - 220, 120, 0);
    this.mouthLight.target.position.set(CAVE.mouthX + 160, 0, 0);
    this.group.add(this.mouthLight, this.mouthLight.target);
    // A dim warm bounce from deep inside stops the far end reading as a void.
    const deepFill = new DirectionalLight(0xffb27a, 0.7);
    deepFill.position.set(CAVE.maxX, 60, 0);
    this.group.add(deepFill);
    // Rakes the OUTSIDE of the rock curtain. Without it the approach was a lit
    // hole floating in pure black — you could see the opening but not the cliff
    // it is bored through, so nothing conveyed how much rock is above you.
    this.cliffLight = new DirectionalLight(0x6fa8c4, 4.2);
    this.cliffLight.position.set(CAVE.mouthX - 300, 190, 90);
    this.cliffLight.target.position.set(CAVE.mouthX, 30, 0);
    this.group.add(this.cliffLight, this.cliffLight.target);

    if (maps) {
      // Zone-owned clones so this zone can dispose its own wrap/repeat settings.
      const tile = (src: Texture, n: number, m = n): Texture => {
        const t = src.clone();
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(n, m);
        t.needsUpdate = true;
        this.disposables.push(t);
        return t;
      };
      const shellMaps: TerrainMaps = { map: tile(maps.map, 90), normalMap: tile(maps.normalMap, 90) };
      if (maps.armMap) shellMaps.armMap = tile(maps.armMap, 90);
      this.rockTexture = tile(maps.map, 1.6, 3.2); // vertical-ish tiling for columns
      const { floor, roof } = this.terrain.build(shellMaps);
      this.group.add(floor, roof);
    } else {
      const { floor, roof } = this.terrain.build();
      this.group.add(floor, roof);
    }

    this.buildMouthWall();
    this.buildColumns();
    this.buildStalactites();
    this.buildStalagmites();
    this.buildBoulderStacks();
    this.buildWhirlpool();
    this.buildParticles(particleScale);

    this.scene.add(this.group);
  }

  /**
   * Second phase: the modelled content. Split out so the zone is walkable the
   * instant build() returns and the .glb packs stream in behind it.
   */
  async dressing(loader: AssetLoaderLike): Promise<void> {
    this.garden = new GardenDressing(this.group, this.terrain);
    await this.garden.build(loader);
    // Big props contribute collision; push into the live array the player,
    // camera, and creatures already share.
    for (const c of this.garden.colliders) this.colliders.push(c);
    console.log(
      `[404hz] drowned garden dressing: +${this.garden.drawCalls} draw calls, ` +
        `+${(this.garden.tris / 1000).toFixed(0)}k tris`,
    );
  }

  // ---- rock geometry generators -------------------------------------------

  /**
   * A tapered, ridged spike — the shared stalactite/stalagmite form. Built
   * pointing DOWN (tip at -Y, base at 0) so a stalactite instances directly and
   * a stalagmite is the same geometry flipped. The radius is modulated along its
   * length so it reads as accreted stone with drip collars, not a smooth cone.
   */
  private makeSpikeGeometry(seed: number): BufferGeometry {
    const rand = mulberry32(seed);
    const segs = 14;
    const geo = new CylinderGeometry(1, 0.06, 1, 9, segs);
    const pos = geo.attributes.position as BufferAttribute;
    const collarF = 3 + Math.floor(rand() * 3);
    const lean = (rand() - 0.5) * 0.16;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // -0.5 .. 0.5
      const z = pos.getZ(i);
      const t = 0.5 - y; // 0 at base, 1 at tip
      // Drip collars + a slow taper irregularity.
      const collar = 1 + Math.sin(t * Math.PI * collarF) * 0.13 * (1 - t);
      const wob = 1 + Math.sin(t * 9.3 + rand() * 0.01) * 0.04;
      pos.setX(i, x * collar * wob + lean * t * t);
      pos.setZ(i, z * collar * wob);
    }
    geo.translate(0, -0.5, 0); // base at y=0, tip at y=-1
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * A stack of drums of decreasing radius — the layered motif from the
   * reference. Built sitting on y=0 with unit height, so it instances as either
   * a floor boulder or, stretched, a column shaft.
   */
  private makeStackGeometry(seed: number, tiers: number): BufferGeometry {
    const rand = mulberry32(seed);
    const parts: BufferGeometry[] = [];
    let y = 0;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const h = (0.6 + rand() * 0.8) / tiers;
      // Waist inward as it rises, but never monotonically — real stacks bulge.
      const rTop = 1 - t * 0.42 - rand() * 0.06;
      const rBot = 1 - t * 0.34 + rand() * 0.08;
      const g = new CylinderGeometry(rTop, rBot, h, 9, 1);
      g.translate((rand() - 0.5) * 0.12, y + h / 2, (rand() - 0.5) * 0.12);
      parts.push(g);
      y += h * (0.88 + rand() * 0.08); // overlap slightly so tiers read as bedded
    }
    const merged = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    // Normalise to unit height so instance scale.y maps directly to metres.
    merged.scale(1, 1 / y, 1);
    merged.computeVertexNormals();
    return merged;
  }

  private rockMaterial(): MeshStandardMaterial {
    // White base so per-instance colour multiplies correctly (project rule).
    const mat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.97,
      metalness: 0,
      map: this.rockTexture ?? undefined,
    });
    this.disposables.push(mat);
    return mat;
  }

  /** Cold wet stone with occasional rust, matching the shell's palette. */
  private tintRock(c: Color, rand: () => number): Color {
    const v = 0.3 + rand() * rand() * 0.42;
    c.setRGB(v, v * 1.03, v * 1.12);
    if (rand() < 0.22) c.lerp(TMP_RUST, 0.18 + rand() * 0.3); // iron staining
    return c;
  }

  /** A random interior spot, biased away from the mouth so the throat stays open. */
  private innerSpot(rand: () => number): { x: number; z: number } {
    const x = INNER.minX + rand() * (INNER.maxX - INNER.minX);
    const z = INNER.minZ + rand() * (INNER.maxZ - INNER.minZ);
    return { x, z };
  }

  // ---- the mouth wall -----------------------------------------------------

  /**
   * The rock curtain the arch is bored through, as REAL geometry.
   *
   * This has to be its own mesh rather than a feature of the roof heightfield,
   * and the reason is worth recording: a heightfield roof is single-valued, so
   * everything above the roof surface is by definition open water. It can
   * express a ceiling that dips to the floor, but it can never express *rock
   * above an opening* — which is precisely what an arch is. The first pass tried
   * to pinch the roof into an arch and the result had no cliff above the mouth
   * at all; you were looking over the top of the whole thing, which is why no
   * amount of relighting made a wall appear.
   *
   * Built with ExtrudeGeometry from a rectangle with an arch-shaped hole, so the
   * front face, back face, and the soffit through the tunnel all come out of one
   * call — and the aperture is exactly the ellipse that CaveTerrain.ceilingAt
   * uses for collision, so what you can swim through is what you can see.
   */
  private buildMouthWall(): void {
    const baseY = this.terrain.heightAt(CAVE.mouthX, 0); // arch springs from the floor
    // The aperture's sides run down to holeBottom; the wall's own boundary has
    // to sit BELOW that. Getting this the wrong way round (hole deeper than the
    // outer contour) makes the shape self-intersecting, and earcut answers with
    // a partial fan that only covers a band around the opening — the wall looked
    // like a free-standing monolith instead of a cliff spanning the whole map.
    const holeBottom = baseY - 70;
    const halfW = CAVE.archHalfWidth;
    const h = CAVE.archHeight;

    // Outer contour, in (z, y): a large many-sided disc rather than a rectangle.
    // Earcut triangulates a wide, 4-vertex rectangle around a small many-vertex
    // hole badly — it filled only a band around the aperture and the rest of the
    // wall silently had no triangles, so the cliff looked like a free-standing
    // monolith. A disc with comparable vertex density to the hole triangulates
    // cleanly. It is far larger than the view frustum at the mouth, and the
    // cavern's side walls seal everything past it, so a disc costs nothing.
    const shape = new Shape();
    const R = 460;
    const cy = baseY + 40;
    const OUTER_STEPS = 56;
    for (let i = 0; i < OUTER_STEPS; i++) {
      const a = (i / OUTER_STEPS) * Math.PI * 2;
      const px = Math.cos(a) * R;
      const py = cy + Math.sin(a) * R;
      if (i === 0) shape.moveTo(px, py);
      else shape.lineTo(px, py);
    }
    shape.closePath();

    // The aperture: a half-ellipse springing from the floor, with a slightly
    // ragged edge so it reads as eroded rock rather than a machined portal.
    const hole = new Path();
    const STEPS = 72;
    const ragged = mulberry32(1234);
    hole.moveTo(halfW, baseY);
    for (let i = 1; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI;
      const jitter = 1 + (ragged() - 0.5) * 0.06;
      hole.lineTo(Math.cos(a) * halfW * jitter, baseY + Math.sin(a) * h * jitter);
    }
    hole.lineTo(-halfW, holeBottom); // sides drop straight down, below the floor
    hole.lineTo(halfW, holeBottom);
    hole.closePath();
    shape.holes.push(hole);

    const geo = new ExtrudeGeometry(shape, {
      depth: CAVE.mouthThickness * 2,
      bevelEnabled: false,
      curveSegments: 8,
    });
    // Shape space is (x=z, y=y, z=depth); rotate so depth runs along world X.
    geo.rotateY(-Math.PI / 2);
    geo.translate(CAVE.mouthX + CAVE.mouthThickness, 0, 0);

    // --- give the cliff an actual SURFACE -----------------------------------
    //
    // ExtrudeGeometry emits the minimum triangles needed to describe the
    // outline: measured, this wall was 524 triangles spanning a 640 m cliff.
    // That is why no amount of relighting made it read as rock — it was a flat
    // plate with three vertices across its whole height, so it had no normals
    // to catch light with and no relief to cast shade into.
    //
    // Subdividing gives it geometry to displace, and the displacement is driven
    // by the same value-noise family the terrain uses, so the cliff belongs to
    // the same rock as the floor and vault. Displacement is skipped near the
    // aperture rim so the arch's silhouette stays crisp and keeps matching the
    // collision profile in ceilingAt.
    const dense = subdivideForRelief(geo, 6);
    const pos = dense.attributes.position as BufferAttribute;
    const halfWm = CAVE.archHalfWidth;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      // Distance out from the aperture edge, normalised — 0 at the rim.
      const radial = Math.hypot(z / halfWm, (y - baseY) / CAVE.archHeight);
      const keepCrisp = 1 - smoothstep(1.0, 1.9, radial);
      const amp = (1 - keepCrisp) * 9;
      if (amp < 0.05) continue;
      const n =
        caveNoise(z * 0.035, y * 0.035) * 0.6 +
        caveNoise(z * 0.11 + 31.7, y * 0.11 + 5.3) * 0.3 +
        caveNoise(z * 0.3 + 12.1, y * 0.3 + 44.9) * 0.1;
      // Push along X only: the wall faces X, so this is relief, not distortion.
      const dir = x < CAVE.mouthX ? -1 : 1;
      pos.setX(i, x + dir * (n - 0.5) * 2 * amp);
    }
    dense.computeVertexNormals();
    this.disposables.push(dense);

    const mat = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.97,
      metalness: 0,
      map: this.rockTexture ?? undefined,
      side: DoubleSide,
    });
    this.disposables.push(mat);
    const mesh = new Mesh(dense, mat);
    mesh.name = 'mouth-wall';
    this.group.add(mesh);
  }

  // ---- the big columns ----------------------------------------------------

  /**
   * Floor-to-ceiling columns: the cavern's structure and the only rock that
   * blocks movement. Each one is fitted to the exact clearance at its spot, so
   * they always land flush on both the floor and the vault.
   */
  private buildColumns(): void {
    const rand = mulberry32(4711);
    const spots: { x: number; z: number; clear: number; r: number }[] = [];
    // The cavern is now roughly twice the area and half again as tall, so this
    // takes far more columns and lets them get genuinely massive — they are the
    // main thing conveying the size of the room from inside it.
    for (let tries = 0; tries < 1400 && spots.length < 64; tries++) {
      const { x, z } = this.innerSpot(rand);
      const clear = this.terrain.clearanceAt(x, z);
      // Only where the vault is a plausible span, and never on a steep slope.
      if (clear < 26 || clear > 150) continue;
      if (this.terrain.slopeAt(x, z) > 1.1) continue;
      // Skewed small so a few giants stand out among many ordinary shafts.
      const r = 5 + rand() * rand() * 20;
      // Keep them apart so the cavern reads as rooms, not a forest.
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < (s.r + r) * 2.2 + 30)) continue;
      spots.push({ x, z, clear, r });
    }

    const geo = this.makeStackGeometry(88, 7);
    this.disposables.push(geo);
    const mesh = new InstancedMesh(geo, this.rockMaterial(), spots.length);
    mesh.name = 'proc-column';
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const p = new Vector3();
    const tint = new Color();

    spots.forEach((s, i) => {
      const floor = this.terrain.heightAt(s.x, s.z);
      // Overlap both ends so no seam shows against the displaced shells.
      scl.set(s.r, s.clear + 6, s.r);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      p.set(s.x, floor - 3, s.z);
      m.compose(p, q, scl);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, this.tintRock(tint, rand));
      // Collider spans the full column: nothing swims through these.
      this.colliders.push({ x: s.x, z: s.z, r: s.r * 0.84, top: floor + s.clear });
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  // ---- hanging stalactites ------------------------------------------------

  /**
   * Curtains of stalactites off the vault. Length is capped against the local
   * clearance so a spike never reaches the floor (that is the columns' job) and
   * never leaves the player nowhere to swim.
   */
  private buildStalactites(): void {
    const rand = mulberry32(1301);
    // Three size classes, each its own instanced draw: a few enormous ones that
    // read as landmarks, then progressively smaller and more numerous.
    const classes = [
      { count: 22, rMin: 3.2, rMax: 7.0, lenFrac: 0.62, seed: 21 },
      { count: 90, rMin: 1.3, rMax: 3.4, lenFrac: 0.44, seed: 22 },
      { count: 180, rMin: 0.45, rMax: 1.4, lenFrac: 0.3, seed: 23 },
    ];

    for (const cls of classes) {
      const geo = this.makeSpikeGeometry(cls.seed);
      this.disposables.push(geo);
      const mesh = new InstancedMesh(geo, this.rockMaterial(), cls.count);
      mesh.name = `proc-stalactite-${cls.seed}`;
      const m = new Matrix4();
      const q = new Quaternion();
      const up = new Vector3(0, 1, 0);
      const scl = new Vector3();
      const p = new Vector3();
      const tint = new Color();
      let idx = 0;

      // Cluster them: pick a few anchor points and hang groups around each, so
      // the vault has dense curtains and open spans rather than an even rash.
      const perCluster = 6;
      while (idx < cls.count) {
        const anchor = this.innerSpot(rand);
        for (let k = 0; k < perCluster && idx < cls.count; k++) {
          const x = anchor.x + (rand() - 0.5) * 46;
          const z = anchor.z + (rand() - 0.5) * 46;
          if (x < INNER.minX || x > INNER.maxX || z < INNER.minZ || z > INNER.maxZ) continue;
          const clear = this.terrain.clearanceAt(x, z);
          if (clear < 14) continue;
          const roof = this.terrain.ceilingAt(x, z);
          const r = cls.rMin + rand() * (cls.rMax - cls.rMin);
          const len = Math.min(clear * cls.lenFrac, r * (7 + rand() * 9));
          scl.set(r, len, r);
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          p.set(x, roof + 2, z); // bite into the vault so the join is hidden
          m.compose(p, q, scl);
          mesh.setMatrixAt(idx, m);
          mesh.setColorAt(idx, this.tintRock(tint, rand));
          idx++;
        }
      }
      mesh.count = idx;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    }

    // A fringe of spikes hanging inside the arch itself — the first thing you
    // swim under, and what sells the scale of the opening.
    this.buildArchFringe();
  }

  /** Teeth hanging from the crown of the mouth arch. */
  private buildArchFringe(): void {
    const rand = mulberry32(9090);
    const geo = this.makeSpikeGeometry(31);
    this.disposables.push(geo);
    const COUNT = 34;
    const mesh = new InstancedMesh(geo, this.rockMaterial(), COUNT);
    mesh.name = 'proc-arch-fringe';
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const p = new Vector3();
    const tint = new Color();
    let idx = 0;

    for (let i = 0; i < COUNT; i++) {
      // Spread across the opening, denser toward the jambs where real arches
      // accrete most heavily.
      const u = (i / (COUNT - 1)) * 2 - 1;
      const z = Math.sign(u) * Math.pow(Math.abs(u), 0.7) * CAVE.archHalfWidth * 0.92;
      const x = CAVE.mouthX + (rand() - 0.5) * CAVE.mouthThickness * 1.2;
      const roof = this.terrain.ceilingAt(x, z);
      const clear = this.terrain.clearanceAt(x, z);
      if (clear < 12) continue;
      const r = 1.4 + rand() * 4.2;
      scl.set(r, Math.min(clear * 0.5, r * (6 + rand() * 8)), r);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      p.set(x, roof + 2, z);
      m.compose(p, q, scl);
      mesh.setMatrixAt(idx, m);
      mesh.setColorAt(idx, this.tintRock(tint, rand));
      idx++;
    }
    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  // ---- rising stalagmites -------------------------------------------------

  /** The same spike form, flipped, growing off the floor to meet the curtains. */
  private buildStalagmites(): void {
    const rand = mulberry32(5150);
    const geo = this.makeSpikeGeometry(41);
    this.disposables.push(geo);
    const COUNT = 130;
    const mesh = new InstancedMesh(geo, this.rockMaterial(), COUNT);
    mesh.name = 'proc-stalagmite';
    const m = new Matrix4();
    const q = new Quaternion();
    const flip = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    const up = new Vector3(0, 1, 0);
    const yaw = new Quaternion();
    const scl = new Vector3();
    const p = new Vector3();
    const tint = new Color();
    let idx = 0;

    for (let tries = 0; tries < COUNT * 6 && idx < COUNT; tries++) {
      const { x, z } = this.innerSpot(rand);
      const clear = this.terrain.clearanceAt(x, z);
      if (clear < 12) continue;
      if (this.terrain.slopeAt(x, z) > 1.4) continue;
      const floor = this.terrain.heightAt(x, z);
      const r = 0.8 + rand() * rand() * 4.4;
      const len = Math.min(clear * 0.42, r * (6 + rand() * 8));
      scl.set(r, len, r);
      // Flip the down-pointing spike so its tip rises, then yaw for variety.
      yaw.setFromAxisAngle(up, rand() * Math.PI * 2);
      q.copy(yaw).multiply(flip);
      p.set(x, floor - 2, z);
      m.compose(p, q, scl);
      mesh.setMatrixAt(idx, m);
      mesh.setColorAt(idx, this.tintRock(tint, rand));
      idx++;
    }
    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  // ---- layered boulder stacks --------------------------------------------

  /** Squat drum-stacked boulders across the floor — the reference's key motif. */
  private buildBoulderStacks(): void {
    const rand = mulberry32(6262);
    const variants = [
      { geo: this.makeStackGeometry(71, 4), count: 70 },
      { geo: this.makeStackGeometry(72, 3), count: 60 },
      { geo: this.makeStackGeometry(73, 5), count: 40 },
    ];
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const p = new Vector3();
    const tint = new Color();

    for (const v of variants) {
      this.disposables.push(v.geo);
      const mesh = new InstancedMesh(v.geo, this.rockMaterial(), v.count);
      mesh.name = 'proc-boulder-stack';
      let idx = 0;
      for (let tries = 0; tries < v.count * 6 && idx < v.count; tries++) {
        const { x, z } = this.innerSpot(rand);
        if (this.terrain.slopeAt(x, z) > 1.6) continue;
        const floor = this.terrain.heightAt(x, z);
        const r = 2 + rand() * rand() * 9;
        scl.set(r, r * (0.7 + rand() * 1.5), r);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        p.set(x, floor - r * 0.18, z); // bed them slightly into the floor
        m.compose(p, q, scl);
        mesh.setMatrixAt(idx, m);
        mesh.setColorAt(idx, this.tintRock(tint, rand));
        idx++;
      }
      mesh.count = idx;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    }
  }

  // ---- the light coming through the mouth ---------------------------------

  // The entrance used to carry a soft additive pane hanging in the throat of the
  // arch. It has been removed: from outside it read as a flat white translucent
  // box floating in the opening, which is exactly the kind of obvious
  // decal-in-3D-space artefact that breaks the illusion of a real cave mouth.
  // The arch now reads on its own geometry and lighting.

  // ---- the whirlpool (the way down) ---------------------------------------

  /**
   * A vortex in the far corner of the cavern: a wide cone of spinning water
   * reaching from the floor toward the vault. It is the zone's exit, so it has
   * to be visible across a very large room — hence an emissive, unlit,
   * fog-exempt shader rather than anything lit.
   *
   * The pull itself lives in `currentAt`, so what you see and what drags you are
   * driven from the same CAVE.whirlpool definition.
   */
  private buildWhirlpool(): void {
    const w = CAVE.whirlpool;
    const floor = this.terrain.heightAt(w.x, w.z);
    // A HOLE IN THE FLOOR, not a tornado. The first pass was a 120 m cone
    // reaching for the vault, which read as a weather event in the middle of a
    // cave. What the exit wants to be is a dark drain in the seabed with a
    // slow swirl on its surface — you find it by looking down, and it says
    // "down" rather than "up".
    const height = 34;
    const geo = new CylinderGeometry(w.radius, w.radius * 0.28, height, 44, 4, true);
    this.disposables.push(geo);

    this.whirlMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vY;
        void main() {
          vUv = uv;
          vY = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vY;
        void main() {
          // A slow swirl on the wall of the shaft. Gentle — this is water
          // turning over a drain, not a vortex.
          float spin = vUv.x * 8.0 - vY * 3.0 + uTime * 0.5;
          float bands = pow(0.5 + 0.5 * sin(spin * 3.14159), 2.0);
          // The throat stays black, but the rim has to CATCH — this is the way
          // out of the zone and the player has to be able to find it across a
          // dark cavern. Brightness climbs sharply toward the mouth of the shaft.
          // Strongly lit at the mouth, falling to pure black down the throat.
          // The gradient IS the depth cue — a uniformly dark shaft is
          // indistinguishable from the cave floor around it.
          float rim = pow(vY, 1.2);
          vec3 murk = vec3(0.005, 0.015, 0.03);
          vec3 glint = vec3(0.50, 0.95, 1.0);
          vec3 col = mix(murk, glint, bands * rim * 1.2);
          col += glint * rim * rim * 1.1;
          float a = 0.7 + bands * 0.3 * rim;
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    this.disposables.push(this.whirlMat);

    // The shaft, sunk so only its mouth shows. It runs deep and its walls are
    // solid, so looking in you see a hole going somewhere rather than a decal
    // painted on the seabed.
    const mesh = new Mesh(geo, this.whirlMat);
    mesh.position.set(w.x, floor - height * 0.42, w.z);
    mesh.renderOrder = 3;
    mesh.name = 'whirlpool';
    this.group.add(mesh);

    // A hard black void filling the shaft. Unlit, unfogged, drawn behind the
    // swirl: this is what actually makes it read as an opening to somewhere
    // else rather than a lit basin — you cannot see a bottom.
    // Its top MUST stay below the shaft's mouth. Sized generously it rose above
    // the seabed and, being opaque black, covered the hole, the swirl, and the
    // rim halo completely — the exit rendered as a patch of nothing.
    const voidH = height * 1.2;
    const voidGeo = new CylinderGeometry(w.radius * 0.9, w.radius * 0.28, voidH, 32, 1, true);
    const voidMat = new MeshBasicMaterial({ color: 0x000000, fog: false, side: DoubleSide });
    const voidMesh = new Mesh(voidGeo, voidMat);
    // Top of the cylinder sits 8 m under the seabed, so it only ever lines the
    // inside of the shaft and never breaches the floor.
    voidMesh.position.set(w.x, floor - 8 - voidH * 0.5, w.z);
    voidMesh.name = 'whirlpool-void';
    voidMesh.renderOrder = 2;
    this.group.add(voidMesh);
    this.disposables.push(voidGeo, voidMat);

    // A wide, faint ring lying on the basin lip. Unlit and fog-exempt, so the
    // exit is findable from across the cavern the way the Carrier's beacon is.
    // A RING, not a disc. As a filled circle it covered the shaft's mouth
    // completely and the exit read as a flat teal puddle painted on the floor —
    // the hole has to stay visibly open in the middle.
    const haloGeo = new RingGeometry(w.radius * 0.92, w.radius * 1.55, 48);
    haloGeo.rotateX(-Math.PI / 2);
    const haloMat = new MeshBasicMaterial({
      color: 0x4fd6ee,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      side: DoubleSide,
    });
    const halo = new Mesh(haloGeo, haloMat);
    halo.position.set(w.x, floor + 1.5, w.z);
    halo.name = 'whirlpool-halo';
    halo.renderOrder = 3;
    this.group.add(halo);
    this.disposables.push(haloGeo, haloMat);

    // Cap the very bottom so nothing shows through from outside the map. Set
    // deep enough that the player never sees it as a floor.
    const capGeo = new CircleGeometry(w.radius * 0.3, 24);
    capGeo.rotateX(-Math.PI / 2);
    const capMat = new MeshBasicMaterial({ color: 0x000000, fog: false });
    const cap = new Mesh(capGeo, capMat);
    cap.position.set(w.x, floor - height * 1.15, w.z);
    cap.name = 'whirlpool-floor';
    this.group.add(cap);
    this.disposables.push(capGeo, capMat);
  }

  // ---- suspended silt -----------------------------------------------------

  private buildParticles(scale: number): void {
    // Dense, close-in silt. This is the cheapest atmosphere in the game — a
    // single Points draw — and it does most of the work of making the cavern
    // feel like heavy, dead water rather than empty space.
    const count = Math.floor(4200 * scale);
    this.particleCount = count;
    const box = 38;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const rand = mulberry32(2024);
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
          p.x += sin(uTime * 0.16 + aSeed * 1.7) * 1.2;
          p.y += sin(uTime * 0.12 + aSeed * 2.3) * 0.9 - uTime * 0.16;
          p.z += cos(uTime * 0.14 + aSeed * 1.1) * 1.2;
          vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCamPos + rel;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = -mv.z;
          vAlpha = (1.0 - smoothstep(uBox * 0.28, uBox * 0.5, dist)) * 0.72;
          gl_PointSize = (16.0 / dist) * (0.5 + fract(aSeed) * 1.1) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vAlpha;
          gl_FragColor = vec4(0.66, 0.78, 0.82, a * 0.55);
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

  /**
   * A single inward shove on arrival, instead of a permanent current. One
   * impulse cannot fight your input frame after frame, so it reads as being
   * carried in by the sea rather than as the controls sticking.
   */
  getSpawnImpulse(out: Vector3): Vector3 {
    return out.set(26, 0, 0);
  }

  getSpawn(out: Vector3): Vector3 {
    // Out in the black water in front of the arch, high enough that the whole
    // opening is in frame the moment control is handed over.
    const x = CAVE.spawn.x;
    const z = CAVE.spawn.z;
    return out.set(x, this.terrain.heightAt(x, z) + 46, z);
  }

  getBounds(): ZoneBounds {
    return {
      // A hard cap well above the vault; the real roof is CaveTerrain.ceilingAt,
      // which the controller and camera clamp against per-position.
      ceilingY: 260,
      minX: CAVE.minX,
      maxX: CAVE.maxX,
      minZ: CAVE.minZ,
      maxZ: CAVE.maxZ,
      softMargin: CAVE.softMargin,
    };
  }

  getPopulationArea(): PopulationArea {
    // Creatures live inside the cavern, clear of the walls and the curtain.
    return {
      minX: CAVE.mouthX + CAVE.mouthThickness + 20,
      maxX: CAVE.maxX - 80,
      minZ: CAVE.minZ + 90,
      maxZ: CAVE.maxZ - 90,
    };
  }

  /** This zone's creature mix. */
  getPopulation(): PopEntry[] {
    return DROWNED_GARDEN_POP;
  }

  /**
   * The cave grows its own vegetation (see GardenDressing), so the shared reef
   * flora must not plant here. Returning its area anyway scattered the Shallow
   * Veil's tropical coral through a lightless cavern at a cost of 2.96M
   * triangles — the single largest item in the frame.
   */
  getFloraArea(): PopulationArea | null {
    return null;
  }

  /**
   * The Signal Carrier stands at the centre of the stone circle. The henge was
   * already the cavern's most deliberate-looking place; putting the relay in the
   * middle of it makes the whole site read as built AROUND the thing, and gives
   * the fight a natural arena with the standing stones as cover.
   */
  getCarrierAnchor(out: Vector3): Vector3 {
    const x = HENGE_CENTRE.x;
    const z = HENGE_CENTRE.z;
    return out.set(x, this.terrain.heightAt(x, z), z);
  }

  getDescentInfo(): DescentInfo {
    return { targetName: 'The Fallen Kingdom', recommendedDominance: 'Predator' };
  }

  /** Inside the whirlpool's throat is the way down to the next zone. */
  isInDescentZone(pos: Vector3): boolean {
    const w = CAVE.whirlpool;
    return Math.hypot(pos.x - w.x, pos.z - w.z) < w.radius * 0.45;
  }

  /**
   * Declining the descent lifts you clear of the hole and pushes you off its
   * lip. Nothing pulls back any more, so this actually succeeds — previously the
   * whirlpool's suction cancelled it and left the player wedged in the basin.
   */
  repelFromDescent(pos: Vector3, vel: Vector3, dt: number): boolean {
    const w = CAVE.whirlpool;
    const dx = pos.x - w.x;
    const dz = pos.z - w.z;
    const d = Math.hypot(dx, dz);
    const lipY = this.terrain.heightAt(w.x + w.radius * 2.6, w.z) + 12;
    // Done once clear of the mouth horizontally AND back up above the basin rim.
    if (d > w.radius * 1.5 && pos.y > lipY - 6) return true;
    // Rise first: being under the lip is what traps you.
    vel.y += 46 * dt;
    if (d < 1e-3) {
      vel.x += 40 * dt;
      return false;
    }
    vel.x += (dx / d) * 70 * dt;
    vel.z += (dz / d) * 70 * dt;
    return false;
  }

  // There is deliberately NO currentAt() in this zone any more.
  //
  // The whirlpool used to suck the player in every frame. That fought
  // repelFromDescent directly — decline the descent and the suction immediately
  // dragged you back down, so you were pinned in the basin unable to leave — and
  // a standing force against player input reads as lag regardless. The hole is
  // now simply a place you swim into, and swim out of.

  // ---- frame update -------------------------------------------------------

  update(dt: number, camera: PerspectiveCamera, renderer: WebGLRenderer): void {
    this.time += dt;
    this.particleMat.uniforms.uTime.value = this.time;
    this.whirlMat.uniforms.uTime.value = this.time;
    this.particleMat.uniforms.uCamPos.value.copy(camera.position);
    this.particleMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();

    // Depth cue: the further in you swim, the blacker and thicker the water and
    // the less the mouth light reaches you.
    const inward = smoothstep(CAVE.mouthX, CAVE.maxX - 60, camera.position.x);

    // Drop the entrance once you are properly inside. From the back of the
    // cavern the mouth is hundreds of metres away through heavy fog and
    // contributes nothing but cost — and the fog means you never see it vanish.
    if (this.garden) {
      this.garden.entranceGroup.visible = camera.position.x < CAVE.mouthX + 260;
    }
    this.fog.density = 0.0062 + inward * 0.010;
    this.hemi.intensity = 2.5 - inward * 0.9;
    this.mouthLight.intensity = 6.5 * (1 - inward * 0.78);
    // The outside cliff is only ever seen from outside; kill it once you are in
    // so it cannot leak light onto the vault.
    this.cliffLight.intensity = 4.2 * (1 - inward);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh || (obj as Points).type === 'Points') mesh.geometry?.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.garden?.dispose();
    this.garden = null;
    this.terrain.dispose();
  }
}

/** Iron-staining tint, hoisted so the per-instance tint loop allocates nothing. */
const TMP_RUST = new Color(0.55, 0.34, 0.18);

// ---- mouth-wall relief helpers ---------------------------------------------

/**
 * Midpoint-subdivide every triangle `levels` times, so a coarse extruded outline
 * has enough vertices to displace into a rock face. Non-indexed output: the
 * wall is displaced per-vertex and then re-normalled, and shared vertices would
 * average the relief away into mush.
 */
function subdivideForRelief(src: BufferGeometry, levels: number): BufferGeometry {
  let positions: number[] = [];
  const srcPos = src.attributes.position as BufferAttribute;
  const index = src.index;
  const tri = (i: number, out: number[]): void => {
    const j = index ? index.getX(i) : i;
    out.push(srcPos.getX(j), srcPos.getY(j), srcPos.getZ(j));
  };
  const triCount = (index ? index.count : srcPos.count) / 3;
  for (let t = 0; t < triCount; t++) {
    tri(t * 3, positions);
    tri(t * 3 + 1, positions);
    tri(t * 3 + 2, positions);
  }

  for (let lvl = 0; lvl < levels; lvl++) {
    const next: number[] = [];
    for (let i = 0; i < positions.length; i += 9) {
      const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
      // Split the LONGEST edge only. Uniform 4-way subdivision would explode a
      // 640 m wall into millions of triangles; longest-edge bisection converges
      // on evenly-sized triangles for a fraction of the count.
      const ab = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
      const bc = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2;
      const ca = (cx - ax) ** 2 + (cy - ay) ** 2 + (cz - az) ** 2;
      if (ab >= bc && ab >= ca) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
        next.push(ax, ay, az, mx, my, mz, cx, cy, cz);
        next.push(mx, my, mz, bx, by, bz, cx, cy, cz);
      } else if (bc >= ca) {
        const mx = (bx + cx) / 2, my = (by + cy) / 2, mz = (bz + cz) / 2;
        next.push(ax, ay, az, bx, by, bz, mx, my, mz);
        next.push(ax, ay, az, mx, my, mz, cx, cy, cz);
      } else {
        const mx = (cx + ax) / 2, my = (cy + ay) / 2, mz = (cz + az) / 2;
        next.push(ax, ay, az, bx, by, bz, mx, my, mz);
        next.push(mx, my, mz, bx, by, bz, cx, cy, cz);
      }
    }
    positions = next;
  }

  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return out;
}

/** Value noise matching the terrain's, so the cliff is the same stone. */
function caveNoise(x: number, y: number): number {
  const h = (ix: number, iy: number): number => {
    let n = (ix * 374761393 + iy * 668265263) | 0;
    n = (n ^ (n >> 13)) | 0;
    n = Math.imul(n, 1274126177);
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
