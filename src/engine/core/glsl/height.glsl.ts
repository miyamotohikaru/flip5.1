// 地形ハイトマップの参照。`#include <flip_height>`。
// 必要な uniforms: uHeightmap, uHeightmapInfo（env.uniforms が持っている）。
export const FLIP_HEIGHT = /* glsl */ `
#ifndef FLIP_HEIGHT_INCLUDED
#define FLIP_HEIGHT_INCLUDED
uniform sampler2D uHeightmap;
uniform vec4 uHeightmapInfo; // x = worldSize, y = 1/worldSize, z = res, w = maxHeight
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
#endif
`;
