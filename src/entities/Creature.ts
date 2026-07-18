import { Euler, Vector3 } from 'three';
import type { CreatureSpecies } from '../data/creatures';
import { EAT_SIZE_RATIO, HUNT_THRESHOLD } from '../data/creatures';
import type { CreatureInstance } from './CreatureFactory';
import type { CylinderCollider, TerrainLike, ZoneBounds } from '../world/types';

/** Everything a creature needs from the ecosystem to think for one step. */
export interface EcoContext {
  dt: number;
  time: number;
  playerPos: Vector3;
  playerLength: number;
  terrain: TerrainLike;
  colliders: CylinderCollider[];
  bounds: ZoneBounds;
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

/** Can `a` eat `b`? Size-gated, with a couple of role rules. */
export function canEat(a: Creature, b: Creature): boolean {
  if (!b.alive || b === a) return false;
  if (b.species.role === 'crab') return false; // hard shell
  if (b.species.role === 'predator' && !a.species.apex) return false; // only the apex eats predators
  if (a.species.role === 'crab') return b.species.role === 'prey';
  if (a.species.apex || a.species.role === 'predator') return a.length >= b.length * EAT_SIZE_RATIO;
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

  // Crab-only.
  private onGround = false;
  private jumpCd = Math.random() * 4;
  private jumpTarget: Creature | null = null;

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
    this.alive = true;
    this.hunger = Math.random();
    this.preferredY = preferredY;
    this.onGround = false;
    this.jumpCd = 1 + Math.random() * 4;
    this.inst.root.visible = true;
    this.inst.root.position.copy(this.pos);
  }

  die(): void {
    this.alive = false;
    this.inst.root.visible = false;
    this.respawnTimer = 4 + Math.random() * 6;
  }

  /** One behaviour + physics step. Ecosystem controls how often this runs. */
  update(ctx: EcoContext): void {
    if (this.species.role === 'crab') this.crabUpdate(ctx);
    else this.fishUpdate(ctx);
  }

  // ---- fish ----------------------------------------------------------------

  private fishUpdate(ctx: EcoContext): void {
    const sp = this.species;
    const dt = ctx.dt;

    let predator: Creature | null = null;
    let predDist = Infinity;
    let prey: Creature | null = null;
    let preyDist = Infinity;
    let schoolN = 0;
    let sepN = 0;
    _sep.set(0, 0, 0);
    _ali.set(0, 0, 0);
    _coh.set(0, 0, 0);

    const ids = ctx.queryNeighbors(this.pos.x, this.pos.z, sp.senseRadius);
    for (let i = 0; i < ids.length; i++) {
      const o = ctx.creatures[ids[i]];
      if (o === this || !o.alive) continue;
      _tmp.subVectors(this.pos, o.pos);
      const d = _tmp.length();
      if (d < 1e-3 || d > sp.senseRadius) continue;

      const minSep = this.radius + o.radius + 0.6;
      if (d < minSep) {
        _sep.addScaledVector(_tmp, (minSep - d) / (d * minSep));
        sepN++;
      }
      if (sp.schooling && o.species.id === sp.id) {
        _coh.add(o.pos);
        _ali.add(o.vel);
        schoolN++;
      }
      if (canEat(o, this) && d < predDist) {
        predDist = d;
        predator = o;
      }
      if (canEat(this, o) && d < preyDist) {
        preyDist = d;
        prey = o;
      }
    }

    _desired.set(0, 0, 0);
    let boost = 1;
    const fleeR = Math.min(sp.senseRadius, this.length * 9 + 6);

    if (predator && predDist < fleeR) {
      this.state = 'flee';
      _tmp2.subVectors(this.pos, predator.pos).normalize();
      _desired.addScaledVector(_tmp2, 2.2);
      boost = 1.6;
    } else if (sp.role === 'predator' && this.hunger > HUNT_THRESHOLD && prey && preyDist < sp.senseRadius) {
      this.state = 'hunt';
      _tmp2.subVectors(prey.pos, this.pos).normalize();
      _desired.addScaledVector(_tmp2, 1.6);
      boost = 1.4;
      if (preyDist < this.radius + prey.radius + 0.5) {
        prey.die();
        this.hunger = 0;
      }
    } else if (sp.schooling && schoolN > 0) {
      this.state = 'school';
      _coh.multiplyScalar(1 / schoolN).sub(this.pos);
      if (_coh.lengthSq() > 1e-4) _desired.addScaledVector(_coh.normalize(), 0.55);
      _ali.multiplyScalar(1 / schoolN);
      if (_ali.lengthSq() > 1e-4) _desired.addScaledVector(_ali.normalize(), 0.7);
    } else {
      this.state = 'wander';
    }

    // Gentle heading wander (strong when idle, weak when reacting).
    this.wanderAngle += (Math.random() - 0.5) * sp.turnRate * dt * 1.6;
    _tmp.set(Math.sin(this.wanderAngle), 0, Math.cos(this.wanderAngle));
    _desired.addScaledVector(_tmp, this.state === 'wander' || this.state === 'school' ? 1 : 0.25);

    // Hold a preferred depth band.
    _desired.y += clamp((this.preferredY - this.pos.y) * 0.12, -0.5, 0.5);

    // Scatter away from the swimming player.
    _tmp.subVectors(this.pos, ctx.playerPos);
    const pd = _tmp.length();
    const scareR = this.length * 6 + 5;
    if (pd < scareR && pd > 1e-3) {
      _desired.addScaledVector(_tmp, ((scareR - pd) / (pd * scareR)) * 1.8);
      if (sp.role !== 'predator') boost = Math.max(boost, 1.35);
    }

    if (sepN > 0) _desired.addScaledVector(_sep, 1.3);
    this.steerToBounds(ctx.bounds);

    this.integrate(ctx, sp.maxSpeed * boost, true);
    this.hunger = Math.min(1, this.hunger + sp.hungerRate * dt);
    this.animate(ctx.dt);
  }

  // ---- crab ----------------------------------------------------------------

  private crabUpdate(ctx: EcoContext): void {
    const sp = this.species;
    const dt = ctx.dt;
    const ground = ctx.terrain.heightAt(this.pos.x, this.pos.z);
    const restY = ground + this.length * 0.3;

    if (this.onGround) {
      this.state = 'crab_scuttle';
      this.jumpCd -= dt;
      this.hunger = Math.min(1, this.hunger + sp.hungerRate * dt);

      // Ambush: launch at a fish passing low overhead.
      if (this.jumpCd <= 0 && this.hunger > HUNT_THRESHOLD) {
        const reach = 7;
        const ids = ctx.queryNeighbors(this.pos.x, this.pos.z, reach);
        let target: Creature | null = null;
        let best = Infinity;
        for (let i = 0; i < ids.length; i++) {
          const o = ctx.creatures[ids[i]];
          if (!o || o === this || !o.alive || o.species.role !== 'prey') continue;
          const dy = o.pos.y - restY;
          if (dy < 0.5 || dy > 6.5) continue;
          const hd = Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
          if (hd < reach && hd < best) {
            best = hd;
            target = o;
          }
        }
        if (target) {
          this.jumpTarget = target;
          this.onGround = false;
          this.state = 'crab_jump';
          _tmp.subVectors(target.pos, this.pos);
          this.vel.set(_tmp.x * 0.9, 13.5, _tmp.z * 0.9);
        }
      }

      if (this.onGround) {
        // Slow scuttle along the seabed.
        this.wanderAngle += (Math.random() - 0.5) * sp.turnRate * dt;
        _desired.set(Math.sin(this.wanderAngle), 0, Math.cos(this.wanderAngle));
        this.steerToBounds(ctx.bounds);
        _desired.y = 0;
        this.integrate(ctx, sp.maxSpeed, false);
        // Stick to the seabed.
        this.pos.y += (restY - this.pos.y) * Math.min(1, 8 * dt);
        this.vel.y = 0;
      }
    } else {
      // Airborne ambush arc.
      this.vel.y -= 16 * dt;
      this.pos.addScaledVector(this.vel, dt);
      const t = this.jumpTarget;
      if (t && t.alive) {
        const d = this.pos.distanceTo(t.pos);
        if (d < this.radius + t.radius + 0.6) {
          t.die();
          this.hunger = 0;
          this.jumpTarget = null;
        }
      }
      if (this.pos.y <= restY && this.vel.y < 0) {
        this.pos.y = restY;
        this.vel.set(0, 0, 0);
        this.onGround = true;
        this.jumpCd = 3 + Math.random() * 5;
        this.jumpTarget = null;
      }
    }

    // Upright: yaw toward horizontal motion, no pitch, subtle waddle.
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 0.2) this.yaw = Math.atan2(this.vel.x, this.vel.z);
    LOOK.set(0, this.yaw, Math.sin(ctx.time * 6 + this.wanderAngle) * 0.05);
    this.inst.root.quaternion.setFromEuler(LOOK);
    this.inst.root.position.copy(this.pos);
  }

  // ---- shared physics ------------------------------------------------------

  private steerToBounds(b: ZoneBounds): void {
    const m = 14;
    if (this.pos.x > b.maxX - m) _desired.x -= (this.pos.x - (b.maxX - m)) / m;
    else if (this.pos.x < b.minX + m) _desired.x += (b.minX + m - this.pos.x) / m;
    if (this.pos.z > b.maxZ - m) _desired.z -= (this.pos.z - (b.maxZ - m)) / m;
    else if (this.pos.z < b.minZ + m) _desired.z += (b.minZ + m - this.pos.z) / m;
  }

  private integrate(ctx: EcoContext, target: number, orient: boolean): void {
    const dt = ctx.dt;
    if (_desired.lengthSq() > 1e-6) _desired.normalize();
    // Accelerate velocity toward desired * target, capped by accel.
    _tmp.copy(_desired).multiplyScalar(target).sub(this.vel);
    const maxDV = this.species.accel * dt;
    if (_tmp.lengthSq() > maxDV * maxDV) _tmp.setLength(maxDV);
    this.vel.add(_tmp);
    const spd = this.vel.length();
    if (spd > target) this.vel.multiplyScalar(target / spd);
    this.pos.addScaledVector(this.vel, dt);

    // Terrain floor + surface ceiling.
    const ground = ctx.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < ground + this.radius) {
      this.pos.y = ground + this.radius;
      if (this.vel.y < 0) this.vel.y *= -0.2;
    }
    const ceil = ctx.bounds.ceilingY;
    if (this.pos.y > ceil) {
      this.pos.y = ceil;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    // Solid obstacles.
    const cols = ctx.colliders;
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
    // Hard box clamp.
    const b = ctx.bounds;
    this.pos.x = clamp(this.pos.x, b.minX, b.maxX);
    this.pos.z = clamp(this.pos.z, b.minZ, b.maxZ);

    if (orient) this.orient(dt, spd);
    this.inst.root.position.copy(this.pos);
  }

  private orient(dt: number, spd: number): void {
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
      this.pitch = clamp(this.pitch, -1.1, 1.1);
    }
    LOOK.set(this.pitch, this.yaw, 0);
    this.inst.root.quaternion.setFromEuler(LOOK);
  }

  private animate(dt: number): void {
    if (!this.inst.mixer) return;
    const spd01 = Math.min(1.4, this.vel.length() / this.species.maxSpeed);
    this.inst.mixer.update(dt * this.species.animSpeed * (0.5 + spd01 * 1.1));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
