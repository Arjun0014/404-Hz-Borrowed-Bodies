import type { PlayerFish } from '../entities/PlayerFish';
import type { PlayerCamera } from './PlayerCamera';
import type { PlayerCombat } from './PlayerCombat';
import { ceilingLength, healthAt } from '../data/growth';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Species growth (Phase 5+): eating biomass grows the host from its minimum size
 * toward the universal ceiling (GROWTH_MAX_LENGTH× the min length), continuously
 * scaling the body, max health, reach, and edible-prey size, and pulling the
 * camera back to match. Possession hands this system a new host at whatever size
 * that creature had grown to (setHost), so the growth bar and body reflect it.
 * Benefits climb with size; the drawback is a loss of agility (in the controller)
 * and the hard ceiling.
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
    this.applyStats();
    this.combat.health = this.combat.maxHealth;
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

  /** Turn agility. Kept at full regardless of size — big hosts still steer well. */
  get agility(): number {
    return 1;
  }

  reset(): void {
    this.biomass = 0;
    this.progress = 0;
    this.stageIndex = 0;
    this.applyStats();
    this.combat.health = this.combat.maxHealth;
  }

  /**
   * Re-seat growth on a freshly possessed host at its natural size (0..1). The
   * body, camera, and max-health snap to the new host; the possession system
   * sets the actual current health afterward.
   */
  setHost(growth01: number): void {
    this.progress = Math.max(0, Math.min(1, growth01));
    this.biomass = this.progress * this.def.biomassToCeiling;
    this.stageIndex = this.stageForProgress();
    this.applyStats();
  }

  /** Add growth biomass from a bite (already size-weighted by the ecosystem). */
  feed(biomass: number): void {
    if (this.atCeiling) return;
    const prevMax = this.combat.maxHealth;
    this.biomass = Math.min(this.def.biomassToCeiling, this.biomass + biomass);
    this.progress = this.biomass / this.def.biomassToCeiling;
    this.applyStats();

    // Growing heals by the max-health gained (rewarding).
    const gained = this.combat.maxHealth - prevMax;
    if (gained > 0) this.combat.health = Math.min(this.combat.maxHealth, this.combat.health + gained);

    // Stage-up notification.
    const idx = this.stageForProgress();
    if (idx > this.stageIndex) {
      this.stageIndex = idx;
      this.onStageUp(this.def.stages[idx].name);
    }
  }

  private stageForProgress(): number {
    let idx = 0;
    for (let i = 0; i < this.def.stages.length; i++) {
      if (this.progress + 1e-6 >= this.def.stages[i].at) idx = i;
    }
    return idx;
  }

  /** Push the current growth into body, camera, and max health (no auto-heal). */
  private applyStats(): void {
    const length = lerp(this.fish.baseLength, ceilingLength(this.fish.baseLength), this.progress);
    this.fish.setGrowth(length / this.fish.baseLength);
    this.fish.agility = this.agility; // heavier body turns slower
    this.camera.setHost(this.fish.species.camera, length);

    const newMax = healthAt(this.def.baseHealth, this.progress);
    this.combat.maxHealth = newMax;
    if (this.combat.health > newMax) this.combat.health = newMax;
  }
}
