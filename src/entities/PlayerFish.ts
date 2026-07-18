import {
  AnimationAction,
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

/**
 * Visual representation of the player's current host.
 * `object` is the movement root (positioned/oriented by SwimController);
 * `modelRoot` carries banking roll and procedural sway so the camera
 * never inherits roll.
 */
export class PlayerFish {
  readonly object = new Group();
  readonly modelRoot = new Group();
  readonly species: SpeciesDef;
  /** Body length in meters after normalization. */
  readonly length: number;

  private mixer: AnimationMixer | null = null;
  private swimAction: AnimationAction | null = null;
  private bank = 0;
  private swayT = 0;

  private constructor(species: SpeciesDef, gltf: GLTF) {
    this.species = species;
    this.object.name = `host-${species.id}`;
    this.object.add(this.modelRoot);

    const model = gltf.scene;
    model.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      // Skinned meshes can mis-report bounds; the player is always on screen.
      mesh.frustumCulled = false;
      // The GLB exports the body as alpha-blended (transparent + depthWrite off)
      // even though it is a solid opaque body — that makes it wash out and look
      // see-through against the bright water surface. Force it opaque so it
      // writes depth and never goes translucent.
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats as Material[]) {
        if (m && m.transparent) {
          m.transparent = false;
          m.depthWrite = true;
          m.needsUpdate = true;
        }
      }
    });

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
    this.length = species.baseLength;

    if (gltf.animations.length > 0) {
      this.mixer = new AnimationMixer(model);
      const clip =
        gltf.animations.find((c) => /swim|idle/i.test(c.name)) ?? gltf.animations[0];
      this.swimAction = this.mixer.clipAction(clip);
      this.swimAction.play();
    }
  }

  static async create(loader: AssetLoader, species: SpeciesDef): Promise<PlayerFish> {
    const gltf = await loader.loadGLB(species.modelUrl);
    return new PlayerFish(species, gltf);
  }

  /** Banking roll target (radians), set by the controller from turn rate. */
  setBank(target: number, dt: number): void {
    this.bank += (target - this.bank) * Math.min(1, dt * 6);
    this.modelRoot.rotation.z = this.bank;
  }

  /** World position just behind the tail (for dash bubble emission). */
  getTailPosition(out: Vector3): Vector3 {
    // -Z is the tail in local space (forward is +Z after alignment).
    out.set(0, 0, -this.length * 0.55);
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
  }
}
