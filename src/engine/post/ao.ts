// アンビエントオクルージョン（GTAO: Jimenez et al. 2016 の水平線積分）。high 以上のみ。
//   - 半分解像度。深度から法線を再構成（左右上下の差分のうち小さい側を選ぶ＝縁で割れない）
//   - 2 方向 × 両側 4 歩（16 サンプル）。方向と歩幅の開始を画素ごとにずらす（IGN、時間で変えない＝ちらつかない）
//   - 深度を見るバイラテラルぼかし 2 回（水平・垂直）。G に線形深度を持ち、合成側の深度付きアップサンプルに使う
//   - 遠く（> 170m）では消える。空（深度 1.0）は 1
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, makeRT, POST_COMMON } from "./pass";

const AO_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tDepth;
uniform vec2 uFullTexel;
uniform vec2 uHalfRes;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform float uNear;
uniform float uFar;
uniform float uRadius;
uniform float uFalloffStart;
uniform float uFalloffEnd;
varying vec2 vUv;

vec3 viewPos(vec2 uv, float z){
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float depthAt(vec2 uv){ return texture2D(tDepth, uv).r; }

vec3 normalFromDepth(vec2 uv, vec3 P){
  vec2 t = uFullTexel * 2.0;
  float dl1 = depthAt(uv - vec2(t.x, 0.0)), dl2 = depthAt(uv - vec2(2.0 * t.x, 0.0));
  float dr1 = depthAt(uv + vec2(t.x, 0.0)), dr2 = depthAt(uv + vec2(2.0 * t.x, 0.0));
  float db1 = depthAt(uv - vec2(0.0, t.y)), db2 = depthAt(uv - vec2(0.0, 2.0 * t.y));
  float dt1 = depthAt(uv + vec2(0.0, t.y)), dt2 = depthAt(uv + vec2(0.0, 2.0 * t.y));
  float c0 = depthAt(uv);
  float el = abs((2.0 * dl1 - dl2) - c0), er = abs((2.0 * dr1 - dr2) - c0);
  float eb = abs((2.0 * db1 - db2) - c0), et = abs((2.0 * dt1 - dt2) - c0);
  vec3 dpdx = (el < er) ? P - viewPos(uv - vec2(t.x, 0.0), dl1) : viewPos(uv + vec2(t.x, 0.0), dr1) - P;
  vec3 dpdy = (eb < et) ? P - viewPos(uv - vec2(0.0, t.y), db1) : viewPos(uv + vec2(0.0, t.y), dt1) - P;
  return normalize(cross(dpdx, dpdy));
}

void main(){
  float z = depthAt(vUv);
  float lin = post_linearDepth(z, uNear, uFar);
  if (z >= 0.999999) { gl_FragColor = vec4(1.0, lin, 0.0, 1.0); return; }
  vec3 P = viewPos(vUv, z);
  vec3 N = normalFromDepth(vUv, P);
  vec3 V = normalize(-P);
  float dist = -P.z;
  float fade = 1.0 - smoothstep(uFalloffStart, uFalloffEnd, dist);
  if (fade <= 0.0) { gl_FragColor = vec4(1.0, lin, 0.0, 1.0); return; }

  // 画面上の半径（px、半分解像度）
  float radiusPx = uRadius * uProj[1][1] / dist * 0.5 * uHalfRes.y;
  radiusPx = clamp(radiusPx, 1.5, 48.0);
  vec2 radiusUv = radiusPx / uHalfRes;

  float noise = post_ign(gl_FragCoord.xy);
  float jitter = post_ign(gl_FragCoord.yx + vec2(17.0, 31.0));
  float visibility = 0.0;
  const int DIRS = 3;
  const int STEPS = 4;
  for (int d = 0; d < DIRS; d++) {
    float ang = (float(d) + noise) * (3.14159265 / float(DIRS));
    vec2 dir2 = vec2(cos(ang), sin(ang));
    vec3 dirV = vec3(dir2, 0.0);
    // スライス平面
    vec3 orthoDir = dirV - dot(dirV, V) * V;
    vec3 axis = normalize(cross(orthoDir, V));
    vec3 projN = N - axis * dot(N, axis);
    float projLen = length(projN);
    float sgn = sign(dot(orthoDir, projN));
    float cosN = clamp(dot(projN, V) / max(projLen, 1e-4), 0.0, 1.0);
    float n = sgn * acos(cosN);
    // 両側の水平線
    float h0 = -1.0, h1 = -1.0;
    for (int s = 0; s < STEPS; s++) {
      float f = (float(s) + 0.5 + 0.5 * jitter) / float(STEPS);
      f = f * f;
      vec2 off = dir2 * radiusUv * f;
      // 右側
      vec2 uvA = vUv + off;
      vec3 SA = viewPos(uvA, depthAt(uvA)) - P;
      float lenA = length(SA);
      float wA = 1.0 - smoothstep(uRadius * 0.7, uRadius * 1.5, lenA);
      float cA = dot(SA, V) / max(lenA, 1e-4);
      h0 = max(h0, mix(-1.0, cA, wA));
      // 左側
      vec2 uvB = vUv - off;
      vec3 SB = viewPos(uvB, depthAt(uvB)) - P;
      float lenB = length(SB);
      float wB = 1.0 - smoothstep(uRadius * 0.7, uRadius * 1.5, lenB);
      float cB = dot(SB, V) / max(lenB, 1e-4);
      h1 = max(h1, mix(-1.0, cB, wB));
    }
    float a0 = -acos(clamp(h1, -1.0, 1.0));
    float a1 = acos(clamp(h0, -1.0, 1.0));
    a0 = n + max(a0 - n, -1.5707963);
    a1 = n + min(a1 - n, 1.5707963);
    float vis = projLen * 0.25 * ((-cos(2.0 * a0 - n) + cosN + 2.0 * a0 * sin(n)) + (-cos(2.0 * a1 - n) + cosN + 2.0 * a1 * sin(n)));
    visibility += vis;
  }
  visibility = clamp(visibility / float(DIRS), 0.0, 1.0);
  float ao = mix(1.0, visibility, fade);
  gl_FragColor = vec4(ao, lin, 0.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main(){
  vec2 c = texture2D(tSrc, vUv).rg;
  float z0 = c.g;
  float sum = c.r, tw = 1.0;
  for (int i = 1; i <= 3; i++) {
    float fi = float(i);
    float gw = exp(-fi * fi * 0.28);
    vec2 a = texture2D(tSrc, vUv + uDir * fi).rg;
    vec2 b = texture2D(tSrc, vUv - uDir * fi).rg;
    float wa = gw * exp(-abs(a.g - z0) / (z0 * 0.06 + 0.05));
    float wb = gw * exp(-abs(b.g - z0) / (z0 * 0.06 + 0.05));
    sum += a.r * wa + b.r * wb;
    tw += wa + wb;
  }
  gl_FragColor = vec4(sum / tw, z0, 0.0, 1.0);
}
`;

export class AO {
  rt: THREE.WebGLRenderTarget;
  tmp: THREE.WebGLRenderTarget;
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  /** 出力（半分解像度、R = AO 0..1、G = 線形深度） */
  texture: THREE.Texture;

  constructor() {
    this.rt = makeRT(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.NearestFilter });
    this.tmp = makeRT(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.NearestFilter });
    this.aoMat = fsMaterial(
      "gtao",
      {
        tDepth: { value: null },
        uFullTexel: { value: new THREE.Vector2() },
        uHalfRes: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Matrix4() },
        uInvProj: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 },
        uFar: { value: 9000 },
        // 半径 1.5m。株の根元・幹の接地の「濃い影」を作るのに 0.6m 以上が要る（批評ラウンド1）
        uRadius: { value: 1.5 },
        // 遠くの木の接地まで残す（30〜60m だと中景の幹が浮く）
        uFalloffStart: { value: 70 },
        uFalloffEnd: { value: 170 },
      },
      AO_FRAG,
    );
    this.blurMat = fsMaterial("gtao_blur", { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }, BLUR_FRAG);
    this.texture = this.rt.texture;
  }

  resize(w: number, h: number) {
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    this.rt.setSize(hw, hh);
    this.tmp.setSize(hw, hh);
  }

  render(pipeline: Pipeline, depth: THREE.Texture, fullW: number, fullH: number, camera: THREE.PerspectiveCamera) {
    const am = this.aoMat, bm = this.blurMat;
    am.uniforms.tDepth.value = depth;
    (am.uniforms.uFullTexel.value as THREE.Vector2).set(1 / fullW, 1 / fullH);
    (am.uniforms.uHalfRes.value as THREE.Vector2).set(this.rt.width, this.rt.height);
    (am.uniforms.uProj.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (am.uniforms.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    am.uniforms.uNear.value = camera.near;
    am.uniforms.uFar.value = camera.far;
    pipeline.blit(am, this.tmp);
    bm.uniforms.tSrc.value = this.tmp.texture;
    (bm.uniforms.uDir.value as THREE.Vector2).set(1 / this.rt.width, 0);
    pipeline.blit(bm, this.rt);
    bm.uniforms.tSrc.value = this.rt.texture;
    (bm.uniforms.uDir.value as THREE.Vector2).set(0, 1 / this.rt.height);
    pipeline.blit(bm, this.tmp);
    this.texture = this.tmp.texture;
  }

  dispose() {
    this.rt.dispose();
    this.tmp.dispose();
    this.aoMat.dispose();
    this.blurMat.dispose();
  }
}
