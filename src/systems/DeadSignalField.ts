import {
  AdditiveBlending,
  BackSide,
  Color,
  FrontSide,
  Group,
  Mesh,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

/**
 * A Dead Signal Field (Phase 13) — the crater a dead Signal Carrier leaves in the
 * entity's reach, and the game's central risk-reward moment.
 *
 * Inside the boundary the entity loses its grip: Connection *drains* instead of
 * rising, and a takeover is meaningfully safer. That is the only renewable relief
 * in a run, so the field is worth standing in. It is also the worst place in the
 * ocean to stand: the dead signal drives every creature nearby into a frenzy in
 * which they attack whatever is closest — each other included. The player gets
 * food, naturally weakened possession targets, and a very good chance of dying.
 *
 * It is deliberately temporary and un-farmable: the radius collapses over its
 * lifetime, the drain fades as it collapses, and one Carrier per zone per run
 * means there is no second field to camp.
 *
 * Rendering is one inverted fresnel sphere (two draw calls, no lighting, no
 * depth write) — the cheapest thing that still reads as a volume you are inside.
 */

/** Total lifetime, seconds. Long enough to matter, short enough not to be a camp. */
const LIFETIME = 95;
const START_RADIUS = 62;
/** Radius at the very end of the collapse, as a fraction of START_RADIUS. */
const END_RADIUS_FRAC = 0.18;
/**
 * Connection removed per second at the field's heart, at full strength.
 * Tuned down from 0.075 after measuring: that cleared a 90% bar in 13 s, which
 * made the field an instant reset rather than the "gradual reduction" the design
 * asks for. At 0.04 a full clear costs ~25 s at the heart and ~40 s at the
 * strength you actually get while manoeuvring — long enough that the frenzy has
 * a real chance to kill you for it.
 */
const DRAIN_PER_SEC = 0.04;
/** Extra possession odds granted inside (added to PlayerPossession.riskChance). */
const RISK_BONUS = 0.3;

export class DeadSignalField {
  readonly pos = new Vector3();
  /** Seconds remaining before the field collapses entirely. */
  private life = LIFETIME;
  radius = START_RADIUS;
  active = true;

  private readonly group = new Group();
  private readonly shellOut: Mesh;
  private readonly shellIn: Mesh;
  private readonly matOut: ShaderMaterial;
  private readonly matIn: ShaderMaterial;
  private time = 0;

  constructor(
    private readonly scene: Scene,
    at: Vector3,
  ) {
    this.pos.copy(at);
    this.group.position.copy(at);
    this.group.name = 'dead-signal-field';

    // Unit sphere, scaled per frame as the field collapses — one geometry.
    const geo = new SphereGeometry(1, 32, 20);
    // Both shells share one geometry, so the two cases differ: from OUTSIDE you
    // see the front hemisphere's front faces AND the back hemisphere's back
    // faces, and their haze stacks; from INSIDE only the BackSide shell draws.
    // The outer shell therefore gets the smaller floor, or the dome turns milky
    // enough to hide the brawl going on inside it — which is the one thing this
    // volume must never do.
    this.matOut = makeShellMaterial(FrontSide, 0.26, 0.028);
    this.matIn = makeShellMaterial(BackSide, 0.26, 0.055);
    this.shellOut = new Mesh(geo, this.matOut);
    this.shellIn = new Mesh(geo, this.matIn);
    this.shellOut.frustumCulled = false;
    this.shellIn.frustumCulled = false;
    // Drawn after the world so the volume tints whatever is inside it.
    this.shellOut.renderOrder = 4;
    this.shellIn.renderOrder = 4;
    this.group.add(this.shellIn, this.shellOut);
    scene.add(this.group);
  }

  /** 0..1 lifetime remaining — 1 at the kill, 0 as it winks out. */
  get life01(): number {
    return Math.max(0, this.life / LIFETIME);
  }

  /** True while the given point is inside the boundary. */
  contains(p: Vector3): boolean {
    return this.active && p.distanceToSquared(this.pos) < this.radius * this.radius;
  }

  /**
   * How strongly the field acts on a point: 1 at the heart, tapering to 0 at the
   * boundary, and fading overall as the field collapses. Everything the field
   * does — Connection drain, possession bonus, frenzy pull — reads off this, so
   * lingering at the edge of a dying field is correctly worth almost nothing.
   */
  strengthAt(p: Vector3): number {
    if (!this.active) return 0;
    const d = p.distanceTo(this.pos);
    if (d >= this.radius) return 0;
    const radial = 1 - d / this.radius;
    // Fade the last fifth of the life so the collapse is felt, not just seen.
    const decay = Math.min(1, this.life01 / 0.2);
    return radial * decay;
  }

  /** Connection removed this frame for a player at `p` (0 when outside). */
  drainFor(p: Vector3, dt: number): number {
    return this.strengthAt(p) * DRAIN_PER_SEC * dt;
  }

  /** Bonus possession odds inside the field (0 outside) — takeovers are safer here. */
  riskBonusFor(p: Vector3): number {
    return this.strengthAt(p) * RISK_BONUS;
  }

  update(dt: number): boolean {
    if (!this.active) return false;
    this.time += dt;
    this.life -= dt;
    if (this.life <= 0) {
      this.active = false;
      this.group.visible = false;
      return false;
    }

    // Collapse: ease the radius down over the lifetime, quickly at the very end.
    const k = this.life01;
    this.radius = START_RADIUS * (END_RADIUS_FRAC + (1 - END_RADIUS_FRAC) * Math.pow(k, 0.65));
    this.group.scale.setScalar(this.radius);

    const u = this.matOut.uniforms;
    const ui = this.matIn.uniforms;
    u.uTime.value = ui.uTime.value = this.time;
    // Brightest right after the kill, dimming as the entity reasserts itself.
    const glow = 0.55 + Math.min(1, k / 0.35) * 0.45;
    u.uGlow.value = glow;
    ui.uGlow.value = glow;
    return true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.shellOut.geometry.dispose();
    this.matOut.dispose();
    this.matIn.dispose();
    this.active = false;
  }
}

/**
 * The boundary shell: a fresnel rim over a faint base haze. Fresnel alone was
 * the first attempt and it failed the readability bar — at gameplay distances
 * the silhouette sits off-screen and you are looking through the sphere's
 * face-on centre, where fresnel is zero, so the field was literally invisible
 * from both inside and out. `base` puts a floor under the alpha so the volume
 * always reads as a haze you are in, while the rim still does the work of
 * showing you where the edge is. Additive, unlit, no depth write.
 *
 * @param strength weight of the fresnel rim
 * @param base     constant haze floor — keep small; it covers the whole screen
 *                 when the player is inside the field
 */
function makeShellMaterial(
  side: typeof FrontSide | typeof BackSide,
  strength: number,
  base: number,
): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 1 },
      uStrength: { value: strength },
      uBase: { value: base },
      uColor: { value: new Color(0x63ffd8) },
      uColorRim: { value: new Color(0xaaa0ff) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uGlow;
      uniform float uStrength;
      uniform float uBase;
      uniform vec3 uColor;
      uniform vec3 uColorRim;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vLocal;

      void main() {
        // Fresnel: transparent head-on, bright at the silhouette.
        float f = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir)));
        f = pow(clamp(f, 0.0, 1.0), 2.4);

        // Slow interference bands crawling over the membrane — dead static.
        float bands =
          sin(vLocal.y * 11.0 - uTime * 1.7) * 0.5 +
          sin((vLocal.x + vLocal.z) * 7.0 + uTime * 1.1) * 0.5;
        bands = 0.5 + 0.35 * bands;

        vec3 col = mix(uColor, uColorRim, f) * (0.65 + bands * 0.7);
        // Rim + haze floor. The floor is what makes the volume readable when the
        // silhouette is off-screen (i.e. whenever you are near or inside it).
        float a = (f * uStrength + uBase * (0.55 + bands * 0.45)) * uGlow;
        gl_FragColor = vec4(col * uGlow, a);
      }
    `,
  });
}
