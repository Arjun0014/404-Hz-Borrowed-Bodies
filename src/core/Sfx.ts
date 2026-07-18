import fishSwimUrl from '../../assets/sounds/fish_swim.mp3?url';
import biteLandedUrl from '../../assets/sounds/bite_landed.mp3?url';
import randomBitesUrl from '../../assets/sounds/random_bite_sounds.wav?url';
import shadowVeilAmbientUrl from '../../assets/sounds/shadow_veil_ambient.wav?url';
import drownedGardenAmbientUrl from '../../assets/sounds/drowned_garden_ambient.mp3?url';

/** Per-zone background ambience tracks. */
export const AMBIENT = {
  shallowVeil: shadowVeilAmbientUrl,
  drownedGarden: drownedGardenAmbientUrl,
} as const;

/**
 * Audio: real recorded samples for the things you hear constantly — a subtle
 * looping swim sound (louder/faster when sprinting), varied bite snaps (random
 * slices of one file so no two bites sound the same), and a meaty "bite landed"
 * chunk. Death is still a short synth groan (no sample for it). No ambient bed.
 * The AudioContext + sample decode happen on the first gesture (the play click).
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;

  private swimBuf: AudioBuffer | null = null;
  private biteLandedBuf: AudioBuffer | null = null;
  private bitesBuf: AudioBuffer | null = null;

  private swimSrc: AudioBufferSourceNode | null = null;
  private swimGain: GainNode | null = null;
  private swimStarted = false;

  private ambientSrc: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private currentAmbientUrl = '';
  private readonly ambientCache = new Map<string, AudioBuffer>();

  private ac(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      try {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.95;
        this.master.connect(this.ctx.destination);
      } catch {
        this.enabled = false;
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /**
   * Create the context and decode the samples. Call on the first gesture. Each
   * sample loads independently so the small ones (bite-landed, swim) are ready
   * right away and don't wait on the large random-bites file to decode.
   */
  async load(): Promise<void> {
    const ac = this.ac();
    if (!ac) return;
    void this.fetchBuf(fishSwimUrl).then((b) => {
      this.swimBuf = b;
      this.startSwimLoop();
    });
    void this.fetchBuf(biteLandedUrl).then((b) => (this.biteLandedBuf = b));
    void this.fetchBuf(randomBitesUrl).then((b) => (this.bitesBuf = b));
  }

  private async fetchBuf(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      const ab = await res.arrayBuffer();
      return await this.ctx!.decodeAudioData(ab);
    } catch {
      return null;
    }
  }

  // ---- continuous swim sound ------------------------------------------------

  private startSwimLoop(): void {
    if (!this.ctx || !this.master || !this.swimBuf || this.swimStarted) return;
    this.swimStarted = true;
    this.swimSrc = this.ctx.createBufferSource();
    this.swimSrc.buffer = this.swimBuf;
    this.swimSrc.loop = true;
    this.swimGain = this.ctx.createGain();
    this.swimGain.gain.value = 0;
    this.swimSrc.connect(this.swimGain).connect(this.master);
    this.swimSrc.start();
  }

  /**
   * Drive the swim loop each frame — kept low and non-dominant; a touch louder
   * and faster while sprinting so speed is felt, not blasted.
   * @param speed01 0..1 host speed
   * @param dashing full-thrust flag
   */
  setSwim(speed01: number, dashing: boolean): void {
    if (!this.ctx || !this.swimGain || !this.swimSrc) return;
    const t = this.ctx.currentTime;
    // Audible while swimming, louder when sprinting, but still not dominant.
    const gain = Math.min(0.45, speed01 * (dashing ? 0.36 : 0.22));
    this.swimGain.gain.setTargetAtTime(gain, t, 0.12);
    const rate = 0.9 + speed01 * (dashing ? 1.0 : 0.45);
    this.swimSrc.playbackRate.setTargetAtTime(rate, t, 0.12);
  }

  // ---- per-zone ambient bed -------------------------------------------------

  /** Loop a background ambience track (low, non-dominant). Swaps on zone change. */
  async playAmbient(url: string, gain = 0.16): Promise<void> {
    const ac = this.ac();
    if (!ac || !this.master) return;
    if (this.currentAmbientUrl === url && this.ambientSrc) return; // already on
    this.currentAmbientUrl = url;
    let buf = this.ambientCache.get(url);
    if (!buf) {
      const decoded = await this.fetchBuf(url);
      if (!decoded || this.currentAmbientUrl !== url) return; // zone changed while loading
      buf = decoded;
      this.ambientCache.set(url, buf);
    }
    if (this.ambientSrc) {
      try {
        this.ambientSrc.stop();
      } catch {
        /* already stopped */
      }
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.ambientGain = ac.createGain();
    this.ambientGain.gain.value = 0;
    src.connect(this.ambientGain).connect(this.master);
    src.start();
    this.ambientSrc = src;
    this.ambientGain.gain.setTargetAtTime(gain, ac.currentTime, 1.2); // gentle fade-in
  }

  // ---- bite one-shots -------------------------------------------------------

  /** A bite snap — a random slice of the bite file so each one differs. */
  biteSwing(gain = 0.9): void {
    const ac = this.ac();
    const b = this.bitesBuf;
    if (!ac || !b || !this.master) return;
    const segDur = Math.min(b.duration, 0.28 + Math.random() * 0.22);
    const offset = Math.random() * Math.max(0, b.duration - segDur);
    const src = ac.createBufferSource();
    src.buffer = b;
    const g = ac.createGain();
    const t = ac.currentTime;
    // Short fades so a mid-file slice doesn't click at its edges.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.gain.setValueAtTime(gain, t + segDur - 0.04);
    g.gain.linearRampToValueAtTime(0.0001, t + segDur);
    src.connect(g).connect(this.master);
    src.start(t, offset, segDur);
  }

  /** The bite connects — a chunk of meat torn free. */
  biteLanded(gain = 1.0): void {
    const ac = this.ac();
    const b = this.biteLandedBuf;
    if (!ac || !b || !this.master) return;
    const src = ac.createBufferSource();
    src.buffer = b;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
  }

  // ---- synth (no sample) ----------------------------------------------------

  /** The host dies — a low synth groan into rumble. */
  death(): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.9);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.95);
  }
}
