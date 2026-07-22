import type { WebGLRenderer } from 'three';

export type QualityLevel = 'high' | 'medium' | 'low';

interface QualityPreset {
  pixelRatioCap: number;
  particleScale: number;
  /**
   * How much of a zone's SCATTER to plant — vegetation, crystal, loose rubble.
   * Architecture and terrain are never scaled: losing a wall changes the level,
   * losing a third of the weed changes nothing you can name. This is the lever
   * that actually moves the frame in the Fallen Kingdom, where scatter is over
   * a third of the triangles in view.
   */
  dressingScale: number;
}

const PRESETS: Record<QualityLevel, QualityPreset> = {
  // Cap at 1.5×: rendering at full 2× device pixels quadruples fragment work
  // (scene + every post-process pass) for barely-visible sharpness underwater.
  high: { pixelRatioCap: 1.5, particleScale: 1, dressingScale: 1 },
  medium: { pixelRatioCap: 1.25, particleScale: 0.55, dressingScale: 0.6 },
  low: { pixelRatioCap: 1, particleScale: 0.3, dressingScale: 0.35 },
};

const STORAGE_KEY = '404hz-quality';

/**
 * Phase 1 quality stub: render resolution + particle density.
 * Grows into the full quality system in Phase 21.
 */
export class Quality {
  level: QualityLevel;
  onChange: (q: Quality) => void = () => {};

  constructor(private readonly renderer: WebGLRenderer) {
    const saved = localStorage.getItem(STORAGE_KEY) as QualityLevel | null;
    this.level = saved && saved in PRESETS ? saved : 'high';
    this.apply();
  }

  get particleScale(): number {
    return PRESETS[this.level].particleScale;
  }

  /** Scatter density for zone dressing; see {@link QualityPreset.dressingScale}. */
  get dressingScale(): number {
    return PRESETS[this.level].dressingScale;
  }

  cycle(): void {
    const order: QualityLevel[] = ['high', 'medium', 'low'];
    this.level = order[(order.indexOf(this.level) + 1) % order.length];
    localStorage.setItem(STORAGE_KEY, this.level);
    this.apply();
    this.onChange(this);
  }

  apply(): void {
    const cap = PRESETS[this.level].pixelRatioCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
  }
}
