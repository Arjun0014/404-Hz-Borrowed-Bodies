import {
  ACESFilmicToneMapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { TerrainMaps } from '../world/types';
import seabedDiffUrl from '../../assets/textures/coral_fort_wall_02/textures/coral_fort_wall_02_diff_1k.jpg';
import seabedNorUrl from '../../assets/textures/coral_fort_wall_02/textures/coral_fort_wall_02_nor_gl_1k.jpg';
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
import { DARTFISH } from '../data/species';
import { Ecosystem } from '../systems/Ecosystem';
import { Flora } from '../world/Flora';
import { PlayerCombat } from '../player/PlayerCombat';
import { PlayerGrowth } from '../player/PlayerGrowth';
import { PlayerPossession } from '../player/PlayerPossession';
import { PlayerResonance } from '../player/PlayerResonance';
import { Dominance } from '../systems/Dominance';
import { Sfx, AMBIENT } from './Sfx';
import { DamageBars } from '../ui/DamageBars';
import { SHALLOW_VEIL_POP } from '../data/creatures';
import type { Zone } from '../world/types';
import type { Creature } from '../entities/Creature';

const TAIL_POS = new Vector3();
const SPAWN = new Vector3();
const LOCK_AIM = new Vector3();
const LOCK_TO = new Vector3();
const LOCK_PROJ = new Vector3();

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
  private ecosystem!: Ecosystem;
  private flora!: Flora;
  private combat!: PlayerCombat;
  private growth!: PlayerGrowth;
  private possession!: PlayerPossession;
  private resonance!: PlayerResonance;
  private dominance!: Dominance;
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

  async start(): Promise<void> {
    const loadingEl = document.getElementById('loading')!;
    const fillEl = document.getElementById('loading-fill')!;
    this.loader.onProgress = (l, t) => {
      fillEl.style.width = `${Math.round((l / Math.max(t, 1)) * 100)}%`;
    };

    // Seabed texture set (Poly Haven coral_fort_wall_02, CC0). Non-fatal if it
    // fails to load: zones fall back to their vertex-colour palettes.
    let maps: TerrainMaps | undefined;
    try {
      const texLoader = new TextureLoader();
      const [map, normalMap] = await Promise.all([
        texLoader.loadAsync(seabedDiffUrl),
        texLoader.loadAsync(seabedNorUrl),
      ]);
      map.colorSpace = SRGBColorSpace;
      const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      map.anisotropy = aniso;
      normalMap.anisotropy = aniso;
      maps = { map, normalMap };
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
    );

    this.bubbles = new Bubbles(this.scene);
    this.bubbles.setPixelRatio(this.renderer.getPixelRatio());
    this.fx = new UnderwaterFx(this.renderer, this.scene, this.playerCamera.camera);

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
    };
    this.resonance.onFull = () => this.showResonanceReady();
    this.growth.onStageUp = (name) => this.showStageToast(name);

    // Dominance: defeating creatures builds a persistent run-level rank.
    this.dominance = new Dominance(this.runState);
    this.ecosystem.onPlayerKill = (c) => this.dominance.recordKill(c.species);
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
    this.flora.update(dt);
    this.sfx.setSwim(dead ? 0 : this.controller.speed01, this.controller.dashOutput > 0.25);
    if (!this.transitioning) {
      this.ecosystem.update(dt, this.controller.pos, this.fish.length, combatActive);
      if (this.started && !possessing) this.combat.update(dt);
      this.updateCombatHud();
      this.updateGrowthHud();
      this.updateResonanceHud();
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

    this.fx.render(dt, speed);
    this.debug.update(
      dt,
      this.renderer,
      this.loop,
      this.quality,
      this.controller.pos,
      zone.particleCount,
      this.ecosystem?.count ?? 0,
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
    el.classList.remove('dom', 'possess', 'resonance');
    el.textContent = this.growth.atCeiling ? `MAX GROWTH · ${name}` : `Grew · ${name}`;
    el.classList.remove('hidden');
    void el.offsetWidth; // restart the pop animation
    this.stageToastUntil = performance.now() + 2400;
  }

  // ---- resonance HUD (possession charge) ----------------------------------

  private resonanceGaugeEl: HTMLElement | null = null;
  private resonanceRingEl: HTMLElement | null = null;

  private updateResonanceHud(): void {
    if (!this.resonance || !this.started) return;
    this.resonanceGaugeEl ||= document.getElementById('resonance-gauge');
    this.resonanceRingEl ||= this.resonanceGaugeEl?.querySelector('.rg-ring') ?? null;
    const full = this.resonance.isFull;
    if (this.resonanceRingEl) {
      this.resonanceRingEl.style.setProperty('--pct', String(Math.round(this.resonance.value01 * 100)));
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
    el.classList.remove('dom', 'possess');
    el.classList.add('resonance');
    el.textContent = 'RESONANCE FULL · possession ready';
    el.classList.remove('hidden');
    void el.offsetWidth;
    this.stageToastUntil = performance.now() + 2200;
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
    el.classList.remove('possess', 'resonance');
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
  private possessTextEl: HTMLElement | null = null;
  private possessFillEl: HTMLElement | null = null;

  private updatePossessHud(): void {
    this.possessPromptEl ||= document.getElementById('possess-prompt');
    if (!this.possessPromptEl || !this.possession) return;
    this.possessNameEl ||= this.possessPromptEl.querySelector('.pp-name');
    this.possessTextEl ||= this.possessPromptEl.querySelector('.pp-text');
    this.possessFillEl ||= this.possessPromptEl.querySelector('.pp-channel-fill');

    const channeling = this.possession.possessing;
    const chTarget = this.possession.channelTarget;
    const best = !channeling && this.started ? this.possession.bestTarget : null;

    if (channeling && chTarget) {
      if (this.possessNameEl) this.possessNameEl.textContent = chTarget.species.displayName;
      if (this.possessTextEl) this.possessTextEl.textContent = 'POSSESSING';
      if (this.possessFillEl) this.possessFillEl.style.width = `${this.possession.channel01 * 100}%`;
      this.possessPromptEl.classList.add('channeling');
      this.possessPromptEl.classList.remove('hidden');
    } else if (best) {
      if (this.possessNameEl) this.possessNameEl.textContent = best.species.displayName;
      if (this.possessTextEl) this.possessTextEl.textContent = 'HOLD TO POSSESS';
      if (this.possessFillEl) this.possessFillEl.style.width = '0%';
      this.possessPromptEl.classList.remove('channeling');
      this.possessPromptEl.classList.remove('hidden');
    } else {
      this.possessPromptEl.classList.add('hidden');
      this.possessPromptEl.classList.remove('channeling');
    }
  }

  /** A takeover completed: adopt the new host, flash, toast, and persist it. */
  private onPossessed(name: string, speciesId: string): void {
    this.runState.data.hostSpeciesId = speciesId;
    this.runState.save();
    this.spawnGrace = 2.5; // a beat of peace to settle into the new body

    const flash = document.getElementById('possess-flash');
    if (flash) {
      flash.classList.remove('flash');
      void flash.offsetWidth;
      flash.classList.add('flash');
    }
    document.getElementById('possess-prompt')?.classList.add('hidden');
    document.getElementById('possess-prompt')?.classList.remove('channeling');

    const el = document.getElementById('stage-toast')!;
    el.classList.remove('dom', 'resonance');
    el.classList.add('possess');
    el.textContent = `Possessed · ${name}`;
    el.classList.remove('hidden');
    void el.offsetWidth;
    this.stageToastUntil = performance.now() + 2600;
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
    document.exitPointerLock?.();
    this.possession?.reset();
    this.lockedCreature = null;
    this.playerCamera?.setLockTarget(null);
    this.damageBars.hideAll();
    document.getElementById('lock-reticle')?.classList.add('hidden');
    document.getElementById('possess-prompt')?.classList.add('hidden');
    document.getElementById('death-screen')!.classList.remove('hidden');
    document.getElementById('resume-chip')!.classList.add('hidden');
  }

  /** Scatter the seabed forest for a zone (none when the zone has no area). */
  private bindFlora(zone: Zone): void {
    const area = zone.getPopulationArea();
    if (area) this.flora.bindZone(zone.terrain, area, zone.colliders);
    else this.flora.unbind();
  }

  /** Populate the ecosystem for a zone (empty when the zone has no area). */
  private bindEcosystem(zone: Zone): void {
    const area = zone.getPopulationArea();
    this.ecosystem.bindZone({
      terrain: zone.terrain,
      colliders: zone.colliders,
      bounds: zone.getBounds(),
      area,
      population: area ? SHALLOW_VEIL_POP : [],
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
    this.controller.bindZone(next.terrain, next.colliders, next.getBounds(), SPAWN);
    this.bindEcosystem(next);
    this.ecosystem.armSpawnSafe(SPAWN.x, SPAWN.z, 30);
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

  private showHint(text: string, seconds: number): void {
    const el = document.getElementById('hint')!;
    el.textContent = text;
    el.classList.remove('hidden');
    window.setTimeout(() => el.classList.add('hidden'), seconds * 1000);
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.playerCamera?.resize(window.innerWidth / window.innerHeight);
    this.fx?.resize(this.renderer);
  }
}
