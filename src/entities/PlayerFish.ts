import {
  AnimationMixer,
  Box3,
  Group,
  Material,
  Mesh,
  Object3D,
  Vector3,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetLoader } from '../core/AssetLoader';
import type { SpeciesDef } from '../data/species';
import { CreatureFactory, type CreatureInstance } from './CreatureFactory';

/**
 * Visual representation of the player's current host.
 * `object` is the movement root (positioned/oriented by SwimController) and stays
 * the SAME across possessions, so the camera never cuts — only the body inside
 * `modelRoot` is swapped. `modelRoot` carries banking roll and procedural sway so
 * the camera never inherits roll.
 */
export class PlayerFish {
  readonly object = new Group();
  readonly modelRoot = new Group();
  /** Mutable: possession swaps the host to any creature species. */
  species: SpeciesDef;
  /** Body length at minimum (un-grown) size for the current host. */
  baseLength: number;
  /** Current body length in meters (baseLength × growth). */
  length: number;
  /** Turn agility multiplier (1 at min size, lower as the host grows). */
  agility = 1;

  private mixer: AnimationMixer | null = null;
  /** The current body added to modelRoot, plus how to free it on the next swap. */
  private modelHolder: Object3D | null = null;
  private disposeCurrent: () => void = () => {};
  private bank = 0;
  private swayT = 0;
  private lungeT = 0;

  private constructor(species: SpeciesDef, gltf: GLTF) {
    this.species = species;
    this.baseLength = species.baseLength;
    this.length = species.baseLength;
    this.object.name = `host-${species.id}`;
    this.object.add(this.modelRoot);
    this.installInitialModel(species, gltf);
  }

  /** Build + align the starter model (raw GLB) and mount it in modelRoot. */
  private installInitialModel(species: SpeciesDef, gltf: GLTF): void {
    const model = gltf.scene;
    forceOpaque(model);

    // Auto-align: put the longest horizontal axis on Z (our forward), then
    // normalize the body length and center the pivot.
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const wrapper = new Group();
    wrapper.add(model);
    if (size.x > size.z * 1.25) wrapper.rotation.y = -Math.PI / 2;
    if (species.flipForward) wrapper.rotation.y += Math.PI;

    const aligned = new Box3().setFromObject(wrapper);
    const alignedSize = aligned.getSize(new Vector3());
    const scale = species.baseLength / Math.max(alignedSize.z, 1e-4);
    wrapper.scale.setScalar(scale);
    const center = aligned.getCenter(new Vector3()).multiplyScalar(scale);
    wrapper.position.sub(center);

    this.modelRoot.add(wrapper);
    this.modelHolder = wrapper;
    this.disposeCurrent = () => disposeTree(wrapper);

    this.mixer = null;
    if (gltf.animations.length > 0) {
      this.mixer = new AnimationMixer(model);
      const clip = gltf.animations.find((c) => /swim|idle/i.test(c.name)) ?? gltf.animations[0];
      this.mixer.clipAction(clip).play();
    }
  }

  static async create(loader: AssetLoader, species: SpeciesDef): Promise<PlayerFish> {
    const gltf = await loader.loadGLB(species.modelUrl);
    return new PlayerFish(species, gltf);
  }

  /**
   * Possession: wear a new host body built from an already-aligned creature
   * instance (its root is scaled to the species' min length, centered, and
   * facing +Z). The movement `object` is unchanged, so the swap is seamless.
   * Growth (object.scale) is re-applied by PlayerGrowth right after.
   */
  swapHost(species: SpeciesDef, inst: CreatureInstance): void {
    if (this.modelHolder) this.modelRoot.remove(this.modelHolder);
    this.disposeCurrent();

    this.species = species;
    this.baseLength = species.baseLength;
    this.length = species.baseLength;
    this.object.name = `host-${species.id}`;

    inst.root.scale.setScalar(1); // growth is applied on this.object, not here
    inst.root.position.set(0, 0, 0);
    this.modelRoot.add(inst.root);
    this.modelHolder = inst.root;
    this.mixer = inst.mixer;
    this.disposeCurrent = () => CreatureFactory.disposeInstance(inst);

    // Reset transient visual state so the new body starts clean.
    this.bank = 0;
    this.lungeT = 0;
    this.modelRoot.rotation.set(0, 0, 0);
    this.modelRoot.scale.set(1, 1, 1);
  }

  /** Banking roll target (radians), set by the controller from turn rate. */
  setBank(target: number, dt: number): void {
    this.bank += (target - this.bank) * Math.min(1, dt * 6);
    this.modelRoot.rotation.z = this.bank;
  }

  /** Squash-stretch pop on a lunge/bite for a punchy, tactile strike. */
  lungePulse(): void {
    this.lungeT = 0.3;
  }

  /** Grow (or reset) the host: scales the whole body and updates its length. */
  setGrowth(scale: number): void {
    this.length = this.baseLength * scale;
    this.object.scale.setScalar(scale);
  }

  /** World position just behind the tail (for dash bubble emission). */
  getTailPosition(out: Vector3): Vector3 {
    // -Z is the tail in local space (forward is +Z after alignment). The local
    // coord is in base units; object.scale applies the growth factor.
    out.set(0, 0, -this.baseLength * 0.55);
    return this.object.localToWorld(out);
  }

  update(dt: number, speed01: number): void {
    if (this.mixer) {
      this.mixer.update(dt * (0.6 + speed01 * 1.8));
    } else {
      // Procedural fallback: gentle body sway scaled by speed.
      this.swayT += dt * (2.5 + speed01 * 9);
      this.modelRoot.rotation.y = Math.sin(this.swayT) * (0.05 + speed01 * 0.1);
    }

    // Lunge squash-stretch: stretch forward (+Z), pinch sideways, then settle.
    if (this.lungeT > 0) {
      this.lungeT -= dt;
      const e = Math.sin(Math.max(0, this.lungeT / 0.3) * Math.PI); // 0→1→0
      this.modelRoot.scale.set(1 - e * 0.26, 1 - e * 0.26, 1 + e * 0.55);
    } else {
      this.modelRoot.scale.set(1, 1, 1);
    }
  }
}

/** GLB bodies are often exported alpha-blended; force them opaque. */
function forceOpaque(root: Object3D): void {
  root.traverse((o: Object3D) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
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

/** Free a self-owned model's GPU resources (used for the starter body on swap). */
function disposeTree(root: Object3D): void {
  root.traverse((o: Object3D) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as (Material & { map?: { dispose?: () => void } })[]) {
      m?.map?.dispose?.();
      m?.dispose?.();
    }
  });
}
