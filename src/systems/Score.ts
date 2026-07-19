import type { RunState } from '../state/RunState';

/**
 * Run scoring, first pass (Phase 14).
 *
 * The design brief for scoring is "reward varied and skilful play rather than
 * repetitive farming" (GAME_DESIGN §19), so almost nothing here pays out per
 * repetition. Biomass and kills are worth very little; what actually moves the
 * number is doing things you can only do once or that carry real risk — wearing
 * a species you have not worn before, snatching a body against the odds, killing
 * a Signal Carrier, surviving with the entity most of the way into your head,
 * and living inside a frenzy long enough to matter.
 *
 * Kept as a plain event log + a derived breakdown so the run-summary screen can
 * show *why* a score is what it is, and so the leaderboard phase can serialise
 * the same structure without rework.
 */

export interface ScoreLine {
  label: string;
  detail: string;
  points: number;
}

/** Points per unit of each scoring channel. */
const PTS = {
  depth: 900, // each zone descended
  biomass: 1.2, // per unit of biomass eaten — deliberately near-worthless
  dominance: 6, // per Dominance point earned
  uniqueHost: 450, // per species worn for the first time this run
  riskPossession: 260, // per successful snatch against the odds
  possessStreak: 120, // per takeover in an unbroken chain (grows the chain's value)
  carrier: 4000, // per Signal Carrier destroyed — the zone's real objective
  carrierNode: 350, // per signal node popped (rewards the skilful kill)
  brinkSeconds: 22, // per second survived above 80% Connection
  frenzySeconds: 34, // per second spent inside a Dead Signal Field
  timeBonus: 260, // per minute under the par time, if the run is completed
} as const;

/** Par run length in seconds — the 4–7 minute zone pace from the design doc. */
const PAR_SECONDS = 7 * 60;

export class Score {
  // --- raw counters ---
  private biomass = 0;
  private uniqueHosts = new Set<string>();
  private riskPossessions = 0;
  private possessions = 0;
  private bestStreak = 0;
  private streak = 0;
  private carriersKilled = 0;
  private carrierNodes = 0;
  private brinkSeconds = 0;
  private frenzySeconds = 0;

  constructor(private readonly run: RunState) {}

  // --- event hooks ---

  feed(biomass: number): void {
    this.biomass += biomass;
  }

  /** A takeover landed. `risky` marks the G-snatch path (it can fail). */
  possessed(speciesId: string, risky: boolean): void {
    this.possessions++;
    this.uniqueHosts.add(speciesId);
    if (risky) this.riskPossessions++;
    this.streak++;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
  }

  /** The chain is broken by dying or by a failed snatch. */
  breakStreak(): void {
    this.streak = 0;
  }

  carrierNodeDestroyed(): void {
    this.carrierNodes++;
  }

  carrierKilled(): void {
    this.carriersKilled++;
  }

  /**
   * Per-frame risk accrual: time spent at the brink of losing the run, and time
   * spent inside a Dead Signal Field. Both are things a cautious player never
   * banks, which is exactly why they pay.
   */
  tick(dt: number, connection01: number, inField: boolean): void {
    if (connection01 > 0.8) this.brinkSeconds += dt;
    if (inField) this.frenzySeconds += dt;
  }

  // --- results ---

  get uniqueHostCount(): number {
    return this.uniqueHosts.size;
  }

  get carriers(): number {
    return this.carriersKilled;
  }

  /** The itemised breakdown, biggest contributions first. */
  breakdown(completed = false): ScoreLine[] {
    const d = this.run.data;
    // The streak is worth the triangular sum of its links, so a long unbroken
    // chain of takeovers is worth far more than the same count spread out.
    const streakPts = (this.bestStreak * (this.bestStreak + 1)) / 2 * PTS.possessStreak;
    const lines: ScoreLine[] = [
      { label: 'Depth reached', detail: `${d.depth} ${d.depth === 1 ? 'zone' : 'zones'}`, points: d.depth * PTS.depth },
      { label: 'Signal Carriers destroyed', detail: `${this.carriersKilled}`, points: this.carriersKilled * PTS.carrier },
      { label: 'Signal nodes broken', detail: `${this.carrierNodes}`, points: this.carrierNodes * PTS.carrierNode },
      { label: 'Bodies worn', detail: `${this.uniqueHosts.size} unique of ${this.possessions}`, points: this.uniqueHosts.size * PTS.uniqueHost },
      { label: 'Longest possession streak', detail: `${this.bestStreak}`, points: streakPts },
      { label: 'Snatched against the odds', detail: `${this.riskPossessions}`, points: this.riskPossessions * PTS.riskPossession },
      { label: 'Dominance', detail: rankDetail(d.dominance), points: Math.round(d.dominance * PTS.dominance) },
      { label: 'Survived on the brink', detail: `${this.brinkSeconds.toFixed(0)} s above 80% connection`, points: Math.round(this.brinkSeconds * PTS.brinkSeconds) },
      { label: 'Time in the frenzy', detail: `${this.frenzySeconds.toFixed(0)} s inside a dead signal`, points: Math.round(this.frenzySeconds * PTS.frenzySeconds) },
      { label: 'Biomass consumed', detail: this.biomass.toFixed(0), points: Math.round(this.biomass * PTS.biomass) },
    ];
    if (completed) {
      const saved = Math.max(0, PAR_SECONDS - d.stats.timeSeconds);
      lines.push({
        label: 'Time bonus',
        detail: `${(saved / 60).toFixed(1)} min under par`,
        points: Math.round((saved / 60) * PTS.timeBonus),
      });
    }
    return lines.filter((l) => l.points > 0).sort((a, b) => b.points - a.points);
  }

  total(completed = false): number {
    let t = 0;
    for (const l of this.breakdown(completed)) t += l.points;
    return Math.round(t);
  }

  /** Persist the final score into the run state (leaderboard phase reads this). */
  commit(completed = false): number {
    const t = this.total(completed);
    this.run.data.score = t;
    return t;
  }
}

function rankDetail(points: number): string {
  return `${points.toFixed(0)} pts`;
}
