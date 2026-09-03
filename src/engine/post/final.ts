// 最終パス（AA の後）: シャープネス（近傍で挟んでリンギングを防ぐ）→ 周辺の色収差 → 粒子（決定的）→ ディザ。
// 入力・出力とも sRGB エンコード済み。alpha（裏返しマスク）が高いほど強くシャープにして線を細く見せる。
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, POST_COMMON } from "./pass";

const FINAL_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uSharpen;
uniform float uSharpenFlip;
uniform float uCA;
uniform float uGrain;
uniform float uGrainSeed;
uniform vec2 uGrainScale;
varying vec2 vUv;
void main(){
  vec2 t = uTexel;
  vec4 c = texture2D(tSrc, vUv);
  vec3 n = texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb;
  vec3 s = texture2D(tSrc, vUv - vec2(0.0, t.y)).rgb;
  vec3 e = texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb;
  vec3 w = texture2D(tSrc, vUv - vec2(t.x, 0.0)).rgb;
  vec3 mn = min(min(min(n, s), min(e, w)), c.rgb);
  vec3 mx = max(max(max(n, s), max(e, w)), c.rgb);
  float sharp = uSharpen + uSharpenFlip * c.a;
  vec3 blur = (n + s + e + w) * 0.25;
  vec3 col = clamp(c.rgb + (c.rgb - blur) * sharp, mn, mx);
  // 周辺の色収差（中央 4 割は掛けない、隅で uCA px）
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d) * 2.0;
  float ca = uCA * smoothstep(0.18, 1.0, r2);
  if (ca > 0.02) {
    vec2 off = d * ca * 2.0 * t.y;
    col.r += texture2D(tSrc, vUv + off).r - c.r;
    col.b += texture2D(tSrc, vUv - off).b - c.b;
  }
  // 粒子: 中間調〜影で強く、ハイライトで弱く。時間でシードが変わる（freeze 中は固定）。
  // 2 つ目のハッシュは「格子を 1.7 倍」ではなく「ずらす」。1.7 = 17/10 なので整数格子だと
  // 10px 周期になり、平坦な空に斜めの網目（クロスハッチ）が出ていた
  vec2 gp = floor(vUv * uGrainScale);
  float g = post_hash12(gp + uGrainSeed) - 0.5;
  float g2 = post_hash12(gp + vec2(37.31, 91.17) + uGrainSeed) - 0.5;
  float lum = post_luma(col);
  float ga = uGrain * (1.0 - smoothstep(0.2, 1.0, lum) * 0.65);
  col += (g * 0.7 + g2 * 0.3) * ga;
  // 8bit のディザ（TPDF = 独立な 2 つの一様乱数の差。平坦な空で縞にも網目にもならない）
  float d1 = post_hash12(gl_FragCoord.xy + uGrainSeed + 5.71);
  float d2 = post_hash12(gl_FragCoord.xy + uGrainSeed + 71.3);
  col += (d1 - d2) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export class Final {
  mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = fsMaterial(
      "post_final",
      {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSharpen: { value: 0.3 },
        uSharpenFlip: { value: 0.35 },
        uCA: { value: 0.8 },
        uGrain: { value: 0.025 },
        uGrainSeed: { value: 0 },
        uGrainScale: { value: new THREE.Vector2(1, 1) },
      },
      FINAL_FRAG,
    );
  }
  render(pipeline: Pipeline, src: THREE.Texture, w: number, h: number, grainPx: number, target: THREE.WebGLRenderTarget | null) {
    const u = this.mat.uniforms;
    u.tSrc.value = src;
    (u.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (u.uGrainScale.value as THREE.Vector2).set(w / grainPx, h / grainPx);
    pipeline.blit(this.mat, target);
  }
  dispose() {
    this.mat.dispose();
  }
}
