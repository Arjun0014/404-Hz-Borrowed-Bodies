import type { WebGLRenderer } from 'three';
import { LoadingManager } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/** GLB loader wired for the project's compressed asset pipeline (Draco + KTX2). */
export class AssetLoader {
  onProgress: (loaded: number, total: number) => void = () => {};

  private readonly gltf: GLTFLoader;
  private readonly draco: DRACOLoader;
  private readonly ktx2: KTX2Loader;

  constructor(renderer: WebGLRenderer) {
    const manager = new LoadingManager();
    manager.onProgress = (_url, loaded, total) => this.onProgress(loaded, total);

    this.draco = new DRACOLoader(manager).setDecoderPath('draco/');
    this.ktx2 = new KTX2Loader(manager).setTranscoderPath('basis/').detectSupport(renderer);

    this.gltf = new GLTFLoader(manager);
    this.gltf.setDRACOLoader(this.draco);
    this.gltf.setKTX2Loader(this.ktx2);
  }

  loadGLB(url: string): Promise<GLTF> {
    return this.gltf.loadAsync(url);
  }

  dispose(): void {
    this.draco.dispose();
    this.ktx2.dispose();
  }
}
