import clownFishUrl from '../../assets/clown_fish_compressed.glb?url';
import tunaFishUrl from '../../assets/tuna_fish_compressed.glb?url';
import type { CreatureSpecies } from './creatures';
import { PLAYER_HP_MULT } from './growth';

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

/**
 * How a host grows as it feeds (Phase 5+). The size range itself is universal
 * (min → GROWTH_MAX_LENGTH× longer, see growth.ts); this only carries per-host
 * toughness, how much biomass the full grind costs, and named stages.
 */
export interface GrowthDef {
  /** Max health at MINIMUM size. HP scales up with size (growth.ts healthAt). */
  baseHealth: number;
  /** Total biomass to grow from minimum size to the species ceiling. */
  biomassToCeiling: number;
  /** Named stages for feedback, as fractions of full growth (ascending). */
  stages: { at: number; name: string }[];
}

export interface SpeciesDef {
  id: string;
  displayName: string;
  modelUrl: string;
  /** MINIMUM body length in meters (the un-grown size; model auto-scaled to this). */
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
  displayName: 'Clownfish',
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
    // distanceFactor is now a sqrt(length) coefficient (see PlayerCamera).
    distanceFactor: 3.0,
    minDistance: 1.6,
    heightFactor: 1.5,
    baseFov: 58,
  },
  growth: {
    // The player host is hardier than a wild clownfish (20 HP × PLAYER_HP_MULT).
    baseHealth: 100,
    // A real grind on small prey; much faster if you risk biting bigger fish,
    // whose chunks are worth far more (see Ecosystem BITE_CHUNK/FINISH_BONUS).
    biomassToCeiling: 70,
    stages: [
      { at: 0, name: 'Fry' },
      { at: 0.25, name: 'Juvenile' },
      { at: 0.55, name: 'Adult' },
      { at: 0.85, name: 'Alpha' },
    ],
  },
};

/**
 * Registered for later phases. Kept in sync with the new GrowthDef shape.
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
    baseHealth: 200,
    biomassToCeiling: 120,
    stages: [
      { at: 0, name: 'Young' },
      { at: 0.3, name: 'Adult' },
      { at: 0.7, name: 'Bull' },
    ],
  },
};

/** Generic size stages for a possessed wild host (no authored stage names). */
const HOST_STAGES = [
  { at: 0, name: 'Juvenile' },
  { at: 0.35, name: 'Adult' },
  { at: 0.75, name: 'Prime' },
];

/**
 * Build a playable host profile from any ecosystem creature, so ANY fish can be
 * possessed (Phase 7). Movement comes straight from the creature (a barracuda
 * host is fast, a grouper heavy); camera and growth are derived from its size.
 */
export function hostProfileFromCreature(sp: CreatureSpecies): SpeciesDef {
  const base = sp.baseLength;
  return {
    id: sp.id,
    displayName: sp.displayName,
    modelUrl: sp.modelUrl,
    baseLength: base,
    flipForward: sp.flipForward,
    movement: {
      maxSpeed: sp.maxSpeed,
      dashMultiplier: 1.7,
      accel: sp.accel,
      drag: sp.drag,
      turnRate: sp.turnRate,
      verticalFactor: sp.role === 'crab' ? 0.5 : 0.75,
    },
    camera: {
      // sqrt(length) coefficient (see PlayerCamera.computeBaseDist).
      distanceFactor: 3.1,
      minDistance: Math.max(1.6, base * 1.1),
      heightFactor: 1.5,
      baseFov: 60,
    },
    growth: {
      baseHealth: sp.baseHealth * PLAYER_HP_MULT,
      biomassToCeiling: 40 + base * 45,
      stages: HOST_STAGES,
    },
  };
}
