// Data-driven ecosystem creatures. Each entry maps a compressed .glb to a
// species with a role, size, movement, and AI senses. Adding or retuning a
// creature is a one-line change here — no engine edits.
import clownFishUrl from '../../assets/clown_fish_compressed.glb?url';
import regalAngelfishUrl from '../../assets/regal_angelfish.glb?url';
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
  displayName: string;
  modelUrl: string;
  /** MINIMUM body length in meters (the un-grown size; model auto-scaled to this). */
  baseLength: number;
  /** HP at minimum size. Scales up with size (see growth.ts healthAt). */
  baseHealth: number;
  /**
   * Largest growth scalar (0..1) a WILD member of this species may roll. 1 lets
   * small prey occasionally spawn near their full ceiling (a prize possession
   * target); big predators use a low value so no giants roam the shallows.
   */
  wildMaxGrowth: number;
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
  // ---- fry: tiny bait fish, the easiest food for a small starter ----
  {
    id: 'fry', displayName: 'Fry', modelUrl: fishSchool1Url, baseLength: 0.3, baseHealth: 10,
    wildMaxGrowth: 0.55, flipForward: false, modelYaw: 0.87, // same model as silverside
    role: 'prey', maxSpeed: 4.6, accel: 20, drag: 2.2, turnRate: 4.6,
    senseRadius: 11, schooling: true, hungerRate: 0, animSpeed: 1.6, procedural: false,
  },
  // ---- clownfish: same species as the player's starter host; ambient shoals ----
  {
    id: 'clownfish', displayName: 'Clownfish', modelUrl: clownFishUrl, baseLength: 0.5, baseHealth: 20,
    wildMaxGrowth: 0.6, flipForward: false,
    role: 'prey', maxSpeed: 5.2, accel: 21, drag: 2.1, turnRate: 4.4,
    senseRadius: 12, schooling: true, hungerRate: 0, animSpeed: 1.5, procedural: false,
  },
  // ---- regal angelfish: low-poly reef fish; graceful mid-water shoals ----
  {
    id: 'angelfish', displayName: 'Regal Angelfish', modelUrl: regalAngelfishUrl, baseLength: 1.0, baseHealth: 22,
    wildMaxGrowth: 0.55, flipForward: false,
    role: 'prey', maxSpeed: 5.4, accel: 20, drag: 2.0, turnRate: 4.0,
    senseRadius: 13, schooling: true, hungerRate: 0, animSpeed: 1.2, procedural: false,
  },
  // ---- loose prey (roam individually, spread across the shelf) ----
  {
    id: 'silverside', displayName: 'Silverside', modelUrl: fishSchool1Url, baseLength: 1.3, baseHealth: 26,
    wildMaxGrowth: 0.5, flipForward: false, modelYaw: 0.87, // model authored ~50° off the swim axis
    role: 'prey', maxSpeed: 6.4, accel: 24, drag: 2.1, turnRate: 4.2,
    senseRadius: 14, schooling: false, hungerRate: 0, animSpeed: 1.4, procedural: false,
  },
  {
    id: 'anchovy', displayName: 'Anchovy', modelUrl: fishSchool3Url, baseLength: 1.5, baseHealth: 28,
    wildMaxGrowth: 0.5, flipForward: false,
    role: 'prey', maxSpeed: 6.0, accel: 22, drag: 2.0, turnRate: 4.0,
    senseRadius: 14, schooling: false, hungerRate: 0, animSpeed: 1.3, procedural: false,
  },
  {
    id: 'sardine', displayName: 'Sardine', modelUrl: fishSchool2Url, baseLength: 1.9, baseHealth: 34,
    wildMaxGrowth: 0.42, flipForward: false, modelYaw: 0,
    role: 'prey', maxSpeed: 5.6, accel: 19, drag: 1.9, turnRate: 3.6,
    senseRadius: 15, schooling: false, hungerRate: 0, animSpeed: 1.1, procedural: false,
  },

  // ---- solitary foragers (graze; hunt small prey only when hungry) ----
  {
    id: 'wrasse', displayName: 'Wrasse', modelUrl: randomFish1Url, baseLength: 1.8, baseHealth: 34,
    wildMaxGrowth: 0.45, flipForward: false, modelYaw: 0,
    role: 'forager', maxSpeed: 5.0, accel: 17, drag: 1.7, turnRate: 3.0,
    senseRadius: 16, schooling: false, hungerRate: 0.04, animSpeed: 1.15, procedural: false,
  },
  {
    id: 'angel', displayName: 'Angelfish', modelUrl: randomFish2Url, baseLength: 2.1, baseHealth: 40,
    wildMaxGrowth: 0.42, flipForward: false,
    role: 'forager', maxSpeed: 4.8, accel: 16, drag: 1.7, turnRate: 2.8,
    senseRadius: 16, schooling: false, hungerRate: 0.04, animSpeed: 1.05, procedural: false,
  },

  // ---- predators (hunt the schools, flee the shark) ----
  {
    id: 'grouper', displayName: 'Grouper', modelUrl: randomFish3Url, baseLength: 2.9, baseHealth: 60,
    wildMaxGrowth: 0.32, flipForward: false,
    role: 'predator', maxSpeed: 6.6, accel: 19, drag: 1.5, turnRate: 2.6,
    senseRadius: 28, schooling: false, hungerRate: 0.07, animSpeed: 1.0, procedural: false,
  },
  {
    id: 'barracuda', displayName: 'Barracuda', modelUrl: randomFish4Url, baseLength: 3.2, baseHealth: 66,
    wildMaxGrowth: 0.32, flipForward: false,
    role: 'predator', maxSpeed: 8.6, accel: 24, drag: 1.4, turnRate: 3.0,
    senseRadius: 32, schooling: false, hungerRate: 0.08, animSpeed: 1.1, procedural: false,
  },

  // ---- apex shark: fast straight-line hunter, devours anything in its path ----
  {
    id: 'shark', displayName: 'Reef Shark', modelUrl: sharkUrl, baseLength: 6.0, baseHealth: 120,
    wildMaxGrowth: 0.22, flipForward: false,
    role: 'predator', apex: true, maxSpeed: 12.5, accel: 26, drag: 1.3, turnRate: 2.1,
    senseRadius: 52, schooling: false, hungerRate: 0.06, animSpeed: 0.95, procedural: false,
  },

  // ---- crab (seabed ambusher) — big enough to read clearly on the seabed ----
  {
    id: 'crab', displayName: 'Reef Crab', modelUrl: crabUrl, baseLength: 2.7, baseHealth: 70,
    wildMaxGrowth: 0.28, flipForward: false, // keep seabed crabs from ballooning huge
    role: 'crab', maxSpeed: 3.2, accel: 13, drag: 3.0, turnRate: 2.2,
    senseRadius: 12, schooling: false, hungerRate: 0.04, animSpeed: 1.0, procedural: true,
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
  // Only a few schools (fry, clownfish, angelfish); everything else roams
  // individually, spread across the whole shelf. Every fish spawns at a random
  // (mostly small) size. Counts are deliberately lean for an open, uncrowded sea.
  { speciesId: 'fry', count: 36, schoolSize: 18 }, // 2 bait balls for the starter to eat
  { speciesId: 'clownfish', count: 18, schoolSize: 9 }, // 2 shoals of the player's own kind
  { speciesId: 'angelfish', count: 16, schoolSize: 8 }, // 2 shoals of regal angelfish
  { speciesId: 'silverside', count: 24 }, // loose, spread out
  { speciesId: 'anchovy', count: 22 },
  { speciesId: 'sardine', count: 10 },
  { speciesId: 'wrasse', count: 10 },
  { speciesId: 'angel', count: 8 },
  { speciesId: 'grouper', count: 6 },
  { speciesId: 'barracuda', count: 4 },
  { speciesId: 'shark', count: 2 },
  { speciesId: 'crab', count: 8 },
];
