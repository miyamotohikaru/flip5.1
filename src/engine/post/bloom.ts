// ブルーム。しきい値で切らない物理寄りのもの（Call of Duty: Advanced Warfare 方式）。
//   ダウンサンプル: 13 タップ（最初の段だけ Karis 平均で「点のギラつき」を抑える）
//   アップサンプル: 3×3 テント。段ごとの重みで「近い滲み」と「広い霞」の比率を決める
// 出力は半分解像度の HDR。合成側で mix(color, bloom, strength) として混ぜる（足さないので全体が白く霞まない）。
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, makeRT, POST_COMMON } from "./pass";

const DOWN_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uKaris;
uniform float uClamp;
varying vec2 vUv;
vec3 s(vec2 o){ return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(uClamp)); }
float kw(vec3 c){ return 1.0 / (1.0 + post_luma(c)); }
void main(){
  vec3 a = s(vec2(-2.0, -2.0)), b = s(vec2(0.0, -2.0)), c = s(vec2(2.0, -2.0));
  vec3 d = s(vec2(-2.0,  0.0)), e = s(vec2(0.0,  0.0)), f = s(vec2(2.0,  0.0));
  vec3 g = s(vec2(-2.0,  2.0)), h = s(vec2(0.0,  2.0)), i = s(vec2(2.0,  2.0));
  vec3 j = s(vec2(-1.0, -1.0)), k = s(vec2(1.0, -1.0)), l = s(vec2(-1.0, 1.0)), m = s(vec2(1.0, 1.0));
  vec3 o;
  if (uKaris > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
    o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    o = (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + e * 0.125 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(o, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tCur;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
void main(){
  vec2 o = uTexel * uRadius;
  vec3 c = texture2D(tLow, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture2D(tLow, vUv + vec2( 0.0, -o.y)).rgb * 2.0;
  c += texture2D(tLow, vUv + vec2( o.x, -o.y)).rgb;
  c += texture2D(tLow, vUv + vec2(-o.x,  0.0)).rgb * 2.0;
  c += texture2D(tLow, vUv).rgb * 4.0;
  c += texture2D(tLow, vUv + vec2( o.x,  0.0)).rgb * 2.0;
  c += texture2D(tLow, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture2D(tLow, vUv + vec2( 0.0,  o.y)).rgb * 2.0;
  c += texture2D(tLow, vUv + vec2( o.x,  o.y)).rgb;
  c *= (1.0 / 16.0);
  gl_FragColor = vec4(texture2D(tCur, vUv).rgb * uWeight + c, 1.0);
}
`;

export class Bloom {
  down: THREE.WebGLRenderTarget[] = [];
  up: THREE.WebGLRenderTarget[] = [];
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  /** 段ごとの重み（0 = 半分解像度。細かい滲み → 広い霞） */
  weights: number[];
  /** 重みの合計。合成側は texture / weightSum で「平均」に戻す */
  weightSum = 1;
  levels: number;

  constructor(levels = 6) {
    this.levels = levels;
    this.weights = [];
    for (let i = 0; i < levels; i++) this.weights.push(Math.pow(0.78, i));
    this.weightSum = this.weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < levels; i++) {
      this.down.push(makeRT(1, 1));
      this.up.push(makeRT(1, 1));
    }
    this.downMat = fsMaterial(
      "bloom_down",
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 }, uClamp: { value: 24 } },
      DOWN_FRAG,
    );
    this.upMat = fsMaterial(
      "bloom_up",
      { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uWeight: { value: 1 } },
      UP_FRAG,
    );
  }

  resize(w: number, h: number) {
    for (let i = 0; i < this.levels; i++) {
      const s = Math.pow(2, i + 1);
      const lw = Math.max(1, Math.floor(w / s)), lh = Math.max(1, Math.floor(h / s));
      this.down[i].setSize(lw, lh);
      this.up[i].setSize(lw, lh);
    }
  }

  /** 最小段（露出の計測に使う） */
  get smallest() {
    return this.down[this.levels - 1];
  }

  /** 結果（半分解像度、重み付き合計）。合成側で weightSum で割る */
  get texture() {
    return this.up[0].texture;
  }

  render(pipeline: Pipeline, source: THREE.Texture, srcW: number, srcH: number) {
    const dm = this.downMat, um = this.upMat;
    let src = source, sw = srcW, sh = srcH;
    for (let i = 0; i < this.levels; i++) {
      dm.uniforms.tSrc.value = src;
      (dm.uniforms.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      // Karis 平均は太陽の滲みまで消してしまうので使わない（代わりに uClamp で点のギラつきを抑える）
      dm.uniforms.uKaris.value = 0;
      pipeline.blit(dm, this.down[i]);
      src = this.down[i].texture;
      sw = this.down[i].width;
      sh = this.down[i].height;
    }
    // 最小段: up = down * w。（半径 0 のテントは down そのものなので、tCur の重みを w-1 にして合計 w にする）
    const last = this.levels - 1;
    um.uniforms.tLow.value = this.down[last].texture;
    um.uniforms.tCur.value = this.down[last].texture;
    (um.uniforms.uTexel.value as THREE.Vector2).set(1 / this.down[last].width, 1 / this.down[last].height);
    um.uniforms.uRadius.value = 0;
    um.uniforms.uWeight.value = this.weights[last] - 1.0;
    pipeline.blit(um, this.up[last]);
    for (let i = last - 1; i >= 0; i--) {
      um.uniforms.tLow.value = this.up[i + 1].texture;
      um.uniforms.tCur.value = this.down[i].texture;
      (um.uniforms.uTexel.value as THREE.Vector2).set(1 / this.up[i + 1].width, 1 / this.up[i + 1].height);
      um.uniforms.uRadius.value = 1.0;
      um.uniforms.uWeight.value = this.weights[i];
      pipeline.blit(um, this.up[i]);
    }
  }

  dispose() {
    for (const r of this.down) r.dispose();
    for (const r of this.up) r.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
  }
}
