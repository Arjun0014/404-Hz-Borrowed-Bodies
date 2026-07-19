/**
 * Connection — the ancient entity establishing control over the player's signal.
 * This is the game's central pressure (GAME_DESIGN §2.3, §7.2): it rises
 * continuously and, at full, the entity seizes control and the run ends. The only
 * relief is slipping into a FRESH body (a species you haven't worn recently), so
 * Connection is what forces the player to keep hunting, weakening, and possessing.
 *
 * Character-level, like Resonance — it belongs to the consciousness, not the host,
 * and survives body swaps. Bigger hosts are more detectable and gain Connection
 * faster (the signal cost that balances powerful bodies). Re-entering a recently
 * used body barely helps: each possessed species is "contaminated" for a while,
 * so cycling between the same two bodies cannot trivialise the pressure.
 */

// --- tuning (the pressure curve; exposed for balancing) ---
const RISE_PER_SEC = 0.010; // gain/sec at sensitivity 1.0 (≈100 s to full, no swaps)
const SENS_BASE = 0.55; // a tiny host still draws the signal
const SENS_PER_LEN = 0.22; // ...and a bigger body draws it much faster
const CONTAM_DECAY_PER_SEC = 0.04; // a used species reads "fresh" again after ~25 s
const FRESH_REDUCTION = 0.45; // a fully-fresh possession drops Connection this much
const MIN_REDUCTION = 0.04; // even a contaminated re-entry gives a token dip

export type ConnectionTier = 'calm' | 'rising' | 'high' | 'critical';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PlayerConnection {
  private value = 0; // 0..1
  /** Debug: freeze the rise (balancing/playtest). */
  frozen = false;
  private wasFull = false;
  /** speciesId → contamination 0..1 (1 = just used, decays toward fresh). */
  private readonly contamination = new Map<string, number>();

  /** Fired once when Connection first reaches full — the entity takes control. */
  onFull: () => void = () => {};

  get value01(): number {
    return this.value;
  }

  get isFull(): boolean {
    return this.value >= 1;
  }

  /** Escalation band, drives HUD/vignette/audio intensity. */
  get tier(): ConnectionTier {
    if (this.value >= 0.9) return 'critical';
    if (this.value >= 0.7) return 'high';
    if (this.value >= 0.4) return 'rising';
    return 'calm';
  }

  /** Connection-gain multiplier for a host of the given body length. */
  static sensitivity(hostLength: number): number {
    return SENS_BASE + hostLength * SENS_PER_LEN;
  }

  /** Connection gained per second in a host of this length — the pressure's pace.
   *  Other systems (e.g. passive Resonance) can mirror this to move in lockstep. */
  static riseRate(hostLength: number): number {
    return RISE_PER_SEC * this.sensitivity(hostLength);
  }

  /** Rise over time (scaled by host size) and decay the contamination memory. */
  update(dt: number, hostLength: number): void {
    if (this.contamination.size) {
      for (const [k, v] of this.contamination) {
        const nv = v - CONTAM_DECAY_PER_SEC * dt;
        if (nv <= 0.001) this.contamination.delete(k);
        else this.contamination.set(k, nv);
      }
    }
    if (this.frozen) return;
    this.value = Math.min(1, this.value + RISE_PER_SEC * PlayerConnection.sensitivity(hostLength) * dt);
    if (this.value >= 1 && !this.wasFull) {
      this.wasFull = true;
      this.onFull();
    }
  }

  /** How much a possession of this species would reduce Connection right now. */
  freshness(speciesId: string): number {
    return 1 - (this.contamination.get(speciesId) ?? 0);
  }

  /**
   * Apply a completed possession: drop Connection by how fresh the body is, then
   * mark that species contaminated so an immediate re-entry barely helps. Returns
   * the amount dropped (for UI feedback).
   */
  possess(speciesId: string): number {
    const drop = Math.max(MIN_REDUCTION, FRESH_REDUCTION * this.freshness(speciesId));
    this.value = Math.max(0, this.value - drop);
    this.contamination.set(speciesId, 1);
    this.wasFull = false;
    return drop;
  }

  reset(): void {
    this.value = 0;
    this.frozen = false;
    this.wasFull = false;
    this.contamination.clear();
  }

  // --- debug/balancing ---
  setLevel(v: number): void {
    this.value = clamp(v, 0, 1);
    if (this.value < 1) this.wasFull = false;
  }

  toggleFreeze(): boolean {
    this.frozen = !this.frozen;
    return this.frozen;
  }
}
