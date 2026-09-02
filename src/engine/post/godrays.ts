// ゴッドレイ（光芒）。画面空間の放射ブラー（GPU Gems 3 "Volumetric Light Scattering"）。
//   1. 遮蔽マスク: 空（深度 1.0）だけを、太陽への角度と空の明るさ（雲で暗くなる）で重み付け → 1/4 解像度
//   2. 放射ブラー 3 回（各 8 タップ、歩幅を 1/64 → 1/8 → 1 と広げる。実効 512 サンプル）。
//      画素ごとに開始位置をずらす（IGN）ので縞が出ない
//   太陽が画面外でも、画面内の「太陽に近い空」が筋になって残る。
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, makeRT, POST_COMMON } from "./pass";

const MASK_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uCone;
varying vec2 vUv;
void main(){
  float z = texture2D(tDepth, vUv).r;
  float sky = step(0.999999, z);
  vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w - uCamPos);
  float sd = max(dot(dir, uSunDir), 0.0);
  float ang = pow(sd, uCone);
  vec3 c = texture2D(tScene, vUv).rgb;
  float lum = post_luma(c);
  lum = lum / (0.6 + lum);
  gl_FragColor = vec4(sky * ang * lum, 0.0, 0.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tSrc;
uniform vec2 uSun;
uniform float uStep;
uniform float uDecay;
varying vec2 vUv;
void main(){
  vec2 d = (uSun - vUv) * uStep;
  vec2 uv = vUv + d * post_ign(gl_FragCoord.xy);
  float sum = 0.0, w = 1.0, tw = 0.0;
  for (int i = 0; i < 8; i++) {
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    sum += texture2D(tSrc, uv).r * w * inside;
    tw += w;
    uv += d;
    w *= uDecay;
  }
  gl_FragColor = vec4(sum / tw, 0.0, 0.0, 1.0);
}
`;

export class GodRays {
  mask: THREE.WebGLRenderTarget;
  ping: THREE.WebGLRenderTarget;
  pong: THREE.WebGLRenderTarget;
  private maskMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  /** 出力（1/4 解像度、R = 光芒の強さ 0..1） */
  texture: THREE.Texture;

  constructor() {
    this.mask = makeRT(1, 1, { type: THREE.HalfFloatType });
    this.ping = makeRT(1, 1, { type: THREE.HalfFloatType });
    this.pong = makeRT(1, 1, { type: THREE.HalfFloatType });
    this.maskMat = fsMaterial(
      "godray_mask",
      {
        tScene: { value: null },
        tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uCone: { value: 14 },
      },
      MASK_FRAG,
    );
    this.blurMat = fsMaterial(
      "godray_blur",
      { tSrc: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uStep: { value: 0.1 }, uDecay: { value: 0.95 } },
      BLUR_FRAG,
    );
    this.texture = this.ping.texture;
  }

  resize(w: number, h: number) {
    const qw = Math.max(1, Math.floor(w / 4)), qh = Math.max(1, Math.floor(h / 4));
    this.mask.setSize(qw, qh);
    this.ping.setSize(qw, qh);
    this.pong.setSize(qw, qh);
  }

  render(
    pipeline: Pipeline,
    scene: THREE.Texture,
    depth: THREE.Texture,
    invViewProj: THREE.Matrix4,
    camPos: THREE.Vector3,
    sunDir: THREE.Vector3,
    sunScreen: THREE.Vector2,
  ) {
    const mm = this.maskMat, bm = this.blurMat;
    mm.uniforms.tScene.value = scene;
    mm.uniforms.tDepth.value = depth;
    (mm.uniforms.uInvViewProj.value as THREE.Matrix4).copy(invViewProj);
    (mm.uniforms.uCamPos.value as THREE.Vector3).copy(camPos);
    (mm.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    pipeline.blit(mm, this.mask);
    (bm.uniforms.uSun.value as THREE.Vector2).copy(sunScreen);
    // 歩幅: 1/512 → 1/64 → 1/8（各 8 タップ）。太陽までの距離の 0.85 まで届く
    const reach = 0.85;
    const steps = [reach / 512, reach / 64, reach / 8];
    const decays = [1.0, 0.98, 0.9];
    let src: THREE.Texture = this.mask.texture;
    let dst = this.ping, other = this.pong;
    for (let i = 0; i < 3; i++) {
      bm.uniforms.tSrc.value = src;
      bm.uniforms.uStep.value = steps[i];
      bm.uniforms.uDecay.value = decays[i];
      pipeline.blit(bm, dst);
      src = dst.texture;
      const t = dst;
      dst = other;
      other = t;
    }
    this.texture = src;
  }

  dispose() {
    this.mask.dispose();
    this.ping.dispose();
    this.pong.dispose();
    this.maskMat.dispose();
    this.blurMat.dispose();
  }
}
