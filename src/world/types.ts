import type { PerspectiveCamera, Texture, Vector3, WebGLRenderer } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { PopEntry } from '../data/creatures';
import type { BoxCollider } from './Solids';

/**
 * The slice of AssetLoader a zone needs for its dressing pass. Declared
 * structurally so world code does not have to import the core loader.
 */
export interface AssetLoaderLike {
  loadGLB(url: string): Promise<GLTF>;
}

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
  /** Combined AO(R)/Roughness(G)/Metalness(B); assigned to all three slots. */
  armMap?: Texture;
  /** Height map driving subtle, low-frequency vertex displacement. */
  displacementMap?: Texture;
}

/**
 * The PBR sets available to zones. Each zone picks the one that suits its rock:
 * the Shallow Veil's sunlit sand, the cave's damp lichen-covered stone, or the
 * Fallen Kingdom's pair — hard fractured `rock` for the cavern it sits in, and
 * coursed `castle` masonry for everything in it that was built.
 */
export interface ZoneMaps {
  seabed?: TerrainMaps;
  lichen?: TerrainMaps;
  rock?: TerrainMaps;
  castle?: TerrainMaps;
}

/** Anything the movement/camera code can query for ground height. */
export interface TerrainLike {
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  /**
   * World-space height of the rock ROOF at (x, z), for zones that have one.
   * Open-water zones omit it and are capped by `ZoneBounds.ceilingY` alone; an
   * enclosed zone (the Drowned Garden cave) implements it so the player, the
   * camera, and creatures are all held under the same vault they can see.
   */
  ceilingAt?(x: number, z: number): number;
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
  /**
   * Rotated-box solids, for zones whose obstacles are walls rather than rocks.
   * Optional: a zone made of boulders and coral has no use for them and omits
   * it. See {@link BoxCollider} for why a wall cannot be a cylinder.
   */
  readonly boxColliders?: BoxCollider[];
  readonly particleCount: number;

  /**
   * `baseMaps` dresses the zone's terrain shell. `trimMaps` is an optional
   * SECOND set for zones whose built content is made of a different material
   * than the ground it stands on — the Fallen Kingdom's masonry against its
   * cavern rock. Zones with one kind of stone ignore it.
   */
  build(
    renderer: WebGLRenderer,
    particleScale: number,
    baseMaps?: TerrainMaps,
    trimMaps?: TerrainMaps,
  ): void;
  /**
   * Optional second phase: load and place this zone's own .glb dressing (rock
   * packs, hero props, vegetation). Kept separate from `build` so the synchronous
   * shape of the world — terrain, collision, spawn — is ready immediately and the
   * models stream in after, rather than forcing every zone's build to be async.
   * Called once, right after `build`.
   */
  dressing?(loader: AssetLoaderLike, densityScale?: number): Promise<void>;
  update(dt: number, camera: PerspectiveCamera, renderer: WebGLRenderer): void;
  setParticleScale(scale: number): void;

  getSpawn(out: Vector3): Vector3;
  getBounds(): ZoneBounds;
  /** Where the ecosystem may spawn creatures; null = this zone has none. */
  getPopulationArea(): PopulationArea | null;
  /** Which creatures live here. Each zone declares its own species mix. */
  getPopulation(): PopEntry[];
  /**
   * Where the SHARED reef-flora scatter may plant, or null if this zone dresses
   * itself. The Shallow Veil uses the shared set; the Drowned Garden supplies
   * its own cave vegetation and must return null — left on, the shelf's reef
   * plants were scattering through the cave to the tune of 2.96M triangles,
   * nearly half the frame, on top of being completely wrong for the setting.
   */
  getFloraArea(): PopulationArea | null;
  /**
   * Where this zone's Signal Carriers stand (each with seabed height included).
   * A zone may field several — clearing them all is the per-level objective — or
   * none (return an empty array). Each landmark should sit somewhere worth
   * swimming to. Returns fresh Vector3s (not a shared scratch), one per carrier.
   */
  getCarrierAnchors(): Vector3[];
  /**
   * Per-zone Signal Carrier tuning: body `size` in metres and `health`. Smaller,
   * lower-health relays in the starting sea; larger, tougher ones in the deep.
   * Optional — a default is used when a zone with carriers doesn't specify.
   */
  getCarrierConfig?(): { size: number; health: number };

  /** Null when this zone has no further descent (dead-end / final). */
  getDescentInfo(): DescentInfo | null;
  /**
   * Optional ambient water movement at a point, in m/s, written into `out`.
   * Added to the player's velocity each frame, so it reads as a current pushing
   * the host around rather than as a change to how the host swims. Zones without
   * currents omit it.
   */
  currentAt?(pos: Vector3, out: Vector3): Vector3;

  /**
   * Optional one-shot velocity applied when the player spawns into this zone —
   * an arrival shove. Preferred over a standing current for "you are carried
   * in", because a single impulse never fights the player's own input.
   */
  getSpawnImpulse?(out: Vector3): Vector3;

  /** True while the player is out in the deep / descent region. */
  isInDescentZone(pos: Vector3): boolean;
  /**
   * Push a declining player back out of the descent region toward safety.
   * Returns true once they are safely back (so the caller can stop pushing).
   */
  repelFromDescent(pos: Vector3, vel: Vector3, dt: number): boolean;

  dispose(): void;
}
