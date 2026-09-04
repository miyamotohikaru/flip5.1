// 体積雲。
//   3D ノイズ（Perlin-Worley 128³ ＋ ディテール Worley 32³）を起動時に GPU で焼き、
//   天気マップ（雲量・雲の型・細かいむら。1024²、80km で繰り返す）も GPU で焼く。
//   毎フレーム: 低解像度 RT にレイマーチ（q.cloudSteps 歩、Beer + 多重散乱近似 + HG 前方散乱）→ 空シェーダで合成。
//   雲の影は 512² のマップ（world xz、一辺 uSkyParams.x）に投影して焼き、flip_cloudShadow() で参照する。

/** 雲の密度場（レイマーチ・影・空の裏返しで共有） */
export const CLOUD_COMMON = /* glsl */ `
uniform highp sampler3D uNoiseShape;
uniform highp sampler3D uNoiseDetail;
uniform sampler2D uWeatherMap;
uniform vec4 uCloudLayer;    // x = 底の高さ(m), y = 上端(m), z = 雲量パラメータ, w = 消散係数(/m)
uniform vec4 uWeatherParams; // x = 1/タイル(m), yz = 風による uv のずれ, w = ディテールの強さ
uniform vec4 uCloudShape;    // x = 型の偏り(嵐で層雲へ), y = 上端の圧縮, z = 予備, w = 予備
uniform vec3 uWindOffset;    // 3D ノイズのずれ (m)
float cl_remap(float v, float l0, float h0, float l1, float h1){ return l1 + (v - l0) * (h1 - l1) / (h0 - l0); }
vec4 cl_weather(vec2 xz){ return texture2D(uWeatherMap, xz * uWeatherParams.x + uWeatherParams.yz); }
float cl_coverage(vec4 w){ return clamp((w.r - (1.0 - uCloudLayer.z)) / 0.5, 0.0, 1.0); }
// 層の中の高さ hf (0..1) と型 (0 = 層雲: 低く平ら, 1 = 積雲: 高い) による密度の重み。
// undul = 雲底のうねり（その雲の厚み top に対する割合、-1..1）。底だけを上下させるので、
// 底が上がったところは雲が薄くなって光が通る＝「暗い塊とすき間」になる
float cl_heightGrad(float hf, float type, float undul){
  type = clamp(type + uCloudShape.x, 0.0, 1.0);
  float top = mix(0.30, 1.0, type) * uCloudShape.y;
  float b = max(undul, -0.9) * 0.5 * top;
  return smoothstep(b, b + 0.07, hf) * (1.0 - smoothstep(top * 0.55, top, hf));
}
float cl_density(vec3 p, float hf, vec4 w, bool detail){
  float cov = cl_coverage(w);
  if (cov <= 0.002) return 0.0;
  // 雲底のうねり（嵐・雨）。**水平位置だけの関数にすること。**
  // ここを 3D ノイズにすると「底の高さ」ではなく密度そのものが 3D で穴だらけになり、
  // 空一面に 40〜70px の白い玉が並ぶ（ラウンド3で実際にそうなった）。
  // 天気マップの細かいむら（w.b、λ≈3km）と、同じマップを 11 倍の uv で引いた λ≈300m の 2 段。
  float undul = 0.0;
  if (uCloudShape.z > 0.001){
    float fine = cl_weather(p.xz * 11.0).b;
    undul = uCloudShape.z * ((w.b - 0.5) * 1.0 + (fine - 0.5) * 1.2);
  }
  float hg = cl_heightGrad(hf, w.g, undul);
  if (hg <= 0.002) return 0.0;
  vec3 sp = (p + uWindOffset) * (1.0 / 4200.0);
  vec4 s = texture(uNoiseShape, sp);
  float lf = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float base = cl_remap(s.r, lf - 1.0, 1.0, 0.0, 1.0) * hg;
  float d = clamp(cl_remap(base, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
  if (detail && d > 0.0){
    vec3 dn = texture(uNoiseDetail, (p + uWindOffset * 1.3) * (1.0 / 300.0)).rgb;
    float hfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float m = mix(hfbm, 1.0 - hfbm, clamp(hf * 8.0, 0.0, 1.0));
    d = clamp(cl_remap(d, m * 0.28 * uWeatherParams.w, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return d;
}
`;

/** 周期ノイズ（焼き込み用。タイルする） */
const PERIODIC_NOISE = /* glsl */ `
#include <flip_noise>
vec3 cl_hash33p(vec3 p, float period){ p = mod(p, period); return flip_hash33(p + 0.5); }
vec2 cl_hash22p(vec2 p, float period){ p = mod(p, period); return flip_hash22(p + 0.5); }
float cl_pnoise3(vec3 p, float period){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(cl_hash33p(i, period) * 2.0 - 1.0, f);
  float n100 = dot(cl_hash33p(i + vec3(1.0, 0.0, 0.0), period) * 2.0 - 1.0, f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(cl_hash33p(i + vec3(0.0, 1.0, 0.0), period) * 2.0 - 1.0, f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(cl_hash33p(i + vec3(1.0, 1.0, 0.0), period) * 2.0 - 1.0, f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(cl_hash33p(i + vec3(0.0, 0.0, 1.0), period) * 2.0 - 1.0, f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(cl_hash33p(i + vec3(1.0, 0.0, 1.0), period) * 2.0 - 1.0, f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(cl_hash33p(i + vec3(0.0, 1.0, 1.0), period) * 2.0 - 1.0, f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(cl_hash33p(i + vec3(1.0, 1.0, 1.0), period) * 2.0 - 1.0, f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z) * 1.3;
}
float cl_worley3(vec3 p, float period){
  vec3 i = floor(p), f = fract(p);
  float md = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 c = vec3(float(x), float(y), float(z));
    vec3 r = c + cl_hash33p(i + c, period) - f;
    md = min(md, dot(r, r));
  }
  return 1.0 - clamp(sqrt(md), 0.0, 1.0);
}
float cl_worleyFbm(vec3 p, float f){ return cl_worley3(p * f, f) * 0.625 + cl_worley3(p * f * 2.0, f * 2.0) * 0.25 + cl_worley3(p * f * 4.0, f * 4.0) * 0.125; }
float cl_perlinFbm(vec3 p, float f, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 6; k++){ if (k >= oct) break; s += a * cl_pnoise3(p * f, f); n += a; f *= 2.0; a *= 0.5; }
  return s / n;
}
float cl_pnoise2(vec2 p, float period){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = cl_hash22p(i, period) * 2.0 - 1.0, gb = cl_hash22p(i + vec2(1.0, 0.0), period) * 2.0 - 1.0;
  vec2 gc = cl_hash22p(i + vec2(0.0, 1.0), period) * 2.0 - 1.0, gd = cl_hash22p(i + vec2(1.0, 1.0), period) * 2.0 - 1.0;
  return mix(mix(dot(ga, f), dot(gb, f - vec2(1.0, 0.0)), u.x), mix(dot(gc, f - vec2(0.0, 1.0)), dot(gd, f - vec2(1.0, 1.0)), u.x), u.y) * 1.4;
}
float cl_fbm2p(vec2 p, float f, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 7; k++){ if (k >= oct) break; s += a * cl_pnoise2(p * f, f); n += a; f *= 2.0; a *= 0.5; }
  return s / n;
}
`;

/** 形のノイズ（128³）。R = Perlin-Worley, GBA = Worley fbm（周波数 4, 8, 16） */
export const NOISE_SHAPE_FRAG = /* glsl */ `
${PERIODIC_NOISE}
uniform float uZ;
varying vec2 vUv;
void main(){
  vec3 p = vec3(vUv, uZ);
  float perlin = clamp(cl_perlinFbm(p, 4.0, 4) * 0.8 + 0.5, 0.0, 1.0);
  float w1 = cl_worleyFbm(p, 4.0), w2 = cl_worleyFbm(p, 8.0), w3 = cl_worleyFbm(p, 16.0);
  float pw = w1 + perlin * (1.0 - w1);
  gl_FragColor = vec4(pw, w1, w2, w3);
}
`;

/** ディテールのノイズ（32³）。RGB = Worley fbm（2, 4, 8） */
export const NOISE_DETAIL_FRAG = /* glsl */ `
${PERIODIC_NOISE}
uniform float uZ;
varying vec2 vUv;
void main(){
  vec3 p = vec3(vUv, uZ);
  gl_FragColor = vec4(cl_worleyFbm(p, 2.0), cl_worleyFbm(p, 4.0), cl_worleyFbm(p, 8.0), 1.0);
}
`;

/** 天気マップ（1024²）。R = 雲量の素, G = 型, B = 細かいむら */
export const WEATHER_FRAG = /* glsl */ `
${PERIODIC_NOISE}
varying vec2 vUv;
// 世界のシードによるずらし（core/seed.ts の subFloat("sky")）。既定のシードでは 0＝今の雲の並び。
// 周期ノイズなので定数を足してもタイルの継ぎ目は出ない
uniform vec2 uWeatherSeed;
void main(){
  vec2 p = vUv + uWeatherSeed;
  float c = cl_fbm2p(p, 4.0, 6) * 0.5 + 0.5;
  c = smoothstep(0.22, 0.86, c);
  float type = cl_fbm2p(p + 3.7, 2.0, 3) * 0.5 + 0.5;
  type = smoothstep(0.32, 0.68, type);
  float fine = cl_fbm2p(p + 9.1, 24.0, 3) * 0.5 + 0.5;
  gl_FragColor = vec4(c, type, fine, 1.0);
}
`;

/** 雲のレイマーチ（低解像度 RT へ。出力は premultiplied: rgb = 雲の放射輝度（空気遠近込み）, a = 不透明度） */
export const CLOUD_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
${CLOUD_COMMON}
uniform vec2 uProjScale;
uniform mat4 uCamWorld;
uniform sampler2D uHistory;
uniform mat4 uPrevViewProj;
uniform float uHistoryValid;
uniform float uFrame;
uniform float uSteps;
uniform vec3 uLightDir;
uniform vec3 uLightE;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
varying vec2 vUv;

// 太陽（月）へ向かう光の減衰。**歩幅は 40→274m の 4 歩＝合計 534m しか進まない。**
// 高い太陽なら層を抜けるのに十分だが、**太陽が地平にあると層の中を何 km も横に進む**ので、
// 534m で測った厚さは本当の 3〜17% にしかならない。すると厚い嵐の雲でも odL が小さく出て、
// 局所的に薄い所だけが直射で光り、空に大きな白い塊が浮く（批評R7「レンズの指紋」）。
// 直すのに歩数は増やさない（雲は 1 画素あたり最大 128 歩、その中から呼ばれる）。
// 歩いた 534m を「平均密度の標本」とみなし、層を抜けるまでの本当の距離で外挿する。
#ifndef FLIP_CLOUD_LSPAN
#define FLIP_CLOUD_LSPAN 9000.0
#endif
float cl_lightMarch(vec3 p, vec3 L, float base, float top){
  float od = 0.0, t = 0.0, dt = 40.0, walked = 0.0;
  for (int i = 0; i < 4; i++){
    t += dt;
    vec3 q = p + L * t;
    float hf = (q.y - base) / (top - base);
    if (hf < 0.0 || hf > 1.0) break;
    od += cl_density(q, hf, cl_weather(q.xz), false) * dt;
    walked = t;
    dt *= 1.9;
  }
  // 光の向きに層を抜けるまでの距離（水平に近いほど長い）。上限は数値の暴走止め
  float span = L.y > 0.02 ? (top - p.y) / L.y : (L.y < -0.02 ? (p.y - base) / -L.y : FLIP_CLOUD_LSPAN);
  span = min(span, FLIP_CLOUD_LSPAN);
  // 層を抜けきる前に 4 歩を使い切っていたら、残りを同じ平均密度で足す
  return od * (1.0 + max(span - walked, 0.0) / max(walked, 1.0));
}
// 多重散乱の近似（Wrenninge）: 減衰・消散・位相の異方性を段ごとに弱めた和
float cl_scatter(float od, float cosT){
  float r = 0.0, a = 1.0, b = 1.0, g = 0.62;
  for (int k = 0; k < 3; k++){
    float ph = 0.78 * flip_phaseHG(cosT, g) + 0.22 * flip_phaseHG(cosT, -0.18 * g);
    r += a * exp(-b * od) * ph;
    a *= 0.5; b *= 0.45; g *= 0.55;
  }
  return r * 3.0;
}
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 vd = normalize(vec3(ndc.x / uProjScale.x, ndc.y / uProjScale.y, -1.0));
  vec3 d = normalize((uCamWorld * vec4(vd, 0.0)).xyz);
  float base = uCloudLayer.x, top = uCloudLayer.y, sigma = uCloudLayer.w;
  vec4 result = vec4(0.0);
  vec3 o = vec3(0.0, flip_camR(uCamPos), 0.0);
  float tg = flip_raySphere(o, d, FLIP_RGROUND);
  float t0 = flip_raySphere(o, d, FLIP_RGROUND + base * 0.001);
  float t1 = flip_raySphere(o, d, FLIP_RGROUND + top * 0.001);
  bool hit = t0 > 0.0 && t1 > t0 && !(tg > 0.0 && tg < t0) && d.y > -0.06;
  if (hit){
    float t0m = t0 * 1000.0, t1m = t1 * 1000.0;
    float len = min(t1m - t0m, 24000.0);
    float dt = len / uSteps;
    float jitter = flip_hash12(gl_FragCoord.xy + fract(uFrame * 0.618034) * 61.7);
    float t = t0m + dt * jitter;
    float T = 1.0; vec3 L = vec3(0.0);
    float cosT = dot(d, uLightDir);
    float firstHit = -1.0;
    int empty = 0;
    for (int i = 0; i < 128; i++){
      if (float(i) >= uSteps) break;
      vec3 p = uCamPos + d * t;
      vec3 pk = o + d * (t * 0.001);
      float alt = (length(pk) - FLIP_RGROUND) * 1000.0;
      float hf = (alt - base) / (top - base);
      if (hf > 1.0) break;
      float stepMul = 1.0;
      if (hf >= 0.0){
        vec4 w = cl_weather(p.xz);
        float dens = cl_density(p, hf, w, t < 10000.0);
        // 何もないところが続いたら大股で（雲に当たったら元の歩幅に戻る）
        if (dens <= 0.0) { empty++; if (empty > 3) stepMul = 2.0; }
        else {
          if (empty > 3) { t -= dt; p = uCamPos + d * t; dens = cl_density(p, hf, w, t < 10000.0); }
          empty = 0;
        }
        if (dens > 0.0){
          if (firstHit < 0.0) firstHit = t;
          float odL = cl_lightMarch(p, uLightDir, base, top) * sigma;
          float sc = cl_scatter(odL, cosT);
          // 上からの空の光は、上に積もる雲の厚さで弱まる（薄いところ・端が明るい）
          float odUp = 0.0;
          {
            // 歩幅はその雲自身の厚み（層雲は薄く積雲は高い）に合わせる。
            // 固定だと層雲では雲の上まで飛び越してしまい、薄い所と厚い所の差が出ない
            float topF = mix(0.30, 1.0, clamp(w.g + uCloudShape.x, 0.0, 1.0)) * uCloudShape.y;
            float du = (top - base) * topF * 0.28;
            for (int k = 1; k <= 3; k++){
              vec3 q = p + vec3(0.0, du * float(k), 0.0);
              float hq = hf + du * float(k) / (top - base);
              if (hq > 1.0) break;
              odUp += cl_density(q, hq, w, false) * du;
            }
          }
          float skyT = exp(-odUp * sigma * 0.03);
          vec3 amb = mix(uAmbBottom, uAmbTop, hf) * (0.15 + 0.85 * skyT) * (1.0 - 0.45 * dens);
          vec3 S = uLightE * sc + amb;
          float stepT = exp(-dens * sigma * dt);
          L += T * S * (1.0 - stepT);
          T *= stepT;
          if (T < 0.004) break;
        }
      }
      t += dt * stepMul;
    }
    // 地平線ぎわは歩幅が粗く細い筋になるので消す（そこは空気遠近で霞む）
    float alpha = (1.0 - T) * smoothstep(-0.02, 0.03, d.y);
    if (alpha > 0.0005){
      vec4 ap = flip_aerial(uCamPos + d * firstHit);
      result = vec4((L * ap.a + ap.rgb * (1.0 - T)) * (alpha / (1.0 - T)), alpha);
    }
  }
  // 時間方向の再利用（前フレームを「方向」で再投影。雲は遠いので視差は無視できる）
  vec4 pc = uPrevViewProj * vec4(d, 0.0);
  if (uHistoryValid > 0.0 && pc.w > 0.0){
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    if (all(greaterThan(puv, vec2(0.002))) && all(lessThan(puv, vec2(0.998)))){
      vec4 h = texture2D(uHistory, puv);
      result = mix(result, h, uHistoryValid);
    }
  }
  gl_FragColor = result;
}
`;

/** 雲の影マップ（world xz → 日なた 0..1） */
export const CLOUD_SHADOW_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
${CLOUD_COMMON}
varying vec2 vUv;
void main(){
  vec2 xz = (vUv - 0.5) * uSkyParams.x;
  float sy = max(uSunDir.y, 0.06);
  float mid = mix(uCloudLayer.x, uCloudLayer.y, 0.4);
  vec2 q = xz + uSunDir.xz / sy * mid;
  vec3 p = vec3(q.x, mid, q.y);
  vec4 w = cl_weather(q);
  float d0 = cl_density(p, 0.25, w, false);
  float d1 = cl_density(p + vec3(0.0, (uCloudLayer.y - uCloudLayer.x) * 0.3, 0.0), 0.55, w, false);
  float od = (d0 + d1) * 0.5 * (uCloudLayer.y - uCloudLayer.x) * uCloudLayer.w * 0.6;
  float sh = exp(-od);
  sh = mix(1.0, sh, smoothstep(0.0, 0.12, uSunDir.y));
  gl_FragColor = vec4(sh, sh, sh, 1.0);
}
`;
