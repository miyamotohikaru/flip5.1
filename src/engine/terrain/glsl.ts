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
uniform sampler2D uTerrainField; // 焼いたノイズ場: r = マクロ, g = メソ, b = 林の密度, a = 岸線からの距離（(sd+20)/40）
uniform sampler2D uVegMap;       // 植生マップ（vegetation/vegmap.ts）: r = 草の密度, g = 林の密度, b = 乾き, a = 岩
uniform float uDetail;
uniform float uReflect;      // 1 = 映り込みカメラ（細部を省く）
uniform float uTerrainDebug; // 調査用: 1 太陽の見え方 2 AO 3 法線 4 cavity 5 地平角A 6 影なし 7 rgb=林/土/ガレのマスク 9 細部なし
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
// 等高線用の細い線。fwidth が 0 のとき（成分が定数の所）に core の flip_line が NaN になるのを避け、
// 間隔が画素より細かくなったら消す（潰れて面が白くならないように）
float tn_line(float v, float w){
  float d = max(fwidth(v), 1e-5);
  float f = abs(fract(v) - 0.5);
  float l = smoothstep(0.5 - w - d, 0.5 - w + d, f); // 整数値の近く（f ≈ 0.5）だけ 1 = 細い線
  return l * (1.0 - smoothstep(0.08, 0.3, d));
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
`;

/**
 * フラグメント: <clipping_planes_fragment> の直後。材質を全部ここで決めて
 * tCol / tRough / tAO / wN / tSunVis / tMoonVis に入れる（後の差し替えが使う）。
 */
export const TERRAIN_FRAG_MATERIAL = /* glsl */ `
vec3 tP = vFlipWorld;
vec2 tXZ = tP.xz;
float tDist = distance(tP, uCamPos);
vec2 tUv = flip_terrainUv(tXZ);
vec4 tAux = texture2D(uTerrainAux, tUv);
vec4 tF = texture2D(uTerrainField, tUv);
vec3 gN;
{ vec2 n2 = tAux.rg; gN = normalize(vec3(n2.x, sqrt(max(1.0 - dot(n2, n2), 0.0)), n2.y)); } // rg = 生の法線 xz（bake.ts は RGBA16F に焼く）
float tAO = tAux.b;
float tCav = tAux.a;
float tSlope = 1.0 - gN.y;
float tH = tP.y;
float tAbove = tH - uLakeLevel;
float tMacro = tF.r * 2.0 - 1.0;   // 数百 m の色むら（タイル感消し）
float tMeso = tF.g * 2.0 - 1.0;    // 36 m
float forestDens = tF.b;           // 250 m 単位の林と草地（遠景の樹冠のざらつき用。木の位置とは別の乱数）
float tShore = tF.a * 40.0 - 20.0; // 岸線からの距離（m、負が湖）
float tPatch = flip_fbm(tXZ * 0.075 + 3.0, 2); // 13 m の斑（枯れ草・土）
// 細部は大きさごとに別の距離で消す（画素より細かくなった模様は迷彩・水玉に見える）。映り込みでは全部省く
float detailOn = step(0.01, uDetail) * (1.0 - uReflect);
float dNear0 = (1.0 - smoothstep(2.0, 6.0 + 6.0 * uDetail, tDist)) * detailOn;   // 2〜8cm: 葉の筋・粒
float dNear1 = (1.0 - smoothstep(3.0, 7.0 + 8.0 * uDetail, tDist)) * detailOn;   // 10〜30cm: 株・小石
float dNear2 = (1.0 - smoothstep(4.0, 9.0 + 7.0 * uDetail, tDist)) * detailOn;     // 45cm: こぶ
float tNear = dNear2;
float tMid = (1.0 - smoothstep(110.0, 300.0 + 320.0 * uDetail, tDist)) * (1.0 - uReflect); // 岩の粒は 620m 先では 1px 未満。そこまでで切る
if (uTerrainDebug > 8.5 && uTerrainDebug < 9.5) { dNear0 = 0.0; dNear1 = 0.0; dNear2 = 0.0; tNear = 0.0; tMid = 0.0; } // 計測用

// ---- どの材質か（0..1 のマスク）。ゾーンは数百 m 単位（tMacro）で変える。細かい斑は迷彩に見えるので使わない ----
float rockM = smoothstep(0.28 + 0.06 * tMacro, 0.44 + 0.06 * tMacro, tSlope + 0.03 * tMeso);
float alpine = smoothstep(300.0 + 100.0 * tMacro, 480.0 + 100.0 * tMacro, tH);
rockM = max(rockM, alpine * smoothstep(0.10, 0.24, tSlope + 0.06 * tMacro));
float screeM = smoothstep(0.17, 0.27, tSlope + 0.04 * tPatch) * (1.0 - rockM) * smoothstep(120.0, 260.0, tH + 60.0 * tMacro);
float dirtM = max(smoothstep(0.15, 0.28, tSlope + 0.05 * tMeso), 1.0 - smoothstep(0.22, 0.42, tCav)) * (1.0 - rockM) * (1.0 - screeM);
// 土は斜面いちめんではなく斑で出す（一様に出ると尾根の草地が茶色い毛布になる）。
// λ36m の一段だけだと「ぼけた水彩」になるので、λ6m と λ1.5m の 2 段を足す（振幅 0.35）
float dirtFine = 0.0;
if (dirtM > 0.03 && tDist < 700.0) dirtFine = 0.35 * (flip_gnoise(tXZ * 0.17 + 29.0) + 1.1 * tPatch) * (1.0 - smoothstep(220.0, 700.0, tDist));
dirtM *= clamp(0.35 + 0.65 * smoothstep(-0.45, 0.45, tPatch + 0.7 * tMeso) + dirtFine, 0.0, 1.0);
vec2 tWind = normalize(uWind.xy + vec2(1e-4, 0.0));
float lee = dot(gN.xz, tWind); // 風下斜面で正
// 雪: 45°（tSlope 0.29）を超える面には積もらない＝急な岩壁は黒く出る。
// 吹き溜まり: 風下（lee）と窪み（tCav < 0.5）で雪線が下がり、風の当たる尾根（tCav > 0.5）では上がる
float snowLine = 448.0 + 60.0 * tMacro - 48.0 * lee - 25.0 * tPatch - 70.0 * (tCav - 0.5);
float snowM = smoothstep(snowLine, snowLine + 40.0, tH) * (1.0 - smoothstep(0.21, 0.33, tSlope - 0.09 * lee));
// 岸: 砂は水際だけ。幅を -1.2〜4.6m（＝砂の無い岸もある）を 3〜25m のノイズでうねらせ、
// 縁のぼけ幅と高さの上限も場所で変える（幅も縁も一定だと「プールの縁」に見える）。
// ノイズは水際の帯でだけ引く（全画素で 3 回引くと重い）
float bn1 = 0.0, bn2 = 0.0, bn3 = 0.0, sandM = 0.0, wetBand = 0.0;
if (tShore < 9.0 && tAbove < 3.5) { // 砂は tShore ≤ 6.5m・水面 +2.75m まで。範囲外でノイズを引かない
  bn1 = flip_gnoise(tXZ * 0.55 + 5.0);   // λ ≈ 1.8 m（縁のぎざぎざ）
  bn2 = flip_gnoise(tXZ * 0.17 + 11.0);  // λ ≈ 6 m（幅のうねり。25m だと遠景で幅が一定に見える）
  bn3 = flip_gnoise(tXZ * 0.055 + 17.0); // λ ≈ 18 m（浜と草の岸の入れ替わり）
  // 幅 1〜3m を主に λ6m で揺らす。λ36m（焼いた場 tMeso）で「浜のある入り江」と
  // 「草が水に落ちる岸」を数十 m 単位で切り替える（帯が途切れないと「プールの縁」になる）
  float beachW = 0.35 + 3.0 * smoothstep(-1.0, 1.0, 1.35 * bn2 + 0.8 * bn3 + 0.55 * bn1 + 0.3 * tPatch)
               - 0.9 * smoothstep(0.1, 0.6, bn3) - 2.4 * smoothstep(-0.30, 0.45, tMeso + 0.4 * tPatch);
  float beachEdge = 0.22 + 0.9 * smoothstep(-0.45, 0.45, bn2 + 0.7 * bn1); // 縁: 切り立つ所と砂が草に食い込む所
  float sandTop = 0.95 + 0.6 * bn2 + 0.35 * bn1;
  sandM = (1.0 - smoothstep(beachW - beachEdge, beachW + beachEdge, tShore + 0.45 * bn1))
        * (1.0 - smoothstep(sandTop, sandTop + 0.55, tAbove))
        * (1.0 - smoothstep(0.35, 0.6, tSlope));
  // 草が砂に舌のように食い込む（境が一本の弧だと「プールの縁」）
  sandM *= 1.0 - 0.85 * smoothstep(0.42, 0.78, flip_vnoise(tXZ * 0.55 + 13.0) + 0.35 * flip_vnoise(tXZ * 1.8 + 4.0) - 0.18);
  // 幅 1〜3m の帯は 150m 先で 1px 未満。そのまま残すと「岸をなぞった 1 本の線」になるので薄める
  float shoreFar = 1.0 - 0.6 * smoothstep(90.0, 320.0, tDist);
  sandM *= shoreFar;
  wetBand *= shoreFar;
  // 水際の濡れ: 高さで一律に切ると等高線の帯（＝プールの縁）になる。幅を 0.1〜0.9m に散らし、
  // 砂の帯とは別の位相にして「濡れ・砂利・草」の 3 本の平行線ができないようにする
  float wetTop = 0.14 + 0.75 * smoothstep(-0.7, 0.7, bn1 + 0.6 * bn2 - 0.4 * bn3);
  wetBand = 1.0 - smoothstep(-0.04, wetTop, tAbove);
  // 高さだけで切ると等高線の帯になるので、水際からの「距離」でも減衰させる
  wetBand *= 1.0 - smoothstep(0.0, 1.4 + 1.8 * (bn2 + 0.5 * bn1 + 0.5), tShore);
}
// 林の密度は植生マップ（G）＝木を実際に置いた密度を正とする。
// 地形の焼いた場（tF.b）は別の乱数なので、それで判断すると「木の下なのに草原の色」になる。
// 512²（8m/texel）の線形補間なので縁はなだらか。植生が無い（?dbg=noveg）ときは 0 で草原のまま
vec4 tVeg = texture2D(uVegMap, tUv);
float forest = tVeg.g;
// 林床の効き。まばらな林（0.3 前後）では草が残り、密な林（0.8 超）で完全に腐植の床になる。
// 縁は 13m/36m の斑で崩すので境界が線に見えない
float fFloor = smoothstep(0.34, 0.94, forest + 0.14 * tPatch + 0.10 * tMeso);

// ---- 色（線形）----
// 枯れ草の斑: 13m の斑は数百 m のゾーン（tMacro）の中でだけ強く出す（中景が迷彩に見えないように）
float dryZone = smoothstep(-0.2, 0.5, tMacro);
vec3 grass = mix(vec3(0.050, 0.115, 0.025), vec3(0.19, 0.165, 0.065), smoothstep(-0.25, 0.45, tPatch + 0.3 * tMeso) * (0.25 + 0.5 * dryZone));
grass *= 1.0 + 0.30 * tMacro + 0.13 * tMeso; // 数百m と 36m のむら。一色の斜面は「ゴルフ場」に見える
grass = mix(grass, vec3(0.19, 0.165, 0.06), smoothstep(250.0, 420.0, tH)); // 高山草地は黄ばむ
// 林帯（10〜400m、緩斜面）: 木の下の暗い床。遠景では樹冠のざらつき
// 林床。針葉樹の下は「草原の色」ではない: 落ち葉（針葉のリター）と腐植の色に寄せ、
// 日が差さないぶん彩度を落とし、林が濃いほど暗くする。
// 縁は植生マップの補間に 13m/36m の斑を足して崩すので、境界が線に見えない
float tCanopy = 1.0; // 樹冠が直達光を遮る割合（1 = 素通り）
if (fFloor > 0.0005) {
  float fLitter = flip_vnoise(tXZ * 0.42 + 21.0);
  // 針葉のリター（赤茶）→ 腐植（黒に近い茶）。斑のスケールを変えて「絵の具」に見せない。
  // 彩度は落とさない: 灰色に寄せると（前回やっていた）AgX の脱色と合わさって「砂」に見える
  vec3 duff = mix(vec3(0.074, 0.051, 0.023), vec3(0.028, 0.019, 0.011),
                  smoothstep(0.18, 0.80, fLitter + 0.4 * tPatch));
  // 苔とまばらな下草（濃い緑）が斑で混じる
  duff = mix(duff, vec3(0.026, 0.046, 0.017), 0.85 * smoothstep(-0.35, 0.62, tMeso + 0.8 * tPatch + 0.5 * fLitter)); // 苔と下草の緑を厚めに（茶一色だと泥に見える）
  duff *= 1.0 + 0.16 * tMacro;
  grass = mix(grass, duff, min(1.0, 2.5 * fFloor));
  // 樹冠の下は空が見えない。さらに λ12m の「木が混んで暗い溜まり」を作る
  // （一様に明るいと、いくら暗くしても砂丘の陰影に見える）
  float shade = smoothstep(-0.35, 0.55, tMeso + 0.6 * tPatch);
  grass *= 1.0 - (0.16 + 0.22 * shade) * fFloor; // 暗さの大半は下の tCanopy（直達光を遮る）が持つ
  // 根元（植生マップ r = 草の密度。木を置いた texel は薄くしてある）ほどわずかに暗い
  grass *= 1.0 - 0.16 * fFloor * smoothstep(0.30, 0.02, tVeg.r);
  // 遠景の樹冠のざらつき（近景では草・幹が描くので出さない）
  if (tNear < 0.99) grass *= 1.0 - 0.24 * fFloor * fLitter * (1.0 - tNear);
  // 木漏れ日: 林が濃いほど直達光が届かない。CSM の落ち影は 200m ほどで尽きるので、
  // それより遠い林床が「日なたの砂」になっていた。斑（2.4m）で木漏れ日にする
  tCanopy = 1.0 - 0.55 * fFloor * smoothstep(0.90, 0.20, fLitter + 0.45 * tPatch);
}
// 中景（10〜60m）: 丈の高い草の群れ（2m）のやわらかい明暗
if (tDist < 160.0 && uReflect < 0.5) grass *= 1.0 + 0.16 * flip_fbm(tXZ * 0.55 + 8.0, 2) * (1.0 - smoothstep(60.0, 160.0, tDist));
// 枯れ草・落ち葉のリター（株の間から見える地面）。λ 3.5m の斑で 70m まで。
// これが無いと地面が「一色の緑の絵の具」になる
if (tDist < 70.0 && uReflect < 0.5) {
  float lit = smoothstep(0.42, 0.86, flip_vnoise(tXZ * 0.29 + 17.0) + 0.45 * tPatch) * (1.0 - smoothstep(28.0, 70.0, tDist));
  grass = mix(grass, vec3(0.155, 0.125, 0.062), 0.5 * lit * (1.0 - fFloor)); // 林床は下の duff が持つ
}
vec3 dirt = vec3(0.105, 0.078, 0.052) * (1.0 + 0.2 * tMacro);
vec3 scree = vec3(0.19, 0.185, 0.175) * (0.85 + 0.3 * tMeso);
vec3 rock = vec3(0.17, 0.155, 0.14) * (1.0 + 0.25 * tMacro);
vec3 snow = vec3(0.60, 0.64, 0.71);
vec3 snowN = gN;
if (snowM > 0.001) {
  snow *= 0.92 + 0.12 * flip_vnoise(tXZ * 0.35 + 2.0);
  // 風下に伸びる吹き溜まりの畝（λ 55m / 20m）。1〜2km 先でも 20〜60px あるので雪の起伏が読める。
  // これが無いと遠景の雪が「メレンゲ」＝一様な白い塊になる
  vec2 sa = vec2(dot(tXZ, tWind), dot(tXZ, vec2(-tWind.y, tWind.x)));
  vec2 f0 = vec2(0.018, 0.055), f1 = vec2(0.20, 0.62), f2 = vec2(0.42, 1.15);
  vec3 s0 = tn_gnoised(sa * f0 + 1.0);
  float dFade = 1.0 - smoothstep(2400.0, 3400.0, tDist);
  vec2 gs = s0.yz * f0 * 9.0 * dFade;
  float sx = 0.0;
  // サスツルギ（風紋）: 風向に細長い λ 5m と 2.4m の畝。近〜中景だけ（遠景では 1px 未満で意味がない）
  float sFade = (1.0 - smoothstep(700.0, 1800.0, tDist)) * (1.0 - uReflect);
  if (sFade > 0.01) {
    vec3 s1 = tn_gnoised(sa * f1 + 3.0);
    vec3 s2 = tn_gnoised(sa * f2 + 8.0);
    gs += (s1.yz * f1 * 0.26 + s2.yz * f2 * 0.09) * sFade;
    sx = (0.08 * s1.x + 0.04 * s2.x) * sFade;
  }
  vec2 gw = tWind * gs.x + vec2(-tWind.y, tWind.x) * gs.y;
  snowN = normalize(gN - vec3(gw.x, 0.0, gw.y) * gN.y);
  // 畝の谷は青く沈む（雪の透光）。風上側の斜面は硬く光る
  snow *= 1.0 + 0.13 * s0.x * dFade + sx;
  snow = mix(snow, vec3(0.50, 0.57, 0.72), 0.35 * smoothstep(0.15, -0.40, s0.x * 1.2 + 6.0 * sx) * dFade);
  // 吹き溜まりの縁（雪と岩の境）を波打たせる: 薄い所は下地が透ける
  snowM *= 0.55 + 0.45 * smoothstep(-0.60, 0.60, s0.x * 2.0 + 12.0 * sx + tMeso + 0.5 * tPatch);
}
// 砂利まじりの砂: 1〜3m の濃淡と、水際に近いほど暗く湿った砂利
vec3 sand = vec3(0.122, 0.113, 0.096) * (1.0 + 0.18 * tMeso); // 高山湖の岸は灰色の砂利。日なたの草より暗くする（明るいと岸を縁取る「線」になる）
if (sandM > 0.001) {
  sand *= 0.8 + 0.4 * flip_vnoise(tXZ * 0.7 + 4.0);
  sand = mix(sand, vec3(0.16, 0.16, 0.15), 0.5 * smoothstep(0.55, 0.8, flip_vnoise(tXZ * 2.5 + 1.0)) * (1.0 - smoothstep(0.0, 6.0, tShore)));
  // 水際の砂利は濡れて暗い（乾いた砂 → 濡れた砂 → 湖底 がつながる）
  sand = mix(sand, sand * 0.52, wetBand);
  // 湖底: 深いほど暗く、沈殿・藻のむらを入れる（一様に明るい灰色は「プールの底」に見える）
  if (tAbove < 0.1) {
    float dep = -tAbove;
    sand *= 0.80 + 0.45 * flip_fbm(tXZ * 0.16 + 7.0, 2) + 0.25 * flip_vnoise(tXZ * 0.045 + 12.0);
    sand = mix(sand, vec3(0.070, 0.086, 0.062), smoothstep(0.5, 5.0, dep)); // 岸ぎわで急に暗くすると水際が線に見える
  }
}
vec3 wN = normalize(mix(gN, snowN, snowM));

if (tNear > 0.0) {
  // 草の株: 30cm の房のなだらかなドーム（境界の線は出さない）。株ごとに色が少し違う
  float dome = flip_vnoise(tXZ * 3.3 + 1.0);
  float hue = flip_vnoise(tXZ * 1.7 + 6.0);
  float gDet = 1.0 - 0.88 * fFloor; // 林床には草の株・葉の模様を出さない（明るく戻ってしまう）
  grass *= 1.0 + (0.45 * dome - 0.2 + 0.25 * (hue - 0.5)) * dNear1 * gDet;
  // 葉の筋（2〜5cm、風向きに少し伸びる）と粒
  vec2 wdir = normalize(uWind.xy + vec2(1e-4, 0.0));
  vec2 xa = vec2(dot(tXZ, wdir), dot(tXZ, vec2(-wdir.y, wdir.x)));
  float blades = flip_vfbm(xa * vec2(16.0, 42.0) + 5.0, 2);
  float edge = 1.0 - abs(flip_gnoise(xa * vec2(14.0, 40.0) + 9.0)); // 葉の縁が光る細い筋
  edge = edge * edge * edge;
  float grain = flip_vnoise(tXZ * 30.0 + 1.0);
  grass *= 1.0 + ((0.8 * blades - 0.4 + 0.5 * edge) * dNear0 + (0.4 * grain - 0.2) * dNear1) * gDet;
  // 土が透ける斑（房の間・踏み跡）
  // 林床の細部: 針葉・小枝・落ち枝の粒（草の株・葉の模様の代わり。上の dome / grain を使い回す）
  if (fFloor > 0.01) grass *= 1.0 + ((0.70 * dome - 0.34) * dNear2 + (0.55 * grain - 0.27) * dNear0) * fFloor;
  // 房の間の土（踏み跡）。林床では腐植の色（草地の土より暗い）
  vec3 soil = mix(vec3(0.075, 0.055, 0.035), vec3(0.036, 0.028, 0.018), fFloor) * (0.8 + 0.4 * grain);
  float bare = smoothstep(0.58, 0.8, flip_vnoise(tXZ * 0.9 + 2.0)) * (1.0 - 0.7 * dome);
  grass = mix(grass, soil, 0.5 * bare * dNear1);
  // 砂: 粒と小石（水際ほど多い）
  if (sandM > 0.005) {
    vec3 pb = tn_cell(tXZ * 3.5);
    float pebble = (1.0 - smoothstep(0.15, 0.35, pb.x)) * step(0.55 + 0.3 * smoothstep(0.0, 6.0, tShore), pb.z);
    sand = mix(sand * (0.85 + 0.3 * grain * dNear0), vec3(0.22, 0.21, 0.20) * (0.7 + 0.6 * pb.z), pebble * dNear1);
  }
  if (snowM > 0.001) snow += 0.03 * tn_gnoised(tXZ * 1.2 + 5.0).x * dNear2;
  // 細部の法線（草・土・砂）: 0.45m / 0.13m / 0.08m のこぶ。大きさごとに別の距離で消す
  vec3 d1 = tn_gnoised(tXZ * 2.2), d2 = tn_gnoised(tXZ * 7.5 + 3.0), d3 = tn_gnoised(tXZ * 13.0 + 9.0);
  // 13cm / 8cm のこぶは低い太陽で「風紋」に見え、林床では砂丘そのものになる。林床では 45cm の
  // うねり（根・落ち葉の盛り上がり）だけ残す
  float fineB = 1.0 - 0.85 * fFloor;
  vec2 g = d1.yz * (2.2 * 0.03) * dNear2 + (d2.yz * (7.5 * 0.02) * dNear1 + d3.yz * (13.0 * 0.01) * dNear0) * fineB;
  // 太陽が低いと小さなこぶの陰影が画素より細かい斑点になるので弱める
  g *= (1.0 - rockM) * (1.0 - 0.6 * snowM) * (1.0 - 0.5 * sandM) * (0.45 + 0.55 * smoothstep(0.05, 0.45, uSunDir.y));
  wN = normalize(wN - vec3(g.x, 0.0, g.y) * gN.y);
}

if (rockM > 0.01 || screeM > 0.06) {
  // 岩。遠景（山肌）にも効く層理・段・亀裂と、近景だけのトライプラナーの粒・ブロック割れ。
  // 層理の帯は 7m 周期・段（ledge）は 6〜12m 周期で、1500m 先でも 8px 幅あるので迷彩にならない
  float farFade = 1.0 - smoothstep(1900.0, 3200.0, tDist);
  // 層理面は褶曲で波打つ。まっすぐ水平な縞が全山を走ると「等高線の模型」に見えるので、
  // 600m 単位の傾き（tMacro）と λ36m の褶曲（tMeso）と λ13m のゆらぎ（tPatch）で帯を折り曲げる。
  // どれも焼いた場（uTerrainField / fbm 1 回）の使い回しで、山肌はノイズを追加で引かない
  float bedH = tH + 34.0 * tMacro + 13.0 * tMeso;
  // 縞は 700m 以遠で消す（1km 先の細い縞はモアレ＝毛羽立った地図に見える）
  float bedA = smoothstep(-0.42, 0.22, tMacro) * (1.0 - smoothstep(600.0, 1500.0, tDist));
  float strata = smoothstep(-0.3, 0.9, sin(bedH * 0.85 + 1.7 * tPatch));
  // 雨水の流れた黒い筋（岩壁を縦に走る）。斜面が急なほど濃い。遠景の山肌のコントラストはこれと tMeso で作る
  float streakM = smoothstep(0.20, 0.45, tSlope) * farFade;
  float streak = 0.0;
  if (streakM > 0.01) {
    streak = 1.0 - abs(flip_gnoise(vec2(dot(tXZ, vec2(0.36, -0.93)) * 0.05, tH * 0.0035) + 14.0));
    streak = streak * streak * streak * streakM;
  }
  float mott = tMeso + 0.55 * tPatch;
  rock *= mix(1.0, mix(0.55, 1.25, strata), bedA) * (1.0 + 0.45 * mott * farFade) * (1.0 - 0.30 * streak);
  // 岩の色みも場所で振る（曇天は陰影が無いので、明暗だけだと山肌が粘土に見える）
  rock = mix(rock, rock * vec3(1.18, 1.03, 0.80), 0.55 * smoothstep(-0.1, 0.55, tMacro + 0.4 * tPatch) * farFade);
  rock = mix(rock, rock * vec3(0.88, 0.93, 1.04), 0.45 * smoothstep(-0.1, 0.55, -tMacro + 0.4 * tMeso) * farFade);
  // 急斜面（斜度 0.5 超）: 6〜12m 間隔の段（棚）と、面を縦に走る亀裂。albedo は薄く、法線で見せる
  float steep = smoothstep(0.42, 0.62, tSlope) * bedA;
  float ledge = 0.0, vcr = 0.0, ledgeS = 0.0;
  if (steep > 0.01) {
    float bandP = 9.0 + 3.0 * tMeso;
    float bh = fract((bedH + 3.0 * tPatch) / bandP) - 0.5;
    ledge = (1.0 - smoothstep(0.10, 0.44, abs(bh) * 2.0)) * steep;
    ledgeS = bh < 0.0 ? 1.0 : -1.0;
    // 縦の亀裂: 水平方向の位置でだけ変わる（高さにはゆっくり）＝壁を縦に走る溝。λ ≈ 8m
    vcr = 1.0 - abs(flip_gnoise(vec2(dot(tXZ, vec2(0.92, 0.39)) * 0.125, tH * 0.010) + 5.0));
    vcr = vcr * vcr * vcr * vcr * smoothstep(0.42, 0.62, tSlope) * farFade;
  }
  rock *= (1.0 - 0.17 * ledge) * (1.0 - 0.22 * vcr);
  float grain = 0.0, crack = 0.0;
  if (tMid > 0.0) {
    vec3 w = pow(abs(gN), vec3(4.0));
    w /= (w.x + w.y + w.z);
    grain = ((flip_vnoise(tP.zy * 1.6) * w.x + flip_vnoise(tP.xz * 1.6) * w.y + flip_vnoise(tP.xy * 1.6) * w.z) - 0.5) * tMid;
    float det = dNear1 * uDetail;
    if (det > 0.0) {
      vec2 pc = w.x > w.y ? (w.x > w.z ? tP.zy : tP.xy) : (w.y > w.z ? tP.xz : tP.xy);
      vec3 c = tn_cell(pc * 0.45);
      crack = (1.0 - smoothstep(0.0, 0.16, c.y - c.x)) * det;
      grain += 0.3 * (c.z - 0.5) * det; // ブロックごとに明るさが違う
    }
  }
  rock *= (1.0 + 0.5 * grain) * (1.0 - 0.5 * crack);
  scree *= mix(1.0, mix(0.80, 1.15, strata), 0.7 * bedA) * (1.0 + 0.35 * grain) * (1.0 + 0.20 * mott * farFade);
  // 苔・地衣: 緩い岩の窪みに。遠くでは斑が迷彩に見えるので薄める
  rock = mix(rock, vec3(0.075, 0.105, 0.045), 0.55 * smoothstep(0.35, 0.7, tPatch + 0.5 * (0.5 - tCav)) * (1.0 - smoothstep(0.25, 0.5, tSlope)) * (0.35 + 0.65 * tMid));
  // 法線: 段は遠景でも入れる（山肌が粘土に見えないように）。細かいバンプは近景だけ。
  // どちらも無い遠景では接平面を作らずに飛ばす（山肌は画面の広い面積を占めるので効く）
  if (steep > 0.01 || tMid > 0.0) {
    vec3 up = abs(gN.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(up, gN));
    vec3 B = cross(gN, T);
    vec2 pt = vec2(dot(tP, T), dot(tP, B));
    // 段は「高さ方向」に折れる。B は面に沿った上下方向なので B 成分を動かす（albedo より法線で見せる）
    vec2 gb = vec2(0.0, ledgeS * ledge * 0.30);
    if (tMid > 0.0) {
      // 太陽が低いとバンプの陰影が強すぎて岩が「濡れたプラスチック」に見えるので弱める（地面の細部と同じ扱い）
      float bAmp = 0.5 + 0.5 * smoothstep(0.03, 0.30, uSunDir.y);
      vec3 b1 = tn_gnoised(pt * 1.4 + 2.0);
      gb += b1.yz * (1.4 * 0.16) * tMid * (0.4 + 0.6 * dNear2) * bAmp;
      if (dNear1 > 0.0) gb += tn_gnoised(pt * 4.5 + 7.0).yz * (4.5 * 0.05) * dNear1 * bAmp;
    }
    vec3 rN = normalize(gN - (T * gb.x + B * gb.y));
    wN = normalize(mix(wN, rN, max(rockM, 0.55 * screeM)));
  }
}

vec3 tCol = grass;
tCol = mix(tCol, dirt, dirtM);
tCol = mix(tCol, scree, screeM);
tCol = mix(tCol, rock, rockM);
tCol = mix(tCol, snow, snowM);
tCol = mix(tCol, sand, sandM);
float tRough = mix(0.92, 0.80, dirtM);
tRough = mix(tRough, 0.85, screeM);
tRough = mix(tRough, 0.82, rockM); // 0.72 は低い太陽で岩がプラスチックのように光った
tRough = mix(tRough, 0.80, snowM); // 0.55 は艶が出すぎて「メレンゲ」に見えた
tRough = mix(tRough, 0.80, sandM);
// 水際の濡れ・雨の濡れ・水たまり
float wet = max(wetBand, uWetness * (1.0 - snowM));
tCol *= 1.0 - 0.32 * wet; // 0.42 は水際に一定幅の暗い帯を作っていた
tRough = mix(tRough, 0.32, wet);
if (uWetness > 0.05) {
  float pud = smoothstep(0.58, 0.78, flip_fbm(tXZ * 0.11 + 1.0, 2) * 0.5 + 0.5 + 0.35 * (0.5 - tCav));
  pud *= (1.0 - smoothstep(0.015, 0.06, tSlope)) * uWetness * (1.0 - snowM) * (1.0 - rockM);
  tCol = mix(tCol, tCol * 0.55, pud);
  tRough = mix(tRough, 0.04, pud);
  wN = normalize(mix(wN, vec3(0.0, 1.0, 0.0), pud));
}
// 谷筋の陰と空の見え方。
// cavity は「窪みの底ほど暗い」。谷筋（tCav < 0.4）を強めに効かせ、尾根（> 0.6）は明るく残す
float cavD = smoothstep(0.62, 0.16, tCav);           // 0 = 尾根・平ら, 1 = 谷底
tCol *= 1.0 - 0.42 * cavD;
// 焼いた AO は空の照度にだけ掛かる。谷で効かせつつ 0.28 を下限に（影の中が真っ黒にならない）
tAO = 0.28 + 0.72 * tAO * tAO * (1.0 - 0.45 * cavD);
// 山の影（地平角マップ）: 太陽と、夜だけ月
float tSunVis = flip_terrainSunVis(tXZ, uSunDir) * tCanopy;
float tMoonVis = ((uMoonColor.r + uMoonColor.g + uMoonColor.b > 0.0005) ? flip_terrainSunVis(tXZ, uMoonDir) : 1.0) * tCanopy;
if (uTerrainDebug > 5.5 && uTerrainDebug < 6.5) { tSunVis = 1.0; tMoonVis = 1.0; }
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
 * 裏返しは「合計の等高線（10m 副線 / 50m 主線、太さ 4:1）」＋「成分ごとの細い線の族」（山脈 20m・土台 8m・細部 0.5m）＋格子。
 * 成分は heightfield.ts が焼いた uHeightParts（r = 山脈, g = 土台, b = 細部, a = 岸線からの距離）。
 */
export const TERRAIN_FRAG_FOG = /* glsl */ `
gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, tP);
if (uFlipRadius > 0.001) {
  float fm = flip_mask(tP);
  vec4 parts = texture2D(uHeightParts, tUv);
  float pm = parts.r, pb = parts.g, pf = parts.b;
  // 紙: 青黒。斜面の向きでごく薄く陰影をつけて形が読めるように
  vec3 fc = FLIP_BG * (0.7 + 0.5 * gN.y + 0.6 * max(dot(gN, uSunDir), 0.0) * tSunVis);
  // 細かい族ほど手前だけ（遠くで密になって面が白くならないように）。25m の等高線だけ遠くまで残す
  float far = 1.0 - 0.6 * smoothstep(300.0, 2200.0, tDist);
  float midR = 1.0 - smoothstep(600.0, 1500.0, tDist);
  float nearR = 1.0 - smoothstep(200.0, 700.0, tDist);
  // 等高線: 10m ごとの副線（細）と 50m ごとの主線（太さ 4:1）。
  // 5m 間隔で同じ太さだと「バーコード」に見える
  float cMinor = tn_line(tH / 10.0, 0.010) * nearR;
  float cMajor = tn_line(tH / 50.0, 0.040);
  // 成分の族はさらに細く（合計の等高線を邪魔しない）
  float lm = tn_line(pm / 20.0, 0.022) * smoothstep(0.5, 3.0, pm) * midR;
  float lb = tn_line(pb / 8.0, 0.016) * nearR;
  float lf = tn_line(pf / 0.5, 0.012) * (1.0 - smoothstep(40.0, 120.0, tDist));
  fc += FLIP_LINE * (0.90 * cMajor + 0.35 * cMinor) * far; // 主線 3px a0.9 / 副線 1px a0.35（太さも明るさも 4:1 弱）
  fc += vec3(0.75, 0.95, 1.0) * 0.34 * lm;
  fc += FLIP_LINE * 0.18 * lb;
  fc += FLIP_LINE * 0.10 * lf;
  fc += FLIP_LINE * 0.08 * flip_grid(tXZ, 10.0) * (1.0 - smoothstep(200.0, 500.0, tDist));
  fc += FLIP_ACCENT * flip_edgeGlow(tP) * 1.5;
  // 紙には空気遠近の透過率だけを効かせ、散乱光は 3 割（白く霞ませない）
  vec4 aer = flip_aerial(tP);
  fc = fc * aer.a + aer.rgb * 0.3;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, fm);
}
if ((uTerrainDebug > 0.5 && uTerrainDebug < 5.5) || (uTerrainDebug > 6.5 && uTerrainDebug < 8.5)) {
  vec3 dbg = vec3(tSunVis);
  if (uTerrainDebug > 1.5) dbg = vec3(tAO);
  if (uTerrainDebug > 2.5) dbg = wN * 0.5 + 0.5;
  if (uTerrainDebug > 3.5) dbg = vec3(tCav);
  if (uTerrainDebug > 4.5) dbg = texture2D(uTerrainHorizonA, tUv).rgb;
  if (uTerrainDebug > 6.5 && uTerrainDebug < 7.5) dbg = vec3(fFloor, dirtM, screeM);
  if (uTerrainDebug > 7.5 && uTerrainDebug < 8.5) dbg = tCol * 6.0; // 地色（照明抜き）を 6 倍で
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
