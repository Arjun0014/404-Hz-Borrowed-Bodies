import clownFishUrl from '../../assets/clown_fish_compressed.glb?url';
import tunaFishUrl from '../../assets/tuna_fish_compressed.glb?url';

export interface CameraProfile {
  /** Camera distance as a multiple of body length. */
  distanceFactor: number;
  minDistance: number;
  /** Vertical offset as a multiple of body length. */
  heightFactor: number;
  baseFov: number;
}

export interface MovementDef {
  maxSpeed: number;
  dashMultiplier: number;
  accel: number;
  /** Exponential water drag while coasting. */
  drag: number;
  /** Max turn rate, rad/s. */
  turnRate: number;
  /** How much of full thrust applies vertically (agility up/down). */
  verticalFactor: number;
}

/** How a host species grows as it feeds (Phase 5). */
export interface GrowthDef {
  /** Species growth ceiling in meters — biomass beyond this does nothing. */
  ceilingLength: number;
  /** Total biomass to grow from baseLength to ceilingLength. */
  biomassToCeiling: number;
  /** Max health at minimum size and at the growth ceiling. */
  maxHealthBase: number;
  maxHealthCeiling: number;
  /** Bite damage multiplier at the ceiling (1 at base). */
  biteScaleCeiling: number;
  /** Named stages for feedback, as fractions of full growth (ascending). */
  stages: { at: number; name: string }[];
}

export interface SpeciesDef {
  id: string;
  displayName: string;
  modelUrl: string;
  /** Target body length in meters (model is auto-scaled to this). */
  baseLength: number;
  /** Extra yaw applied after auto axis-alignment if the model faces backwards. */
  flipForward: boolean;
  movement: MovementDef;
  camera: CameraProfile;
  growth: GrowthDef;
}

/** Starter host. Uses the user-supplied clownfish asset (final art candidate). */
export const DARTFISH: SpeciesDef = {
  id: 'dartfish',
  displayName: 'Dartfish',
  modelUrl: clownFishUrl,
  baseLength: 0.5,
  flipForward: false,
  movement: {
    maxSpeed: 6.2,
    dashMultiplier: 1.9,
    accel: 22,
    drag: 1.9,
    turnRate: 3.6,
    verticalFactor: 0.85,
  },
  camera: {
    distanceFactor: 4.2,
    minDistance: 1.6,
    heightFactor: 1.5,
    baseFov: 58,
  },
  growth: {
    ceilingLength: 2.2, // ~4.4× the 0.5 m start — big for a dartfish, still small vs predators
    // A long grind on fry alone (~140 fry); much faster if you risk biting bigger
    // fish, whose chunks are worth far more (see BITE_CHUNK/FINISH_BONUS).
    biomassToCeiling: 60,
    maxHealthBase: 100,
    maxHealthCeiling: 240,
    biteScaleCeiling: 2.4,
    stages: [
      { at: 0, name: 'Fry' },
      { at: 0.25, name: 'Juvenile' },
      { at: 0.55, name: 'Adult' },
      { at: 0.85, name: 'Alpha' },
    ],
  },
};

/**
 * Registered for later phases (ambient neutral in Phase 3, possession target in
 * Phase 7). Not spawned in Phase 1.
 */
export const TUNA: SpeciesDef = {
  id: 'tuna',
  displayName: 'Bluefin',
  modelUrl: tunaFishUrl,
  baseLength: 1.6,
  flipForward: false,
  movement: {
    maxSpeed: 8.5,
    dashMultiplier: 1.7,
    accel: 16,
    drag: 1.4,
    turnRate: 2.2,
    verticalFactor: 0.6,
  },
  camera: {
    distanceFactor: 5.5,
    minDistance: 3.5,
    heightFactor: 1.6,
    baseFov: 62,
  },
  growth: {
    ceilingLength: 3.2,
    biomassToCeiling: 90,
    maxHealthBase: 200,
    maxHealthCeiling: 460,
    biteScaleCeiling: 2.2,
    stages: [
      { at: 0, name: 'Young' },
      { at: 0.3, name: 'Adult' },
      { at: 0.7, name: 'Bull' },
    ],
  },
};
