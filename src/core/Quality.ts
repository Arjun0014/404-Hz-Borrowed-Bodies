import type { WebGLRenderer } from 'three';

export type QualityLevel = 'high' | 'medium' | 'low';

interface QualityPreset {
  pixelRatioCap: number;
  particleScale: number;
}

const PRESETS: Record<QualityLevel, QualityPreset> = {
  high: { pixelRatioCap: 2, particleScale: 1 },
  medium: { pixelRatioCap: 1.5, particleScale: 0.55 },
  low: { pixelRatioCap: 1, particleScale: 0.3 },
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
