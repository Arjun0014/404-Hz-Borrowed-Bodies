import { Quaternion, Vector3 } from 'three';
import type { Input } from '../core/Input';
import type { Terrain } from '../world/Terrain';
import type { PlayerFish } from '../entities/PlayerFish';
import type { PlayerCamera } from './PlayerCamera';
import { STEERING_SCHEME, WORLD } from '../config';

const AIM = new Vector3();
const DESIRED = new Vector3();
const RIGHT = new Vector3();
const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const LOOK_Q = new Quaternion();
const TMP = new Vector3();

/**
 * Underwater kinematic swim movement: thrust along camera aim, water drag,
 * limited turn rate, banking, and collision against terrain/surface/bounds.
 */
export class SwimController {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  speed01 = 0;

  private prevYaw = 0;
  private yawRate = 0;

  constructor(
    private readonly fish: PlayerFish,
    private readonly input: Input,
    private readonly camera: PlayerCamera,
    private readonly terrain: Terrain,
  ) {
    this.pos.set(WORLD.spawn.x, this.terrain.heightAt(WORLD.spawn.x, WORLD.spawn.z) + 3, WORLD.spawn.z);
    this.fish.object.position.copy(this.pos);
    // Face +X (toward the drop-off) to match the camera's spawn yaw.
    this.fish.object.quaternion.setFromAxisAngle(UP, Math.PI / 2);
    this.prevYaw = Math.PI / 2;
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
    const drag = inputActive ? mv.drag : mv.drag * 1.45;
    this.vel.multiplyScalar(Math.exp(-drag * dt));
    const speed = this.vel.length();
    if (speed > maxSpeed) this.vel.multiplyScalar(maxSpeed / speed);

    this.pos.addScaledVector(this.vel, dt);

    // --- collisions ----------------------------------------------------------
    const radius = this.fish.length * 0.45;

    // Terrain.
    const ground = this.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < ground + radius) {
      this.pos.y = ground + radius;
      if (this.vel.y < 0) this.vel.y *= -0.15;
    }
    // Surface.
    const ceiling = WORLD.surfaceY - 0.7;
    if (this.pos.y > ceiling) {
      this.pos.y = ceiling;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    // Phase 1 pit floor: gentle upwelling blocks deep descent until Phase 2.
    const dDrop = Math.hypot(this.pos.x - WORLD.dropCenter.x, this.pos.z - WORLD.dropCenter.z);
    if (dDrop < WORLD.dropRadius && this.pos.y < WORLD.pitFloorY) {
      this.vel.y += (WORLD.pitFloorY - this.pos.y) * 2.2 * dt + 4 * dt;
    }
    // Soft outer current, hard clamp beyond it.
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD.playableRadius) {
      TMP.set(-this.pos.x / r, 0, -this.pos.z / r);
      const push = Math.min(1, (r - WORLD.playableRadius) / 20);
      this.vel.addScaledVector(TMP, push * 14 * dt);
      if (r > WORLD.hardRadius) {
        this.pos.x *= WORLD.hardRadius / r;
        this.pos.z *= WORLD.hardRadius / r;
      }
    }

    // --- orientation ---------------------------------------------------------
    const speedNow = this.vel.length();
    this.speed01 = speedNow / mv.maxSpeed;
    // Face velocity when moving; face aim when idle.
    const faceDir = speedNow > 0.4 ? TMP.copy(this.vel).normalize() : TMP.copy(AIM);
    LOOK_Q.setFromUnitVectors(FORWARD, faceDir);
    const maxStep = mv.turnRate * dt;
    this.fish.object.quaternion.rotateTowards(LOOK_Q, maxStep);

    // Banking from yaw rate.
    const yaw = Math.atan2(faceDir.x, faceDir.z);
    let dYaw = yaw - this.prevYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.yawRate += (dYaw / Math.max(dt, 1e-4) - this.yawRate) * Math.min(1, 8 * dt);
    this.prevYaw = yaw;
    const bank = Math.max(-0.6, Math.min(0.6, -this.yawRate * 0.22 * Math.min(1, this.speed01 * 2)));
    this.fish.setBank(bank, dt);

    this.fish.object.position.copy(this.pos);
    this.fish.update(dt, Math.min(1, this.speed01));
  }
}
