// 「裏返し」。`#include <flip_flip>`。
//
// 契約: 各マテリアルは最終色を
//   color = mix(color, <数式ビューの色>, flip_mask(worldPos));
// のように混ぜる。数式ビューは「青黒い紙に白青の線」で統一する（定数 FLIP_BG / FLIP_LINE / FLIP_ACCENT）。
// 必要な uniforms: uFlip, uFlipCenter, uFlipRadius, uTime（env.uniforms）。
export const FLIP_FLIP = /* glsl */ `
#ifndef FLIP_FLIP_INCLUDED
#define FLIP_FLIP_INCLUDED
#ifndef FLIP_NOISE_INCLUDED
float flip_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
#endif
uniform float uFlip;
uniform vec3 uFlipCenter;
uniform float uFlipRadius;
uniform float uTime;
const vec3 FLIP_BG = vec3(0.012, 0.020, 0.048);
const vec3 FLIP_LINE = vec3(0.55, 0.85, 1.0);
const vec3 FLIP_ACCENT = vec3(1.0, 0.72, 0.28);
// 0 = 普通の見た目, 1 = 数式ビュー。中心から広がる波の縁がやわらかい
float flip_mask(vec3 worldPos){
  float d = distance(worldPos, uFlipCenter);
  float edge = 12.0;
  float wave = 1.0 - smoothstep(uFlipRadius - edge, uFlipRadius + edge, d);
  return clamp(wave * step(0.001, uFlipRadius), 0.0, 1.0);
}
// 縁の光り（波の先端）: 幅 8〜15m の帯＋先行するリップル 3 本＋火花
float flip_edgeGlow(vec3 worldPos){
  float d = distance(worldPos, uFlipCenter);
  float on = step(0.001, uFlipRadius) * (1.0 - step(5990.0, uFlipRadius));
  float x = d - uFlipRadius; // 負: 通過済み, 正: これから
  float band = exp(-abs(x) / 6.0);
  float ripple = 0.0;
  for (int i = 1; i <= 3; i++) {
    float fi = float(i);
    ripple += exp(-abs(x - fi * 22.0) / 2.5) * (0.5 / fi);
  }
  float spark = flip_hash12(floor(worldPos.xz * 0.5) + floor(uTime * 8.0)) ;
  spark = step(0.965, spark) * exp(-abs(x) / 10.0) * 1.5;
  return (band + ripple + spark) * on;
}
// 細い線（アンチエイリアス付き）。v は等高線などの値、w は線の太さ（v の単位）
float flip_line(float v, float w){
  float f = abs(fract(v) - 0.5);
  float d = fwidth(v);
  return smoothstep(0.5 - w - d, 0.5 - w + d, f);
}
// 格子（world xz、間隔 s メートル）
float flip_grid(vec2 xz, float s){
  vec2 g = abs(fract(xz / s - 0.5) - 0.5) / fwidth(xz / s);
  float l = min(g.x, g.y);
  return 1.0 - clamp(l, 0.0, 1.0);
}
#endif
`;
