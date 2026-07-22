import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
  Vector3,
} from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetLoader } from '../core/AssetLoader';
import type { CreatureSpecies } from '../data/creatures';

/** A loaded, measured species ready to stamp out instances. */
interface CreatureModel {
  species: CreatureSpecies;
  clip: AnimationClip | null;
  /** Source object cloned per instance (skinned armature, or merged crab mesh). */
  source: Object3D;
  skinned: boolean;
  // Baked orientation/scale/centering (matches PlayerFish's alignment).
  alignYaw: number;
  scale: number;
  centerNeg: Vector3;
}

/** One spawned creature's renderable pieces. */
export interface CreatureInstance {
  root: Group;
  mixer: AnimationMixer | null;
  action: AnimationAction | null;
  /** Skinned meshes whose skeletons must be disposed on despawn. */
  skinned: SkinnedMesh[];
}

/**
 * Loads each creature .glb once and stamps out lightweight instances.
 * Skinned species clone via SkeletonUtils (shared geometry + material, new
 * skeleton). The crab has no skeleton, so its meshes are merged to a single
 * geometry (one draw call) and animated procedurally by the Creature.
 */
export class CreatureFactory {
  private readonly models = new Map<string, CreatureModel>();

  constructor(private readonly loader: AssetLoader) {}

  async loadAll(list: CreatureSpecies[]): Promise<void> {
    await Promise.all(list.map((s) => this.load(s)));
  }

  private async load(species: CreatureSpecies): Promise<void> {
    const gltf = await this.loader.loadGLB(species.modelUrl);
    const scene = gltf.scene;
    this.forceOpaque(scene);

    let source: Object3D;
    let skinned: boolean;
    if (species.procedural) {
      source = this.mergeToSingleMesh(scene) ?? scene;
      skinned = false;
    } else {
      source = scene;
      skinned = true;
    }

    // Measure alignment/scale once (same recipe as PlayerFish).
    const { alignYaw, scale, centerNeg } = this.measure(source, species);

    const clip =
      gltf.animations.length > 0
        ? gltf.animations.find((c) => (species.animClip ?? /swim|take|action|scene/i).test(c.name)) ??
          gltf.animations[0]
        : null;

    this.models.set(species.id, { species, clip, source, skinned, alignYaw, scale, centerNeg });
  }

  /** GLB bodies are often exported alpha-blended; force them opaque. */
  private forceOpaque(root: Object3D): void {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // distance tier controls visibility instead
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats as Material[]) {
        if (m && m.transparent) {
          m.transparent = false;
          m.depthWrite = true;
          m.needsUpdate = true;
        }
      }
    });
  }

  /**
   * Measure a model's swim axis, scale, and pivot offset.
   *
   * Every temporary here is LOCAL, and that is the whole point. These four
   * objects used to be shared instance fields, while `loadAll` runs every
   * species concurrently through `Promise.all` — so each `await` inside a load
   * handed the shared probe group, box, size and centre to whichever other
   * species resumed next. Alignment was decided from whatever happened to be in
   * the scratch at the time, which made the swim axis depend on network
   * ordering: the same model came out nose-first on one load and broadside on
   * the next, and no amount of staring at a single session could explain it.
   * Measured directly: `eyemonster` and `anglerfish` reported an alignment yaw
   * of -PI/2 on one run and 0 on the next with no code change in between.
   */
  private measure(
    source: Object3D,
    species: CreatureSpecies,
  ): { alignYaw: number; scale: number; centerNeg: Vector3 } {
    const probe = source.clone();
    const wrap = new Group();
    wrap.add(probe);

    const box = new Box3();
    const size = new Vector3();
    box.setFromObject(probe);
    box.getSize(size);
    // Explicit per-model yaw wins; otherwise assume the longest horizontal axis
    // is the swim axis and rotate it onto +Z (our forward). The heuristic reads
    // a SkinnedMesh in its bind pose, which does not always match the posed
    // skeleton — models it gets wrong are pinned with `modelYaw` in creatures.ts.
    let alignYaw = species.modelYaw ?? (size.x > size.z * 1.25 ? -Math.PI / 2 : 0);
    if (species.flipForward) alignYaw += Math.PI;
    wrap.rotation.y = alignYaw;
    wrap.updateMatrixWorld(true);

    box.setFromObject(wrap);
    box.getSize(size);
    const scale = species.baseLength / Math.max(size.z, 1e-4);
    const centerNeg = box.getCenter(new Vector3()).multiplyScalar(-scale);
    // Per-model pivot correction, in baseLength multiples. Applied after the
    // box centring so a species only has to describe how far its own body sits
    // from the middle of its box, not re-derive the centring itself.
    const off = species.modelOffset;
    if (off) {
      centerNeg.x += (off.x ?? 0) * species.baseLength;
      centerNeg.y += (off.y ?? 0) * species.baseLength;
      centerNeg.z += (off.z ?? 0) * species.baseLength;
    }

    wrap.clear();
    return { alignYaw, scale, centerNeg };
  }

  /** Merge a skeleton-less model's meshes into one geometry (one draw call). */
  private mergeToSingleMesh(scene: Object3D): Mesh | null {
    scene.updateMatrixWorld(true);
    const geoms: BufferGeometry[] = [];
    let material: Material | null = null;
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      // Keep only attributes common to all meshes so the merge succeeds.
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      }
      geoms.push(g);
      if (!material) material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    });
    const merged = geoms.length ? mergeGeometries(geoms, false) : null;
    for (const g of geoms) g.dispose();
    if (!merged) return null;
    const mat = (material as Material | null) ?? new MeshStandardMaterial({ color: 0x9a8570 });
    const mesh = new Mesh(merged, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  createInstance(speciesId: string): CreatureInstance {
    const model = this.models.get(speciesId);
    if (!model) throw new Error(`species not loaded: ${speciesId}`);

    const root = new Group();
    const wrapper = new Group();
    wrapper.rotation.y = model.alignYaw;
    wrapper.scale.setScalar(model.scale);
    wrapper.position.copy(model.centerNeg);

    const clone = model.skinned ? skeletonClone(model.source) : model.source.clone();
    wrapper.add(clone);
    root.add(wrapper);

    const skinned: SkinnedMesh[] = [];
    clone.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) skinned.push(o as SkinnedMesh);
    });

    let mixer: AnimationMixer | null = null;
    let action: AnimationAction | null = null;
    if (model.clip) {
      mixer = new AnimationMixer(clone);
      action = mixer.clipAction(model.clip);
      action.time = Math.random() * model.clip.duration; // desync instances
      action.play();
    }

    return { root, mixer, action, skinned };
  }

  /** Free per-instance skeleton GPU resources (bone textures) on despawn. */
  static disposeInstance(inst: CreatureInstance): void {
    for (const sm of inst.skinned) sm.skeleton?.dispose?.();
  }

  /** Dispose shared per-species resources (geometry, materials, textures). */
  dispose(): void {
    for (const model of this.models.values()) {
      model.source.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats as Material[]) {
          const sm = m as MeshStandardMaterial;
          sm.map?.dispose();
          sm.normalMap?.dispose();
          m?.dispose();
        }
      });
    }
    this.models.clear();
  }
}
