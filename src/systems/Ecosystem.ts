import { Group, type Scene, Vector3 } from 'three';
import { SpatialHash } from './SpatialHash';
import { Creature, type EcoContext, type SchoolRef } from '../entities/Creature';
import { CreatureFactory } from '../entities/CreatureFactory';
import { SPECIES, speciesById, type CreatureSpecies, type PopEntry } from '../data/creatures';
import type { AssetLoader } from '../core/AssetLoader';
import type { CylinderCollider, PopulationArea, TerrainLike, ZoneBounds } from '../world/types';

export interface ZoneBinding {
  terrain: TerrainLike;
  colliders: CylinderCollider[];
  bounds: ZoneBounds;
  /** Null → this zone has no ecosystem (e.g. the blockout). */
  area: PopulationArea | null;
  population: PopEntry[];
  /** Where to gather the population initially (the player's spawn). */
  focus?: Vector3;
}

// Distance bands (m, from the player). The whole population is kept gathered
// around the player by a soft "home pull", so almost everything sits inside the
// visible bands; only AI + animation *cost* is throttled with distance, and
// position always integrates every frame so nothing ever stutters.
const NEAR = 55;
const MID = 100;
const FAR = 155; // beyond this we stop rendering + animating (still drifts home)

// Where dead/returning creatures reappear: a ring out in the murk around the
// player, so they fade in and swim toward you rather than popping in close.
const RING_MIN = 55;
const RING_MAX = 115;
// No creature spawns inside this radius of the player at zone load, so you get a
// calm moment as the world swims in rather than materializing on top of you.
const SPAWN_CLEAR = 34;

// Growth biomass economy. Each bite tears a chunk worth BITE_CHUNK × the fish's
// body length; finishing (killing/eating) it whole adds FINISH_BONUS × length.
// So big fish are worth far more per chunk and much more whole — but riskier.
const BITE_CHUNK = 0.4;
const FINISH_BONUS = 1.0;

/** A coherent shoal: a roaming centre its members steer toward as one body. */
interface School {
  species: CreatureSpecies;
  ref: SchoolRef;
  wanderAngle: number;
  depthOffset: number;
}

/**
 * The living ecosystem. A fixed pooled population that the player is always in
 * the middle of: schools swim together and part around you, foragers graze,
 * predators and an apex shark hunt the schools, crabs ambush from the seabed,
 * and anything eaten swims back in from the deep — a constant, self-replenishing
 * world at bounded CPU cost.
 */
export class Ecosystem {
  private readonly group = new Group();
  private readonly factory: CreatureFactory;
  private readonly hash = new SpatialHash(10);
  private readonly creatures: Creature[] = [];
  private readonly schools: School[] = [];
  private frame = 0;

  /** Debug: freeze all AI (used to calibrate model orientation). */
  paused = false;
  /** Called when a predator bites the host. Set by GameApp/PlayerCombat. */
  onHitPlayer: (dmg: number) => void = () => {};
  private playerThreatT = 0;
  private terrain: TerrainLike | null = null;
  private colliders: CylinderCollider[] = [];
  private bounds: ZoneBounds | null = null;
  private area: PopulationArea | null = null;

  private readonly _playerPos = new Vector3();
  private readonly _biteVec = new Vector3();
  private readonly _nbr: number[] = [];
  private readonly ctx: EcoContext;

  constructor(loader: AssetLoader, scene: Scene) {
    this.factory = new CreatureFactory(loader);
    this.group.name = 'ecosystem';
    scene.add(this.group);
    this.ctx = {
      time: 0,
      playerPos: this._playerPos,
      playerLength: 0.5,
      playerAlive: true,
      playerThreatT: 0,
      terrain: null as unknown as TerrainLike,
      colliders: this.colliders,
      bounds: null as unknown as ZoneBounds,
      habitat: null as unknown as PopulationArea,
      creatures: this.creatures,
      queryNeighbors: (x, z, r) => this.queryNeighbors(x, z, r),
      hitPlayer: (dmg) => this.onHitPlayer(dmg),
    };
  }

  /** Load every species model once (templates persist across zones). */
  async load(): Promise<void> {
    await this.factory.loadAll(SPECIES);
  }

  get count(): number {
    return this.creatures.length;
  }

  /** Swap to a new zone: dispose the old population, build the new one. */
  bindZone(b: ZoneBinding): void {
    this.despawnAll();
    this.terrain = b.terrain;
    this.colliders = b.colliders;
    this.bounds = b.bounds;
    this.area = b.area;
    this.ctx.terrain = b.terrain;
    this.ctx.colliders = b.colliders;
    this.ctx.bounds = b.bounds;
    this.ctx.habitat = b.area as PopulationArea;
    if (b.area) {
      if (b.focus) this._playerPos.copy(b.focus);
      else this._playerPos.set((b.area.minX + b.area.maxX) / 2, 0, (b.area.minZ + b.area.maxZ) / 2);
      this.populate(b.population);
    }
  }

  private despawnAll(): void {
    for (const c of this.creatures) {
      this.group.remove(c.inst.root);
      CreatureFactory.disposeInstance(c.inst);
    }
    this.creatures.length = 0;
    this.schools.length = 0;
  }

  // ---- population ----------------------------------------------------------

  private populate(population: PopEntry[]): void {
    let phase = 0;
    for (const entry of population) {
      const sp = speciesById(entry.speciesId);
      if (entry.schoolSize && sp.schooling) {
        let made = 0;
        while (made < entry.count) {
          const n = Math.min(entry.schoolSize, entry.count - made);
          const school = this.newSchool(sp, SPAWN_CLEAR, RING_MAX);
          for (let i = 0; i < n; i++) {
            const x = school.ref.center.x + (Math.random() - 0.5) * 10;
            const z = school.ref.center.z + (Math.random() - 0.5) * 10;
            const c = this.spawnAt(sp, x, z, school.ref.center.y, phase++);
            c.school = school.ref;
            made++;
          }
        }
      } else {
        for (let i = 0; i < entry.count; i++) {
          const s = this.ringSpot(SPAWN_CLEAR, RING_MAX);
          const py = this.preferredYFor(sp, s.x, s.z);
          this.spawnAt(sp, s.x, s.z, py, phase++);
        }
      }
    }
  }

  private newSchool(sp: CreatureSpecies, rMin: number, rMax: number): School {
    const s = this.ringSpot(rMin, rMax);
    const gy = this.terrain!.heightAt(s.x, s.z);
    const depthOffset = 5 + Math.random() * 12;
    const center = new Vector3(s.x, this.clampY(gy + depthOffset), s.z);
    const school: School = {
      species: sp,
      ref: { center, vel: new Vector3() },
      wanderAngle: Math.random() * Math.PI * 2,
      depthOffset,
    };
    this.schools.push(school);
    return school;
  }

  private spawnAt(sp: CreatureSpecies, x: number, z: number, y: number, phase: number): Creature {
    const inst = this.factory.createInstance(sp.id);
    this.group.add(inst.root);
    const c = new Creature(sp, inst);
    c.phase = phase % 6;
    const lengthMul = 1 + (Math.random() * 2 - 1) * sp.sizeVar;
    const len = sp.baseLength * lengthMul;
    const gy = this.terrain!.heightAt(x, z);
    const py = this.preferredYFor(sp, x, z);
    const spawnY = sp.role === 'crab' ? gy + len * 0.3 : Math.max(gy + len * 0.45 + 0.5, y);
    c.spawn(x, spawnY, z, py, lengthMul);
    this.creatures.push(c);
    return c;
  }

  private preferredYFor(sp: CreatureSpecies, x: number, z: number): number {
    const gy = this.terrain!.heightAt(x, z);
    let y: number;
    switch (sp.role) {
      case 'prey': y = gy + 2 + Math.random() * 12; break;
      case 'forager': y = gy + 2 + Math.random() * 7; break;
      case 'predator': y = gy + 5 + Math.random() * 14; break;
      default: y = gy + sp.baseLength * 0.3; break; // crab
    }
    return this.clampY(y);
  }

  private clampY(y: number): number {
    const ceil = this.bounds!.ceilingY - 2;
    return Math.min(y, ceil);
  }

  /** A point on a ring around the player, clamped to the shelf habitat. */
  private ringSpot(rMin: number, rMax: number): { x: number; z: number } {
    const a = this.area!;
    const ang = Math.random() * Math.PI * 2;
    const r = rMin + Math.random() * (rMax - rMin);
    const x = clamp(this._playerPos.x + Math.cos(ang) * r, a.minX, a.maxX);
    const z = clamp(this._playerPos.z + Math.sin(ang) * r, a.minZ, a.maxZ);
    return { x, z };
  }

  private respawn(c: Creature): void {
    if (!this.area) return;
    let x: number;
    let z: number;
    let py: number;
    if (c.school) {
      // Rejoin the shoal so schools stay whole and replenish together.
      x = c.school.center.x + (Math.random() - 0.5) * 10;
      z = c.school.center.z + (Math.random() - 0.5) * 10;
      x = clamp(x, this.area.minX, this.area.maxX);
      z = clamp(z, this.area.minZ, this.area.maxZ);
      py = c.school.center.y;
    } else {
      const s = this.ringSpot(RING_MIN, RING_MAX);
      x = s.x;
      z = s.z;
      py = this.preferredYFor(c.species, x, z);
    }
    const gy = this.terrain!.heightAt(x, z);
    const lengthMul = 1 + (Math.random() * 2 - 1) * c.species.sizeVar;
    const len = c.species.baseLength * lengthMul;
    const y = c.species.role === 'crab' ? gy + len * 0.3 : Math.max(gy + len * 0.45 + 0.5, py);
    c.spawn(x, y, z, py, lengthMul);
  }

  // ---- per-frame update ----------------------------------------------------

  update(dt: number, playerPos: Vector3, playerLength: number, playerAlive = true): void {
    if (this.paused || this.creatures.length === 0 || !this.terrain) return;
    this.frame++;
    this._playerPos.copy(playerPos);
    this.ctx.playerLength = playerLength;
    this.ctx.playerAlive = playerAlive;
    this.playerThreatT = Math.max(0, this.playerThreatT - dt);
    this.ctx.playerThreatT = this.playerThreatT;
    this.ctx.time += dt;

    // Roam the shoals (staggered — a couple per frame is plenty).
    for (let i = 0; i < this.schools.length; i++) {
      if ((this.frame + i) % 4 === 0) this.updateSchool(this.schools[i], dt * 4);
    }

    // Rebuild the neighbour grid from living creatures.
    this.hash.clear();
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (c.alive) this.hash.insert(i, c.pos.x, c.pos.z);
    }

    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (!c.alive) {
        c.respawnTimer -= dt;
        if (c.respawnTimer <= 0) this.respawn(c);
        continue;
      }

      const d2 = c.pos.distanceToSquared(this._playerPos);
      let thinkStride: number;
      let animStride: number;
      let visible: boolean;
      if (d2 < NEAR * NEAR) {
        thinkStride = 2; animStride = 1; visible = true;
      } else if (d2 < MID * MID) {
        thinkStride = 5; animStride = 2; visible = true;
      } else if (d2 < FAR * FAR) {
        thinkStride = 10; animStride = 3; visible = true;
      } else {
        thinkStride = 20; animStride = 0; visible = false; // hidden: still drifts home
      }
      c.inst.root.visible = visible;

      const f = this.frame + c.phase;
      if (f % thinkStride === 0) c.think(this.ctx, dt * thinkStride);

      // Move every frame while visible (smooth); hidden creatures drift home
      // slowly so they re-enter the bubble without any cost when unseen.
      if (visible) {
        c.move(this.ctx, dt);
        if (animStride > 0 && f % animStride === 0) c.animate(dt * animStride);
      } else if (f % 3 === 0) {
        c.move(this.ctx, dt * 3);
      }
    }
  }

  /** Roam a shoal's centre, keep it near the player and on the shelf. */
  private updateSchool(s: School, dt: number): void {
    s.wanderAngle += (Math.random() - 0.5) * 0.8 * dt;
    const cruise = s.species.maxSpeed * 0.5;
    let vx = Math.sin(s.wanderAngle) * cruise;
    let vz = Math.cos(s.wanderAngle) * cruise;

    // Home pull: keep the shoal gathered around the player.
    const dx = this._playerPos.x - s.ref.center.x;
    const dz = this._playerPos.z - s.ref.center.z;
    const hd = Math.hypot(dx, dz);
    if (hd > 65) {
      const w = Math.min((hd - 65) / 45, 1.5);
      vx += (dx / hd) * cruise * w * 1.8;
      vz += (dz / hd) * cruise * w * 1.8;
    }

    s.ref.vel.set(vx, 0, vz);
    s.ref.center.x += vx * dt;
    s.ref.center.z += vz * dt;

    // Keep the centre inside the shelf, a little inset from the edges.
    const a = this.area!;
    s.ref.center.x = clamp(s.ref.center.x, a.minX + 8, a.maxX - 8);
    s.ref.center.z = clamp(s.ref.center.z, a.minZ + 8, a.maxZ - 8);

    // Ease depth toward this shoal's band over the local seabed.
    const gy = this.terrain!.heightAt(s.ref.center.x, s.ref.center.z);
    const targetY = this.clampY(gy + s.depthOffset);
    s.ref.center.y += (targetY - s.ref.center.y) * Math.min(1, 2 * dt);
  }

  /** Read-only view of the population (for HP-bar rendering). */
  get list(): readonly Creature[] {
    return this.creatures;
  }

  /**
   * The host's lunge bite: damage every creature within `reach` of `origin` that
   * lies within the FRONT cone (dot(forward, toTarget) >= minDot). Small prey are
   * eaten (instant, for healing); anything bigger takes `damage` and can be killed
   * over repeated strikes. `alreadyHit` dedupes across the frames of one lunge so
   * each creature is hit at most once per strike. Call after update() (uses the
   * neighbour grid). Returns counts of hit / eaten / killed.
   */
  playerBiteCone(
    origin: Vector3,
    forward: Vector3,
    reach: number,
    minDot: number,
    eatMaxLen: number,
    damage: number,
    alreadyHit: Set<Creature>,
  ): { hit: number; eaten: number; killed: number; biomass: number } {
    let hit = 0;
    let eaten = 0;
    let killed = 0;
    let biomass = 0; // total body length consumed, for growth
    if (!this.terrain) return { hit, eaten, killed, biomass };
    const ids = this.queryNeighbors(origin.x, origin.z, reach + 3);
    for (let i = 0; i < ids.length; i++) {
      const c = this.creatures[ids[i]];
      if (!c.alive || alreadyHit.has(c)) continue;
      this._biteVec.subVectors(c.pos, origin);
      const d = this._biteVec.length();
      if (d > reach + c.radius) continue;
      const dot =
        d > 1e-3
          ? (forward.x * this._biteVec.x + forward.y * this._biteVec.y + forward.z * this._biteVec.z) / d
          : 1;
      if (dot < minDot) continue; // behind / to the side — no bite
      alreadyHit.add(c);
      hit++;
      const edible = c.species.role !== 'crab' && c.length <= eatMaxLen;
      const died = edible ? c.takeDamage(9999) : c.takeDamage(damage);
      if (edible && died) eaten++;
      else if (died) killed++;
      // Biomass is a CHUNK proportional to the fish's size (a chunk of a big
      // fish is worth more), plus a bonus for finishing/eating it whole.
      biomass += c.length * BITE_CHUNK;
      if (died) biomass += c.length * FINISH_BONUS;
    }
    if (hit > 0) this.playerThreatT = 2.5; // nearby prey flee the aggressor
    return { hit, eaten, killed, biomass };
  }

  private queryNeighbors(x: number, z: number, r: number): number[] {
    this._nbr.length = 0;
    this.hash.query(x, z, r, this._collect);
    return this._nbr;
  }

  private readonly _collect = (i: number): void => {
    this._nbr.push(i);
  };

  dispose(): void {
    this.despawnAll();
    this.factory.dispose();
    this.group.parent?.remove(this.group);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
