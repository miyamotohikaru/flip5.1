// 地形ハイトマップの参照。`#include <flip_height>`。
// 必要な uniforms: uHeightmap, uHeightmapInfo（env.uniforms が持っている）。
// 追加（地形担当が起動時に焼く。env.uniforms の uTerrainAux / uTerrainHorizonA / uTerrainHorizonB）:
//   flip_terrainNormalBaked(xz) … 焼いた法線（3×3 Sobel、texel 精度。近景の細部は各モジュールが足す）
//   flip_terrainAO(xz)          … 空の見え方 0..1（谷底で小さい）。間接光に掛ける
//   flip_terrainCavity(xz)      … 谷筋の陰 0..1（0.5 = 平ら、小さいほど窪み）
//   flip_terrainSunVis(xz, dir) … その地点から光源 dir（光の来る向き）が山に隠れていないか 0..1
//   flip_sunOcclusion(wp, dir, camDist) … 上の「山の影」に「林が落とす帯」を足した遠景の遮蔽 0..1
//     （uSunVeg = 植生マップ。core/lighting.ts が uVegMap を毎フレーム挿す）
export const FLIP_HEIGHT = /* glsl */ `
#ifndef FLIP_HEIGHT_INCLUDED
#define FLIP_HEIGHT_INCLUDED
uniform sampler2D uHeightmap;
uniform vec4 uHeightmapInfo; // x = worldSize, y = 1/worldSize, z = res, w = maxHeight
uniform sampler2D uTerrainAux;
uniform sampler2D uTerrainHorizonA;
uniform sampler2D uTerrainHorizonB;
uniform sampler2D uSunVeg; // 植生マップ（G = 林の密度）。lighting が uVegMap を挿す
// world xz → 高さ（バイリニア・手動。float線形フィルタ非対応の端末でも同じ絵にする）
float flip_height(vec2 xz){
  float res = uHeightmapInfo.z;
  vec2 uv = (xz * uHeightmapInfo.y + 0.5) * res - 0.5;
  vec2 f = fract(uv);
  vec2 i = floor(uv);
  vec2 t = vec2(1.0 / res);
  vec2 b = (i + 0.5) * t;
  float a = texture2D(uHeightmap, b).r;
  float c = texture2D(uHeightmap, b + vec2(t.x, 0.0)).r;
  float d = texture2D(uHeightmap, b + vec2(0.0, t.y)).r;
  float e = texture2D(uHeightmap, b + t).r;
  return mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
}
// 有限差分の法線（eps はメートル）
vec3 flip_terrainNormal(vec2 xz, float eps){
  float hl = flip_height(xz - vec2(eps, 0.0));
  float hr = flip_height(xz + vec2(eps, 0.0));
  float hd = flip_height(xz - vec2(0.0, eps));
  float hu = flip_height(xz + vec2(0.0, eps));
  return normalize(vec3(hl - hr, 2.0 * eps, hd - hu));
}
// 補助テクスチャの uv（uHeightmap と同じ対応）
vec2 flip_terrainUv(vec2 xz){ return xz * uHeightmapInfo.y + 0.5; }
// 焼いた法線（RGBA16F の rg に生の xz）。ハードウェアのバイリニアで滑らか
vec3 flip_terrainNormalBaked(vec2 xz){
  vec2 n = texture2D(uTerrainAux, flip_terrainUv(xz)).rg;
  return normalize(vec3(n.x, sqrt(max(1.0 - dot(n, n), 0.0)), n.y));
}
float flip_terrainAO(vec2 xz){ return texture2D(uTerrainAux, flip_terrainUv(xz)).b; }
float flip_terrainCavity(vec2 xz){ return texture2D(uTerrainAux, flip_terrainUv(xz)).a; }
float flip_horizonPick(vec4 a, vec4 b, float i){
  return i < 3.5 ? (i < 1.5 ? (i < 0.5 ? a.r : a.g) : (i < 2.5 ? a.b : a.a))
                 : (i < 5.5 ? (i < 4.5 ? b.r : b.g) : (i < 6.5 ? b.b : b.a));
}
// 地形の地平角による光源の見え方（0 = 山の影, 1 = 日なた）。dir は光の来る向き（world、正規化）
float flip_terrainSunVis(vec2 xz, vec3 dir){
  vec2 uv = flip_terrainUv(xz);
  vec4 a = texture2D(uTerrainHorizonA, uv);
  vec4 b = texture2D(uTerrainHorizonB, uv);
  float az = mod(atan(dir.z, dir.x) * 1.2732395 + 8.0, 8.0); // 0..8（+X から +Z 回り、45° 刻み）
  float i0 = floor(az);
  float f = az - i0;
  float h0 = flip_horizonPick(a, b, i0);
  float h1 = flip_horizonPick(a, b, mod(i0 + 1.0, 8.0));
  float horizon = mix(h0, h1, f) * 1.5707963;
  float elev = asin(clamp(dir.y, -1.0, 1.0));
  return smoothstep(horizon - 0.13, horizon + 0.07, elev); // 幅を 5.7° → 11.5°（1km 先の稜線の半影はこれくらい広い。地平角マップの段差も隠れる）
}

// 影の判定用の高さ（最近傍 1 タップ。バイリニアは要らないので flip_height より 4 倍安い）
float flip_heightPoint(vec2 xz){
  return texture2D(uHeightmap, xz * uHeightmapInfo.y + 0.5).r;
}

/** 針葉樹の天蓋のおおよその高さ（m）。林の密度 1 のところの木の高さ */
#define FLIP_CANOPY 18.0

/**
 * 遠景の太陽の遮蔽（0 = 影, 1 = 日なた）。CSM のシャドウマップが届かない外側を埋める。
 *   ① 地形の地平角（flip_terrainSunVis）… 山が落とす影。全距離に効く。
 *      地面より上にある点（木の梢など）は、その分だけ地平が下がって見えるので太陽を少し持ち上げて判定する。
 *   ② 「地形＋林の天蓋」を太陽方向へ 6 歩レイマーチ … 林が落とす帯。木 1 本ずつではなく林として。
 *      太陽が低いほど遡る距離 FLIP_CANOPY/tan(高度) が伸び、斜面に長い影が出る。
 * camDist はカメラからの距離（m）。近景は CSM が本物の落ち影を出すので ② は 90〜260m で徐々に効かせる。
 */
float flip_sunOcclusion(vec3 wp, vec3 sunDir, float camDist){
  if (sunDir.y <= 0.02) return 1.0;
  float ground = flip_heightPoint(wp.xz);
  float above = max(0.0, wp.y - ground);
  vec3 lifted = normalize(sunDir + vec3(0.0, above * 0.0033, 0.0));
  float vis = flip_terrainSunVis(wp.xz, lifted);
  vec2 hxz = sunDir.xz;
  float hl = length(hxz);
  if (hl < 1e-4) return vis; // 真上の太陽（林は帯を落とさない）
  vec2 dir = hxz / hl;
  float tanE = sunDir.y / hl;
  float reach = clamp(FLIP_CANOPY / tanE, 14.0, 420.0);
  // 太陽方向に 6 歩。天蓋が光線より上にある標本が 1 つでもあれば影（＝落ち影のマスク）。
  // 密度をそのまま暗さにすると弱すぎるので、まず「林らしさ 0..1」に伸ばしてから使う。
  float occ = 0.0;
  for (int i = 1; i <= 6; i++){
    float t = float(i) / 6.0;
    float d = reach * t;
    vec2 sxz = wp.xz + dir * d;
    float g = texture2D(uSunVeg, sxz * uHeightmapInfo.y + 0.5).g;
    float cov = smoothstep(0.02, 0.20, g); // 林らしさ（疎林でも木の丈は同じ）
    float canopy = flip_heightPoint(sxz) + FLIP_CANOPY * cov;
    float ray = wp.y + d * tanE;
    // 天蓋が光線より上にある分だけ効く（縁は 3m でぼかす）。
    // 影の先端ほど薄い（本物の長い影も、遠い遮蔽物ほど半影が広くて淡い）
    occ = max(occ, cov * smoothstep(-3.0, 3.0, canopy - ray) * (1.0 - 0.35 * t));
  }
  return vis * (1.0 - 0.88 * occ * smoothstep(70.0, 220.0, camDist));
}
#endif
`;
