// FXAA 3.11（Timothy Lottes）品質プリセット 12 相当を自前で。mid 段階（SMAA より軽い）で使う。
// 入力は sRGB エンコード済みの LDR。alpha はそのまま通す（裏返しマスク）。
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial } from "./pass";

const FXAA_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
#define EDGE_THRESHOLD 0.125
#define EDGE_THRESHOLD_MIN 0.0312
#define SUBPIX 0.75
float L(vec2 uv){ vec3 c = texture2D(tSrc, uv).rgb; return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec2 t = uTexel;
  vec2 posM = vUv;
  vec4 rgbaM = texture2D(tSrc, posM);
  float lumaM = dot(rgbaM.rgb, vec3(0.299, 0.587, 0.114));
  float lumaS = L(posM + vec2(0.0, t.y));
  float lumaE = L(posM + vec2(t.x, 0.0));
  float lumaN = L(posM - vec2(0.0, t.y));
  float lumaW = L(posM - vec2(t.x, 0.0));
  float maxSM = max(lumaS, lumaM), minSM = min(lumaS, lumaM);
  float maxESM = max(lumaE, maxSM), minESM = min(lumaE, minSM);
  float maxWN = max(lumaN, lumaW), minWN = min(lumaN, lumaW);
  float rangeMax = max(maxWN, maxESM), rangeMin = min(minWN, minESM);
  float range = rangeMax - rangeMin;
  if (range < max(EDGE_THRESHOLD_MIN, rangeMax * EDGE_THRESHOLD)) { gl_FragColor = rgbaM; return; }
  float lumaNW = L(posM + vec2(-t.x, -t.y));
  float lumaSE = L(posM + vec2(t.x, t.y));
  float lumaNE = L(posM + vec2(t.x, -t.y));
  float lumaSW = L(posM + vec2(-t.x, t.y));
  float lumaNS = lumaN + lumaS;
  float lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = (-2.0 * lumaM) + lumaNS;
  float edgeVert1 = (-2.0 * lumaM) + lumaWE;
  float lumaNESE = lumaNE + lumaSE;
  float lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = (-2.0 * lumaE) + lumaNESE;
  float edgeVert2 = (-2.0 * lumaN) + lumaNWNE;
  float lumaNWSW = lumaNW + lumaSW;
  float lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);
  float edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);
  float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;
  float edgeVert3 = (-2.0 * lumaS) + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4;
  float edgeVert = abs(edgeVert3) + edgeVert4;
  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = t.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; }
  if (horzSpan) lengthSign = t.y;
  float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;
  float gradientN = lumaN - lumaM;
  float gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM;
  float lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);
  vec2 posB = posM;
  vec2 offNP = vec2(horzSpan ? t.x : 0.0, horzSpan ? 0.0 : t.y);
  if (!horzSpan) posB.x += lengthSign * 0.5;
  if (horzSpan) posB.y += lengthSign * 0.5;
  vec2 posN = posB - offNP;
  vec2 posP = posB + offNP;
  float subpixD = ((-2.0) * subpixC) + 3.0;
  float lumaEndN = L(posN);
  float subpixE = subpixC * subpixC;
  float lumaEndP = L(posP);
  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled;
  bool doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) posN -= offNP * 1.5;
  bool doneNP = (!doneN) || (!doneP);
  if (!doneP) posP += offNP * 1.5;
  for (int i = 2; i < 12; i++) {
    if (!doneNP) break;
    float stp = i < 10 ? 2.0 : (i == 10 ? 4.0 : 8.0);
    if (!doneN) lumaEndN = L(posN) - lumaNN * 0.5;
    if (!doneP) lumaEndP = L(posP) - lumaNN * 0.5;
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP * stp;
    doneNP = (!doneN) || (!doneP);
    if (!doneP) posP += offNP * stp;
  }
  float dstN = horzSpan ? posM.x - posN.x : posM.y - posN.y;
  float dstP = horzSpan ? posP.x - posM.x : posP.y - posM.y;
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  float spanLength = dstP + dstN;
  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLengthRcp = 1.0 / spanLength;
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = (dst * (-spanLengthRcp)) + 0.5;
  float subpixH = subpixG * SUBPIX;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign;
  if (horzSpan) posM.y += pixelOffsetSubpix * lengthSign;
  gl_FragColor = vec4(texture2D(tSrc, posM).rgb, rgbaM.a);
}
`;

export class FXAA {
  private mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = fsMaterial("fxaa", { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, FXAA_FRAG);
  }
  render(pipeline: Pipeline, src: THREE.Texture, w: number, h: number, target: THREE.WebGLRenderTarget | null) {
    this.mat.uniforms.tSrc.value = src;
    (this.mat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    pipeline.blit(this.mat, target);
  }
  dispose() {
    this.mat.dispose();
  }
}
