// 雨。カメラ周りの箱に世界固定でばら撒いた筋（3層: 近＝太く速く、遠＝霧のように薄い）と、地面への着弾のしぶき。
// 位置は全てハッシュ（決定的）。風と突風で斜めになり、嵐では横殴り・密度2倍。
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { hash2 } from "../core/noise";
import { WX_COMMON, WX_QUAD_ATTR, WX_FLIP_VS } from "./glsl";
import { Ripples } from "./ripples";
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
  float layer = aSeed.w < 0.34 ? 0.0 : (aSeed.w < 0.68 ? 1.0 : 2.0);
  // 3 層の入れ子の箱。近いほど密で、40m の外は fog.ts の「雨のヴェール」が受け持つ
  float box = layer == 0.0 ? 4.0 : (layer == 1.0 ? 12.0 : 30.0);
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
  // 距離の重み。近景 1.0 → 25m で 0.5 → 50m で 0.33。長さも濃さもこれで落とす＝「奥行きのある雨」
  float near = 1.0 / (1.0 + dist / 25.0);
  // 長さは距離にもっと敏感に（遠くの筋が長いと「引っかき傷」に見える）
  float near2 = 1.0 / (1.0 + dist / 12.0);
  // 動体ぶれの長さ（露光 ~15ms）。長いと「引っかき傷」になるので短く。遠いほど短い
  float len = min(speed * (0.020 + 0.007 * layer), 0.22 + 0.12 * layer) * (0.75 + 0.5 * aSeed.y) * (0.25 + 0.75 * near2);
  vec3 side = normalize(cross(a, vdir));
  float px = dist * uWxPixel;
  float dropW = 0.0025 + 0.0015 * layer;
  // ごく近くはピントが合わず太くぼやける
  float defocus = 1.0 + 3.0 * (1.0 - smoothstep(0.3, 1.6, dist));
  float w = max(dropW * defocus, px * 1.3);
  vec3 pos = center + a * (position.y - 0.5) * len + side * position.x * w;
  // 粒の大きさのばらつき: ほとんどは薄く、たまに近くの大粒が明るく光る
  float bright = 0.35 + 0.95 * aSeed.z * aSeed.z;
  float alpha = (0.26 - 0.06 * layer) * clamp(dropW / w, 0.25, 1.0) * bright;
  // レンズのすぐ前の雨粒はピントが外れて大きくぼやける＝ほとんど見えない（長い白線にしない）
  alpha *= smoothstep(0.25, 1.4, dist);
  // 距離で薄くなる（同じ濃さのまま遠くまで届くと、消失点へ集まる白線＝ワープに見える）。
  // 40m でヴェールに引き継ぐ
  alpha *= near * near * (1.0 - smoothstep(24.0, 36.0, dist));
  // 目線より高い筋は近くだけ（空を背景に長い白線が散らないように）
  float above = max(center.y - uCamPos.y, 0.0);
  alpha *= 1.0 - smoothstep(4.0, 9.0, dist) * smoothstep(0.6, 3.0, above);
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
  vec3 col = lit * 1.35 + uGroundAmbient * 0.12 + vec3(0.004);
  col += uSunColor * wx_phaseHG(dot(vdir, uSunDir), 0.75) * 0.35 * sunUp;
  col += uMoonColor * wx_phaseHG(dot(vdir, uMoonDir), 0.7) * 0.6;
  // 稲光は近い雨粒ほど強く照らす（雨のカーテン全体が白飛びしないよう控えめに）
  float dl = distance(vWorld, uLightningPos + vec3(0.0, uWxCloudBase * 0.4, 0.0));
  col += vec3(0.94, 0.96, 1.0) * uLightning * 0.12 / (1.0 + dl * dl / (500.0 * 500.0));
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
/** x = 一辺（m）。y は「陸か水か」だったが、水面の波紋は ripples.ts の画素シェーダへ移したので常に 0 */
uniform vec2 uSplashMode;
varying vec2 vQ;
varying float vLife;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying float vOnLand;
void main(){
  float k = uSplashGrid;
  // 陸のしぶきは足元 13m 四方、水面の波紋は 60m 四方（湖は遠いので広く薄く撒く）
  float cs = uSplashMode.x / k;
  float ix = mod(aIndex, k), iz = floor(aIndex / k);
  vec2 camCell = floor(uCamPos.xz / cs);
  vec2 cell = camCell + vec2(ix, iz) - 0.5 * k;
  // 水面の波紋は陸の着弾より長く残る
  float period = 0.30 + 0.36 * aSeed.x;
  float ph = uTime / period + aSeed.y;
  float cycle = floor(ph);
  float life = fract(ph);
  vec2 jit = flip_hash22(cell * 1.37 + cycle * 7.13 + aSeed.zw);
  vec2 xz = (cell + jit) * cs;
  float th = flip_height(xz);
  // 陸は「濡れの染み＋着弾の閃き」、水は「広がる波紋の輪」（別々のメッシュで撒く）
  float water = uSplashMode.y;
  float onLand = step(uWxLake + 0.06, th) * (1.0 - water);
  float onWater = step(th, uWxLake - 0.05) * water;
  float y = mix(th + 0.015, uWxLake + 0.006, water);
  vec3 center = vec3(xz.x, y, xz.y);
  // 一度に光る数を減らす（画面いっぱいの輪は「シャボン玉」に見える）
  float on = (onLand + onWater) * step(flip_hash12(cell + cycle * 3.7), uRain * 0.85);
  float dist = distance(center, uCamPos);
  float px = dist * uWxPixel;
  // 寝かせた円板。陸の着弾の輪は実寸 1〜3cm、水面の波紋は 12〜30cm まで広がる
  float rMax = mix(0.010 + 0.013 * aSeed.z, 0.07 + 0.13 * aSeed.z, water);
  float size = max(rMax * 2.2, px * 2.2);
  vec3 pos = center + vec3(position.x, 0.0, position.y - 0.5) * size * 2.0;
  // 陸のしぶきは足元だけ、水面の波紋は遠くまで（湖が画面の主役なので）
  float reach = mix(1.0 - smoothstep(4.0, 6.2, dist), 1.0 - smoothstep(22.0, 34.0, dist), water);
  float alpha = on * reach * smoothstep(0.25, 0.8, dist);
  vQ = position.xy;
  vLife = life;
  vAlpha = alpha;
  vWorld = center;
  vFm = wx_flipMask(center);
  vOnLand = 1.0 - water;
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
varying float vOnLand;
void main(){
  // 寝かせた円板。q は板の -1..1、rq は「輪の最大半径」を 1 とした半径
  vec2 q = vec2(vQ.x, vQ.y - 0.5) * 2.0;
  float rq = length(q) * 1.2;
  float t = vLife;
  // 着弾の閃き: 中心が一瞬だけ光る（輪郭線ではなく点。これが「雨粒が当たった」の主役）
  float pop = exp(-rq * rq * 9.0) * exp(-t * 5.0) * vOnLand;
  // 広がる輪。広がるほど太く・薄くぼけて消える（細いままだと描いた円＝シャボン玉に見える）。
  // 水面の波紋は輪が細く長生き、陸の着弾はすぐ太くぼける
  float aa = max(fwidth(rq) * 1.2, mix(0.05 + 0.13 * t, 0.07 + 0.28 * t, vOnLand));
  float e = (rq - t) / aa;
  float fade = mix((1.0 - t), (1.0 - t) * (1.0 - t), vOnLand);
  float ring = exp(-e * e) * fade * mix(0.85, 0.55, vOnLand);
  // 水面はもう一重、内側に遅れて広がる輪（本物の波紋は同心円）
  float e2 = (rq - t * 0.55) / (aa * 1.4);
  ring += exp(-e2 * e2) * fade * 0.45 * (1.0 - vOnLand);
  // 着弾の暗点（濡れて暗くなった一点）。陸だけ。輪より内側で、輪より先に消える
  float dark = (1.0 - smoothstep(0.0, 0.12 + 0.5 * t, rq)) * (1.0 - smoothstep(0.25, 0.75, t)) * vOnLand;
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  // 輪は「濡れた面が空を映した照り」。空の色をそのまま出すと暗い嵐で白い輪郭線になる
  vec3 bright = uSkyAmbient * 0.30 + uGroundAmbient * 0.35 + uSunColor * 0.04 * sunUp + vec3(0.94, 0.96, 1.0) * uLightning * 0.12;
  // 水面の波紋は空の照り返し（地面の色は混ぜない）
  bright = mix(uSkyAmbient * 0.55 + uSunColor * 0.05 * sunUp + vec3(0.94, 0.96, 1.0) * uLightning * 0.12, bright, vOnLand);
  vec3 darkCol = uGroundAmbient * 0.08;
  // ソフトパーティクルの深度フェードは使わない。しぶきは地面に貼りついた「デカール」なので、
  // 地面との深度差はいつもゼロ＝真上から見ると全部消えてしまう（草の手前後は深度テストが受け持つ）
  vec4 aer = flip_aerial(vWorld);
  float base = vAlpha * aer.a;
  float aR = base * (ring * 0.55 + pop * 1.6) * mix(0.30, 0.30, vOnLand);
  float aD = base * dark * 0.20;
  float alpha = clamp(aR + aD, 0.0, 1.0);
  vec3 col = (bright * aR + darkCol * aD) / max(aR + aD, 1e-5);
  // 数式ビュー: 着弾点（座標の点）
  float dotc = 1.0 - smoothstep(0.0, 0.12, rq);
  col = mix(col, FLIP_LINE, vFm);
  alpha = mix(alpha, dotc * vAlpha, vFm);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export class Rain {
  streaks: THREE.Mesh;
  splashes: THREE.Mesh;
  /** 湖面の波紋（画面いっぱいの 1 パス。ripples.ts）。
   *  水担当が法線リングを入れるときは `weather.rain.ripples.visible = false` でここを止める */
  ripples: THREE.Mesh;
  rippleFx: Ripples;
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
      uniforms: w.bind({ uSplashGrid: { value: grid }, uSplashMode: { value: new THREE.Vector2(13, 0) } }),
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

    // 湖面の波紋。板を撒くのはやめて、画面いっぱいの 1 パスで格子のセルごとに評価する（ripples.ts）
    this.rippleFx = new Ripples(w);
    this.ripples = this.rippleFx.mesh;
  }

  update() {
    const wt = this.w.env.weather;
    // 密度: 雨で約6割、嵐で全部（横殴り＋密度2倍弱）
    const density = Math.min(1, wt.rain * (1.0 + 0.35 * wt.storm));
    const n = Math.floor(this.maxStreaks * density);
    this.streaks.visible = n > 8;
    this.streakGeo.instanceCount = Math.max(n, 1);
    this.splashes.visible = wt.rain > 0.03;
    this.rippleFx.update();
  }
}
