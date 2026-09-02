// 大気。`#include <flip_atmosphere>`。
//
// 契約（全マテリアル共通）:
//   vec3 flip_skyColor(vec3 dir)                  … 空の放射輝度（雲なし、太陽の円盤なし）
//   vec4 flip_aerial(vec3 worldPos)               … rgb = 途中で足される散乱光, a = 透過率
//   vec3 flip_applyAerial(vec3 color, vec3 worldPos) … 物体色に空気遠近を掛ける
// 各マテリアルは最後の色に必ず flip_applyAerial を通す（MeshStandardMaterial なら fog_fragment の差し替え）。
//
// ここにあるのは土台の実装（解析的な空＋高さ指数の霧）。空モジュールが物理ベースのものに置き換える。
// 必要な uniforms: uSunDir, uSunColor, uMoonDir, uMoonColor, uCamPos, uFog, uCloud, uStorm, uHour（env.uniforms）。
export const FLIP_ATMOSPHERE = /* glsl */ `
#ifndef FLIP_ATMOSPHERE_INCLUDED
#define FLIP_ATMOSPHERE_INCLUDED
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uCamPos;
uniform float uFog;
uniform float uCloud;
uniform float uStorm;
uniform float uHour;

vec3 flip_skyColor(vec3 dir){
  float s = clamp(uSunDir.y, -0.2, 1.0);
  float day = smoothstep(-0.08, 0.25, s);
  float dusk = smoothstep(-0.12, 0.08, s) * (1.0 - smoothstep(0.08, 0.35, s));
  vec3 zenithDay = vec3(0.12, 0.30, 0.72);
  vec3 horizonDay = vec3(0.62, 0.74, 0.88);
  vec3 zenithNight = vec3(0.004, 0.006, 0.014);
  vec3 horizonNight = vec3(0.010, 0.014, 0.028);
  float h = clamp(dir.y, -0.05, 1.0);
  float t = pow(1.0 - h, 2.6);
  vec3 sky = mix(mix(zenithNight, zenithDay, day), mix(horizonNight, horizonDay, day), t);
  // 夕焼け: 太陽の周りの地平が赤く
  float sunDot = max(dot(dir, uSunDir), 0.0);
  vec3 duskColor = vec3(1.0, 0.42, 0.14);
  sky += duskColor * dusk * pow(1.0 - h, 6.0) * (0.35 + 0.65 * pow(sunDot, 3.0));
  // 太陽のハロー（Mie の代わり）
  sky += uSunColor * 0.012 * pow(sunDot, 14.0) * (1.0 + 4.0 * (1.0 - h));
  // 雲量・嵐で暗く灰色に
  float grey = clamp(uCloud * 0.7 + uStorm * 0.6, 0.0, 0.9);
  sky = mix(sky, vec3(dot(sky, vec3(0.33))) * vec3(0.9, 0.95, 1.0), grey);
  return sky;
}

vec4 flip_aerial(vec3 worldPos){
  vec3 d = worldPos - uCamPos;
  float dist = length(d);
  vec3 dir = d / max(dist, 1e-3);
  // 高さで薄くなる霧の密度を視線に沿って積分（解析）
  float base = 0.00026 * (0.35 + 1.4 * uFog);
  float falloff = 0.0035;
  float hc = uCamPos.y, hp = worldPos.y;
  float dh = hp - hc;
  float density;
  if (abs(dh) < 0.5) density = base * exp(-falloff * hc);
  else density = base * (exp(-falloff * hc) - exp(-falloff * hp)) / (falloff * dh);
  float od = density * dist;
  float T = exp(-od);
  vec3 skyHere = flip_skyColor(vec3(dir.x, max(dir.y, 0.02), dir.z));
  float sunDot = max(dot(dir, uSunDir), 0.0);
  vec3 inscatter = skyHere * 0.85 + uSunColor * 0.05 * pow(sunDot, 8.0);
  return vec4(inscatter * (1.0 - T), T);
}

vec3 flip_applyAerial(vec3 color, vec3 worldPos){
  vec4 a = flip_aerial(worldPos);
  return color * a.a + a.rgb;
}
#endif
`;
