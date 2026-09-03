// 地形ハイトマップの参照。`#include <flip_height>`。
// 必要な uniforms: uHeightmap, uHeightmapInfo（env.uniforms が持っている）。
// 追加（地形担当が起動時に焼く。env.uniforms の uTerrainAux / uTerrainHorizonA / uTerrainHorizonB）:
//   flip_terrainNormalBaked(xz) … 焼いた法線（3×3 Sobel、texel 精度。近景の細部は各モジュールが足す）
//   flip_terrainAO(xz)          … 空の見え方 0..1（谷底で小さい）。間接光に掛ける
//   flip_terrainCavity(xz)      … 谷筋の陰 0..1（0.5 = 平ら、小さいほど窪み）
//   flip_terrainSunVis(xz, dir) … その地点から光源 dir（光の来る向き）が山に隠れていないか 0..1
export const FLIP_HEIGHT = /* glsl */ `
#ifndef FLIP_HEIGHT_INCLUDED
#define FLIP_HEIGHT_INCLUDED
uniform sampler2D uHeightmap;
uniform vec4 uHeightmapInfo; // x = worldSize, y = 1/worldSize, z = res, w = maxHeight
uniform sampler2D uTerrainAux;
uniform sampler2D uTerrainHorizonA;
uniform sampler2D uTerrainHorizonB;
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
// 地形の地平角による光源の見え方（0 = 山の影, 1 = 日なた）。dir は光の来る向き（world、正規化）。
// 木・草の「山の影」にも使える。使うときの前提（terrain/bake.ts が焼いている中身）:
//   ・解像度 high 1536²（2.7m/texel）／mid・low 1024²（4m/texel）。線形補間なので影の縁は
//     texel 幅ぶんぼける。山の影の半影は 1km 先で 9m なので、この粗さは物理的に妥当
//   ・方位は 8 方向（45°刻み）を線形補間。大きな山塊は正しく、単独の尖峰は方位方向に ±22.5° 滲む
//   ・地平角は「地面 +1.5m」の点で焼いてある。高さ h の樹冠はもっと低い地平を見るので、
//     木に使うときは dir.y を少し持ち上げる（例 dir.y + h/1500）と過剰な影を避けられる
//   ・射程 high 4.9km ／ mid 2.5km（世界は 4km 四方）
//   ・遷移幅は 11.5°（半影の代用）。これより硬い影が要るなら CSM を使うこと
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
#endif
`;
