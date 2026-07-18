// World + tuning constants for the Shallow Veil.
// All distances in meters, angles in radians.

export const WORLD = {
  /** Full width of the zone geometry. */
  size: 620,
  /** Y of the ocean surface plane. */
  surfaceY: 45,

  // Playable box (soft current pushes back outside it). The +X side is the
  // open sea leading into the deep, so maxX sits far out in the dark.
  minX: -250,
  maxX: 250,
  minZ: -195,
  maxZ: 195,
  softMargin: 24,

  /** Cliff lip: the shelf is x < edgeX; terraced steps + open deep beyond. */
  edgeX: 66,
  /** Once the player is past this (out over the deep), offer descent. */
  descentX: 104,

  /** Player spawn, on the shelf, facing +X toward the open edge. */
  spawn: { x: -178, z: -42 },
} as const;

/**
 * Steering scheme A: fish thrusts along the full camera aim (incl. pitch).
 * Scheme B: thrust is horizontal-only; vertical movement comes from keys.
 */
export const STEERING_SCHEME: 'A' | 'B' = 'A';

export const FOG = {
  /** Shelf water — deliberately moody/dark, not a bright pool. */
  shallowColor: 0x1f5165,
  /** Colour once well below the surface / out over the deep. */
  deepColor: 0x071a26,
  /** Near-black of the abyss beyond the cliff — the "very deep dark". */
  abyssColor: 0x02080e,
  /** Base fog; ShallowVeil ramps it much denser out over the deep. */
  density: 0.0075,
} as const;
