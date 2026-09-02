// SMAA 1x（Jimenez et al. 2012）を自前で。画像ファイルは使わない:
//   three の SMAAPass はエリア／サーチのテクスチャを Base64 画像で持つが、ここでは
//   エリア（線の下の面積）をシェーダで解析的に計算し、サーチは 1 画素ずつ歩く（テクスチャ不要）。
//   1. edges   … 輝度の差でエッジ検出（局所コントラスト適応 2.0）→ RG8
//   2. weights … 線の端まで探索し、端の交差エッジのパターン（Z/U/L）から混合の重み → RGBA8
//   3. blend   … 隣の画素と重みで混ぜる
// 入力は sRGB エンコード済みの LDR（知覚的な輝度でエッジを取る）。
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, makeRT } from "./pass";

const EDGES_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
float L(vec2 uv){ return dot(texture2D(tSrc, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }
void main(){
  vec2 t = uTexel;
  float Lm = L(vUv);
  float Lleft = L(vUv + vec2(-t.x, 0.0));
  float Ltop = L(vUv + vec2(0.0, t.y));
  vec4 delta;
  delta.xy = abs(Lm - vec2(Lleft, Ltop));
  vec2 edges = step(vec2(uThreshold), delta.xy);
  if (dot(edges, vec2(1.0)) == 0.0) { gl_FragColor = vec4(0.0); return; }
  float Lright = L(vUv + vec2(t.x, 0.0));
  float Lbottom = L(vUv + vec2(0.0, -t.y));
  delta.zw = abs(Lm - vec2(Lright, Lbottom));
  vec2 maxDelta = max(delta.xy, delta.zw);
  float Lleftleft = L(vUv + vec2(-2.0 * t.x, 0.0));
  float Ltoptop = L(vUv + vec2(0.0, 2.0 * t.y));
  delta.zw = abs(vec2(Lleft, Ltop) - vec2(Lleftleft, Ltoptop));
  maxDelta = max(maxDelta, delta.zw);
  float finalDelta = max(maxDelta.x, maxDelta.y);
  edges *= step(finalDelta, 2.0 * delta.xy);
  gl_FragColor = vec4(edges, 0.0, 1.0);
}
`;

const WEIGHTS_FRAG = /* glsl */ `
uniform sampler2D tEdges;
uniform vec2 uTexel;
varying vec2 vUv;
#define MAX_STEPS 16
vec2 E(vec2 uv){ return texture2D(tEdges, uv).rg; }

// 線 p1→p2 の下（y<0 側）と上の面積。画素 [x, x+1]（SMAA の AreaTex.py と同じ）
vec2 area(vec2 p1, vec2 p2, float x){
  vec2 d = p2 - p1;
  float x1 = x, x2 = x + 1.0;
  float y1 = p1.y + d.y * (x1 - p1.x) / d.x;
  float y2 = p1.y + d.y * (x2 - p1.x) / d.x;
  bool inside = (x1 >= p1.x && x1 < p2.x) || (x2 > p1.x && x2 <= p2.x);
  if (!inside) return vec2(0.0);
  bool trapezoid = (y1 >= 0.0 && y2 >= 0.0) || (y1 <= 0.0 && y2 <= 0.0);
  if (trapezoid) {
    float a = (y1 + y2) * 0.5;
    return a < 0.0 ? vec2(abs(a), 0.0) : vec2(0.0, abs(a));
  }
  float xc = -p1.y * d.x / d.y + p1.x;
  float a1 = xc > p1.x ? y1 * (xc - floor(xc)) * 0.5 : 0.0;
  float a2 = xc < p2.x ? y2 * (ceil(xc) - xc) * 0.5 : 0.0;
  float a = abs(a1) > abs(a2) ? a1 : -a2;
  return a < 0.0 ? vec2(abs(a1), abs(a2)) : vec2(abs(a2), abs(a1));
}
vec2 smoothArea(float d, vec2 a1, vec2 a2){
  vec2 b1 = sqrt(a1 * 2.0), b2 = sqrt(a2 * 2.0);
  float p = smoothstep(0.0, 32.0, d);
  return mix(b1, a1, p) + mix(b2, a2, p);
}
// bits: 1 = 自分の側に交差エッジ, 2 = 隣の側に交差エッジ。p = b1 + 4*b2（左端/上端が b1）
vec2 areaOrtho(int p, float left, float right){
  float d = left + right + 1.0;
  vec2 P0 = vec2(0.0, -0.5), P1 = vec2(0.0, 0.5), Pm = vec2(d * 0.5, 0.0), E0 = vec2(d, -0.5), E1 = vec2(d, 0.5);
  if (p == 1) return left <= right ? area(P0, Pm, left) : vec2(0.0);
  if (p == 2) return left >= right ? area(Pm, E0, left) : vec2(0.0);
  if (p == 3) return smoothArea(d, area(P0, Pm, left), area(Pm, E0, left));
  if (p == 4) return left <= right ? area(P1, Pm, left) : vec2(0.0);
  if (p == 6 || p == 7 || p == 14) return area(P1, E0, left);
  if (p == 8) return left >= right ? area(Pm, E1, left) : vec2(0.0);
  if (p == 9 || p == 11 || p == 13) return area(P0, E1, left);
  if (p == 12) return smoothArea(d, area(P1, Pm, left), area(Pm, E1, left));
  return vec2(0.0);
}
int bits(float mine, float other){ return int(step(0.5, mine)) + 2 * int(step(0.5, other)); }

void main(){
  vec2 t = uTexel;
  vec2 e = E(vUv);
  vec4 weights = vec4(0.0);
  if (e.g > 0.5) {
    // 上側にエッジ（水平の線）。左端へ
    vec2 ep = e;
    vec2 uvp = vUv;
    float dl = 0.0;
    int b1 = 0;
    for (int i = 0; i < MAX_STEPS; i++) {
      float rUp = E(uvp + vec2(0.0, t.y)).r;
      if (ep.r > 0.5 || rUp > 0.5) { b1 = bits(ep.r, rUp); break; }
      vec2 en = E(uvp - vec2(t.x, 0.0));
      if (en.g < 0.5) break;
      ep = en;
      uvp -= vec2(t.x, 0.0);
      dl += 1.0;
    }
    // 右端へ
    uvp = vUv;
    float dr = 0.0;
    int b2 = 0;
    for (int i = 0; i < MAX_STEPS; i++) {
      vec2 en = E(uvp + vec2(t.x, 0.0));
      float rUp = E(uvp + vec2(t.x, t.y)).r;
      if (en.r > 0.5 || rUp > 0.5) { b2 = bits(en.r, rUp); break; }
      if (en.g < 0.5) break;
      uvp += vec2(t.x, 0.0);
      dr += 1.0;
    }
    weights.rg = areaOrtho(b1 + 4 * b2, dl, dr);
  }
  if (e.r > 0.5) {
    // 左側にエッジ（垂直の線）。上端へ
    vec2 ep = e;
    vec2 uvp = vUv;
    float du = 0.0;
    int b1 = 0;
    for (int i = 0; i < MAX_STEPS; i++) {
      float gL = E(uvp - vec2(t.x, 0.0)).g;
      if (ep.g > 0.5 || gL > 0.5) { b1 = bits(ep.g, gL); break; }
      vec2 en = E(uvp + vec2(0.0, t.y));
      if (en.r < 0.5) break;
      ep = en;
      uvp += vec2(0.0, t.y);
      du += 1.0;
    }
    // 下端へ
    uvp = vUv;
    float dd = 0.0;
    int b2 = 0;
    for (int i = 0; i < MAX_STEPS; i++) {
      vec2 en = E(uvp - vec2(0.0, t.y));
      float gL = E(uvp - vec2(t.x, t.y)).g;
      if (en.g > 0.5 || gL > 0.5) { b2 = bits(en.g, gL); break; }
      if (en.r < 0.5) break;
      uvp -= vec2(0.0, t.y);
      dd += 1.0;
    }
    weights.ba = areaOrtho(b1 + 4 * b2, du, dd);
  }
  gl_FragColor = weights;
}
`;

const BLEND_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tWeights;
uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec2 t = uTexel;
  vec4 wm = texture2D(tWeights, vUv);
  float wUp = wm.r;
  float wLeft = wm.b;
  float wDown = texture2D(tWeights, vUv - vec2(0.0, t.y)).g;
  float wRight = texture2D(tWeights, vUv + vec2(t.x, 0.0)).a;
  vec4 C = texture2D(tColor, vUv);
  if (wUp + wDown + wLeft + wRight < 1e-5) { gl_FragColor = C; return; }
  vec2 off;
  off.x = wRight > wLeft ? wRight : -wLeft;
  off.y = wUp > wDown ? wUp : -wDown;
  if (abs(off.x) > abs(off.y)) off.y = 0.0; else off.x = 0.0;
  vec4 Cop = texture2D(tColor, vUv + sign(off) * t);
  float s = max(abs(off.x), abs(off.y));
  gl_FragColor = mix(C, Cop, s);
}
`;

export class SMAA {
  edgesRT: THREE.WebGLRenderTarget;
  weightsRT: THREE.WebGLRenderTarget;
  private edgesMat: THREE.ShaderMaterial;
  private weightsMat: THREE.ShaderMaterial;
  private blendMat: THREE.ShaderMaterial;

  constructor(threshold = 0.08) {
    this.edgesRT = makeRT(1, 1, { type: THREE.UnsignedByteType, format: THREE.RGFormat, filter: THREE.NearestFilter });
    this.weightsRT = makeRT(1, 1, { type: THREE.UnsignedByteType, filter: THREE.NearestFilter });
    this.edgesMat = fsMaterial("smaa_edges", { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: threshold } }, EDGES_FRAG);
    this.weightsMat = fsMaterial("smaa_weights", { tEdges: { value: null }, uTexel: { value: new THREE.Vector2() } }, WEIGHTS_FRAG);
    this.blendMat = fsMaterial("smaa_blend", { tColor: { value: null }, tWeights: { value: null }, uTexel: { value: new THREE.Vector2() } }, BLEND_FRAG);
  }

  resize(w: number, h: number) {
    this.edgesRT.setSize(w, h);
    this.weightsRT.setSize(w, h);
  }

  /** src（LDR sRGB）→ target */
  render(pipeline: Pipeline, src: THREE.Texture, w: number, h: number, target: THREE.WebGLRenderTarget | null) {
    const em = this.edgesMat, wm = this.weightsMat, bm = this.blendMat;
    em.uniforms.tSrc.value = src;
    (em.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    pipeline.blit(em, this.edgesRT);
    wm.uniforms.tEdges.value = this.edgesRT.texture;
    (wm.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    pipeline.blit(wm, this.weightsRT);
    bm.uniforms.tColor.value = src;
    bm.uniforms.tWeights.value = this.weightsRT.texture;
    (bm.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    pipeline.blit(bm, target);
  }

  dispose() {
    this.edgesRT.dispose();
    this.weightsRT.dispose();
    this.edgesMat.dispose();
    this.weightsMat.dispose();
    this.blendMat.dispose();
  }
}
