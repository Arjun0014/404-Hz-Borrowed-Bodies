import {
  ACESFilmicToneMapping,
  Scene,
  SRGBColorSpace,
  type Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { TerrainMaps, ZoneMaps } from '../world/types';
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
import { DARTFISH } from '../data/species';
import { Ecosystem } from '../systems/Ecosystem';
import { Flora } from '../world/Flora';
import { PlayerCombat } from '../player/PlayerCombat';
import { PlayerGrowth } from '../player/PlayerGrowth';
import { PlayerPossession } from '../player/PlayerPossession';
import { PlayerAbility } from '../player/PlayerAbility';
import { PlayerResonance } from '../player/PlayerResonance';
import { PlayerConnection } from '../player/PlayerConnection';
import { Dominance } from '../systems/Dominance';
import { Sfx, AMBIENT } from './Sfx';
import { DamageBars } from '../ui/DamageBars';
import { SignalCarrier } from '../entities/SignalCarrier';
import { DeadSignalField } from '../systems/DeadSignalField';
import { Score } from '../systems/Score';
import type { CylinderCollider, Zone } from '../world/types';
import type { Creature } from '../entities/Creature';

const TAIL_POS = new Vector3();
const SPAWN = new Vector3();
const LOCK_AIM = new Vector3();
const LOCK_TO = new Vector3();
const LOCK_PROJ = new Vector3();
const CARRIER_ANCHOR = new Vector3();
const BLOOD_DIR = new Vector3();
const CARRIER_PROJ = new Vector3();

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
  /** The zone's Signal Carrier (Phase 12) — null once destroyed or in a zone without one. */
  private carrier: SignalCarrier | null = null;
  /** The Dead Signal Field its death left behind (Phase 13). */
  private field: DeadSignalField | null = null;
  /** One Carrier per zone per run: never rebuild one the player already killed. */
  private carrierDownThisZone = false;
  /** Kills made inside the field this run — feeds the anti-farm yield decay. */
  private fieldKills = 0;
  /** True once the shared reef flora has been disposed (one-way, on descent). */
  private floraDisposed = false;
  /** The Carrier's solid obstacle, pushed into the zone's collider array. */
  private carrierCollider: CylinderCollider | null = null;
  private readonly sfx = new Sfx();
  private readonly damageBars = new DamageBars();
  /** Seconds of post-spawn peace before predators may hunt the host. */
  private spawnGrace = 0;
  /** Current hold-RMB lock-on target (null when not locked on). */
  private lockedCreature: Creature | null = null;

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
          void this.doDescend();
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
    const [seabed, lichen] = await Promise.all([
      this.loadMapSet([seabedDiffKtxUrl, seabedNorKtxUrl, seabedArmKtxUrl, seabedDispKtxUrl]),
      this.loadMapSet([lichenDiffKtxUrl, lichenNorKtxUrl, lichenArmKtxUrl, lichenDispKtxUrl]),
    ]);
    return { seabed, lichen };
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
    const saved = RunState.load();
    const resuming = !!saved && saved.data.depth > 0;
    this.runState = resuming ? (saved as RunState) : new RunState();
    this.runState.save();

    // Build the current zone + player rig.
    this.zones = new ZoneManager(this.scene, this.renderer, maps);
    const zone = this.zones.buildInitial(this.runState.data.depth, this.quality.particleScale);

    this.fish = await PlayerFish.create(this.loader, DARTFISH);
    this.scene.add(this.fish.object);

    this.playerCamera = new PlayerCamera(
      this.input,
      zone.terrain,
      zone.colliders,
      window.innerWidth / window.innerHeight,
    );
    this.playerCamera.setHost(DARTFISH.camera, this.fish.length);
    this.controller = new SwimController(
      this.fish,
      this.input,
      this.playerCamera,
      zone.terrain,
      zone.colliders,
      zone.getBounds(),
      zone.getSpawn(SPAWN),
      zone,
    );
    // The starting zone's modelled dressing, loaded before the title screen
    // clears so the world is complete the first time it is seen.
    await zone.dressing?.(this.loader);

    this.bubbles = new Bubbles(this.scene);
    this.bubbles.setPixelRatio(this.renderer.getPixelRatio());
    this.fx = new UnderwaterFx(this.renderer, this.scene, this.playerCamera.camera);
    // Blood, gore, and the clouds they leave. Lives on the scene, not the zone,
    // so it survives descents and keeps running through a zone swap.
    this.blood = new BloodFx(this.scene);

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
    this.ecosystem.onPlayerKill = (c) => this.recordKill(c);
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

    // Signal Carrier: the zone's objective. Built last, so its garrison can be
    // seeded from an already-populated ecosystem.
    await this.buildCarrier(zone);

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
    // Lock-on first, so possession can act on the currently targeted creature.
    this.updateLockOn();
    if (!this.transitioning && this.started && !dead) {
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
    // post-spawn grace — no ambushes on the loading screen, mid-possession, or the
    // instant you dive.
    const combatActive =
      this.started && !dead && !this.transitioning && !possessing && this.spawnGrace <= 0;

    const speed = this.transitioning || dead ? 0 : this.controller.speed01;
    this.playerCamera.update(dt, this.controller.pos, this.controller.vel, speed);
    zone.update(dt, this.playerCamera.camera, this.renderer);
    if (!this.floraDisposed) this.flora.update(dt);
    this.sfx.setSwim(dead ? 0 : this.controller.speed01, this.controller.dashOutput > 0.25);
    if (!this.transitioning) {
      this.ecosystem.update(dt, this.controller.pos, this.fish.length, combatActive);
      if (this.started && !possessing) this.combat.update(dt);
      if (this.started && !possessing && !dead) {
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
    this.fx.render(dt, speed);
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
      // Per-host signal cost: a shark draws the entity far faster than a quiet crab.
      // Standing in the Carrier's aura multiplies it again — that is what makes
      // approaching the relay a decision rather than a formality.
      const connMult =
        this.fish.species.connectionMult *
        (this.carrier?.alive ? this.carrier.connectionMultAt(this.controller.pos) : 1);
      this.connection.update(dt, this.fish.length, connMult);
      // Resonance also trickles up over time, paced to the Connection rise, so the
      // means to escape builds alongside the pressure. Eating is still far faster.
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
    const c = this.carrier;
    if (c?.alive && beat('carrier',
      this.controller.pos.distanceTo(c.pos) < CARRIER_TRACK_RANGE,
      'Something is broadcasting across the shelf. Follow the pulse — killing it is the only lasting relief.',
      6.5)) return;

    // Only worth saying once they are genuinely in trouble.
    beat('critical', this.connection.value01 > 0.85,
      'It almost has you. Take a fresh body NOW, or find the Carrier.', 6);
  }

  // ---- Signal Carrier HUD --------------------------------------------------

  private carrierHudEl: HTMLElement | null = null;
  private carrierFillEl: HTMLElement | null = null;
  private carrierStageEl: HTMLElement | null = null;
  private carrierNodesEl: HTMLElement | null = null;
  private carrierMarkEl: HTMLElement | null = null;
  private carrierPct = -1;
  private carrierNodeText = '';
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

    const c = this.carrier;
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
      this.carrierFillEl ||= document.getElementById('carrier-fill');
      this.carrierStageEl ||= document.getElementById('carrier-stage');
      this.carrierNodesEl ||= document.getElementById('carrier-nodes');
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
    this.carrierMarkEl.textContent = `◈ CARRIER ${Math.round(dist)}m`;
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

  /** Acquire/hold a lock-on target while RMB is held and feed it to the camera. */
  private updateLockOn(): void {
    const active =
      this.input.rmbDown && this.started && !(this.combat?.dead ?? false) && !this.transitioning;
    if (!active) {
      this.lockedCreature = null;
      this.playerCamera.setLockTarget(null);
      return;
    }
    // Sticky: keep the current target while it lives and stays within reach;
    // otherwise acquire the best creature in view.
    const cur = this.lockedCreature;
    if (!cur || !cur.alive || cur.pos.distanceTo(this.controller.pos) > LOCK_KEEP_RANGE) {
      this.lockedCreature = this.acquireLockTarget();
    }
    this.playerCamera.setLockTarget(this.lockedCreature ? this.lockedCreature.pos : null);
  }

  /** Pick the most on-screen, nearest living creature within the aim cone. */
  private acquireLockTarget(): Creature | null {
    const list = this.ecosystem?.list;
    if (!list) return null;
    this.playerCamera.getAimDir(LOCK_AIM);
    const from = this.controller.pos;
    let best: Creature | null = null;
    let bestScore = -Infinity;
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
    return best;
  }

  /** Position the on-screen lock reticle over the locked target (or hide it). */
  private updateLockReticle(): void {
    this.lockReticleEl ||= document.getElementById('lock-reticle');
    const el = this.lockReticleEl;
    if (!el) return;
    const c = this.lockedCreature;
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

  /** Loop the current zone's background ambience (Shallow Veil vs deeper). */
  private updateZoneAmbient(): void {
    const depth = this.runState.data.depth;
    void this.sfx.playAmbient(depth === 0 ? AMBIENT.shallowVeil : AMBIENT.drownedGarden);
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
    this.possession?.reset();
    this.score?.breakStreak();
    this.lockedCreature = null;
    this.playerCamera?.setLockTarget(null);
    this.damageBars.hideAll();
    this.sfx.setConnectionDrone(0);
    this.sfx.setFieldTone(0);
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
  private async buildCarrier(zone: Zone): Promise<void> {
    this.disposeCarrier();
    if (this.carrierDownThisZone) return;
    const anchor = zone.getCarrierAnchor(CARRIER_ANCHOR);
    if (!anchor) return;

    try {
      this.carrier = await SignalCarrier.create(
        this.loader,
        this.scene,
        anchor,
        zone.getBounds().ceilingY,
      );
    } catch (err) {
      // Non-fatal: the zone is still playable, it just has no objective.
      console.warn('[404hz] signal carrier failed to load', err);
      return;
    }
    this.carrier.onDeath = (pos) => this.onCarrierDeath(pos);
    this.carrier.onNodeDestroyed = (left) => this.onCarrierNode(left);
    this.carrier.onPulse = (prox) => this.sfx.carrierPulse(prox);
    this.ecosystem.carrier = this.carrier;
    this.ecosystem.garrisonCarrier(this.carrier.pos, 6);

    // Make the relay solid. Pushing a collider into the zone's live array gives
    // player, camera, and creature avoidance in one move — they all read the
    // same array instance. It is removed again in disposeCarrier.
    this.carrierCollider = {
      x: this.carrier.pos.x,
      z: this.carrier.pos.z,
      r: this.carrier.radius,
      top: this.carrier.pos.y + this.carrier.radius,
    };
    zone.colliders.push(this.carrierCollider);
  }

  private disposeCarrier(): void {
    if (this.carrierCollider) {
      const cols = this.zones?.current.colliders;
      const i = cols ? cols.indexOf(this.carrierCollider) : -1;
      if (i >= 0) cols!.splice(i, 1);
      this.carrierCollider = null;
    }
    this.carrier?.dispose();
    this.carrier = null;
    this.field?.dispose();
    this.field = null;
    if (this.ecosystem) {
      this.ecosystem.carrier = null;
      this.ecosystem.field = null;
    }
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
    this.carrierDownThisZone = true;
    this.score.carrierKilled();
    this.sfx.carrierDeath();
    this.triggerShake();
    this.ecosystem.alertPrey();

    this.field = new DeadSignalField(this.scene, pos);
    this.ecosystem.field = this.field;
    this.ecosystem.carrier = null;

    const flash = document.getElementById('possess-flash');
    if (flash) {
      flash.classList.remove('flash', 'fail');
      void flash.offsetWidth;
      flash.classList.add('flash');
    }
    this.showToast('THE CARRIER IS DEAD', 'resonance', 3000);
    this.showHint(
      'A DEAD SIGNAL FIELD opens. Inside it the entity cannot hold you — and everything here has turned on everything else.',
      7,
    );
  }

  /** Advance the Carrier + field, and apply everything the field does to the run. */
  private updateObjective(dt: number, dead: boolean): void {
    const pos = this.controller.pos;

    // The corpse keeps updating after death so its collapse flare can play out;
    // it is only disposed on zone change.
    this.carrier?.update(dt, pos);

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

  /** Populate the ecosystem for a zone (empty when the zone has no area). */
  private bindEcosystem(zone: Zone): void {
    const area = zone.getPopulationArea();
    this.ecosystem.bindZone({
      terrain: zone.terrain,
      colliders: zone.colliders,
      bounds: zone.getBounds(),
      area,
      population: area ? zone.getPopulation() : [],
      focus: this.controller.pos,
    });
  }

  // ---- descent flow --------------------------------------------------------

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
    (el.querySelector('.dp-target') as HTMLElement).textContent = info.targetName;
    (el.querySelector('.dp-dom') as HTMLElement).textContent = info.recommendedDominance;
    // Descent should feel earned. If the zone's Carrier is still broadcasting,
    // say so plainly — you are leaving the only Connection relief behind you,
    // and there is no way back to it.
    const note = el.querySelector('.dp-carrier') as HTMLElement | null;
    if (note) {
      const pending = !!this.carrier?.alive;
      note.classList.toggle('hidden', !pending);
      if (pending) note.textContent = 'The Signal Carrier here is still alive. There is no return.';
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
    this.playerCamera.bindZone(next.terrain, next.colliders);
    this.controller.bindZone(next.terrain, next.colliders, next.getBounds(), SPAWN, next);
    // Stream in the zone's modelled dressing. Awaited during the transition
    // curtain so the player never sees rocks and plants popping into place.
    await next.dressing?.(this.loader);
    this.bindEcosystem(next);
    this.ecosystem.armSpawnSafe(SPAWN.x, SPAWN.z, 30);
    // A fresh zone gets a fresh objective — one Carrier each, never a second.
    this.carrierDownThisZone = false;
    this.carrierSeen = false;
    this.fieldKills = 0;
    await this.buildCarrier(next);
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
