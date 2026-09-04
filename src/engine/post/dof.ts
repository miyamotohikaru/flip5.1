// 被写界深度。薄いレンズの錯乱円（CoC）を深度から出し、半分解像度で円形ディスクの集約ぼかし。
//   - 一人称では絞る（f/2.8 相当）。近くを見たときだけ背景が柔らかくなる。写真モードでは f/1.6
//   - 集約（scatter-as-gather）: 各サンプルは「自分の CoC が今の画素まで届く」ときだけ寄与する
//     → ピントの合った前景が背景のぼけに滲まない
//   - 合成側で CoC（フル解像度の深度から）で鮮明な絵とぼけた絵を混ぜる
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, makeRT, POST_COMMON } from "./pass";

/** CoC（px）をレンズの物理から出す共通 GLSL。uDof = (焦点距離 m, 有効口径 m, センサ高 m, 出力の高さ px) */
export const DOF_COC = /* glsl */ `
uniform vec4 uDof;
uniform float uFocus;
uniform float uCocMax;
float dof_coc(float dist){
  float f = uDof.x, A = uDof.y;
  float s = max(uFocus, f * 1.5);
  float c = A * f * abs(dist - s) / (max(dist, 0.05) * (s - f));
  return min(c / uDof.z * uDof.w, uCocMax);
}
`;

const PREPARE_FRAG = /* glsl */ `
${POST_COMMON}
${DOF_COC}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uFullTexel;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
void main(){
  // 2x2 の平均色と、その中で最も大きい CoC（縁が欠けないように）
  vec2 o = uFullTexel * 0.5;
  vec3 c = texture2D(tScene, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tScene, vUv + vec2(o.x, -o.y)).rgb
         + texture2D(tScene, vUv + vec2(-o.x, o.y)).rgb + texture2D(tScene, vUv + vec2(o.x, o.y)).rgb;
  c *= 0.25;
  float z0 = texture2D(tDepth, vUv + vec2(-o.x, -o.y)).r, z1 = texture2D(tDepth, vUv + vec2(o.x, -o.y)).r;
  float z2 = texture2D(tDepth, vUv + vec2(-o.x, o.y)).r, z3 = texture2D(tDepth, vUv + vec2(o.x, o.y)).r;
  float coc = max(max(dof_coc(post_linearDepth(z0, uNear, uFar)), dof_coc(post_linearDepth(z1, uNear, uFar))),
                  max(dof_coc(post_linearDepth(z2, uNear, uFar)), dof_coc(post_linearDepth(z3, uNear, uFar))));
  gl_FragColor = vec4(min(c, vec3(32.0)), coc);
}
`;

const GATHER_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec4 center = texture2D(tSrc, vUv);
  float coc = center.a;
  if (coc < 0.5) { gl_FragColor = center; return; }
  float r = coc * 0.5; // 半分解像度での半径（px）
  float rot = post_ign(gl_FragCoord.xy) * 6.2831853;
  float cs = cos(rot), sn = sin(rot);
  vec3 sum = center.rgb;
  float tw = 1.0;
  const int N = 28;
  for (int i = 0; i < N; i++) {
    float fi = float(i) + 0.5;
    float rad = sqrt(fi / float(N));
    float a = fi * 2.3999632;
    vec2 p = vec2(cos(a), sin(a)) * rad;
    p = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
    vec2 uv = vUv + p * r * uTexel;
    vec4 s = texture2D(tSrc, uv);
    float distPx = rad * r;
    // サンプル自身の CoC がこの画素まで届くか
    float w = clamp((s.a * 0.5 - distPx + 1.0) / 2.0, 0.0, 1.0);
    // 前景（CoC 大）が背景へ滲みすぎないよう、中心より大きい CoC は抑える
    w *= clamp((coc + 2.0) / max(s.a, 1e-3), 0.0, 1.0);
    sum += s.rgb * w;
    tw += w;
  }
  gl_FragColor = vec4(sum / tw, coc);
}
`;

export class DoF {
  prep: THREE.WebGLRenderTarget;
  blur: THREE.WebGLRenderTarget;
  private prepMat: THREE.ShaderMaterial;
  private gatherMat: THREE.ShaderMaterial;
  /** 出力（半分解像度、rgb = ぼけた色, a = CoC px） */
  texture: THREE.Texture;
  /** 最後に描いた焦点距離とレンズ */
  cocMax = 14;

  constructor() {
    this.prep = makeRT(1, 1, { type: THREE.HalfFloatType });
    this.blur = makeRT(1, 1, { type: THREE.HalfFloatType });
    this.prepMat = fsMaterial(
      "dof_prepare",
      {
        tScene: { value: null },
        tDepth: { value: null },
        uFullTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 9000 },
        uDof: { value: new THREE.Vector4(0.02, 0.007, 0.024, 900) },
        uFocus: { value: 5 },
        uCocMax: { value: 14 },
      },
      PREPARE_FRAG,
    );
    this.gatherMat = fsMaterial("dof_gather", { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, GATHER_FRAG);
    this.texture = this.blur.texture;
  }

  resize(w: number, h: number) {
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    this.prep.setSize(hw, hh);
    this.blur.setSize(hw, hh);
  }

  render(pipeline: Pipeline, scene: THREE.Texture, depth: THREE.Texture, fullW: number, fullH: number, camera: THREE.PerspectiveCamera, lens: THREE.Vector4, focus: number) {
    const pm = this.prepMat, gm = this.gatherMat;
    pm.uniforms.tScene.value = scene;
    pm.uniforms.tDepth.value = depth;
    (pm.uniforms.uFullTexel.value as THREE.Vector2).set(1 / fullW, 1 / fullH);
    pm.uniforms.uNear.value = camera.near;
    pm.uniforms.uFar.value = camera.far;
    (pm.uniforms.uDof.value as THREE.Vector4).copy(lens);
    pm.uniforms.uFocus.value = focus;
    pm.uniforms.uCocMax.value = this.cocMax;
    pipeline.blit(pm, this.prep);
    gm.uniforms.tSrc.value = this.prep.texture;
    (gm.uniforms.uTexel.value as THREE.Vector2).set(1 / this.prep.width, 1 / this.prep.height);
    pipeline.blit(gm, this.blur);
    this.texture = this.blur.texture;
  }

  dispose() {
    this.prep.dispose();
    this.blur.dispose();
    this.prepMat.dispose();
    this.gatherMat.dispose();
  }
}
