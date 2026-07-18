import { Vector2, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Full-screen underwater look: a gentle animated refraction wobble so the whole
 * view feels like it is seen through moving water, a bluish depth vignette, and
 * a speed-driven radial warp + chromatic streak that kicks in while swimming
 * fast / dashing (the "rushing through water" feel).
 */
const UnderwaterShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uSpeed;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;

      // Ambient refraction wobble — small, felt more than seen.
      vec2 wob;
      wob.x = sin(uv.y * 24.0 + uTime * 1.4) * 0.0016 + sin(uv.y * 8.0 - uTime * 0.7) * 0.0011;
      wob.y = cos(uv.x * 20.0 + uTime * 1.1) * 0.0016 + cos(uv.x * 6.5 + uTime * 0.5) * 0.0011;

      vec2 center = uv - 0.5;
      float r = length(center);
      vec2 radial = center / (r + 1e-5);

      // Speed pulls the image outward from the centre → sense of rushing forward.
      float speed = clamp(uSpeed, 0.0, 1.6);
      vec2 warp = radial * speed * 0.005 * smoothstep(0.1, 0.8, r);

      vec2 suv = uv + wob + warp;

      // Subtle chromatic streak at the edges, a little stronger with speed.
      float ca = (0.0005 + speed * 0.0022) * r;
      vec3 col;
      col.r = texture2D(tDiffuse, suv + radial * ca).r;
      col.g = texture2D(tDiffuse, suv).g;
      col.b = texture2D(tDiffuse, suv - radial * ca).b;

      // Subtle bluish depth vignette (kept light — the Shallow Veil is sunlit).
      float vig = smoothstep(1.1, 0.35, r);
      col *= mix(0.9, 1.0, vig);
      col = mix(col, col * vec3(0.78, 0.92, 1.05), (1.0 - vig) * 0.35);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class UnderwaterFx {
  private readonly composer: EffectComposer;
  private readonly pass: ShaderPass;
  private readonly sizeTmp = new Vector2();
  private time = 0;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.pass = new ShaderPass(UnderwaterShader);
    this.composer.addPass(this.pass);
    // OutputPass applies tone mapping + sRGB conversion (the composer's render
    // targets are linear, so without it the whole image renders too dark).
    this.composer.addPass(new OutputPass());
    this.syncSize(renderer);
  }

  private syncSize(renderer: WebGLRenderer): void {
    const size = renderer.getSize(this.sizeTmp);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
  }

  resize(renderer: WebGLRenderer): void {
    this.syncSize(renderer);
  }

  /** speed01 is 0..~1.9 (dashing pushes above 1). */
  render(dt: number, speed01: number): void {
    this.time += dt;
    this.pass.uniforms.uTime.value = this.time;
    // Smooth the speed input a touch so the warp eases in/out.
    const cur = this.pass.uniforms.uSpeed.value as number;
    this.pass.uniforms.uSpeed.value = cur + (speed01 - cur) * Math.min(1, dt * 6);
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
