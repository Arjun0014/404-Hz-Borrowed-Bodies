import {
  ACESFilmicToneMapping,
  Scene,
  SRGBColorSpace,
  type Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { TerrainMaps, ZoneMaps } from '../world/types';
import { Solids } from '../world/Solids';
// Per-zone PBR sets, as GPU-compressed KTX2: diffuse, normal (GL), ARM
// (AO/rough/metal), displacement. Shallow Veil uses Poly Haven
// "coast_sand_rocks_02"; the Drowned Garden's cave uses "lichen_rock" (both CC0).
//
// The raw JPG/PNG sources are still in assets/ (they are what
// `node scripts/encode-ktx2.mjs` reads) but are no longer IMPORTED: a static
// import made Vite bundle them into the build even though nothing sampled them,
// shipping megabytes of dead weight.
import seabedDiffKtxUrl from '../../assets/textures/coast_sand_rocks_02_1k/ktx2/coast_sand_rocks_02_diff_1k.ktx2?url';
import seabedNorKtxUrl from '../../assets/textures/coast_sand_rocks_02_1k/ktx2/coast_sand_rocks_02_nor_gl_1k.ktx2?url';
import seabedArmKtxUrl from '../../assets/textures/coast_sand_rocks_02_1k/ktx2/coast_sand_rocks_02_arm_1k.ktx2?url';
import seabedDispKtxUrl from '../../assets/textures/coast_sand_rocks_02_1k/ktx2/coast_sand_rocks_02_disp_1k.ktx2?url';
import lichenDiffKtxUrl from '../../assets/textures/lichen_rock_1k/ktx2/lichen_rock_diff_1k.ktx2?url';
import lichenNorKtxUrl from '../../assets/textures/lichen_rock_1k/ktx2/lichen_rock_nor_gl_1k.ktx2?url';
import lichenArmKtxUrl from '../../assets/textures/lichen_rock_1k/ktx2/lichen_rock_arm_1k.ktx2?url';
import lichenDispKtxUrl from '../../assets/textures/lichen_rock_1k/ktx2/lichen_rock_disp_1k.ktx2?url';
// The Fallen Kingdom needs TWO sets, because it is a built place standing in a
// natural one: "aerial_rocks_04" for the cavern's hard fractured stone, and
// "castle_wall_slates" for every wall, column and block the kingdom raised.
import rockDiffKtxUrl from '../../assets/textures/aerial_rocks_04_1k/ktx2/aerial_rocks_04_diff_1k.ktx2?url';
import rockNorKtxUrl from '../../assets/textures/aerial_rocks_04_1k/ktx2/aerial_rocks_04_nor_gl_1k.ktx2?url';
import rockArmKtxUrl from '../../assets/textures/aerial_rocks_04_1k/ktx2/aerial_rocks_04_arm_1k.ktx2?url';
import rockDispKtxUrl from '../../assets/textures/aerial_rocks_04_1k/ktx2/aerial_rocks_04_disp_1k.ktx2?url';
import castleDiffKtxUrl from '../../assets/textures/castle_wall_slates_1k/ktx2/castle_wall_slates_diff_1k.ktx2?url';
import castleNorKtxUrl from '../../assets/textures/castle_wall_slates_1k/ktx2/castle_wall_slates_nor_gl_1k.ktx2?url';
import castleArmKtxUrl from '../../assets/textures/castle_wall_slates_1k/ktx2/castle_wall_slates_arm_1k.ktx2?url';
import castleDispKtxUrl from '../../assets/textures/castle_wall_slates_1k/ktx2/castle_wall_slates_disp_1k.ktx2?url';
import { Loop } from './Loop';
import { Input } from './Input';
import { AssetLoader } from './AssetLoader';
import { Quality } from './Quality';
import { DebugOverlay } from './DebugOverlay';
import { ZoneManager } from '../world/ZoneManager';
import { RunState } from '../state/RunState';
import { PlayerFish } from '../entities/PlayerFish';
import { SwimController } from '../player/SwimController';
import { PlayerCamera } from '../player/PlayerCamera';
import { Bubbles } from '../entities/Bubbles';
import { UnderwaterFx } from '../render/UnderwaterFx';
import { BloodFx } from '../render/BloodFx';
import { KillCinematic } from '../render/KillCinematic';
import { DARTFISH, hostProfileFromCreature } from '../data/species';
import { EAT_SIZE_RATIO, speciesById } from '../data/creatures';
import { Ecosystem } from '../systems/Ecosystem';
import { Flora } from '../world/Flora';
import { PlayerCombat } from '../player/PlayerCombat';
import { PlayerGrowth } from '../player/PlayerGrowth';
import { PlayerPossession } from '../player/PlayerPossession';
import { PlayerAbility } from '../player/PlayerAbility';
import { PlayerResonance } from '../player/PlayerResonance';
import { PlayerConnection } from '../player/PlayerConnection';
import { Dominance } from '../systems/Dominance';
import { Sfx, AMBIENT, MUSIC } from './Sfx';
import { DamageBars } from '../ui/DamageBars';
import { SignalCarrier } from '../entities/SignalCarrier';
import { DeadSignalField } from '../systems/DeadSignalField';
import { Score } from '../systems/Score';
import type { CarrierSpec, CylinderCollider, Zone } from '../world/types';
import type { Creature } from '../entities/Creature';

const TAIL_POS = new Vector3();
const SPAWN = new Vector3();
const LOCK_AIM = new Vector3();
const LOCK_TO = new Vector3();
const LOCK_PROJ = new Vector3();
const BLOOD_DIR = new Vector3();
const CARRIER_PROJ = new Vector3();

/** Anything lockable: a creature OR a Signal Carrier (both carry a live world pos). */
type LockTarget = { readonly pos: Vector3; readonly alive: boolean };

// Signal Carrier HUD ranges.
/** Within this distance the Carrier's health bar takes over the screen. */
const CARRIER_ENGAGE_RANGE = 120;
/** Within this the off-screen direction marker appears — most of the shelf. */
const CARRIER_TRACK_RANGE = 400;

// Dead Signal Field anti-farm: in-field kills stop paying Dominance after a few,
// so the frenzy is a survival and possession opportunity, not a rank farm.
const FIELD_FREE_KILLS = 4;
const FIELD_KILL_DECAY = 0.45;

// Hold-RMB lock-on tuning.
const LOCK_RANGE = 60; // max acquire distance
const LOCK_KEEP_RANGE = 78; // sticky: hold a target a bit past acquire range
const LOCK_CONE = 0.3; // target must be within this view-cone of the aim to acquire
// Carriers are big landmarks — lockable (and held) from much further than a fish.
const CARRIER_LOCK_RANGE = 150;

// Signal Carrier → Connection coupling. The carriers are the SOLE source of the
// entity's grip: Connection rises ONLY while at least one relay is still alive —
// those in the current zone PLUS any you left un-killed in EARLIER zones (they
// carry forward; future zones never count). Each living relay contributes one
// "unit" of the base rise, so the pace scales linearly with how many are still
// broadcasting. Kill every relay in reach and the rise stops dead — that is the
// whole objective, and why the number frozen when you clear a level is your win.
const CARRIER_PRESSURE = 1.0; // rise units contributed per living carrier

function wait(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** Application shell: renderer, screens, run state, and zone lifecycle. */
export class GameApp {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly loop = new Loop();
  private readonly input: Input;
  private readonly quality: Quality;
  private readonly loader: AssetLoader;
  private readonly debug = new DebugOverlay();

  private zones!: ZoneManager;
  private runState!: RunState;
  private fish!: PlayerFish;
  private controller!: SwimController;
  private playerCamera!: PlayerCamera;
  private bubbles!: Bubbles;
  private fx!: UnderwaterFx;
  private blood!: BloodFx;
  /** Short frenzy-eat cutaway on big/lucky kills (Phase 16). */
  private cinematic!: KillCinematic;
  private ecosystem!: Ecosystem;
  private flora!: Flora;
  private combat!: PlayerCombat;
  private growth!: PlayerGrowth;
  private possession!: PlayerPossession;
  private ability!: PlayerAbility;
  private resonance!: PlayerResonance;
  private connection!: PlayerConnection;
  private dominance!: Dominance;
  private score!: Score;
  /** The zone's Signal Carriers (Phase 12; a zone may field several to clear). */
  private carriers: SignalCarrier[] = [];
  /** The Dead Signal Field a carrier death left behind (Phase 13). */
  private field: DeadSignalField | null = null;
  /** Kills made inside the field this run — feeds the anti-farm yield decay. */
  private fieldKills = 0;
  /** True once the shared reef flora has been disposed (one-way, on descent). */
  private floraDisposed = false;
  /** The carriers' solid obstacles, pushed into the zone's collider array. */
  private readonly carrierColliders: CylinderCollider[] = [];
  /** Whether the zone's descent membrane is currently raised. */
  private sealShown = false;
  /** How many carriers this zone started with (for the "N left" objective read). */
  private carrierTotalThisZone = 0;
  /** Carriers left ALIVE in earlier zones — their Connection pressure carries
   *  forward for the rest of the run (you can never go back to kill them). */
  private carriedOverCarriers = 0;
  private readonly sfx = new Sfx();
  /**
   * Every solid in the active zone, spatially indexed. One instance for the
   * whole app, rebound on descent, and shared by the player, the camera, and
   * all ~280 creatures — so the index is built once per zone rather than once
   * per reader, and nobody scans the full list.
   */
  private readonly solids = new Solids([]);
  private readonly damageBars = new DamageBars();
  /** Seconds of post-spawn peace before predators may hunt the host. */
  private spawnGrace = 0;
  /** Current hold-RMB lock-on target that can be POSSESSED (a creature only). */
  private lockedCreature: Creature | null = null;
  /** The general lock-on target — a creature OR a Carrier — driving the camera,
   *  reticle, and the bite-dash. lockedCreature is the possessable subset of it. */
  private lockTarget: LockTarget | null = null;

  private started = false;
  private transitioning = false;
  private promptShown = false;
  private promptDismissed = false;
  private repelling = false;

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    // The composer renders multiple passes per frame; reset info once manually
    // so the debug overlay reports the whole frame's real draw calls/triangles.
    this.renderer.info.autoReset = false;

    this.quality = new Quality(this.renderer);
    this.loader = new AssetLoader(this.renderer);
    this.input = new Input(this.renderer.domElement);

    window.addEventListener('resize', () => this.onResize());
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.error('[404hz] WebGL context lost');
      this.showHint('graphics context lost — reload the page', 10);
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.debug.toggle();
      } else if (e.code === 'F4') {
        e.preventDefault();
        this.quality.cycle();
        this.zones?.current.setParticleScale(this.quality.particleScale);
        this.bubbles?.setPixelRatio(this.renderer.getPixelRatio());
        this.fx?.resize(this.renderer);
        this.showHint(`quality: ${this.quality.level}`, 1.6);
      } else if (e.code === 'Backquote') {
        // Debug/balancing: freeze the Connection rise (` key).
        e.preventDefault();
        if (this.connection) {
          const frozen = this.connection.toggleFreeze();
          this.showHint(`connection ${frozen ? 'FROZEN (debug)' : 'resumed'}`, 1.6);
        }
      } else if (this.promptShown && !this.transitioning) {
        if (e.code === 'KeyE') {
          e.preventDefault();
          // Sealed exits refuse the key outright rather than failing silently.
          const sealer = this.sealingCarrier;
          if (sealer) this.showHint(`${sealer.title} still holds the way down`, 2.4);
          else void this.doDescend();
        } else if (e.code === 'KeyQ') {
          e.preventDefault();
          this.cancelDescent();
        }
      }
    });
  }

  /** Load one PBR set (diffuse / normal / ARM / displacement) from KTX2. */
  private async loadMapSet(urls: [string, string, string, string]): Promise<TerrainMaps> {
    const load = (url: string): Promise<Texture> => this.loader.loadKTX2(url);
    const [map, normalMap, armMap, displacementMap] = await Promise.all(urls.map(load));
    // Diffuse is sRGB colour; normal/ARM/displacement are linear data maps.
    // (KTX2 carries the transfer function in its DFD, but enforce it anyway.)
    map.colorSpace = SRGBColorSpace;
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    map.anisotropy = aniso;
    normalMap.anisotropy = aniso;
    armMap.anisotropy = aniso;
    return { map, normalMap, armMap, displacementMap };
  }

  /**
   * Load every zone's rock set up front. They are small (KTX2, ~1.2 MB each) and
   * shared across zone rebuilds, so paying once at boot beats a hitch mid-descent.
   */
  private async loadZoneMaps(): Promise<ZoneMaps> {
    const [seabed, lichen, rock, castle] = await Promise.all([
      this.loadMapSet([seabedDiffKtxUrl, seabedNorKtxUrl, seabedArmKtxUrl, seabedDispKtxUrl]),
      this.loadMapSet([lichenDiffKtxUrl, lichenNorKtxUrl, lichenArmKtxUrl, lichenDispKtxUrl]),
      this.loadMapSet([rockDiffKtxUrl, rockNorKtxUrl, rockArmKtxUrl, rockDispKtxUrl]),
      this.loadMapSet([castleDiffKtxUrl, castleNorKtxUrl, castleArmKtxUrl, castleDispKtxUrl]),
    ]);
    return { seabed, lichen, rock, castle };
  }

  async start(): Promise<void> {
    const loadingEl = document.getElementById('loading')!;
    const fillEl = document.getElementById('loading-fill')!;
    this.loader.onProgress = (l, t) => {
      fillEl.style.width = `${Math.round((l / Math.max(t, 1)) * 100)}%`;
    };

    // Seabed PBR set (Poly Haven coast_sand_rocks_02, CC0). Non-fatal if it
    // fails to load: zones fall back to their vertex-colour palettes.
    let maps: ZoneMaps = {};
    try {
      maps = await this.loadZoneMaps();
    } catch (err) {
      console.warn('[404hz] seabed textures failed to load, using fallback palette', err);
    }

    // Run state: resume a saved run if one is mid-descent, else start fresh.
    // Playtest shortcut: `?depth=N` boots a FRESH run straight into that zone
    // (0 = Shallow Veil, 1 = Drowned Garden, 2 = Fallen Kingdom), bypassing the
    // save so test links always land in a clean zone.
    const params = new URLSearchParams(location.search);
    const depthParam = params.get('depth');
    const saved = RunState.load();
    let resuming = !!saved && saved.data.depth > 0;
    if (depthParam !== null) {
      const d = Math.max(0, Math.min(9, parseInt(depthParam, 10) || 0));
      this.runState = new RunState();
      this.runState.data.depth = d;
      this.runState.data.stats.descents = d;
      resuming = false;
    } else {
      this.runState = resuming ? (saved as RunState) : new RunState();
    }
    this.runState.save();

    // Build the current zone + player rig.
    this.zones = new ZoneManager(this.scene, this.renderer, maps);
    const zone = this.zones.buildInitial(this.runState.data.depth, this.quality.particleScale);

    this.fish = await PlayerFish.create(this.loader, DARTFISH);
    this.scene.add(this.fish.object);

    this.solids.bind(zone.colliders, zone.boxColliders);
    this.playerCamera = new PlayerCamera(
      this.input,
      zone.terrain,
      this.solids,
      window.innerWidth / window.innerHeight,
    );
    this.playerCamera.setHost(DARTFISH.camera, this.fish.length);
    this.controller = new SwimController(
      this.fish,
      this.input,
      this.playerCamera,
      zone.terrain,
      this.solids,
      zone.getBounds(),
      zone.getSpawn(SPAWN),
      zone,
    );
    // The starting zone's modelled dressing, loaded before the title screen
    // clears so the world is complete the first time it is seen.
    await zone.dressing?.(this.loader, this.quality.dressingScale);

    this.bubbles = new Bubbles(this.scene);
    this.bubbles.setPixelRatio(this.renderer.getPixelRatio());
    this.fx = new UnderwaterFx(this.renderer, this.scene, this.playerCamera.camera);
    // Blood, gore, and the clouds they leave. Lives on the scene, not the zone,
    // so it survives descents and keeps running through a zone swap.
    this.blood = new BloodFx(this.scene);
    // The frenzy-eat cutaway reuses that blood layer, and drives the host + camera
    // forward while it plays (see tick()).
    this.cinematic = new KillCinematic(
      this.playerCamera.camera,
      this.fish,
      this.controller,
      this.blood,
      this.sfx,
    );

    // Seabed forest: load flora models once, then scatter them on this zone
    // (before the ecosystem, so big-coral colliders are in place for the fish).
    this.flora = new Flora(this.loader, this.scene);
    await this.flora.load();
    this.bindFlora(zone);

    // Living ecosystem: load every species once, then populate this zone.
    this.ecosystem = new Ecosystem(this.loader, this.scene);
    await this.ecosystem.load();
    this.bindEcosystem(zone);

    // Survival loop: host health, biting/feeding, damage from predators, death.
    this.combat = new PlayerCombat(
      this.controller,
      this.fish,
      this.ecosystem,
      this.input,
      this.sfx,
      this.playerCamera,
    );
    this.ecosystem.onHitPlayer = (dmg) => this.combat.takeDamage(dmg);
    this.combat.onDeath = () => this.onHostDeath();
    this.combat.onHit = () => this.triggerShake();

    // Growth: eating biomass grows the host toward its species ceiling.
    this.growth = new PlayerGrowth(this.fish, this.playerCamera, this.combat);
    // Resonance: a CHARACTER-level charge (survives host swaps) that eating fills
    // and a possession spends. Same biomass a bite feeds growth also feeds it.
    this.resonance = new PlayerResonance();
    this.combat.onFeed = (biomass) => {
      this.growth.feed(biomass);
      this.resonance.feed(biomass);
      this.score?.feed(biomass);
    };
    this.resonance.onFull = () => this.showResonanceReady();
    this.growth.onStageUp = (name) => this.showStageToast(name);

    // Dominance: defeating creatures builds a persistent run-level rank.
    this.dominance = new Dominance(this.runState);
    this.score = new Score(this.runState);
    this.ecosystem.onPlayerKill = (c) => {
      this.recordKill(c);
      this.maybeKillCinematic(c);
    };
    // Blood follows the bite direction, so spray and chunks fly the way the
    // jaws were travelling rather than puffing symmetrically.
    this.ecosystem.onBloodHit = (at, scale, died) => {
      this.controller.getForward(BLOOD_DIR);
      if (died) this.blood.kill(at, BLOOD_DIR, scale);
      else this.blood.hit(at, BLOOD_DIR, scale);
    };
    this.combat.onCarrierHit = (nodeKilled, died) => this.onCarrierHit(nodeKilled, died);
    this.dominance.onRankUp = (name) => this.onDominanceRankUp(name);
    this.dominance.onWeakCapped = () =>
      this.showHint('Weak prey no longer raises Dominance — hunt bigger creatures.', 5);

    // Possession: weaken a creature, then take over its body (Phase 7).
    this.possession = new PlayerPossession(
      this.ecosystem,
      this.fish,
      this.controller,
      this.playerCamera,
      this.growth,
      this.combat,
      this.dominance,
      this.resonance,
      this.input,
      this.sfx,
    );
    this.possession.onPossessed = (name, speciesId) => this.onPossessed(name, speciesId);
    this.possession.onRiskResult = (success, name) => this.onRiskResult(success, name);

    // Ability: the current host's one special move (Q). Distinct per curated host.
    this.ability = new PlayerAbility(
      this.fish,
      this.controller,
      this.combat,
      this.playerCamera,
      this.ecosystem,
      this.input,
      this.sfx,
    );
    this.ability.onActivate = (name) => this.showAbilityToast(name);

    // Connection: the entity's grip. Rises continuously (faster in bigger hosts),
    // eased only by slipping into a fresh body; full Connection ends the run.
    this.connection = new PlayerConnection();
    this.connection.onFull = () => this.onConnectionFull();

    // Signal Carriers: the zone's objective. Built last, so their garrisons can
    // be seeded from an already-populated ecosystem.
    await this.buildCarriers(zone);

    // Playtest shortcuts (URL params): `?fish=<speciesId>` starts you in that
    // body; `?freeze` stops Connection rising so you can explore in peace.
    const fishParam = params.get('fish') ?? params.get('host');
    if (fishParam) this.debugBecomeHost(fishParam);
    if (params.has('freeze')) this.connection.frozen = true;

    this.updateZoneTag();

    loadingEl.classList.add('hidden');
    const titleEl = document.getElementById('title')!;
    const promptLine = titleEl.querySelector('.prompt') as HTMLElement | null;
    if (resuming && promptLine) {
      promptLine.textContent = `click to resume · Depth ${this.runState.data.depth}`;
      const tag = document.createElement('p');
      tag.className = 'phase-tag';
      tag.textContent = 'press N for a new run';
      titleEl.appendChild(tag);
    }
    titleEl.classList.remove('hidden');

    const beginPlay = () => {
      titleEl.classList.add('hidden');
      document.getElementById('health-hud')!.classList.remove('hidden');
      document.getElementById('dominance-hud')!.classList.remove('hidden');
      document.getElementById('growth-hud')!.classList.remove('hidden');
      document.getElementById('resonance-gauge')!.classList.remove('hidden');
      document.getElementById('connection-hud')!.classList.remove('hidden');
      void this.sfx.load();
      this.updateZoneAmbient();
      this.spawnGrace = 3.5; // a calm moment before predators lock on
      this.ecosystem.armSpawnSafe(this.controller.pos.x, this.controller.pos.z, 30);
      this.input.requestLock();
    };
    titleEl.addEventListener('click', beginPlay);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyN' && !this.started) {
        RunState.clear();
        location.reload();
      }
      // Restart after the host dies.
      if (e.code === 'KeyR' && this.combat?.dead) {
        RunState.clear();
        location.reload();
      }
    });

    const resumeChip = document.getElementById('resume-chip')!;
    this.renderer.domElement.addEventListener('click', () => {
      if (this.started && !this.input.pointerLocked && !this.transitioning && !this.combat?.dead) {
        this.input.requestLock();
      }
    });
    this.input.onPointerLockChange = (locked) => {
      if (locked) {
        this.started = true;
        resumeChip.classList.add('hidden');
      } else if (this.started && !this.transitioning && !this.combat?.dead) {
        resumeChip.classList.remove('hidden');
      }
    };

    this.loop.onTick = (dt) => this.tick(dt);
    this.loop.start();

    // Expose for dev-console poking and automated checks.
    (window as unknown as { __game: unknown }).__game = this;
  }

  private tick(dt: number): void {
    this.renderer.info.reset();
    this.runState.tick(dt);
    const zone = this.zones.current;

    const dead = this.combat?.dead ?? false;
    // A kill cinematic (point 5) takes over the camera and freezes control for a
    // beat and a half; while it plays we suspend possession, swimming, and the
    // normal camera, but keep the world, blood, and FX running underneath it.
    const cine = this.cinematic?.active ?? false;
    // Lock-on first, so possession can act on the currently targeted creature.
    this.updateLockOn();
    if (!cine && !this.transitioning && this.started && !dead) {
      // Possession only ever acts on the locked-on target; while a takeover
      // channels, normal control is paused (the possession owns the body).
      this.possession.update(dt, this.lockedCreature);
      if (!this.possession.possessing) {
        this.controller.update(dt);
        if (this.repelling) {
          const done = this.zones.current.repelFromDescent(this.controller.pos, this.controller.vel, dt);
          if (done) {
            this.repelling = false;
            this.promptDismissed = false;
          }
        } else {
          this.checkDescent();
        }
      }
    }
    const possessing = this.possession?.possessing ?? false;

    if (this.spawnGrace > 0) this.spawnGrace -= dt;
    // Predators may only hunt/bite the host once it is in control and past the
    // post-spawn grace — no ambushes on the loading screen, mid-possession, mid
    // cinematic, or the instant you dive.
    const combatActive =
      this.started && !dead && !this.transitioning && !possessing && !cine && this.spawnGrace <= 0;

    const speed = this.transitioning || dead || cine ? 0 : this.controller.speed01;
    if (cine) {
      this.cinematic.update(dt); // owns the camera this frame
    } else {
      this.playerCamera.update(dt, this.controller.pos, this.controller.vel, speed);
      this.cinematic.tickIdle(dt); // advance its cooldown
    }
    zone.update(dt, this.playerCamera.camera, this.renderer);
    if (!this.floraDisposed) this.flora.update(dt);
    this.sfx.setSwim(dead || cine ? 0 : this.controller.speed01, this.controller.dashOutput > 0.25);
    if (!this.transitioning) {
      this.ecosystem.update(dt, this.controller.pos, this.fish.length, combatActive);
      if (this.started && !possessing && !cine) this.combat.update(dt);
      if (this.started && !possessing && !dead && !cine) {
        // Q is "stay" while a descent prompt is up, so drop the ability tap then.
        if (this.promptShown) this.input.consumeAbility();
        else this.ability.update(dt);
      }
      this.updateObjective(dt, dead);
      this.updateConnection(dt, dead);
      this.updateOnboarding(dt);
      this.updateCarrierHud();
      this.updateFieldHud();
      this.updateCombatHud();
      this.updateEnergyHud();
      this.updateGrowthHud();
      this.updateResonanceHud();
      this.updateAbilityHud();
      this.updateDominanceHud();
      this.updatePossessHud();
      this.updateLockReticle();
      this.damageBars.update(
        this.playerCamera.camera,
        this.ecosystem.list,
        window.innerWidth,
        window.innerHeight,
      );
    }

    if (!this.transitioning) {
      this.fish.getTailPosition(TAIL_POS);
      this.bubbles.update(
        dt,
        this.playerCamera.camera.position,
        TAIL_POS,
        this.controller.vel,
        this.controller.dashOutput,
      );
    }

    this.blood.update(dt, this.playerCamera.camera.position);
    // Sprint intensity drives the water-rush streaks in the post shader.
    this.fx.render(dt, speed, this.transitioning || dead || cine ? 0 : this.controller.dashOutput);
    this.debug.update(
      dt,
      this.renderer,
      this.loop,
      this.quality,
      this.controller.pos,
      zone.particleCount,
      this.ecosystem?.count ?? 0,
      this.connection && this.started ? this.connection.value01 * 100 : -1,
      this.connection?.frozen ?? false,
    );
  }

  // ---- combat HUD + death --------------------------------------------------

  private healthFillEl: HTMLElement | null = null;
  private vignetteEl: HTMLElement | null = null;

  private updateCombatHud(): void {
    if (!this.combat || !this.started) return;
    this.healthFillEl ||= document.getElementById('health-fill');
    this.vignetteEl ||= document.getElementById('damage-vignette');
    if (this.healthFillEl) {
      this.healthFillEl.style.width = `${Math.max(0, this.combat.health01 * 100)}%`;
      this.healthFillEl.classList.toggle('fed', this.combat.feedFlash > 0.01);
      this.healthFillEl.classList.toggle(
        'low',
        this.combat.health01 < 0.3 && this.combat.feedFlash <= 0.01,
      );
    }
    if (this.vignetteEl) {
      this.vignetteEl.style.opacity = String(Math.min(0.9, this.combat.hurtFlash * 0.9));
    }
  }

  // ---- sprint energy HUD ---------------------------------------------------

  private energyBarEl: HTMLElement | null = null;
  private energyFillEl: HTMLElement | null = null;

  /**
   * The sprint bar only wants to be seen while it matters. Its opacity comes
   * straight from the controller's staminaShow (which snaps up on sprint and
   * eases down when you let off), so it appears as you sprint and quietly fades
   * away while it recharges — never sitting on screen the rest of the time.
   */
  private updateEnergyHud(): void {
    if (!this.started) return;
    this.energyBarEl ||= document.getElementById('energy-bar');
    this.energyFillEl ||= document.getElementById('energy-fill');
    if (!this.energyBarEl || !this.energyFillEl) return;
    const show = this.combat?.dead ? 0 : this.controller.staminaShow;
    this.energyBarEl.style.opacity = show.toFixed(2);
    if (show <= 0.001) return; // hidden — no need to touch the fill
    const s01 = this.controller.stamina01;
    this.energyFillEl.style.width = `${Math.max(0, Math.min(1, s01)) * 100}%`;
    this.energyFillEl.classList.toggle('low', s01 < 0.25);
  }

  private triggerShake(): void {
    const app = document.getElementById('app');
    if (!app) return;
    app.classList.remove('hit');
    void app.offsetWidth; // reflow so the animation restarts on each hit
    app.classList.add('hit');
  }

  // ---- growth HUD ----------------------------------------------------------

  private growthFillEl: HTMLElement | null = null;
  private growthStageEl: HTMLElement | null = null;
  private growthLenEl: HTMLElement | null = null;
  private stageToastUntil = 0;

  private updateGrowthHud(): void {
    if (!this.growth || !this.started) return;
    this.growthFillEl ||= document.getElementById('growth-fill');
    this.growthStageEl ||= document.getElementById('growth-stage');
    this.growthLenEl ||= document.getElementById('growth-len');
    const maxed = this.growth.atCeiling;
    if (this.growthFillEl) {
      this.growthFillEl.style.width = `${this.growth.growth01 * 100}%`;
      this.growthFillEl.classList.toggle('maxed', maxed);
    }
    if (this.growthStageEl) {
      this.growthStageEl.textContent = maxed ? `${this.growth.stageName} · MAX` : this.growth.stageName;
      this.growthStageEl.classList.toggle('maxed', maxed);
    }
    if (this.growthLenEl) this.growthLenEl.textContent = `${this.fish.length.toFixed(1)} m`;

    if (this.stageToastUntil > 0 && performance.now() > this.stageToastUntil) {
      this.stageToastUntil = 0;
      document.getElementById('stage-toast')!.classList.add('hidden');
    }
  }

  private showStageToast(name: string): void {
    const el = document.getElementById('stage-toast')!;
    el.classList.remove('dom', 'possess', 'resonance', 'fail');
    el.textContent = this.growth.atCeiling ? `MAX GROWTH · ${name}` : `Grew · ${name}`;
    el.classList.remove('hidden');
    void el.offsetWidth; // restart the pop animation
    this.stageToastUntil = performance.now() + 2400;
  }

  private showAbilityToast(name: string): void {
    this.showToast(`${name}!`, null, 1200);
  }

  /**
   * The single centre-screen toast, shared by every system that flashes a line.
   * `variant` picks the palette (null = the default gold); passing it explicitly
   * matters because the variant classes are sticky and must be cleared each time.
   */
  private showToast(
    text: string,
    variant: 'dom' | 'possess' | 'resonance' | 'fail' | null,
    ms: number,
  ): void {
    const el = document.getElementById('stage-toast')!;
    el.classList.remove('dom', 'possess', 'resonance', 'fail');
    if (variant) el.classList.add(variant);
    el.textContent = text;
    el.classList.remove('hidden');
    void el.offsetWidth; // restart the pop animation
    this.stageToastUntil = performance.now() + ms;
  }

  // ---- ability HUD (host special move) ------------------------------------

  private abilityHudEl: HTMLElement | null = null;
  private abilityNameEl: HTMLElement | null = null;
  private abilityFillEl: HTMLElement | null = null;
  private abilityReadyPct = -1;

  private updateAbilityHud(): void {
    if (!this.ability || !this.started) return;
    this.abilityHudEl ||= document.getElementById('ability-hud');
    this.abilityNameEl ||= document.getElementById('ability-name');
    this.abilityFillEl ||= document.getElementById('ability-fill');
    if (!this.abilityHudEl) return;
    const has = this.ability.has;
    this.abilityHudEl.classList.toggle('hidden', !has);
    if (!has) return;
    if (this.abilityNameEl) this.abilityNameEl.textContent = this.fish.species.ability.name;
    const pct = Math.round(this.ability.ready01 * 100);
    if (this.abilityFillEl && pct !== this.abilityReadyPct) {
      this.abilityReadyPct = pct;
      this.abilityFillEl.style.width = `${pct}%`;
    }
    this.abilityHudEl.classList.toggle('ready', this.ability.isReady);
    this.abilityHudEl.classList.toggle('active', this.ability.isActive);
  }

  // ---- resonance HUD (possession charge) ----------------------------------

  private resonanceGaugeEl: HTMLElement | null = null;
  private resonanceRingEl: HTMLElement | null = null;
  private resonancePct = -1;

  private updateResonanceHud(): void {
    if (!this.resonance || !this.started) return;
    this.resonanceGaugeEl ||= document.getElementById('resonance-gauge');
    this.resonanceRingEl ||= this.resonanceGaugeEl?.querySelector('.rg-ring') ?? null;
    const full = this.resonance.isFull;
    // Only repaint the conic-gradient ring on an integer-% change (it now ticks
    // passively every frame, so guard the write).
    const pct = Math.round(this.resonance.value01 * 100);
    if (this.resonanceRingEl && pct !== this.resonancePct) {
      this.resonancePct = pct;
      this.resonanceRingEl.style.setProperty('--pct', String(pct));
    }
    if (this.resonanceGaugeEl) {
      this.resonanceGaugeEl.classList.toggle('full', full);
      // Pulse when you're aiming at a takeable fish but not yet charged.
      this.resonanceGaugeEl.classList.toggle('needed', !full && (this.possession?.needsCharge ?? false));
    }
  }

  private showResonanceReady(): void {
    if (!this.started) return;
    const el = document.getElementById('stage-toast')!;
    el.classList.remove('dom', 'possess', 'fail');
    el.classList.add('resonance');
    el.textContent = 'RESONANCE FULL · possession ready';
    el.classList.remove('hidden');
    void el.offsetWidth;
    this.stageToastUntil = performance.now() + 2200;
  }

  // ---- connection (the entity's grip) -------------------------------------

  private connFillEl: HTMLElement | null = null;
  private connPctEl: HTMLElement | null = null;
  private connHudEl: HTMLElement | null = null;
  private connWarnEl: HTMLElement | null = null;
  private connVigEl: HTMLElement | null = null;
  private connBeatT = 0;
  // Cached last-written HUD values, so the DOM is only touched on a real change.
  private connPct = -1;
  private connTierKey = '';
  private connVig = -1;

  /** Rise Connection, then drive its HUD bar, warning, vignette, and dread audio. */
  private updateConnection(dt: number, dead: boolean): void {
    if (!this.connection) return;
    if (this.started && !dead) {
      // Connection is driven ENTIRELY by the signal carriers. Rise = (living
      // carriers, this zone PLUS any left un-killed in earlier zones) scaled by the
      // per-host signal cost and, if you are standing in the nearest relay's aura,
      // that aura. With zero carriers left in reach the multiplier is 0 and the
      // rise stops completely — clearing a level banks your progress for good.
      const near = this.nearestCarrier(this.controller.pos);
      const totalCarriers = this.carriedOverCarriers + this.livingCarriers;
      const connMult =
        totalCarriers === 0
          ? 0
          : this.fish.species.connectionMult *
            (totalCarriers * CARRIER_PRESSURE) *
            (near ? near.connectionMultAt(this.controller.pos) : 1);
      this.connection.update(dt, this.fish.length, connMult);
      // Resonance also trickles up over time, paced to the Connection rise, so the
      // means to escape builds alongside the pressure.
      this.resonance.tickPassive(dt, PlayerConnection.riseRate(this.fish.length, connMult));
    }
    if (!this.started) return;

    const lvl = this.connection.value01;
    const tier = this.connection.tier;
    this.connFillEl ||= document.getElementById('connection-fill');
    this.connPctEl ||= document.getElementById('connection-pct');
    this.connHudEl ||= document.getElementById('connection-hud');
    this.connWarnEl ||= document.getElementById('connection-warning');
    this.connVigEl ||= document.getElementById('connection-vignette');

    const crit = tier === 'critical' && !dead;

    // Bar + %: only rewrite on an integer-% change (not all 60 frames a second).
    const pct = Math.round(lvl * 100);
    if (pct !== this.connPct) {
      this.connPct = pct;
      if (this.connFillEl) this.connFillEl.style.width = `${pct}%`;
      if (this.connPctEl) this.connPctEl.textContent = `${pct}%`;
    }

    // Tier classes + warning + vignette state: only on a tier/dead change.
    const tierKey = dead ? 'dead' : tier;
    if (tierKey !== this.connTierKey) {
      this.connTierKey = tierKey;
      if (this.connHudEl) {
        this.connHudEl.classList.toggle('rising', !dead && tier === 'rising');
        this.connHudEl.classList.toggle('high', !dead && tier === 'high');
        this.connHudEl.classList.toggle('critical', crit);
      }
      this.connWarnEl?.classList.toggle('hidden', !crit);
      this.connVigEl?.classList.toggle('critical', crit);
      // At critical the pulse animation owns the vignette opacity; clear inline so
      // it takes over, and force a re-write when we later drop out of critical.
      if (crit && this.connVigEl) this.connVigEl.style.opacity = '';
      this.connVig = -1;
    }

    // Eldritch vignette opacity — creeps in from ~40% (skipped while critical,
    // where the CSS pulse drives it), rewritten only on a real change.
    if (this.connVigEl && !crit) {
      const vig = dead ? 0 : Math.max(0, (lvl - 0.4) / 0.6) * 0.85;
      const vigR = Math.round(vig * 100);
      if (vigR !== this.connVig) {
        this.connVig = vigR;
        this.connVigEl.style.opacity = String(vig);
      }
    }

    // Dread audio: a swelling drone + a heartbeat, both only from the "high" band
    // (70%+) so calm/rising stays silent; the beat quickens toward full.
    this.sfx.setConnectionDrone(dead ? 0 : lvl);
    if (!dead && lvl > 0.7) {
      this.connBeatT -= dt;
      if (this.connBeatT <= 0) {
        const t = (lvl - 0.7) / 0.3; // 0 at 70% → 1 at full
        this.sfx.heartbeat(t);
        this.connBeatT = 1.4 - t * 0.98; // 1.4 s → ~0.42 s between beats
      }
    }
  }

  private onConnectionFull(): void {
    this.endRun(
      'THE SIGNAL TAKES HOLD',
      'the entity seizes your consciousness',
      'signal',
    );
  }

  // --- debug/balancing (callable from the dev console via __game) ---
  setConnection(v: number): void {
    this.connection?.setLevel(v);
  }
  freezeConnection(on = true): void {
    if (this.connection) this.connection.frozen = on;
  }

  /**
   * Force the player straight into a creature's body — the `?fish=<id>` playtest
   * link, and callable live as `__game.debugBecomeHost('shark')`. Mirrors a real
   * possession's takeover (profile + host instance + growth/camera/health reseat)
   * but skips the channel, warp, and Resonance cost. `grow` (0..1) sets the size.
   */
  debugBecomeHost(speciesId: string, grow = 0.7): void {
    let sp;
    try {
      sp = speciesById(speciesId);
    } catch {
      console.warn(`[404hz] debugBecomeHost: unknown species "${speciesId}"`);
      return;
    }
    const profile = hostProfileFromCreature(sp);
    const inst = this.ecosystem.createHostInstance(sp.id);
    this.fish.swapHost(profile, inst);
    this.growth.setHost(Math.max(0, Math.min(1, grow))); // size + camera + max HP
    this.combat.dead = false;
    this.combat.health = this.combat.maxHealth;
    this.runState.data.hostSpeciesId = sp.id;
    this.onPossessed(profile.displayName, sp.id);
  }

  // ---- onboarding (Phase 14: teach through play, not a tutorial) ----------

  /** Beats already fired this run — each one shows exactly once. */
  private readonly beatsShown = new Set<string>();
  private beatCooldown = 0;

  /**
   * Contextual teaching. Each beat is a condition the player has just walked
   * into, phrased as a nudge rather than an instruction, shown once, and rate
   * limited so two never collide. The order they naturally fire in follows the
   * core loop: eat → charge → take a body → feel the grip tighten → go find the
   * thing that can loosen it.
   */
  private updateOnboarding(dt: number): void {
    if (!this.started || this.combat.dead || this.transitioning) return;
    this.beatCooldown -= dt;
    if (this.beatCooldown > 0) return;

    const beat = (key: string, cond: boolean, text: string, secs = 5): boolean => {
      if (this.beatsShown.has(key) || !cond) return false;
      this.beatsShown.add(key);
      this.showHint(text, secs);
      this.beatCooldown = secs + 1.5;
      return true;
    };

    // The opening nudge: what to do with the ocean you woke up in.
    if (beat('hunt', this.runState.data.stats.timeSeconds > 4,
      'Hunt. Eating fills RESONANCE — and Resonance is what lets you take a body.')) return;

    // Charged for the first time: how to actually spend it.
    if (beat('lock', this.resonance.isFull,
      'Hold RIGHT MOUSE to lock a target, then HOLD F to slip into it — or tap G to gamble.')) return;

    // The pressure becomes legible before it becomes dangerous.
    if (beat('connection', this.connection.value01 > 0.35,
      'The entity is closing in. A body you have not worn recently loosens its grip.')) return;

    // Point them at the objective once they can sense it at all.
    const c = this.nearestCarrier(this.controller.pos);
    if (c && beat('carrier',
      this.controller.pos.distanceTo(c.pos) < CARRIER_TRACK_RANGE,
      'Lock on to a Signal Carrier and DASH-BITE it. Kill every relay in a level before you descend — any you leave alive keep dragging the entity onto you.',
      6.5)) return;

    // Only worth saying once they are genuinely in trouble.
    beat('critical', this.connection.value01 > 0.85,
      'It almost has you. Take a fresh body NOW, or find the Carrier.', 6);
  }

  // ---- Signal Carrier HUD --------------------------------------------------

  private carrierHudEl: HTMLElement | null = null;
  private carrierNameEl: HTMLElement | null = null;
  private carrierFillEl: HTMLElement | null = null;
  private carrierStageEl: HTMLElement | null = null;
  private carrierNodesEl: HTMLElement | null = null;
  private carrierMarkEl: HTMLElement | null = null;
  private carrierPct = -1;
  private carrierNodeText = '';
  private carrierNameText = '';
  private carrierSeen = false;
  /** Seconds the boss bar stays forced open after a hit, regardless of range. */
  private carrierEngagedT = 0;

  /**
   * Two readouts, deliberately separate: a boss bar once you are close enough to
   * be fighting it, and an off-screen direction marker from most of the shelf
   * away. The marker is the discovery aid — the design brief asks that the
   * Carrier be findable from half the zone, and fog alone will not do that.
   */
  private updateCarrierHud(): void {
    this.carrierHudEl ||= document.getElementById('carrier-hud');
    this.carrierMarkEl ||= document.getElementById('carrier-marker');
    if (!this.carrierHudEl || !this.carrierMarkEl) return;

    const c = this.nearestCarrier(this.controller.pos);
    if (!c || !c.alive || !this.started || this.combat.dead) {
      this.carrierHudEl.classList.add('hidden');
      this.carrierMarkEl.classList.add('hidden');
      return;
    }

    const dist = this.controller.pos.distanceTo(c.pos);
    this.carrierEngagedT = Math.max(0, this.carrierEngagedT - 0.016);

    // --- boss bar (close range, or recently struck) ---
    const engaged = dist < CARRIER_ENGAGE_RANGE || this.carrierEngagedT > 0;
    this.carrierHudEl.classList.toggle('hidden', !engaged);
    if (engaged) {
      if (!this.carrierSeen) {
        this.carrierSeen = true;
        this.showToast('SIGNAL CARRIER', 'resonance', 2600);
        this.showHint(
          'Break its three SIGNAL NODES — they shield the body and each one is worth a fifth of it.',
          7,
        );
      }
      this.carrierNameEl ||= document.getElementById('carrier-name');
      this.carrierFillEl ||= document.getElementById('carrier-fill');
      this.carrierStageEl ||= document.getElementById('carrier-stage');
      this.carrierNodesEl ||= document.getElementById('carrier-nodes');
      // Name doubles as the objective counter when a zone fields more than one.
      const nameText =
        this.carrierTotalThisZone > 1
          ? `SIGNAL CARRIER · ${this.livingCarriers}/${this.carrierTotalThisZone}`
          : 'SIGNAL CARRIER';
      if (nameText !== this.carrierNameText) {
        this.carrierNameText = nameText;
        if (this.carrierNameEl) this.carrierNameEl.textContent = nameText;
      }
      const pct = Math.round(c.health01 * 100);
      if (pct !== this.carrierPct) {
        this.carrierPct = pct;
        if (this.carrierFillEl) this.carrierFillEl.style.width = `${pct}%`;
        if (this.carrierStageEl) this.carrierStageEl.textContent = c.stageName;
      }
      // Node pips + the shield state, only rewritten when they actually change.
      const alive = c.nodesAlive;
      const text = alive > 0 ? `${'◆ '.repeat(alive).trim()}  SHIELDED` : 'SHIELD DOWN';
      if (text !== this.carrierNodeText) {
        this.carrierNodeText = text;
        if (this.carrierNodesEl) this.carrierNodesEl.textContent = text;
        this.carrierHudEl.classList.toggle('unshielded', alive === 0);
      }
      this.carrierHudEl.classList.toggle('critical', c.health01 < 0.25);
    }

    // --- off-screen direction marker (long range) ---
    if (dist > CARRIER_TRACK_RANGE) {
      this.carrierMarkEl.classList.add('hidden');
      return;
    }
    CARRIER_PROJ.copy(c.pos).project(this.playerCamera.camera);
    const behind = CARRIER_PROJ.z > 1;
    const onScreen =
      !behind && Math.abs(CARRIER_PROJ.x) < 0.94 && Math.abs(CARRIER_PROJ.y) < 0.9;
    // Once you can see it, the marker gets out of the way.
    if (onScreen && engaged) {
      this.carrierMarkEl.classList.add('hidden');
      return;
    }
    let nx = CARRIER_PROJ.x;
    let ny = CARRIER_PROJ.y;
    if (behind) {
      nx = -nx;
      ny = -ny;
    }
    // Push the marker out to the screen edge along its own direction.
    const m = Math.max(Math.abs(nx), Math.abs(ny), 1e-3);
    const edge = behind || !onScreen ? 0.86 / m : 1;
    const x = (nx * edge * 0.5 + 0.5) * window.innerWidth;
    const y = (-ny * edge * 0.5 + 0.5) * window.innerHeight;
    this.carrierMarkEl.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    const left = this.livingCarriers;
    this.carrierMarkEl.textContent =
      left > 1 ? `◈ CARRIER ${Math.round(dist)}m · ${left} LEFT` : `◈ CARRIER ${Math.round(dist)}m`;
    this.carrierMarkEl.classList.remove('hidden');
  }

  // ---- Dead Signal Field HUD ----------------------------------------------

  private fieldHudEl: HTMLElement | null = null;
  private fieldFillEl: HTMLElement | null = null;
  private fieldStateEl: HTMLElement | null = null;
  private fieldInside = false;

  private updateFieldHud(): void {
    this.fieldHudEl ||= document.getElementById('field-hud');
    if (!this.fieldHudEl) return;
    const f = this.field;
    const show = !!f && f.active && this.started && !this.combat.dead;
    this.fieldHudEl.classList.toggle('hidden', !show);
    if (!show || !f) {
      this.fieldInside = false;
      return;
    }
    this.fieldFillEl ||= document.getElementById('field-fill');
    this.fieldStateEl ||= document.getElementById('field-state');
    if (this.fieldFillEl) this.fieldFillEl.style.width = `${f.life01 * 100}%`;

    const inside = f.contains(this.controller.pos);
    if (inside !== this.fieldInside) {
      this.fieldInside = inside;
      this.fieldHudEl.classList.toggle('inside', inside);
      if (this.fieldStateEl) {
        this.fieldStateEl.textContent = inside ? 'CONNECTION DRAINING' : 'COLLAPSING';
      }
      if (inside) this.showHint('the entity loses its grip — but nothing here is on your side', 3.5);
    }
  }

  // ---- dominance HUD -------------------------------------------------------

  private domRankEl: HTMLElement | null = null;
  private domFillEl: HTMLElement | null = null;

  private updateDominanceHud(): void {
    if (!this.dominance || !this.started) return;
    this.domRankEl ||= document.getElementById('dom-rank');
    this.domFillEl ||= document.getElementById('dom-fill');
    if (this.domRankEl) {
      this.domRankEl.textContent = this.dominance.rankName;
      this.domRankEl.classList.toggle('maxed', this.dominance.atMaxRank);
    }
    if (this.domFillEl) this.domFillEl.style.width = `${this.dominance.progressToNext * 100}%`;
  }

  private onDominanceRankUp(name: string): void {
    this.runState.save(); // persist milestone
    const el = document.getElementById('stage-toast')!;
    el.classList.remove('possess', 'resonance', 'fail');
    el.classList.add('dom');
    el.textContent = `Dominance ▸ ${name}`;
    el.classList.remove('hidden');
    void el.offsetWidth;
    this.stageToastUntil = performance.now() + 2600;
    const hud = document.getElementById('dominance-hud')!;
    hud.classList.remove('rankup');
    void hud.offsetWidth;
    hud.classList.add('rankup');
  }

  // ---- possession HUD + takeover ------------------------------------------

  private possessPromptEl: HTMLElement | null = null;
  private possessNameEl: HTMLElement | null = null;
  private possessGuaranteedEl: HTMLElement | null = null;
  private possessRiskEl: HTMLElement | null = null;
  private possessPctEl: HTMLElement | null = null;
  private possessFillEl: HTMLElement | null = null;

  private updatePossessHud(): void {
    this.possessPromptEl ||= document.getElementById('possess-prompt');
    if (!this.possessPromptEl || !this.possession) return;
    this.possessNameEl ||= this.possessPromptEl.querySelector('.pp-name');
    this.possessGuaranteedEl ||= this.possessPromptEl.querySelector('.pp-guaranteed');
    this.possessRiskEl ||= this.possessPromptEl.querySelector('.pp-risk');
    this.possessPctEl ||= this.possessPromptEl.querySelector('.pp-pct');
    this.possessFillEl ||= this.possessPromptEl.querySelector('.pp-channel-fill');

    const p = this.possession;
    const channeling = p.possessing;
    const chTarget = p.channelTarget;
    // Risk target (any locked, charged, in-range creature) drives the prompt when
    // not channeling; the guaranteed line only shows for eligible targets.
    const risk = !channeling && this.started ? p.riskTarget : null;
    const el = this.possessPromptEl;

    if (channeling && chTarget) {
      if (this.possessNameEl) this.possessNameEl.textContent = chTarget.species.displayName;
      if (this.possessFillEl) this.possessFillEl.style.width = `${p.channel01 * 100}%`;
      el.classList.add('channeling');
      el.classList.remove('hidden');
    } else if (risk) {
      if (this.possessNameEl) this.possessNameEl.textContent = risk.species.displayName;
      // Guaranteed hold shown only when the target is actually eligible.
      this.possessGuaranteedEl?.classList.toggle('hidden', !p.bestTarget);
      const pct = Math.round(p.riskChance01 * 100);
      if (this.possessPctEl) this.possessPctEl.textContent = `${pct}%`;
      if (this.possessRiskEl) {
        // Colour the odds: green (safe) → amber → red (long shot).
        this.possessRiskEl.classList.toggle('good', pct >= 66);
        this.possessRiskEl.classList.toggle('fair', pct >= 33 && pct < 66);
        this.possessRiskEl.classList.toggle('poor', pct < 33);
      }
      el.classList.remove('channeling');
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
      el.classList.remove('channeling');
    }
  }

  /** A risk-snatch resolved — flash + toast the outcome. */
  private onRiskResult(success: boolean, name: string): void {
    if (success) return; // the possess flow (onPossessed) already handles success
    this.score.breakStreak(); // a botched snatch ends the chain
    const flash = document.getElementById('possess-flash');
    if (flash) {
      flash.classList.remove('flash', 'fail');
      void flash.offsetWidth;
      flash.classList.add('flash', 'fail'); // red failure jolt
    }
    const el = document.getElementById('stage-toast')!;
    el.classList.remove('dom', 'resonance', 'possess');
    el.classList.add('fail');
    el.textContent = `Snatch failed · ${name} slips free`;
    el.classList.remove('hidden');
    void el.offsetWidth;
    this.stageToastUntil = performance.now() + 2200;
  }

  /** A takeover completed: adopt the new host, ease Connection, flash, toast. */
  private onPossessed(name: string, speciesId: string): void {
    this.runState.data.hostSpeciesId = speciesId;
    this.runState.save();
    this.spawnGrace = 2.5; // a beat of peace to settle into the new body
    this.controller.refillStamina(); // a fresh body starts rested

    // A fresh body loosens the entity's grip; a recently-worn one barely helps.
    const fresh = this.connection.freshness(speciesId);
    this.connection.possess(speciesId);
    this.score.possessed(speciesId, this.possession.lastPossessionWasRisk);
    this.ability.reset(); // the new host's special move is ready immediately
    this.abilityReadyPct = -1; // force the ability HUD to repaint for the new host

    const flash = document.getElementById('possess-flash');
    if (flash) {
      flash.classList.remove('flash', 'fail');
      void flash.offsetWidth;
      flash.classList.add('flash');
    }
    document.getElementById('possess-prompt')?.classList.add('hidden');
    document.getElementById('possess-prompt')?.classList.remove('channeling');

    const el = document.getElementById('stage-toast')!;
    el.classList.remove('dom', 'resonance', 'fail');
    el.classList.add('possess');
    const abil = this.fish.species.ability;
    el.textContent =
      abil.kind !== 'none' ? `Possessed · ${name}  —  ${abil.name} [Q]` : `Possessed · ${name}`;
    el.classList.remove('hidden');
    void el.offsetWidth;
    this.stageToastUntil = performance.now() + 2600;

    // Teach the contamination rule: a familiar body gives little relief.
    if (fresh < 0.5) this.showHint('a familiar body — the signal barely loosens', 2.4);
    else this.showHint(this.fish.species.identity, 3.2); // introduce the new host
  }

  // ---- lock-on (hold right mouse) -----------------------------------------

  private lockReticleEl: HTMLElement | null = null;

  /**
   * Acquire/hold a lock-on target while RMB is held and feed it to the camera,
   * the reticle, and the bite-dash. A target may be a creature (possessable) OR a
   * Signal Carrier (the objective, point 6) — both are dashed at and bitten the
   * same way; only a creature can be possessed, so lockedCreature is the subset.
   */
  private updateLockOn(): void {
    const active =
      this.input.rmbDown && this.started && !(this.combat?.dead ?? false) && !this.transitioning;
    if (!active) {
      this.lockTarget = null;
      this.lockedCreature = null;
      this.playerCamera.setLockTarget(null);
      if (this.combat) this.combat.lockTarget = null;
      return;
    }
    // Sticky: keep the current target while it lives and stays within reach
    // (carriers hold from further, being large); otherwise re-acquire.
    const cur = this.lockTarget;
    const keepRange = this.isCarrier(cur) ? CARRIER_LOCK_RANGE * 1.3 : LOCK_KEEP_RANGE;
    if (!cur || !cur.alive || cur.pos.distanceTo(this.controller.pos) > keepRange) {
      this.lockTarget = this.acquireLockTarget();
    }
    this.lockedCreature =
      this.lockTarget && !this.isCarrier(this.lockTarget) ? (this.lockTarget as Creature) : null;
    this.playerCamera.setLockTarget(this.lockTarget ? this.lockTarget.pos : null);
    if (this.combat) this.combat.lockTarget = this.lockTarget;
  }

  /** Pick the most on-screen, nearest living target (creature or carrier) in the aim cone. */
  private acquireLockTarget(): LockTarget | null {
    this.playerCamera.getAimDir(LOCK_AIM);
    const from = this.controller.pos;
    let best: LockTarget | null = null;
    let bestScore = -Infinity;

    const list = this.ecosystem?.list;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c.alive) continue;
        LOCK_TO.subVectors(c.pos, from);
        const d = LOCK_TO.length();
        if (d < 1e-3 || d > LOCK_RANGE) continue;
        const dot = (LOCK_AIM.x * LOCK_TO.x + LOCK_AIM.y * LOCK_TO.y + LOCK_AIM.z * LOCK_TO.z) / d;
        if (dot < LOCK_CONE) continue; // must be roughly in front / in view
        const score = dot * 1.5 - d / LOCK_RANGE; // most-centered + closest wins
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }

    // Carriers are lockable too — the objective you dash into and tear open. They
    // hold from much further and get a small bias so aiming at one wins over a
    // stray fish drifting across it.
    for (const cc of this.carriers) {
      if (!cc.alive) continue;
      LOCK_TO.subVectors(cc.pos, from);
      const d = LOCK_TO.length();
      if (d < 1e-3 || d > CARRIER_LOCK_RANGE) continue;
      const dot = (LOCK_AIM.x * LOCK_TO.x + LOCK_AIM.y * LOCK_TO.y + LOCK_AIM.z * LOCK_TO.z) / d;
      if (dot < LOCK_CONE) continue;
      const score = dot * 1.5 - d / CARRIER_LOCK_RANGE + 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = cc;
      }
    }
    return best;
  }

  /** Position the on-screen lock reticle over the locked target (or hide it). */
  private updateLockReticle(): void {
    this.lockReticleEl ||= document.getElementById('lock-reticle');
    const el = this.lockReticleEl;
    if (!el) return;
    const c = this.lockTarget;
    if (!c || !c.alive) {
      el.classList.add('hidden');
      return;
    }
    LOCK_PROJ.copy(c.pos).project(this.playerCamera.camera);
    if (LOCK_PROJ.z > 1) {
      el.classList.add('hidden'); // behind the camera
      return;
    }
    const x = (LOCK_PROJ.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-LOCK_PROJ.y * 0.5 + 0.5) * window.innerHeight;
    el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    el.classList.remove('hidden');
  }

  /**
   * Loop the current zone's background ambience, and start its theme.
   *
   * Two layers on purpose: the ambience is the water and never changes volume,
   * while the score arrives loud for its first thirty seconds and then settles
   * underneath (see Sfx.playMusic). The Shallow Veil has no theme — the surface
   * stays quiet so that dropping into the Garden has something to announce.
   */
  private updateZoneAmbient(): void {
    const depth = this.runState.data.depth;
    void this.sfx.playAmbient(depth === 0 ? AMBIENT.shallowVeil : AMBIENT.drownedGarden);
    const theme = depth === 1 ? MUSIC.drownedGarden : depth >= 2 ? MUSIC.fallenKingdom : null;
    if (theme) void this.sfx.playMusic(theme);
    else this.sfx.stopMusic();
  }

  private onHostDeath(): void {
    this.endRun('YOUR HOST HAS DIED', 'the signal claims another body');
  }

  /**
   * End the run and show the fail screen. Both fail states route here: the host
   * dying in combat, and Connection reaching full (the entity taking control,
   * flagged with `variant: 'signal'` for its eldritch styling/copy).
   */
  private endRun(title: string, sub: string, variant?: 'signal'): void {
    this.combat.dead = true; // gate control everywhere + enable R to restart
    document.exitPointerLock?.();
    this.cinematic?.cancel(); // never leave the letterbox up over the death screen
    this.possession?.reset();
    this.score?.breakStreak();
    this.lockedCreature = null;
    this.lockTarget = null;
    if (this.combat) this.combat.lockTarget = null;
    this.playerCamera?.setLockTarget(null);
    this.damageBars.hideAll();
    this.sfx.setConnectionDrone(0);
    this.sfx.setFieldTone(0);
    this.sfx.stopMusic(2.5); // the score dies with the host
    document.getElementById('lock-reticle')?.classList.add('hidden');
    document.getElementById('possess-prompt')?.classList.add('hidden');
    document.getElementById('connection-warning')?.classList.add('hidden');
    document.getElementById('carrier-hud')?.classList.add('hidden');
    document.getElementById('carrier-marker')?.classList.add('hidden');
    document.getElementById('field-hud')?.classList.add('hidden');
    // Clear in-flight feedback, or a toast/hint from the moment of death hangs
    // over the summary. The hint's own timer is cancelled too.
    if (this.hintTimer) window.clearTimeout(this.hintTimer);
    this.hintTimer = 0;
    this.stageToastUntil = 0;
    document.getElementById('stage-toast')?.classList.add('hidden');
    document.getElementById('hint')?.classList.add('hidden');
    const ds = document.getElementById('death-screen')!;
    (ds.querySelector('.death-title') as HTMLElement).textContent = title;
    (ds.querySelector('.death-sub') as HTMLElement).textContent = sub;
    ds.classList.toggle('signal', variant === 'signal');
    this.renderRunSummary();
    ds.classList.remove('hidden');
    document.getElementById('resume-chip')!.classList.add('hidden');
  }

  /**
   * The run summary (Phase 14's first scoring pass): what the run was actually
   * worth, itemised. Showing the breakdown rather than a bare number is the
   * point — it teaches which behaviours pay, which is how the score model
   * steers play away from farming.
   */
  private renderRunSummary(): void {
    const host = document.getElementById('run-summary');
    if (!host || !this.score) return;
    const total = this.score.commit();
    const lines = this.score.breakdown();
    const mins = Math.floor(this.runState.data.stats.timeSeconds / 60);
    const secs = Math.floor(this.runState.data.stats.timeSeconds % 60);

    const rows = lines
      .map(
        (l) =>
          `<div class="rs-row"><span class="rs-label">${l.label}</span>` +
          `<span class="rs-detail">${l.detail}</span>` +
          `<span class="rs-pts">${l.points.toLocaleString()}</span></div>`,
      )
      .join('');
    host.innerHTML =
      `<div class="rs-total"><span>RUN SCORE</span><b>${total.toLocaleString()}</b></div>` +
      `<div class="rs-rows">${rows || '<div class="rs-row rs-empty">nothing worth recording</div>'}</div>` +
      `<div class="rs-time">survived ${mins}m ${secs}s · Dominance ${this.dominance.rankName}` +
      `${this.score.carriers > 0 ? ` · ${this.score.carriers} Carrier down` : ''}</div>`;
    host.classList.remove('hidden');
  }

  /** Scatter the seabed forest for a zone (none when the zone has no area). */
  private bindFlora(zone: Zone): void {
    const area = zone.getFloraArea();
    if (area) {
      this.flora.bindZone(zone.terrain, area, zone.colliders);
      return;
    }
    // No shared flora in this zone. Descent is one-way, so the reef set can
    // never be needed again — fully dispose its geometry, materials, and
    // textures rather than merely unbinding the instances. Keeping the Shallow
    // Veil's plants resident while playing the Drowned Garden was pure waste.
    this.flora.dispose();
    this.floraDisposed = true;
  }

  // ---- Signal Carrier + Dead Signal Field (Phases 12–13) -------------------

  /**
   * Stand up the zone's Signal Carrier and its garrison. Safe to call for zones
   * that have no Carrier (it simply does nothing), and it refuses to rebuild one
   * the player has already destroyed — one Carrier per zone per run is the
   * anti-farm rule that keeps Dead Signal Fields scarce.
   */
  private async buildCarriers(zone: Zone): Promise<void> {
    this.disposeCarriers();
    // A zone may describe its carriers individually (the Fallen Kingdom pairs a
    // relay with a colossal squid) or just hand over N identical anchors.
    const cfg = zone.getCarrierConfig?.() ?? { size: 12, health: 3000 };
    const specs: CarrierSpec[] =
      zone.getCarrierSpecs?.() ??
      zone.getCarrierAnchors().map((anchor) => ({ anchor, size: cfg.size, health: cfg.health }));
    if (specs.length === 0) return;

    for (const spec of specs) {
      let carrier: SignalCarrier;
      try {
        carrier = await SignalCarrier.create(
          this.loader,
          this.scene,
          spec.anchor,
          zone.getBounds().ceilingY,
          spec.size,
          spec.health,
          spec.variant,
        );
      } catch (err) {
        // Non-fatal: the zone is still playable, it just has one fewer objective.
        console.warn('[404hz] signal carrier failed to load', err);
        continue;
      }
      carrier.onDeath = (pos) => this.onCarrierDeath(pos);
      carrier.onNodeDestroyed = (left) => this.onCarrierNode(left);
      carrier.onPulse = (prox) => this.sfx.carrierPulse(prox);
      // A melee variant hits the player directly. Routed through the same
      // takeDamage path as a predator's bite so guard, i-frames and the death
      // screen all behave exactly as they already do.
      carrier.onStrike = (dmg) => {
        if (this.combat.dead || this.transitioning) return;
        this.combat.takeDamage(dmg);
        this.playerCamera.punch(20);
        this.sfx.biteLanded();
      };
      this.carriers.push(carrier);

      // Make the relay solid — one collider per carrier in the zone's live array,
      // so player, camera, and creatures all avoid it. Removed in disposeCarriers
      // (or on that carrier's death, so a faded corpse leaves no invisible wall).
      const col: CylinderCollider = {
        x: carrier.pos.x,
        z: carrier.pos.z,
        r: carrier.radius,
        top: carrier.pos.y + carrier.radius,
      };
      this.carrierColliders.push(col);
      zone.colliders.push(col);
      // A small garrison each, so both relays are defended when found.
      this.ecosystem.garrisonCarrier(carrier.pos, 4);
    }
    this.ecosystem.carriers = this.carriers;
    this.carrierTotalThisZone = this.carriers.length;
  }

  private disposeCarriers(): void {
    const cols = this.zones?.current.colliders;
    if (cols) {
      for (const cc of this.carrierColliders) {
        const i = cols.indexOf(cc);
        if (i >= 0) cols.splice(i, 1);
      }
    }
    this.carrierColliders.length = 0;
    for (const c of this.carriers) c.dispose();
    this.carriers = [];
    this.carrierTotalThisZone = 0;
    this.field?.dispose();
    this.field = null;
    if (this.ecosystem) {
      this.ecosystem.carriers = [];
      this.ecosystem.field = null;
    }
  }

  /** How many of this zone's carriers are still broadcasting. */
  private get livingCarriers(): number {
    let n = 0;
    for (const c of this.carriers) if (c.alive) n++;
    return n;
  }

  /** Nearest still-living carrier to a point (HUD + aura + connection pressure). */
  private nearestCarrier(at: Vector3): SignalCarrier | null {
    return this.ecosystem?.nearestCarrier(at) ?? null;
  }

  /** True when a lock target is actually one of the carriers (not a creature). */
  private isCarrier(t: LockTarget | null): t is SignalCarrier {
    return !!t && this.carriers.includes(t as SignalCarrier);
  }

  /** A bite connected with the relay — feedback scaled to what it hit. */
  private onCarrierHit(nodeKilled: boolean, died: boolean): void {
    // Force the boss bar visible and repainted the moment it is struck, however
    // far away the player is standing: hitting something and seeing no health
    // move reads as the hit not registering.
    this.carrierEngagedT = 6;
    this.carrierPct = -1;
    if (died || nodeKilled) return; // those have their own, louder feedback
    this.sfx.biteLanded(0.7);
  }

  /** A signal node popped: a big chunk of the bar, and the shield weakens. */
  private onCarrierNode(remaining: number): void {
    this.score.carrierNodeDestroyed();
    this.sfx.carrierNodeBreak();
    this.triggerShake();
    this.showToast(
      remaining > 0
        ? `SIGNAL NODE BROKEN · ${remaining} left`
        : 'SHIELD DOWN — TEAR IT APART',
      'possess',
      2200,
    );
  }

  /**
   * The Carrier dies. This is the run's turning point: the entity loses a relay,
   * a Dead Signal Field opens over the corpse, and the local ecosystem tips into
   * a frenzy inside it.
   */
  private onCarrierDeath(pos: Vector3): void {
    this.score.carrierKilled();
    this.sfx.carrierDeath();
    this.triggerShake();
    this.ecosystem.alertPrey();

    // Killing the relay removes its share of the Connection rise straight away
    // (the multiplier reads livingCarriers each frame); kill the last one in reach
    // and the rise stops entirely until the next zone's relays wake it up again.

    // Drop the dead carrier's collider so its faded corpse leaves no invisible wall.
    const cols = this.zones.current.colliders;
    for (let i = this.carrierColliders.length - 1; i >= 0; i--) {
      const cc = this.carrierColliders[i];
      if (Math.abs(cc.x - pos.x) < 0.5 && Math.abs(cc.z - pos.z) < 0.5) {
        const ci = cols.indexOf(cc);
        if (ci >= 0) cols.splice(ci, 1);
        this.carrierColliders.splice(i, 1);
      }
    }

    // One Dead Signal Field at a time — a new kill moves it to the new corpse.
    this.field?.dispose();
    this.field = new DeadSignalField(this.scene, pos);
    this.ecosystem.field = this.field;

    const remaining = this.livingCarriers;
    const flash = document.getElementById('possess-flash');
    if (flash) {
      flash.classList.remove('flash', 'fail');
      void flash.offsetWidth;
      flash.classList.add('flash');
    }
    this.showToast(
      remaining > 0 ? `CARRIER DOWN · ${remaining} LEFT` : 'ALL CARRIERS DOWN — SIGNAL WEAKENED',
      'resonance',
      3000,
    );
    this.showHint(
      remaining > 0
        ? 'A DEAD SIGNAL FIELD opens over the corpse — the entity cannot hold you inside it. One relay down; clear the rest before you descend.'
        : "Every relay in this level is dead — none of them will follow you down. Descend clean when you're ready.",
      7,
    );
  }

  /** Advance the Carrier + field, and apply everything the field does to the run. */
  private updateObjective(dt: number, dead: boolean): void {
    const pos = this.controller.pos;

    // Corpses keep updating after death so their collapse flare plays out; they
    // are only disposed on zone change.
    for (let i = 0; i < this.carriers.length; i++) {
      const c = this.carriers[i];
      c.update(dt, pos);
      // A patrolling carrier moves, so its solid has to move with it. Leaving
      // the collider at the spawn anchor would park an invisible wall over the
      // descent and let you swim through the body itself.
      const col = this.carrierColliders[i];
      if (col && c.alive) {
        col.x = c.pos.x;
        col.z = c.pos.z;
        col.top = c.pos.y + c.radius;
      }
    }
    this.updateDescentSeal();

    if (this.field) {
      if (!this.field.update(dt)) {
        this.field.dispose();
        this.field = null;
        this.ecosystem.field = null;
        this.sfx.setFieldTone(0);
        this.possession.externalRiskBonus = 0;
        this.showHint('the dead signal collapses — the entity is back', 3);
      }
    }

    const strength = !dead && this.field ? this.field.strengthAt(pos) : 0;
    // Inside the field the entity's grip actually loosens — the only renewable
    // Connection relief in a run.
    if (strength > 0 && this.connection) this.connection.drain(this.field!.drainFor(pos, dt));
    this.possession.externalRiskBonus = this.field ? this.field.riskBonusFor(pos) : 0;
    this.sfx.setFieldTone(strength);
    this.score?.tick(dt, this.connection?.value01 ?? 0, strength > 0);
  }

  /**
   * Dominance credit for a kill, with the field's anti-farm decay applied. The
   * first few kills inside a frenzy pay normally; after that the field stops
   * being a rank farm and goes back to being a survival problem.
   */
  private recordKill(c: Creature): void {
    let mult = 1;
    if (this.field?.contains(c.pos)) {
      this.fieldKills++;
      if (this.fieldKills > FIELD_FREE_KILLS) {
        mult = Math.pow(FIELD_KILL_DECAY, this.fieldKills - FIELD_FREE_KILLS);
      }
    }
    this.dominance.recordKill(c.species, mult);
  }

  /**
   * Decide whether a kill earns a frenzy-eat cutaway (point 5). ALWAYS for prey
   * as large or larger than the host (the trophy kills), and occasionally on a
   * clean full eat of smaller prey — never for crabs (they chip, not spray), and
   * never mid-possession, mid-descent, or on a dead host. The cinematic's own
   * cooldown keeps it a rare treat even in a feeding frenzy.
   */
  private maybeKillCinematic(c: Creature): void {
    if (!this.started || this.combat.dead || this.transitioning || this.promptShown) return;
    if (this.possession?.possessing) return;
    if (c.species.role === 'crab') return;
    const hostLen = Math.max(0.001, this.fish.length);
    const big = c.length >= hostLen; // as large or larger than the host
    const eatenWhole = c.length <= hostLen / EAT_SIZE_RATIO; // a clean full swallow
    if (!(big || (eatenWhole && Math.random() < 0.12))) return;
    if (this.cinematic.trigger(c.pos, c.length, big)) {
      this.combat.iframes(2.4); // no free hits while the camera is away
    }
  }

  /** Populate the ecosystem for a zone (empty when the zone has no area). */
  private bindEcosystem(zone: Zone): void {
    const area = zone.getPopulationArea();
    this.ecosystem.bindZone({
      terrain: zone.terrain,
      solids: this.solids,
      bounds: zone.getBounds(),
      area,
      population: area ? zone.getPopulation() : [],
      focus: this.controller.pos,
    });
  }

  // ---- descent flow --------------------------------------------------------

  /**
   * The carrier holding this zone's exit shut, if there is one and it lives.
   *
   * A sealing carrier turns its zone's descent from a decision into a fight:
   * you cannot leave the Fallen Kingdom without going through the Drowned
   * Herald, because the Herald is what is generating the membrane.
   */
  private get sealingCarrier(): SignalCarrier | null {
    for (const c of this.carriers) if (c.sealsDescent && c.alive) return c;
    return null;
  }

  /** Keep the zone's visible membrane in step with its sealing carrier. */
  private updateDescentSeal(): void {
    const sealed = !!this.sealingCarrier;
    if (sealed === this.sealShown) return;
    this.sealShown = sealed;
    this.zones.current.setDescentSealed?.(sealed);
    if (!sealed) {
      this.showHint('the seal over the throat gutters and fails — the way down is open', 5);
      this.sfx.carrierDeath();
    }
  }

  private checkDescent(): void {
    const inZone = this.zones.current.isInDescentZone(this.controller.pos);
    if (inZone) {
      if (!this.promptShown && !this.promptDismissed) this.showDescentPrompt();
    } else {
      this.promptDismissed = false;
      if (this.promptShown) this.hideDescentPrompt();
    }
  }

  private showDescentPrompt(): void {
    const info = this.zones.current.getDescentInfo();
    if (!info) return;
    this.promptShown = true;
    const el = document.getElementById('descend-prompt')!;
    // Sealed: the same card, but it is telling you what to kill rather than
    // asking whether you are ready. E is refused while this is up (see the
    // keydown handler), so the prompt cannot lie about being actionable.
    const sealer = this.sealingCarrier;
    el.classList.toggle('sealed', !!sealer);
    const keys = el.querySelector('.dp-keys') as HTMLElement;
    if (sealer) {
      (el.querySelector('.dp-title') as HTMLElement).innerHTML =
        `THE WAY DOWN IS <span class="dp-target">SEALED</span>`;
      (el.querySelector('.dp-warn') as HTMLElement).textContent =
        `${sealer.title} is holding the throat shut.`;
      (el.querySelector('.dp-rec') as HTMLElement).textContent =
        'Break it, and the seal breaks with it.';
      (el.querySelector('.dp-carrier') as HTMLElement)?.classList.add('hidden');
      keys.innerHTML = '<b>Q</b> back off';
      el.classList.remove('hidden');
      return;
    }
    keys.innerHTML = '<b>E</b> descend &nbsp;·&nbsp; <b>Q</b> stay';
    (el.querySelector('.dp-title') as HTMLElement).innerHTML =
      `DESCEND TO <span class="dp-target">THE DEEP</span>?`;
    (el.querySelector('.dp-warn') as HTMLElement).textContent = 'There is no return.';
    (el.querySelector('.dp-rec') as HTMLElement).innerHTML =
      'Recommended Dominance: <span class="dp-dom">Hunter</span>';
    (el.querySelector('.dp-target') as HTMLElement).textContent = info.targetName;
    (el.querySelector('.dp-dom') as HTMLElement).textContent = info.recommendedDominance;
    // Descent should feel earned. If the zone's Carrier is still broadcasting,
    // say so plainly — you are leaving the only Connection relief behind you,
    // and there is no way back to it.
    const note = el.querySelector('.dp-carrier') as HTMLElement | null;
    if (note) {
      const pending = this.livingCarriers;
      note.classList.toggle('hidden', pending === 0);
      if (pending > 0) {
        note.textContent =
          pending === 1
            ? '1 Signal Carrier here is still broadcasting — leave it alive and its pull follows you down for the rest of the run. There is no return.'
            : `${pending} Signal Carriers here are still broadcasting — any you leave alive keep pulling on you for the rest of the run. There is no return.`;
      }
    }
    el.classList.remove('hidden');
  }

  private hideDescentPrompt(): void {
    this.promptShown = false;
    document.getElementById('descend-prompt')!.classList.add('hidden');
  }

  private cancelDescent(): void {
    this.hideDescentPrompt();
    this.promptDismissed = true; // don't re-show until the player leaves the trigger
    this.repelling = true; // declining actively pushes the fish back onto the shelf
  }

  private async doDescend(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    this.cinematic?.cancel(); // don't carry a cutaway across a zone change
    // Any carrier you leave ALIVE here follows you as permanent pressure — you can
    // never come back to kill it. Banked before the zone (and its carriers) swap.
    this.carriedOverCarriers += this.livingCarriers;
    this.hideDescentPrompt();

    const transEl = document.getElementById('transition')!;
    const textEl = document.getElementById('transition-text')!;
    const info = this.zones.current.getDescentInfo();
    textEl.textContent = `Descending to ${info?.targetName ?? 'the deep'}…`;
    transEl.classList.add('show');
    await wait(800);

    const before = this.zones.snapshot();

    // Dispose the old zone before building the new → lower peak memory.
    this.zones.disposeCurrent();
    const nextDepth = this.runState.data.depth + 1;
    const next = this.zones.createZone(nextDepth, this.quality.particleScale);
    this.zones.promote(next);
    this.runState.descend();
    this.runState.save();

    // Rebind the persistent player rig to the new zone.
    next.getSpawn(SPAWN);
    this.bindFlora(next);
    this.solids.bind(next.colliders, next.boxColliders);
    this.playerCamera.bindZone(next.terrain, this.solids);
    this.controller.bindZone(next.terrain, this.solids, next.getBounds(), SPAWN, next);
    // Stream in the zone's modelled dressing. Awaited during the transition
    // curtain so the player never sees rocks and plants popping into place.
    await next.dressing?.(this.loader, this.quality.dressingScale);
    this.bindEcosystem(next);
    this.ecosystem.armSpawnSafe(SPAWN.x, SPAWN.z, 30);
    // A fresh zone gets a fresh set of objectives.
    this.carrierSeen = false;
    this.fieldKills = 0;
    await this.buildCarriers(next);
    this.updateZoneAmbient();
    this.spawnGrace = 3.0; // brief peace after arriving in the new zone
    this.updateZoneTag();

    // Draw one (still-dark) frame of the new zone so it is ready to reveal.
    next.update(0.016, this.playerCamera.camera, this.renderer);
    this.playerCamera.update(0.016, this.controller.pos, this.controller.vel, 0);
    this.fx.render(0.016, 0);

    const after = this.zones.snapshot();
    console.log('[404hz] descent complete', {
      depth: this.runState.data.depth,
      geometries: `${before.geometries} → ${after.geometries}`,
      textures: `${before.textures} → ${after.textures}`,
      programs: `${before.programs} → ${after.programs}`,
      heapMB: before.heapMB !== null && after.heapMB !== null ? `${before.heapMB} → ${after.heapMB}` : 'n/a',
    });

    await wait(450);
    transEl.classList.remove('show');
    await wait(650);
    this.transitioning = false;
    if (!this.input.pointerLocked && this.started) {
      document.getElementById('resume-chip')!.classList.remove('hidden');
    }
  }

  private updateZoneTag(): void {
    const el = document.getElementById('zone-tag');
    if (el) el.textContent = `DEPTH ${this.runState.data.depth} · ${this.zones.current.displayName}`;
  }

  /** Automated 5× transition memory test (call from console: __game.runTransitionTest()). */
  async runTransitionTest(n = 5): Promise<void> {
    const base = this.zones.snapshot();
    console.log('[404hz][test] baseline', base);
    for (let i = 0; i < n; i++) {
      await this.doDescend();
      await wait(250);
      const s = this.zones.snapshot();
      console.log(`[404hz][test] after descent ${i + 1}`, s, {
        dGeoVsBase: s.geometries - base.geometries,
        dTexVsBase: s.textures - base.textures,
      });
    }
    console.log('[404hz][test] done. Geometry/texture counts should be flat across descents.');
  }

  private hintTimer = 0;

  private showHint(text: string, seconds: number): void {
    const el = document.getElementById('hint')!;
    // Cancel any pending hide first: with onboarding beats, ability toasts, and
    // objective callbacks all writing here, a stale timer from an earlier hint
    // would otherwise blank the current one part-way through.
    if (this.hintTimer) window.clearTimeout(this.hintTimer);
    el.textContent = text;
    el.classList.remove('hidden');
    this.hintTimer = window.setTimeout(() => {
      el.classList.add('hidden');
      this.hintTimer = 0;
    }, seconds * 1000);
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.playerCamera?.resize(window.innerWidth / window.innerHeight);
    this.fx?.resize(this.renderer);
  }
}
