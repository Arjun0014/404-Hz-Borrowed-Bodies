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

/** Broad play-feel category for a host (drives HUD identity + tuning). */
export type HostArchetype = 'agile' | 'defensive' | 'skirmisher' | 'apex' | 'generic';

/** How a host moves through the world. Most swim; the crab crawls the seabed. */
export type Locomotion = 'swim' | 'crawl';

/** The active special ability a host can trigger (Phase 10). */
export type AbilityKind =
  | 'none'
  | 'slip'
  | 'brace'
  | 'burst'
  | 'inhale'
  | 'frenzy'
  // ---- Drowned Garden hosts ----
  /** Firefly squid: an ink cloud that blinds pursuers and breaks their tracking. */
  | 'ink'
  /** Magnapinna: a long-range suction that visibly drags prey into its mouth. */
  | 'suction'
  /** Manta: a gliding barrel-roll that sheds damage and covers ground. */
  | 'glide'
  /** Megalodon: a devastating charge that swallows everything in its path. */
  | 'rampage';

export interface AbilityDef {
  kind: AbilityKind;
  /** Short name shown on the HUD (empty for 'none'). */
  name: string;
  /** Seconds between uses. */
  cooldown: number;
  /** Seconds the effect stays active (0 = instant). */
  duration: number;
  /** One-line description for the ability HUD tooltip. */
  desc: string;
}

/** Per-host attack identity: a lunge-bite tuned per species. */
export interface AttackDef {
  /** Verb shown in feedback (Nip / Pincer / Slash / Maw…). */
  name: string;
  /** Damage as a multiple of the universal size-scaled bite. */
  damageMult: number;
  /** Reach as a multiple of body length. */
  reachMult: number;
  /** Seconds between attacks. */
  cooldown: number;
  /** Forward burst speed of the lunge. */
  lungeSpeed: number;
  /** Devour EVERY edible thing swept through (apex), not just the front cone. */
  sweep: boolean;
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
  // ---- Phase 10 host identity ----
  archetype: HostArchetype;
  locomotion: Locomotion;
  attack: AttackDef;
  ability: AbilityDef;
  /**
   * Per-host signal cost, multiplying the Connection rise.
   *
   * Currently 1.0 for EVERY host by design: varying it (and scaling by body
   * size, which PlayerConnection also used to do) punished the player for
   * earning a powerful body, which is the opposite of what the possession loop
   * is meant to reward. The dial is kept so individual hosts can be made louder
   * or quieter later as a deliberate authored choice, not as a size tax.
   */
  connectionMult: number;
  /** One-line host identity for the HUD. */
  identity: string;
}

const NO_ABILITY: AbilityDef = { kind: 'none', name: '', cooldown: 0, duration: 0, desc: '' };
const GENERIC_ATTACK: AttackDef = {
  name: 'Bite', damageMult: 1, reachMult: 1, cooldown: 2.0, lungeSpeed: 20, sweep: false,
};

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
  archetype: 'agile',
  locomotion: 'swim',
  attack: { name: 'Nip', damageMult: 0.8, reachMult: 1.0, cooldown: 1.5, lungeSpeed: 20, sweep: false },
  ability: { kind: 'slip', name: 'Slip', cooldown: 6, duration: 0.4, desc: 'Evasive dart — a quick burst out of danger.' },
  connectionMult: 1.0,
  identity: 'Agile scout — nimble and quiet, but fragile.',
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
  archetype: 'skirmisher',
  locomotion: 'swim',
  attack: { name: 'Slash', damageMult: 1.3, reachMult: 1.2, cooldown: 1.4, lungeSpeed: 24, sweep: false },
  ability: { kind: 'burst', name: 'Burst', cooldown: 6, duration: 0.7, desc: 'Sprint burst — close or escape.' },
  connectionMult: 1.0,
  identity: 'Open-water cruiser — fast and relentless.',
};

/**
 * Curated Phase 10 roster overrides, keyed by creature species id. Possessing
 * one of these wild creatures yields an authored host with a distinct attack,
 * special ability, signal cost, and identity — instead of the generic profile.
 * Any creature NOT listed here still becomes a plain generic host.
 */
const ROSTER: Record<string, Partial<SpeciesDef>> = {
  clownfish: {
    archetype: 'agile',
    attack: { name: 'Nip', damageMult: 0.8, reachMult: 1.0, cooldown: 1.5, lungeSpeed: 20, sweep: false },
    ability: { kind: 'slip', name: 'Slip', cooldown: 6, duration: 0.4, desc: 'Evasive dart out of danger.' },
    connectionMult: 1.0,
    identity: 'Agile scout — nimble and quiet, but fragile.',
  },
  crab: {
    archetype: 'defensive',
    locomotion: 'crawl',
    attack: { name: 'Pincer', damageMult: 1.7, reachMult: 0.9, cooldown: 1.7, lungeSpeed: 9, sweep: false },
    ability: { kind: 'brace', name: 'Brace', cooldown: 8, duration: 3, desc: 'Hunker down — halve incoming damage.' },
    connectionMult: 1.0,
    identity: 'Armored seabed bruiser — walks, jumps, and pinches. Quiet to the signal.',
  },
  grouper: {
    archetype: 'defensive',
    attack: { name: 'Gulp', damageMult: 1.3, reachMult: 1.1, cooldown: 1.6, lungeSpeed: 16, sweep: false },
    ability: { kind: 'inhale', name: 'Inhale', cooldown: 7, duration: 0.6, desc: 'Suction feed — pull in and swallow nearby prey.' },
    connectionMult: 1.0,
    identity: 'Heavy ambusher — tanky, with a suction gulp.',
  },
  barracuda: {
    archetype: 'skirmisher',
    attack: { name: 'Slash', damageMult: 1.5, reachMult: 1.2, cooldown: 1.4, lungeSpeed: 24, sweep: false },
    ability: { kind: 'burst', name: 'Burst', cooldown: 6, duration: 0.7, desc: 'Sprint burst — close or escape, scattering prey.' },
    connectionMult: 1.0,
    identity: 'Hit-and-run striker — blazing fast, glass jaw.',
  },
  // ---- Drowned Garden roster ----
  fireflysquid: {
    archetype: 'agile',
    attack: { name: 'Beak', damageMult: 0.9, reachMult: 1.0, cooldown: 1.4, lungeSpeed: 22, sweep: false },
    ability: { kind: 'ink', name: 'Ink', cooldown: 8, duration: 3, desc: 'Ink cloud — blinds and scatters anything hunting you.' },
    connectionMult: 1.0,
    identity: 'Living lantern — tiny and quick, and it can vanish.',
  },
  manta: {
    archetype: 'skirmisher',
    attack: { name: 'Sweep', damageMult: 1.2, reachMult: 1.4, cooldown: 1.6, lungeSpeed: 20, sweep: true },
    ability: { kind: 'glide', name: 'Glide', cooldown: 7, duration: 2.5, desc: 'Soaring glide — long, fast, and hard to hit.' },
    connectionMult: 1.0,
    identity: 'Vast and unhurried — wide wings, wide reach.',
  },
  magnapinna: {
    archetype: 'defensive',
    attack: { name: 'Lash', damageMult: 1.4, reachMult: 1.8, cooldown: 1.7, lungeSpeed: 13, sweep: false },
    ability: { kind: 'suction', name: 'Suction', cooldown: 9, duration: 1.6, desc: 'Draw everything nearby into your mouth and swallow it.' },
    connectionMult: 1.0,
    identity: 'Long-armed horror — it does not chase, it pulls.',
  },
  megalodon: {
    archetype: 'apex',
    attack: { name: 'Devour', damageMult: 2.6, reachMult: 1.4, cooldown: 1.7, lungeSpeed: 26, sweep: true },
    ability: { kind: 'rampage', name: 'Rampage', cooldown: 14, duration: 5, desc: 'Unstoppable charge — speed, armour, and a maw that takes everything.' },
    connectionMult: 1.0,
    identity: 'The thing the cave is afraid of. Now it is you.',
  },

  shark: {
    archetype: 'apex',
    attack: { name: 'Maw', damageMult: 2.0, reachMult: 1.25, cooldown: 1.6, lungeSpeed: 22, sweep: true },
    ability: { kind: 'frenzy', name: 'Frenzy', cooldown: 12, duration: 4, desc: 'Blood frenzy — a surge of speed and savage bite.' },
    connectionMult: 1.0,
    identity: 'Apex terror — devours all in its path; the signal loves it.',
  },
};

/** Generic size stages for a possessed wild host (no authored stage names). */
const HOST_STAGES = [
  { at: 0, name: 'Juvenile' },
  { at: 0.35, name: 'Adult' },
  { at: 0.75, name: 'Prime' },
];

/** Generic identity line for a wild host that isn't in the curated roster. */
function genericIdentity(role: CreatureSpecies['role']): string {
  switch (role) {
    case 'predator': return 'Wild predator — a capable, unremarkable body.';
    case 'forager': return 'Wild forager — an ordinary grazing body.';
    case 'crab': return 'Wild crab — an armored seabed body.';
    default: return 'Wild prey — a small, expendable body.';
  }
}

/**
 * Build a playable host profile from any ecosystem creature, so ANY fish can be
 * possessed (Phase 7). Movement comes straight from the creature (a barracuda
 * host is fast, a grouper heavy); camera and growth are derived from its size.
 * Curated roster species (Phase 10) layer a distinct attack, ability, signal
 * cost, and identity on top via ROSTER; everything else stays a generic host.
 */
export function hostProfileFromCreature(sp: CreatureSpecies): SpeciesDef {
  const base = sp.baseLength;
  const curated = ROSTER[sp.id];
  const base_profile: SpeciesDef = {
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
    archetype: sp.role === 'crab' ? 'defensive' : 'generic',
    locomotion: sp.role === 'crab' ? 'crawl' : 'swim',
    attack: GENERIC_ATTACK,
    ability: NO_ABILITY,
    connectionMult: 1.0,
    identity: genericIdentity(sp.role),
  };
  return curated ? { ...base_profile, ...curated } : base_profile;
}
