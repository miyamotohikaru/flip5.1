// 雨。カメラ周りの箱に世界固定でばら撒いた筋（3層: 近＝太く速く、遠＝霧のように薄い）と、地面への着弾のしぶき。
// 位置は全てハッシュ（決定的）。風と突風で斜めになり、嵐では横殴り・密度2倍。
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { hash2 } from "../core/noise";
import { WX_COMMON, WX_QUAD_ATTR, WX_FLIP_VS } from "./glsl";
import type { Weather } from "./index";

/** インスタンス化した板（x∈[-0.5,0.5], y∈[0,1]）。aSeed = 4つのハッシュ、aIndex = 通し番号 */
export function makeQuadInstances(count: number, seed: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  const idx = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = hash2(i, seed);
    seeds[i * 4 + 1] = hash2(i, seed + 1);
    seeds[i * 4 + 2] = hash2(i, seed + 2);
    seeds[i * 4 + 3] = hash2(i, seed + 3);
    idx[i] = i;
  }
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  geo.setAttribute("aIndex", new THREE.InstancedBufferAttribute(idx, 1));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

const RAIN_VERT = /* glsl */ `
#include <flip_noise>
${WX_FLIP_VS}
${WX_COMMON}
${WX_QUAD_ATTR}
uniform vec3 uCamPos;
uniform vec3 uWind;
uniform float uStorm;
uniform float uGust;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
void main(){
  float layer = aSeed.w < 0.5 ? 0.0 : (aSeed.w < 0.8 ? 1.0 : 2.0);
  float box = layer == 0.0 ? 6.0 : (layer == 1.0 ? 18.0 : 45.0);
  // 風で斜めに。突風で揺れ、嵐では横殴り
  float wsp = uWind.z * (0.45 + 0.9 * uGust) * (1.0 + 0.9 * uStorm);
  float fall = 7.5 + 2.5 * aSeed.x;
  vec3 vel = vec3(uWind.x * wsp, -fall, uWind.y * wsp);
  vec3 fwd = wx_camFwd(viewMatrix);
  vec3 boxC = uCamPos + vec3(fwd.x, 0.0, fwd.z) * box * 0.3 + vec3(0.0, box * 0.12, 0.0);
  vec3 p = aSeed.xyz * box + vel * uTime;
  vec3 rel = mod(p - boxC, vec3(box)) - 0.5 * box;
  vec3 center = boxC + rel;
  vec3 toCam = center - uCamPos;
  float dist = length(toCam);
  vec3 vdir = toCam / max(dist, 1e-4);
  float speed = length(vel);
  vec3 a = vel / speed;
  // 動体ぶれの長さ（露光 ~30ms）。遠い層は細長く
  float len = speed * (0.04 + 0.014 * layer) * (0.75 + 0.5 * aSeed.y);
  vec3 side = normalize(cross(a, vdir));
  float px = dist * uWxPixel;
  float dropW = 0.0025 + 0.0015 * layer;
  // ごく近くはピントが合わず太くぼやける
  float defocus = 1.0 + 3.0 * (1.0 - smoothstep(0.3, 1.6, dist));
  float w = max(dropW * defocus, px * 1.3);
  vec3 pos = center + a * (position.y - 0.5) * len + side * position.x * w;
  float alpha = (0.8 - 0.2 * layer) * clamp(dropW / w, 0.45, 1.0) * (0.55 + 0.45 * aSeed.z);
  alpha *= smoothstep(0.1, 0.4, dist);
  vec3 e = abs(rel) / box;
  float edge = (1.0 - smoothstep(0.32, 0.5, e.x)) * (1.0 - smoothstep(0.32, 0.5, e.y)) * (1.0 - smoothstep(0.32, 0.5, e.z));
  alpha *= edge;
  vFm = wx_flipMask(center);
  if (vFm > 0.001) {
    // 数式ビュー: 落下の直線（速度ベクトルの向きに長く）
    vec3 mpos = center + a * (position.y - 0.5) * len * 3.0 + side * position.x * max(dropW, px * 1.6);
    pos = mix(pos, mpos, vFm);
  }
  vQ = position.xy;
  vAlpha = alpha;
  vWorld = center;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const RAIN_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uLightning;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
void main(){
  float x = vQ.x * 2.0;
  float across = exp(-x * x * 3.0);
  float along = smoothstep(0.0, 0.3, vQ.y) * (1.0 - smoothstep(0.7, 1.0, vQ.y));
  // 筋の途中に明るい粒（雨粒本体のきらめき）
  float glint = exp(-pow((vQ.y - 0.55) * 6.0, 2.0)) * 0.6;
  float shape = across * (along * 0.75 + glint);
  vec3 vdir = normalize(vWorld - uCamPos);
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  // 雨粒は周りの光を屈折して運ぶ: 半球光＋逆光で明るく
  vec3 col = uSkyAmbient * 0.85 + uGroundAmbient * 0.3;
  col += uSunColor * wx_phaseHG(dot(vdir, uSunDir), 0.75) * 0.35 * sunUp;
  col += uMoonColor * wx_phaseHG(dot(vdir, uMoonDir), 0.7) * 0.6;
  col += vec3(0.8, 0.85, 1.0) * uLightning * 0.9;
  vec4 aer = flip_aerial(vWorld);
  float dist = distance(uCamPos, vWorld);
  float alpha = vAlpha * shape * aer.a * exp(-wx_fogOD(uCamPos, vWorld) - wx_veilOD(dist));
  // 数式ビュー: 細い直線
  float mshape = exp(-x * x * 8.0) * smoothstep(0.0, 0.04, vQ.y) * (1.0 - smoothstep(0.96, 1.0, vQ.y));
  col = mix(col, FLIP_LINE, vFm);
  alpha = mix(alpha, mshape * 0.85 * vAlpha, vFm);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

const SPLASH_VERT = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WX_FLIP_VS}
${WX_COMMON}
${WX_QUAD_ATTR}
uniform vec3 uCamPos;
uniform float uRain;
uniform float uSplashGrid;
varying vec2 vQ;
varying float vLife;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying float vOnWater;
void main(){
  float k = uSplashGrid;
  float cs = 13.0 / k;
  float ix = mod(aIndex, k), iz = floor(aIndex / k);
  vec2 camCell = floor(uCamPos.xz / cs);
  vec2 cell = camCell + vec2(ix, iz) - 0.5 * k;
  float period = 0.32 + 0.4 * aSeed.x;
  float ph = uTime / period + aSeed.y;
  float cycle = floor(ph);
  float life = fract(ph);
  vec2 jit = flip_hash22(cell * 1.37 + cycle * 7.13 + aSeed.zw);
  vec2 xz = (cell + jit) * cs;
  float th = flip_height(xz);
  float onWater = step(th, uWxLake + 0.04);
  float y = max(th, uWxLake) + 0.03;
  vec3 center = vec3(xz.x, y, xz.y);
  float dens = uRain * (1.0 - 0.55 * onWater);
  float on = step(flip_hash12(cell + cycle * 3.7), dens);
  float dist = distance(center, uCamPos);
  float size = (0.06 + 0.05 * aSeed.z) * (0.45 + 0.55 * life);
  float px = dist * uWxPixel;
  size = max(size, px * 4.0);
  // 立てた板（Y 軸回りだけカメラを向く）
  vec2 f2 = normalize(uCamPos.xz - center.xz + vec2(1e-4, 0.0));
  vec3 side = vec3(-f2.y, 0.0, f2.x);
  vec3 pos = center + side * position.x * size * 1.6 + vec3(0.0, position.y * size, 0.0);
  float alpha = on * (1.0 - smoothstep(4.5, 6.5, dist)) * smoothstep(0.25, 0.8, dist) * (1.0 - life * life);
  vQ = position.xy;
  vLife = life;
  vAlpha = alpha;
  vWorld = center;
  vFm = wx_flipMask(center);
  vOnWater = onWater;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const SPLASH_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uLightning;
varying vec2 vQ;
varying float vLife;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying float vOnWater;
float segDist(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
void main(){
  vec2 q = vec2(vQ.x * 1.6, vQ.y);
  float t = vLife;
  float r = 0.18 + 0.5 * t;
  float h = sin(t * 3.1416) * 0.6;
  // 王冠: 手前半周の楕円の環 ＋ 5本の短い水柱と先端の玉
  vec2 e = vec2(q.x / r, (q.y - 0.04) / (r * 0.28));
  float ring = exp(-pow(abs(length(e) - 1.0) * 5.0, 2.0)) * step(q.y, 0.04 + r * 0.28);
  float spikes = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ang = (fi + 0.5) / 5.0 * 3.1416;
    float hh = h * (0.55 + 0.45 * flip_hash11(fi * 3.1 + floor(vWorld.x * 13.0) + floor(vWorld.z * 7.0)));
    vec2 base = vec2(cos(ang) * r, 0.04 - sin(ang) * r * 0.28 * 0.5);
    vec2 tip = vec2(cos(ang) * r * (1.0 + 0.35 * t), base.y + hh);
    float d = segDist(q, base, tip);
    spikes += exp(-d * d * 900.0) * 0.7;
    spikes += exp(-dot(q - tip, q - tip) * 1800.0);
  }
  float shape = clamp(ring * 0.8 + spikes, 0.0, 1.0);
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  // 水しぶきは空を映して白く光る（濡れた暗い地面の上で目立つ）
  vec3 col = uSkyAmbient * 1.5 + uGroundAmbient * 0.25 + vec3(0.22) + uSunColor * 0.08 * sunUp + vec3(0.8, 0.85, 1.0) * uLightning;
  float soft = wx_soft(gl_FragCoord.xy, gl_FragCoord.z, 0.05);
  vec4 aer = flip_aerial(vWorld);
  float alpha = vAlpha * shape * soft * aer.a * 0.9;
  // 数式ビュー: 着弾点（座標の点）
  float dotc = 1.0 - smoothstep(0.0, 0.12, length(vec2(q.x, q.y - 0.1)));
  col = mix(col, FLIP_LINE, vFm);
  alpha = mix(alpha, dotc * vAlpha * soft, vFm);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export class Rain {
  streaks: THREE.Mesh;
  splashes: THREE.Mesh;
  streakMat: THREE.ShaderMaterial;
  splashMat: THREE.ShaderMaterial;
  private streakGeo: THREE.InstancedBufferGeometry;
  private splashGeo: THREE.InstancedBufferGeometry;
  private maxStreaks: number;
  private maxSplashes: number;

  constructor(public w: Weather) {
    const c = w.counts;
    this.maxStreaks = c.rain;
    this.maxSplashes = c.splash;
    this.streakGeo = makeQuadInstances(this.maxStreaks, 101);
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: w.bind({}),
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    });
    this.streaks = new THREE.Mesh(this.streakGeo, this.streakMat);
    this.streaks.frustumCulled = false;
    this.streaks.layers.set(LAYER.TRANSPARENT);
    this.streaks.renderOrder = 60;
    this.streaks.castShadow = false;
    this.streaks.name = "weather.rain";
    w.group.add(this.streaks);

    const grid = Math.ceil(Math.sqrt(this.maxSplashes));
    this.splashGeo = makeQuadInstances(grid * grid, 211);
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ uSplashGrid: { value: grid } }),
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    });
    this.splashes = new THREE.Mesh(this.splashGeo, this.splashMat);
    this.splashes.frustumCulled = false;
    this.splashes.layers.set(LAYER.TRANSPARENT);
    this.splashes.renderOrder = 70;
    this.splashes.castShadow = false;
    this.splashes.name = "weather.splash";
    w.group.add(this.splashes);
  }

  update() {
    const wt = this.w.env.weather;
    // 密度: 雨で約6割、嵐で全部（横殴り＋密度2倍弱）
    const density = Math.min(1, wt.rain * (0.75 + 0.45 * wt.storm));
    const n = Math.floor(this.maxStreaks * density);
    this.streaks.visible = n > 8;
    this.streakGeo.instanceCount = Math.max(n, 1);
    this.splashes.visible = wt.rain > 0.03;
  }
}
