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
}

/** Starter host. Uses the user-supplied clownfish asset (final art candidate). */
export const DARTFISH: SpeciesDef = {
  id: 'dartfish',
  displayName: 'Dartfish',
  modelUrl: clownFishUrl,
  baseLength: 0.42,
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
    distanceFactor: 7.5,
    minDistance: 2.4,
    heightFactor: 2.2,
    baseFov: 60,
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
};
