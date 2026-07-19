/**
 * Resonance — the signal's charge to jump into a new body. This is a property of
 * the CHARACTER (the 404 Hz signal), not of the fish it is wearing: it survives
 * possessions and host swaps, unlike growth/HP which belong to the host body.
 *
 * Eating fish builds resonance; a possession requires a full meter and spends it
 * entirely. That cost is what stops body-swapping from being free — you have to
 * hunt and feed before you can take another creature, whether it is below your
 * Dominance (a free grab) or a tougher contested target.
 */

// Total eaten-biomass (body-length units, the growth currency) to fully charge.
// Roughly a short hunting streak of small fish; big fish charge faster.
const RESONANCE_PER_FILL = 14;

export class PlayerResonance {
  private value = 0; // 0..1
  private wasFull = false;

  /** Fired the moment the meter first reaches full (for a "ready" cue). */
  onFull: () => void = () => {};

  /** 0..1 charge, for the HUD meter. */
  get value01(): number {
    return this.value;
  }

  /** True once fully charged — the gate for any possession. */
  get isFull(): boolean {
    return this.value >= 0.999;
  }

  /** Eating biomass charges the meter (same currency growth uses). */
  feed(biomass: number): void {
    if (this.value >= 1) return;
    this.value = Math.min(1, this.value + Math.max(0, biomass) / RESONANCE_PER_FILL);
    if (this.isFull && !this.wasFull) {
      this.wasFull = true;
      this.onFull();
    }
  }

  /**
   * Slow passive trickle over time, paced to match the Connection rise (so as the
   * entity's grip climbs, your means to escape into a fresh body climbs with it).
   * `ratePerSec` is on the 0..1 meter scale. Eating is still the fast way to fill.
   */
  tickPassive(dt: number, ratePerSec: number): void {
    if (this.value >= 1) return;
    this.value = Math.min(1, this.value + Math.max(0, ratePerSec) * dt);
    if (this.isFull && !this.wasFull) {
      this.wasFull = true;
      this.onFull();
    }
  }

  /** Spend the whole charge on a completed possession. */
  spend(): void {
    this.value = 0;
    this.wasFull = false;
  }

  reset(): void {
    this.value = 0;
    this.wasFull = false;
  }
}
