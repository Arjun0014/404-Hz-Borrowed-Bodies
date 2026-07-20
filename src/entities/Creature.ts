import { Euler, Vector3 } from 'three';
import type { CreatureSpecies } from '../data/creatures';
import { EAT_SIZE_RATIO, FORAGER_HUNT_THRESHOLD, HUNT_THRESHOLD } from '../data/creatures';
import { biteScaleAt, healthAt, lengthAt, lengthRatio } from '../data/growth';
import type { CreatureInstance } from './CreatureFactory';
import type { CylinderCollider, PopulationArea, TerrainLike, ZoneBounds } from '../world/types';

/** A schooling fish steers toward its shoal's roaming centre (owned by Ecosystem). */
export interface SchoolRef {
  center: Vector3;
  vel: Vector3;
  /** Shared base size of the shoal, so members and respawns stay same-sized. */
  growth: number;
}

/** Everything a creature needs from the ecosystem to think for one step. */
export interface EcoContext {
  time: number;
  playerPos: Vector3;
  playerLength: number;
  /** False once the host has died — creatures stop hunting/reacting to it. */
  playerAlive: boolean;
  /** >0 while the player is being aggressive nearby; prey flee it as a predator. */
  playerThreatT: number;
  terrain: TerrainLike;
  colliders: CylinderCollider[];
  bounds: ZoneBounds;
  /** Horizontal habitat rectangle — the flat shelf, clear of walls and cliff. */
  habitat: PopulationArea;
  creatures: Creature[];
  /** Reused buffer of creature indices within `radius` of (x,z). */
  queryNeighbors(x: number, z: number, radius: number): number[];
  /** A predator bit the player for `dmg`. */
  hitPlayer(dmg: number): void;
  /** While true, creatures are repelled from `spawnSafe` and can't bite there. */
  spawnSafeActive: boolean;
  spawnSafe: Vector3;
  spawnSafeR: number;

  // ---- Signal Carrier (Phase 12) ----
  /** The living Carrier's position, or null. Its aura enrages the predators
   *  around it into a garrison — the thing you must fight through to reach it. */
  carrierPos: Vector3 | null;
  carrierAuraR: number;
  /** True while the host is inside that aura (the garrison turns on it). */
  playerInAura: boolean;

  // ---- Dead Signal Field (Phase 13) ----
  /** The active field's centre, or null. Creatures inside it go frenzied. */
  fieldPos: Vector3 | null;
  fieldR: number;
  /** How far out the field's dead signal drags creatures toward the brawl. */
  fieldPullR: number;
}

/** Bite damage a predator deals to the host, by role. */
const PLAYER_BITE_DAMAGE: Record<string, number> = {
  grouper: 10,
  barracuda: 15,
  shark: 34,
};

export type CreatureState =
  | 'wander'
  | 'school'
  | 'flee'
  | 'hunt'
  | 'frenzy'
  | 'crab_scuttle'
  | 'crab_jump';

// ---- Frenzy (Phase 13) ----
// Inside a Dead Signal Field every creature attacks whatever is nearest, friend
// or foe. The frenzy brain is deliberately the cheapest in the game — one small
// neighbour query, nearest target, charge, bite — because this is the scene with
// the most simultaneous actors. No boids, no fear, no senses, no terrain
// look-ahead beyond the floor clamp that move() already applies.
const FRENZY_SENSE = 17; // how far a frenzied creature looks for something to maul
const FRENZY_BITE_CD = 1.1; // seconds between its bites
const FRENZY_SPEED = 1.45; // it swims at this multiple of its top speed
/**
 * Bite damage a frenzied creature deals, per meter of its own body length.
 * Tuned down from 9 after measuring: at 9 the field killed 25 creatures in three
 * seconds and stripped itself bare, which defeats the point — the field is meant
 * to leave WEAKENED bodies lying around for you to take, not corpses.
 */
const FRENZY_DMG_PER_LEN = 6;
/** Damage it deals to the host, per meter of body length (lower — you're armoured). */
const FRENZY_PLAYER_DMG_PER_LEN = 5;

// Module scratch — zero per-frame allocation.
const _sep = new Vector3();
const _ali = new Vector3();
const _coh = new Vector3();
const _desired = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const LOOK = new Euler(0, 0, 0, 'YXZ');

/** Can `a` eat `b`? Size-gated, with role rules. */
export function canEat(a: Creature, b: Creature): boolean {
  if (!b.alive || b === a) return false;
  if (b.species.role === 'crab') return false; // hard shell — nobody eats crabs
  if (a.species.role === 'crab') return b.species.role === 'prey';
  // Only the apex eats other predators (and other sharks).
  if (b.species.role === 'predator' && !a.species.apex) return false;
  if (a.species.apex) return a.length >= b.length * (EAT_SIZE_RATIO * 0.9);
  if (a.species.role === 'predator') return a.length >= b.length * EAT_SIZE_RATIO;
  // Foragers pick off much-smaller schooling prey.
  if (a.species.role === 'forager') {
    return b.species.role === 'prey' && a.length >= b.length * EAT_SIZE_RATIO;
  }
  return false;
}

export class Creature {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  length: number;
  radius: number;
  /** Size scalar 0..1 (min size → species ceiling). Drives length, HP, and bite. */
  growth01 = 0;
  alive = true;
  health = 1;
  maxHealth = 1;
  hunger = Math.random();
  state: CreatureState = 'wander';
  /** Set each frame by the possession system: weakened enough to be taken over. */
  stunReady = false;
  /** Seconds left in a stun (frozen + dazed) — the possession window. */
  stunT = 0;
  /** Seconds the apex will retaliate against the player after being attacked by it.
   *  Unprovoked, the shark ignores the host and just hunts other fish. */
  provokedT = 0;
  /** Seconds left in a Dead Signal Field frenzy (Phase 13). Refreshed while inside. */
  frenzyT = 0;
  private frenzyBiteCd = 0;

  /** This predator is currently going for the player. */
  private huntPlayer = false;
  /** Cooldown between lunge strikes, and the active-strike window timer. */
  private lungeCd = 0;
  private lungeT = 0;
  /** Seconds left to show this creature's floating HP bar after being hurt. */
  hpBarTimer = 0;

  get health01(): number {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  private yaw = Math.random() * Math.PI * 2;
  private pitch = 0;
  private wanderAngle = Math.random() * Math.PI * 2;
  preferredY = 0;
  respawnTimer = 0;
  /** Frame-stagger offset so not every creature thinks on the same frame. */
  phase = 0;

  /** Set by Ecosystem for schooling species; drives cohesion. */
  school: SchoolRef | null = null;

  // Steering intent — recomputed in think(), applied every frame in move().
  private readonly desiredDir = new Vector3(0, 0, 1);
  private desiredSpeed = 0;
  private target: Creature | null = null;

  // Crab-only.
  private onGround = false;
  private jumpCd = Math.random() * 4;

  constructor(
    readonly species: CreatureSpecies,
    readonly inst: CreatureInstance,
  ) {
    this.length = species.baseLength;
    this.radius = species.baseLength * 0.45;
  }

  spawn(x: number, y: number, z: number, preferredY: number, growth01 = 0): void {
    this.growth01 = growth01;
    this.length = lengthAt(this.species.baseLength, growth01);
    this.radius = this.length * 0.45;
    this.maxHealth = healthAt(this.species.baseHealth, growth01); // HP tied to size
    this.health = this.maxHealth;
    this.inst.root.scale.setScalar(lengthRatio(growth01));
    this.stunReady = false;
    this.stunT = 0;
    this.provokedT = 0;
    this.frenzyT = 0;
    this.frenzyBiteCd = 0;
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = Math.random() * Math.PI * 2;
    this.pitch = 0;
    this.desiredDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.desiredSpeed = this.species.maxSpeed * 0.5;
    this.alive = true;
    this.hunger = Math.random() * 0.6;
    this.preferredY = preferredY;
    this.target = null;
    this.huntPlayer = false;
    this.lungeCd = 0;
    this.lungeT = 0;
    this.hpBarTimer = 0;
    this.onGround = false;
    this.jumpCd = 1 + Math.random() * 4;
    this.inst.root.visible = true;
    this.inst.root.position.copy(this.pos);
  }

  /** The player attacked this creature — the apex retaliates for a while. */
  provoke(seconds = 10): void {
    this.provokedT = Math.max(this.provokedT, seconds);
  }

  /** Freeze the creature for a stun window (the possession takeover). */
  stun(seconds: number): void {
    this.stunT = seconds;
    this.stunReady = false;
    this.vel.set(0, 0, 0);
    this.target = null;
  }

  /** Take damage; returns true if this killed the creature. */
  takeDamage(dmg: number): boolean {
    if (!this.alive) return false;
    this.health -= dmg;
    if (this.health <= 0) {
      this.die();
      return true;
    }
    this.hpBarTimer = 4; // show a floating HP bar for a few seconds
    return false;
  }

  die(): void {
    this.alive = false;
    this.target = null;
    this.huntPlayer = false;
    this.stunReady = false;
    this.frenzyT = 0;
    this.inst.root.visible = false;
    this.respawnTimer = 3 + Math.random() * 5;
  }

  // ---- think: decide a steering intent (throttled by distance) --------------

  think(ctx: EcoContext, dt: number): void {
    if (this.stunT > 0) return; // dazed — no decisions while stunned
    if (this.species.role === 'crab') this.crabThink(ctx, dt);
    else if (this.frenzyT > 0) this.frenzyThink(ctx);
    else this.fishThink(ctx, dt);
  }

  /** Drag this creature into a Dead Signal Field frenzy (Ecosystem's director). */
  enterFrenzy(seconds: number): void {
    if (this.species.role === 'crab') return; // armoured seabed walkers sit it out
    this.frenzyT = Math.max(this.frenzyT, seconds);
  }

  /**
   * The frenzy brain: charge the nearest living thing and bite it. No allegiance,
   * no fear, no schooling — the dead signal strips everything else away. Costs one
   * short neighbour query per think, which is why the field can hold a crowd.
   */
  private frenzyThink(ctx: EcoContext): void {
    this.state = 'frenzy';
    this.target = null;
    this.huntPlayer = false;

    let best: Creature | null = null;
    let bestD = Infinity;
    const ids = ctx.queryNeighbors(this.pos.x, this.pos.z, FRENZY_SENSE);
    for (let i = 0; i < ids.length; i++) {
      const o = ctx.creatures[ids[i]];
      if (!o || o === this || !o.alive || o.species.role === 'crab') continue;
      const d = this.pos.distanceTo(o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }

    // The host is just another body in the water here.
    const pd = ctx.playerAlive ? this.pos.distanceTo(ctx.playerPos) : Infinity;
    if (pd < bestD && pd < FRENZY_SENSE) {
      this.huntPlayer = true;
      best = null;
      _desired.subVectors(ctx.playerPos, this.pos);
    } else if (best) {
      this.target = best;
      _desired.subVectors(best.pos, this.pos);
    } else {
      // Nothing in reach — thrash toward the field's heart and find something.
      if (ctx.fieldPos) _desired.subVectors(ctx.fieldPos, this.pos);
      else _desired.set(Math.sin(this.wanderAngle), 0, Math.cos(this.wanderAngle));
    }

    if (_desired.lengthSq() > 1e-6) _desired.normalize();
    else _desired.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.desiredDir.copy(_desired);
    this.desiredSpeed = this.species.maxSpeed * FRENZY_SPEED;
  }

  /** Maul whatever the frenzy is charging (creature or host). Real, resolvable damage. */
  private frenzyBite(ctx: EcoContext, dt: number): void {
    this.frenzyBiteCd -= dt;
    if (this.frenzyBiteCd > 0) return;

    const t = this.target;
    if (t && t.alive) {
      if (this.pos.distanceTo(t.pos) < this.radius + t.radius + 1.2) {
        t.takeDamage(this.length * FRENZY_DMG_PER_LEN);
        t.enterFrenzy(6); // being bitten drags the victim into the brawl too
        this.frenzyBiteCd = FRENZY_BITE_CD;
        this.hunger = Math.max(0, this.hunger - 0.4);
      }
      return;
    }
    if (this.huntPlayer && ctx.playerAlive) {
      // Reach is generous (this is a mob, not a duel) but the host's own damage
      // i-frames cap how fast a crowd can actually chew through it.
      const gape = this.radius + ctx.playerLength * 0.5 + 1.6;
      if (this.pos.distanceTo(ctx.playerPos) < gape) {
        ctx.hitPlayer(this.length * FRENZY_PLAYER_DMG_PER_LEN);
        this.frenzyBiteCd = FRENZY_BITE_CD;
      }
    }
  }

  private fishThink(ctx: EcoContext, dt: number): void {
    const sp = this.species;

    let predator: Creature | null = null;
    let predDist = Infinity;
    let prey: Creature | null = null;
    let preyDist = Infinity;
    let schoolN = 0;
    let sepN = 0;
    _sep.set(0, 0, 0);
    _ali.set(0, 0, 0);
    _coh.set(0, 0, 0);

    const wantsPrey = this.wantsToHunt();
    const ids = ctx.queryNeighbors(this.pos.x, this.pos.z, sp.senseRadius);
    for (let i = 0; i < ids.length; i++) {
      const o = ctx.creatures[ids[i]];
      if (o === this || !o.alive) continue;
      _tmp.subVectors(this.pos, o.pos);
      const d = _tmp.length();
      if (d < 1e-3 || d > sp.senseRadius) continue;

      const minSep = this.radius + o.radius + 0.8;
      if (d < minSep) {
        _sep.addScaledVector(_tmp, (minSep - d) / (d * minSep));
        sepN++;
      }
      if (sp.schooling && o.species.id === sp.id) {
        _coh.add(o.pos);
        _ali.add(o.vel);
        schoolN++;
      }
      // Something that can eat us? (apex never fears anything.)
      if (!sp.apex && canEat(o, this) && d < predDist) {
        predDist = d;
        predator = o;
      }
      if (wantsPrey && canEat(this, o) && d < preyDist) {
        preyDist = d;
        prey = o;
      }
    }

    _desired.set(0, 0, 0);
    let boost = 1;
    this.target = null;
    this.huntPlayer = false;
    const fleeR = Math.min(sp.senseRadius, this.length * 10 + 8);

    // Distance to the host — a threat to flee, or (for predators) prey to hunt.
    _tmp.subVectors(this.pos, ctx.playerPos);
    const playerDist = _tmp.length();
    // Normal predators hunt the host on sight. The apex (shark) does NOT — it
    // minds its own business, hunting other fish, and only turns on the host once
    // the host has attacked it (provokedT), then chases for a while.
    // Carrier garrison (Phase 12): the relay's aura enrages the predators holding
    // station around it. An enraged predator will go for the host regardless of
    // size or provocation — that pressure IS the encounter's defence, in place of
    // the entity's own minions (moved to a later phase).
    let enraged = false;
    if (ctx.carrierPos && sp.role === 'predator') {
      const dc = this.pos.distanceTo(ctx.carrierPos);
      if (dc < ctx.carrierAuraR) {
        enraged = ctx.playerInAura;
        // Leash: hold station near the relay rather than wandering off the fight.
        if (dc > ctx.carrierAuraR * 0.62) {
          _tmp2.subVectors(ctx.carrierPos, this.pos).normalize();
          _desired.addScaledVector(_tmp2, 1.2);
        }
      }
    }
    const canEatPlayer =
      ctx.playerAlive &&
      sp.role === 'predator' &&
      (enraged || this.length >= ctx.playerLength * EAT_SIZE_RATIO) &&
      (!sp.apex || enraged || this.provokedT > 0);
    // The host is a juicy target: hunted when close (<14 m) or nearly as near as
    // the closest fish prey, so lingering next to a predator gets you bitten even
    // in a crowd — but you're fast enough to dash away.
    // An enraged garrison predator hunts on sight, hungry or not, from further out.
    const huntReach = enraged ? sp.senseRadius * 1.5 : sp.senseRadius;
    if (
      canEatPlayer &&
      (wantsPrey || enraged) &&
      playerDist < huntReach &&
      (enraged || playerDist < 14 || playerDist < preyDist + 6)
    ) {
      this.huntPlayer = true;
      prey = null;
    }
    // Prey/foragers flee the host while it is attacking nearby.
    const playerIsThreat =
      ctx.playerAlive && ctx.playerThreatT > 0 && (sp.role === 'prey' || sp.role === 'forager');

    if (predator && predDist < fleeR) {
      this.state = 'flee';
      _tmp2.subVectors(this.pos, predator.pos).normalize();
      _desired.addScaledVector(_tmp2, 2.4);
      boost = 1.7;
    } else if (playerIsThreat && playerDist < fleeR) {
      this.state = 'flee';
      _tmp2.subVectors(this.pos, ctx.playerPos).normalize();
      _desired.addScaledVector(_tmp2, 2.4);
      boost = 1.7;
    } else if (this.huntPlayer) {
      this.state = 'hunt';
      _tmp2.subVectors(ctx.playerPos, this.pos).normalize();
      // The apex commits hard and never brakes — a fast straight-line charge.
      // Others ease in close so they can turn in and strike instead of orbiting.
      _desired.addScaledVector(_tmp2, sp.apex ? 3.2 : 2.2);
      boost = sp.apex ? 1.85 : playerDist < 6 ? 0.6 : 1.5;
    } else if (prey && preyDist < sp.senseRadius) {
      this.state = 'hunt';
      this.target = prey;
      _tmp2.subVectors(prey.pos, this.pos).normalize();
      _desired.addScaledVector(_tmp2, sp.apex ? 3.2 : 1.8);
      boost = sp.apex ? 1.85 : 1.5; // shark barrels straight through at full tilt
    } else if (this.school) {
      this.state = 'school';
      // Strong pull to the shoal centre keeps the school coherent.
      _tmp2.subVectors(this.school.center, this.pos);
      const dc = _tmp2.length();
      if (dc > 1e-3) _desired.addScaledVector(_tmp2, (0.9 + Math.min(dc, 20) * 0.04) / dc);
      if (this.school.vel.lengthSq() > 1e-4) {
        _tmp2.copy(this.school.vel).normalize();
        _desired.addScaledVector(_tmp2, 0.5);
      }
      if (schoolN > 0 && _ali.lengthSq() > 1e-4) {
        _desired.addScaledVector(_ali.multiplyScalar(1 / schoolN).normalize(), 0.4);
      }
    } else if (sp.schooling && schoolN > 0) {
      // Fallback boids if a schooling fish somehow has no shoal.
      this.state = 'school';
      _coh.multiplyScalar(1 / schoolN).sub(this.pos);
      if (_coh.lengthSq() > 1e-4) _desired.addScaledVector(_coh.normalize(), 0.6);
      _ali.multiplyScalar(1 / schoolN);
      if (_ali.lengthSq() > 1e-4) _desired.addScaledVector(_ali.normalize(), 0.7);
    } else {
      this.state = 'wander';
    }

    // Gentle heading wander (strong when idle, weak when reacting).
    this.wanderAngle += (Math.random() - 0.5) * sp.turnRate * dt * 1.6;
    _tmp.set(Math.sin(this.wanderAngle), 0, Math.cos(this.wanderAngle));
    _desired.addScaledVector(_tmp, this.state === 'wander' ? 1 : this.state === 'school' ? 0.35 : 0.2);

    // Hold a preferred depth band.
    _desired.y += clamp((this.preferredY - this.pos.y) * 0.14, -0.6, 0.6);

    // Prey/foragers scatter away from the swimming player; predators do not
    // (they hunt it), and the apex is unbothered by anything.
    if (sp.role === 'prey' || sp.role === 'forager') {
      _tmp.subVectors(this.pos, ctx.playerPos);
      const pd = _tmp.length();
      const scareR = this.length * 5 + 6;
      if (pd < scareR && pd > 1e-3) {
        _desired.addScaledVector(_tmp, ((scareR - pd) / (pd * scareR)) * 2.0);
        boost = Math.max(boost, 1.4);
      }
    }

    // Dead Signal Field (Phase 13): the collapse draws the local ecosystem in.
    // Only a pull — the actual frenzy is switched on by the Ecosystem's director
    // once a creature is inside, so the convergence reads as curiosity turning to
    // violence rather than everything teleporting into a brawl.
    if (ctx.fieldPos) {
      _tmp.subVectors(ctx.fieldPos, this.pos);
      const fd = _tmp.length();
      if (fd < ctx.fieldPullR && fd > 1e-3) {
        _desired.addScaledVector(_tmp, 1.6 / fd);
        boost = Math.max(boost, 1.3);
      }
    }

    // Stay out of the player's spawn-safe bubble at the start of a zone.
    if (ctx.spawnSafeActive) {
      _tmp.subVectors(this.pos, ctx.spawnSafe);
      _tmp.y = 0;
      const sd = _tmp.length();
      const rr = ctx.spawnSafeR + 12;
      if (sd < rr && sd > 1e-3) {
        _desired.addScaledVector(_tmp, (2.6 * (1 - sd / rr)) / sd);
        boost = Math.max(boost, 1.35);
        if (this.huntPlayer) this.huntPlayer = false; // never chase into the safe zone
      }
    }

    // A committed hunter barrels through the crowd (light separation) so it can
    // actually reach its target instead of being held off at the crowd's edge.
    // The apex ignores crowding entirely — it swims straight through the shoal.
    if (sepN > 0) _desired.addScaledVector(_sep, this.huntPlayer || sp.apex ? 0.4 : 1.4);
    this.avoidTerrainAndObstacles(ctx);
    this.steerToHabitat(ctx.habitat);

    if (_desired.lengthSq() > 1e-6) _desired.normalize();
    else _desired.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.desiredDir.copy(_desired);
    this.desiredSpeed = sp.maxSpeed * boost;
    this.hunger = Math.min(1, this.hunger + sp.hungerRate * dt);
  }

  /** Predators hunt above HUNT_THRESHOLD; the apex always prowls; foragers rarely. */
  private wantsToHunt(): boolean {
    const r = this.species.role;
    if (this.species.apex) return true; // the shark is always on the hunt
    if (r === 'predator') return this.hunger > HUNT_THRESHOLD;
    if (r === 'forager') return this.hunger > FORAGER_HUNT_THRESHOLD;
    return false;
  }

  /** Steer around rising terrain (mesas/pinnacles/walls) and rock colliders. */
  private avoidTerrainAndObstacles(ctx: EcoContext): void {
    const dir = _tmp2.copy(this.desiredDir);
    if (dir.lengthSq() < 1e-6) dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    dir.y = 0;
    const hLen = Math.hypot(dir.x, dir.z);
    if (hLen < 1e-4) return;
    dir.x /= hLen;
    dir.z /= hLen;

    // Terrain look-ahead: sample the seabed a body-length or two ahead.
    const ahead = 5 + this.length * 2.5;
    const belly = this.pos.y - this.radius - 1.2;
    const gAhead = ctx.terrain.heightAt(this.pos.x + dir.x * ahead, this.pos.z + dir.z * ahead);
    if (gAhead > belly) {
      // Ground rises into our path: compare left/right and veer to the lower side,
      // and add lift so we clear low humps rather than plough in.
      const lx = -dir.z;
      const lz = dir.x;
      const gl = ctx.terrain.heightAt(this.pos.x + lx * ahead, this.pos.z + lz * ahead);
      const gr = ctx.terrain.heightAt(this.pos.x - lx * ahead, this.pos.z - lz * ahead);
      const sign = gl < gr ? 1 : -1;
      const urgency = clamp((gAhead - belly) / 8, 0.3, 1.6);
      _desired.x += lx * sign * urgency * 2.2;
      _desired.z += lz * sign * urgency * 2.2;
      _desired.y += urgency * 0.8;
    }

    // Rock colliders: turn away from any we're heading into.
    const cols = ctx.colliders;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (this.pos.y > c.top + this.radius + 2) continue;
      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const d = Math.hypot(dx, dz);
      const avoidR = c.r + this.radius + 7;
      if (d > 1e-3 && d < avoidR) {
        const w = (avoidR - d) / (d * avoidR);
        _desired.x += dx * w * 3.0;
        _desired.z += dz * w * 3.0;
      }
    }
  }

  private crabThink(ctx: EcoContext, dt: number): void {
    const sp = this.species;
    if (!this.onGround) return; // airborne arc is pure physics (see crabMove)

    this.state = 'crab_scuttle';
    this.jumpCd -= dt;
    this.hunger = Math.min(1, this.hunger + sp.hungerRate * dt);

    // Scuttle out of the player's spawn-safe bubble and don't ambush from inside it.
    let inSafe = false;
    if (ctx.spawnSafeActive) {
      const dx = this.pos.x - ctx.spawnSafe.x;
      const dz = this.pos.z - ctx.spawnSafe.z;
      const sd = Math.hypot(dx, dz);
      if (sd < ctx.spawnSafeR + 12) {
        inSafe = true;
        if (sd > 1e-3) {
          this.desiredDir.set(dx / sd, 0, dz / sd);
          this.desiredSpeed = sp.maxSpeed;
          return;
        }
      }
    }

    // Ambush: launch at a fish passing low overhead.
    if (!inSafe && this.jumpCd <= 0 && this.hunger > HUNT_THRESHOLD) {
      const reach = 8;
      const restY = ctx.terrain.heightAt(this.pos.x, this.pos.z) + this.length * 0.3;
      const ids = ctx.queryNeighbors(this.pos.x, this.pos.z, reach);
      let best = Infinity;
      let target: Creature | null = null;
      for (let i = 0; i < ids.length; i++) {
        const o = ctx.creatures[ids[i]];
        if (!o || o === this || !o.alive || o.species.role !== 'prey') continue;
        const dy = o.pos.y - restY;
        if (dy < 0.5 || dy > 7) continue;
        const hd = Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
        if (hd < reach && hd < best) {
          best = hd;
          target = o;
        }
      }
      if (target) {
        this.target = target;
        this.onGround = false;
        this.state = 'crab_jump';
        _tmp.subVectors(target.pos, this.pos);
        this.vel.set(_tmp.x * 0.95, 14, _tmp.z * 0.95);
        return;
      }
    }

    // Slow scuttle heading.
    this.wanderAngle += (Math.random() - 0.5) * sp.turnRate * dt;
    this.desiredDir.set(Math.sin(this.wanderAngle), 0, Math.cos(this.wanderAngle));
    this.desiredSpeed = sp.maxSpeed;
  }

  // ---- move: integrate physics every frame (smooth motion) ------------------

  move(ctx: EcoContext, dt: number): void {
    if (this.stunT > 0) {
      this.stunT -= dt;
      this.vel.multiplyScalar(0.82); // bleed off momentum, hold roughly in place
      this.pos.addScaledVector(this.vel, dt);
      if (this.hpBarTimer > 0) this.hpBarTimer -= dt;
      // Dazed wobble so a stunned target reads clearly as vulnerable.
      LOOK.set(Math.sin(ctx.time * 22) * 0.35, this.yaw + ctx.time * 3, Math.sin(ctx.time * 17) * 0.25);
      this.inst.root.quaternion.setFromEuler(LOOK);
      this.inst.root.position.copy(this.pos);
      return;
    }
    if (this.species.role === 'crab') this.crabMove(ctx, dt);
    else this.fishMove(ctx, dt);
  }

  private fishMove(ctx: EcoContext, dt: number): void {
    const sp = this.species;
    // Accelerate velocity toward desiredDir * desiredSpeed, capped by accel.
    _tmp.copy(this.desiredDir).multiplyScalar(this.desiredSpeed).sub(this.vel);
    const maxDV = sp.accel * dt;
    if (_tmp.lengthSq() > maxDV * maxDV) _tmp.setLength(maxDV);
    this.vel.add(_tmp);
    const spd = this.vel.length();
    if (spd > this.desiredSpeed && this.desiredSpeed > 1e-3) {
      this.vel.multiplyScalar(this.desiredSpeed / spd);
    }
    this.pos.addScaledVector(this.vel, dt);

    this.resolveCollisions(ctx);
    if (this.frenzyT > 0) {
      // In a frenzy nothing is swallowed whole — creatures tear at each other and
      // leave weakened survivors, which is what makes the field worth entering.
      this.frenzyT -= dt;
      this.frenzyBite(ctx, dt);
    } else {
      this.tryEat();
      if (this.species.apex) this.apexSweepEat(ctx); // devours anything in its path
      this.strikePlayer(ctx, dt);
    }
    if (this.hpBarTimer > 0) this.hpBarTimer -= dt;
    if (this.provokedT > 0) this.provokedT -= dt;
    this.orient(dt);
    this.inst.root.position.copy(this.pos);
  }

  /**
   * Apex only: eat every edible creature the shark physically overlaps as it
   * charges, not just its chosen target — so anything caught in its straight-line
   * path is swallowed. (The player is damaged separately, via strikePlayer.)
   */
  private apexSweepEat(ctx: EcoContext): void {
    const maw = this.radius + 2.2; // a wide swallowing gape ahead/around the head
    const ids = ctx.queryNeighbors(this.pos.x, this.pos.z, maw + 3);
    for (let i = 0; i < ids.length; i++) {
      const o = ctx.creatures[ids[i]];
      if (!o || o === this || !o.alive) continue;
      if (this.pos.distanceTo(o.pos) < maw + o.radius && canEat(this, o)) {
        o.die();
        this.hunger = Math.max(0, this.hunger - 0.3);
      }
    }
  }

  /**
   * A hunting predator lunges at the host and only lands damage with its MOUTH —
   * the player must be in front of the head (heading cone) AND close to the
   * snout. Brushing the body/side never hurts. Telegraphed forward burst so it
   * reads and can be dodged.
   */
  private strikePlayer(ctx: EcoContext, dt: number): void {
    this.lungeCd -= dt;
    this.lungeT -= dt;
    if (!this.huntPlayer || !ctx.playerAlive) return;
    // Never bite inside the spawn-safe bubble.
    if (ctx.spawnSafeActive) {
      const sdx = ctx.playerPos.x - ctx.spawnSafe.x;
      const sdz = ctx.playerPos.z - ctx.spawnSafe.z;
      if (Math.hypot(sdx, sdz) < ctx.spawnSafeR) return;
    }

    _tmp.subVectors(ctx.playerPos, this.pos);
    const d = _tmp.length();
    if (d < 1e-3) return;
    _tmp.multiplyScalar(1 / d); // unit toward player

    // The direction the head actually points (from yaw/pitch), not velocity.
    const cp = Math.cos(this.pitch);
    _tmp2.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const headingDot = _tmp2.dot(_tmp); // player in front of the head?

    // Begin a lunge when in range and the head is aimed at the host.
    const lungeRange = this.radius + ctx.playerLength + 4.5;
    if (this.lungeCd <= 0 && d < lungeRange && headingDot > 0.55) {
      this.vel.addScaledVector(_tmp2, this.species.maxSpeed * 1.7);
      this.lungeT = 0.45;
      this.lungeCd = 1.8 + Math.random() * 0.8;
    }

    // Damage lands only from the MOUTH: the snout point must be within the host's
    // body, and the host must sit in a tight front cone. Bigger predators bite harder.
    const mouthX = this.pos.x + _tmp2.x * this.length * 0.55;
    const mouthY = this.pos.y + _tmp2.y * this.length * 0.55;
    const mouthZ = this.pos.z + _tmp2.z * this.length * 0.55;
    const mouthDist = Math.hypot(
      ctx.playerPos.x - mouthX,
      ctx.playerPos.y - mouthY,
      ctx.playerPos.z - mouthZ,
    );
    const gape = ctx.playerLength * 0.5 + this.length * 0.22 + 0.4;
    if (this.lungeT > 0 && headingDot > 0.6 && mouthDist < gape) {
      const base = PLAYER_BITE_DAMAGE[this.species.id] ?? 8;
      ctx.hitPlayer(base * biteScaleAt(this.growth01));
      this.lungeT = 0;
      this.lungeCd = Math.max(this.lungeCd, 1.4);
      this.hunger = Math.max(0, this.hunger - 0.5);
    }
  }

  private crabMove(ctx: EcoContext, dt: number): void {
    const sp = this.species;
    const restY = ctx.terrain.heightAt(this.pos.x, this.pos.z) + this.length * 0.3;

    if (this.onGround) {
      // Horizontal scuttle.
      _tmp.copy(this.desiredDir).setY(0).multiplyScalar(sp.maxSpeed).sub(_tmp2.copy(this.vel).setY(0));
      const maxDV = sp.accel * dt;
      if (_tmp.lengthSq() > maxDV * maxDV) _tmp.setLength(maxDV);
      this.vel.x += _tmp.x;
      this.vel.z += _tmp.z;
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > sp.maxSpeed) {
        this.vel.x *= sp.maxSpeed / hs;
        this.vel.z *= sp.maxSpeed / hs;
      }
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pushOffColliders(ctx.colliders);
      this.clampToHabitat(ctx.habitat);
      this.pos.y += (restY - this.pos.y) * Math.min(1, 8 * dt);
      this.vel.y = 0;
    } else {
      // Ballistic ambush arc — integrated every frame for a clean parabola.
      this.vel.y -= 16 * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.clampToHabitat(ctx.habitat);
      const t = this.target;
      if (t && t.alive && this.pos.distanceTo(t.pos) < this.radius + t.radius + 0.7) {
        t.die();
        this.hunger = 0;
        this.target = null;
      }
      if (this.pos.y <= restY && this.vel.y < 0) {
        this.pos.y = restY;
        this.vel.set(0, 0, 0);
        this.onGround = true;
        this.jumpCd = 3 + Math.random() * 5;
        this.target = null;
      }
    }

    if (this.hpBarTimer > 0) this.hpBarTimer -= dt;

    // Upright: yaw toward horizontal motion, subtle waddle.
    const hspd = Math.hypot(this.vel.x, this.vel.z);
    if (hspd > 0.2) this.yaw = Math.atan2(this.vel.x, this.vel.z);
    LOOK.set(0, this.yaw, Math.sin(ctx.time * 6 + this.wanderAngle) * 0.05);
    this.inst.root.quaternion.setFromEuler(LOOK);
    this.inst.root.position.copy(this.pos);
  }

  /** Snap-catch the current prey when we reach it. */
  private tryEat(): void {
    const t = this.target;
    if (!t) return;
    if (!t.alive) {
      this.target = null;
      return;
    }
    if (this.pos.distanceTo(t.pos) < this.radius + t.radius + 0.6 && canEat(this, t)) {
      t.die();
      this.hunger = 0;
      this.target = null;
    }
  }

  // ---- shared physics -------------------------------------------------------

  private resolveCollisions(ctx: EcoContext): void {
    // Terrain floor.
    const ground = ctx.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < ground + this.radius) {
      this.pos.y = ground + this.radius;
      if (this.vel.y < 0) this.vel.y *= -0.2;
    }
    // Surface ceiling, or the rock roof in an enclosed zone — lower wins, so
    // fish in the Drowned Garden stay under the vault instead of swimming
    // through it.
    const rock = ctx.terrain.ceilingAt?.(this.pos.x, this.pos.z);
    const ceil =
      rock === undefined ? ctx.bounds.ceilingY : Math.min(ctx.bounds.ceilingY, rock - this.radius);
    if (this.pos.y > ceil) {
      this.pos.y = ceil;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    this.pushOffColliders(ctx.colliders);
    this.clampToHabitat(ctx.habitat);
  }

  private pushOffColliders(cols: CylinderCollider[]): void {
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (this.pos.y > c.top + this.radius) continue;
      let dx = this.pos.x - c.x;
      let dz = this.pos.z - c.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-4) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      const minD = c.r + this.radius;
      if (d < minD) {
        const push = (minD - d) / d;
        this.pos.x += dx * push;
        this.pos.z += dz * push;
        const inward = (this.vel.x * dx + this.vel.z * dz) / (d * d);
        if (inward < 0) {
          this.vel.x -= dx * inward;
          this.vel.z -= dz * inward;
        }
      }
    }
  }

  /** Keep fish on the flat shelf (habitat), never over the cliff or into walls. */
  private clampToHabitat(h: PopulationArea): void {
    if (this.pos.x < h.minX) {
      this.pos.x = h.minX;
      if (this.vel.x < 0) this.vel.x = 0;
    } else if (this.pos.x > h.maxX) {
      this.pos.x = h.maxX;
      if (this.vel.x > 0) this.vel.x = 0;
    }
    if (this.pos.z < h.minZ) {
      this.pos.z = h.minZ;
      if (this.vel.z < 0) this.vel.z = 0;
    } else if (this.pos.z > h.maxZ) {
      this.pos.z = h.maxZ;
      if (this.vel.z > 0) this.vel.z = 0;
    }
  }

  /** Soft turn back toward the habitat interior before hitting the hard clamp. */
  private steerToHabitat(h: PopulationArea): void {
    const m = 20;
    if (this.pos.x > h.maxX - m) _desired.x -= (this.pos.x - (h.maxX - m)) / m;
    else if (this.pos.x < h.minX + m) _desired.x += (h.minX + m - this.pos.x) / m;
    if (this.pos.z > h.maxZ - m) _desired.z -= (this.pos.z - (h.maxZ - m)) / m;
    else if (this.pos.z < h.minZ + m) _desired.z += (h.minZ + m - this.pos.z) / m;
  }

  private orient(dt: number): void {
    const spd = this.vel.length();
    if (spd > 0.3) {
      _tmp.copy(this.vel).multiplyScalar(1 / spd);
      const targetYaw = Math.atan2(_tmp.x, _tmp.z);
      const targetPitch = -Math.asin(clamp(_tmp.y, -1, 1));
      const maxStep = this.species.turnRate * dt;
      let dY = targetYaw - this.yaw;
      if (dY > Math.PI) dY -= Math.PI * 2;
      if (dY < -Math.PI) dY += Math.PI * 2;
      this.yaw += clamp(dY, -maxStep, maxStep);
      this.pitch += clamp(targetPitch - this.pitch, -maxStep, maxStep);
      this.pitch = clamp(this.pitch, -1.0, 1.0);
    }
    LOOK.set(this.pitch, this.yaw, 0);
    this.inst.root.quaternion.setFromEuler(LOOK);
  }

  animate(dt: number): void {
    if (!this.inst.mixer) return;
    const spd01 = Math.min(1.4, this.vel.length() / this.species.maxSpeed);
    this.inst.mixer.update(dt * this.species.animSpeed * (0.5 + spd01 * 1.1));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
