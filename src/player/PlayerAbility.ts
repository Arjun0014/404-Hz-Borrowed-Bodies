import { Vector3 } from 'three';
import type { Input } from '../core/Input';
import type { PlayerFish } from '../entities/PlayerFish';
import type { SwimController } from './SwimController';
import type { PlayerCombat } from './PlayerCombat';
import type { PlayerCamera } from './PlayerCamera';
import type { Ecosystem } from '../systems/Ecosystem';
import type { Sfx } from '../core/Sfx';
import type { Creature } from '../entities/Creature';
import type { AbilityKind } from '../data/species';
import { EAT_SIZE_RATIO } from '../data/creatures';

const FWD = new Vector3();
const ORIGIN = new Vector3();
const PULL = new Vector3();

/**
 * Per-host special ability (Phase 10), tapped on Q. Each curated host has one:
 *   slip   (clownfish) — evasive dart + brief i-frames.
 *   brace  (crab)      — halve incoming damage for a few seconds.
 *   burst  (barracuda) — a sprint surge that scatters nearby prey.
 *   inhale (grouper)   — suction-devour small prey in a wide arc ahead + heal.
 *   frenzy (shark)     — a speed surge, brief i-frames, and a heal.
 * Wild (generic) hosts have no ability. Cooldown-gated; Resonance is NOT spent
 * (that gates possession), so abilities are the moment-to-moment host flavour.
 */
export class PlayerAbility {
  private cooldownT = 0;
  private activeT = 0;
  /** Seconds of magnapinna suction left to run (see runSuction). */
  private suctionT = 0;

  /** Fired when an ability activates (its name) — for HUD feedback. */
  onActivate: (name: string) => void = () => {};

  constructor(
    private readonly fish: PlayerFish,
    private readonly controller: SwimController,
    private readonly combat: PlayerCombat,
    private readonly camera: PlayerCamera,
    private readonly ecosystem: Ecosystem,
    private readonly input: Input,
    private readonly sfx: Sfx,
  ) {}

  reset(): void {
    this.cooldownT = 0;
    this.activeT = 0;
    this.suctionT = 0;
  }

  /** True when the host actually has an ability to show. */
  get has(): boolean {
    return this.fish.species.ability.kind !== 'none';
  }

  /** 0..1 readiness (1 = off cooldown, ready to fire). */
  get ready01(): number {
    const cd = this.fish.species.ability.cooldown;
    if (cd <= 0) return 1;
    return 1 - Math.min(1, Math.max(0, this.cooldownT / cd));
  }

  get isReady(): boolean {
    return this.has && this.cooldownT <= 0;
  }

  /** True while a duration ability is still running (for the HUD glow). */
  get isActive(): boolean {
    return this.activeT > 0;
  }

  update(dt: number): void {
    if (this.cooldownT > 0) this.cooldownT -= dt;
    if (this.activeT > 0) this.activeT -= dt;
    if (this.suctionT > 0) this.runSuction(dt);
    if (!this.input.consumeAbility()) return;
    const a = this.fish.species.ability;
    if (a.kind === 'none' || this.cooldownT > 0) return;
    this.trigger(a.kind, a.duration);
    this.cooldownT = a.cooldown;
    this.activeT = a.duration;
    this.onActivate(a.name);
  }

  /**
   * The magnapinna's suction, run continuously while active.
   *
   * The point is that you SEE it: creatures caught in the cone are physically
   * hauled toward the mouth each frame, tumbling as they come, and are only
   * swallowed once they actually arrive. Resolving it as a single instant
   * area-hit would have been far less code and completely missed the effect —
   * the horror is watching things fail to swim away.
   */
  private runSuction(dt: number): void {
    this.suctionT -= dt;
    this.controller.getForward(FWD);
    // Mouth sits just ahead of the head; everything is dragged to this point.
    ORIGIN.copy(this.controller.pos).addScaledVector(FWD, this.fish.length * 0.45);

    const reach = this.fish.length * 5.5;
    const eatMax = this.fish.length / EAT_SIZE_RATIO;
    const list = this.ecosystem.list;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive) continue;
      PULL.subVectors(ORIGIN, c.pos);
      const d = PULL.length();
      if (d > reach || d < 1e-3) continue;
      // Only what is in FRONT gets pulled — a suction, not an aura.
      if (-PULL.dot(FWD) / d < 0.1) continue;

      // Pull hardest at the mouth, so prey accelerates as it loses the fight.
      const grip = 1 - d / reach;
      const speed = 14 + grip * 34;
      c.pos.addScaledVector(PULL.normalize(), speed * dt);
      // Kill their own steering for a moment so they visibly stop swimming away.
      c.vel.multiplyScalar(0.86);
      c.stun(0.25);

      // Swallowed on arrival.
      if (d < this.fish.length * 0.7) {
        if (c.length <= eatMax) {
          c.die();
          this.ecosystem.onPlayerKill(c);
          this.combat.heal(9);
          this.combat.onFeed(c.length * 1.4);
        } else {
          // Too big to swallow — it still gets mauled against the beak.
          c.takeDamage(28);
        }
      }
    }
  }

  private trigger(kind: AbilityKind, duration: number): void {
    switch (kind) {
      case 'slip': {
        // Quick evasive dart in the facing direction + brief invulnerability.
        this.controller.lunge(28);
        this.combat.iframes(0.6);
        this.camera.punch(14);
        this.sfx.biteSwing();
        break;
      }
      case 'brace': {
        // Hunker down: soak half of all incoming damage for the duration.
        this.combat.guard(0.5, duration);
        this.camera.punch(6);
        this.sfx.stunHit();
        break;
      }
      case 'burst': {
        // Sprint surge; the wake scatters nearby prey.
        this.controller.boost(1.9, duration);
        this.ecosystem.alertPrey();
        this.camera.punch(10);
        this.sfx.biteSwing(0.85);
        break;
      }
      case 'inhale': {
        // Grouper suction feed: devour small prey in a wide arc ahead, then heal.
        this.controller.getForward(FWD);
        ORIGIN.copy(this.controller.pos).addScaledVector(FWD, this.fish.length * 0.5);
        const eatMax = this.fish.length / EAT_SIZE_RATIO;
        const res = this.ecosystem.playerBiteCone(
          ORIGIN,
          FWD,
          this.fish.length * 2.2,
          -0.2, // very wide arc — a gulp, not a bite
          eatMax,
          40,
          new Set<Creature>(),
        );
        if (res.eaten > 0) this.combat.heal(10 * res.eaten);
        if (res.biomass > 0) this.combat.onFeed(res.biomass); // eating grows the host
        this.camera.punch(8);
        this.sfx.biteLanded();
        break;
      }
      case 'ink': {
        // Vanish. The cloud itself is the ecosystem's existing "prey scatter"
        // signal turned against hunters: everything nearby loses track of the
        // host, and the host gets i-frames and a dart to break line of sight.
        this.ecosystem.alertPrey();
        this.ecosystem.blindHunters(duration);
        this.combat.iframes(0.8);
        this.controller.lunge(22);
        this.camera.punch(10);
        this.sfx.possessFail(); // a muffled, wrong-sounding whump suits ink
        break;
      }
      case 'glide': {
        // A long, fast, low-drag soar — distance and evasion rather than damage.
        this.controller.boost(1.75, duration);
        this.combat.iframes(0.5);
        this.camera.punch(8);
        this.sfx.biteSwing(0.6);
        break;
      }
      case 'suction': {
        // The magnapinna's whole identity. Everything in a wide cone ahead is
        // physically DRAGGED toward the mouth over the ability's duration and
        // swallowed on arrival — see PlayerAbility.update, which runs the pull
        // each frame rather than resolving it in one instant hit.
        this.suctionT = duration;
        this.camera.punch(6);
        this.sfx.stunHit();
        break;
      }
      case 'rampage': {
        // Apex of apexes: speed, damage soak, and a maw wide enough that the
        // charge itself is the attack.
        this.controller.boost(1.7, duration);
        this.combat.guard(0.45, duration);
        this.combat.iframes(0.6);
        this.combat.heal(this.combat.maxHealth * 0.08);
        this.camera.punch(24);
        this.sfx.carrierDeath();
        break;
      }
      case 'frenzy': {
        // Blood frenzy: a speed surge, brief i-frames, and a savage heal.
        this.controller.boost(1.5, duration);
        this.combat.iframes(0.4);
        this.combat.heal(this.combat.maxHealth * 0.1);
        this.camera.punch(16);
        this.sfx.possess();
        break;
      }
    }
  }
}
