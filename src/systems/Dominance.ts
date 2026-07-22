import type { CreatureSpecies, DomClass } from '../data/creatures';
import type { RunState } from '../state/RunState';

export type { DomClass };

/** Dominance ranks (GAME_DESIGN §7.4). Only the lower ranks are reachable in the
 *  Shallow Veil; deeper zones supply the stronger targets for higher ranks. */
export interface DomRank {
  name: string;
  at: number;
}
export const RANKS: DomRank[] = [
  { name: 'Drifter', at: 0 },
  { name: 'Hunter', at: 25 },
  { name: 'Predator', at: 90 },
  { name: 'Abyssal', at: 260 },
  { name: 'Usurper', at: 650 },
  // The Fallen Kingdom's rank. You reach this zone already wearing a megalodon,
  // so 'apex' has stopped meaning anything here — Usurper freely possesses every
  // apex in the game. Sovereign is what the trench giants ask for, and killing
  // them is the only way to get it.
  { name: 'Sovereign', at: 1400 },
];

const CLASS_VALUE: Record<DomClass, number> = {
  weak: 1, medium: 4, strong: 14, apex: 35, leviathan: 90,
};
// The maximum Dominance a class can push you to. This is the anti-farming core:
// weak prey stalls just into Hunter, so tiny fish can never unlock predator-level
// control — you must defeat progressively stronger creatures to rank up.
//
// `apex` stays uncapped, deliberately. Capping it would have retuned the Garden's
// megalodon, and this pass is only meant to add a tier on top, not move the
// existing ladder underneath it.
const CLASS_CAP: Record<DomClass, number> = {
  weak: 30, medium: 95, strong: 280, apex: Infinity, leviathan: Infinity,
};

const FIRST_KILL_BONUS = 2.5; // first defeat of a species this run is worth more
const FALLOFF = 0.5; // per repeat of the same species → diminishing returns

// Peer rank of each Dominance class. A creature is "at or below your standing" —
// and so freely possessable at any health — once your rank index reaches it. So a
// starting Drifter can already take same-tier weak fish (clownfish, fry, other
// prey); foragers open up at Hunter, predators at Predator, apex at Abyssal.
const CLASS_PEER_RANK: Record<DomClass, number> = {
  weak: 0, medium: 1, strong: 2, apex: 3, leviathan: 4,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Which Dominance class + base value a species is worth to defeat. */
export function classify(species: CreatureSpecies): { cls: DomClass; value: number } {
  // An explicit class wins: the trench giants are 'leviathan' and the rare
  // deep-water hunters punch above their role, neither of which the role/apex
  // heuristic below can express.
  if (species.domClass) return { cls: species.domClass, value: CLASS_VALUE[species.domClass] };
  if (species.apex) return { cls: 'apex', value: CLASS_VALUE.apex };
  if (species.role === 'predator') return { cls: 'strong', value: CLASS_VALUE.strong };
  if (species.role === 'forager' || species.role === 'crab') return { cls: 'medium', value: CLASS_VALUE.medium };
  return { cls: 'weak', value: CLASS_VALUE.weak }; // prey
}

/**
 * Run-level Dominance: a persistent rank earned by defeating creatures, weighted
 * by their class. Per-class caps + per-species diminishing returns mean farming
 * weak prey only advances early ranks; higher ranks demand stronger, more varied
 * targets. Backed by RunState so it survives host changes and zone descents.
 */
export class Dominance {
  onRankUp: (name: string) => void = () => {};
  /** Fired the first time a weak-prey kill is wasted against the class cap. */
  onWeakCapped: () => void = () => {};
  private weakCapNotified = false;

  constructor(private readonly run: RunState) {}

  get points(): number {
    return this.run.data.dominance;
  }

  get rankIndex(): number {
    let r = 0;
    for (let i = 0; i < RANKS.length; i++) if (this.points + 1e-6 >= RANKS[i].at) r = i;
    return r;
  }

  get rankName(): string {
    return RANKS[this.rankIndex].name;
  }

  get atMaxRank(): boolean {
    return this.rankIndex >= RANKS.length - 1;
  }

  /**
   * True if this species' class sits below the player's current Dominance
   * standing. Such creatures can be possessed at any health — no need to weaken
   * them first — as the tangible payoff for ranking up.
   */
  canFreelyPossess(species: CreatureSpecies): boolean {
    const { cls } = classify(species);
    return this.rankIndex >= CLASS_PEER_RANK[cls];
  }

  /** 0..1 progress toward the next rank (1 at the final rank). */
  get progressToNext(): number {
    const i = this.rankIndex;
    if (i >= RANKS.length - 1) return 1;
    const cur = RANKS[i].at;
    const next = RANKS[i + 1].at;
    return clamp((this.points - cur) / (next - cur), 0, 1);
  }

  /**
   * Record the player defeating a creature; grows Dominance per the rules.
   * @param yieldMult external scaling — the Dead Signal Field passes a decaying
   *   value so the frenzy cannot be farmed for rank (Phase 13 anti-farm rule).
   */
  recordKill(species: CreatureSpecies, yieldMult = 1): void {
    const { cls, value } = classify(species);
    const kills = this.run.data.speciesKills[species.id] ?? 0;

    // Base value, boosted on first defeat, decaying for repeats of the species.
    let gain = value * (1 / (1 + kills * FALLOFF)) * (kills === 0 ? FIRST_KILL_BONUS : 1) * yieldMult;

    // Class cap: once Dominance is past what this class can grant, its kills
    // barely register — you have to hunt bigger to keep advancing.
    if (this.points >= CLASS_CAP[cls]) {
      gain *= 0.05;
      if (cls === 'weak' && !this.weakCapNotified) {
        this.weakCapNotified = true;
        this.onWeakCapped();
      }
    }

    const beforeRank = this.rankIndex;
    this.run.data.dominance += gain;
    this.run.data.speciesKills[species.id] = kills + 1;
    if (this.rankIndex > beforeRank) this.onRankUp(this.rankName);
  }
}
