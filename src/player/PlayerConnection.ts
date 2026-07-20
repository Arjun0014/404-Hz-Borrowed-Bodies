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
const RISE_PER_SEC = 0.010; // gain/sec (≈100 s to full, no swaps)
/**
 * Connection no longer scales with host SIZE.
 *
 * It used to: a 6 m shark drew the entity ~2.8x faster than a 0.5 m fish, on the
 * theory that powerful bodies should cost more signal. In play that punished the
 * exact thing the game rewards you for achieving — you finally take a big body
 * and it immediately starts killing you faster — so growing and possessing
 * upward felt like a trap rather than a payoff. The pressure is now identical in
 * every creature, and the per-species `connectionMult` (species.ts) remains as
 * the deliberate, authored dial for hosts that should be louder or quieter.
 */
const SENS_FLAT = 1.0;
const CONTAM_DECAY_PER_SEC = 0.04; // a used species reads "fresh" again after ~25 s
const FRESH_REDUCTION = 0.45; // a fully-fresh possession drops Connection this much
const MIN_REDUCTION = 0.04; // even a contaminated re-entry gives a token dip
/** Cap on how far killing Signal Carriers can permanently slow the rise. */
const MAX_CARRIER_RELIEF = 0.6;

export type ConnectionTier = 'calm' | 'rising' | 'high' | 'critical';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PlayerConnection {
  private value = 0; // 0..1
  /** Debug: freeze the rise (balancing/playtest). */
  frozen = false;
  private wasFull = false;
  /**
   * Permanent slowdown from killing Signal Carriers (0..MAX_CARRIER_RELIEF). Each
   * carrier destroyed adds to it and it persists across descents, so clearing a
   * level's relays is lasting progress against the entity — the payoff for the
   * "kill them all each level" loop. Multiplies the whole rise via reliefFactor.
   */
  private carrierRelief = 0;
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

  /** Connection-gain multiplier. Flat: body size no longer affects the pace. */
  static sensitivity(_hostLength: number): number {
    return SENS_FLAT;
  }

  /** 0..1 permanent rise multiplier from carrier kills (1 = none killed yet). */
  get reliefFactor(): number {
    return 1 - this.carrierRelief;
  }

  /** Killing a Signal Carrier permanently weakens the entity's grip. */
  weaken(step: number): void {
    this.carrierRelief = clamp(this.carrierRelief + step, 0, MAX_CARRIER_RELIEF);
  }

  /** Connection gained per second — the pressure's pace, identical in every body.
   *  connMult is the host's per-species signal cost (species.ts connectionMult).
   *  Other systems (e.g. passive Resonance) mirror this to move in lockstep. */
  static riseRate(_hostLength: number, connMult = 1): number {
    return RISE_PER_SEC * SENS_FLAT * connMult;
  }

  /** Rise over time (scaled by host size AND per-host signal cost) and decay the
   *  contamination memory. */
  update(dt: number, hostLength: number, connMult = 1): void {
    if (this.contamination.size) {
      for (const [k, v] of this.contamination) {
        const nv = v - CONTAM_DECAY_PER_SEC * dt;
        if (nv <= 0.001) this.contamination.delete(k);
        else this.contamination.set(k, nv);
      }
    }
    if (this.frozen) return;
    this.value = Math.min(
      1,
      this.value + PlayerConnection.riseRate(hostLength, connMult) * this.reliefFactor * dt,
    );
    if (this.value >= 1 && !this.wasFull) {
      this.wasFull = true;
      this.onFull();
    }
  }

  /**
   * Remove Connection directly — the Dead Signal Field's drain (Phase 13). This
   * is the only relief that does not require a fresh body, which is precisely why
   * the field is temporary and one-per-zone.
   */
  drain(amount: number): void {
    if (amount <= 0) return;
    this.value = Math.max(0, this.value - amount);
    if (this.value < 1) this.wasFull = false;
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
    this.carrierRelief = 0;
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
