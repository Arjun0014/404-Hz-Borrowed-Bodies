/**
 * Persistent run state — everything that must survive a zone transition
 * (GAME_DESIGN §14). Zone-scoped data lives in the Zone; this does not.
 * Serializable so a run can be autosaved at each zone entry and resumed after
 * a refresh or crash.
 */
export interface RunStateData {
  hostSpeciesId: string;
  /** Zone index: 0 = Shallow Veil, 1+ = deeper. */
  depth: number;
  score: number;
  /** Dominance placeholder (real system arrives in Phase 6). */
  dominance: number;
  stats: {
    descents: number;
    timeSeconds: number;
  };
  /** RNG seed for this run (seeded systems arrive in later phases). */
  seed: number;
}

const STORAGE_KEY = '404hz-run';
const VERSION = 1;

export class RunState {
  data: RunStateData;

  constructor(data?: Partial<RunStateData>) {
    this.data = {
      hostSpeciesId: 'dartfish',
      depth: 0,
      score: 0,
      dominance: 0,
      stats: { descents: 0, timeSeconds: 0 },
      seed: (Math.random() * 0xffffffff) >>> 0,
      ...data,
    };
  }

  descend(): void {
    this.data.depth += 1;
    this.data.stats.descents += 1;
  }

  tick(dt: number): void {
    this.data.stats.timeSeconds += dt;
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, data: this.data }));
    } catch {
      /* storage may be unavailable (private mode); non-fatal */
    }
  }

  /** Load an autosaved run, or null if none / incompatible. */
  static load(): RunState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { v: number; data: RunStateData };
      if (parsed.v !== VERSION || !parsed.data) return null;
      return new RunState(parsed.data);
    } catch {
      return null;
    }
  }

  static clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* non-fatal */
    }
  }
}
