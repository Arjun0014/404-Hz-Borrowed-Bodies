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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Phase 7 — Stun and Guaranteed Possession. Possession is gated on two things:
 * a locked-on TARGET (you must be aiming at a specific creature, right mouse) and
 * a full RESONANCE meter (the character-level charge earned by eating). Only then
 * does the "HOLD F" prompt appear. A creature qualifies if it is below your
 * Dominance (a free grab) or has been weakened past its size-scaled threshold
 * (bigger = must weaken more). Holding F channels for 3 s while the target is
 * stunned; complete it and you slip into that body at its natural size, spending
 * the resonance. The old body is abandoned (no duplication); Dominance carries over.
 */
export class PlayerPossession {
  /** True while channeling — gates normal control in GameApp (host holds still). */
  possessing = false;
  /** The creature F would take over right now (drives the "HOLD F" prompt). */
  bestTarget: Creature | null = null;
  /** True when aiming at a takeable creature but resonance isn't charged yet. */
  needsCharge = false;

  /** Fired when a takeover completes (host display name + species id). */
  onPossessed: (displayName: string, speciesId: string) => void = () => {};

  private target: Creature | null = null;
  private channelT = 0;

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
    this.needsCharge = false;
    this.target = null;
    this.channelT = 0;
  }

  /** 0..1 channel progress (for the on-screen ring/bar). */
  get channel01(): number {
    return clamp(this.channelT / CHANNEL_DUR, 0, 1);
  }

  /** The creature currently being channeled (null unless mid-takeover). */
  get channelTarget(): Creature | null {
    return this.possessing ? this.target : null;
  }

  /**
   * @param target the creature the player is currently locked onto (right mouse),
   *   or null. Possession only ever acts on this targeted creature.
   */
  update(dt: number, target: Creature | null): void {
    if (this.possessing) {
      this.advanceChannel(dt);
      return;
    }
    this.markEligible(); // ambient purple bars on all takeable creatures
    this.bestTarget = null;
    this.needsCharge = false;

    const cand = this.candidate(target);
    if (!cand) return;
    if (this.resonance.isFull) {
      this.bestTarget = cand; // prompt shows; F starts the channel
      if (this.input.isDown('KeyF')) this.begin(cand);
    } else {
      this.needsCharge = true; // aiming at a takeable fish, but not charged
    }
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

  /** The locked-on creature if it can actually be taken over right now, else null. */
  private candidate(target: Creature | null): Creature | null {
    if (!target || !target.alive || target.stunT > 0) return null;
    const range = RANGE_BASE + this.fish.length * RANGE_PER_LEN;
    if (this.inRange(target) > range) return null;
    return this.eligible(target) ? target : null;
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
