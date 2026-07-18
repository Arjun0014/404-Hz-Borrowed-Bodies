import type { CreatureSpecies } from '../data/creatures';
import type { RunState } from '../state/RunState';

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
];

/** Creature Dominance class — sets both the base value and the cap it can reach. */
export type DomClass = 'weak' | 'medium' | 'strong' | 'apex';

const CLASS_VALUE: Record<DomClass, number> = { weak: 1, medium: 4, strong: 14, apex: 35 };
// The maximum Dominance a class can push you to. This is the anti-farming core:
// weak prey stalls just into Hunter, so tiny fish can never unlock predator-level
// control — you must defeat progressively stronger creatures to rank up.
const CLASS_CAP: Record<DomClass, number> = { weak: 30, medium: 95, strong: 280, apex: Infinity };

const FIRST_KILL_BONUS = 2.5; // first defeat of a species this run is worth more
const FALLOFF = 0.5; // per repeat of the same species → diminishing returns

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Which Dominance class + base value a species is worth to defeat. */
export function classify(species: CreatureSpecies): { cls: DomClass; value: number } {
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

  /** 0..1 progress toward the next rank (1 at the final rank). */
  get progressToNext(): number {
    const i = this.rankIndex;
    if (i >= RANKS.length - 1) return 1;
    const cur = RANKS[i].at;
    const next = RANKS[i + 1].at;
    return clamp((this.points - cur) / (next - cur), 0, 1);
  }

  /** Record the player defeating a creature; grows Dominance per the rules. */
  recordKill(species: CreatureSpecies): void {
    const { cls, value } = classify(species);
    const kills = this.run.data.speciesKills[species.id] ?? 0;

    // Base value, boosted on first defeat, decaying for repeats of the species.
    let gain = value * (1 / (1 + kills * FALLOFF)) * (kills === 0 ? FIRST_KILL_BONUS : 1);

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
