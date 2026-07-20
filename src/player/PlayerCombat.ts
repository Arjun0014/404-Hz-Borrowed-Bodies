import { Vector3 } from 'three';
import type { Input } from '../core/Input';
import type { Sfx } from '../core/Sfx';
import type { PlayerFish } from '../entities/PlayerFish';
import type { Ecosystem } from '../systems/Ecosystem';
import type { Creature } from '../entities/Creature';
import type { SwimController } from './SwimController';
import type { PlayerCamera } from './PlayerCamera';
import { EAT_SIZE_RATIO } from '../data/creatures';
import { BITE_SIZE_EXP } from '../data/growth';

const FWD = new Vector3();
const ORIGIN = new Vector3();
const LOCK_DIR = new Vector3();

// A lock-on bite commits harder than a free one: it dashes toward the target, so
// the burst is stronger and reaches a little further to close the gap.
const LOCK_DASH_MULT = 1.45;
const LOCK_REACH_MULT = 1.15;

// Attack tuning — a committed lunge: quick and reachy, but deliberate. Speed and
// cooldown now come from the host's per-species attack profile (species.ts).
const ATTACK_WINDOW = 0.42; // seconds the jaws stay "live" during a lunge
// Bite damage of the starter (0.5 m) host; scales up with host length so a big
// possessed body hits far harder.
const BITE_BASE = 34;
const BITE_REF_LEN = 0.5;
// The jaws only reach a mouth-sized patch just ahead of the snout — sized to the
// BODY, so a small fish bites a small patch and a big host reaches further. Kept
// tight so you only ever bite what the lunge physically sweeps over (point 9).
const REACH_PER_LEN = 0.9;
const REACH_MOUTH = 0.25;
const CONE_DOT = 0.6; // ~53° front cone — only what's dead ahead gets bitten

/**
 * The host's attack: a committed forward LUNGE with a live bite window. Only the
 * front connects (a cone ahead of the snout), so side-brushing never damages.
 * The lunge covers real distance, doubling as a dodge/escape and a strike. Small
 * prey are eaten (healing); anything bigger — schools, predators, crabs — takes
 * damage and can be killed over several lunges. Also owns host health and death.
 */
export class PlayerCombat {
  maxHealth = 100;
  health = 100;
  dead = false;

  /** 0..1 feedback intensities for the HUD (decay each frame). */
  hurtFlash = 0;
  feedFlash = 0;

  onDeath: () => void = () => {};
  onHit: () => void = () => {}; // took damage (screen shake)
  onFeed: (biomass: number) => void = () => {}; // ate/killed → grow
  /** A bite landed on the Signal Carrier — drives its hit feedback (Phase 12). */
  onCarrierHit: (nodeKilled: boolean, died: boolean) => void = () => {};

  /**
   * The current lock-on target (set each frame by GameApp; a creature OR the
   * Signal Carrier — anything with a live world position). When set, clicking
   * bite DASHES toward where the target is at that instant and strikes along the
   * dash: the lock-and-attack of point 3. Null when nothing is locked.
   */
  lockTarget: { readonly pos: Vector3; readonly alive: boolean } | null = null;
  /** Fixed aim direction of the lunge in progress (captured at the click). */
  private readonly attackDir = new Vector3();
  /** True while the lunge in progress is a lock-on dash (longer reach). */
  private lungeLocked = false;

  private attackCd = 0;
  private attackActive = 0;
  private sinceHurt = 99;
  /** Brace (crab): fraction of incoming damage blocked while >0. */
  private guardFrac = 0;
  private guardT = 0;
  private readonly lungeHits = new Set<Creature>();
  /** Play the "bite landed" chunk at most once per lunge (no stacking on schools). */
  private landedThisLunge = false;
  /** The Signal Carrier may only be struck once per lunge (see resolveBite). */
  private carrierHitThisLunge = false;

  constructor(
    private readonly controller: SwimController,
    private readonly fish: PlayerFish,
    private readonly ecosystem: Ecosystem,
    private readonly input: Input,
    private readonly sfx: Sfx,
    private readonly camera: PlayerCamera,
  ) {}

  reset(): void {
    this.dead = false;
    this.attackCd = 0;
    this.attackActive = 0;
    this.sinceHurt = 99;
    this.guardFrac = 0;
    this.guardT = 0;
    this.hurtFlash = 0;
    this.feedFlash = 0;
    this.lungeHits.clear();
    this.carrierHitThisLunge = false;
  }

  get health01(): number {
    return this.health / this.maxHealth;
  }

  /** Brace ability (crab): block a fraction of incoming damage for a duration. */
  guard(fraction: number, duration: number): void {
    this.guardFrac = fraction;
    this.guardT = Math.max(this.guardT, duration);
  }

  /** True while a Brace guard is active (for the HUD). */
  get guarding(): boolean {
    return this.guardT > 0;
  }

  /** Grant brief invulnerability (Slip / Frenzy). */
  iframes(t: number): void {
    this.sinceHurt = Math.min(this.sinceHurt, -t);
  }

  /** Heal a flat amount (ability payoff), capped at max. */
  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
    if (amount > 0) this.feedFlash = Math.max(this.feedFlash, 0.6);
  }

  update(dt: number): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.feedFlash = Math.max(0, this.feedFlash - dt * 2.5);
    if (this.dead) return;

    this.attackCd -= dt;
    this.sinceHurt += dt;
    this.guardT = Math.max(0, this.guardT - dt);

    if (this.sinceHurt > 5 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 3 * dt);
    }

    if (this.input.consumeAttack() && this.attackCd <= 0) this.startLunge();
    if (this.attackActive > 0) {
      this.attackActive -= dt;
      this.resolveBite();
    }
  }

  private startLunge(): void {
    const atk = this.fish.species.attack;
    this.attackCd = atk.cooldown;
    this.attackActive = ATTACK_WINDOW;
    this.lungeHits.clear();
    this.landedThisLunge = false;
    this.carrierHitThisLunge = false;

    // Lock-on strike: if a target is locked, dash toward where it is RIGHT NOW
    // (its last-known position at the click — the dash is ballistic, it does not
    // home) and snap the body onto that line so the bite lands along the dash.
    // With nothing locked it's the plain forward lunge. Either way the aim is
    // frozen for the whole bite window so a committed strike doesn't wander.
    const lock = this.lockTarget;
    this.lungeLocked = false;
    if (lock && lock.alive) {
      LOCK_DIR.subVectors(lock.pos, this.controller.pos);
      if (LOCK_DIR.lengthSq() > 1e-4) {
        this.attackDir.copy(LOCK_DIR).normalize();
        this.controller.lungeToward(atk.lungeSpeed * LOCK_DASH_MULT, this.attackDir, true);
        this.lungeLocked = true;
      }
    }
    if (!this.lungeLocked) {
      this.controller.getForward(this.attackDir);
      this.controller.lunge(atk.lungeSpeed);
    }

    this.camera.punch(this.lungeLocked ? 24 : 18);
    this.fish.lungePulse();
    this.sfx.biteSwing(); // jaws snap (varied slice)
  }

  /** Check the front cone each frame the jaws are live (plows through schools). */
  private resolveBite(): void {
    // Aim is the direction captured at the click (frozen for the whole window),
    // so a lock-on dash strikes exactly where it was pointed and a free lunge
    // doesn't smear as the body settles.
    FWD.copy(this.attackDir);
    ORIGIN.copy(this.controller.pos).addScaledVector(FWD, this.fish.length * 0.55);
    // Reach + edible-prey size + bite damage all scale off the host's real body
    // length AND the host's per-species attack profile — a clownfish nips, a
    // shark tears; an apex "sweep" maw devours a wide arc, not just the front.
    // A lock-on dash reaches a little further to finish closing the gap.
    const atk = this.fish.species.attack;
    const eatMax = this.fish.length / EAT_SIZE_RATIO;
    const reach =
      this.fish.length * REACH_PER_LEN * atk.reachMult * (this.lungeLocked ? LOCK_REACH_MULT : 1) +
      REACH_MOUTH;
    const damage =
      BITE_BASE * atk.damageMult * Math.pow(this.fish.length / BITE_REF_LEN, BITE_SIZE_EXP);
    const cone = atk.sweep ? 0.1 : CONE_DOT; // sweep = wide devouring arc
    const res = this.ecosystem.playerBiteCone(
      ORIGIN,
      FWD,
      reach,
      cone,
      eatMax,
      damage,
      this.lungeHits,
    );
    if (res.hit > 0) {
      // Only one "chunk" sound per lunge, even plowing through a whole school.
      if (!this.landedThisLunge) {
        this.sfx.biteLanded();
        this.landedThisLunge = true;
      }
      this.camera.punch(9); // impact kick
    }
    if (res.eaten > 0) {
      this.health = Math.min(this.maxHealth, this.health + 14 * res.eaten);
      this.feedFlash = 1;
    }
    if (res.killed > 0) {
      this.health = Math.min(this.maxHealth, this.health + 6 * res.killed);
      this.feedFlash = 1;
    }
    if (res.biomass > 0) this.onFeed(res.biomass); // eating grows the host

    // The Signal Carrier, resolved here and ONCE per lunge. The bite's live
    // window is ~25 frames long; letting it connect on each one multiplied both
    // the damage and the impact sound by 25.
    const carrier = this.ecosystem.nearestCarrier(ORIGIN);
    if (carrier?.alive && !this.carrierHitThisLunge) {
      const hitRes = carrier.tryHit(ORIGIN, FWD, reach, cone, damage);
      if (hitRes.hit) {
        this.carrierHitThisLunge = true;
        this.camera.punch(hitRes.nodeKilled ? 26 : 12);
        this.onCarrierHit(hitRes.nodeKilled, hitRes.died);
      }
    }
  }

  takeDamage(dmg: number): void {
    if (this.dead || this.sinceHurt < 0.5) return; // brief i-frames
    if (this.guardT > 0) dmg *= 1 - this.guardFrac; // Brace soaks the blow
    this.health -= dmg;
    this.sinceHurt = 0;
    this.hurtFlash = 1;
    this.sfx.biteSwing(0.8); // the predator's jaws
    this.sfx.biteLanded(); // a chunk torn out of you
    this.onHit();
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.sfx.death();
      this.onDeath();
    }
  }
}
