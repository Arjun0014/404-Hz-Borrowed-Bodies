// Data-driven ecosystem creatures. Each entry maps a compressed .glb to a
// species with a role, size, movement, and AI senses. Adding or retuning a
// creature is a one-line change here — no engine edits.
import fishSchool1Url from '../../assets/fish_school_1.glb?url';
import fishSchool2Url from '../../assets/fish_school_2.glb?url';
import fishSchool3Url from '../../assets/fish_school_3.glb?url';
import randomFish1Url from '../../assets/random_fish_1.glb?url';
import randomFish2Url from '../../assets/random_fish_2.glb?url';
import randomFish3Url from '../../assets/random_fish_3.glb?url';
import randomFish4Url from '../../assets/random_fish_4.glb?url';
import crabUrl from '../../assets/crab.glb?url';
import sharkUrl from '../../assets/shark.glb?url';

/**
 * prey     — schooling fish; flees anything that can eat it.
 * forager  — solitary fish; wanders, nibbles, flees bigger predators.
 * predator — hunts smaller fish when hungry (and flees the apex).
 * crab     — walks the seabed; ambush-jumps passing fish.
 */
export type CreatureRole = 'prey' | 'forager' | 'predator' | 'crab';

export interface CreatureSpecies {
  id: string;
  modelUrl: string;
  /** Typical body length in meters (model auto-scaled to this). */
  baseLength: number;
  /** Per-instance size jitter as a fraction of baseLength (±). */
  sizeVar: number;
  /** Extra 180° yaw if the model faces backwards after auto-alignment. */
  flipForward: boolean;
  /**
   * Explicit alignment yaw (radians) overriding the longest-axis heuristic.
   * Set per model so the head leads the swim direction (fixes "sideways" fish).
   */
  modelYaw?: number;
  role: CreatureRole;
  /** Apex (shark) can eat even other predators. */
  apex?: boolean;

  // ---- movement ----
  maxSpeed: number;
  accel: number;
  drag: number;
  turnRate: number;

  // ---- AI ----
  senseRadius: number;
  schooling: boolean;
  hungerRate: number;

  // ---- rendering ----
  animClip?: RegExp;
  animSpeed: number;
  procedural: boolean;
}

// A hunter eats another creature when it is at least this much longer.
export const EAT_SIZE_RATIO = 1.25;
// Hunger above this makes a predator/shark/crab actively hunt.
export const HUNT_THRESHOLD = 0.25;
// Foragers only turn on smaller prey when quite hungry (they mostly graze).
export const FORAGER_HUNT_THRESHOLD = 0.5;

export const SPECIES: CreatureSpecies[] = [
  // ---- schooling prey (min ~2× the 0.5 m clownfish) ----
  {
    id: 'silverside', modelUrl: fishSchool1Url, baseLength: 1.3, sizeVar: 0.22, flipForward: false,
    modelYaw: 0.87, // this model is authored ~50° off the swim axis
    role: 'prey', maxSpeed: 6.4, accel: 24, drag: 2.1, turnRate: 4.2,
    senseRadius: 14, schooling: true, hungerRate: 0, animSpeed: 1.4, procedural: false,
  },
  {
    id: 'anchovy', modelUrl: fishSchool3Url, baseLength: 1.5, sizeVar: 0.22, flipForward: false,
    role: 'prey', maxSpeed: 6.0, accel: 22, drag: 2.0, turnRate: 4.0,
    senseRadius: 14, schooling: true, hungerRate: 0, animSpeed: 1.3, procedural: false,
  },
  {
    id: 'sardine', modelUrl: fishSchool2Url, baseLength: 1.9, sizeVar: 0.22, flipForward: false,
    modelYaw: 0,
    role: 'prey', maxSpeed: 5.6, accel: 19, drag: 1.9, turnRate: 3.6,
    senseRadius: 15, schooling: true, hungerRate: 0, animSpeed: 1.1, procedural: false,
  },

  // ---- solitary foragers (graze; hunt small prey only when hungry) ----
  {
    id: 'wrasse', modelUrl: randomFish1Url, baseLength: 1.8, sizeVar: 0.25, flipForward: false,
    modelYaw: 0,
    role: 'forager', maxSpeed: 5.0, accel: 17, drag: 1.7, turnRate: 3.0,
    senseRadius: 16, schooling: false, hungerRate: 0.04, animSpeed: 1.15, procedural: false,
  },
  {
    id: 'angel', modelUrl: randomFish2Url, baseLength: 2.1, sizeVar: 0.25, flipForward: false,
    role: 'forager', maxSpeed: 4.8, accel: 16, drag: 1.7, turnRate: 2.8,
    senseRadius: 16, schooling: false, hungerRate: 0.04, animSpeed: 1.05, procedural: false,
  },

  // ---- predators (hunt the schools, flee the shark) ----
  {
    id: 'grouper', modelUrl: randomFish3Url, baseLength: 2.9, sizeVar: 0.2, flipForward: false,
    role: 'predator', maxSpeed: 6.6, accel: 19, drag: 1.5, turnRate: 2.6,
    senseRadius: 28, schooling: false, hungerRate: 0.07, animSpeed: 1.0, procedural: false,
  },
  {
    id: 'barracuda', modelUrl: randomFish4Url, baseLength: 3.2, sizeVar: 0.18, flipForward: false,
    role: 'predator', maxSpeed: 8.6, accel: 24, drag: 1.4, turnRate: 3.0,
    senseRadius: 32, schooling: false, hungerRate: 0.08, animSpeed: 1.1, procedural: false,
  },

  // ---- apex shark (really big, prowls and hunts everything) ----
  {
    id: 'shark', modelUrl: sharkUrl, baseLength: 6.0, sizeVar: 0.15, flipForward: false,
    role: 'predator', apex: true, maxSpeed: 9.0, accel: 18, drag: 1.3, turnRate: 2.3,
    senseRadius: 46, schooling: false, hungerRate: 0.06, animSpeed: 0.95, procedural: false,
  },

  // ---- crab (seabed ambusher) ----
  {
    id: 'crab', modelUrl: crabUrl, baseLength: 1.35, sizeVar: 0.25, flipForward: false,
    role: 'crab', maxSpeed: 3.0, accel: 12, drag: 3.0, turnRate: 2.2,
    senseRadius: 11, schooling: false, hungerRate: 0.04, animSpeed: 1.0, procedural: true,
  },
];

export function speciesById(id: string): CreatureSpecies {
  const s = SPECIES.find((sp) => sp.id === id);
  if (!s) throw new Error(`unknown species ${id}`);
  return s;
}

export interface PopEntry {
  speciesId: string;
  count: number;
  schoolSize?: number;
}

/**
 * Populates the Shallow Veil. The ecosystem keeps this whole population inside a
 * roaming "bubble" around the player (see Ecosystem), so these counts are what
 * you actually swim among — dense schools, roaming foragers, hunting predators,
 * an apex shark, and seabed crabs. schoolSize groups the schooling species into
 * coherent shoals that swim and recycle as a unit.
 */
export const SHALLOW_VEIL_POP: PopEntry[] = [
  // Lean on the cheap schooling species (silverside 534 tris, anchovy 806) for a
  // high *visible* count; keep the heavy sardine (6.5k tris) to a single shoal.
  { speciesId: 'silverside', count: 64, schoolSize: 16 },
  { speciesId: 'anchovy', count: 52, schoolSize: 13 },
  { speciesId: 'sardine', count: 12, schoolSize: 12 },
  { speciesId: 'wrasse', count: 12 },
  { speciesId: 'angel', count: 10 },
  { speciesId: 'grouper', count: 7 },
  { speciesId: 'barracuda', count: 5 },
  { speciesId: 'shark', count: 2 },
  { speciesId: 'crab', count: 10 },
];
