// Universal size / growth math shared by wild creatures (Creature) and the
// player's host (PlayerGrowth). Every fish spans one fixed size range: from its
// species MINIMUM length up to a body GROWTH_MAX_LENGTH× longer (its ceiling).
// A single "growth" scalar 0..1 places a fish anywhere in that range, and HP and
// bite power scale with size off the same scalar — so a wild fish that spawned
// near max size is a big, tough, hard-hitting body, and possessing it hands the
// player that same size + a full growth bar.

/** Ceiling length as a multiple of a species' minimum length. 5× ≈ 125× volume
 *  — a dramatic range so growing and possessing feel transformative, without
 *  producing absurd giants. */
export const GROWTH_MAX_LENGTH = 5;

// HP and bite grow with body size, as powers of the length ratio (1 = linear in
// length, 3 = full volume). These keep a big fish genuinely tanky and punchy
// without turning a max fish into an unkillable wall.
export const HP_SIZE_EXP = 1.4;
export const BITE_SIZE_EXP = 1.3;

/** The player's host is hardier than a wild fish of the same species/size. */
export const PLAYER_HP_MULT = 5;

/** Wild spawns are heavily biased toward the minimum size (big ones are rare). */
export const WILD_SIZE_SKEW = 3.2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Length as a multiple of baseLength for a growth scalar. */
export function lengthRatio(growth01: number): number {
  return 1 + clamp01(growth01) * (GROWTH_MAX_LENGTH - 1);
}

/** Body length at a growth scalar, for a species of the given minimum length. */
export function lengthAt(baseLength: number, growth01: number): number {
  return baseLength * lengthRatio(growth01);
}

/** The growth ceiling (maximum length) for a species of the given minimum length. */
export function ceilingLength(baseLength: number): number {
  return baseLength * GROWTH_MAX_LENGTH;
}

/** Max HP at a growth scalar, given the species' HP at minimum size. */
export function healthAt(baseHealth: number, growth01: number): number {
  return baseHealth * Math.pow(lengthRatio(growth01), HP_SIZE_EXP);
}

/** Bite-damage multiplier (1 at minimum size) at a growth scalar. */
export function biteScaleAt(growth01: number): number {
  return Math.pow(lengthRatio(growth01), BITE_SIZE_EXP);
}

/** Recover the growth scalar 0..1 from an actual length + species minimum length. */
export function growthFromLength(length: number, baseLength: number): number {
  return clamp01((length / baseLength - 1) / (GROWTH_MAX_LENGTH - 1));
}

/**
 * A wild size roll skewed toward the minimum, then capped by the species' own
 * wild ceiling (big predators never spawn as giants; small prey occasionally do,
 * which makes a near-max fish a rare, valuable possession target).
 */
export function rollWildGrowth(wildMaxGrowth: number, skew = WILD_SIZE_SKEW): number {
  return Math.pow(Math.random(), skew) * clamp01(wildMaxGrowth);
}
