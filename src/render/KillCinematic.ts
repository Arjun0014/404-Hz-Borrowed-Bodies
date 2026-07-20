import { PerspectiveCamera, Vector3 } from 'three';
import type { PlayerFish } from '../entities/PlayerFish';
import type { BloodFx } from './BloodFx';
import type { Sfx } from '../core/Sfx';

/**
 * The kill cinematic (point 5) — a short, cinematic "frenzy eat" cutaway.
 *
 * When the host tears something apart (always for prey bigger than the host, and
 * occasionally on a clean full eat), the game cuts away from normal control for a
 * beat and a half: black letterbox bars slide in, the camera swings in close and
 * low and orbits the carnage, and the blood layer erupts — chunks and spray
 * flying off the kill. Then it hands control straight back.
 *
 * It is deliberately self-contained: it owns the camera while active, drives its
 * own letterbox DOM, and reuses the existing BloodFx for the gore. GameApp only
 * decides WHEN to trigger it and stops feeding the normal camera/control while
 * `active`. The host is granted i-frames for the duration so the cutaway is never
 * a free hit for whatever else is nearby.
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
  private goreT = 0;

  private readonly focal = new Vector3();
  private readonly gorePos = new Vector3();
  private readonly _dir = new Vector3();

  private rootEl: HTMLElement | null = null;
  private barTop: HTMLElement | null = null;
  private barBottom: HTMLElement | null = null;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly fish: PlayerFish,
    private readonly blood: BloodFx,
    private readonly sfx: Sfx,
  ) {}

  /**
   * Try to start a cinematic on a kill. Returns true if it actually fired (so the
   * caller can grant i-frames). Fails silently while one is already playing or on
   * cooldown, which is what keeps it a treat rather than a constant interruption.
   *
   * @param hostPos  the host's position (one focus of the framing)
   * @param victimPos where the victim died (the other focus, and the gore origin)
   * @param scale    victim body length — drives distance and how much it bleeds
   * @param big      the victim was as large or larger than the host (a longer, always-on shot)
   */
  trigger(hostPos: Vector3, victimPos: Vector3, scale: number, big: boolean): boolean {
    if (this.active || this.cooldown > 0) return false;

    this.scale = Math.max(0.6, Math.min(6, scale));
    this.focal.addVectors(hostPos, victimPos).multiplyScalar(0.5);
    this.focal.y += 0.3 * this.scale + 0.4;
    this.gorePos.copy(victimPos);

    // View across the host→victim line so both are in frame, from a random side,
    // then sweep. Close and a touch low, looking up at the kill.
    const baseAng = Math.atan2(victimPos.z - hostPos.z, victimPos.x - hostPos.x);
    this.startAngle = baseAng + Math.PI * 0.5 + (Math.random() < 0.5 ? -0.35 : 0.35);
    this.dist = Math.max(2.4, (this.scale + 1.2) * 1.7);

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
    // A first big burst right away so the cut lands on impact, not on a pause.
    this.burst(this.scale);
    return true;
  }

  /** Advance the cooldown while nothing is playing (call every idle frame). */
  tickIdle(dt: number): void {
    if (this.cooldown > 0) this.cooldown -= dt;
  }

  /** Drive the shot: camera, gore, letterbox, and the host's own animation. */
  update(dt: number): void {
    if (!this.active) {
      this.tickIdle(dt);
      return;
    }
    this.timeLeft -= dt;
    const t = 1 - Math.max(0, this.timeLeft) / this.duration; // 0 → 1

    // Slow orbit in, close and low; ease the distance in so it arrives with a push.
    const ang = this.startAngle + t * 0.55;
    const easeIn = Math.min(1, t / 0.18);
    const d = this.dist * (1.14 - 0.14 * easeIn);
    const elev = 0.26;
    const ce = Math.cos(elev);
    this.camera.position.set(
      this.focal.x + Math.cos(ang) * ce * d,
      this.focal.y + Math.sin(elev) * d + 0.4,
      this.focal.z + Math.sin(ang) * ce * d,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.focal);

    // Keep the host body animating (its update is otherwise skipped while we own
    // the frame), so it reads as an active feeding rather than a frozen pose.
    this.fish.update(dt, 0.65);

    // The frenzy: repeated gore bursts through the first ~65% of the shot. Gibs
    // and spray are opaque and don't near-fade, so they read up close where the
    // blood clouds would wash out.
    if (this.timeLeft > this.duration * 0.35) {
      this.goreT -= dt;
      if (this.goreT <= 0) {
        this.goreT = 0.085;
        this.burst(this.scale * 0.7);
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

  /** One gore burst at the kill, thrown in a random direction. */
  private burst(scale: number): void {
    this._dir.set(Math.random() - 0.5, Math.random() * 0.4 - 0.1, Math.random() - 0.5);
    if (this._dir.lengthSq() < 1e-4) this._dir.set(1, 0, 0);
    this._dir.normalize();
    this.blood.kill(this.gorePos, this._dir, scale);
  }

  private ensureDom(): void {
    this.rootEl ||= document.getElementById('cinematic');
    this.barTop ||= (this.rootEl?.querySelector('.cine-top') as HTMLElement | null) ?? null;
    this.barBottom ||= (this.rootEl?.querySelector('.cine-bottom') as HTMLElement | null) ?? null;
  }
}
