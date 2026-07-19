import { Euler, Vector3 } from 'three';
import type { Input } from '../core/Input';
import type { CylinderCollider, TerrainLike, ZoneBounds } from '../world/types';
import type { PlayerFish } from '../entities/PlayerFish';
import type { PlayerCamera } from './PlayerCamera';
import { STEERING_SCHEME } from '../config';

const AIM = new Vector3();
const DESIRED = new Vector3();
const RIGHT = new Vector3();
const UP = new Vector3(0, 1, 0);
const LOOK_E = new Euler(0, 0, 0, 'YXZ');
const TMP = new Vector3();

/**
 * Underwater kinematic swim movement: thrust along camera aim, water drag,
 * limited turn rate, banking, and collision against terrain/surface/bounds.
 */
export class SwimController {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  speed01 = 0;
  /** 0..1 thrust intensity for water FX — full while dashing, light while cruising fast. */
  dashOutput = 0;

  /** Orientation as yaw/pitch scalars — roll is structurally impossible. */
  private curYaw = Math.PI / 2; // spawn facing +X (toward the drop-off)
  private curPitch = 0;
  private yawRate = 0;
  /** While >0, a lunge is carrying the fish faster than its normal max speed. */
  private lungeBoostT = 0;

  // Zone-scoped references, swapped on descent via bindZone().
  private terrain: TerrainLike;
  private colliders: CylinderCollider[];
  private bounds: ZoneBounds;

  constructor(
    private readonly fish: PlayerFish,
    private readonly input: Input,
    private readonly camera: PlayerCamera,
    terrain: TerrainLike,
    colliders: CylinderCollider[],
    bounds: ZoneBounds,
    spawn: Vector3,
  ) {
    this.terrain = terrain;
    this.colliders = colliders;
    this.bounds = bounds;
    this.placeAt(spawn);
  }

  /** Point the player at a spawn, level and at rest. */
  private placeAt(spawn: Vector3): void {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.speed01 = 0;
    this.dashOutput = 0;
    this.curYaw = Math.PI / 2;
    this.curPitch = 0;
    this.yawRate = 0;
    this.fish.object.position.copy(this.pos);
    LOOK_E.set(0, this.curYaw, 0);
    this.fish.object.quaternion.setFromEuler(LOOK_E);
  }

  /** Unit forward vector the fish is facing (from yaw/pitch). */
  getForward(out: Vector3): Vector3 {
    const cp = Math.cos(this.curPitch);
    return out.set(Math.sin(this.curYaw) * cp, -Math.sin(this.curPitch), Math.cos(this.curYaw) * cp);
  }

  /**
   * Add a forward burst of velocity (a bite/attack lunge) and open a short window
   * in which the normal max-speed clamp is lifted, so the burst actually carries
   * the fish a real distance instead of being capped away next frame.
   */
  lunge(speed: number): void {
    this.getForward(TMP);
    this.vel.addScaledVector(TMP, speed);
    this.lungeBoostT = 0.45;
  }

  /**
   * Reposition the host instantly and (optionally) face a direction — used by the
   * possession dash, which drives the body directly while normal control is
   * paused. Seeds the internal yaw/pitch so control resumes without a snap-turn.
   */
  warpTo(pos: Vector3, forward?: Vector3): void {
    this.pos.copy(pos);
    if (forward && forward.lengthSq() > 1e-6) {
      TMP.copy(forward).normalize();
      this.curYaw = Math.atan2(TMP.x, TMP.z);
      this.curPitch = -Math.asin(Math.max(-1, Math.min(1, TMP.y)));
    }
    this.fish.object.position.copy(this.pos);
    LOOK_E.set(this.curPitch, this.curYaw, 0);
    this.fish.object.quaternion.setFromEuler(LOOK_E);
  }

  /** Rebind to a new zone after descent and reposition at its spawn. */
  bindZone(terrain: TerrainLike, colliders: CylinderCollider[], bounds: ZoneBounds, spawn: Vector3): void {
    this.terrain = terrain;
    this.colliders = colliders;
    this.bounds = bounds;
    this.placeAt(spawn);
  }

  update(dt: number): void {
    const mv = this.fish.species.movement;
    const dashing = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
    const maxSpeed = mv.maxSpeed * (dashing ? mv.dashMultiplier : 1);

    // --- input → desired thrust direction -----------------------------------
    const thrust = this.input.axis('KeyW', 'KeyS');
    const strafe = this.input.axis('KeyD', 'KeyA');
    const vertical = this.input.axis('Space', 'KeyC');

    this.camera.getAimDir(AIM);
    if (STEERING_SCHEME === 'B') AIM.y = 0;
    AIM.normalize();
    RIGHT.crossVectors(AIM, UP).normalize();

    DESIRED.set(0, 0, 0)
      .addScaledVector(AIM, Math.max(thrust, thrust * 0.45)) // reverse is weak
      .addScaledVector(RIGHT, strafe * 0.55)
      .addScaledVector(UP, vertical * mv.verticalFactor);

    const inputActive = DESIRED.lengthSq() > 0.001;
    if (inputActive) {
      DESIRED.normalize();
      const accel = mv.accel * (dashing ? 1.7 : 1);
      this.vel.addScaledVector(DESIRED, accel * dt);
    }

    // --- water drag & speed clamp -------------------------------------------
    // During a lunge, drag is lighter and the max-speed cap is lifted so the
    // burst glides; drag then eases the fish back to normal speed on its own.
    this.lungeBoostT = Math.max(0, this.lungeBoostT - dt);
    const boosting = this.lungeBoostT > 0;
    const drag = boosting ? mv.drag * 0.35 : inputActive ? mv.drag : mv.drag * 1.45;
    this.vel.multiplyScalar(Math.exp(-drag * dt));
    const speed = this.vel.length();
    const cap = boosting ? Math.max(maxSpeed, speed) : maxSpeed;
    if (speed > cap) this.vel.multiplyScalar(cap / speed);

    this.pos.addScaledVector(this.vel, dt);

    // --- collisions ----------------------------------------------------------
    const radius = this.fish.length * 0.45;

    // Terrain.
    const ground = this.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < ground + radius) {
      this.pos.y = ground + radius;
      if (this.vel.y < 0) this.vel.y *= -0.15;
    }
    // Surface / zone ceiling (blocks backtracking upward in deeper zones).
    if (this.pos.y > this.bounds.ceilingY) {
      this.pos.y = this.bounds.ceilingY;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    // Solid obstacles (spires, monoliths): push out radially.
    for (const c of this.colliders) {
      if (this.pos.y > c.top + radius) continue;
      let dx = this.pos.x - c.x;
      let dz = this.pos.z - c.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-4) {
        // Degenerate: exactly at the axis — pick any outward direction.
        dx = 1;
        dz = 0;
        d = 1;
      }
      const minD = c.r + radius;
      if (d < minD) {
        const push = (minD - d) / d;
        this.pos.x += dx * push;
        this.pos.z += dz * push;
        // Kill the inward velocity component.
        const inward = (this.vel.x * dx + this.vel.z * dz) / (d * d);
        if (inward < 0) {
          this.vel.x -= dx * inward;
          this.vel.z -= dz * inward;
        }
      }
    }

    // Soft box current + hard clamp, per axis. The +X open edge is far out in
    // the deep, so the player can swim well past the shelf before it pushes.
    const b = this.bounds;
    const m = b.softMargin;
    if (this.pos.x > b.maxX) {
      const over = this.pos.x - b.maxX;
      this.vel.x -= Math.min(1, over / m) * 16 * dt;
      if (over > m) this.pos.x = b.maxX + m;
    } else if (this.pos.x < b.minX) {
      const over = b.minX - this.pos.x;
      this.vel.x += Math.min(1, over / m) * 16 * dt;
      if (over > m) this.pos.x = b.minX - m;
    }
    if (this.pos.z > b.maxZ) {
      const over = this.pos.z - b.maxZ;
      this.vel.z -= Math.min(1, over / m) * 16 * dt;
      if (over > m) this.pos.z = b.maxZ + m;
    } else if (this.pos.z < b.minZ) {
      const over = b.minZ - this.pos.z;
      this.vel.z += Math.min(1, over / m) * 16 * dt;
      if (over > m) this.pos.z = b.minZ - m;
    }

    // --- orientation ---------------------------------------------------------
    const speedNow = this.vel.length();
    this.speed01 = speedNow / mv.maxSpeed;
    this.dashOutput = dashing
      ? Math.min(1, this.speed01 / 1.3)
      : Math.max(0, this.speed01 - 0.6) * 0.5;
    // Face velocity when moving; face aim when idle. Orientation is tracked
    // as yaw/pitch scalars and rebuilt from Euler each frame, so roll (and
    // therefore an upside-down or slanted fish) is structurally impossible.
    // Banking is a separate visual layer on the model root.
    const faceDir = speedNow > 0.4 ? TMP.copy(this.vel).normalize() : TMP.copy(AIM);
    const targetYaw = Math.atan2(faceDir.x, faceDir.z);
    const targetPitch = -Math.asin(Math.min(1, Math.max(-1, faceDir.y)));
    const maxStep = mv.turnRate * this.fish.agility * dt;
    let dYaw = targetYaw - this.curYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const yawStep = Math.max(-maxStep, Math.min(maxStep, dYaw));
    this.curYaw += yawStep;
    if (this.curYaw > Math.PI) this.curYaw -= Math.PI * 2;
    if (this.curYaw < -Math.PI) this.curYaw += Math.PI * 2;
    const dPitch = targetPitch - this.curPitch;
    this.curPitch += Math.max(-maxStep, Math.min(maxStep, dPitch));
    this.curPitch = Math.max(-1.3, Math.min(1.3, this.curPitch));
    LOOK_E.set(this.curPitch, this.curYaw, 0);
    this.fish.object.quaternion.setFromEuler(LOOK_E);

    // Banking from actual yaw rate.
    this.yawRate += (yawStep / Math.max(dt, 1e-4) - this.yawRate) * Math.min(1, 8 * dt);
    const bank = Math.max(-0.6, Math.min(0.6, -this.yawRate * 0.22 * Math.min(1, this.speed01 * 2)));
    this.fish.setBank(bank, dt);

    this.fish.object.position.copy(this.pos);
    this.fish.update(dt, Math.min(1, this.speed01));
  }
}
