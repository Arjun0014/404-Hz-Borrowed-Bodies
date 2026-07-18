import {
  ACESFilmicToneMapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { TerrainMaps } from '../world/Terrain';
import seabedDiffUrl from '../../assets/textures/coral_fort_wall_02/textures/coral_fort_wall_02_diff_1k.jpg';
import seabedNorUrl from '../../assets/textures/coral_fort_wall_02/textures/coral_fort_wall_02_nor_gl_1k.jpg';
import { Loop } from './Loop';
import { Input } from './Input';
import { AssetLoader } from './AssetLoader';
import { Quality } from './Quality';
import { DebugOverlay } from './DebugOverlay';
import { ShallowVeil } from '../world/ShallowVeil';
import { PlayerFish } from '../entities/PlayerFish';
import { SwimController } from '../player/SwimController';
import { PlayerCamera } from '../player/PlayerCamera';
import { Bubbles } from '../entities/Bubbles';
import { UnderwaterFx } from '../render/UnderwaterFx';
import { DARTFISH } from '../data/species';

const MARKER_POS = new Vector3();
const TAIL_POS = new Vector3();

/** Application shell: renderer, screens, and the Phase 1 play state. */
export class GameApp {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly loop = new Loop();
  private readonly input: Input;
  private readonly quality: Quality;
  private readonly loader: AssetLoader;
  private readonly debug = new DebugOverlay();

  private zone!: ShallowVeil;
  private fish!: PlayerFish;
  private controller!: SwimController;
  private playerCamera!: PlayerCamera;
  private bubbles!: Bubbles;
  private fx!: UnderwaterFx;
  private started = false;
  private hintTimer = 0;

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
        this.zone?.setParticleScale(this.quality.particleScale);
        this.bubbles?.setPixelRatio(this.renderer.getPixelRatio());
        this.fx?.resize(this.renderer);
        this.showHint(`quality: ${this.quality.level}`, 1.6);
      }
    });
  }

  async start(): Promise<void> {
    const loadingEl = document.getElementById('loading')!;
    const fillEl = document.getElementById('loading-fill')!;
    this.loader.onProgress = (l, t) => {
      fillEl.style.width = `${Math.round((l / Math.max(t, 1)) * 100)}%`;
    };

    // Seabed texture set (Poly Haven coral_fort_wall_02, CC0). Non-fatal if
    // it fails to load: the terrain falls back to its vertex-colour palette.
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

    // Build world + player.
    this.zone = new ShallowVeil(this.scene);
    this.zone.build(this.renderer, this.quality.particleScale, maps);

    this.fish = await PlayerFish.create(this.loader, DARTFISH);
    this.scene.add(this.fish.object);

    this.playerCamera = new PlayerCamera(
      this.input,
      this.zone.terrain,
      this.zone.colliders,
      window.innerWidth / window.innerHeight,
    );
    this.playerCamera.setHost(DARTFISH.camera, this.fish.length);
    this.controller = new SwimController(
      this.fish,
      this.input,
      this.playerCamera,
      this.zone.terrain,
      this.zone.colliders,
    );

    this.bubbles = new Bubbles(this.scene);
    this.bubbles.setPixelRatio(this.renderer.getPixelRatio());
    this.fx = new UnderwaterFx(this.renderer, this.scene, this.playerCamera.camera);

    loadingEl.classList.add('hidden');
    const titleEl = document.getElementById('title')!;
    titleEl.classList.remove('hidden');

    const beginPlay = () => {
      titleEl.classList.add('hidden');
      this.input.requestLock();
    };
    titleEl.addEventListener('click', beginPlay);

    const resumeChip = document.getElementById('resume-chip')!;
    this.renderer.domElement.addEventListener('click', () => {
      if (this.started && !this.input.pointerLocked) this.input.requestLock();
    });
    this.input.onPointerLockChange = (locked) => {
      if (locked) {
        this.started = true;
        resumeChip.classList.add('hidden');
      } else if (this.started) {
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
    this.controller.update(dt);
    this.playerCamera.update(dt, this.controller.pos, this.controller.vel, this.controller.speed01);
    this.zone.update(dt, this.playerCamera.camera, this.renderer);

    // Descent-marker proximity hint (placeholder until Phase 2).
    this.zone.getMarkerPosition(MARKER_POS);
    const nearMarker = MARKER_POS.distanceTo(this.controller.pos) < 26;
    if (nearMarker && this.hintTimer <= 0) {
      this.showHint('The drop into the Drowned Garden — descent arrives in Phase 2', 4);
      this.hintTimer = 20;
    }
    this.hintTimer -= dt;

    this.fish.getTailPosition(TAIL_POS);
    this.bubbles.update(dt, this.playerCamera.camera.position, TAIL_POS, this.controller.vel, this.controller.dashOutput);

    this.fx.render(dt, this.controller.speed01);
    this.debug.update(dt, this.renderer, this.loop, this.quality, this.controller.pos, this.zone.particleCount);
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
