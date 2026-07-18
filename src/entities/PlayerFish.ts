import {
  AnimationAction,
  AnimationMixer,
  Box3,
  Group,
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
    // Skinned meshes can mis-report bounds; the player is always on screen anyway.
    model.traverse((o: Object3D) => {
      if ((o as Mesh).isMesh) o.frustumCulled = false;
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
