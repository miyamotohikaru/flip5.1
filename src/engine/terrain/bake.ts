// 地形の補助テクスチャを GPU で1回焼く（起動時、最初の描画の直前）。
//   aux（RGBA8, ハイトマップと同じ解像度）: rg = 法線 xz, b = 空の見え方（AO）, a = 谷筋の陰（cavity）
//   horizonA / horizonB（RGBA8, 1024²）: 8方位の地平の仰角 / (π/2)。太陽・月がその地点から見えるか
// 読む側は core/glsl/height.glsl.ts の flip_terrainNormalBaked / flip_terrainAO / flip_terrainSunVis。
import * as THREE from "three";
import type { Env } from "../core/env";
import { WORLD } from "../core/heightfield";
import { bindEnvUniforms } from "../core/patch";
import { FS_VERT } from "../core/pipeline";

export type TerrainBake = {
  aux: THREE.WebGLRenderTarget;
  horizonA: THREE.WebGLRenderTarget;
  horizonB: THREE.WebGLRenderTarget;
  /** 材質のノイズ場（RGBA8, 1024²）: r = マクロ, g = メソ, b = 林の密度, a = 岸線からの距離 (sd+20)/40 */
  field: THREE.WebGLRenderTarget;
};

const FIELD_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
uniform sampler2D uHeightParts;
varying vec2 vUv;
void main(){
  vec2 xz = (vUv - 0.5) * uHeightmapInfo.x;
  float macro = flip_fbm(xz * 0.0016 + 4.0, 2);
  float meso = flip_gnoise(xz * 0.028 + 9.0);
  float forest = smoothstep(-0.1, 0.45, flip_fbm(xz * 0.004 + 11.0, 3) + 0.25);
  float sd = texture2D(uHeightParts, vUv).a;
  gl_FragColor = vec4(macro * 0.5 + 0.5, meso * 0.5 + 0.5, forest, clamp((sd + 20.0) / 40.0, 0.0, 1.0));
}
`;

const AUX_FRAG = /* glsl */ `
#include <flip_height>
varying vec2 vUv;
uniform float uTexel;
void main(){
  vec2 xz = (vUv - 0.5) * uHeightmapInfo.x;
  float e = uTexel;
  float h0 = flip_height(xz);
  float hl = flip_height(xz - vec2(e, 0.0)), hr = flip_height(xz + vec2(e, 0.0));
  float hd = flip_height(xz - vec2(0.0, e)), hu = flip_height(xz + vec2(0.0, e));
  vec3 n = normalize(vec3(hl - hr, 2.0 * e, hd - hu));
  // 谷筋の陰: 3つのスケールのラプラシアン。0.5 = 平ら、小さいほど窪み
  float e2 = e * 3.0, e3 = e * 9.0;
  float lap1 = h0 - 0.25 * (hl + hr + hd + hu);
  float lap2 = h0 - 0.25 * (flip_height(xz - vec2(e2, 0.0)) + flip_height(xz + vec2(e2, 0.0)) + flip_height(xz - vec2(0.0, e2)) + flip_height(xz + vec2(0.0, e2)));
  float lap3 = h0 - 0.25 * (flip_height(xz - vec2(e3, 0.0)) + flip_height(xz + vec2(e3, 0.0)) + flip_height(xz - vec2(0.0, e3)) + flip_height(xz + vec2(0.0, e3)));
  float cav = clamp(0.5 + 0.9 * lap1 / e + 0.5 * lap2 / e2 + 0.35 * lap3 / e3, 0.0, 1.0);
  // 空の見え方: 8方位 × 12歩（〜150m）の地平角の平均。
  // 接平面（局所の傾き）より上に出ている分だけを遮蔽とする（開けた斜面は 1、谷底や崖下で小さい。
  // 傾き自体は半球光が法線で考慮するので二重に暗くしない）
  vec2 grad = vec2(hr - hl, hu - hd) / (2.0 * e);
  float occ = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    vec2 dir = vec2(cos(a), sin(a));
    float plane = dot(grad, dir);
    float ms = 0.0;
    for (int s = 1; s <= 12; s++) {
      float dist = float(s) * float(s) + 2.0;
      float hs = flip_height(xz + dir * dist);
      ms = max(ms, (hs - h0 - 0.4) / dist - plane);
    }
    occ += ms / sqrt(1.0 + ms * ms);
  }
  float ao = clamp(1.0 - occ * 0.16, 0.0, 1.0);
  gl_FragColor = vec4(n.xz * 0.5 + 0.5, ao, cav);
}
`;

const HORIZON_FRAG = /* glsl */ `
#include <flip_height>
varying vec2 vUv;
uniform float uDirBase;
float tn_h(vec2 xz){ return texture2D(uHeightmap, xz * uHeightmapInfo.y + 0.5).r; }
float horizonDir(vec2 xz, float h0, float a){
  vec2 dir = vec2(cos(a), sin(a));
  float ms = 0.0;
  float dist = 4.0;
  for (int s = 0; s < HSTEPS; s++) {
    float hs = tn_h(xz + dir * dist);
    ms = max(ms, (hs - h0) / dist);
    dist *= HGROW;
  }
  return atan(ms) * 0.63661977;
}
void main(){
  vec2 xz = (vUv - 0.5) * uHeightmapInfo.x;
  float h0 = flip_height(xz) + 1.5;
  gl_FragColor = vec4(
    horizonDir(xz, h0, uDirBase * 0.7853982),
    horizonDir(xz, h0, (uDirBase + 1.0) * 0.7853982),
    horizonDir(xz, h0, (uDirBase + 2.0) * 0.7853982),
    horizonDir(xz, h0, (uDirBase + 3.0) * 0.7853982));
}
`;

function makeTarget(res: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.MirroredRepeatWrapping,
    wrapT: THREE.MirroredRepeatWrapping,
  });
  rt.texture.name = "terrainBake";
  return rt;
}

/**
 * 補助テクスチャを焼く。描画の途中（onBeforeRender）から呼ばれてもよいように、
 * レンダーターゲットなどの状態は戻す。
 */
export function bakeTerrainAux(renderer: THREE.WebGLRenderer, env: Env, auxRes: number, horizonRes: number, steps: number, grow: number): TerrainBake {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const auxMat = new THREE.ShaderMaterial({
    uniforms: bindEnvUniforms({ uTexel: { value: WORLD.size / auxRes } }, env),
    vertexShader: FS_VERT,
    fragmentShader: AUX_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const horizonMat = new THREE.ShaderMaterial({
    uniforms: bindEnvUniforms({ uDirBase: { value: 0 } }, env),
    vertexShader: FS_VERT,
    fragmentShader: HORIZON_FRAG.replace("HSTEPS", String(steps)).replace("HGROW", grow.toFixed(4)),
    depthTest: false,
    depthWrite: false,
  });
  const fieldMat = new THREE.ShaderMaterial({
    uniforms: bindEnvUniforms({}, env),
    vertexShader: FS_VERT,
    fragmentShader: FIELD_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, auxMat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const aux = makeTarget(auxRes);
  const horizonA = makeTarget(horizonRes);
  const horizonB = makeTarget(horizonRes);
  const field = makeTarget(1024);

  const prevTarget = renderer.getRenderTarget();
  const prevShadow = renderer.shadowMap.autoUpdate;
  const prevXr = renderer.xr.enabled;
  renderer.shadowMap.autoUpdate = false;
  renderer.xr.enabled = false;
  renderer.setRenderTarget(aux);
  renderer.render(scene, cam);
  mesh.material = horizonMat;
  horizonMat.uniforms.uDirBase.value = 0;
  renderer.setRenderTarget(horizonA);
  renderer.render(scene, cam);
  horizonMat.uniforms.uDirBase.value = 4;
  renderer.setRenderTarget(horizonB);
  renderer.render(scene, cam);
  mesh.material = fieldMat;
  renderer.setRenderTarget(field);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.shadowMap.autoUpdate = prevShadow;
  renderer.xr.enabled = prevXr;

  auxMat.dispose();
  horizonMat.dispose();
  fieldMat.dispose();
  geo.dispose();
  return { aux, horizonA, horizonB, field };
}
