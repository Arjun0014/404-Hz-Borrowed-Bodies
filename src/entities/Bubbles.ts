import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Points,
  ShaderMaterial,
  Vector3,
  type Scene,
} from 'three';

const GRAVITY_UP = 3.2; // bubbles rise
const TMP = new Vector3();

/**
 * Pooled bubble particles. A slow ambient sprinkle rises everywhere for a
 * living-water feel; dashing emits a dense burst from the fish's tail that
 * streams backward, giving swimming a tactile "pushing through water" effect.
 */
export class Bubbles {
  readonly points: Points;

  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly aData: Float32Array; // per-vertex: size, alpha
  private readonly geo: BufferGeometry;
  private readonly mat: ShaderMaterial;
  private cursor = 0;
  private ambientAccum = 0;

  constructor(scene: Scene, max = 260) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.aData = new Float32Array(max * 2);

    // Start all dead and far away.
    for (let i = 0; i < max; i++) {
      this.pos[i * 3 + 1] = 100000;
      this.life[i] = 0;
    }

    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aData', new BufferAttribute(this.aData, 2));
    this.geo.boundingSphere = null;

    this.mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTex: { value: makeBubbleTexture() },
        uPixelRatio: { value: 1 },
        uFar: { value: 55 },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aData; // x=size, y=alpha
        uniform float uPixelRatio;
        uniform float uFar;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = -mv.z;
          // Fade with distance (additive can't use scene fog correctly).
          float distFade = 1.0 - smoothstep(uFar * 0.5, uFar, dist);
          // Also fade bubbles that are almost on top of the camera so the
          // dash trail never blooms into giant rings in your face — but keep
          // them visible from ~1 m out so the trail actually reads.
          float nearFade = smoothstep(0.4, 1.1, dist);
          vAlpha = aData.y * distFade * nearFade;
          gl_PointSize = min(aData.x * uPixelRatio * (70.0 / max(dist, 0.4)), 42.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(t.rgb, t.a * vAlpha);
        }
      `,
    });

    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    scene.add(this.points);
  }

  setPixelRatio(r: number): void {
    this.mat.uniforms.uPixelRatio.value = r;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  /**
   * @param camPos camera position (ambient bubbles spawn around it)
   * @param tailPos world position just behind the fish
   * @param fishVel current fish velocity (dash bubbles inherit a little)
   * @param dashOutput 0..1 — how hard the fish is thrusting (drives burst rate)
   */
  update(dt: number, camPos: Vector3, tailPos: Vector3, fishVel: Vector3, dashOutput: number): void {
    // --- ambient sprinkle around the camera ---
    this.ambientAccum += dt * 9;
    while (this.ambientAccum >= 1) {
      this.ambientAccum -= 1;
      const a = Math.random() * Math.PI * 2;
      const rad = 8 + Math.random() * 26;
      TMP.set(Math.cos(a) * rad, -8 - Math.random() * 14, Math.sin(a) * rad).add(camPos);
      this.spawn(
        TMP.x,
        TMP.y,
        TMP.z,
        (Math.random() - 0.5) * 0.3,
        GRAVITY_UP * (0.4 + Math.random() * 0.4),
        (Math.random() - 0.5) * 0.3,
        0.35 + Math.random() * 0.55,
        3.5 + Math.random() * 3,
      );
    }

    // --- dash trail from the fish tail ---
    if (dashOutput > 0.02) {
      const rate = dashOutput * 40;
      const n = rate * dt;
      let count = Math.floor(n);
      if (Math.random() < n - count) count++;
      for (let k = 0; k < count; k++) {
        this.spawn(
          tailPos.x + (Math.random() - 0.5) * 0.35,
          tailPos.y + (Math.random() - 0.5) * 0.35,
          tailPos.z + (Math.random() - 0.5) * 0.35,
          -fishVel.x * 0.3 + (Math.random() - 0.5) * 1.0,
          -fishVel.y * 0.2 + GRAVITY_UP * 0.5 + (Math.random() - 0.5) * 0.7,
          -fishVel.z * 0.3 + (Math.random() - 0.5) * 1.0,
          0.2 + Math.random() * 0.4,
          0.8 + Math.random() * 0.8,
        );
      }
    }

    // --- integrate ---
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.aData[i * 2 + 1] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = i * 3;
      // Buoyancy + wobble + drag.
      this.vel[t + 1] += GRAVITY_UP * dt * 0.35;
      const wob = Math.sin((this.life[i] + i) * 6) * 0.4;
      this.pos[t] += (this.vel[t] + wob) * dt;
      this.pos[t + 1] += this.vel[t + 1] * dt;
      this.pos[t + 2] += this.vel[t + 2] * dt;
      const drag = Math.exp(-1.5 * dt);
      this.vel[t] *= drag;
      this.vel[t + 2] *= drag;
      this.vel[t + 1] = Math.min(this.vel[t + 1] * drag + GRAVITY_UP * dt, GRAVITY_UP);

      const lifeT = this.life[i] / this.maxLife[i];
      // Fade in fast, fade out slow.
      const alpha = Math.min(1, (1 - lifeT) * 6) * Math.min(1, lifeT * 1.6);
      this.aData[i * 2] = this.size[i];
      this.aData[i * 2 + 1] = alpha * 0.7;
    }

    (this.geo.attributes.position as BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aData as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.parent?.remove(this.points);
    this.geo.dispose();
    (this.mat.uniforms.uTex.value as CanvasTexture).dispose();
    this.mat.dispose();
  }
}

function makeBubbleTexture(): CanvasTexture {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const c = s / 2;
  // Ring: transparent centre, bright thin rim (reads as a bubble).
  const g = ctx.createRadialGradient(c, c, s * 0.16, c, c, s * 0.48);
  g.addColorStop(0, 'rgba(200,235,240,0.05)');
  g.addColorStop(0.72, 'rgba(210,240,245,0.1)');
  g.addColorStop(0.9, 'rgba(235,250,252,0.7)');
  g.addColorStop(1, 'rgba(220,245,250,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  // Highlight glint.
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(c * 0.72, c * 0.72, s * 0.07, 0, Math.PI * 2);
  ctx.fill();
  return new CanvasTexture(canvas);
}
