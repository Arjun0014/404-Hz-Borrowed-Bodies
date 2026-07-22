import type { Scene, WebGLRenderer } from 'three';
import type { Zone, ZoneMaps } from './types';
import { ShallowVeil } from './ShallowVeil';
import { DrownedGarden } from './DrownedGarden';
import { FallenKingdom } from './FallenKingdom';
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
    let ground;
    let trim;
    if (depth === 0) {
      zone = new ShallowVeil(this.scene);
      ground = this.maps.seabed;
    } else if (depth === 1) {
      zone = new DrownedGarden(this.scene);
      ground = this.maps.lichen;
    } else if (depth === 2) {
      // The Fallen Kingdom is the one zone built of two stones: hard fractured
      // rock for the cavern, coursed slate masonry for the city inside it.
      zone = new FallenKingdom(this.scene);
      ground = this.maps.rock ?? this.maps.lichen;
      trim = this.maps.castle ?? this.maps.lichen;
    } else {
      zone = new BlockoutZone(this.scene, depth);
      ground = this.maps.seabed;
    }
    zone.build(this.renderer, particleScale, ground, trim);
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
