import type { PlayerFish } from '../entities/PlayerFish';
import type { PlayerCamera } from './PlayerCamera';
import type { PlayerCombat } from './PlayerCombat';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Species growth (Phase 5): eating biomass grows the host from its minimum size
 * toward the species ceiling, continuously scaling the body, max health, bite
 * damage, reach, and edible-prey size, and pulling the camera back to match.
 * At the ceiling the species is maxed — the only way to get stronger is a new
 * host (a later phase). Benefits climb with size; the drawback is the hard
 * ceiling plus a small loss of agility handled in the controller.
 */
export class PlayerGrowth {
  private biomass = 0;
  private progress = 0; // 0..1 toward the ceiling
  private stageIndex = 0;

  /** Fired when the host crosses into a new named stage. */
  onStageUp: (name: string) => void = () => {};

  constructor(
    private readonly fish: PlayerFish,
    private readonly camera: PlayerCamera,
    private readonly combat: PlayerCombat,
  ) {
    this.apply();
  }

  private get def() {
    return this.fish.species.growth;
  }

  get growth01(): number {
    return this.progress;
  }

  get atCeiling(): boolean {
    return this.progress >= 0.999;
  }

  get stageName(): string {
    return this.def.stages[this.stageIndex]?.name ?? '';
  }

  /** Fraction of full agility remaining (drops as the host grows heavier). */
  get agility(): number {
    return 1 - this.progress * 0.35;
  }

  reset(): void {
    this.biomass = 0;
    this.progress = 0;
    this.stageIndex = 0;
    this.apply();
  }

  /** Add growth biomass from a bite (already size-weighted by the ecosystem). */
  feed(biomass: number): void {
    if (this.atCeiling) return;
    this.biomass = Math.min(this.def.biomassToCeiling, this.biomass + biomass);
    this.progress = this.biomass / this.def.biomassToCeiling;
    this.apply();

    // Stage-up notification.
    let idx = 0;
    for (let i = 0; i < this.def.stages.length; i++) {
      if (this.progress + 1e-6 >= this.def.stages[i].at) idx = i;
    }
    if (idx > this.stageIndex) {
      this.stageIndex = idx;
      this.onStageUp(this.def.stages[idx].name);
    }
  }

  /** Push the current growth into body, camera, and combat stats. */
  private apply(): void {
    const d = this.def;
    const length = lerp(this.fish.baseLength, d.ceilingLength, this.progress);
    this.fish.setGrowth(length / this.fish.baseLength);
    this.fish.agility = this.agility; // heavier body turns slower
    this.camera.setHost(this.fish.species.camera, length);

    const newMax = lerp(d.maxHealthBase, d.maxHealthCeiling, this.progress);
    const gained = newMax - this.combat.maxHealth;
    this.combat.maxHealth = newMax;
    if (gained > 0) this.combat.health = Math.min(newMax, this.combat.health + gained); // growing heals
    else this.combat.health = Math.min(this.combat.health, newMax);

    this.combat.biteScale = lerp(1, d.biteScaleCeiling, this.progress);
  }
}
