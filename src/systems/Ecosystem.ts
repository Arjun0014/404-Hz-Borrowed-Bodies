import { Group, type Scene, Vector3 } from 'three';
import { SpatialHash } from './SpatialHash';
import { Creature, type EcoContext, type SchoolRef } from '../entities/Creature';
import { CreatureFactory, type CreatureInstance } from '../entities/CreatureFactory';
import { SPECIES, speciesById, type CreatureSpecies, type PopEntry } from '../data/creatures';
import { lengthAt, rollWildGrowth } from '../data/growth';
import type { AssetLoader } from '../core/AssetLoader';
import type { SignalCarrier, CarrierHitResult } from '../entities/SignalCarrier';
import type { DeadSignalField } from './DeadSignalField';
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

// Distance bands (m, from the player). Creatures live spread across the whole
// shelf (they do NOT follow the player), so only those the player is near cost
// full AI + animation; distant ones are throttled and eventually hidden. Position
// always integrates every frame so nothing ever stutters when it re-enters view.
const NEAR = 55;
const MID = 100;
const FAR = 150; // beyond this we stop rendering + animating

// Radius kept clear of creatures around the player's spawn, and the seconds it
// stays clear after taking control (issue: getting swarmed the instant you dive).
const SPAWN_SAFE_R = 46;
const SPAWN_SAFE_SECONDS = 30;

// Growth biomass economy. Each bite tears a chunk worth BITE_CHUNK × the fish's
// body length; finishing (killing/eating) it whole adds FINISH_BONUS × length.
// So big fish are worth far more per chunk and much more whole — but riskier.
const BITE_CHUNK = 0.4;
const FINISH_BONUS = 1.0;

// ---- Dead Signal Field frenzy director (Phase 13) ----
// The field is the game's worst-case scene, so participation is explicitly
// budgeted rather than "everything inside joins". Creatures nearest the player
// are enrolled first, so the brawl the player can actually see is always full
// while the crowd out in the fog stays cheap.
const FRENZY_CAP = 30;
/** Seconds of frenzy granted per enrolment; refreshed while a creature stays in. */
const FRENZY_REFRESH = 3.0;
/** How far outside the boundary the field's pull reaches, as a multiple of radius. */
const FIELD_PULL_MULT = 2.1;
/** Re-run the director every N frames (it is a full-population scan). */
const DIRECTOR_STRIDE = 12;

/** A coherent shoal: a roaming centre its members steer toward as one body. */
interface School {
  species: CreatureSpecies;
  ref: SchoolRef;
  wanderAngle: number;
  depthOffset: number;
}

/** Per-fish size around a shoal's shared base size, so a school reads coherent. */
function schoolGrowth(ref: SchoolRef): number {
  return Math.max(0, Math.min(1, ref.growth + (Math.random() - 0.5) * 0.14));
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
  /** Called when the player's bite kills a creature (for Dominance/score). */
  onPlayerKill: (c: Creature) => void = () => {};
  /**
   * The zone's Signal Carrier, if one is standing. The ecosystem owns the link so
   * every attack path (bite, apex sweep, grouper inhale) resolves against it
   * through the one bite function, and so its aura reaches creature AI.
   */
  carrier: SignalCarrier | null = null;
  /** The active Dead Signal Field, if any — drives the frenzy director. */
  field: DeadSignalField | null = null;
  /** True while the host is inside the Carrier's aura (garrison trigger). */
  private playerInAura = false;
  /** How many creatures are currently frenzied (debug/HUD readout). */
  frenzyCount = 0;
  private playerThreatT = 0;
  private terrain: TerrainLike | null = null;
  private colliders: CylinderCollider[] = [];
  private bounds: ZoneBounds | null = null;
  private area: PopulationArea | null = null;
  // Spawn-safe bubble: creatures are repelled from it and cannot bite the player
  // while it is active (a calm moment at the start of a zone).
  private spawnSafeT = 0;
  private readonly _spawnSafe = new Vector3();

  private readonly _playerPos = new Vector3();
  private readonly _biteVec = new Vector3();
  private readonly _nbr: number[] = [];
  /** Reused participant buffer for the frenzy director (no per-call allocation). */
  private readonly _frenzyBuf: number[] = [];
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
      spawnSafeActive: false,
      spawnSafe: this._spawnSafe,
      spawnSafeR: SPAWN_SAFE_R,
      carrierPos: null,
      carrierAuraR: 0,
      playerInAura: false,
      fieldPos: null,
      fieldR: 0,
      fieldPullR: 0,
    };
  }

  /** Keep a bubble around (x,z) clear of creatures for `seconds` (spawn grace). */
  armSpawnSafe(x: number, z: number, seconds = SPAWN_SAFE_SECONDS): void {
    this._spawnSafe.set(x, 0, z);
    this.spawnSafeT = seconds;
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
    // Carrier + field are zone-scoped; GameApp owns their lifetime and re-links
    // them after the new zone is standing.
    this.carrier = null;
    this.field = null;
    this.frenzyCount = 0;
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
      // Keep the spawn clear until the player actually takes control; GameApp
      // re-arms the real 30 s window on beginPlay/descent.
      this.armSpawnSafe(this._playerPos.x, this._playerPos.z, 1e9);
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
          const school = this.newSchool(sp);
          for (let i = 0; i < n; i++) {
            const x = school.ref.center.x + (Math.random() - 0.5) * 10;
            const z = school.ref.center.z + (Math.random() - 0.5) * 10;
            const c = this.spawnAt(sp, x, z, school.ref.center.y, phase++, schoolGrowth(school.ref));
            c.school = school.ref;
            made++;
          }
        }
      } else {
        // Solitary fish: scattered uniformly across the whole shelf.
        for (let i = 0; i < entry.count; i++) {
          const s = this.habitatSpot();
          const py = this.preferredYFor(sp, s.x, s.z);
          this.spawnAt(sp, s.x, s.z, py, phase++, rollWildGrowth(sp.wildMaxGrowth));
        }
      }
    }
  }

  private newSchool(sp: CreatureSpecies): School {
    const s = this.habitatSpot();
    const gy = this.terrain!.heightAt(s.x, s.z);
    const depthOffset = 5 + Math.random() * 12;
    const center = new Vector3(s.x, this.clampY(gy + depthOffset), s.z);
    const school: School = {
      species: sp,
      ref: { center, vel: new Vector3(), growth: rollWildGrowth(sp.wildMaxGrowth) },
      wanderAngle: Math.random() * Math.PI * 2,
      depthOffset,
    };
    this.schools.push(school);
    return school;
  }

  private spawnAt(
    sp: CreatureSpecies,
    x: number,
    z: number,
    y: number,
    phase: number,
    growth01: number,
  ): Creature {
    const inst = this.factory.createInstance(sp.id);
    this.group.add(inst.root);
    const c = new Creature(sp, inst);
    c.phase = phase % 6;
    const len = lengthAt(sp.baseLength, growth01);
    const gy = this.terrain!.heightAt(x, z);
    const py = this.preferredYFor(sp, x, z);
    const spawnY = sp.role === 'crab' ? gy + len * 0.3 : Math.max(gy + len * 0.45 + 0.5, y);
    c.spawn(x, spawnY, z, py, growth01);
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

  /** A uniform random point on the shelf, avoiding the active spawn-safe bubble. */
  private habitatSpot(): { x: number; z: number } {
    const a = this.area!;
    for (let tries = 0; tries < 8; tries++) {
      const x = a.minX + Math.random() * (a.maxX - a.minX);
      const z = a.minZ + Math.random() * (a.maxZ - a.minZ);
      if (this.spawnSafeT > 0) {
        const d = Math.hypot(x - this._spawnSafe.x, z - this._spawnSafe.z);
        if (d < SPAWN_SAFE_R + 8) continue;
      }
      return { x, z };
    }
    return {
      x: a.minX + Math.random() * (a.maxX - a.minX),
      z: a.minZ + Math.random() * (a.maxZ - a.minZ),
    };
  }

  private respawn(c: Creature): void {
    if (!this.area) return;
    let x: number;
    let z: number;
    let py: number;
    let growth01: number;
    if (c.school) {
      // Rejoin the shoal so schools stay whole and replenish together, at the
      // shoal's own size band.
      x = c.school.center.x + (Math.random() - 0.5) * 10;
      z = c.school.center.z + (Math.random() - 0.5) * 10;
      x = clamp(x, this.area.minX, this.area.maxX);
      z = clamp(z, this.area.minZ, this.area.maxZ);
      py = c.school.center.y;
      growth01 = schoolGrowth(c.school);
    } else {
      const s = this.habitatSpot();
      x = s.x;
      z = s.z;
      py = this.preferredYFor(c.species, x, z);
      growth01 = rollWildGrowth(c.species.wildMaxGrowth);
    }
    const gy = this.terrain!.heightAt(x, z);
    const len = lengthAt(c.species.baseLength, growth01);
    const y = c.species.role === 'crab' ? gy + len * 0.3 : Math.max(gy + len * 0.45 + 0.5, py);
    c.spawn(x, y, z, py, growth01);
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
    if (this.spawnSafeT > 0) this.spawnSafeT -= dt;
    this.ctx.spawnSafeActive = this.spawnSafeT > 0;

    // Publish the Carrier's aura + the field's boundary into the AI context.
    const carrier = this.carrier?.alive ? this.carrier : null;
    this.playerInAura = !!carrier && carrier.auraStrength(this._playerPos) > 0;
    this.ctx.carrierPos = carrier ? carrier.pos : null;
    this.ctx.carrierAuraR = carrier ? carrier.auraRadius : 0;
    this.ctx.playerInAura = this.playerInAura;
    const field = this.field?.active ? this.field : null;
    this.ctx.fieldPos = field ? field.pos : null;
    this.ctx.fieldR = field ? field.radius : 0;
    this.ctx.fieldPullR = field ? field.radius * FIELD_PULL_MULT : 0;
    if (field && this.frame % DIRECTOR_STRIDE === 0) this.driveFrenzy(field);
    else if (!field) this.frenzyCount = 0;

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
        thinkStride = 24; animStride = 0; visible = false; // far offscreen: cheap
      }
      c.inst.root.visible = visible;

      const f = this.frame + c.phase;
      if (f % thinkStride === 0) c.think(this.ctx, dt * thinkStride);

      // Move every frame while visible (smooth). Far offscreen creatures barely
      // move (they aren't seen) — enough to keep the world drifting, near-zero cost.
      if (visible) {
        c.move(this.ctx, dt);
        if (animStride > 0 && f % animStride === 0) c.animate(dt * animStride);
      } else if (f % 8 === 0) {
        c.move(this.ctx, dt * 8);
      }
    }
  }

  /**
   * The frenzy director. Enrols creatures standing inside the field into the
   * brawl, capped at FRENZY_CAP and prioritised by distance to the player, so the
   * chaos is always densest where it can be seen and the worst case stays bounded
   * no matter how many creatures drift in. Runs on a stride, not every frame.
   */
  private driveFrenzy(field: DeadSignalField): void {
    const r2 = field.radius * field.radius;
    // Collect who is inside, cheapest first: one squared-distance test each.
    // The buffer is reused — this runs during the heaviest scene in the game and
    // has no business generating garbage.
    const inside = this._frenzyBuf;
    inside.length = 0;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      if (!c.alive || c.species.role === 'crab') continue;
      if (c.pos.distanceToSquared(field.pos) < r2) inside.push(i);
    }
    // Nearest to the player wins a slot — the visible fight is the one that matters.
    if (inside.length > FRENZY_CAP) {
      const p = this._playerPos;
      inside.sort(
        (a, b) =>
          this.creatures[a].pos.distanceToSquared(p) - this.creatures[b].pos.distanceToSquared(p),
      );
      inside.length = FRENZY_CAP;
    }
    for (const i of inside) this.creatures[i].enterFrenzy(FRENZY_REFRESH);
    this.frenzyCount = inside.length;
  }

  /**
   * Seed the Carrier's garrison: relocate the nearest wild predators into a ring
   * around it so the relay is defended from the moment the player finds it,
   * instead of only once the ecosystem happens to drift over. Called once, when
   * the Carrier is placed.
   */
  garrisonCarrier(at: Vector3, count: number): number {
    if (!this.terrain || !this.area) return 0;
    // Prefer the predators already furthest from the player, so seeding the
    // garrison never yanks a fish out from under them mid-fight.
    const cands = this.creatures
      .filter((c) => c.alive && c.species.role === 'predator')
      .sort((a, b) => b.pos.distanceToSquared(this._playerPos) - a.pos.distanceToSquared(this._playerPos))
      .slice(0, count);
    cands.forEach((c, i) => {
      const a = (i / Math.max(1, cands.length)) * Math.PI * 2 + Math.random() * 0.5;
      const r = 22 + Math.random() * 24;
      const x = clamp(at.x + Math.cos(a) * r, this.area!.minX, this.area!.maxX);
      const z = clamp(at.z + Math.sin(a) * r, this.area!.minZ, this.area!.maxZ);
      const gy = this.terrain!.heightAt(x, z);
      const y = this.clampY(Math.max(gy + c.length * 0.6 + 2, at.y - 8 + Math.random() * 16));
      c.pos.set(x, y, z);
      c.preferredY = y;
      c.vel.set(0, 0, 0);
    });
    return cands.length;
  }

  /** Roam a shoal's centre freely across the shelf (it does NOT follow the player). */
  private updateSchool(s: School, dt: number): void {
    s.wanderAngle += (Math.random() - 0.5) * 0.8 * dt;
    const cruise = s.species.maxSpeed * 0.5;
    let vx = Math.sin(s.wanderAngle) * cruise;
    let vz = Math.cos(s.wanderAngle) * cruise;

    // Steer the shoal away from the spawn-safe bubble while it is active.
    if (this.spawnSafeT > 0) {
      const dx = s.ref.center.x - this._spawnSafe.x;
      const dz = s.ref.center.z - this._spawnSafe.z;
      const d = Math.hypot(dx, dz);
      if (d < SPAWN_SAFE_R + 14 && d > 1e-3) {
        vx += (dx / d) * cruise * 2.2;
        vz += (dz / d) * cruise * 2.2;
      }
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

  /** Read-only view of the population (for HP-bar rendering + possession targeting). */
  get list(): readonly Creature[] {
    return this.creatures;
  }

  /**
   * Build a renderable body for a species so the player can wear it after
   * possession (Phase 7). Reuses the already-loaded species template — no
   * network load — and the caller owns/disposes the returned instance.
   */
  createHostInstance(speciesId: string): CreatureInstance {
    return this.factory.createInstance(speciesId);
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
  ): { hit: number; eaten: number; killed: number; biomass: number; carrier: CarrierHitResult | null } {
    let hit = 0;
    let eaten = 0;
    let killed = 0;
    let biomass = 0; // total body length consumed, for growth
    // The Signal Carrier shares the bite's geometry, so every attack the player
    // has — bite, apex sweep, grouper inhale — damages it without special cases.
    let carrier: CarrierHitResult | null = null;
    if (this.carrier?.alive) {
      const r = this.carrier.tryHit(origin, forward, reach, minDot, damage);
      if (r.hit) {
        carrier = r;
        hit++;
      }
    }
    if (!this.terrain) return { hit, eaten, killed, biomass, carrier };
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
      c.provoke(); // the apex only retaliates against a host that attacks it
      hit++;
      const edible = c.species.role !== 'crab' && c.length <= eatMaxLen;
      const died = edible ? c.takeDamage(9999) : c.takeDamage(damage);
      if (edible && died) eaten++;
      else if (died) killed++;
      if (died) this.onPlayerKill(c); // Dominance credit for the defeat
      // Biomass is a CHUNK proportional to the fish's size (a chunk of a big
      // fish is worth more), plus a bonus for finishing/eating it whole.
      biomass += c.length * BITE_CHUNK;
      if (died) biomass += c.length * FINISH_BONUS;
    }
    if (hit > 0) this.playerThreatT = 2.5; // nearby prey flee the aggressor
    return { hit, eaten, killed, biomass, carrier };
  }

  /** Startle nearby prey away from the host (a failed risk-snatch alerts the sea). */
  alertPrey(): void {
    this.playerThreatT = Math.max(this.playerThreatT, 2.5);
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
