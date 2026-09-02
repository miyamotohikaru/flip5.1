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
  float layer = aSeed.w < 0.55 ? 0.0 : (aSeed.w < 0.88 ? 1.0 : 2.0);
  // 筋が見えるのはカメラのすぐ周りだけ。遠くの雨は fog.ts の「雨のヴェール」が受け持つ
  float box = layer == 0.0 ? 5.5 : (layer == 1.0 ? 10.0 : 16.0);
  // 風で斜めに。突風で揺れ、嵐では横殴り。ただし 45°を超えると「ワープの速度線」に見えるので抑える
  float wsp = uWind.z * (0.34 + 0.40 * uGust) * (1.0 + 0.45 * uStorm);
  float fall = 8.5 + 3.0 * aSeed.x;
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
  // 動体ぶれの長さ（露光 ~15ms）。長いと「引っかき傷」になるので短く
  float len = min(speed * (0.020 + 0.007 * layer), 0.22 + 0.12 * layer) * (0.75 + 0.5 * aSeed.y);
  vec3 side = normalize(cross(a, vdir));
  float px = dist * uWxPixel;
  float dropW = 0.0025 + 0.0015 * layer;
  // ごく近くはピントが合わず太くぼやける
  float defocus = 1.0 + 3.0 * (1.0 - smoothstep(0.3, 1.6, dist));
  float w = max(dropW * defocus, px * 1.3);
  vec3 pos = center + a * (position.y - 0.5) * len + side * position.x * w;
  // 粒の大きさのばらつき: ほとんどは薄く、たまに近くの大粒が明るく光る
  float bright = 0.35 + 0.95 * aSeed.z * aSeed.z;
  float alpha = (0.36 - 0.11 * layer) * clamp(dropW / w, 0.25, 1.0) * bright;
  // レンズのすぐ前の雨粒はピントが外れて大きくぼやける＝ほとんど見えない（長い白線にしない）
  alpha *= smoothstep(0.25, 1.4, dist);
  // 6m を過ぎたら薄れ、12m で消える（遠くまで同じ濃さだと消失点へ集まる白線＝ワープに見える）
  alpha *= 1.0 - smoothstep(6.0, 12.0, dist);
  // 目線より高い筋は近くだけ（空を背景に長い白線が散らないように）
  float above = max(center.y - uCamPos.y, 0.0);
  alpha *= 1.0 - smoothstep(3.0, 6.5, dist) * smoothstep(0.4, 2.2, above);
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
uniform vec3 uLightningPos;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
void main(){
  float x = vQ.x * 2.0;
  float across = exp(-x * x * 3.0);
  float along = smoothstep(0.0, 0.3, vQ.y) * (1.0 - smoothstep(0.7, 1.0, vQ.y));
  // 筋の途中に明るい粒（雨粒本体のきらめき）
  float glint = exp(-pow((vQ.y - 0.55) * 6.0, 2.0)) * 0.30;
  float shape = across * (along * 0.75 + glint);
  vec3 vdir = normalize(vWorld - uCamPos);
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  // 雨粒は周りの光を屈折して運ぶ: その向きの空の色（曇り・嵐では雲を透けた光）＋地面の照り返し。
  // 背景の空より明るくしすぎると、暗い嵐の中で白い引っかき傷になる
  vec3 skyH = flip_skyColor(normalize(vec3(vdir.x, max(vdir.y, 0.06), vdir.z)));
  vec3 lit = mix(skyH, uSkyAmbient * 0.64, smoothstep(0.35, 1.0, uCloud));
  vec3 col = lit * 1.15 + uGroundAmbient * 0.12 + vec3(0.004);
  col += uSunColor * wx_phaseHG(dot(vdir, uSunDir), 0.75) * 0.35 * sunUp;
  col += uMoonColor * wx_phaseHG(dot(vdir, uMoonDir), 0.7) * 0.6;
  // 稲光は近い雨粒ほど強く照らす（雨のカーテン全体が白飛びしないよう控えめに）
  float dl = distance(vWorld, uLightningPos + vec3(0.0, uWxCloudBase * 0.4, 0.0));
  col += vec3(0.8, 0.85, 1.0) * uLightning * 0.12 / (1.0 + dl * dl / (500.0 * 500.0));
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
void main(){
  float k = uSplashGrid;
  float cs = 13.0 / k;
  float ix = mod(aIndex, k), iz = floor(aIndex / k);
  vec2 camCell = floor(uCamPos.xz / cs);
  vec2 cell = camCell + vec2(ix, iz) - 0.5 * k;
  float period = 0.30 + 0.36 * aSeed.x;
  float ph = uTime / period + aSeed.y;
  float cycle = floor(ph);
  float life = fract(ph);
  vec2 jit = flip_hash22(cell * 1.37 + cycle * 7.13 + aSeed.zw);
  vec2 xz = (cell + jit) * cs;
  float th = flip_height(xz);
  // 水面の着弾は水担当の法線リングが描く（重ねると白い粒になる）ので、ここは陸だけ
  float onLand = step(uWxLake + 0.06, th);
  vec3 center = vec3(xz.x, th + 0.015, xz.y);
  float on = onLand * step(flip_hash12(cell + cycle * 3.7), uRain);
  float dist = distance(center, uCamPos);
  float px = dist * uWxPixel;
  // 地面に寝かせた円板。輪は rMax まで広がる（雨粒の着弾の輪は 3〜7cm）
  float rMax = 0.03 + 0.04 * aSeed.z;
  float size = max(rMax * 2.4, px * 3.0);
  vec3 pos = center + vec3(position.x, 0.0, position.y - 0.5) * size * 2.0;
  float alpha = on * (1.0 - smoothstep(4.0, 6.2, dist)) * smoothstep(0.25, 0.8, dist);
  vQ = position.xy;
  vLife = life;
  vAlpha = alpha;
  vWorld = center;
  vFm = wx_flipMask(center);
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
void main(){
  // 地面に寝かせた円板。q は板の -1..1、rq は「輪の最大半径」を 1 とした半径
  vec2 q = vec2(vQ.x, vQ.y - 0.5) * 2.0;
  float rq = length(q) * 1.2;
  float t = vLife;
  // 広がる細い輪（1px 幅）。広がるほど薄くなって消える
  float aa = max(fwidth(rq) * 1.1, 0.035);
  float e = (rq - t) / aa;
  float ring = exp(-e * e) * (1.0 - t) * (1.0 - t);
  // 着弾の暗点（濡れて暗くなった一点）。輪より内側で、輪より先に消える
  float dark = (1.0 - smoothstep(0.0, 0.12 + 0.5 * t, rq)) * (1.0 - smoothstep(0.25, 0.75, t));
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  // 輪は空を映して明るい／暗点は濡れた地面そのもの
  vec3 bright = uSkyAmbient * 0.70 + uGroundAmbient * 0.12 + uSunColor * 0.05 * sunUp + vec3(0.8, 0.85, 1.0) * uLightning * 0.3;
  vec3 darkCol = uGroundAmbient * 0.08;
  float soft = wx_soft(gl_FragCoord.xy, gl_FragCoord.z, 0.05);
  vec4 aer = flip_aerial(vWorld);
  float base = vAlpha * soft * aer.a;
  float aR = base * ring * 0.30;
  float aD = base * dark * 0.22;
  float alpha = clamp(aR + aD, 0.0, 1.0);
  vec3 col = (bright * aR + darkCol * aD) / max(aR + aD, 1e-5);
  // 数式ビュー: 着弾点（座標の点）
  float dotc = 1.0 - smoothstep(0.0, 0.12, rq);
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
