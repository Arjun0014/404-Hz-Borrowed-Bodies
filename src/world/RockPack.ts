import {
  Box3,
  BufferGeometry,
  type Material,
  Mesh,
  type Object3D,
  Vector3,
} from 'three';
import type { AssetLoaderLike } from './types';

/**
 * Splits a multi-part .glb "asset pack" into individually placeable pieces.
 *
 * The bone-rock and dinosaur-bone packs each ship a dozen distinct props welded
 * into one file, all sharing a handful of materials. Loading the file as a
 * single model would force every prop to appear together wherever it was
 * placed; what the zone actually wants is each rock as its own geometry it can
 * instance hundreds of times.
 *
 * So this walks the loaded scene, pulls out every mesh, bakes its world
 * transform into the geometry, and normalises it to a unit-ish size centred on
 * its own base — the same recipe CreatureFactory uses, but for scenery. The
 * result is a list of geometries ready to hand to an InstancedMesh, plus the
 * shared materials so the caller can decide whether to reuse or replace them.
 *
 * Pieces are keyed by their node name (`SmallRock3`, `DinoSkullTop`, …) so a
 * zone can ask for exactly the shapes it wants rather than indexing blindly.
 */

export interface RockPiece {
  /** Source node name, e.g. "BigArchTop" or "DinoRib". */
  name: string;
  /**
   * Geometry translated so the piece sits on y=0 and is centred on x/z, then
   * scaled so its longest horizontal axis is 1. Instance scale therefore maps
   * directly to "how many metres wide should this rock be".
   */
  geometry: BufferGeometry;
  /** The piece's material as authored (shared across pieces from one pack). */
  material: Material;
  /** Height above its base at unit scale — lets callers reason about clearance. */
  unitHeight: number;
  /** Triangle count, for budgeting. */
  tris: number;
}

export class RockPack {
  readonly pieces: RockPiece[] = [];
  private readonly byName = new Map<string, RockPiece>();

  private constructor() {}

  /** Load a pack .glb and split it into normalised, individually usable pieces. */
  static async load(loader: AssetLoaderLike, url: string): Promise<RockPack> {
    const pack = new RockPack();
    const gltf = await loader.loadGLB(url);
    gltf.scene.updateMatrixWorld(true);

    const box = new Box3();
    const size = new Vector3();
    const center = new Vector3();

    gltf.scene.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;

      const geo = mesh.geometry.clone();
      // Bake the node's place in the pack's layout into the vertices, so the
      // piece is self-contained and no longer depends on its parent hierarchy.
      geo.applyMatrix4(mesh.matrixWorld);

      box.setFromBufferAttribute(geo.attributes.position as never);
      box.getSize(size);
      box.getCenter(center);
      const longest = Math.max(size.x, size.z, 1e-4);
      const scale = 1 / longest;
      // Centre on x/z, drop to y=0 at the base, then normalise the footprint.
      geo.translate(-center.x, -box.min.y, -center.z);
      geo.scale(scale, scale, scale);
      geo.computeVertexNormals();

      const idx = geo.index;
      const tris = Math.round(
        (idx ? idx.count : (geo.attributes.position as { count: number }).count) / 3,
      );

      // Node names in these packs are "<Piece>_<Material>_0"; the parent node
      // carries the clean name, so prefer it when it looks meaningful.
      const parentName = mesh.parent?.name ?? '';
      const name = /_\d+$/.test(mesh.name) && parentName ? parentName : mesh.name;

      const piece: RockPiece = {
        name,
        geometry: geo,
        material: (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material,
        unitHeight: size.y * scale,
        tris,
      };
      pack.pieces.push(piece);
      pack.byName.set(name, piece);
    });

    return pack;
  }

  /** A piece by node name, or undefined if this pack has no such part. */
  get(name: string): RockPiece | undefined {
    return this.byName.get(name);
  }

  /** Every piece whose name starts with `prefix` (e.g. "SmallRock", "Dino"). */
  matching(prefix: string): RockPiece[] {
    return this.pieces.filter((p) => p.name.startsWith(prefix));
  }

  /** Free the split geometries. Materials belong to the source glb's cache. */
  dispose(): void {
    for (const p of this.pieces) p.geometry.dispose();
    this.pieces.length = 0;
    this.byName.clear();
  }
}
