import { type PerspectiveCamera, Vector3 } from 'three';
import type { Creature } from '../entities/Creature';

const MAX_BARS = 14;
const _v = new Vector3();

/**
 * Floating HP bars over recently-damaged creatures. A small DOM pool is
 * projected from world space each frame; only creatures hurt in the last few
 * seconds (hpBarTimer > 0) that are on-screen show a bar, nearest first.
 */
export class DamageBars {
  private readonly container: HTMLElement;
  private readonly bars: { el: HTMLElement; fill: HTMLElement }[] = [];
  private readonly candidates: { c: Creature; sx: number; sy: number; d: number }[] = [];

  constructor() {
    let container = document.getElementById('damage-bars');
    if (!container) {
      container = document.createElement('div');
      container.id = 'damage-bars';
      document.body.appendChild(container);
    }
    this.container = container;
    for (let i = 0; i < MAX_BARS; i++) {
      const el = document.createElement('div');
      el.className = 'dmg-bar';
      const fill = document.createElement('div');
      fill.className = 'dmg-fill';
      el.appendChild(fill);
      el.style.display = 'none';
      this.container.appendChild(el);
      this.bars.push({ el, fill });
    }
  }

  update(camera: PerspectiveCamera, creatures: readonly Creature[], w: number, h: number): void {
    this.candidates.length = 0;
    for (let i = 0; i < creatures.length; i++) {
      const c = creatures[i];
      if (!c.alive || c.hpBarTimer <= 0) continue;
      _v.copy(c.pos);
      _v.y += c.radius + 0.7;
      _v.project(camera);
      if (_v.z > 1 || _v.z < -1) continue; // behind or clipped
      if (_v.x < -1.05 || _v.x > 1.05 || _v.y < -1.05 || _v.y > 1.05) continue;
      this.candidates.push({
        c,
        sx: (_v.x * 0.5 + 0.5) * w,
        sy: (-_v.y * 0.5 + 0.5) * h,
        d: _v.z,
      });
    }
    this.candidates.sort((a, b) => a.d - b.d); // nearest first

    for (let i = 0; i < MAX_BARS; i++) {
      const b = this.bars[i];
      if (i < this.candidates.length) {
        const { c, sx, sy } = this.candidates[i];
        b.el.style.display = 'block';
        b.el.style.left = `${sx}px`;
        b.el.style.top = `${sy}px`;
        b.el.style.opacity = String(Math.min(1, c.hpBarTimer));
        b.fill.style.width = `${Math.max(0, c.health01 * 100)}%`;
      } else if (b.el.style.display !== 'none') {
        b.el.style.display = 'none';
      }
    }
  }

  hideAll(): void {
    for (const b of this.bars) b.el.style.display = 'none';
  }
}
