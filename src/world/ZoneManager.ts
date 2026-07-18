import type { Scene, WebGLRenderer } from 'three';
import type { TerrainMaps, Zone } from './types';
import { ShallowVeil } from './ShallowVeil';
import { BlockoutZone } from './BlockoutZone';

export interface MemorySnapshot {
  geometries: number;
  textures: number;
  programs: number;
  heapMB: number | null;
}

/**
 * Owns the single active zone and the build/dispose lifecycle. Only one zone
 * exists at a time; descent disposes the old before (or after) building the
 * new, and disposal is verified against renderer.info.
 */
export class ZoneManager {
  current!: Zone;

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly baseMaps: TerrainMaps | undefined,
  ) {}

  /** Build the zone for a given depth index (0 = Shallow Veil). */
  createZone(depth: number, particleScale: number): Zone {
    const zone: Zone = depth === 0 ? new ShallowVeil(this.scene) : new BlockoutZone(this.scene, depth);
    zone.build(this.renderer, particleScale, this.baseMaps);
    return zone;
  }

  buildInitial(depth: number, particleScale: number): Zone {
    this.current = this.createZone(depth, particleScale);
    return this.current;
  }

  disposeCurrent(): void {
    this.current.dispose();
  }

  promote(zone: Zone): void {
    this.current = zone;
  }

  snapshot(): MemorySnapshot {
    const info = this.renderer.info;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
  }
}
