// 大気の LUT を焼くシェーダ群（Hillaire 2020）。
//   透過率 LUT      256×64   静的（靄の濃さが変わったときだけ焼き直す）
//   多重散乱 LUT    32×32    同上
//   Sky-View LUT    256×128  毎フレーム（カメラ高度・太陽・月で変わる）
//   空気遠近 LUT    64×32×16 毎フレーム（3D: 方位 × 仰角 × 距離）
//   環境プローブ    4×1      毎フレーム（半球光の照度を CPU に返す）
import { ATMO_COMMON } from "./atmosphere.glsl";

export const LUT_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** 透過率 LUT: 各テクセル (r, mu) から大気の外までの透過率 */
export const TRANS_FRAG = /* glsl */ `
${ATMO_COMMON}
varying vec2 vUv;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(FLIP_TRANS_W - 1.0, FLIP_TRANS_H - 1.0);
  float r, mu; flip_transParams(uv, r, mu);
  vec3 o = vec3(0.0, r, 0.0);
  vec3 d = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  float tMax = flip_raySphere(o, d, FLIP_RT);
  if (tMax < 0.0) tMax = 0.0;
  const int N = 48;
  float dt = tMax / float(N);
  vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++){
    vec3 p = o + d * ((float(i) + 0.5) * dt);
    float h = length(p) - FLIP_RG;
    vec3 sR, sM, sE; flip_atmoMedium(h, sR, sM, sE);
    od += sE * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

/** 多重散乱 LUT（Ψ_ms）: x = 太陽の cos(天頂角), y = 高度 */
export const MS_FRAG = /* glsl */ `
${ATMO_COMMON}
varying vec2 vUv;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(63.0, 31.0);
  float sx = uv.x * 2.0 - 1.0;
  float sunCos = sign(sx) * sx * sx;
  float r = FLIP_RG + uv.y * (FLIP_RT - FLIP_RG) + 0.001;
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - sunCos * sunCos)), sunCos, 0.0);
  vec3 o = vec3(0.0, r, 0.0);
  vec3 Lsum = vec3(0.0), fsum = vec3(0.0);
  const int ND = 64;
  for (int i = 0; i < ND; i++){
    float fi = float(i) + 0.5;
    float y = 1.0 - 2.0 * fi / float(ND);
    float rad = sqrt(max(0.0, 1.0 - y * y));
    float phi = fi * 2.399963;
    vec3 d = vec3(cos(phi) * rad, y, sin(phi) * rad);
    float tTop = flip_raySphere(o, d, FLIP_RT);
    float tG = flip_raySphere(o, d, FLIP_RG);
    float tMax = (tG > 0.0) ? tG : tTop;
    const int NS = 20;
    float dt = tMax / float(NS);
    vec3 T = vec3(1.0), L = vec3(0.0), f = vec3(0.0);
    for (int j = 0; j < NS; j++){
      vec3 p = o + d * ((float(j) + 0.5) * dt);
      float rp = length(p);
      float h = rp - FLIP_RG;
      vec3 sR, sM, sE; flip_atmoMedium(h, sR, sM, sE);
      float muS = dot(p / rp, sunDir);
      float shadow = (flip_raySphere(p, sunDir, FLIP_RG) > 0.0) ? 0.0 : 1.0;
      vec3 Ts = flip_atmoTrans(rp, muS) * shadow;
      vec3 sS = sR + sM;
      vec3 S = sS * Ts * 0.0795775;
      vec3 Tstep = exp(-sE * dt);
      vec3 invE = 1.0 / max(sE, vec3(1e-7));
      L += T * (S - S * Tstep) * invE;
      f += T * (sS - sS * Tstep) * invE;
      T *= Tstep;
    }
    if (tG > 0.0){
      vec3 n = normalize(o + d * tG);
      float NdotL = max(dot(n, sunDir), 0.0);
      L += T * 0.3 * flip_atmoTrans(FLIP_RG, dot(n, sunDir)) * NdotL / PI;
    }
    Lsum += L; fsum += f;
  }
  Lsum /= float(ND); fsum /= float(ND);
  vec3 psi = Lsum / max(vec3(1.0) - fsum, vec3(1e-3));
  gl_FragColor = vec4(psi, 1.0);
}
`;

/** Sky-View / 空気遠近 で共有する散乱の積分 */
const SCATTER_COMMON = /* glsl */ `
uniform sampler2D uMsLut;
uniform float uCamR;
uniform vec3 uSunDirK;
uniform vec3 uMoonDirK;
uniform vec3 uSunE;
uniform vec3 uMoonE;
vec3 flip_msLookup(float r, float muS){
  float sx = sign(muS) * sqrt(abs(muS));
  vec2 uv = vec2(sx * 0.5 + 0.5, (r - FLIP_RG) / (FLIP_RT - FLIP_RG));
  uv = flip_subUv(clamp(uv, 0.0, 1.0), vec2(64.0, 32.0));
  return texture2D(uMsLut, uv).rgb;
}
// o から d へ [0, tMax] を N 歩（二次で手前が細かい）で積分。L = 散乱光, T = 透過率
void flip_scatterMarch(vec3 o, vec3 d, float tMax, int N, out vec3 L, out vec3 T){
  T = vec3(1.0); L = vec3(0.0);
  float cS = dot(d, uSunDirK), cM = dot(d, uMoonDirK);
  float phRs = flip_phaseR(cS), phMs = flip_phaseMie(cS, 0.76);
  float phRm = flip_phaseR(cM), phMm = flip_phaseMie(cM, 0.76);
  float tPrev = 0.0;
  for (int i = 0; i < 48; i++){
    if (i >= N) break;
    float f = (float(i) + 1.0) / float(N);
    float t = tMax * f * f;
    float dt = t - tPrev;
    vec3 p = o + d * (0.5 * (t + tPrev));
    tPrev = t;
    float rp = length(p);
    float h = rp - FLIP_RG;
    vec3 sR, sM, sE; flip_atmoMedium(h, sR, sM, sE);
    vec3 up = p / rp;
    float muS = dot(up, uSunDirK);
    float muM = dot(up, uMoonDirK);
    float shS = (flip_raySphere(p, uSunDirK, FLIP_RG) > 0.0) ? 0.0 : 1.0;
    float shM = (flip_raySphere(p, uMoonDirK, FLIP_RG) > 0.0) ? 0.0 : 1.0;
    vec3 Ts = flip_atmoTrans(rp, muS) * shS;
    vec3 Tm = flip_atmoTrans(rp, muM) * shM;
    vec3 sS = sR + sM;
    vec3 S = uSunE * (Ts * (sR * phRs + sM * phMs) + flip_msLookup(rp, muS) * sS)
           + uMoonE * (Tm * (sR * phRm + sM * phMm) + flip_msLookup(rp, muM) * sS);
    vec3 Tstep = exp(-sE * dt);
    L += T * (S - S * Tstep) / max(sE, vec3(1e-7));
    T *= Tstep;
  }
}
`;

/** Sky-View LUT: カメラ高度からの空の放射輝度（雲・太陽円盤なし）。u = 太陽相対方位（√）, v = 仰角 */
export const SKYVIEW_FRAG = /* glsl */ `
${ATMO_COMMON}
${SCATTER_COMMON}
uniform vec3 uNightGlow;
varying vec2 vUv;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(FLIP_SKYVIEW_W - 1.0, FLIP_SKYVIEW_H - 1.0);
  float el = flip_vToElev(uv.y);
  float s = uv.x * 2.0 - 1.0;
  float dAz = sign(s) * s * s * PI;
  float az = atan(uSunDirK.z, uSunDirK.x) + dAz;
  float ce = cos(el);
  vec3 d = vec3(ce * cos(az), sin(el), ce * sin(az));
  vec3 o = vec3(0.0, uCamR, 0.0);
  float tTop = flip_raySphere(o, d, FLIP_RT);
  float tG = flip_raySphere(o, d, FLIP_RGROUND);
  float tMax = (tG > 0.0) ? tG : tTop;
  vec3 L, T;
  flip_scatterMarch(o, d, tMax, 40, L, T);
  if (tG > 0.0){
    // 惑星の地面（地形の外側の遠景）: 薄い緑灰
    vec3 n = normalize(o + d * tG);
    float muS = dot(n, uSunDirK), muM = dot(n, uMoonDirK);
    vec3 alb = vec3(0.20, 0.22, 0.17);
    vec3 ground = alb / PI * (uSunE * flip_atmoTrans(FLIP_RGROUND, muS) * max(muS, 0.0) + uMoonE * flip_atmoTrans(FLIP_RGROUND, muM) * max(muM, 0.0))
                + alb * 2.0 * (uSunE * flip_msLookup(FLIP_RGROUND, muS) + uMoonE * flip_msLookup(FLIP_RGROUND, muM));
    L += T * ground;
  }
  // 大気光（夜の空が真っ黒にならない程度）。地平線寄りで少し強い
  L += uNightGlow * (0.7 + 0.6 * (1.0 - clamp(d.y, 0.0, 1.0)));
  gl_FragColor = vec4(L, 1.0);
}
`;

/** 空気遠近 LUT の 1 スライス（距離）: u = 方位, v = 仰角。rgb = 散乱光, a = 透過率（平均） */
export const AERIAL_FRAG = /* glsl */ `
${ATMO_COMMON}
${SCATTER_COMMON}
uniform float uSlice;
uniform float uMaxDist;
varying vec2 vUv;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(63.0, FLIP_AERIAL_H - 1.0);
  float el = flip_vToElev(uv.y);
  float az = (uv.x - 0.5) * 6.2831853;
  float ce = cos(el);
  vec3 d = vec3(ce * cos(az), sin(el), ce * sin(az));
  float f = uSlice / (FLIP_AERIAL_D - 1.0);
  float dist = uMaxDist * f * f * 0.001;
  vec3 o = vec3(0.0, uCamR, 0.0);
  float tTop = flip_raySphere(o, d, FLIP_RT);
  float tMax = min(dist, tTop > 0.0 ? tTop : dist);
  vec3 L, T;
  if (tMax <= 0.0) { L = vec3(0.0); T = vec3(1.0); }
  else flip_scatterMarch(o, d, tMax, 12, L, T);
  gl_FragColor = vec4(L, dot(T, vec3(0.3333)));
}
`;

/** 環境プローブ: 0 = 上向き照度（空）, 1 = 下向き照度（地面）, 2 = 全天の平均放射輝度, 3 = 天頂の放射輝度 */
export const PROBE_FRAG = /* glsl */ `
${ATMO_COMMON}
uniform sampler2D uSkyViewLut;
uniform vec3 uSunDirK;
varying vec2 vUv;
vec3 skyAt(vec3 dir){
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float az = atan(dir.z, dir.x);
  float sunAz = atan(uSunDirK.z, uSunDirK.x);
  float dd = az - sunAz;
  dd = dd - 6.2831853 * floor((dd + PI) / 6.2831853);
  float u = 0.5 + 0.5 * sign(dd) * sqrt(abs(dd) / PI);
  float v = flip_elevToV(el);
  v = (v * (FLIP_SKYVIEW_H - 1.0) + 0.5) / FLIP_SKYVIEW_H;
  return texture2D(uSkyViewLut, vec2(u, v)).rgb;
}
void main(){
  int texel = int(gl_FragCoord.x);
  vec3 acc = vec3(0.0);
  const int NA = 24; const int NE = 12;
  if (texel == 0 || texel == 1){
    float sgn = texel == 0 ? 1.0 : -1.0;
    for (int j = 0; j < NE; j++){
      float el = (float(j) + 0.5) / float(NE) * 0.5 * PI;
      float wgt = sin(el) * cos(el) * (0.5 * PI / float(NE)) * (6.2831853 / float(NA));
      for (int i = 0; i < NA; i++){
        float az = (float(i) + 0.5) / float(NA) * 6.2831853;
        vec3 d = vec3(cos(el) * cos(az), sgn * sin(el), cos(el) * sin(az));
        acc += skyAt(d) * wgt;
      }
    }
  } else if (texel == 2){
    for (int j = 0; j < NE; j++){
      float el = ((float(j) + 0.5) / float(NE) - 0.5) * PI;
      float wgt = cos(el) * (PI / float(NE)) * (6.2831853 / float(NA)) / (4.0 * PI);
      for (int i = 0; i < NA; i++){
        float az = (float(i) + 0.5) / float(NA) * 6.2831853;
        vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
        acc += skyAt(d) * wgt;
      }
    }
  } else {
    // 太陽側の地平線の帯（方位 ±35°, 仰角 0.5〜9°）の平均: 露出の「明るいところ」の目安
    float sunAz = atan(uSunDirK.z, uSunDirK.x);
    for (int j = 0; j < 6; j++){
      float el = radians(0.5 + 8.5 * (float(j) + 0.5) / 6.0);
      for (int i = 0; i < 12; i++){
        float az = sunAz + radians(-35.0 + 70.0 * (float(i) + 0.5) / 12.0);
        vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
        acc += skyAt(d) / 72.0;
      }
    }
  }
  gl_FragColor = vec4(acc, 1.0);
}
`;
