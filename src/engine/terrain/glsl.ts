// 地形の GLSL。index.ts が MeshStandardMaterial / MeshDepthMaterial の各 #include を差し替える。
// 高さは flip_height（ハイトマップ）だけから取る。頂点をそれ以外で上下させない（草・木・水がずれる）。

/** 頂点シェーダ: <common> の後 */
export const TERRAIN_VERT_PARS = /* glsl */ `
#include <flip_height>
uniform float uStep;   // この環の格子間隔（m）
uniform float uHalf;   // この環の半径（m）
varying vec3 vFlipWorld;
`;

/**
 * 頂点シェーダ: <begin_vertex> の差し替え。
 * 環の外縁に近づくほど「ひとつ粗いレベルが描く線形補間の高さ」へ寄せる（割れ目とポッピングを消す）。
 * 粗い格子の偶奇は world 座標から決まる（各レベルは 2×格子間隔にスナップしているので）。
 */
export const TERRAIN_VERT_HEIGHT = /* glsl */ `
vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz;
float h = flip_height(wxz);
{
  float cheb = max(abs(position.x), abs(position.z));
  float morph = smoothstep(uHalf * 0.70, uHalf * 0.985, cheb);
  if (morph > 0.0) {
    vec2 par = mod(floor(wxz / uStep + 0.5), 2.0);
    if (par.x > 0.5 || par.y > 0.5) {
      vec2 o;
      if (par.x > 0.5 && par.y > 0.5) {
        // 粗い四角形の対角線の向きは (I+J) の偶奇で交互（buildRing と同じ規則）
        vec2 cI = floor(wxz / (2.0 * uStep));
        o = mod(cI.x + cI.y, 2.0) < 0.5 ? vec2(-uStep, uStep) : vec2(-uStep, -uStep);
      } else {
        o = par.x > 0.5 ? vec2(uStep, 0.0) : vec2(0.0, uStep);
      }
      float hc = 0.5 * (flip_height(wxz + o) + flip_height(wxz - o));
      h = mix(h, hc, morph);
    }
  }
}
vec3 transformed = vec3(position.x, h, position.z);
vFlipWorld = vec3(wxz.x, h, wxz.y);
`;

/** 頂点シェーダ: <beginnormal_vertex> の差し替え（影の normalBias に使う） */
export const TERRAIN_VERT_NORMAL = /* glsl */ `
vec3 objectNormal = flip_terrainNormalBaked((modelMatrix * vec4(position, 1.0)).xz);
`;

/** フラグメント: <common> の後 */
export const TERRAIN_FRAG_PARS = /* glsl */ `
#include <flip_noise>
#include <flip_height>
#include <flip_atmosphere>
#include <flip_flip>
uniform float uWetness;
uniform vec3 uWind;
uniform float uLakeLevel;
uniform sampler2D uHeightParts;
uniform float uDetail;
uniform float uTerrainDebug; // 調査用: 1 太陽の見え方 2 AO 3 法線 4 cavity 5 地平角A 6 影なし
varying vec3 vFlipWorld;

// 微分つきグラディエントノイズ: x = 値, yz = 勾配（ノイズ空間）
vec3 tn_gnoised(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = flip_hash22(i) * 2.0 - 1.0, gb = flip_hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = flip_hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, gd = flip_hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0)), vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0, 1.0));
  float k0 = vb - va, k1 = vc - va, k2 = va - vb - vc + vd;
  float v = va + u.x * k0 + u.y * k1 + u.x * u.y * k2;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * vec2(k0 + u.y * k2, k1 + u.x * k2);
  return vec3(v, d) * 1.4;
}
// 細胞ノイズ: x = 最近傍距離 F1, y = F2, z = セル id（小石・岩の割れ目）
vec3 tn_cell(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + flip_hash22(i + g) - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = flip_hash12(i + g); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
// 岩肌（2D の面）: x = 明るさ, y = 亀裂 0..1
vec2 tn_rockFace(vec2 p, float detail){
  float grain = flip_vfbm(p * 1.6, 2) - 0.5;
  float crack = 0.0;
  if (detail > 0.0) {
    vec3 c = tn_cell(p * 0.45);
    crack = (1.0 - smoothstep(0.0, 0.16, c.y - c.x)) * detail;
    grain += 0.3 * (c.z - 0.5) * detail; // ブロックごとに明るさが違う
  }
  return vec2(1.0 + 0.5 * grain, crack);
}
`;

/**
 * フラグメント: <clipping_planes_fragment> の直後。材質を全部ここで決めて
 * tCol / tRough / tAO / wN / tSunVis / tMoonVis に入れる（後の差し替えが使う）。
 */
export const TERRAIN_FRAG_MATERIAL = /* glsl */ `
vec3 tP = vFlipWorld;
vec2 tXZ = tP.xz;
float tDist = distance(tP, uCamPos);
vec4 tAux = texture2D(uTerrainAux, flip_terrainUv(tXZ));
vec3 gN;
{ vec2 n2 = tAux.rg * 2.0 - 1.0; gN = normalize(vec3(n2.x, sqrt(max(1.0 - dot(n2, n2), 0.0)), n2.y)); }
float tAO = tAux.b;
float tCav = tAux.a;
float tSlope = 1.0 - gN.y;
float tH = tP.y;
float tAbove = tH - uLakeLevel;
float tNear = (1.0 - smoothstep(20.0, 60.0 + 70.0 * uDetail, tDist)) * step(0.01, uDetail);
float tMid = 1.0 - smoothstep(120.0, 400.0 + 500.0 * uDetail, tDist);
float tMacro = flip_fbm(tXZ * 0.0016 + 4.0, 2);   // 数百 m の色むら（タイル感消し）
float tMeso = flip_gnoise(tXZ * 0.028 + 9.0);      // 36 m
float tPatch = flip_fbm(tXZ * 0.075 + 3.0, 2);     // 13 m の斑（枯れ草・土）

// ---- どの材質か（0..1 のマスク）----
float rockM = smoothstep(0.30, 0.45, tSlope + 0.07 * tMeso + 0.05 * tPatch);
rockM = max(rockM, smoothstep(330.0 + 90.0 * tMacro, 440.0 + 90.0 * tMacro, tH) * smoothstep(0.10, 0.28, tSlope + 0.1 * tMeso));
float screeM = smoothstep(0.17, 0.27, tSlope + 0.04 * tPatch) * (1.0 - rockM) * smoothstep(120.0, 260.0, tH + 60.0 * tMacro);
float dirtM = max(smoothstep(0.17, 0.30, tSlope + 0.05 * tMeso), 1.0 - smoothstep(0.22, 0.42, tCav)) * (1.0 - rockM) * (1.0 - screeM);
float lee = dot(gN.xz, normalize(uWind.xy + vec2(1e-4, 0.0))); // 風下斜面で正
float snowLine = 445.0 + 60.0 * tMacro - 35.0 * lee - 25.0 * tPatch;
float snowM = smoothstep(snowLine, snowLine + 45.0, tH) * (1.0 - smoothstep(0.40, 0.62, tSlope - 0.15 * lee));
float sandM = (1.0 - smoothstep(1.1 + 0.3 * tMeso, 1.55 + 0.3 * tMeso, tAbove)) * (1.0 - smoothstep(0.35, 0.6, tSlope));
float wetBand = 1.0 - smoothstep(0.0, 0.45, tAbove);

// ---- 色（線形）----
vec3 grass = mix(vec3(0.060, 0.125, 0.030), vec3(0.215, 0.185, 0.070), smoothstep(-0.25, 0.45, tPatch + 0.3 * tMeso));
grass *= 1.0 + 0.22 * tMacro;
grass = mix(grass, vec3(0.19, 0.165, 0.06), smoothstep(250.0, 420.0, tH)); // 高山草地は黄ばむ
vec3 dirt = vec3(0.105, 0.078, 0.052) * (1.0 + 0.2 * tMacro);
vec3 scree = vec3(0.19, 0.185, 0.175) * (0.85 + 0.3 * tMeso);
vec3 rock = vec3(0.17, 0.155, 0.14) * (1.0 + 0.25 * tMacro);
vec3 snow = vec3(0.70, 0.74, 0.80) * (0.92 + 0.12 * flip_vnoise(tXZ * 0.35 + 2.0));
vec3 sand = vec3(0.30, 0.27, 0.20) * (1.0 + 0.1 * tMeso);
vec3 wN = gN;

if (tNear > 0.0) {
  // 草: クローバーのような斑と細かい粒。砂: 粒と小石
  float clover = flip_vnoise(tXZ * 1.9 + 4.0);
  float grain = flip_vnoise(tXZ * 7.0 + 1.0);
  grass = mix(grass, vec3(0.040, 0.100, 0.028), 0.55 * smoothstep(0.5, 0.8, clover) * tNear);
  grass *= 1.0 + (0.35 * grain - 0.17) * tNear;
  vec3 pb = tn_cell(tXZ * 3.5);
  float pebble = (1.0 - smoothstep(0.15, 0.35, pb.x)) * step(0.72, pb.z);
  sand = mix(sand * (0.9 + 0.2 * grain), vec3(0.22, 0.21, 0.20) * (0.7 + 0.6 * pb.z), pebble * tNear);
  snow += 0.03 * tn_gnoised(tXZ * 1.2 + 5.0).x;
  // 細部の法線（草・土・砂）: 0.45m と 0.13m のこぶ
  vec3 d1 = tn_gnoised(tXZ * 2.2), d2 = tn_gnoised(tXZ * 7.5 + 3.0);
  vec2 g = d1.yz * (2.2 * 0.10) + d2.yz * (7.5 * 0.03);
  g *= (1.0 - rockM) * (1.0 - 0.6 * snowM) * (1.0 - 0.5 * sandM);
  wN = normalize(gN - vec3(g.x, 0.0, g.y) * gN.y * tNear);
}

if (rockM > 0.005 && tMid > 0.0) {
  // 岩: 層理（高さの帯）＋ トライプラナーの粒・亀裂 ＋ 面に沿ったバンプ
  vec3 w = pow(abs(gN), vec3(4.0));
  w /= (w.x + w.y + w.z);
  float strata = sin((tH + 3.5 * flip_gnoise(tXZ * 0.035)) * 0.85 + 1.5 * flip_gnoise(tXZ * 0.11));
  strata = smoothstep(-0.3, 0.9, strata);
  float det = tNear * uDetail;
  vec2 fx = tn_rockFace(tP.zy, det * step(0.15, w.x));
  vec2 fy = tn_rockFace(tP.xz, det * step(0.15, w.y));
  vec2 fz = tn_rockFace(tP.xy, det * step(0.15, w.z));
  float bright = fx.x * w.x + fy.x * w.y + fz.x * w.z;
  float crack = fx.y * w.x + fy.y * w.y + fz.y * w.z;
  rock *= mix(0.78, 1.15, strata) * bright * (1.0 - 0.5 * crack);
  rock = mix(rock, vec3(0.075, 0.105, 0.045), 0.6 * smoothstep(0.5, 0.75, tPatch) * (1.0 - smoothstep(0.25, 0.5, tSlope))); // 苔・地衣
  vec3 up = abs(gN.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, gN));
  vec3 B = cross(gN, T);
  vec2 pt = vec2(dot(tP, T), dot(tP, B));
  vec3 b1 = tn_gnoised(pt * 1.4 + 2.0), b2 = tn_gnoised(pt * 4.5 + 7.0);
  vec2 gb = (b1.yz * (1.4 * 0.16) + b2.yz * (4.5 * 0.05)) * tMid * (0.4 + 0.6 * tNear);
  vec3 rN = normalize(gN - (T * gb.x + B * gb.y));
  wN = normalize(mix(wN, rN, rockM));
}

vec3 tCol = grass;
tCol = mix(tCol, dirt, dirtM);
tCol = mix(tCol, scree, screeM);
tCol = mix(tCol, rock, rockM);
tCol = mix(tCol, snow, snowM);
tCol = mix(tCol, sand, sandM);
float tRough = mix(0.92, 0.80, dirtM);
tRough = mix(tRough, 0.85, screeM);
tRough = mix(tRough, 0.72, rockM);
tRough = mix(tRough, 0.55, snowM);
tRough = mix(tRough, 0.80, sandM);
// 水際の濡れ・雨の濡れ・水たまり
float wet = max(wetBand, uWetness * (1.0 - snowM));
tCol *= 1.0 - 0.42 * wet;
tRough = mix(tRough, 0.32, wet);
if (uWetness > 0.05) {
  float pud = smoothstep(0.58, 0.78, flip_fbm(tXZ * 0.11 + 1.0, 2) * 0.5 + 0.5 + 0.35 * (0.5 - tCav));
  pud *= (1.0 - smoothstep(0.015, 0.06, tSlope)) * uWetness * (1.0 - snowM) * (1.0 - rockM);
  tCol = mix(tCol, tCol * 0.55, pud);
  tRough = mix(tRough, 0.04, pud);
  wN = normalize(mix(wN, vec3(0.0, 1.0, 0.0), pud));
}
// 谷筋の陰と空の見え方
tCol *= 0.72 + 0.56 * tCav;
tAO = tAO * (0.85 + 0.3 * tCav);
// 山の影（地平角マップ）: 太陽と月それぞれ
float tSunVis = flip_terrainSunVis(tXZ, uSunDir);
float tMoonVis = flip_terrainSunVis(tXZ, uMoonDir);
if (uTerrainDebug > 5.5 && uTerrainDebug < 6.5) { tSunVis = 1.0; tMoonVis = 1.0; }
if (uTerrainDebug > 6.5 && uTerrainDebug < 7.5) { tSunVis = 1.0; }
if (uTerrainDebug > 7.5 && uTerrainDebug < 8.5) { tMoonVis = 1.0; }
`;

/** フラグメント: <normal_fragment_begin> の差し替え */
export const TERRAIN_FRAG_NORMAL = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
vec3 normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
vec3 nonPerturbedNormal = normal;
`;

/** フラグメント: <aomap_fragment> の差し替え（焼いた AO を間接光に） */
export const TERRAIN_FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= tAO;
reflectedLight.indirectSpecular *= tAO;
`;

/**
 * フラグメント: <fog_fragment> の差し替え。空気遠近 → 裏返し。
 * 裏返しは「合計の等高線（5m/25m）」＋「成分ごとの線の族」（山脈 20m・土台 4m・細部 0.5m）＋格子。
 * 成分は heightfield.ts が焼いた uHeightParts（r = 山脈, g = 土台, b = 細部, a = 岸線からの距離）。
 */
export const TERRAIN_FRAG_FOG = /* glsl */ `
gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, tP);
if (uFlipRadius > 0.001) {
  float fm = flip_mask(tP);
  vec4 parts = texture2D(uHeightParts, flip_terrainUv(tXZ));
  float pm = parts.r, pb = parts.g, pf = parts.b;
  vec3 fc = FLIP_BG * (0.75 + 0.6 * gN.y);
  float c5 = flip_line(tH / 5.0, 0.035) * (1.0 - smoothstep(0.2, 0.5, fwidth(tH / 5.0)));
  float c25 = flip_line(tH / 25.0, 0.06);
  float lm = flip_line(pm / 20.0, 0.07) * smoothstep(0.5, 3.0, pm);
  float lb = flip_line(pb / 4.0, 0.045) * (1.0 - smoothstep(0.2, 0.5, fwidth(pb / 4.0)));
  float lf = flip_line(pf / 0.5, 0.03) * (1.0 - smoothstep(0.2, 0.45, fwidth(pf / 0.5)));
  fc += FLIP_LINE * (0.55 * c25 + 0.2 * c5);
  fc += vec3(0.75, 0.95, 1.0) * 0.55 * lm;
  fc += FLIP_LINE * 0.28 * lb;
  fc += FLIP_LINE * 0.13 * lf;
  fc += FLIP_LINE * 0.08 * flip_grid(tXZ, 10.0) * (1.0 - smoothstep(200.0, 600.0, tDist));
  fc += FLIP_ACCENT * flip_edgeGlow(tP) * 1.5;
  fc = flip_applyAerial(fc, tP) * 0.7 + fc * 0.3;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, fm);
}
if (uTerrainDebug > 0.5 && uTerrainDebug < 5.5) {
  vec3 dbg = vec3(tSunVis);
  if (uTerrainDebug > 1.5) dbg = vec3(tAO);
  if (uTerrainDebug > 2.5) dbg = wN * 0.5 + 0.5;
  if (uTerrainDebug > 3.5) dbg = vec3(tCav);
  if (uTerrainDebug > 4.5) dbg = texture2D(uTerrainHorizonA, flip_terrainUv(tXZ)).rgb;
  gl_FragColor.rgb = dbg * 0.5;
}
`;

/**
 * three の lights_fragment_begin（CSM 版）に「山の影」を差し込む。
 * 影を落とす平行光（太陽のカスケード）には tSunVis、それ以外（月）には tMoonVis を掛ける。
 * 目印が見つからなければそのまま返す（山の影なしで動く）。
 */
export function injectTerrainShadow(chunk: string): string {
  const marker = "#if ( NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS)";
  const call = "getDirectionalLightInfo( directionalLight, directLight );";
  const idx = chunk.indexOf(marker);
  if (idx < 0 || !chunk.includes(call)) return chunk;
  const sun = chunk.slice(0, idx).split(call).join(`${call} directLight.color *= tSunVis;`);
  const moon = chunk.slice(idx).split(call).join(`${call} directLight.color *= tMoonVis;`);
  return sun + moon;
}
