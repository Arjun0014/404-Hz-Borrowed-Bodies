/**
 * Uniform 2D (x,z) grid for O(n) neighbour queries. Creatures spread mostly
 * horizontally, so hashing on the ground plane and checking true 3D distance
 * in the caller is both cheap and accurate enough for schooling, separation,
 * and predator targeting.
 */
export class SpatialHash {
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly cellSize: number) {}

  private key(cx: number, cz: number): number {
    // Pack two signed cell coords into one number (±32k range).
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  clear(): void {
    for (const arr of this.cells.values()) arr.length = 0;
  }

  insert(index: number, x: number, z: number): void {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const k = this.key(cx, cz);
    let arr = this.cells.get(k);
    if (!arr) {
      arr = [];
      this.cells.set(k, arr);
    }
    arr.push(index);
  }

  /** Invoke cb(index) for every entry in cells overlapping the radius box. */
  query(x: number, z: number, radius: number, cb: (index: number) => void): void {
    const min = -radius;
    const cx0 = Math.floor((x + min) / this.cellSize);
    const cz0 = Math.floor((z + min) / this.cellSize);
    const cx1 = Math.floor((x + radius) / this.cellSize);
    const cz1 = Math.floor((z + radius) / this.cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.cells.get(this.key(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) cb(arr[i]);
      }
    }
  }
}
