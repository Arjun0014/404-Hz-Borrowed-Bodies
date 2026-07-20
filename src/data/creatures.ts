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
import megalodonUrl from '../../assets/shark_megalodon.glb?url';
import mantaUrl from '../../assets/drowned garden/manta.glb?url';
import magnapinnaUrl from '../../assets/drowned garden/magnapinna_squid.glb?url';
import fireflySquidUrl from '../../assets/drowned garden/firefly-squid-glowing.glb?url';

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
  // ---- barracuda: the player's starter species; small, darty, schooling ----
  // Swapped with the clownfish: its darting movement is the best-feeling thing
  // in the game to control, so it is the body you start in. The name and model
  // stay with their own creature; only the ecological SLOT was exchanged.
  {
    id: 'barracuda', displayName: 'Barracuda', modelUrl: randomFish4Url, baseLength: 0.5, baseHealth: 20,
    wildMaxGrowth: 0.6, flipForward: false,
    role: 'prey', maxSpeed: 5.6, accel: 23, drag: 2.1, turnRate: 4.6,
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
  // ---- clownfish: now the shelf's fast hunting predator (see the swap above) ----
  {
    id: 'clownfish', displayName: 'Clownfish', modelUrl: clownFishUrl, baseLength: 3.2, baseHealth: 66,
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

  // ================= The Drowned Garden =================
  // Deep-cave fauna. These only populate depth 1+; the Shallow Veil's
  // population list does not reference them.

  // ---- firefly squid: small, glowing, schools in the dark ----
  {
    id: 'fireflysquid', displayName: 'Firefly Squid', modelUrl: fireflySquidUrl,
    baseLength: 0.8, baseHealth: 22, wildMaxGrowth: 0.5, flipForward: false,
    role: 'prey', maxSpeed: 5.4, accel: 20, drag: 2.1, turnRate: 4.2,
    senseRadius: 14, schooling: true, hungerRate: 0, animSpeed: 1.3, procedural: false,
  },
  // ---- manta: huge, placid, glides the vault; a superb body to wear ----
  {
    id: 'manta', displayName: 'Manta', modelUrl: mantaUrl,
    baseLength: 4.5, baseHealth: 90, wildMaxGrowth: 0.3, flipForward: false,
    role: 'forager', maxSpeed: 7.4, accel: 14, drag: 1.4, turnRate: 2.0,
    senseRadius: 30, schooling: false, hungerRate: 0.03, animSpeed: 0.8, procedural: false,
  },
  // ---- magnapinna: long-armed ambusher that inhales whatever drifts close ----
  {
    id: 'magnapinna', displayName: 'Magnapinna', modelUrl: magnapinnaUrl,
    baseLength: 5.2, baseHealth: 110, wildMaxGrowth: 0.28, flipForward: false,
    role: 'predator', maxSpeed: 6.0, accel: 15, drag: 1.6, turnRate: 2.2,
    senseRadius: 34, schooling: false, hungerRate: 0.07, animSpeed: 0.9, procedural: false,
  },
  // ---- megalodon: the cavern's boss. One of them, and it owns the place ----
  {
    id: 'megalodon', displayName: 'Megalodon', modelUrl: megalodonUrl,
    baseLength: 11, baseHealth: 260, wildMaxGrowth: 0.18, flipForward: false,
    role: 'predator', apex: true, maxSpeed: 13.5, accel: 26, drag: 1.25, turnRate: 1.8,
    senseRadius: 64, schooling: false, hungerRate: 0.06, animSpeed: 0.85, procedural: false,
  },

  // ---- crab (seabed ambusher) — big enough to read clearly on the seabed ----
  {
    id: 'crab', displayName: 'Reef Crab', modelUrl: crabUrl, baseLength: 2.7, baseHealth: 70,
    wildMaxGrowth: 0.28, flipForward: false, // keep seabed crabs from ballooning huge
    // The wide claw-span axis fools the longest-axis heuristic into facing the
    // crab sideways; pin the forward axis so the claws (and walk) lead. (+90°).
    modelYaw: Math.PI / 2,
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

/**
 * Populates the Drowned Garden. Leaner than the shelf — a dark cave should feel
 * sparse and dangerous rather than busy — and weighted toward the cavern's own
 * fauna, with a handful of familiar shelf species so the ecosystem still reads
 * as continuous. Exactly one megalodon: it is the zone's boss, not a population.
 */
export const DROWNED_GARDEN_POP: PopEntry[] = [
  // Weighted hard toward the CHEAP models, because the cavern felt lonely and
  // the only affordable way to fix that is volume of low-poly fish. Per-model
  // costs: firefly squid 1,562 tris, fry/silverside 534, anchovy 806,
  // barracuda 2,174, angelfish 292, clownfish 276. The expensive hunters stay
  // rare, which is also what makes running into one mean something.
  { speciesId: 'fireflysquid', count: 54, schoolSize: 14 }, // glowing bait balls
  { speciesId: 'fry', count: 60, schoolSize: 15 },
  { speciesId: 'angelfish', count: 40, schoolSize: 10 },
  { speciesId: 'barracuda', count: 36, schoolSize: 12 }, // the small starter species
  { speciesId: 'silverside', count: 34 },
  { speciesId: 'anchovy', count: 28 },
  { speciesId: 'sardine', count: 12 },
  { speciesId: 'wrasse', count: 12 },
  { speciesId: 'angel', count: 10 },
  { speciesId: 'manta', count: 7 },
  { speciesId: 'grouper', count: 6 },
  { speciesId: 'magnapinna', count: 5 },
  { speciesId: 'clownfish', count: 4 }, // now the fast predator
  { speciesId: 'crab', count: 10 },
  { speciesId: 'megalodon', count: 1 },
];
