import {
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  RepeatWrapping,
  Scene,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type {
  CylinderCollider,
  DescentInfo,
  PopulationArea,
  TerrainLike,
  TerrainMaps,
  Zone,
  ZoneBounds,
} from './types';
import type { PopEntry } from '../data/creatures';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >> 13), 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smoother(x - ix);
  const fz = smoother(z - iz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const RADIUS = 130;
const HARD = 150;
const CEILING = 34;

/** Bowl heightfield for the blockout. Pure function → collision matches mesh. */
class BlockoutTerrain implements TerrainLike {
  heightAt(x: number, z: number): number {
    const r = Math.hypot(x, z);
    let h = -6 + vnoise(x * 0.02 + 3.3, z * 0.02 + 7.1) * 6 + vnoise(x * 0.06, z * 0.06) * 1.5;
    // Rim wall rising beyond the playable radius.
    h += smoothstep(RADIUS - 28, HARD + 10, r) * 46;
    return h;
  }
  slopeAt(x: number, z: number): number {
    const e = 1.5;
    const dhx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dhz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dhx, dhz) / (2 * e);
  }
}

/**
 * Temporary lower-zone prototype for Phase 2 (NOT the Drowned Garden art).
 * Deliberately abstract: a dark enclosed bowl with blockout pillars and a
 * glowing descent core. Proves the zone lifecycle — build, play, dispose.
 * Deeper instances (higher `depth`) get darker and colder.
 */
export class BlockoutZone implements Zone {
  readonly displayName: string;
  readonly group = new Group();
  readonly terrain = new BlockoutTerrain();
  readonly colliders: CylinderCollider[] = [];
  particleCount = 0;

  private readonly scene: Scene;
  private readonly depth: number;
  private time = 0;
  private fog!: FogExp2;
  private coreLight!: PointLight;
  private coreRing!: Mesh;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene, depth: number) {
    this.scene = scene;
    this.depth = depth;
    this.displayName = `Descent Blockout · Depth ${depth}`;
  }

  build(_renderer: WebGLRenderer, _particleScale: number, baseMaps?: TerrainMaps): void {
    // Colder + darker the deeper you go.
    const t = Math.min(1, (this.depth - 1) / 4);
    const fogCol = new Color(0x123344).lerp(new Color(0x05121c), t);
    this.fog = new FogExp2(fogCol.getHex(), 0.011 + t * 0.004);
    this.scene.fog = this.fog;
    this.scene.background = fogCol.clone();

    this.group.add(new HemisphereLight(0x4a7d92, 0x0a1a22, 0.7 - t * 0.2));
    const key = new DirectionalLight(0x9fd6e6, 0.6);
    key.position.set(30, 120, 20);
    this.group.add(key);

    this.buildFloor(baseMaps, fogCol);
    this.buildPillars(baseMaps);
    this.buildCore();

    this.scene.add(this.group);
  }

  private buildFloor(baseMaps: TerrainMaps | undefined, fogCol: Color): void {
    const segs = 140;
    const geo = new PlaneGeometry(HARD * 2.2, HARD * 2.2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const base = new Color(0x3a4a52);
    const tmp = new Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.terrain.heightAt(x, z);
      pos.setY(i, h);
      tmp.copy(base).multiplyScalar(0.7 + vnoise(x * 0.08, z * 0.08) * 0.5);
      tmp.lerp(fogCol, smoothstep(0, 40, h)); // rim fades into fog
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    if (baseMaps) {
      const m = baseMaps.map.clone();
      m.wrapS = m.wrapT = RepeatWrapping;
      m.repeat.set(60, 60);
      m.needsUpdate = true;
      mat.map = m;
      this.disposables.push(m);
    }
    const mesh = new Mesh(geo, mat);
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  private buildPillars(baseMaps: TerrainMaps | undefined): void {
    const rand = mulberry32(4020 + this.depth * 131);
    const mat = new MeshStandardMaterial({
      color: 0x6b7480,
      roughness: 1,
      map: baseMaps ? (() => {
        const m = baseMaps.map.clone();
        m.wrapS = m.wrapT = RepeatWrapping;
        m.repeat.set(1.5, 3);
        m.needsUpdate = true;
        this.disposables.push(m);
        return m;
      })() : undefined,
    });
    this.disposables.push(mat);

    const geo = new CylinderGeometry(0.6, 1.1, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    this.disposables.push(geo);

    const count = 16;
    const mesh = new InstancedMesh(geo, mat, count);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scl = new Vector3();
    const p = new Vector3();
    const tint = new Color();
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const rr = 22 + Math.sqrt(rand()) * (RADIUS - 34);
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const height = 12 + rand() * 20;
      const width = 2.2 + rand() * 3;
      scl.set(width, height, width);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      const gy = this.terrain.heightAt(x, z);
      p.set(x, gy - 0.5, z);
      m.compose(p, q, scl);
      mesh.setMatrixAt(i, m);
      tint.setHSL(0.55, 0.12, 0.3 + rand() * 0.18);
      mesh.setColorAt(i, tint);
      this.colliders.push({ x, z, r: width * 0.85, top: gy + height * 0.95 });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }

  private buildCore(): void {
    const gy = this.terrain.heightAt(0, 0);
    // Descent core: a glowing beacon you descend into.
    const ringGeo = new TorusGeometry(5, 0.25, 12, 60);
    ringGeo.rotateX(Math.PI / 2);
    const ringMat = new MeshBasicMaterial({ color: 0x8be0ff, transparent: true, opacity: 0.85 });
    this.coreRing = new Mesh(ringGeo, ringMat);
    this.coreRing.position.set(0, gy + 4, 0);
    this.group.add(this.coreRing);
    this.disposables.push(ringGeo, ringMat);

    const coneGeo = new ConeGeometry(4.5, 9, 24, 1, true);
    const coneMat = new MeshBasicMaterial({
      color: 0x4fd4ff,
      transparent: true,
      opacity: 0.28,
    });
    const cone = new Mesh(coneGeo, coneMat);
    cone.position.set(0, gy + 4.5, 0);
    this.group.add(cone);
    this.disposables.push(coneGeo, coneMat);

    this.coreLight = new PointLight(0x6fe0ff, 60, 70, 1.6);
    this.coreLight.position.set(0, gy + 6, 0);
    this.group.add(this.coreLight);
  }

  update(dt: number, _camera: PerspectiveCamera, _renderer: WebGLRenderer): void {
    this.time += dt;
    const pulse = 0.5 + Math.sin(this.time * 2.4) * 0.5;
    this.coreLight.intensity = 40 + pulse * 40;
    (this.coreRing.material as MeshBasicMaterial).opacity = 0.55 + pulse * 0.4;
    this.coreRing.rotation.y = this.time * 0.5;
  }

  setParticleScale(_scale: number): void {
    /* blockout has no particle field */
  }

  getSpawn(out: Vector3): Vector3 {
    // Enter near the rim, above the floor, looking toward the core.
    const x = -RADIUS * 0.55;
    const z = 0;
    return out.set(x, this.terrain.heightAt(x, z) + 14, z);
  }

  getBounds(): ZoneBounds {
    return {
      ceilingY: CEILING,
      minX: -HARD,
      maxX: HARD,
      minZ: -HARD,
      maxZ: HARD,
      softMargin: HARD - RADIUS,
    };
  }

  getDescentInfo(): DescentInfo {
    return {
      targetName: `Descent Blockout · Depth ${this.depth + 1}`,
      recommendedDominance: 'Hunter',
    };
  }

  /** The blockout has no ecosystem (Phase 3 populates only the Shallow Veil). */
  getPopulationArea(): PopulationArea | null {
    return null;
  }

  /** The blockout has no ecosystem. */
  getPopulation(): PopEntry[] {
    return [];
  }

  /** No ecosystem, so no flora either. */
  getFloraArea(): PopulationArea | null {
    return null;
  }

  /** No ecosystem here, so no Carrier encounter either (it arrives with Phase 15). */
  getCarrierAnchor(_out: Vector3): Vector3 | null {
    return null;
  }

  /** The blockout's descent is the glowing central core. */
  isInDescentZone(pos: Vector3): boolean {
    return Math.hypot(pos.x, pos.z) < 26;
  }

  repelFromDescent(pos: Vector3, vel: Vector3, dt: number): boolean {
    const d = Math.hypot(pos.x, pos.z);
    if (d > 32) return true;
    const nx = d > 1e-3 ? pos.x / d : 1;
    const nz = d > 1e-3 ? pos.z / d : 0;
    vel.x += nx * 34 * dt;
    vel.z += nz * 34 * dt;
    return false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
    for (const d of this.disposables) d.dispose();
  }
}
