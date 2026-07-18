import type { PerspectiveCamera, Texture, Vector3, WebGLRenderer } from 'three';

/** A vertical cylinder obstacle for player + camera collision. */
export interface CylinderCollider {
  x: number;
  z: number;
  r: number;
  top: number;
}

/** Shared seabed texture set (owned by GameApp; zones clone from it). */
export interface TerrainMaps {
  map: Texture;
  normalMap: Texture;
}

/** Anything the movement/camera code can query for ground height. */
export interface TerrainLike {
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
}

/** World clamp limits the swim controller enforces for a zone. */
export interface ZoneBounds {
  ceilingY: number;
  playableRadius: number;
  hardRadius: number;
  centerX: number;
  centerZ: number;
}

/** Volume that, when the player enters it, offers descent. */
export interface DescentTrigger {
  x: number;
  z: number;
  radius: number;
}

/** Copy shown on the descent confirmation prompt. */
export interface DescentInfo {
  targetName: string;
  recommendedDominance: string;
}

/**
 * A self-contained gameplay zone. Owns all zone-scoped GPU resources and can
 * fully dispose them; the player rig (fish, camera, controller) is NOT part of
 * a zone and persists across descents.
 */
export interface Zone {
  readonly displayName: string;
  readonly terrain: TerrainLike;
  readonly colliders: CylinderCollider[];
  readonly particleCount: number;

  build(renderer: WebGLRenderer, particleScale: number, baseMaps?: TerrainMaps): void;
  update(dt: number, camera: PerspectiveCamera, renderer: WebGLRenderer): void;
  setParticleScale(scale: number): void;

  getSpawn(out: Vector3): Vector3;
  getBounds(): ZoneBounds;
  /** Null when this zone has no further descent (dead-end / final). */
  getDescentTrigger(): DescentTrigger | null;
  getDescentInfo(): DescentInfo | null;

  dispose(): void;
}
