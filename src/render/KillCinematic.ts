import { PerspectiveCamera, Vector3 } from 'three';
import type { PlayerFish } from '../entities/PlayerFish';
import type { SwimController } from '../player/SwimController';
import type { BloodFx } from './BloodFx';
import type { Sfx } from '../core/Sfx';

/**
 * The kill cinematic (point 5) — a short, cinematic "frenzy eat" cutaway.
 *
 * When the host tears something apart (always for prey bigger than the host, and
 * occasionally on a clean full eat), the game cuts away from normal control for a
 * beat and a half: black letterbox bars slide in, and the camera swings in close
 * and orbits the host as it KEEPS SWIMMING FORWARD through the kill, blood and
 * chunks streaming off its mouth. It is an action beat, not a frozen pose — the
 * host surges ahead the whole time and the camera tracks it. Then it hands control
 * straight back, seamlessly, from wherever the surge left the fish.
 *
 * Self-contained: it owns the camera and drives the host's position while active,
 * reuses the existing BloodFx for gore, and drives its own letterbox DOM. GameApp
 * only decides WHEN to trigger it and stops feeding the normal camera/control.
 * The host gets i-frames for the duration so the cutaway is never a free hit.
 */
export class KillCinematic {
  active = false;

  private timeLeft = 0;
  private duration = 0;
  /** Ticks down whether or not one is playing — a cutaway is a rare treat. */
  private cooldown = 0;
  private startAngle = 0;
  private dist = 0;
  private scale = 1;
  private swimSpeed = 0;
  private goreT = 0;

  private readonly forward = new Vector3();
  private readonly focal = new Vector3();
  private readonly gorePos = new Vector3();
  private readonly _dir = new Vector3();

  private rootEl: HTMLElement | null = null;
  private barTop: HTMLElement | null = null;
  private barBottom: HTMLElement | null = null;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly fish: PlayerFish,
    private readonly controller: SwimController,
    private readonly blood: BloodFx,
    private readonly sfx: Sfx,
  ) {}

  /**
   * Try to start a cinematic on a kill. Returns true if it actually fired (so the
   * caller can grant i-frames). Fails silently while one is already playing or on
   * cooldown, which is what keeps it a treat rather than a constant interruption.
   *
   * @param victimPos where the victim died (seeds the first gore burst)
   * @param scale     victim body length — drives distance and how much it bleeds
   * @param big       victim was as large or larger than the host (longer, always-on shot)
   */
  trigger(victimPos: Vector3, scale: number, big: boolean): boolean {
    if (this.active || this.cooldown > 0) return false;

    this.scale = Math.max(0.6, Math.min(6, scale));

    // The host keeps swimming along its facing, mostly level so a short surge
    // never dives it into the seabed or the roof.
    this.controller.getForward(this.forward);
    this.forward.y *= 0.25;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
    this.forward.normalize();
    // A committed feeding surge — a touch quicker than a cruise so it reads as action.
    this.swimSpeed = Math.min(11, 5.5 + this.scale);

    // View across the swim line, from a random side, then sweep as it tracks.
    const baseAng = Math.atan2(this.forward.z, this.forward.x);
    this.startAngle = baseAng + Math.PI * 0.5 + (Math.random() < 0.5 ? -0.35 : 0.35);
    this.dist = Math.max(2.6, (this.scale + 1.4) * 1.7);

    this.duration = big ? 2.0 : 1.55;
    this.timeLeft = this.duration;
    this.goreT = 0;
    this.active = true;
    this.cooldown = (big ? 15 : 20) + this.duration;

    this.ensureDom();
    this.rootEl?.classList.remove('hidden');
    // A wet, heavy crunch to open on, plus a squash-stretch chomp on the body.
    this.sfx.biteLanded(1);
    this.fish.lungePulse();
    // First big burst right at the kill so the cut lands on impact, not a pause.
    this.gorePos.copy(victimPos);
    this.blood.kill(this.gorePos, this.forward, this.scale);
    return true;
  }

  /** Advance the cooldown while nothing is playing (call every idle frame). */
  tickIdle(dt: number): void {
    if (this.cooldown > 0) this.cooldown -= dt;
  }

  /** Drive the shot: move the host, track it with the camera, stream gore, letterbox. */
  update(dt: number): void {
    if (!this.active) {
      this.tickIdle(dt);
      return;
    }
    this.timeLeft -= dt;
    const t = 1 - Math.max(0, this.timeLeft) / this.duration; // 0 → 1

    // Keep the host SWIMMING forward through the kill (write both the controller
    // position, so control resumes seamlessly, and the rendered body).
    this.controller.pos.addScaledVector(this.forward, this.swimSpeed * dt);
    this.fish.object.position.copy(this.controller.pos);

    // Focal rides just ahead of the head; the camera orbits this moving point, so
    // the shot both sweeps around and travels with the fish — a tracking shot.
    this.focal
      .copy(this.controller.pos)
      .addScaledVector(this.forward, this.scale * 0.2);
    this.focal.y += 0.3 * this.scale + 0.4;

    const ang = this.startAngle + t * 0.5;
    const easeIn = Math.min(1, t / 0.18);
    const d = this.dist * (1.12 - 0.12 * easeIn);
    const elev = 0.24;
    const ce = Math.cos(elev);
    this.camera.position.set(
      this.focal.x + Math.cos(ang) * ce * d,
      this.focal.y + Math.sin(elev) * d + 0.4,
      this.focal.z + Math.sin(ang) * ce * d,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.focal);

    // Animate the body so the swim cycle plays under the cut, not a frozen pose.
    this.fish.update(dt, 0.8);

    // Gore streams from the moving mouth through the first ~70% of the shot, thrown
    // mostly backward so chunks trail behind like a wake of blood. Gibs and spray
    // are opaque (no near-camera fade), so they read up close.
    if (this.timeLeft > this.duration * 0.3) {
      this.goreT -= dt;
      if (this.goreT <= 0) {
        this.goreT = 0.08;
        this.gorePos
          .copy(this.controller.pos)
          .addScaledVector(this.forward, this.fish.length * 0.45);
        this._dir
          .copy(this.forward)
          .multiplyScalar(-0.5)
          .add(this._rand());
        if (this._dir.lengthSq() < 1e-4) this._dir.set(1, 0, 0);
        this._dir.normalize();
        this.blood.kill(this.gorePos, this._dir, this.scale * 0.7);
      }
    }

    // Letterbox: bars slide in fast, hold, and pull back out at the tail.
    const reveal =
      Math.min(1, t / 0.14) * Math.min(1, Math.max(0, this.timeLeft) / (this.duration * 0.28));
    const h = (reveal * 11).toFixed(2);
    if (this.barTop) this.barTop.style.height = `${h}vh`;
    if (this.barBottom) this.barBottom.style.height = `${h}vh`;

    if (this.timeLeft <= 0) this.end();
  }

  /** Force-stop the cinematic immediately (death, descent, etc.). */
  cancel(): void {
    if (this.active) this.end();
  }

  private end(): void {
    this.active = false;
    this.ensureDom();
    if (this.barTop) this.barTop.style.height = '0vh';
    if (this.barBottom) this.barBottom.style.height = '0vh';
    this.rootEl?.classList.add('hidden');
  }

  /** A small random scatter vector (reuses _dir's caller context, returns a temp). */
  private _rand(): Vector3 {
    return _SCATTER.set(Math.random() - 0.5, Math.random() * 0.4 - 0.1, Math.random() - 0.5);
  }

  private ensureDom(): void {
    this.rootEl ||= document.getElementById('cinematic');
    this.barTop ||= (this.rootEl?.querySelector('.cine-top') as HTMLElement | null) ?? null;
    this.barBottom ||= (this.rootEl?.querySelector('.cine-bottom') as HTMLElement | null) ?? null;
  }
}

const _SCATTER = new Vector3();
