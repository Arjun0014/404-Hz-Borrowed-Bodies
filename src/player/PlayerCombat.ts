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

// Attack tuning — a committed lunge: quick and reachy, but deliberate (long
// cooldown) so it can't be spammed.
const LUNGE_SPEED = 20; // forward burst — covers real distance (attack + escape)
const ATTACK_WINDOW = 0.42; // seconds the jaws stay "live" during a lunge
const ATTACK_CD = 2.0; // no rapid-fire clicking; one committed lunge at a time
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

  private attackCd = 0;
  private attackActive = 0;
  private sinceHurt = 99;
  private readonly lungeHits = new Set<Creature>();
  /** Play the "bite landed" chunk at most once per lunge (no stacking on schools). */
  private landedThisLunge = false;

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
    this.hurtFlash = 0;
    this.feedFlash = 0;
    this.lungeHits.clear();
  }

  get health01(): number {
    return this.health / this.maxHealth;
  }

  update(dt: number): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.feedFlash = Math.max(0, this.feedFlash - dt * 2.5);
    if (this.dead) return;

    this.attackCd -= dt;
    this.sinceHurt += dt;

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
    this.attackCd = ATTACK_CD;
    this.attackActive = ATTACK_WINDOW;
    this.lungeHits.clear();
    this.landedThisLunge = false;
    this.controller.lunge(LUNGE_SPEED);
    this.camera.punch(18);
    this.fish.lungePulse();
    this.sfx.biteSwing(); // jaws snap (varied slice)
  }

  /** Check the front cone each frame the jaws are live (plows through schools). */
  private resolveBite(): void {
    this.controller.getForward(FWD);
    ORIGIN.copy(this.controller.pos).addScaledVector(FWD, this.fish.length * 0.55);
    // Reach + edible-prey size + bite damage all scale off the host's real body
    // length — a small fish bites a small patch; a big host reaches and hits hard.
    const eatMax = this.fish.length / EAT_SIZE_RATIO;
    const reach = this.fish.length * REACH_PER_LEN + REACH_MOUTH;
    const damage = BITE_BASE * Math.pow(this.fish.length / BITE_REF_LEN, BITE_SIZE_EXP);
    const res = this.ecosystem.playerBiteCone(
      ORIGIN,
      FWD,
      reach,
      CONE_DOT,
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
  }

  takeDamage(dmg: number): void {
    if (this.dead || this.sinceHurt < 0.5) return; // brief i-frames
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
