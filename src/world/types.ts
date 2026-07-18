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

/** Axis-aligned playable box; the swim controller pushes back outside it. */
export interface ZoneBounds {
  ceilingY: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  softMargin: number;
}

/** Copy shown on the descent confirmation prompt. */
export interface DescentInfo {
  targetName: string;
  recommendedDominance: string;
}

/** Seabed rectangle where the ecosystem may spawn creatures. */
export interface PopulationArea {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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
  /** Where the ecosystem may spawn creatures; null = this zone has none. */
  getPopulationArea(): PopulationArea | null;

  /** Null when this zone has no further descent (dead-end / final). */
  getDescentInfo(): DescentInfo | null;
  /** True while the player is out in the deep / descent region. */
  isInDescentZone(pos: Vector3): boolean;
  /**
   * Push a declining player back out of the descent region toward safety.
   * Returns true once they are safely back (so the caller can stop pushing).
   */
  repelFromDescent(pos: Vector3, vel: Vector3, dt: number): boolean;

  dispose(): void;
}
