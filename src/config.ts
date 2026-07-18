// World + tuning constants for the Shallow Veil (Phase 1).
// All distances in meters, angles in radians.

export const WORLD = {
  /** Full width of the zone geometry. */
  size: 600,
  /** Radius the player can comfortably roam; soft current pushes back beyond it. */
  playableRadius: 268,
  /** Hard clamp radius. */
  hardRadius: 290,
  /** Y of the ocean surface plane. */
  surfaceY: 45,
  /** Center of the descent drop-off pit. */
  dropCenter: { x: 225, z: 10 },
  dropRadius: 85,
  /** Soft floor inside the pit for Phase 1 (real descent arrives in Phase 2). */
  pitFloorY: -24,
  /** Player spawn. */
  spawn: { x: -170, z: -55 },
} as const;

/**
 * Steering scheme A: fish thrusts along the full camera aim (incl. pitch).
 * Scheme B: thrust is horizontal-only; vertical movement comes from keys.
 * Kept as a flag for the Phase 1 approval A/B test.
 */
export const STEERING_SCHEME: 'A' | 'B' = 'A';

export const FOG = {
  shallowColor: 0x3d89a6,
  deepColor: 0x0a2433,
  density: 0.0058,
} as const;
