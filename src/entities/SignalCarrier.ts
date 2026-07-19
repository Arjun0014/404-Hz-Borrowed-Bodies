import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  type Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { AssetLoader } from '../core/AssetLoader';
import carrierUrl from '../../assets/eye_signal_carrier.glb?url';

/**
 * The Signal Carrier — the Shallow Veil's major objective (Phase 12).
 *
 * A high-health biological relay the ancient entity broadcasts through: large,
 * semi-stationary, and impossible to miss (a pulsing beacon that reads through
 * fog from most of the shelf away). It is NOT a Creature — it never roams, never
 * flees, and can never be possessed — so it lives outside the ecosystem AI and
 * owns its own tiny update.
 *
 * Killing it is deliberately not a damage-sponge grind. Three **signal nodes**
 * orbit it on tethers and SHIELD the body: while any node lives, direct hits on
 * the carrier are cut to a quarter. Popping a node is worth a fifth of the
 * carrier's whole health bar and staggers it. So the skilful kill is "break the
 * nodes, then burn the body", and the fight rewards a host that can actually
 * deliver damage (a shark ends it in seconds; a starter clownfish should not
 * be here at all).
 *
 * Its aura is the other half of the encounter: standing near it accelerates the
 * player's Connection and enrages the wild predators around it into a garrison
 * (see EcoContext.carrierPos / Creature.fishThink). Approaching is a decision,
 * not a formality.
 */

/** Longest-axis size of the carrier body, in meters. A genuine landmark. */
const CARRIER_SIZE = 16;
/** Hover height above the seabed at its anchor. */
const HOVER = 11;
/** Bite/hit radius of the body. */
const BODY_RADIUS = 6.5;

const MAX_HEALTH = 12000;
/** Fraction of max health removed instantly when a node is destroyed. */
const NODE_CHUNK = 0.2;
const NODE_HEALTH = 750;
const NODE_COUNT = 3;
const NODE_ORBIT_R = 10.5;
const NODE_RADIUS = 1.5;
/** Body damage multiplier while any node still shields the carrier. */
const SHIELDED_MULT = 0.25;

/** Radius of the Carrier's influence: faster Connection + an enraged garrison. */
const AURA_RADIUS = 78;
/** Multiplier applied to the player's Connection rise at the aura's center. */
const AURA_CONNECTION_MULT = 2.4;

/** Seconds between beacon pulses (ring + audio ping). */
const PULSE_INTERVAL = 2.6;
/** Seconds the carrier is staggered (shield down, beacon stutters) after a node pops. */
const STAGGER_TIME = 2.5;

const _v = new Vector3();
const WHITE = new Color(0xffffff);

/** Per-damage-stage look: emissive colour + how hard the beacon throbs. */
const STAGE_COLOR = [0x8fe6ff, 0xffd479, 0xff8a4a, 0xff3b5c];
const STAGE_NAME = ['INTACT', 'STRAINED', 'FAILING', 'COLLAPSING'];

interface CarrierNode {
  mesh: Mesh;
  health: number;
  alive: boolean;
  /** Orbit phase (radians) around the carrier. */
  phase: number;
  /** Vertical offset of this node's orbit ring. */
  yOff: number;
  readonly pos: Vector3;
}

export interface CarrierHitResult {
  /** Damage actually applied (after shielding). */
  damage: number;
  /** A node was destroyed by this hit. */
  nodeKilled: boolean;
  /** The carrier died from this hit. */
  died: boolean;
  /** Anything at all was struck (drives bite SFX/camera punch). */
  hit: boolean;
}

export class SignalCarrier {
  readonly pos = new Vector3();
  readonly radius = BODY_RADIUS;
  readonly auraRadius = AURA_RADIUS;
  readonly maxHealth = MAX_HEALTH;
  health = MAX_HEALTH;
  alive = true;

  /** Fired once when the carrier dies, at its position — hands off to the field. */
  onDeath: (pos: Vector3) => void = () => {};
  /** Fired when a signal node pops (remaining node count). */
  onNodeDestroyed: (remaining: number) => void = () => {};
  /** Fired on each beacon pulse, with 0..1 proximity — drives the beacon audio. */
  onPulse: (proximity01: number) => void = () => {};

  private readonly group = new Group();
  private readonly bodyRoot = new Group();
  private readonly nodes: CarrierNode[] = [];
  private readonly nodeMats: MeshBasicMaterial[] = [];
  private readonly bodyMats: MeshStandardMaterial[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  private glowSprite!: Sprite;
  private glowMat!: SpriteMaterial;
  private rings: { mesh: Mesh; mat: MeshBasicMaterial; t: number }[] = [];
  private tethers!: LineSegments;
  private tetherPos!: Float32BufferAttribute;
  private tetherMat!: LineBasicMaterial;

  private time = 0;
  private pulseT = 0;
  private staggerT = 0;
  private hurtFlash = 0;
  private baseY = 0;
  private readonly stageColor = new Color(STAGE_COLOR[0]);
  private lastStage = -1;
  private dyingT = 0;

  private constructor(
    private readonly scene: Scene,
    model: Object3D,
  ) {
    this.group.name = 'signal-carrier';
    this.bodyRoot.add(model);
    this.group.add(this.bodyRoot);
    scene.add(this.group);
  }

  /**
   * Load the carrier model, normalize it to CARRIER_SIZE, and anchor it hovering
   * above `anchor` (which should already carry the seabed height at that spot).
   * `ceilingY` is the zone's surface: the hover is clamped beneath it so the
   * relay can never breach the water, whatever terrain a zone anchors it over.
   */
  static async create(
    loader: AssetLoader,
    scene: Scene,
    anchor: Vector3,
    ceilingY: number,
  ): Promise<SignalCarrier> {
    const gltf = await loader.loadGLB(carrierUrl);
    const model = gltf.scene;

    // Normalize: the source is authored at an arbitrary scale far from the
    // origin, so scale its longest axis to CARRIER_SIZE and recenter the pivot.
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const scale = CARRIER_SIZE / Math.max(size.x, size.y, size.z, 1e-4);
    const wrap = new Group();
    wrap.add(model);
    wrap.scale.setScalar(scale);
    wrap.position.copy(box.getCenter(new Vector3()).multiplyScalar(-scale));

    const carrier = new SignalCarrier(scene, wrap);
    carrier.captureBodyMaterials(model);
    // Hover clear of the seabed, but never so high that the body breaches.
    const topRoom = ceilingY - CARRIER_SIZE * 0.55;
    carrier.pos.copy(anchor).setY(Math.min(anchor.y + HOVER, topRoom));
    carrier.baseY = carrier.pos.y;
    carrier.group.position.copy(carrier.pos);
    carrier.buildBeacon();
    carrier.buildNodes();
    carrier.applyStage(0, true);
    return carrier;
  }

  // ---- construction --------------------------------------------------------

  /** Grab the body's materials so damage stages can drive their emissive glow. */
  private captureBodyMaterials(model: Object3D): void {
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // one landmark object; culling it costs more than it saves
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats as Material[]) {
        const sm = m as MeshStandardMaterial;
        if (sm?.isMeshStandardMaterial) this.bodyMats.push(sm);
      }
    });
  }

  /**
   * The beacon: a soft additive core glow plus expanding sonar rings. Both are
   * drawn with `fog: false` so the carrier stays findable through the Shallow
   * Veil's thick fog — that "visible from half the zone away" read is the whole
   * point of the encounter's discovery step.
   */
  private buildBeacon(): void {
    const size = 256;
    const c = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(c, c, 1, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.22, 'rgba(190,230,255,0.42)');
    g.addColorStop(0.6, 'rgba(140,190,255,0.12)');
    g.addColorStop(1, 'rgba(120,170,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new CanvasTexture(canvas);

    this.glowMat = new SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      // Depth-TESTED on purpose. `fog: false` is what carries the beacon through
      // the Shallow Veil's haze at range; leaving depth off as well drew the
      // halo straight over the body and blew the model out to a white ball. With
      // depth on, the carrier occludes its own core and you get a rim halo — the
      // silhouette stays readable up close and still glows from far away.
      depthTest: true,
      blending: AdditiveBlending,
      fog: false,
      opacity: 0.85,
    });
    this.glowSprite = new Sprite(this.glowMat);
    this.glowSprite.scale.setScalar(22);
    this.glowSprite.renderOrder = 3;
    this.group.add(this.glowSprite);
    this.disposables.push(tex, this.glowMat);

    // Two pooled sonar rings, recycled on each pulse (no per-pulse allocation).
    // Thin: the ring is scaled up to ~35 m across, so a 0.12 band width became a
    // 4 m solid hoop. 0.028 keeps it a sweep line at every size.
    const ringGeo = new RingGeometry(1, 1.028, 48);
    ringGeo.rotateX(Math.PI / 2); // lie flat, so it reads as a sonar sweep
    this.disposables.push(ringGeo);
    for (let i = 0; i < 2; i++) {
      const mat = new MeshBasicMaterial({
        color: STAGE_COLOR[0],
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
        fog: false,
        side: DoubleSide, // visible from above and below
      });
      const mesh = new Mesh(ringGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.disposables.push(mat);
      this.rings.push({ mesh, mat, t: 1 + i * 0.5 });
    }
  }

  /**
   * Three signal nodes on slow orbits, joined to the body by glowing tethers.
   * They are the encounter's skill expression: each is a weak point worth a
   * fifth of the carrier's health, and together they shield the body.
   */
  private buildNodes(): void {
    // Detail 0 — a hard-faceted crystal. Subdivided, it read as a plain white
    // ball and vanished into the beacon glow.
    const geo = new IcosahedronGeometry(NODE_RADIUS, 0);
    this.disposables.push(geo);
    for (let i = 0; i < NODE_COUNT; i++) {
      const mat = new MeshBasicMaterial({ color: 0xbdf0ff, fog: false, toneMapped: false });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.nodeMats.push(mat);
      this.disposables.push(mat);
      this.nodes.push({
        mesh,
        health: NODE_HEALTH,
        alive: true,
        phase: (i / NODE_COUNT) * Math.PI * 2,
        yOff: -2 + i * 2.4,
        pos: new Vector3(),
      });
    }

    // Tethers: one line segment per node (body center → node), positions
    // rewritten in place each frame. One draw call for all three.
    const geoT = new BufferGeometry();
    this.tetherPos = new Float32BufferAttribute(new Float32Array(NODE_COUNT * 6), 3);
    this.tetherPos.setUsage(DynamicDrawUsage); // rewritten in place every frame
    geoT.setAttribute('position', this.tetherPos);
    this.tetherMat = new LineBasicMaterial({
      color: 0x8fe6ff,
      transparent: true,
      opacity: 0.5,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.tethers = new LineSegments(geoT, this.tetherMat);
    this.tethers.frustumCulled = false;
    this.group.add(this.tethers);
    this.disposables.push(geoT, this.tetherMat);
  }

  // ---- state ---------------------------------------------------------------

  get health01(): number {
    return Math.max(0, this.health / this.maxHealth);
  }

  /** Damage stage 0..3 — drives the emissive colour, pulse rate, and HUD label. */
  get stage(): number {
    const h = this.health01;
    if (h > 0.75) return 0;
    if (h > 0.5) return 1;
    if (h > 0.25) return 2;
    return 3;
  }

  get stageName(): string {
    return STAGE_NAME[this.stage];
  }

  get nodesAlive(): number {
    let n = 0;
    for (const nd of this.nodes) if (nd.alive) n++;
    return n;
  }

  /** True while nodes still cut incoming body damage. */
  get shielded(): boolean {
    return this.nodesAlive > 0 && this.staggerT <= 0;
  }

  /** 0..1 how deep inside the aura a point is (0 = outside). */
  auraStrength(at: Vector3): number {
    if (!this.alive) return 0;
    const d = at.distanceTo(this.pos);
    if (d >= AURA_RADIUS) return 0;
    return 1 - d / AURA_RADIUS;
  }

  /** Connection-rise multiplier for a player at this position (1 = unaffected). */
  connectionMultAt(at: Vector3): number {
    return 1 + this.auraStrength(at) * (AURA_CONNECTION_MULT - 1);
  }

  // ---- damage --------------------------------------------------------------

  /**
   * Resolve a player bite against the carrier: nodes first (they are the small,
   * precise targets and should always win a contested hit), then the body.
   * Mirrors Ecosystem.playerBiteCone's geometry — a reach sphere clipped by the
   * attack's front cone — so every attack path (bite, sweep, inhale) works here.
   */
  tryHit(origin: Vector3, forward: Vector3, reach: number, minDot: number, damage: number): CarrierHitResult {
    const res: CarrierHitResult = { damage: 0, nodeKilled: false, died: false, hit: false };
    if (!this.alive) return res;

    for (const nd of this.nodes) {
      if (!nd.alive) continue;
      if (!this.inStrike(nd.pos, NODE_RADIUS, origin, forward, reach, minDot)) continue;
      res.hit = true;
      nd.health -= damage;
      res.damage += damage;
      if (nd.health <= 0) {
        nd.alive = false;
        nd.mesh.visible = false;
        res.nodeKilled = true;
        this.staggerT = STAGGER_TIME;
        this.hurtFlash = 1;
        // A node is worth a fifth of the whole bar — the reward for precision.
        this.health -= this.maxHealth * NODE_CHUNK;
        this.onNodeDestroyed(this.nodesAlive);
      }
      // One node per strike: a wide sweep should not vaporise the whole shield.
      break;
    }

    if (!res.nodeKilled && this.inStrike(this.pos, BODY_RADIUS, origin, forward, reach, minDot)) {
      res.hit = true;
      const applied = damage * (this.shielded ? SHIELDED_MULT : 1);
      this.health -= applied;
      res.damage += applied;
      this.hurtFlash = Math.max(this.hurtFlash, 0.7);
    }

    if (this.health <= 0 && this.alive) {
      this.health = 0;
      this.alive = false;
      this.dyingT = 1.6;
      res.died = true;
      this.onDeath(this.pos);
    }
    return res;
  }

  /** Sphere-at-`target` vs. the attack's reach + front cone. */
  private inStrike(
    target: Vector3,
    targetRadius: number,
    origin: Vector3,
    forward: Vector3,
    reach: number,
    minDot: number,
  ): boolean {
    _v.subVectors(target, origin);
    const d = _v.length();
    if (d > reach + targetRadius) return false;
    if (d < 1e-3) return true;
    return _v.dot(forward) / d >= minDot;
  }

  // ---- per-frame -----------------------------------------------------------

  update(dt: number, playerPos: Vector3): void {
    this.time += dt;
    if (this.staggerT > 0) this.staggerT -= dt;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.2);

    if (!this.alive) {
      // Death throes: the beacon collapses inward and the whole rig fades out.
      this.dyingT = Math.max(0, this.dyingT - dt);
      const k = this.dyingT / 1.6;
      this.group.scale.setScalar(0.4 + k * 0.6);
      this.glowMat.opacity = k * 2.2; // a final blinding flare, then nothing
      this.tetherMat.opacity = 0;
      for (const r of this.rings) r.mesh.visible = false;
      this.group.visible = this.dyingT > 0;
      return;
    }

    const stage = this.stage;
    if (stage !== this.lastStage) this.applyStage(stage, false);

    // Semi-stationary: a slow hover bob and a lazy turn, so it reads as alive
    // without ever leaving its anchor. Staggering makes it lurch.
    const stagger = this.staggerT > 0 ? 1 : 0;
    this.pos.y = this.baseY + Math.sin(this.time * 0.5) * 1.1 + stagger * Math.sin(this.time * 26) * 0.5;
    this.group.position.copy(this.pos);
    // Face the player slowly — an eye that tracks you is worth the two lines.
    _v.subVectors(playerPos, this.pos);
    const wantYaw = Math.atan2(_v.x, _v.z);
    let dY = wantYaw - this.bodyRoot.rotation.y;
    while (dY > Math.PI) dY -= Math.PI * 2;
    while (dY < -Math.PI) dY += Math.PI * 2;
    this.bodyRoot.rotation.y += Math.max(-0.45 * dt, Math.min(0.45 * dt, dY));
    this.bodyRoot.rotation.z = Math.sin(this.time * 0.37) * 0.05;

    this.updateNodes(dt);
    this.updateBeacon(dt, playerPos, stage);
  }

  private updateNodes(dt: number): void {
    const spin = 0.34 + this.stage * 0.12; // agitation rises as it fails
    let seg = 0;
    const arr = this.tetherPos.array as Float32Array;
    for (const nd of this.nodes) {
      nd.phase += spin * dt;
      const r = NODE_ORBIT_R + Math.sin(this.time * 0.8 + nd.phase) * 0.8;
      nd.pos.set(
        this.pos.x + Math.cos(nd.phase) * r,
        this.pos.y + nd.yOff + Math.sin(this.time * 0.9 + nd.phase) * 0.7,
        this.pos.z + Math.sin(nd.phase) * r,
      );
      if (nd.alive) {
        // Local space (the group is already at this.pos).
        nd.mesh.position.subVectors(nd.pos, this.pos);
        const hurt = 1 - nd.health / NODE_HEALTH;
        const throb = 1 + Math.sin(this.time * (3 + hurt * 7) + nd.phase) * 0.12;
        nd.mesh.scale.setScalar(throb);
      }
      const i = seg * 6;
      arr[i] = 0;
      arr[i + 1] = 0;
      arr[i + 2] = 0;
      arr[i + 3] = nd.alive ? nd.mesh.position.x : 0;
      arr[i + 4] = nd.alive ? nd.mesh.position.y : 0;
      arr[i + 5] = nd.alive ? nd.mesh.position.z : 0;
      seg++;
    }
    this.tetherPos.needsUpdate = true;
    this.tetherMat.opacity = this.nodesAlive > 0 ? 0.32 + Math.sin(this.time * 2.2) * 0.12 : 0;
  }

  private updateBeacon(dt: number, playerPos: Vector3, stage: number): void {
    // Pulse faster as it fails; stutter while staggered.
    const interval = PULSE_INTERVAL * (1 - stage * 0.16) * (this.staggerT > 0 ? 0.45 : 1);
    this.pulseT -= dt;
    if (this.pulseT <= 0) {
      this.pulseT = interval;
      this.emitRing();
      const d = playerPos.distanceTo(this.pos);
      this.onPulse(Math.max(0, 1 - d / 260)); // audible from well outside the aura
    }

    // Core glow: throbs with the pulse cycle, flares when hurt.
    const cyc = 1 - Math.max(0, this.pulseT / interval);
    const flare = Math.pow(Math.sin(cyc * Math.PI), 3);
    this.glowSprite.scale.setScalar(21 + flare * 8 + this.hurtFlash * 10);
    this.glowMat.opacity = 0.4 + flare * 0.3 + this.hurtFlash * 0.35;

    for (const r of this.rings) {
      if (r.t >= 1) {
        r.mesh.visible = false;
        continue;
      }
      r.t = Math.min(1, r.t + dt / 2.2);
      const s = 8 + r.t * 46;
      r.mesh.scale.set(s, s, s);
      // Fade in fast, then out — a sweep passing you, not a ring sitting there.
      r.mat.opacity = Math.min(1, r.t * 8) * (1 - r.t) * 0.38;
    }
  }

  private emitRing(): void {
    // Recycle whichever ring is furthest through its life.
    let best = this.rings[0];
    for (const r of this.rings) if (r.t > best.t) best = r;
    best.t = 0;
    best.mesh.visible = true;
    best.mat.color.copy(this.stageColor);
  }

  /** Repaint everything that expresses the current damage stage. */
  private applyStage(stage: number, initial: boolean): void {
    this.lastStage = stage;
    this.stageColor.setHex(STAGE_COLOR[stage]);
    // Keep the nodes saturated — washing them toward white made them read as
    // part of the core glow instead of as three distinct targets.
    for (const m of this.nodeMats) m.color.copy(this.stageColor).lerp(WHITE, 0.08);
    this.tetherMat.color.copy(this.stageColor);
    this.glowMat.color.copy(this.stageColor);
    // Body emissive: a cool relay glow that turns angry as the carrier fails.
    // Kept low while intact — at 0.35 the emissive washed the albedo out and the
    // eye read as a featureless pale ball; it should look like flesh that starts
    // burning from the inside only once you are actually hurting it.
    for (const m of this.bodyMats) {
      m.emissive.copy(this.stageColor);
      m.emissiveIntensity = 0.1 + stage * 0.42;
      m.needsUpdate = initial;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats as Material[]) {
          const sm = m as MeshStandardMaterial;
          sm?.map?.dispose();
          sm?.normalMap?.dispose();
          m?.dispose();
        }
      }
    });
    for (const d of this.disposables) d.dispose();
    this.nodes.length = 0;
  }
}
