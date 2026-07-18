import { Euler, Vector3 } from 'three';
import type { CreatureSpecies } from '../data/creatures';
import { EAT_SIZE_RATIO, FORAGER_HUNT_THRESHOLD, HUNT_THRESHOLD } from '../data/creatures';
import type { CreatureInstance } from './CreatureFactory';
import type { CylinderCollider, PopulationArea, TerrainLike, ZoneBounds } from '../world/types';

/** A schooling fish steers toward its shoal's roaming centre (owned by Ecosystem). */
export interface SchoolRef {
  center: Vector3;
  vel: Vector3;
}

/** Everything a creature needs from the ecosystem to think for one step. */
export interface EcoContext {
  time: number;
  playerPos: Vector3;
  playerLength: number;
  terrain: TerrainLike;
  colliders: CylinderCollider[];
  bounds: ZoneBounds;
  /** Horizontal habitat rectangle — the flat shelf, clear of walls and cliff. */
  habitat: PopulationArea;
  creatures: Creature[];
  /** Reused buffer of creature indices within `radius` of (x,z). */
  queryNeighbors(x: number, z: number, radius: number): number[];
}

export type CreatureState = 'wander' | 'school' | 'flee' | 'hunt' | 'crab_scuttle' | 'crab_jump';

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
  alive = true;
  hunger = Math.random();
  state: CreatureState = 'wander';

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

  spawn(x: number, y: number, z: number, preferredY: number, lengthMul = 1): void {
    this.length = this.species.baseLength * lengthMul;
    this.radius = this.length * 0.45;
    this.inst.root.scale.setScalar(lengthMul);
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
    this.onGround = false;
    this.jumpCd = 1 + Math.random() * 4;
    this.inst.root.visible = true;
    this.inst.root.position.copy(this.pos);
  }

  die(): void {
    this.alive = false;
    this.target = null;
    this.inst.root.visible = false;
    this.respawnTimer = 3 + Math.random() * 5;
  }

  // ---- think: decide a steering intent (throttled by distance) --------------

  think(ctx: EcoContext, dt: number): void {
    if (this.species.role === 'crab') this.crabThink(ctx, dt);
    else this.fishThink(ctx, dt);
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
    const fleeR = Math.min(sp.senseRadius, this.length * 10 + 8);

    if (predator && predDist < fleeR) {
      this.state = 'flee';
      _tmp2.subVectors(this.pos, predator.pos).normalize();
      _desired.addScaledVector(_tmp2, 2.4);
      boost = 1.7;
    } else if (prey && preyDist < sp.senseRadius) {
      this.state = 'hunt';
      this.target = prey;
      _tmp2.subVectors(prey.pos, this.pos).normalize();
      _desired.addScaledVector(_tmp2, 1.8);
      boost = sp.apex ? 1.3 : 1.5;
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

    // Scatter away from the swimming player (the apex is unbothered).
    if (!sp.apex) {
      _tmp.subVectors(this.pos, ctx.playerPos);
      const pd = _tmp.length();
      const scareR = this.length * 5 + 6;
      if (pd < scareR && pd > 1e-3) {
        _desired.addScaledVector(_tmp, ((scareR - pd) / (pd * scareR)) * 2.0);
        if (sp.role === 'prey' || sp.role === 'forager') boost = Math.max(boost, 1.4);
      }
    }

    if (sepN > 0) _desired.addScaledVector(_sep, 1.4);
    this.avoidTerrainAndObstacles(ctx);
    this.steerToHabitat(ctx.habitat);

    if (_desired.lengthSq() > 1e-6) _desired.normalize();
    else _desired.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.desiredDir.copy(_desired);
    this.desiredSpeed = sp.maxSpeed * boost;
    this.hunger = Math.min(1, this.hunger + sp.hungerRate * dt);
  }

  /** Predators/apex hunt above HUNT_THRESHOLD; foragers only when quite hungry. */
  private wantsToHunt(): boolean {
    const r = this.species.role;
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

    // Ambush: launch at a fish passing low overhead.
    if (this.jumpCd <= 0 && this.hunger > HUNT_THRESHOLD) {
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
    this.tryEat();
    this.orient(dt);
    this.inst.root.position.copy(this.pos);
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
    // Surface ceiling.
    const ceil = ctx.bounds.ceilingY;
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
