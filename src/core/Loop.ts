/** Fixed-callback rAF loop with clamped dt and frame statistics. */
export class Loop {
  onTick: (dt: number) => void = () => {};

  fps = 0;
  /** Exponential moving average of tick duration (ms). */
  frameMsAvg = 0;
  /** Worst tick duration in the last stats window (ms). */
  frameMsMax = 0;

  private running = false;
  private raf = 0;
  private last = 0;
  private winTime = 0;
  private winFrames = 0;
  private winWorst = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(rawDt, 0.05);

    const t0 = performance.now();
    this.onTick(dt);
    const cost = performance.now() - t0;

    this.frameMsAvg += (cost - this.frameMsAvg) * 0.06;
    this.winWorst = Math.max(this.winWorst, cost);
    this.winTime += rawDt;
    this.winFrames++;
    if (this.winTime >= 0.5) {
      this.fps = this.winFrames / this.winTime;
      this.frameMsMax = this.winWorst;
      this.winTime = 0;
      this.winFrames = 0;
      this.winWorst = 0;
    }

    this.raf = requestAnimationFrame(this.tick);
  };
}
