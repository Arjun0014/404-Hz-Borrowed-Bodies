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
import monsterFishUrl from '../../assets/fallen kingdom/monster_fish.glb?url';
import eyeMonsterUrl from '../../assets/fallen kingdom/eye_monster.glb?url';
import anglerfishUrl from '../../assets/fallen kingdom/weird_deepsea_anglerfish.glb?url';
import koiUrl from '../../assets/fallen kingdom/secret_low_poly_cartoon_koi_fish.glb?url';

/**
 * prey     — schooling fish; flees anything that can eat it.
 * forager  — solitary fish; wanders, nibbles, flees bigger predators.
 * predator — hunts smaller fish when hungry (and flees the apex).
 * crab     — walks the seabed; ambush-jumps passing fish.
 */
export type CreatureRole = 'prey' | 'forager' | 'predator' | 'crab';

/**
 * Dominance class — what defeating this creature is worth, and what rank you
 * need before you can wear it freely (see systems/Dominance).
 *
 * Declared here rather than in Dominance so the data layer owns it: Dominance
 * already imports CreatureSpecies, and a species that names its own class would
 * otherwise close an import cycle.
 */
export type DomClass = 'weak' | 'medium' | 'strong' | 'apex' | 'leviathan';

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
  /**
   * Override the Dominance class this creature is worth (see systems/Dominance).
   * Normally derived from `role` + `apex`; the Fallen Kingdom's trench giants set
   * it to 'leviathan' because you ARRIVE in this zone wearing a megalodon, and a
   * creature you already out-rank is not a target.
   */
  domClass?: DomClass;

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
  // wildMaxGrowth raised 0.32 → 0.45 so scattered clownfish come in a clear
  // spread of sizes (a lean juvenile up to a hefty adult) rather than all looking
  // the same — asked for alongside thinning their numbers in the starting sea.
  // Kept below the old-shark range so the starter sea never grows a rare giant.
  {
    id: 'clownfish', displayName: 'Clownfish', modelUrl: clownFishUrl, baseLength: 3.2, baseHealth: 66,
    wildMaxGrowth: 0.45, flipForward: false,
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

  // ================= The Fallen Kingdom =================
  // The drowned city's own fauna. Referenced ONLY by FALLEN_KINGDOM_POP, so
  // adding them leaves the Veil and the Garden exactly as they were.

  /**
   * The trench's two apex forms. You arrive in this zone wearing a megalodon,
   * so the resident giants have to out-class one: both are 'leviathan', a
   * Dominance tier above apex, which means a megalodon-riding player cannot
   * simply walk in and wear them. They are also the only creatures in the game
   * with a genuinely wide wild size range — the ask was "very big, with varying
   * sizes", and at wildMaxGrowth 0.55 a monster fish runs 9 m to 28 m, so the
   * one across the plaza might be smaller than you or twice your length.
   */
  {
    id: 'monsterfish', displayName: 'Trench Horror', modelUrl: monsterFishUrl,
    baseLength: 9, baseHealth: 300, wildMaxGrowth: 0.55, flipForward: false,
    role: 'predator', apex: true, domClass: 'leviathan',
    maxSpeed: 11.5, accel: 22, drag: 1.3, turnRate: 1.7,
    senseRadius: 60, schooling: false, hungerRate: 0.06, animSpeed: 0.9, procedural: false,
  },
  {
    id: 'eyemonster', displayName: 'Watcher', modelUrl: eyeMonsterUrl,
    baseLength: 8, baseHealth: 280, wildMaxGrowth: 0.5, flipForward: false,
    role: 'predator', apex: true, domClass: 'leviathan',
    maxSpeed: 10.5, accel: 19, drag: 1.35, turnRate: 2.0,
    senseRadius: 66, schooling: false, hungerRate: 0.05, animSpeed: 0.8, procedural: false,
  },

  /**
   * Two rarities, two each in the whole zone, each worth hunting for its body
   * rather than its meat.
   *
   * The anglerfish is a wall: 620 HP at minimum size is more than a megalodon's
   * 260, and it hits harder than anything else that is not a leviathan. You do
   * not out-trade it, you out-last it.
   *
   * The koi is the opposite — the fastest creature in the game at 20 m/s, ahead
   * of the megalodon's 13.5, with the turn rate to use it. That is exactly what
   * makes it hard to catch and exactly what makes wearing it worth the chase.
   */
  {
    id: 'anglerfish', displayName: 'Abyssal Angler', modelUrl: anglerfishUrl,
    baseLength: 4.2, baseHealth: 620, wildMaxGrowth: 0.4, flipForward: false,
    role: 'predator', domClass: 'apex',
    maxSpeed: 6.4, accel: 15, drag: 1.7, turnRate: 1.9,
    senseRadius: 40, schooling: false, hungerRate: 0.08, animSpeed: 0.85, procedural: false,
    animClip: /default/i, // the other two clips are bites, driven on attack
  },
  {
    id: 'koi', displayName: 'Gilded Koi', modelUrl: koiUrl,
    baseLength: 2.2, baseHealth: 90, wildMaxGrowth: 0.45, flipForward: false,
    role: 'forager', domClass: 'strong',
    maxSpeed: 20, accel: 40, drag: 1.9, turnRate: 5.0,
    // It sees you coming from a long way off and leaves. That, plus the speed,
    // is the whole difficulty — there is no tanking it down, you have to corner it.
    senseRadius: 70, schooling: false, hungerRate: 0.03, animSpeed: 1.3, procedural: false,
    animClip: /swim/i,
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
  // The player IS a barracuda now, so the shelf should feel like home water:
  // two proper shoals of your own kind (up from 4 lone fish), sizes varying
  // within each shoal. This is the "more barracuda + a small school" ask.
  { speciesId: 'barracuda', count: 16, schoolSize: 8 },
  // Clownfish are the fast PREDATOR now — thinned right down (18 → 6) and left
  // solitary so the starting sea isn't crowded with them, each rolling its own
  // size off the raised wildMaxGrowth for a visible spread.
  { speciesId: 'clownfish', count: 6 },
  { speciesId: 'angelfish', count: 16, schoolSize: 8 }, // 2 shoals of regal angelfish
  { speciesId: 'silverside', count: 24 }, // loose, spread out
  { speciesId: 'anchovy', count: 22 },
  { speciesId: 'sardine', count: 10 },
  { speciesId: 'wrasse', count: 10 },
  { speciesId: 'angel', count: 8 },
  { speciesId: 'grouper', count: 6 },
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

/**
 * Populates the Fallen Kingdom — the drowned city.
 *
 * Weighted deliberately: MANY cheap fish, FEW expensive ones. A ruined city
 * should be teeming in its streets and quiet in its depths, and the only way to
 * buy that is to spend the budget on models that cost almost nothing.
 *
 * The number that decides "cheap" here is not triangles — it is BONES. Every
 * fish is a skinned armature, and each bone recomposes a matrix every frame it
 * is near the player, which is the single largest CPU cost in the game (see
 * Ecosystem.setAttached). The two numbers disagree wildly, and going by
 * triangles alone picks exactly the wrong fish:
 *
 *   fish_school_1 (fry, silverside)   534 tris    5 bones   <- the best value
 *   fish_school_3 (anchovy)           806 tris   10 bones
 *   random_fish_1 (wrasse)          1,102 tris    6 bones
 *   fish_school_2 (sardine)         6,496 tris    6 bones   <- heavy GPU, cheap CPU
 *   crab                            5,002 tris    0 bones   <- not skinned at all
 *   regal_angelfish                   292 tris   95 bones   <- looks free, is not
 *   clown_fish                        276 tris   94 bones   <- looks free, is not
 *   firefly squid                   1,562 tris  121 bones   <- worst ratio in the game
 *
 * So the volume comes from the 5-19 bone models, the 90-121 bone models are
 * thinned to accents, and the result is 433 creatures carrying ~10.7k bones
 * where the old 273 carried ~15.1k. More alive, and cheaper.
 */
export const FALLEN_KINGDOM_POP: PopEntry[] = [
  // ---- the volume: cheap bodies AND cheap skeletons -----------------------
  { speciesId: 'fry', count: 110, schoolSize: 16 }, // bait balls through the streets
  { speciesId: 'silverside', count: 80 },
  { speciesId: 'anchovy', count: 70 },
  { speciesId: 'wrasse', count: 30 },
  { speciesId: 'angel', count: 24 },
  { speciesId: 'sardine', count: 6 }, // a few bigger silhouettes; 6 bones apiece
  { speciesId: 'crab', count: 8 }, // rubble-pickers — zero bones, procedural

  // ---- accents: beautiful, but 90-120 bones each, so kept scarce ----------
  { speciesId: 'fireflysquid', count: 26, schoolSize: 13 }, // glow motes in the dark
  { speciesId: 'angelfish', count: 24, schoolSize: 8 },
  { speciesId: 'barracuda', count: 14, schoolSize: 7 },
  { speciesId: 'clownfish', count: 6 },

  // ---- hunters: rare on purpose, so meeting one means something -----------
  { speciesId: 'grouper', count: 6 },
  { speciesId: 'manta', count: 3 },
  { speciesId: 'magnapinna', count: 3 },

  // ---- the trench's own: the giants this zone is actually about -----------
  { speciesId: 'monsterfish', count: 8 },
  { speciesId: 'eyemonster', count: 7 },
  // Two each, in a 760 x 760 m city. Finding one is the event.
  { speciesId: 'anglerfish', count: 2 },
  { speciesId: 'koi', count: 2 },
  // The body you most likely arrived in, now swimming at you.
  { speciesId: 'megalodon', count: 1 },
];
