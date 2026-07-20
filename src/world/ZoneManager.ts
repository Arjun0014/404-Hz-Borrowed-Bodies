import type { Scene, WebGLRenderer } from 'three';
import type { Zone, ZoneMaps } from './types';
import { ShallowVeil } from './ShallowVeil';
import { DrownedGarden } from './DrownedGarden';
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
    private readonly maps: ZoneMaps,
  ) {}

  /**
   * Build the zone for a given depth index (0 = Shallow Veil, 1 = Drowned
   * Garden). Each zone is handed the rock set that suits it: sunlit sand for the
   * shelf, damp lichen-covered stone for the cave.
   */
  createZone(depth: number, particleScale: number): Zone {
    let zone: Zone;
    let rock;
    if (depth === 0) {
      zone = new ShallowVeil(this.scene);
      rock = this.maps.seabed;
    } else if (depth === 1) {
      zone = new DrownedGarden(this.scene);
      rock = this.maps.lichen;
    } else {
      zone = new BlockoutZone(this.scene, depth);
      rock = this.maps.seabed;
    }
    zone.build(this.renderer, particleScale, rock);
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
