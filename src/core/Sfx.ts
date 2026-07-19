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

  // Connection dread drone (persistent, fades with Connection level).
  private droneOsc: OscillatorNode | null = null;
  private droneSub: OscillatorNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;

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

  /** Stun impact — a sharp electric zap as the target seizes up. */
  stunHit(): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.18);
    const lfo = ac.createOscillator(); // buzzy tremolo for a "zap" texture
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(60, t);
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 40;
    lfo.connect(lfoGain).connect(osc.frequency);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(this.master);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.24);
    lfo.stop(t + 0.24);
  }

  /** Takeover complete — a rising shimmer/whoosh as you enter the new body. */
  possess(): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(720, t + 0.35);
    const filt = ac.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(300, t);
    filt.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
    filt.Q.value = 6;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(filt).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.6);
  }

  /**
   * The Connection dread drone — a persistent low eldritch hum that fades in past
   * ~40% Connection and grows louder/brighter toward full. Call every frame with
   * the current level; it lazily builds the graph and just retunes it after.
   */
  setConnectionDrone(level: number): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    if (!this.droneGain) {
      this.droneGain = ac.createGain();
      this.droneGain.gain.value = 0.0001;
      this.droneFilter = ac.createBiquadFilter();
      this.droneFilter.type = 'lowpass';
      this.droneFilter.frequency.value = 200;
      this.droneOsc = ac.createOscillator();
      this.droneOsc.type = 'sawtooth';
      this.droneOsc.frequency.value = 52;
      this.droneSub = ac.createOscillator();
      this.droneSub.type = 'sine';
      this.droneSub.frequency.value = 38.5; // slight beating against the saw
      this.droneOsc.connect(this.droneFilter);
      this.droneSub.connect(this.droneFilter);
      this.droneFilter.connect(this.droneGain).connect(this.master);
      this.droneOsc.start();
      this.droneSub.start();
    }
    const L = Math.max(0, Math.min(1, level));
    // Silent until the "high" band (70%); swells from there toward full.
    const g = L < 0.7 ? 0.0001 : Math.max(0.0001, ((L - 0.7) / 0.3) * 0.24);
    this.droneGain.gain.setTargetAtTime(g, t, 0.4);
    this.droneFilter?.frequency.setTargetAtTime(200 + L * 950, t, 0.4);
  }

  /** A single heartbeat thump (lub-dub) — quickens as Connection rises. */
  heartbeat(intensity = 1): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const master = this.master;
    const t = ac.currentTime;
    const v = 0.16 + Math.max(0, Math.min(1, intensity)) * 0.16;
    const beat = (at: number, gain: number): void => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(90, at);
      osc.frequency.exponentialRampToValueAtTime(42, at + 0.14);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(g).connect(master);
      osc.start(at);
      osc.stop(at + 0.2);
    };
    beat(t, v); // lub
    beat(t + 0.16, v * 0.72); // dub
  }

  /** A risk-snatch failed — a harsh dissonant buzz-down (the signal rejected). */
  possessFail(): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    // Two detuned saws a tritone apart, crashing downward — deliberately ugly.
    for (const [f0, f1] of [[440, 90], [311, 66]] as const) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + 0.3);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.26, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.36);
    }
  }

  // ---- Signal Carrier + Dead Signal Field (Phases 12–13) --------------------

  /**
   * The Carrier's beacon ping — a deep two-tone sonar pulse. This is how the
   * player *finds* the thing: it carries much further than the beacon glow, so
   * hearing it get louder is the discovery mechanic.
   * @param proximity01 0 (inaudible, far away) → 1 (right on top of it)
   */
  carrierPulse(proximity01: number): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const p = Math.max(0, Math.min(1, proximity01));
    if (p < 0.02) return;
    const t = ac.currentTime;
    // Two stacked sines a fifth apart, filtered dark — reads as "big and organic"
    // rather than a beep. The upper partial only opens up when you're close.
    const ping = (freq: number, at: number, gain: number, dur: number): void => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.72, at + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(g).connect(this.master!);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    };
    const vol = 0.06 + p * p * 0.3; // squared, so it swells sharply on approach
    ping(74, t, vol, 1.1);
    ping(111, t + 0.14, vol * 0.55 * p, 0.8);
  }

  /** A signal node pops — a bright shatter over a sub thump. */
  carrierNodeBreak(): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    // Shatter: filtered noise burst.
    const len = Math.floor(ac.sampleRate * 0.4);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3200, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.35);
    bp.Q.value = 1.4;
    const g = ac.createGain();
    g.gain.value = 0.42;
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    // Sub thump underneath so it lands with weight.
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.4);
    const g2 = ac.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.34, t + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(g2).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  /** The Carrier dies — a long collapsing roar as the entity loses a relay. */
  carrierDeath(): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    // Three detuned saws collapsing over two seconds, through a closing filter.
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(3800, t);
    filt.frequency.exponentialRampToValueAtTime(120, t + 2.0);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    filt.connect(g).connect(this.master);
    for (const f of [196, 148, 99]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.18, t + 2.0);
      osc.connect(filt);
      osc.start(t);
      osc.stop(t + 2.3);
    }
    // A rising shimmer on top — the signal releasing its grip.
    const up = ac.createOscillator();
    up.type = 'triangle';
    up.frequency.setValueAtTime(220, t);
    up.frequency.exponentialRampToValueAtTime(1800, t + 1.4);
    const gu = ac.createGain();
    gu.gain.setValueAtTime(0.0001, t);
    gu.gain.exponentialRampToValueAtTime(0.16, t + 0.3);
    gu.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    up.connect(gu).connect(this.master);
    up.start(t);
    up.stop(t + 1.7);
  }

  // Dead Signal Field ambience: a hollow, detuned shimmer that says "the entity
  // cannot reach you here". Persistent like the connection drone; call every
  // frame with the field strength at the player (0 = outside).
  private fieldOscA: OscillatorNode | null = null;
  private fieldOscB: OscillatorNode | null = null;
  private fieldGain: GainNode | null = null;
  private fieldFilter: BiquadFilterNode | null = null;

  setFieldTone(strength01: number): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const t = ac.currentTime;
    if (!this.fieldGain) {
      this.fieldGain = ac.createGain();
      this.fieldGain.gain.value = 0.0001;
      this.fieldFilter = ac.createBiquadFilter();
      this.fieldFilter.type = 'bandpass';
      this.fieldFilter.frequency.value = 640;
      this.fieldFilter.Q.value = 2.2;
      this.fieldOscA = ac.createOscillator();
      this.fieldOscA.type = 'triangle';
      this.fieldOscA.frequency.value = 318;
      this.fieldOscB = ac.createOscillator();
      this.fieldOscB.type = 'triangle';
      this.fieldOscB.frequency.value = 322.9; // ~5 Hz beating — an unstable, dead tone
      this.fieldOscA.connect(this.fieldFilter);
      this.fieldOscB.connect(this.fieldFilter);
      this.fieldFilter.connect(this.fieldGain).connect(this.master);
      this.fieldOscA.start();
      this.fieldOscB.start();
    }
    const s = Math.max(0, Math.min(1, strength01));
    this.fieldGain.gain.setTargetAtTime(Math.max(0.0001, s * 0.15), t, 0.5);
    this.fieldFilter?.frequency.setTargetAtTime(500 + s * 500, t, 0.5);
  }

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
