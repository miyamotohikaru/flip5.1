// 大気モデル（Hillaire 2020 "A Scalable and Production Ready Sky and Atmosphere Rendering Technique"）。
//
// ここが `flip_atmosphere` チャンクの本体（core/glsl/atmosphere.glsl.ts の土台版を overrideChunk で置き換える）。
// 契約の関数名・引数・戻り値は変えない:
//   vec3 flip_skyColor(vec3 dir)                    … 空の放射輝度（雲・太陽円盤なし）。Sky-View LUT を引く
//   vec4 flip_aerial(vec3 worldPos)                 … rgb = 途中で足される散乱光, a = 透過率。空気遠近 LUT ＋ 地表の霧
//   vec3 flip_applyAerial(vec3 color, vec3 worldPos)
// 追加:
//   float flip_cloudShadow(vec2 xz)                 … 雲の影 0..1（地形担当が使う）
//   float flip_fogOpticalDepth(vec3 a, vec3 b)      … 地表の霧の光学的厚さ
//
// 単位: 惑星の幾何は km（精度のため）。world 座標は m。world y=0（湖面）は海抜 uSkyParams.w km。
// 必要な uniforms（全て env.uniforms にある）: uSunDir uSunColor uMoonDir uMoonColor uCamPos uFog uCloud uStorm uHour
//   uSkyTransLut uSkyViewLut uAerialLut uCloudShadowMap uSkyParams uSkyFog uSkyFogLight
// 注意: uTime / uWind / uRain / uWetness / uSkyAmbient はここで宣言しない（他のシェーダが自前で宣言していて重複する）。

/** LUT 生成シェーダと共有する部分（媒質・位相関数・LUT の座標変換） */
export const ATMO_COMMON = /* glsl */ `
#ifndef FLIP_ATMO_COMMON
#define FLIP_ATMO_COMMON
#ifndef PI
#ifndef PI
#define PI 3.141592653589793
#endif
#endif
// エアロゾル（靄）の波長依存を「散乱」と「吸収」に分ける。
//   散乱 FLIP_MIE_S … Angstrom 指数 0.8（ほぼ灰色）。ここを青寄りにしても空が青くなるだけで橙にならない
//   吸収 FLIP_MIE_A … 吸収 Angstrom 指数 4（砂塵・褐色炭素）。青だけを強く食う。
//                     これで斜めに厚く通った直射光が赤くなり、その光を前方散乱した空が橙になる。
//                     散乱を増やすのと違って空を明るくしないので、太陽まわりが白く飛ばない
#define FLIP_MIE_S vec3(0.86, 1.0, 1.16)
#define FLIP_MIE_A vec3(0.43, 1.0, 2.44)
#define FLIP_RG 6360.0
#define FLIP_RT 6460.0
#define FLIP_TRANS_W 256.0
#define FLIP_TRANS_H 64.0
#define FLIP_SKYVIEW_W 256.0
#define FLIP_SKYVIEW_H 128.0
#define FLIP_AERIAL_H 32.0
#define FLIP_AERIAL_D 16.0
uniform sampler2D uSkyTransLut;
uniform vec4 uSkyParams;
// 実験室のつまみ（core/env.ts の uLabSky）。x = ミー, y = レイリー, z = オゾン。既定は 1
uniform vec4 uLabSky;
#define FLIP_RGROUND (FLIP_RG + uSkyParams.w)

// 海抜 h (km) の媒質。sR = レイリー散乱, sM = ミー＋靄の散乱, sE = 消散（散乱＋吸収）
void flip_atmoMedium(float h, out vec3 sR, out vec3 sM, out vec3 sE){
  float hr = max(h, 0.0);
  float dR = exp(-hr / 8.0);
  float dM = exp(-hr / 2.5);
  // 靄（境界層のエアロゾル）。高さスケール 1.6km。ここを厚くすると日没の橙の帯が地平から上へ広がる
  float dH = uSkyParams.z * exp(-max(h - uSkyParams.w, 0.0) / 1.6);
  float dO = max(0.0, 1.0 - abs(hr - 25.0) / 15.0);
  // uLabSky = 実験室のつまみ（既定は全部 1 ＝ 何も変わらない）
  sR = vec3(5.802, 13.558, 33.1) * 1e-3 * dR * uLabSky.y;
  // ミー（エアロゾル）。黄昏に「橙の帯」が出る量。cpu.ts の extinction() と同じ値にすること
  float mS = (1.0e-2 * dM + dH * 0.70) * uLabSky.x;
  float mA = (4.0e-3 * dM + dH * 0.75) * uLabSky.x;
  sM = FLIP_MIE_S * mS;
  sE = sR + FLIP_MIE_S * mS + FLIP_MIE_A * mA + vec3(0.65, 1.881, 0.085) * 1.0e-3 * dO * uLabSky.z;
}
float flip_phaseR(float c){ return 0.0596831 * (1.0 + c * c); }
// Cornette-Shanks
float flip_phaseMie(float c, float g){
  float g2 = g * g;
  return 0.119366 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float flip_phaseHG(float c, float g){
  float g2 = g * g;
  return 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
// 原点中心・半径 R の球との交差。o から d 方向へ進んで最初に当たる正の距離。当たらなければ -1
float flip_raySphere(vec3 o, vec3 d, float R){
  float b = dot(o, d);
  float c = dot(o, o) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -b - s;
  if (t0 > 0.0) return t0;
  float t1 = -b + s;
  if (t1 > 0.0) return t1;
  return -1.0;
}
// 透過率 LUT の座標（Hillaire）。r = 中心からの距離 km, mu = cos(天頂角)
vec2 flip_transUv(float r, float mu){
  float H = sqrt(max(0.0, FLIP_RT * FLIP_RT - FLIP_RG * FLIP_RG));
  float rho = sqrt(max(0.0, r * r - FLIP_RG * FLIP_RG));
  float disc = r * r * (mu * mu - 1.0) + FLIP_RT * FLIP_RT;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = FLIP_RT - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / max(dMax - dMin, 1e-6);
  float xR = rho / H;
  return vec2(clamp(xMu, 0.0, 1.0), clamp(xR, 0.0, 1.0));
}
void flip_transParams(vec2 uv, out float r, out float mu){
  float H = sqrt(FLIP_RT * FLIP_RT - FLIP_RG * FLIP_RG);
  float rho = H * uv.y;
  r = sqrt(rho * rho + FLIP_RG * FLIP_RG);
  float dMin = FLIP_RT - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}
// [0,1] → テクセル中心（端の半テクセル補正）
vec2 flip_subUv(vec2 uv, vec2 size){ return (uv * (size - 1.0) + 0.5) / size; }
// r (km) の点から mu 方向に大気の外へ出るまでの透過率
vec3 flip_atmoTrans(float r, float mu){
  vec2 uv = flip_subUv(flip_transUv(r, mu), vec2(FLIP_TRANS_W, FLIP_TRANS_H));
  return texture2D(uSkyTransLut, uv).rgb;
}
// 仰角 (rad) ↔ LUT の v。地平線付近を細かく取る（√圧縮）
float flip_elevToV(float el){ return 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI)); }
float flip_vToElev(float v){ float s = v * 2.0 - 1.0; return sign(s) * s * s * 0.5 * PI; }
// カメラ位置 (m) → 惑星中心からの距離 (km)
float flip_camR(vec3 camPos){ return FLIP_RGROUND + max(camPos.y, -60.0) * 0.001; }
#endif
`;

/** `flip_atmosphere` チャンク（公開 API） */
export const FLIP_ATMOSPHERE_PBR = /* glsl */ `
#ifndef FLIP_ATMOSPHERE_INCLUDED
#define FLIP_ATMOSPHERE_INCLUDED
${ATMO_COMMON}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uCamPos;
uniform float uFog;
uniform float uCloud;
uniform float uStorm;
uniform float uHour;
uniform sampler2D uSkyViewLut;
uniform highp sampler3D uAerialLut;
uniform sampler2D uCloudShadowMap;
uniform vec4 uSkyFog;
uniform vec4 uSkyFog2;
uniform vec3 uSkyFogLight;

// このチャンク専用の小さな値ノイズ（flip_noise に依存しない）
float flip_atmoHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float flip_atmoNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(flip_atmoHash(i), flip_atmoHash(i + vec2(1.0, 0.0)), u.x), mix(flip_atmoHash(i + vec2(0.0, 1.0)), flip_atmoHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 空の LUT の座標: u = 太陽相対の方位（√圧縮。太陽の周りが細かい）, v = 仰角（地平線が細かい）
vec2 flip_skyViewUv(vec3 dir){
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float az = atan(dir.z, dir.x);
  float sunAz = atan(uSunDir.z, uSunDir.x);
  float d = az - sunAz;
  d = d - 6.2831853 * floor((d + PI) / 6.2831853);
  float u = 0.5 + 0.5 * sign(d) * sqrt(abs(d) / PI);
  return vec2(u, flip_elevToV(el));
}
vec3 flip_skyColor(vec3 dir){
  vec2 uv = flip_skyViewUv(dir);
  uv.y = (uv.y * (FLIP_SKYVIEW_H - 1.0) + 0.5) / FLIP_SKYVIEW_H;
  return texture2D(uSkyViewLut, uv).rgb;
}

// 指数層（密度 rho·exp(-y/H)）の a → b の光学的厚さ
float flip_fogLayerOd(vec3 a, vec3 b, float rho, float H){
  float dist = distance(a, b);
  float dy = b.y - a.y;
  float ya = max(a.y, -50.0), yb = max(b.y, -50.0);
  float ea = exp(-ya / H);
  float t;
  if (abs(dy) < 0.01) t = ea * dist;
  else t = (ea - exp(-yb / H)) * H / dy * dist;
  return rho * max(t, 0.0);
}
// 地表の霧（2 層: 広いミスト ＋ 湖面に張り付く薄く濃い層）の光学的厚さ。a → b
float flip_fogOpticalDepth(vec3 a, vec3 b){
  return flip_fogLayerOd(a, b, uSkyFog.x, uSkyFog.y) + flip_fogLayerOd(a, b, uSkyFog2.x, uSkyFog2.y);
}
// 霧のむら（中点の xz で決める。空の側は同じ式で 2000m 先を使う）
float flip_fogPatch(vec2 xz){
  vec2 p = (xz + uSkyFog.zw) * 0.0032;
  float n = flip_atmoNoise(p) * 0.6 + flip_atmoNoise(p * 2.7 + 11.0) * 0.4;
  return 0.4 + 1.2 * n;
}
// 霧に入ってくる光（等方の空の光＋太陽・月の前方散乱）
vec3 flip_fogLight(vec3 dir){
  // 等方の空の光と、視線の先（地平線寄り）の空の色を混ぜる（前方散乱で「向こうの空」の色が乗る）。
  // 方向の側を強めにすると、薄明の霧が朝日・夕日の側だけ暖色になる（一色フィルターにならない）
  vec3 hz = normalize(vec3(dir.x, max(dir.y, 0.04), dir.z));
  vec3 l = uSkyFogLight * 0.42 + flip_skyColor(hz) * 0.62;
  l += uSunColor * flip_phaseHG(dot(dir, uSunDir), 0.6) * 0.9;
  l += uMoonColor * 4.0 * flip_phaseHG(dot(dir, uMoonDir), 0.6) * 0.9;
  return l;
}

vec4 flip_aerial(vec3 worldPos){
  vec3 dv = worldPos - uCamPos;
  float dist = length(dv);
  vec3 dir = dv / max(dist, 1e-4);
  // 空気遠近 LUT（方位 × 仰角 × 距離）
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float az = atan(dir.z, dir.x);
  float u = az / 6.2831853 + 0.5;
  float v = flip_elevToV(el);
  v = (v * (FLIP_AERIAL_H - 1.0) + 0.5) / FLIP_AERIAL_H;
  float w = sqrt(clamp(dist / uSkyParams.y, 0.0, 1.0));
  w = (w * (FLIP_AERIAL_D - 1.0) + 0.5) / FLIP_AERIAL_D;
  vec4 atm = texture(uAerialLut, vec3(u, v, w));
  // 地表の霧（手前の媒質として合成）
  float od = flip_fogOpticalDepth(uCamPos, worldPos);
  vec3 mid = uCamPos + dir * min(dist, 4000.0) * 0.5;
  od *= flip_fogPatch(mid.xz);
  float tf = exp(-od);
  vec3 inscatter = flip_fogLight(dir) * (1.0 - tf) + tf * atm.rgb;
  return vec4(inscatter, atm.a * tf);
}

vec3 flip_applyAerial(vec3 color, vec3 worldPos){
  vec4 a = flip_aerial(worldPos);
  return color * a.a + a.rgb;
}

// 雲の影（0 = 影, 1 = 日なた）。マップは原点中心・一辺 uSkyParams.x m
float flip_cloudShadow(vec2 xz){
  vec2 uv = xz / uSkyParams.x + 0.5;
  return texture2D(uCloudShadowMap, uv).r;
}
#endif
`;
