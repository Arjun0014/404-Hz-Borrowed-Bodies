import { Euler, Vector3 } from 'three';
import type { Input } from '../core/Input';
import type { CylinderCollider, TerrainLike, Zone, ZoneBounds } from '../world/types';
import type { PlayerFish } from '../entities/PlayerFish';
import type { PlayerCamera } from './PlayerCamera';
import type { MovementDef } from '../data/species';
import { STEERING_SCHEME } from '../config';

const AIM = new Vector3();
const DESIRED = new Vector3();
const RIGHT = new Vector3();
const UP = new Vector3(0, 1, 0);
const LOOK_E = new Euler(0, 0, 0, 'YXZ');
const TMP = new Vector3();
const CURRENT = new Vector3();

// Crab (crawl) locomotion.
const CRAB_GRAVITY = 22; // fall accel (m/s²) once airborne
const CRAB_JUMP = 9; // hop launch speed

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

  // --- sprint (Shift) stamina -------------------------------------------------
  /** 0..1 sprint energy: drains while sprinting, refills when you let off. */
  private stamina = 1;
  /** True the frames the host is actually sprinting (bar has charge + moving). */
  sprinting = false;
  /** 0..1 HUD reveal: 1 while sprinting, eases to 0 once you stop (bar hides). */
  staminaShow = 0;
  /** After a full drain, block sprint until the bar recovers past a threshold. */
  private sprintLockout = false;
  /**
   * Smoothed 0..1 sprint intensity. Engages fast, but RELEASES slowly so the
   * max-speed cap glides back down to cruise instead of snapping the instant you
   * let off Shift — drives both the speed multiplier and the "rushing water" FX.
   */
  private sprintRamp = 0;

  /** 0..1 remaining sprint energy (for the energy HUD). */
  get stamina01(): number {
    return this.stamina;
  }

  /** Orientation as yaw/pitch scalars — roll is structurally impossible. */
  private curYaw = Math.PI / 2; // spawn facing +X (toward the drop-off)
  private curPitch = 0;
  private yawRate = 0;
  /** While >0, a lunge is carrying the fish faster than its normal max speed. */
  private lungeBoostT = 0;
  /** Ability speed boost (Burst/Frenzy): a temporary max-speed multiplier. */
  private boostT = 0;
  private boostMult = 1;
  /** Crab crawl: true while resting on the seabed (can jump). */
  private grounded = false;
  /** Speed of the ambient current carrying the host right now, m/s. */
  currentSpeed = 0;
  /** The zone, for its ambient current. Swapped on descent via bindZone(). */
  private zone: Zone | null = null;

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
    zone?: Zone,
  ) {
    this.terrain = terrain;
    this.colliders = colliders;
    this.bounds = bounds;
    this.zone = zone ?? null;
    this.placeAt(spawn);
  }

  /** Point the player at a spawn, level and at rest. */
  private placeAt(spawn: Vector3): void {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.speed01 = 0;
    this.dashOutput = 0;
    this.refillStamina();
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
   * A DIRECTED lunge toward a world-space direction — the lock-on strike (point
   * 3). Adds the burst along `dir` and, when `snapFacing`, orients the body onto
   * that line immediately so it reads as a committed turn-and-dash rather than a
   * sideways slide; the follow-up bite (which reads getForward) then lands along
   * the dash. Same max-speed-cap lift as a normal lunge, held a touch longer so
   * the gap-closer actually covers the ground.
   */
  lungeToward(speed: number, dir: Vector3, snapFacing: boolean): void {
    TMP.copy(dir);
    if (TMP.lengthSq() < 1e-8) {
      this.lunge(speed);
      return;
    }
    TMP.normalize();
    this.vel.addScaledVector(TMP, speed);
    this.lungeBoostT = 0.5;
    if (snapFacing) {
      this.curYaw = Math.atan2(TMP.x, TMP.z);
      this.curPitch = -Math.asin(Math.max(-1, Math.min(1, TMP.y)));
      LOOK_E.set(this.curPitch, this.curYaw, 0);
      this.fish.object.quaternion.setFromEuler(LOOK_E);
    }
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
  bindZone(
    terrain: TerrainLike,
    colliders: CylinderCollider[],
    bounds: ZoneBounds,
    spawn: Vector3,
    zone?: Zone,
  ): void {
    this.terrain = terrain;
    this.colliders = colliders;
    this.bounds = bounds;
    this.zone = zone ?? null;
    this.currentSpeed = 0;
    this.placeAt(spawn);
    // Arrival shove, if this zone defines one.
    this.zone?.getSpawnImpulse?.(CURRENT);
    if (this.zone?.getSpawnImpulse) this.vel.copy(CURRENT);
  }

  /** Ability speed surge: multiply max speed for a duration (Burst/Frenzy). */
  boost(mult: number, duration: number): void {
    this.boostMult = mult;
    this.boostT = Math.max(this.boostT, duration);
  }

  /** Refill the sprint bar — a fresh host (or a respawn) starts fully rested. */
  refillStamina(): void {
    this.stamina = 1;
    this.sprinting = false;
    this.staminaShow = 0;
    this.sprintLockout = false;
    this.sprintRamp = 0;
  }

  /**
   * Resolve sprint for this frame and drain/refill the bar. `driving` gates it on
   * actual forward effort so idling with Shift held never bleeds energy; a short
   * lockout after a full drain stops the sprint stuttering on/off at empty.
   * Returns true while the host is sprinting.
   */
  private stepSprint(dt: number, mv: MovementDef, driving: boolean): boolean {
    const wantSprint = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
    const sprinting = wantSprint && driving && this.stamina > 0.001 && !this.sprintLockout;
    this.sprinting = sprinting;
    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - dt / Math.max(0.5, mv.dashStamina));
      if (this.stamina <= 0) this.sprintLockout = true;
    } else {
      this.stamina = Math.min(1, this.stamina + dt * mv.dashRegen);
      if (this.sprintLockout && this.stamina > 0.25) this.sprintLockout = false;
    }
    // Smoothed intensity: race up when sprinting, drift down slowly when not, so the
    // speed cap and FX ease back to cruise over ~1 s rather than cutting instantly.
    const rampRate = sprinting ? 9 : 2.6;
    this.sprintRamp += (Number(sprinting) - this.sprintRamp) * Math.min(1, rampRate * dt);
    if (this.sprintRamp < 0.001) this.sprintRamp = 0;
    // HUD reveal: snap up while sprinting, ease away once you stop (bar hides).
    this.staminaShow = sprinting ? 1 : Math.max(0, this.staminaShow - dt * 2.4);
    return sprinting;
  }

  update(dt: number): void {
    const mv = this.fish.species.movement;
    if (this.fish.species.locomotion === 'crawl') {
      this.crawlUpdate(dt, mv);
      return;
    }
    this.boostT = Math.max(0, this.boostT - dt);
    const boost = this.boostT > 0 ? this.boostMult : 1;

    // --- input → desired thrust direction -----------------------------------
    const thrust = this.input.axis('KeyW', 'KeyS');
    const strafe = this.input.axis('KeyD', 'KeyA');
    const vertical = this.input.axis('Space', 'KeyC');

    // Sprint (Shift) — only while genuinely driving the body; drains the bar.
    const driving = thrust > 0.1 || strafe !== 0 || vertical !== 0;
    this.stepSprint(dt, mv, driving);
    // The dash multiplier follows the smoothed ramp, not the raw on/off, so the cap
    // eases back to cruise when you let off rather than snapping the fish to a stop.
    const sprintMult = 1 + (mv.dashMultiplier - 1) * this.sprintRamp;
    const maxSpeed = mv.maxSpeed * sprintMult * boost;

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
      const accel = mv.accel * (1 + 0.7 * this.sprintRamp) * boost;
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

    // --- ambient current -----------------------------------------------------
    // Applied to POSITION rather than velocity, so a current cannot be banked
    // into speed by the drag/clamp above — it carries the host bodily, which is
    // what a current does, and it stays exactly as strong however fast you swim.
    this.applyCurrent(dt);

    this.pos.addScaledVector(this.vel, dt);

    // --- collisions ----------------------------------------------------------
    const radius = this.fish.length * 0.45;

    // Terrain.
    const ground = this.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < ground + radius) {
      this.pos.y = ground + radius;
      if (this.vel.y < 0) this.vel.y *= -0.15;
    }
    // Surface / zone ceiling (blocks backtracking upward in deeper zones), plus
    // the rock roof in enclosed zones — whichever is lower wins.
    const roof = this.roofAt(this.pos.x, this.pos.z, radius);
    if (this.pos.y > roof) {
      this.pos.y = roof;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    this.collideSolidsAndBounds(radius, dt);

    // --- orientation ---------------------------------------------------------
    const speedNow = this.vel.length();
    this.speed01 = speedNow / mv.maxSpeed;
    // FX intensity follows the smoothed ramp so the "rushing water" streak fades out
    // with the speed instead of cutting the frame you release Shift.
    const cruiseFx = Math.max(0, this.speed01 - 0.6) * 0.5;
    this.dashOutput = Math.max(cruiseFx, Math.min(1, this.speed01 / 1.3) * this.sprintRamp);
    // Face velocity when moving; face aim when idle. Orientation is tracked
    // as yaw/pitch scalars and rebuilt from Euler each frame, so roll (and
    // therefore an upside-down or slanted fish) is structurally impossible.
    // Banking is a separate visual layer on the model root.
    //
    // This is the Phase 0-7 behaviour, restored. Phase 10 (92382b3) replaced it
    // with `faceDir = AIM` plus `orientRate = max(turnRate * 1.8, 4.0)` to stop
    // big low-turn hosts trailing the camera. That welded the body to the view
    // axis at nearly double the turn rate: mouse-look spun the fish in place,
    // you only ever saw its tail, and swimming stopped reading as swimming.
    // Following velocity is what makes the body lean into its own turns.
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

  /** Drift the host with the zone's water, if this zone has any. */
  private applyCurrent(dt: number): void {
    if (!this.zone?.currentAt) return;
    this.zone.currentAt(this.pos, CURRENT);
    this.pos.addScaledVector(CURRENT, dt);
    // Report the drift so the HUD can tell the player they are being carried.
    this.currentSpeed = CURRENT.length();
  }

  /**
   * Lowest overhead at this spot: the zone's flat cap, or the rock roof in a
   * cave zone, less the body's radius so the host never clips into stone.
   */
  private roofAt(x: number, z: number, radius: number): number {
    const cap = this.bounds.ceilingY;
    const rock = this.terrain.ceilingAt?.(x, z);
    return rock === undefined ? cap : Math.min(cap, rock - radius);
  }

  /** Shared solid-obstacle push-out + soft-box boundary clamp (swim + crawl). */
  private collideSolidsAndBounds(radius: number, dt: number): void {
    for (const c of this.colliders) {
      if (this.pos.y > c.top + radius) continue;
      let dx = this.pos.x - c.x;
      let dz = this.pos.z - c.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-4) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      const minD = c.r + radius;
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
  }

  /**
   * Crab locomotion: a grounded seabed walker. WASD moves horizontally relative
   * to the camera (no free swimming up/down); Space HOPS; gravity pulls it back
   * to the seabed. The body faces its walk direction and stays upright — a proper
   * crawl instead of the old sideways scuttle.
   */
  private crawlUpdate(dt: number, mv: MovementDef): void {
    this.boostT = Math.max(0, this.boostT - dt);
    const boost = this.boostT > 0 ? this.boostMult : 1;

    // Horizontal movement, camera-relative (aim flattened to the seabed plane).
    const thrust = this.input.axis('KeyW', 'KeyS');
    const strafe = this.input.axis('KeyD', 'KeyA');
    this.stepSprint(dt, mv, thrust > 0.1 || strafe !== 0);
    const sprintMult = 1 + (mv.dashMultiplier - 1) * this.sprintRamp;
    const maxSpeed = mv.maxSpeed * sprintMult * boost;
    this.camera.getAimDir(AIM);
    AIM.y = 0;
    if (AIM.lengthSq() < 1e-6) AIM.set(Math.sin(this.curYaw), 0, Math.cos(this.curYaw));
    AIM.normalize();
    RIGHT.crossVectors(AIM, UP).normalize();
    DESIRED.set(0, 0, 0).addScaledVector(AIM, thrust).addScaledVector(RIGHT, strafe);
    const moving = DESIRED.lengthSq() > 0.001;
    if (moving) {
      DESIRED.normalize();
      const accel = mv.accel * (1 + 0.5 * this.sprintRamp) * boost;
      this.vel.x += DESIRED.x * accel * dt;
      this.vel.z += DESIRED.z * accel * dt;
    }
    // Horizontal ground drag + speed clamp (Y is handled by gravity, not drag).
    const hdrag = moving ? mv.drag : mv.drag * 1.7;
    const df = Math.exp(-hdrag * dt);
    this.vel.x *= df;
    this.vel.z *= df;
    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    if (hspeed > maxSpeed) {
      const k = maxSpeed / hspeed;
      this.vel.x *= k;
      this.vel.z *= k;
    }

    // A crab on the seabed is dragged by the same water everything else is.
    this.applyCurrent(dt);

    // Jump + gravity.
    const radius = this.fish.length * 0.4;
    const groundNow = this.terrain.heightAt(this.pos.x, this.pos.z) + radius;
    this.grounded = this.pos.y <= groundNow + 0.06;
    if (this.grounded && this.input.isDown('Space') && this.vel.y <= 0.1) {
      this.vel.y = CRAB_JUMP;
      this.grounded = false;
    }
    this.vel.y -= CRAB_GRAVITY * dt;

    this.pos.addScaledVector(this.vel, dt);

    // Land on the seabed / cap at the ceiling.
    const groundAfter = this.terrain.heightAt(this.pos.x, this.pos.z) + radius;
    if (this.pos.y < groundAfter) {
      this.pos.y = groundAfter;
      if (this.vel.y < 0) this.vel.y = 0;
    }
    const roof = this.roofAt(this.pos.x, this.pos.z, radius);
    if (this.pos.y > roof) {
      this.pos.y = roof;
      if (this.vel.y > 0) this.vel.y = 0;
    }
    this.collideSolidsAndBounds(radius, dt);

    // Orientation: upright, facing the walk direction (aim when standing still).
    const speedNow = Math.hypot(this.vel.x, this.vel.z);
    this.speed01 = speedNow / mv.maxSpeed;
    this.dashOutput = Math.min(1, this.speed01 / 1.3) * this.sprintRamp;
    const faceDir = moving ? TMP.set(this.vel.x, 0, this.vel.z) : TMP.copy(AIM);
    if (faceDir.lengthSq() > 1e-5) {
      faceDir.normalize();
      const targetYaw = Math.atan2(faceDir.x, faceDir.z);
      const maxStep = Math.max(mv.turnRate * 2.2, 4.5) * dt;
      let dYaw = targetYaw - this.curYaw;
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      this.curYaw += Math.max(-maxStep, Math.min(maxStep, dYaw));
      if (this.curYaw > Math.PI) this.curYaw -= Math.PI * 2;
      if (this.curYaw < -Math.PI) this.curYaw += Math.PI * 2;
    }
    this.curPitch += (0 - this.curPitch) * Math.min(1, 8 * dt); // settle upright
    LOOK_E.set(this.curPitch, this.curYaw, 0);
    this.fish.object.quaternion.setFromEuler(LOOK_E);
    this.fish.setBank(0, dt);
    this.fish.object.position.copy(this.pos);
    this.fish.update(dt, Math.min(1, this.speed01));
  }
}
