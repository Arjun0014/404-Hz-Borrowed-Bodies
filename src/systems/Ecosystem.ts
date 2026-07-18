import { Group, type Scene, Vector3 } from 'three';
import { SpatialHash } from './SpatialHash';
import { Creature, type EcoContext } from '../entities/Creature';
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
}

// Distance tiers (m) → how often a creature thinks. Kept visible past FULL so
// nothing pops; only AI + animation cost is throttled with distance.
const FULL = 50;
const MID = 100;
const CULL = 175;

/**
 * The living ecosystem: a fixed pooled population per zone, updated in
 * distance-staggered tiers over a spatial hash. Prey school and flee, predators
 * hunt, crabs ambush, and eaten creatures respawn far away — a constant,
 * self-replenishing population at bounded CPU cost.
 */
export class Ecosystem {
  private readonly group = new Group();
  private readonly factory: CreatureFactory;
  private readonly hash = new SpatialHash(10);
  private readonly creatures: Creature[] = [];
  private frame = 0;

  /** Debug: freeze all AI (used to calibrate model orientation). */
  paused = false;
  private terrain: TerrainLike | null = null;
  private colliders: CylinderCollider[] = [];
  private bounds: ZoneBounds | null = null;
  private area: PopulationArea | null = null;

  private readonly _playerPos = new Vector3();
  private readonly _nbr: number[] = [];
  private readonly ctx: EcoContext;

  constructor(loader: AssetLoader, scene: Scene) {
    this.factory = new CreatureFactory(loader);
    this.group.name = 'ecosystem';
    scene.add(this.group);
    this.ctx = {
      dt: 0,
      time: 0,
      playerPos: this._playerPos,
      playerLength: 0.5,
      terrain: null as unknown as TerrainLike,
      colliders: this.colliders,
      bounds: null as unknown as ZoneBounds,
      creatures: this.creatures,
      queryNeighbors: (x, z, r) => this.queryNeighbors(x, z, r),
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
    if (b.area) this.populate(b.population);
  }

  private despawnAll(): void {
    for (const c of this.creatures) {
      this.group.remove(c.inst.root);
      CreatureFactory.disposeInstance(c.inst);
    }
    this.creatures.length = 0;
  }

  // ---- population ----------------------------------------------------------

  private populate(population: PopEntry[]): void {
    let phase = 0;
    for (const entry of population) {
      const sp = speciesById(entry.speciesId);
      if (entry.schoolSize && sp.schooling) {
        let made = 0;
        while (made < entry.count) {
          const center = this.randomSpot();
          const py = this.preferredYFor(sp, center.x, center.z);
          const n = Math.min(entry.schoolSize, entry.count - made);
          for (let i = 0; i < n; i++) {
            const x = center.x + (Math.random() - 0.5) * 7;
            const z = center.z + (Math.random() - 0.5) * 7;
            this.spawnAt(sp, x, z, py + (Math.random() - 0.5) * 2.5, phase++);
            made++;
          }
        }
      } else {
        for (let i = 0; i < entry.count; i++) {
          const spot = this.randomSpot();
          const py = this.preferredYFor(sp, spot.x, spot.z);
          this.spawnAt(sp, spot.x, spot.z, py, phase++);
        }
      }
    }
  }

  private spawnAt(sp: CreatureSpecies, x: number, z: number, y: number, phase: number): void {
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
  }

  private preferredYFor(sp: CreatureSpecies, x: number, z: number): number {
    const gy = this.terrain!.heightAt(x, z);
    const ceil = this.bounds!.ceilingY - 2;
    let y: number;
    switch (sp.role) {
      case 'prey': y = gy + 1.5 + Math.random() * 11; break;
      case 'forager': y = gy + 2 + Math.random() * 6; break;
      case 'predator': y = gy + 4 + Math.random() * 13; break;
      default: y = gy + sp.baseLength * 0.3; break; // crab
    }
    return Math.min(y, ceil);
  }

  private randomSpot(): { x: number; z: number } {
    const a = this.area!;
    return {
      x: a.minX + Math.random() * (a.maxX - a.minX),
      z: a.minZ + Math.random() * (a.maxZ - a.minZ),
    };
  }

  private respawn(c: Creature): void {
    if (!this.area) return;
    // Prefer a spot away from the player so it fades in through the fog.
    let x = 0;
    let z = 0;
    for (let t = 0; t < 8; t++) {
      const s = this.randomSpot();
      x = s.x;
      z = s.z;
      if (Math.hypot(x - this._playerPos.x, z - this._playerPos.z) > 45) break;
    }
    const py = this.preferredYFor(c.species, x, z);
    const gy = this.terrain!.heightAt(x, z);
    const lengthMul = 1 + (Math.random() * 2 - 1) * c.species.sizeVar;
    const len = c.species.baseLength * lengthMul;
    const y = c.species.role === 'crab' ? gy + len * 0.3 : Math.max(gy + len * 0.45 + 0.5, py);
    c.spawn(x, y, z, py, lengthMul);
  }

  // ---- per-frame update ----------------------------------------------------

  update(dt: number, playerPos: Vector3, playerLength: number): void {
    if (this.paused || this.creatures.length === 0 || !this.terrain) return;
    this.frame++;
    this._playerPos.copy(playerPos);
    this.ctx.playerLength = playerLength;
    this.ctx.time += dt;

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
      let stride: number;
      if (d2 < FULL * FULL) stride = 1;
      else if (d2 < MID * MID) stride = 3;
      else if (d2 < CULL * CULL) stride = 6;
      else {
        c.inst.root.visible = false;
        continue;
      }
      c.inst.root.visible = true;
      if ((this.frame + c.phase) % stride === 0) {
        this.ctx.dt = dt * stride;
        c.update(this.ctx);
      }
    }
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
