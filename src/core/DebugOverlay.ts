import type { WebGLRenderer, Vector3 } from 'three';
import type { Loop } from './Loop';
import type { Quality } from './Quality';
import { WORLD } from '../config';

interface PerfMemory {
  usedJSHeapSize: number;
}

/** On-screen dev stats (F3). Source of the recorded per-phase performance baselines. */
export class DebugOverlay {
  visible = true;

  private readonly el: HTMLDivElement;
  private timer = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'debug-overlay';
    document.body.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  update(
    dt: number,
    renderer: WebGLRenderer,
    loop: Loop,
    quality: Quality,
    playerPos: Vector3,
    particleCount: number,
  ): void {
    this.timer += dt;
    if (this.timer < 0.25 || !this.visible) return;
    this.timer = 0;

    const info = renderer.info;
    const mem = (performance as unknown as { memory?: PerfMemory }).memory;
    const heap = mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : 'n/a';
    const depth = (WORLD.surfaceY - playerPos.y).toFixed(1);

    this.el.textContent =
      `fps        ${loop.fps.toFixed(0)}\n` +
      `tick ms    ${loop.frameMsAvg.toFixed(2)} avg / ${loop.frameMsMax.toFixed(1)} max\n` +
      `draw calls ${info.render.calls}\n` +
      `triangles  ${(info.render.triangles / 1000).toFixed(0)}k\n` +
      `geometries ${info.memory.geometries}  textures ${info.memory.textures}\n` +
      `programs   ${info.programs?.length ?? 0}\n` +
      `js heap    ${heap}\n` +
      `particles  ${particleCount}\n` +
      `quality    ${quality.level}\n` +
      `pos        ${playerPos.x.toFixed(0)}, ${playerPos.y.toFixed(0)}, ${playerPos.z.toFixed(0)}\n` +
      `depth      ${depth} m`;
  }
}
