import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { Input } from '../core/Input';
import type { CylinderCollider, TerrainLike } from '../world/types';
import type { CameraProfile } from '../data/species';
import { WORLD } from '../config';

const TMP_A = new Vector3();
const TMP_B = new Vector3();

/**
 * Third-person orbit camera, size-adaptive via CameraProfile.
 * Never rolls: up is always +Y. Collision-aware against terrain and surface.
 */
export class PlayerCamera {
  readonly camera: PerspectiveCamera;

  // Spawn facing +X: toward open water and the distant drop-off.
  private yaw = -Math.PI / 2;
  // Positive pitch = camera above the host, looking slightly down.
  private pitch = 0.16;
  private profile: CameraProfile;
  private hostLength: number;
  private baseDist: number;
  private zoomFactor = 1;
  private currentDist: number;
  private currentFov: number;
  private kickFov = 0;
  private readonly lookTarget = new Vector3();
  private readonly smoothPos = new Vector3();
  private initialized = false;

  // Lock-on (hold right mouse): while set, the orbit rotates so this world point
  // sits centered ahead of the host, and manual mouse-orbit is suspended.
  private readonly lockPos = new Vector3();
  private locked = false;

  // Zone-scoped references, swapped on descent.
  private terrain: TerrainLike;
  private colliders: CylinderCollider[];

  constructor(
    private readonly input: Input,
    terrain: TerrainLike,
    colliders: CylinderCollider[],
    aspect: number,
  ) {
    this.terrain = terrain;
    this.colliders = colliders;
    this.profile = { distanceFactor: 7, minDistance: 2.4, heightFactor: 2, baseFov: 60 };
    this.hostLength = 0.4;
    this.baseDist = this.computeBaseDist();
    this.currentDist = this.baseDist;
    this.currentFov = this.profile.baseFov;
    this.camera = new PerspectiveCamera(this.currentFov, aspect, 0.08, 900);
  }

  /** Rebind to a new zone; the next update snaps to the new framing. */
  bindZone(terrain: TerrainLike, colliders: CylinderCollider[]): void {
    this.terrain = terrain;
    this.colliders = colliders;
    this.initialized = false;
  }

  /** Called on spawn and again on every possession/growth change (Phase 5+). */
  setHost(profile: CameraProfile, hostLength: number): void {
    this.profile = profile;
    this.hostLength = hostLength;
    this.baseDist = this.computeBaseDist();
  }

  private computeBaseDist(): number {
    // Distance grows with sqrt(length), not linearly — a big host fills much more
    // of the screen (feels powerful) instead of shrinking into the distance.
    return Math.max(this.profile.minDistance, this.profile.distanceFactor * Math.sqrt(this.hostLength));
  }

  /** Direction the player is aiming (camera forward), used for steering. */
  getAimDir(out: Vector3): Vector3 {
    return this.camera.getWorldDirection(out);
  }

  /** True while a lock-on target is active (drives the reticle + steering feel). */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Set (or clear) the lock-on target — a live world position to keep centered. */
  setLockTarget(pos: Vector3 | null): void {
    if (pos) {
      this.lockPos.copy(pos);
      this.locked = true;
    } else {
      this.locked = false;
    }
  }

  /** A transient FOV punch (a lunge/impact kick). Decays fast. */
  punch(fov: number): void {
    this.kickFov = Math.max(this.kickFov, fov);
  }

  get yawAngle(): number {
    return this.yaw;
  }

  update(dt: number, targetPos: Vector3, targetVel: Vector3, speed01: number): void {
    // Mouse orbit — suspended while locked on (the target owns the aim), though
    // the wheel-zoom stays live and the deltas are still consumed each frame.
    const sens = 0.0022;
    if (!this.locked) {
      this.yaw -= this.input.mouseDX * sens;
      this.pitch = MathUtils.clamp(this.pitch - this.input.mouseDY * sens, -1.25, 1.32);
    }
    if (this.input.wheelDelta !== 0) {
      this.zoomFactor = MathUtils.clamp(this.zoomFactor + this.input.wheelDelta * 0.0006, 0.6, 1.6);
    }
    this.input.clearMouse();

    // Lock-on: swing the orbit so the target sits centered ahead of the host, so
    // W-swim, the bite cone, and possession all line up on it. Camera sits behind
    // the host on the host→target line (back vector points away from the target).
    if (this.locked) {
      TMP_A.subVectors(this.lockPos, targetPos);
      const len = TMP_A.length();
      if (len > 1e-3) {
        const wantYaw = Math.atan2(-TMP_A.x, -TMP_A.z);
        let dY = wantYaw - this.yaw;
        while (dY > Math.PI) dY -= Math.PI * 2;
        while (dY < -Math.PI) dY += Math.PI * 2;
        const k = Math.min(1, 9 * dt);
        this.yaw += dY * k;
        const wantPitch = MathUtils.clamp(Math.asin(MathUtils.clamp(-TMP_A.y / len, -1, 1)), -1.0, 1.2);
        this.pitch += (wantPitch - this.pitch) * k;
      }
    }

    // Desired position: behind the target on the yaw/pitch orbit sphere.
    const dist = this.baseDist * this.zoomFactor;
    const cp = Math.cos(this.pitch);
    const back = TMP_A.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );
    const height = this.hostLength * this.profile.heightFactor * 0.35;

    // Collision: march from the target outwards; stop before terrain, the
    // surface, or any solid obstacle (spires, monoliths).
    let usable = dist;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = (dist * i) / steps;
      const px = targetPos.x + back.x * t;
      const py = targetPos.y + back.y * t + height;
      const pz = targetPos.z + back.z * t;
      const ground = this.terrain.heightAt(px, pz);
      let blocked = py < ground + 0.5 || py > WORLD.surfaceY - 0.3;
      if (!blocked) {
        for (const c of this.colliders) {
          if (py < c.top + 0.3 && Math.hypot(px - c.x, pz - c.z) < c.r + 0.35) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) {
        usable = Math.max(this.profile.minDistance * 0.6, ((i - 1) * dist) / steps);
        break;
      }
    }
    // Fast pull-in, slower push-out.
    const k = usable < this.currentDist ? 14 : 3.2;
    this.currentDist += (usable - this.currentDist) * Math.min(1, k * dt);

    const desired = TMP_B.copy(targetPos)
      .addScaledVector(back, this.currentDist)
      .add(TMP_A.set(0, height, 0));

    if (!this.initialized) {
      this.smoothPos.copy(desired);
      this.lookTarget.copy(targetPos);
      this.initialized = true;
    }
    // Snappy tracking: heavy smoothing here reads as "swimming in jello".
    this.smoothPos.lerp(desired, Math.min(1, 16 * dt));
    this.camera.position.copy(this.smoothPos);

    // Look slightly ahead of motion; no roll ever.
    const look = TMP_A.copy(targetPos).addScaledVector(targetVel, 0.07);
    look.y += height * 0.4;
    this.lookTarget.lerp(look, Math.min(1, 20 * dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookTarget);

    // Speed-reactive FOV plus a fast-decaying lunge kick for punchy strikes.
    this.kickFov = Math.max(0, this.kickFov - dt * 60);
    const targetFov = this.profile.baseFov + speed01 * 4 + this.kickFov;
    if (Math.abs(targetFov - this.currentFov) > 0.03) {
      this.currentFov += (targetFov - this.currentFov) * Math.min(1, 12 * dt);
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
