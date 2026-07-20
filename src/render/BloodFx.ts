import {
  CanvasTexture,
  DodecahedronGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NormalBlending,
  Quaternion,
  type Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';

/**
 * Blood, viscera, and the cloud they leave behind.
 *
 * Three layers, because a bite that only sprays particles reads as a firework
 * and a bite that only stains the water reads as a bug:
 *
 *  1. SPRAY  — a fast burst of fine droplets thrown along the bite direction.
 *     Gone in under a second; this is the impact.
 *  2. GIBS   — actual chunks of meat that tumble, sink, and fade. This is what
 *     sells "you tore something apart" rather than "you applied damage".
 *  3. CLOUD  — a slow expanding stain that hangs in the water for several
 *     seconds after everything else is gone. This is the part you remember,
 *     and the reason a kill leaves a mark on the world rather than a flash.
 *
 * Everything is POOLED and instanced. A frenzy can produce dozens of kills in a
 * few seconds, so nothing here allocates during play: fixed pools, dead entries
 * recycled oldest-first, and one draw call per layer.
 */

// Pool sizes. Generous enough for a Dead Signal Field frenzy without ever
// growing, since growth mid-fight is exactly when a hitch would be felt.
const MAX_GIBS = 220;
const MAX_CLOUDS = 34;
const MAX_DROPS = 900;

/**
 * Hard ceiling on a cloud sprite's diameter, in metres.
 *
 * This is a PERFORMANCE limit, not an art one. Cloud size scaled off the
 * victim's length with no cap, so a megalodon kill produced sprites up to 37 m
 * across — and with the third-person camera sitting under two metres behind the
 * host, a sprite that size covers the whole screen. Three of them per kill, a
 * few kills, and you are blending dozens of full-screen transparent layers:
 * fill-rate collapses and the framerate goes with it. Capping the diameter costs
 * nothing visually (a 9 m stain already reads as huge at that camera distance)
 * and bounds the worst case.
 */
const MAX_CLOUD_SIZE = 9;

/** Seconds a blood cloud lingers before it has fully dispersed. */
const CLOUD_LIFE = 7.5;
const GIB_LIFE = 5.0;
const DROP_LIFE = 0.85;

const GRAVITY = 3.2; // gibs are near-neutrally buoyant; they sink slowly
const WATER_DRAG = 1.6;

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _v = new Vector3();

interface Gib {
  pos: Vector3;
  vel: Vector3;
  spin: Vector3;
  rot: Quaternion;
  size: number;
  life: number;
}

interface Cloud {
  pos: Vector3;
  vel: Vector3;
  life: number;
  maxSize: number;
  sprite: Sprite;
  mat: SpriteMaterial;
}

interface Drop {
  pos: Vector3;
  vel: Vector3;
  life: number;
  size: number;
}

export class BloodFx {
  private readonly group = new Group();
  private readonly gibs: Gib[] = [];
  private readonly clouds: Cloud[] = [];
  private readonly drops: Drop[] = [];

  private gibMesh!: InstancedMesh;
  private dropMesh!: InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly scene: Scene) {
    this.group.name = 'blood-fx';
    this.group.renderOrder = 5;
    scene.add(this.group);
    this.buildGibs();
    this.buildDrops();
    this.buildCloudPool();
  }

  // ---- pools --------------------------------------------------------------

  private buildGibs(): void {
    // Irregular lumps, not spheres — a chunk of meat should have facets that
    // catch the light as it tumbles.
    const geo = new DodecahedronGeometry(0.5, 0);
    // Lambert, not Standard: a gib is a 15 cm lump that still wants to catch the
    // light as it tumbles, but full PBR (roughness/metalness/IBL) on up to 220
    // instances buys nothing you can see at that size.
    //
    // NOT transparent. Gibs fade by SHRINKING, never by alpha, so the transparent
    // flag only bought a depth-write-disabled sorted pass — extra overdraw and
    // per-frame sorting for zero visual difference.
    const mat = new MeshLambertMaterial({ color: 0x7d1418 });
    this.disposables.push(geo, mat);
    this.gibMesh = new InstancedMesh(geo, mat, MAX_GIBS);
    this.gibMesh.count = 0;
    this.gibMesh.frustumCulled = false;
    this.gibMesh.name = 'blood-gibs';
    this.group.add(this.gibMesh);
  }

  private buildDrops(): void {
    const geo = new DodecahedronGeometry(0.5, 0);
    // Basic, unlit: droplets are 2-5 cm specks in motion for under a second. They
    // are never on screen long enough or large enough for shading to register, so
    // lighting 900 of them is pure cost. Also opaque, for the same reason gibs are.
    const mat = new MeshBasicMaterial({ color: 0x9e1a1a });
    this.disposables.push(geo, mat);
    this.dropMesh = new InstancedMesh(geo, mat, MAX_DROPS);
    this.dropMesh.count = 0;
    this.dropMesh.frustumCulled = false;
    this.dropMesh.name = 'blood-drops';
    this.group.add(this.dropMesh);
  }

  /**
   * The cloud pool. Sprites rather than instanced quads because each needs its
   * own opacity as it disperses, and a handful of sprites is cheaper than the
   * per-instance attribute plumbing would be.
   */
  private buildCloudPool(): void {
    const tex = makeSoftBlob();
    this.disposables.push(tex);
    for (let i = 0; i < MAX_CLOUDS; i++) {
      const mat = new SpriteMaterial({
        map: tex,
        color: 0x5e0d10,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // Normal blending, NOT additive: blood in water DARKENS and muddies it.
        // Additive would make a kill look like an explosion of light.
        blending: NormalBlending,
        fog: true,
      });
      const sprite = new Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 5;
      this.group.add(sprite);
      this.disposables.push(mat);
      this.clouds.push({
        pos: new Vector3(),
        vel: new Vector3(),
        life: 0,
        maxSize: 1,
        sprite,
        mat,
      });
    }
  }

  // ---- spawning -----------------------------------------------------------

  /**
   * A bite connected but did not kill. A spray of droplets and a small stain —
   * enough to tell you the hit landed on flesh.
   *
   * @param at    world position of the wound
   * @param dir   direction the bite was travelling (spray follows through)
   * @param scale body length of the victim, so a big fish bleeds a lot more
   */
  hit(at: Vector3, dir: Vector3, scale: number): void {
    const s = Math.max(0.4, Math.min(4, scale));
    this.spawnDrops(at, dir, Math.round(10 + s * 8), s);
    this.spawnCloud(at, s * 1.5, 0.55);
    if (Math.random() < 0.5) this.spawnGibs(at, dir, 1, s * 0.5);
  }

  /**
   * Something died. Everything at once: a wide spray, real chunks of the body,
   * and a cloud big enough to swim through and still see seconds later.
   */
  kill(at: Vector3, dir: Vector3, scale: number): void {
    const s = Math.max(0.5, Math.min(6, scale));
    this.spawnDrops(at, dir, Math.round(26 + s * 16), s * 1.3);
    this.spawnGibs(at, dir, Math.round(4 + s * 2.2), s);
    // Several overlapping puffs read as a billow rather than one flat disc.
    this.spawnCloud(at, s * 2.6, 1);
    for (let i = 0; i < 2; i++) {
      addRandom(_v.copy(at), s * 0.8);
      this.spawnCloud(_v, s * 1.9, 0.8);
    }
  }

  private spawnDrops(at: Vector3, dir: Vector3, n: number, scale: number): void {
    for (let i = 0; i < n; i++) {
      const d = this.drops.length < MAX_DROPS ? newDrop() : oldest(this.drops);
      if (this.drops.length < MAX_DROPS) this.drops.push(d);
      addRandom(d.pos.copy(at), scale * 0.35);
      // Mostly along the bite, with a wide cone of scatter.
      addRandom(d.vel.copy(dir).multiplyScalar(4 + Math.random() * 11), 7);
      d.size = scale * (0.06 + Math.random() * 0.1);
      d.life = DROP_LIFE * (0.6 + Math.random() * 0.7);
    }
  }

  private spawnGibs(at: Vector3, dir: Vector3, n: number, scale: number): void {
    for (let i = 0; i < n; i++) {
      const g = this.gibs.length < MAX_GIBS ? newGib() : oldest(this.gibs);
      if (this.gibs.length < MAX_GIBS) this.gibs.push(g);
      addRandom(g.pos.copy(at), scale * 0.4);
      addRandom(g.vel.copy(dir).multiplyScalar(2 + Math.random() * 6), 5);
      g.spin.set(rand(6), rand(6), rand(6));
      g.rot.identity();
      g.size = scale * (0.12 + Math.random() * 0.24);
      g.life = GIB_LIFE * (0.7 + Math.random() * 0.6);
    }
  }

  private spawnCloud(at: Vector3, size: number, strength: number): void {
    const c = this.clouds.find((x) => x.life <= 0) ?? oldest(this.clouds);
    c.pos.copy(at);
    // Drifts slowly and rises a little, like real blood in still water.
    c.vel.set(rand(0.5), 0.25 + Math.random() * 0.4, rand(0.5));
    c.maxSize = Math.min(MAX_CLOUD_SIZE, size * (1.6 + Math.random() * 0.8));
    c.life = CLOUD_LIFE * (0.75 + Math.random() * 0.5) * strength;
    c.sprite.visible = true;
    c.mat.opacity = 0;
  }

  // ---- per-frame ----------------------------------------------------------

  /**
   * @param cameraPos where the eye is, for the near-cloud fade in updateClouds()
   */
  update(dt: number, cameraPos: Vector3): void {
    this.updateDrops(dt);
    this.updateGibs(dt);
    this.updateClouds(dt, cameraPos);
  }

  private updateDrops(dt: number): void {
    let n = 0;
    for (const d of this.drops) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vel.y -= GRAVITY * dt;
      d.vel.multiplyScalar(Math.exp(-WATER_DRAG * 2.2 * dt));
      d.pos.addScaledVector(d.vel, dt);
      if (d.life <= 0) continue;
      const k = Math.min(1, d.life / DROP_LIFE);
      _s.setScalar(d.size * k);
      _m.compose(d.pos, _q.identity(), _s);
      this.dropMesh.setMatrixAt(n++, _m);
    }
    this.dropMesh.count = n;
    if (n > 0) this.dropMesh.instanceMatrix.needsUpdate = true;
  }

  private updateGibs(dt: number): void {
    let n = 0;
    for (const g of this.gibs) {
      if (g.life <= 0) continue;
      g.life -= dt;
      g.vel.y -= GRAVITY * dt;
      g.vel.multiplyScalar(Math.exp(-WATER_DRAG * dt));
      g.pos.addScaledVector(g.vel, dt);
      // Tumble, slowing as drag takes hold.
      _q.setFromAxisAngle(_v.copy(g.spin).normalize(), g.spin.length() * dt);
      g.rot.multiply(_q).normalize();
      g.spin.multiplyScalar(Math.exp(-1.1 * dt));
      if (g.life <= 0) continue;
      // Shrink away at the end rather than popping out.
      const k = Math.min(1, g.life / 1.2);
      _s.setScalar(g.size * k);
      _m.compose(g.pos, g.rot, _s);
      this.gibMesh.setMatrixAt(n++, _m);
    }
    this.gibMesh.count = n;
    if (n > 0) this.gibMesh.instanceMatrix.needsUpdate = true;
  }

  private updateClouds(dt: number, cameraPos: Vector3): void {
    for (const c of this.clouds) {
      if (c.life <= 0) {
        if (c.sprite.visible) c.sprite.visible = false;
        continue;
      }
      c.life -= dt;

      c.vel.multiplyScalar(Math.exp(-0.6 * dt));
      c.pos.addScaledVector(c.vel, dt);
      c.sprite.position.copy(c.pos);

      const age = 1 - Math.max(0, c.life) / CLOUD_LIFE;
      // Bloom fast, then disperse slowly — the shape of real diffusion.
      const grow = Math.pow(Math.min(1, age * 4.5), 0.55);
      const radius = c.maxSize * (0.25 + grow * 0.9) * 0.5;
      c.sprite.scale.setScalar(radius * 2);
      // Hold near-full opacity for the first half of its life so the stain
      // genuinely lingers, then fade out.
      let opacity = 0.54 * Math.min(1, age * 6) * Math.pow(1 - age, 1.4);

      // NEAR-CAMERA FADE. The chase camera sits under two metres behind the
      // host and bites land directly in front of it, so a cloud is almost
      // always born close to the eye. Without this, a single kill drops a
      // multi-metre sprite across the whole viewport: you cannot see, and the
      // GPU blends a full-screen transparent layer per puff. Fading a cloud out
      // as the eye enters it keeps the stain readable from outside, never walls
      // off the view, and — because a fully faded cloud is skipped entirely —
      // removes the worst-case overdraw instead of merely making it prettier.
      const d = Math.sqrt(
        (c.pos.x - cameraPos.x) ** 2 +
        (c.pos.y - cameraPos.y) ** 2 +
        (c.pos.z - cameraPos.z) ** 2,
      );
      const near = Math.min(1, Math.max(0, (d - radius * 0.4) / Math.max(0.001, radius * 0.7)));
      opacity *= near;

      c.mat.opacity = opacity;
      // Skip the draw call altogether once it contributes nothing.
      c.sprite.visible = opacity > 0.004;
      if (c.life <= 0) c.sprite.visible = false;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.gibs.length = 0;
    this.drops.length = 0;
    this.clouds.length = 0;
  }
}

// ---- helpers --------------------------------------------------------------

function rand(n: number): number {
  return (Math.random() - 0.5) * 2 * n;
}

/**
 * Add a random offset to `v` in place.
 *
 * This used to be a `randomIn()` that returned a fresh Vector3, which meant a
 * single big kill allocated ~250 throwaway vectors and a frenzy allocated
 * thousands — directly contradicting this file's "nothing here allocates during
 * play" promise, and handing the GC a reason to hitch at the exact moment the
 * screen is busiest. Writing in place keeps that promise true.
 */
function addRandom(v: Vector3, n: number): Vector3 {
  v.x += rand(n);
  v.y += rand(n);
  v.z += rand(n);
  return v;
}

function newGib(): Gib {
  return {
    pos: new Vector3(),
    vel: new Vector3(),
    spin: new Vector3(),
    rot: new Quaternion(),
    size: 1,
    life: 0,
  };
}

function newDrop(): Drop {
  return { pos: new Vector3(), vel: new Vector3(), life: 0, size: 1 };
}

function oldest<T extends { life: number }>(pool: T[]): T {
  let best = pool[0];
  for (const p of pool) if (p.life < best.life) best = p;
  return best;
}

/** Soft radial blob for the blood clouds, with a little internal mottling. */
function makeSoftBlob(): CanvasTexture {
  const size = 128;
  const c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(c, c, 1, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Break up the perfect circle so overlapping puffs do not read as bubbles.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = c * (0.35 + Math.random() * 0.6);
    const rr = c * (0.06 + Math.random() * 0.16);
    const bg = ctx.createRadialGradient(
      c + Math.cos(a) * r, c + Math.sin(a) * r, 0,
      c + Math.cos(a) * r, c + Math.sin(a) * r, rr,
    );
    bg.addColorStop(0, 'rgba(0,0,0,0.5)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}
