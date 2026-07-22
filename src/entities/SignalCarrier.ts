import {
  AdditiveBlending,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
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
  LoopOnce,
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

// These are the REFERENCE proportions for a full-size carrier; a per-zone `size`
// and `maxHealth` (see create()) scale everything off them, so a smaller, killable
// relay in the starting sea and a larger one in the deep share one rig.
/** Reference longest-axis size of the carrier body, in meters. A genuine landmark. */
const CARRIER_SIZE = 16;
/** Reference hover height above the seabed at its anchor. */
const HOVER = 11;
/** Reference bite/hit radius of the body. */
const BODY_RADIUS = 6.5;

/** Default health if a zone doesn't specify one (zones pass their own). */
const MAX_HEALTH = 4000;
/** Fraction of max health removed instantly when a node is destroyed. */
const NODE_CHUNK = 0.2;
/** Each node's own HP, as a fraction of the carrier's max health. */
const NODE_HEALTH_FRAC = 0.06;
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

/**
 * An alternate body for a Signal Carrier.
 *
 * The relay in the first two zones is a static eye that hovers over its anchor
 * and does nothing but broadcast. That is the right shape for a thing you find
 * and dismantle, but the Fallen Kingdom's second carrier is a colossal squid
 * coiled over the way out, and it has to read as an ANIMAL: it patrols, it has
 * sixteen animation clips, and it lashes anything that swims into reach.
 *
 * Rather than fork the class, a variant swaps the model and switches on the
 * behaviours the standard relay simply omits. Everything that makes a carrier a
 * carrier — the shielding nodes, the aura, the beacon, the damage stages, the
 * Dead Signal Field on death — is shared, so the squid IS a Signal Carrier and
 * every system that already understands one needs no changes.
 */
export interface CarrierVariant {
  /** Model to load instead of the standard eye relay. */
  modelUrl: string;
  /** Name shown on the boss bar, and in the seal prompt at the descent. */
  title: string;
  /**
   * Patrol a ring around the anchor instead of hovering over it. It never
   * leaves this ring — a carrier that chased would stop being a landmark.
   */
  roam?: { radius: number; speed: number; rise: number };
  /** Lash out at a player who comes inside `range`. */
  melee?: { range: number; damage: number; cooldown: number; windup: number };
  /** Clip name patterns, matched against the model's own animation names. */
  clips?: { idle?: RegExp; swim?: RegExp; fast?: RegExp; attack?: RegExp; death?: RegExp };
  /** Orbiting shield nodes (defaults to the standard three). */
  nodeCount?: number;
  /** While this carrier lives, the zone's way down is sealed shut. */
  sealsDescent?: boolean;
  /** Body radius as a fraction of `size` (a squid is longer than it is wide). */
  radiusFactor?: number;
  /**
   * Meshes to drop from the loaded model, by name or material name.
   *
   * Needed because asset packs ship cosmetics: the colossal squid arrives
   * wearing a Christmas hat (`XmasHat_LowRes`), which is very funny exactly once
   * and then is a Christmas hat on your boss for ever.
   */
  hideMeshes?: RegExp;
}

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
  readonly radius: number;
  readonly auraRadius = AURA_RADIUS;
  readonly maxHealth: number;
  health: number;
  alive = true;

  /** Longest-axis size in metres (per-zone; smaller in the starting sea). */
  readonly size: number;
  /** Uniform visual/geometry scale relative to the reference CARRIER_SIZE. */
  private readonly vis: number;
  private readonly hover: number;
  private readonly nodeOrbitR: number;
  private readonly nodeRadius: number;
  private readonly nodeMaxHealth: number;

  /** Fired once when the carrier dies, at its position — hands off to the field. */
  onDeath: (pos: Vector3) => void = () => {};
  /** Fired when a signal node pops (remaining node count). */
  onNodeDestroyed: (remaining: number) => void = () => {};
  /** Fired on each beacon pulse, with 0..1 proximity — drives the beacon audio. */
  onPulse: (proximity01: number) => void = () => {};
  /** Fired when a melee variant lands a tentacle strike on the player. */
  onStrike: (damage: number) => void = () => {};

  /** The variant's display name, or the generic relay title. */
  readonly title: string;
  /** True if the way down stays shut while this carrier lives. */
  readonly sealsDescent: boolean;
  private readonly variant?: CarrierVariant;
  private mixer: AnimationMixer | null = null;
  private readonly actions = new Map<string, AnimationAction>();
  private currentClip = '';
  /** Ring patrol angle, radians (roaming variants only). */
  private roamA = 0;
  private strikeCd = 0;
  /** Counts down through a wind-up; the blow lands when it reaches zero. */
  private strikeT = 0;
  private readonly anchor = new Vector3();

  private readonly group = new Group();
  private readonly bodyRoot = new Group();
  private readonly nodes: CarrierNode[] = [];
  private readonly nodeMats: MeshBasicMaterial[] = [];
  private readonly bodyMats: MeshStandardMaterial[] = [];
  /** Unlit body materials, tinted directly since they have no emissive channel. */
  private readonly unlitMats: MeshBasicMaterial[] = [];
  /** Each unlit material's original colour, so a stage tint is a blend not a stomp. */
  private readonly unlitBase: Color[] = [];
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
    size: number,
    maxHealth: number,
    variant?: CarrierVariant,
  ) {
    const vis = size / CARRIER_SIZE;
    this.size = size;
    this.vis = vis;
    this.variant = variant;
    this.title = variant?.title ?? 'Signal Carrier';
    this.sealsDescent = variant?.sealsDescent ?? false;
    this.radius = variant?.radiusFactor ? size * variant.radiusFactor : BODY_RADIUS * vis;
    this.hover = HOVER * vis;
    this.nodeOrbitR = NODE_ORBIT_R * vis;
    this.nodeRadius = Math.max(1.1, NODE_RADIUS * vis);
    this.maxHealth = maxHealth;
    this.health = maxHealth;
    this.nodeMaxHealth = maxHealth * NODE_HEALTH_FRAC;
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
    size = CARRIER_SIZE,
    maxHealth = MAX_HEALTH,
    variant?: CarrierVariant,
  ): Promise<SignalCarrier> {
    const gltf = await loader.loadGLB(variant?.modelUrl ?? carrierUrl);
    const model = gltf.scene;

    // Normalize: the source is authored at an arbitrary scale far from the
    // origin, so scale its longest axis to `size` and recenter the pivot.
    const box = new Box3().setFromObject(model);
    const bsize = box.getSize(new Vector3());
    const scale = size / Math.max(bsize.x, bsize.y, bsize.z, 1e-4);
    const wrap = new Group();
    wrap.add(model);
    wrap.scale.setScalar(scale);
    wrap.position.copy(box.getCenter(new Vector3()).multiplyScalar(-scale));

    const carrier = new SignalCarrier(scene, wrap, size, maxHealth, variant);
    carrier.captureBodyMaterials(model);
    // Hover clear of the seabed, but never so high that the body breaches. A
    // roaming variant adds its own `rise` on top — it patrols ABOVE its anchor.
    const lift = carrier.hover + (variant?.roam?.rise ?? 0);
    const topRoom = ceilingY - size * 0.55;
    carrier.anchor.copy(anchor);
    carrier.pos.copy(anchor).setY(Math.min(anchor.y + lift, topRoom));
    carrier.baseY = carrier.pos.y;
    carrier.group.position.copy(carrier.pos);
    if (variant?.clips && gltf.animations.length > 0) carrier.bindClips(model, gltf.animations, variant);
    carrier.buildBeacon();
    carrier.buildNodes();
    carrier.applyStage(0, true);
    return carrier;
  }

  /**
   * Wire up the model's animation clips by name.
   *
   * Matched by pattern rather than index because the source packs sixteen clips
   * in authoring order, and hard-coding indices would silently play a death
   * throe as an idle the first time the asset is re-exported.
   */
  private bindClips(model: Object3D, clips: AnimationClip[], variant: CarrierVariant): void {
    this.mixer = new AnimationMixer(model);
    for (const [state, re] of Object.entries(variant.clips ?? {})) {
      if (!re) continue;
      const clip = clips.find((c) => (re as RegExp).test(c.name));
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      // Attack and death play once and hold; the rest loop.
      if (state === 'attack' || state === 'death') {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(state, action);
    }
    this.play('idle', 0);
  }

  /** Crossfade to a clip, ignoring the request if it is already running. */
  private play(state: string, fade = 0.28): void {
    if (this.currentClip === state) return;
    const next = this.actions.get(state);
    if (!next) return;
    const prev = this.actions.get(this.currentClip);
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev) prev.stop();
    this.currentClip = state;
  }

  // ---- construction --------------------------------------------------------

  /** Grab the body's materials so damage stages can drive their emissive glow. */
  private captureBodyMaterials(model: Object3D): void {
    const hide = this.variant?.hideMeshes;
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // one landmark object; culling it costs more than it saves
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (hide && (hide.test(mesh.name) || mats.some((m) => m && hide.test((m as Material).name)))) {
        mesh.visible = false;
        return;
      }
      for (const m of mats as Material[]) {
        const sm = m as MeshStandardMaterial;
        if (sm?.isMeshStandardMaterial) this.bodyMats.push(sm);
        // Unlit bodies get tinted instead. The squid pack exports every part as
        // MeshBasicMaterial, so the emissive path below binds to nothing and the
        // damage stages would silently do nothing to it — the one visual cue
        // that tells you a carrier is dying.
        else if ((m as MeshBasicMaterial)?.isMeshBasicMaterial) {
          this.unlitMats.push(m as MeshBasicMaterial);
        }
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
    this.glowSprite.scale.setScalar(22 * this.vis);
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
    const geo = new IcosahedronGeometry(this.nodeRadius, 0);
    this.disposables.push(geo);
    const nodeCount = this.variant?.nodeCount ?? NODE_COUNT;
    for (let i = 0; i < nodeCount; i++) {
      const mat = new MeshBasicMaterial({ color: 0xbdf0ff, fog: false, toneMapped: false });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.nodeMats.push(mat);
      this.disposables.push(mat);
      this.nodes.push({
        mesh,
        health: this.nodeMaxHealth,
        alive: true,
        phase: (i / nodeCount) * Math.PI * 2,
        yOff: (-2 + i * 2.4) * this.vis,
        pos: new Vector3(),
      });
    }

    // Tethers: one line segment per node (body center → node), positions
    // rewritten in place each frame. One draw call for all of them. Sized off
    // the node count actually built, not the constant — a variant may ask for
    // more, and a short buffer would silently drop the extra tethers.
    const geoT = new BufferGeometry();
    this.tetherPos = new Float32BufferAttribute(new Float32Array(this.nodes.length * 6), 3);
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
      if (!this.inStrike(nd.pos, this.nodeRadius, origin, forward, reach, minDot)) continue;
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

    if (!res.nodeKilled && this.inStrike(this.pos, this.radius, origin, forward, reach, minDot)) {
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
    this.mixer?.update(dt);

    if (!this.alive) {
      this.play('death', 0.2);
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

    const stagger = this.staggerT > 0 ? 1 : 0;
    const roam = this.variant?.roam;
    let faceYaw: number;

    if (roam) {
      // A patrol, not a chase. It circles its anchor for ever, and the radius
      // breathes so the path never reads as a drawn circle. Deliberately never
      // takes the player's position into account: this thing owns the way out,
      // and the threat is that it is ALREADY there, not that it follows you.
      this.roamA += (roam.speed / Math.max(roam.radius, 1)) * dt * (1 + stagger * 1.4);
      const r = roam.radius * (0.82 + Math.sin(this.time * 0.23) * 0.18);
      this.pos.x = this.anchor.x + Math.cos(this.roamA) * r;
      this.pos.z = this.anchor.z + Math.sin(this.roamA) * r;
      this.pos.y =
        this.baseY + Math.sin(this.time * 0.41) * (roam.rise * 0.16) + stagger * Math.sin(this.time * 26) * 0.6;
      // Lead with the direction of travel, except mid-strike, when it turns on
      // whatever it is hitting.
      faceYaw =
        this.strikeT > 0
          ? Math.atan2(playerPos.x - this.pos.x, playerPos.z - this.pos.z)
          : Math.atan2(-Math.sin(this.roamA), -Math.cos(this.roamA)) + Math.PI / 2;
    } else {
      // Semi-stationary: a slow hover bob and a lazy turn, so it reads as alive
      // without ever leaving its anchor. Staggering makes it lurch.
      this.pos.y = this.baseY + Math.sin(this.time * 0.5) * 1.1 + stagger * Math.sin(this.time * 26) * 0.5;
      // Face the player slowly — an eye that tracks you is worth the two lines.
      faceYaw = Math.atan2(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
    }
    this.group.position.copy(this.pos);

    let dY = faceYaw - this.bodyRoot.rotation.y;
    while (dY > Math.PI) dY -= Math.PI * 2;
    while (dY < -Math.PI) dY += Math.PI * 2;
    const turn = roam ? 1.4 : 0.45;
    this.bodyRoot.rotation.y += Math.max(-turn * dt, Math.min(turn * dt, dY));
    this.bodyRoot.rotation.z = Math.sin(this.time * 0.37) * 0.05;

    this.updateMelee(dt, playerPos);
    this.updateNodes(dt);
    this.updateBeacon(dt, playerPos, stage);
  }

  /**
   * The tentacle strike.
   *
   * A wind-up rather than an instant hit, and the damage is only dealt if the
   * player is STILL in reach when the blow lands — so backing out of range is a
   * real answer to it, and the animation is telling you the truth about when to
   * move. Range is generous because the arms are long; it still never pursues.
   */
  private updateMelee(dt: number, playerPos: Vector3): void {
    const m = this.variant?.melee;
    if (!m) return;
    if (this.strikeCd > 0) this.strikeCd -= dt;

    if (this.strikeT > 0) {
      this.strikeT -= dt;
      if (this.strikeT <= 0) {
        // Landed — but only on someone who stayed inside the arms.
        if (playerPos.distanceTo(this.pos) <= m.range + this.radius) this.onStrike(m.damage);
      }
      return;
    }

    const near = playerPos.distanceTo(this.pos) <= m.range + this.radius;
    if (near && this.strikeCd <= 0) {
      this.strikeT = m.windup;
      this.strikeCd = m.cooldown;
      this.play('attack', 0.12);
      return;
    }
    // Between strikes: swim when it is patrolling, idle when it is not, and
    // switch to the fast cycle while something is close enough to be worth
    // reacting to.
    if (this.variant?.roam) this.play(near ? 'fast' : 'swim');
    else this.play('idle');
  }

  private updateNodes(dt: number): void {
    const spin = 0.34 + this.stage * 0.12; // agitation rises as it fails
    let seg = 0;
    const arr = this.tetherPos.array as Float32Array;
    for (const nd of this.nodes) {
      nd.phase += spin * dt;
      const r = this.nodeOrbitR + Math.sin(this.time * 0.8 + nd.phase) * 0.8 * this.vis;
      nd.pos.set(
        this.pos.x + Math.cos(nd.phase) * r,
        this.pos.y + nd.yOff + Math.sin(this.time * 0.9 + nd.phase) * 0.7 * this.vis,
        this.pos.z + Math.sin(nd.phase) * r,
      );
      if (nd.alive) {
        // Local space (the group is already at this.pos).
        nd.mesh.position.subVectors(nd.pos, this.pos);
        const hurt = 1 - nd.health / this.nodeMaxHealth;
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
    this.glowSprite.scale.setScalar((21 + flare * 8 + this.hurtFlash * 10) * this.vis);
    this.glowMat.opacity = 0.4 + flare * 0.3 + this.hurtFlash * 0.35;

    for (const r of this.rings) {
      if (r.t >= 1) {
        r.mesh.visible = false;
        continue;
      }
      r.t = Math.min(1, r.t + dt / 2.2);
      const s = (8 + r.t * 46) * this.vis;
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
    // Unlit bodies carry the same signal in their albedo. Blended rather than
    // replaced, so the model's own texture still reads at every stage.
    for (let i = 0; i < this.unlitMats.length; i++) {
      if (initial && !this.unlitBase[i]) this.unlitBase[i] = this.unlitMats[i].color.clone();
      const base = this.unlitBase[i];
      if (!base) continue;
      this.unlitMats[i].color.copy(base).lerp(this.stageColor, 0.12 + stage * 0.22);
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
