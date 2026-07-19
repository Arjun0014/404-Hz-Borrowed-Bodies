import { Vector3 } from 'three';
import type { Creature } from '../entities/Creature';
import type { Ecosystem } from '../systems/Ecosystem';
import type { PlayerFish } from '../entities/PlayerFish';
import type { SwimController } from './SwimController';
import type { PlayerCamera } from './PlayerCamera';
import type { PlayerGrowth } from './PlayerGrowth';
import type { PlayerCombat } from './PlayerCombat';
import type { Dominance } from '../systems/Dominance';
import type { PlayerResonance } from './PlayerResonance';
import type { Input } from '../core/Input';
import type { Sfx } from '../core/Sfx';
import { hostProfileFromCreature } from '../data/species';

const FWD = new Vector3();
const TO = new Vector3();

// Eligibility: how weak a target must be to become possessable. Same-size fish
// yield at POSSESS_BASE_FRAC health; a target N× your length must be weakened to
// roughly 1/N of that — so BIGGER targets are harder (point 2).
const POSSESS_BASE_FRAC = 0.42;
const POSSESS_SIZE_POW = 1.0;
const POSSESS_MIN_FRAC = 0.06;
const POSSESS_MAX_FRAC = 0.55;
const POSSESS_DOM_BONUS = 0.04; // each Dominance rank makes possession a bit easier

// You must be within this range of the targeted creature to channel a takeover.
const RANGE_BASE = 12;
const RANGE_PER_LEN = 4;
// While targeting (right mouse held), possessable creatures within this radius
// glow — only the near ones, and only while you're actively looking to take over.
const REVEAL_RADIUS = 42;

const CHANNEL_DUR = 3.0; // hold F this long, held still, to take the body
const HEALTH_RESTORE = 0.55; // fresh host wakes at this fraction of its max HP

// Phase 8 — Risk Possession. An INSTANT snatch (tap G) on the locked target that
// can fail. Success chance keys off the same size+Dominance threshold the stun
// path uses: right at "stun-ready" the odds are best, climbing to a healthy
// target's floor. Chance is always shown before you commit.
const RISK_MAX_CHANCE = 0.9; // a stun-ready target is nearly a sure thing
const RISK_MIN_CHANCE = 0.1; // a full-health tougher target is a long shot
// Chance = base + how favourable the size/Dominance matchup is + how weakened the
// target is + a small Dominance edge. Both size AND health move the odds.
const RISK_BASE = 0.12;
const RISK_MATCHUP_WEIGHT = 0.35; // easier class/size → better odds even at full HP
const RISK_HEALTH_WEIGHT = 0.5; // weakening the target is the biggest lever
const RISK_DOM_WEIGHT = 0.02; // per Dominance rank
const RISK_COOLDOWN = 1.6; // no spamming the gamble after it fails
// Failed snatch backlash: a chunk of max HP, heavier the longer the odds.
const RISK_BACKLASH_MIN = 0.18;
const RISK_BACKLASH_MAX = 0.42;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Host possession — two methods, both gated on a locked-on TARGET (right mouse)
 * and a full RESONANCE meter (spent per attempt).
 *
 * GUARANTEED (Phase 7, hold F): a creature qualifies if it is below your Dominance
 * or weakened past its size-scaled threshold. Hold F to channel 3 s while it is
 * stunned, then you slip into that body — reliable and skill-based.
 *
 * RISK (Phase 8, tap G): an immediate snatch on ANY locked target, even a healthy
 * or tougher one, at a shown success chance. Succeed and you take the body; fail
 * and you burn the resonance anyway, take backlash damage, alert the target, and
 * eat a short cooldown. The desperate, high-reward option — never the only path.
 */
export class PlayerPossession {
  /** True while channeling — gates normal control in GameApp (host holds still). */
  possessing = false;
  /** The creature F would take over right now (drives the "HOLD F" prompt). */
  bestTarget: Creature | null = null;
  /** The locked target a risk-snatch (G) would attempt — any in-range creature. */
  riskTarget: Creature | null = null;
  /** True when aiming at a takeable creature but resonance isn't charged yet. */
  needsCharge = false;
  /**
   * Extra snatch odds granted from outside — the Dead Signal Field sets this each
   * frame (Phase 13: "possession may become easier or safer inside the field").
   * Kept as a plain input rather than a field reference so possession stays
   * unaware of what is being generous to it.
   */
  externalRiskBonus = 0;
  /** True if the most recent takeover came from the risk path (for scoring). */
  lastPossessionWasRisk = false;

  /** Fired when a takeover completes (host display name + species id). */
  onPossessed: (displayName: string, speciesId: string) => void = () => {};
  /** Fired on a risk-snatch attempt with its outcome (for HUD flash/toast/sfx). */
  onRiskResult: (success: boolean, displayName: string) => void = () => {};

  private target: Creature | null = null;
  private channelT = 0;
  private riskCd = 0;

  constructor(
    private readonly ecosystem: Ecosystem,
    private readonly fish: PlayerFish,
    private readonly controller: SwimController,
    private readonly camera: PlayerCamera,
    private readonly growth: PlayerGrowth,
    private readonly combat: PlayerCombat,
    private readonly dominance: Dominance,
    private readonly resonance: PlayerResonance,
    private readonly input: Input,
    private readonly sfx: Sfx,
  ) {}

  reset(): void {
    this.possessing = false;
    this.bestTarget = null;
    this.riskTarget = null;
    this.needsCharge = false;
    this.target = null;
    this.channelT = 0;
    this.riskCd = 0;
  }

  /** 0..1 channel progress (for the on-screen ring/bar). */
  get channel01(): number {
    return clamp(this.channelT / CHANNEL_DUR, 0, 1);
  }

  /** The creature currently being channeled (null unless mid-takeover). */
  get channelTarget(): Creature | null {
    return this.possessing ? this.target : null;
  }

  /** 0..1 success chance of a risk-snatch on the current risk target (0 if none). */
  get riskChance01(): number {
    return this.riskTarget ? this.riskChance(this.riskTarget) : 0;
  }

  /**
   * @param target the creature the player is currently locked onto (right mouse),
   *   or null. Possession only ever acts on this targeted creature.
   */
  update(dt: number, target: Creature | null): void {
    if (this.riskCd > 0) this.riskCd -= dt;
    if (this.possessing) {
      this.advanceChannel(dt);
      return;
    }
    this.markEligible(); // ambient purple bars on all takeable creatures
    this.bestTarget = null;
    this.riskTarget = null;
    this.needsCharge = false;

    // Any locked, in-range, un-stunned creature is a candidate for a risk snatch;
    // only the eligible (weakened / below-Dominance) ones allow the guaranteed hold.
    const inReach = this.reachable(target);
    if (!inReach) {
      this.input.consumeRisk(); // drop a stray tap when nothing is targeted
      return;
    }

    if (!this.resonance.isFull) {
      this.needsCharge = true; // aiming at a fish, but not charged
      this.input.consumeRisk();
      return;
    }

    // Charged + targeting: guaranteed hold (if eligible) and/or an instant gamble.
    this.riskTarget = inReach;
    if (this.eligible(inReach)) {
      this.bestTarget = inReach; // "HOLD F" prompt
      if (this.input.isDown('KeyF')) this.begin(inReach);
    }
    if (this.input.consumeRisk() && this.riskCd <= 0) this.attemptRisk(inReach);
  }

  /** Required health fraction for a target to be possessable (size + Dominance). */
  private requiredFrac(c: Creature): number {
    const ratio = c.length / Math.max(0.05, this.fish.length);
    const dom = this.dominance.rankIndex * POSSESS_DOM_BONUS;
    return clamp(
      POSSESS_BASE_FRAC / Math.pow(Math.max(ratio, 0.001), POSSESS_SIZE_POW) + dom,
      POSSESS_MIN_FRAC,
      POSSESS_MAX_FRAC,
    );
  }

  private inRange(c: Creature): number {
    TO.subVectors(c.pos, this.controller.pos);
    return TO.length();
  }

  /** Is this creature possessable — below your Dominance, or weakened enough? */
  private eligible(c: Creature): boolean {
    // Free grab if the creature's class is below your Dominance standing;
    // otherwise it must be weakened past its size-scaled threshold.
    return (
      this.dominance.canFreelyPossess(c.species) ||
      (c.health01 < 0.999 && c.health01 <= this.requiredFrac(c))
    );
  }

  /**
   * Flag possessable creatures so DamageBars glows them — but ONLY while the
   * player is targeting (right mouse held) and ONLY for creatures near the host,
   * so it reads as "scan the fish around me", not a map-wide cheat sheet.
   */
  private markEligible(): void {
    const reveal = this.input.rmbDown;
    const list = this.ecosystem.list;
    const p = this.controller.pos;
    const r2 = REVEAL_RADIUS * REVEAL_RADIUS;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!reveal || !c.alive || c.stunT > 0) {
        c.stunReady = false;
        continue;
      }
      const dx = c.pos.x - p.x;
      const dy = c.pos.y - p.y;
      const dz = c.pos.z - p.z;
      c.stunReady = dx * dx + dy * dy + dz * dz <= r2 && this.eligible(c);
    }
  }

  /** The locked-on creature if it is alive, un-stunned, and within reach — else null. */
  private reachable(target: Creature | null): Creature | null {
    if (!target || !target.alive || target.stunT > 0) return null;
    const range = RANGE_BASE + this.fish.length * RANGE_PER_LEN;
    return this.inRange(target) <= range ? target : null;
  }

  /** Success chance (0..1) of an instant risk-snatch on this target. */
  private riskChance(c: Creature): number {
    const frac = this.requiredFrac(c); // the guaranteed-stun threshold (size + Dominance)
    if (c.health01 <= frac) return RISK_MAX_CHANCE; // already stun-ready — near certain
    const bonus = this.externalRiskBonus; // dead-signal field makes the jump safer
    // Matchup ease: high for small/below-Dominance targets, low for big/tough ones.
    const matchup = clamp(
      (frac - POSSESS_MIN_FRAC) / (POSSESS_MAX_FRAC - POSSESS_MIN_FRAC),
      0,
      1,
    );
    const weak = 1 - c.health01; // 0 (full HP) → 1 (near dead)
    const dom = this.dominance.rankIndex * RISK_DOM_WEIGHT;
    const chance = RISK_BASE + matchup * RISK_MATCHUP_WEIGHT + weak * RISK_HEALTH_WEIGHT + dom + bonus;
    return clamp(chance, RISK_MIN_CHANCE, RISK_MAX_CHANCE);
  }

  /** Gamble on an instant takeover of the target. Spends resonance either way. */
  private attemptRisk(target: Creature): void {
    const chance = this.riskChance(target);
    const name = target.species.displayName;
    this.resonance.spend(); // the signal discharges whether it lands or not
    this.riskCd = RISK_COOLDOWN;

    if (Math.random() < chance) {
      this.lastPossessionWasRisk = true; // set BEFORE takeOver — onPossessed reads it
      this.takeOver(target);
      this.onRiskResult(true, name);
      return;
    }

    // Failure: backlash damage (heavier the longer the odds), alert the target,
    // scatter nearby prey, and a camera jolt. The gamble has real teeth.
    const backlash = this.combat.maxHealth * lerp(RISK_BACKLASH_MIN, RISK_BACKLASH_MAX, 1 - chance);
    this.combat.takeDamage(backlash);
    target.provoke();
    this.ecosystem.alertPrey();
    this.camera.punch(20);
    this.sfx.possessFail();
    this.onRiskResult(false, name);
  }

  private begin(target: Creature): void {
    this.possessing = true;
    this.target = target;
    this.bestTarget = null;
    this.needsCharge = false;
    this.channelT = 0;
    this.controller.vel.set(0, 0, 0); // stop dead — you're channeling
    target.stun(CHANNEL_DUR + 1.0);
    this.sfx.stunHit();
  }

  private advanceChannel(dt: number): void {
    const t = this.target;
    const range = RANGE_BASE + this.fish.length * RANGE_PER_LEN + 3; // small grace
    // Cancel if the target died, drifted out of range, or F was released.
    if (!t || !t.alive || this.inRange(t) > range || !this.input.isDown('KeyF')) {
      this.cancel();
      return;
    }
    this.controller.vel.set(0, 0, 0); // held still throughout the channel
    t.stun(0.4); // keep it frozen + facing us
    this.channelT += dt;
    if (this.channelT >= CHANNEL_DUR) this.complete();
  }

  private cancel(): void {
    this.possessing = false;
    this.target = null;
    this.channelT = 0;
  }

  private complete(): void {
    const target = this.target;
    this.possessing = false;
    this.target = null;
    this.channelT = 0;
    if (!target) return;
    this.resonance.spend(); // the jump costs the whole charge — go feed again
    this.lastPossessionWasRisk = false;
    this.takeOver(target);
  }

  /** Slip into the target's body — shared by the guaranteed and risk paths. */
  private takeOver(target: Creature): void {
    const sp = target.species;
    const profile = hostProfileFromCreature(sp);
    const inst = this.ecosystem.createHostInstance(sp.id);
    this.fish.swapHost(profile, inst);

    // New host wakes at its natural size (growth), re-framed camera, scaled HP.
    this.growth.setHost(target.growth01);
    this.combat.dead = false;
    this.combat.health = Math.min(
      this.combat.maxHealth,
      Math.max(target.health, this.combat.maxHealth * HEALTH_RESTORE),
    );
    this.combat.feedFlash = 1; // green possession flash

    // Slip into the target's body; abandon the old one.
    this.controller.getForward(FWD);
    this.controller.warpTo(target.pos, FWD);
    this.controller.vel.set(0, 0, 0);
    target.die(); // remove the wild body (no kill credit); pool respawns it later

    this.camera.punch(24);
    this.sfx.possess();
    this.onPossessed(profile.displayName, sp.id);
  }
}
