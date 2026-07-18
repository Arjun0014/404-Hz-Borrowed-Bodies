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
import { Dominance } from '../systems/Dominance';
import { Sfx, AMBIENT } from './Sfx';
import { DamageBars } from '../ui/DamageBars';
import { SHALLOW_VEIL_POP } from '../data/creatures';
import type { Zone } from '../world/types';

const TAIL_POS = new Vector3();
const SPAWN = new Vector3();

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
  private dominance!: Dominance;
  private readonly sfx = new Sfx();
  private readonly damageBars = new DamageBars();
  /** Seconds of post-spawn peace before predators may hunt the host. */
  private spawnGrace = 0;

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
    this.combat.onFeed = (biomass) => this.growth.feed(biomass);
    this.growth.onStageUp = (name) => this.showStageToast(name);

    // Dominance: defeating creatures builds a persistent run-level rank.
    this.dominance = new Dominance(this.runState);
    this.ecosystem.onPlayerKill = (c) => this.dominance.recordKill(c.species);
    this.dominance.onRankUp = (name) => this.onDominanceRankUp(name);
    this.dominance.onWeakCapped = () =>
      this.showHint('Weak prey no longer raises Dominance — hunt bigger creatures.', 5);

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
      void this.sfx.load();
      this.updateZoneAmbient();
      this.spawnGrace = 3.5; // a calm moment before predators lock on
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
    if (!this.transitioning && this.started && !dead) {
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

    if (this.spawnGrace > 0) this.spawnGrace -= dt;
    // Predators may only hunt/bite the host once it is in control and past the
    // post-spawn grace — no ambushes on the loading screen or the instant you dive.
    const combatActive = this.started && !dead && !this.transitioning && this.spawnGrace <= 0;

    const speed = this.transitioning || dead ? 0 : this.controller.speed01;
    this.playerCamera.update(dt, this.controller.pos, this.controller.vel, speed);
    zone.update(dt, this.playerCamera.camera, this.renderer);
    this.flora.update(dt);
    this.sfx.setSwim(dead ? 0 : this.controller.speed01, this.controller.dashOutput > 0.25);
    if (!this.transitioning) {
      this.ecosystem.update(dt, this.controller.pos, this.fish.length, combatActive);
      if (this.started) this.combat.update(dt);
      this.updateCombatHud();
      this.updateGrowthHud();
      this.updateDominanceHud();
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
    el.classList.remove('dom');
    el.textContent = this.growth.atCeiling ? `MAX GROWTH · ${name}` : `Grew · ${name}`;
    el.classList.remove('hidden');
    void el.offsetWidth; // restart the pop animation
    this.stageToastUntil = performance.now() + 2400;
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

  /** Loop the current zone's background ambience (Shallow Veil vs deeper). */
  private updateZoneAmbient(): void {
    const depth = this.runState.data.depth;
    void this.sfx.playAmbient(depth === 0 ? AMBIENT.shallowVeil : AMBIENT.drownedGarden);
  }

  private onHostDeath(): void {
    document.exitPointerLock?.();
    this.damageBars.hideAll();
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
