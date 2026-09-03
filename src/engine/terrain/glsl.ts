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
uniform sampler2D uTerrainField; // 焼いたノイズ場: r = マクロ(λ625m), g = メソ(λ36m), b = 斑(λ13m), a = 岸線からの距離（(sd+20)/40）
uniform sampler2D uVegMap;       // 植生マップ（vegetation/vegmap.ts）: r = 草の密度, g = 林の密度, b = 乾き, a = 岩
uniform vec4 uSeedWorld;     // 世界の体格（core/height.ts）: x = 雪線のずれ(m)
uniform float uDetail;
uniform float uReflect;      // 1 = 映り込みカメラ（細部を省く）
uniform float uTerrainDebug; // 調査用: 1 太陽の見え方 2 AO 3 法線 4 cavity 5 地平角A 6 影なし 7 rgb=林床/土/ガレ 8 地色 9 細部なし 12 rgb=砂/土/ガレ 13 距離帯 14 画素の足跡
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
// 画素幅で太さを決める線。値の幅（tn_line）で決めると、距離と傾きで太さが変わって
// 「主線 3px / 副線 1px」の 4:1 が画の中で消えてしまう（批評R2→R3 で未達だった原因）
float tn_linePx(float v, float px){
  float d = max(fwidth(v), 1e-5);
  float f = abs(fract(v) - 0.5);
  float w = min(px * d * 0.5, 0.42);
  float aa = d * 0.30;                          // にじみは 0.6 画素。2d だと主線 5px / 副線 3px になり 4:1 が潰れる
  float l = smoothstep(0.5 - w - aa, 0.5 - w + aa, f);
  return l * (1.0 - smoothstep(0.30, 0.70, d)); // 間隔が 1.5px を切ったら消す（潰れて面が白くなる）
}
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
// 1 画素が地面の上で覆う長さ（m）。距離だけでなく「どれだけ浅い角度で見ているか」も入る。
// 足跡より細かい模様は標本化できず、浅い角度では一方向に引き伸ばした「にじみ」になる
// （批評R4〜R7 の岸の彗星形。dpr 3 で描いても形が変わらないのはこれが理由）。
// ミップと同じ働きをさせて、足跡が大きい画素では細かい模様を消す
float tFoot = length(fwidth(tXZ));
float lodFine = 1.0 - smoothstep(0.13, 0.32, tFoot); // λ30〜40cm が読める画素か（標本化限界は足跡 20cm）
float lodMid = 1.0 - smoothstep(0.35, 0.95, tFoot);  // λ90cm〜1.5m が読める画素か（同 45cm）
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
float tShore = tF.a * 40.0 - 20.0; // 岸線からの距離（m、負が湖）
float tPatch = tF.b * 2.0 - 1.0;   // 13 m の斑（枯れ草・土）。焼いた場から読む（毎画素 fbm を引かない）
// 細部は大きさごとに別の距離で消す（画素より細かくなった模様は迷彩・水玉に見える）。映り込みでは全部省く
float detailOn = step(0.01, uDetail) * (1.0 - uReflect);
float dNear0 = (1.0 - smoothstep(2.0, 6.0 + 6.0 * uDetail, tDist)) * detailOn;   // 2〜8cm: 葉の筋・粒
// 10〜30cm の株・小石は 60m まで（high）。ここが 15m で切れていたので 15〜110m に情報が 1 つも無く、
// 中景が「エアブラシで塗ったパターゴルフのグリーン」になっていた（批評R7 上位10の1番）。
// λ30cm は 60m でも 3px あるので画素は切らない
float dNear1 = (1.0 - smoothstep(6.0, 30.0 + 30.0 * uDetail, tDist)) * detailOn; // 10〜30cm: 株・小石
// 3〜13cm の粒・こぶは画素より細かくなるのが早いので、旧 dNear1 の距離（high で 15m）のまま残す
float dFine1 = (1.0 - smoothstep(3.0, 7.0 + 8.0 * uDetail, tDist)) * detailOn;   // 3〜13cm: 粒・小石の陰影
float dNear2 = (1.0 - smoothstep(4.0, 9.0 + 7.0 * uDetail, tDist)) * detailOn;     // 45cm: こぶ
float tNear = max(dNear1, dNear2); // 株が 60m まで届くので、細部の枝はそこまで走らせる
float tMid = (1.0 - smoothstep(110.0, 300.0 + 320.0 * uDetail, tDist)) * (1.0 - uReflect); // 岩の粒は 620m 先では 1px 未満。そこまでで切る
// 株の帯: 60m で消える株（dNear1）と 110m から始まる岩の粒（tMid）の間を埋める。
// λ90cm は 30m で 19px・120m で 5px・170m で 3px。λ40cm はその半分（下の f04 で 95m で切る）
float dMid04 = smoothstep(6.0, 16.0, tDist) * (1.0 - smoothstep(90.0, 170.0, tDist)) * detailOn;
if (uTerrainDebug > 8.5 && uTerrainDebug < 9.5) { dNear0 = 0.0; dNear1 = 0.0; dFine1 = 0.0; dNear2 = 0.0; tNear = 0.0; tMid = 0.0; dMid04 = 0.0; } // 計測用

// ---- どの材質か（0..1 のマスク）。ゾーンは数百 m 単位（tMacro）で変える。細かい斑は迷彩に見えるので使わない ----
float rockM = smoothstep(0.28 + 0.06 * tMacro, 0.44 + 0.06 * tMacro, tSlope + 0.03 * tMeso);
float alpine = smoothstep(300.0 + 100.0 * tMacro, 480.0 + 100.0 * tMacro, tH);
rockM = max(rockM, alpine * smoothstep(0.10, 0.24, tSlope + 0.06 * tMacro));
float screeM = smoothstep(0.17, 0.27, tSlope + 0.04 * tPatch) * (1.0 - rockM) * smoothstep(120.0, 260.0, tH + 60.0 * tMacro);
float dirtM = max(smoothstep(0.15, 0.28, tSlope + 0.05 * tMeso), 1.0 - smoothstep(0.22, 0.42, tCav)) * (1.0 - rockM) * (1.0 - screeM);
// 土は斜面いちめんではなく斑で出す（一様に出ると尾根の草地が茶色い毛布になる）。
// λ36m の一段だけだと「ぼけた水彩」になるので、λ6m と λ1.5m の 2 段を足す（振幅 0.35）
float dirtFine = 0.35 * (tMeso + 1.1 * tPatch); // 下の中景ノイズと役割が重なるので自前のノイズはやめた
dirtM *= clamp(0.35 + 0.65 * smoothstep(-0.45, 0.45, tPatch + 0.7 * tMeso) + dirtFine, 0.0, 1.0);
// 水際 12m 以内は土を出さない。棚の肩の傾きで dirtM が立ち、岸線と平行な
// 「幅 5〜15m の無地の灰色コンクリート」になっていた（批評R4 7①）
dirtM *= smoothstep(-1.0, 12.0, tShore);
vec2 tWind = normalize(uWind.xy + vec2(1e-4, 0.0));
float lee = dot(gN.xz, tWind); // 風下斜面で正
// 雪: 45°（tSlope 0.29）を超える面には積もらない＝急な岩壁は黒く出る。
// 吹き溜まり: 風下（lee）と窪み（tCav < 0.5）で雪線が下がり、風の当たる尾根（tCav > 0.5）では上がる
float snowLine = 448.0 + uSeedWorld.x + 60.0 * tMacro - 48.0 * lee - 25.0 * tPatch - 70.0 * (tCav - 0.5);
float snowM = smoothstep(snowLine, snowLine + 40.0, tH) * (1.0 - smoothstep(0.21, 0.33, tSlope - 0.09 * lee));
// 岸: 砂は水際だけ。幅を -1.2〜4.6m（＝砂の無い岸もある）を 3〜25m のノイズでうねらせ、
// 縁のぼけ幅と高さの上限も場所で変える（幅も縁も一定だと「プールの縁」に見える）。
// ノイズは水際の帯でだけ引く（全画素で 3 回引くと重い）
float bn1 = 0.0, bn2 = 0.0, bn3 = 0.0, sandM = 0.0, wetBand = 0.0;
if (tShore < 9.0 && tAbove < 3.5) { // 砂は tShore ≤ 6.5m・水面 +2.75m まで。範囲外でノイズを引かない
  // 岸の帯の形を決めるノイズ。波長ごとに別の距離で消す。λ1.8m を 1.5km まで残すと、
  // マスクの縁が 1 画素より細かく揺れて「一方向へ引き伸ばした彗星形のにじみ」になる
  bn1 = flip_gnoise(tXZ * 0.55 + 5.0) * (1.0 - smoothstep(45.0, 110.0, tDist));   // λ ≈ 1.8 m（縁のぎざぎざ）
  bn2 = flip_gnoise(tXZ * 0.17 + 11.0) * (1.0 - smoothstep(150.0, 380.0, tDist)); // λ ≈ 6 m（幅のうねり）
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
  // 草が砂に舌のように食い込む（境が一本の弧だと「プールの縁」）。
  // λ0.56m の切れ込みは bn1 と同じ距離で消す（遠くまで残すとマスクの縁が画素より細かく揺れる）
  float tongue = flip_vnoise(tXZ * 0.55 + 13.0) + 0.35 * flip_vnoise(tXZ * 1.8 + 4.0) * (1.0 - smoothstep(45.0, 110.0, tDist)) * lodFine - 0.18;
  sandM *= 1.0 - 0.85 * smoothstep(0.42, 0.78, tongue);
  // 幅 1〜3m の浜は、ほぼ平らな対岸を視線と平行に見ると「奥行き方向に 200 画素の細長い舌」になる。
  // 320m で 40% 残していたので 1.5km 先でも彗星形のにじみとして出ていた（批評R4〜R7 の × 判定の正体）。
  // 600m で浜そのものを消す（幅 3m は 600m で 1.5 画素。ここまで来ると情報は残っていない）
  float shoreFar = 1.0 - 1.0 * smoothstep(90.0, 600.0, tDist);
  sandM *= shoreFar;
  // 水際の濡れ: 高さで一律に切ると等高線の帯（＝プールの縁）になる。幅を 0.1〜0.9m に散らし、
  // 砂の帯とは別の位相にして「濡れ・砂利・草」の 3 本の平行線ができないようにする
  float wetTop = 0.14 + 0.75 * smoothstep(-0.7, 0.7, bn1 + 0.6 * bn2 - 0.4 * bn3);
  wetBand = 1.0 - smoothstep(-0.04, wetTop, tAbove);
  // 高さだけで切ると等高線の帯になるので、水際からの「距離」でも減衰させる
  wetBand *= 1.0 - smoothstep(0.0, 1.4 + 1.8 * (bn2 + 0.5 * bn1 + 0.5), tShore);
  // 濡れの帯は幅 1m 前後。1.5km 先では 1 画素を大きく下回り、
  // 「一方向に引き伸ばした彗星形のにじみ」として出る（批評R4〜R6 の 2 ラウンド × 判定の正体）。
  // 砂の濡れを切ると帯の std 8.56 → 6.75、tCol 側も切ると 7.04（sand を定数にした下限が 6.31）
  // 濡れの帯は幅 1m 前後の高コントラスト（0.52 倍）の細い帯。浅い角度で見ると
  // 縁が 1〜2 画素を切って「一方向へ引き伸ばした彗星形のにじみ」になる（批評R4〜R6 の × 判定）。
  // 30m から縁のゆらぎを止め、180m で帯そのものを消す
  wetBand *= 1.0 - smoothstep(70.0, 180.0, tDist);
  wetBand = mix(wetBand, smoothstep(0.9, 0.15, tShore) * smoothstep(-0.04, 0.7, -tAbove + 0.7), smoothstep(25.0, 60.0, tDist));
}
// 林の密度は植生マップ（G）＝木を実際に置いた密度を正とする。
// 地形の焼いた場（tF.b）は別の乱数なので、それで判断すると「木の下なのに草原の色」になる。
// 512²（8m/texel）の線形補間なので縁はなだらか。植生が無い（?dbg=noveg）ときは 0 で草原のまま
vec4 tVeg = texture2D(uVegMap, tUv);
float forest = tVeg.g;
// 林床の効き。まばらな林（0.3 前後）では草が残り、密な林（0.8 超）で完全に腐植の床になる。
// 縁は 13m/36m の斑で崩すので境界が線に見えない
// 林の「密」の判定を上げる。植生マップの G は cloudy_side の開けた斜面でも 0.60〜0.69 あり、
// 0.34 起点だと「木が 1 本しかないのに林床の色」になっていた（影担当の申し送り）
float fFloorRaw = smoothstep(0.55, 0.95, forest + 0.16 * tPatch + 0.10 * tMeso);
// 林床の「材質」は近景だけ。200m 先の林は樹冠しか見えないので、そこの地面を腐植の色にすると
// 稜線に沿った暗い板（批評R4・R5 の「金床」）になる。境目を 70〜240m で溶かす
float fFar = smoothstep(70.0, 240.0, tDist);
float fFloor = fFloorRaw * (1.0 - fFar);

// ---- 色（線形）----
// 枯れ草の斑: 13m の斑は数百 m のゾーン（tMacro）の中でだけ強く出す（中景が迷彩に見えないように）
float dryZone = smoothstep(-0.2, 0.5, tMacro);
vec3 grass = mix(vec3(0.050, 0.115, 0.025), vec3(0.19, 0.165, 0.065), smoothstep(-0.25, 0.45, tPatch + 0.3 * tMeso) * (0.25 + 0.5 * dryZone) * (1.0 - smoothstep(0.12, 0.55, forest))); // 林とその空地は湿っていて枯れない（枯れ草の黄色が R/G を押し上げる）
grass *= 1.0 + 0.30 * tMacro + 0.13 * tMeso; // 数百m と 36m のむら。一色の斜面は「ゴルフ場」に見える
grass = mix(grass, vec3(0.19, 0.165, 0.06), smoothstep(250.0, 420.0, tH)); // 高山草地は黄ばむ
// 林帯（10〜400m、緩斜面）: 木の下の暗い床。遠景では樹冠のざらつき
// 林床。針葉樹の下は「草原の色」ではない: 落ち葉（針葉のリター）と腐植の色に寄せ、
// 日が差さないぶん彩度を落とし、林が濃いほど暗くする。
// 縁は植生マップの補間に 13m/36m の斑を足して崩すので、境界が線に見えない
float tCanopy = 1.0; // 樹冠が直達光を遮る割合（1 = 素通り）
vec3 tDuffCap = vec3(1.0); // 林床の地色の上限（明るい側の裾を切る）
// 遠景の林の地面は「暗い板」でなく、樹冠の色へごく薄く寄せるだけにする
if (fFar > 0.01) grass *= 1.0 - 0.16 * fFloorRaw * fFar;
if (fFloor > 0.0005) {
  float fLitter = flip_vnoise(tXZ * 0.42 + 21.0);
  // 褪せた針葉のリター（灰茶。R/G ≈ 1.0）→ 腐植（ほぼ黒）。
  // R が G に勝つ色（前は R/G = 1.32）は日なたで橙の砂に、1km 先では錆色に見える。
  // 明暗の比 4:1 を近距離で読ませるのが「林床」と「砂」の分かれ目
  vec3 duff = mix(vec3(0.0800, 0.0850, 0.0546), vec3(0.0258, 0.0275, 0.0178),
                  smoothstep(0.05, 0.90, fLitter + 0.45 * tPatch));
  // 苔・下草の緑が斑で混じる（緑側なので R/G は下がる方向）
  duff = mix(duff, vec3(0.0270, 0.0380, 0.0175), 0.45 * smoothstep(0.15, 0.78, tMeso + 0.7 * tPatch + 0.5 * fLitter));
  duff *= 1.0 + 0.16 * tMacro;
  tDuffCap = duff * 1.18; // 針葉や小枝の明るい粒でも腐植の 1.18 倍まで
  grass = mix(grass, duff, min(1.0, 2.5 * fFloor));
  // 樹冠の下は空が見えない。さらに λ12m の「木が混んで暗い溜まり」を作る
  // （一様に明るいと、いくら暗くしても砂丘の陰影に見える）
  float shade = smoothstep(-0.35, 0.55, tMeso + 0.6 * tPatch);
  grass *= 1.0 - (0.05 + 0.10 * shade) * fFloor; // 暗さは影担当の flip_sunOcclusion が持つ
  // 根元（植生マップ r = 草の密度。木を置いた texel は薄くしてある）ほどわずかに暗い
  grass *= 1.0 - 0.16 * fFloor * smoothstep(0.30, 0.02, tVeg.r);
  // 遠景の樹冠のざらつき（近景では草・幹が描くので出さない）
  if (tNear < 0.99) grass *= 1.0 - 0.24 * fFloor * fLitter * (1.0 - tNear);
  // 木漏れ日: 林が濃いほど直達光が届かない。CSM の落ち影は 200m ほどで尽きるので、
  // それより遠い林床が「日なたの砂」になっていた。斑（2.4m）で木漏れ日にする
  tCanopy = 1.0 - 0.88 * fFloor * smoothstep(1.00, 0.10, fLitter + 0.45 * tPatch);
}
// 中景（10〜60m）: 丈の高い草の群れ（2m）のやわらかい明暗
if (tDist < 160.0 && uReflect < 0.5) grass *= 1.0 + 0.16 * flip_fbm(tXZ * 0.55 + 8.0, 2) * (1.0 - smoothstep(60.0, 160.0, tDist));
// 林床の中景（5〜55m）: 落ち葉・小枝の斑（λ25cm / 8cm）。近景の針葉は 12m で消えるので、
// ここが空くと 12〜50m の帯が「なめらかな砂の斜面」になる（批評R3 の「明るい砂」の主因）
if (fFloor > 0.01 && tDist < 55.0 && uReflect < 0.5) {
  float mFade = 1.0 - smoothstep(26.0, 55.0, tDist);
  float l1 = flip_vnoise(tXZ * 4.0 + 31.0);
  grass *= 1.0 + (0.80 * l1 - 0.40 + 0.45 * tPatch) * fFloor * mFade;
  // 落ちた針葉と小枝。5〜22m でもはっきり読める大きさ（λ 25cm の束と λ 7cm の針）で、
  // 暗い側に振る（腐植の上に濃い茶の針葉が散る）。草の陰に隠れない濃さ
  float nFade = (1.0 - smoothstep(12.0, 24.0, tDist)) * fFloor;
  if (nFade > 0.01) {
    vec2 nw = normalize(uWind.xy + vec2(1e-4, 0.0));
    vec2 na = vec2(dot(tXZ, nw), dot(tXZ, vec2(-nw.y, nw.x)));
    float twig = flip_vnoise(tXZ * 4.6 + 71.0);
    float ndl  = flip_vfbm(na * vec2(9.0, 26.0) + 13.0, 2);
    grass *= 1.0 - (0.62 * smoothstep(0.58, 0.92, twig) + 0.46 * smoothstep(0.55, 0.90, ndl)) * nFade;
  }
}
// 枯れ草・落ち葉のリター（株の間から見える地面）。λ 3.5m の斑で 70m まで。
// これが無いと地面が「一色の緑の絵の具」になる
if (tDist < 70.0 && uReflect < 0.5) {
  float lit = smoothstep(0.42, 0.86, flip_vnoise(tXZ * 0.29 + 17.0) + 0.45 * tPatch) * (1.0 - smoothstep(28.0, 70.0, tDist));
  grass = mix(grass, vec3(0.155, 0.125, 0.062), 0.5 * lit * (1.0 - smoothstep(0.10, 0.45, forest))); // 林床は duff が持つ（fFloor だと疎林で漏れる）
}
vec3 dirt = vec3(0.088, 0.084, 0.060) * (1.0 + 0.2 * tMacro + 0.28 * tMeso + 0.20 * tPatch); // 温帯の土は灰褐色。R/G 1.35 のオレンジだと地色が赤くなる。遠景も無地にしない（焼いた場の使い回し）
// 斜面の土（批評R3 4位）: λ6m（振幅 0.35）と λ1.5m（振幅 0.2）の 2 段。
// 一段だけだと「無地のエアブラシ」に見える。傾き 25°超には 0.6 倍の暗い縦筋（雨裂）
vec2 dirtN = vec2(0.0);
if (dirtM > 0.05 && tDist < 380.0) {
  float dFade = 1.0 - smoothstep(200.0, 380.0, tDist);
  float d6 = flip_gnoise(tXZ * 0.17 + 29.0);
  vec3 d15 = tn_gnoised(tXZ * 0.66 + 41.0);
  dirt *= 1.0 + (0.35 * d6 + 0.20 * d15.x) * dFade;
  dirtN = d15.yz * (0.66 * 0.13) * dFade;
  // 雨裂は本当に急な斜面だけ。緩い岸の肩に出すと縦縞のコーデュロイになる（批評R4 7④）
}
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
vec3 sand = vec3(0.115, 0.113, 0.108) * (1.0 + 0.18 * tMeso); // 高山湖の岸は灰色の砂利。暖色だと濡れた帯が赤紫にかぶる（水担当の切り分け）
if (sandM > 0.001) {
  // 砂利の粒は波長ごとに別の距離で消す。λ1.4m と λ0.4m を 1.5km 先まで残すと、
  // 1 画素の足跡が細長い浅い角度で「一方向へ引き伸ばした彗星形のにじみ」になる
  // （批評R4〜R6 の「岸のにじみ」の正体。std 11.41 → sand を定数にすると 6.31 で確定した）
  float sd14 = (1.0 - smoothstep(60.0, 140.0, tDist)) * lodMid;  // λ1.4m は 140m まで
  float sd04 = (1.0 - smoothstep(18.0, 45.0, tDist)) * lodFine; // λ0.4m は 45m まで
  sand *= 1.0 + (0.4 * flip_vnoise(tXZ * 0.7 + 4.0) - 0.2) * sd14;
  if (sd04 > 0.01) sand = mix(sand, vec3(0.16, 0.16, 0.15), 0.5 * smoothstep(0.55, 0.8, flip_vnoise(tXZ * 2.5 + 1.0)) * (1.0 - smoothstep(0.0, 6.0, tShore)) * sd04);
  // 水際の砂利は濡れて暗い（乾いた砂 → 濡れた砂 → 湖底 がつながる）
  sand = mix(sand, sand * 0.68, wetBand); // 0.52 は細い帯で明暗差が強すぎ、浅い角度でにじみになる
  // 湖底: 深いほど暗く、沈殿・藻のむらを入れる（一様に明るい灰色は「プールの底」に見える）。
  // 浅瀬の棚は遠くからだと幅 10〜20px の一様な淡い帯になり、それ自体が「プールの縁」になるので、
  // λ2.4m の礫と λ22m の藻・沈泥を 400m 先まで残して崩す
  if (tAbove < 0.1) {
    float dep = -tAbove;
    float sFar = 1.0 - smoothstep(90.0, 220.0, tDist); // λ2.4m は 220m まで（それ以遠は 1px を切る）
    float g1 = flip_vnoise(tXZ * 0.42 + 61.0);
    sand *= (0.74 + 0.52 * g1 + 0.30 * tMeso + 0.20 * tPatch) * sFar + (1.0 - sFar);
    sand = mix(sand, vec3(0.034, 0.050, 0.030), 0.55 * smoothstep(0.35, 0.88, tPatch + 0.55 * g1 + 0.3 * tMeso) * sFar);
    // 遠景では礫の粒が画素より細かくなり「無地の灰色コンクリート」に平均化される。
    // 距離が離れるほど藻・沈泥の緑へ寄せる（浅瀬は水草と藻で緑がかって見えるのが本当）
    sand = mix(sand, vec3(0.030, 0.046, 0.028), 0.70 * smoothstep(70.0, 260.0, tDist));
    sand *= 0.92 + 0.45 * flip_fbm(tXZ * 0.16 + 7.0, 2) * (1.0 - smoothstep(30.0, 90.0, tDist)) + 0.16 * tMacro;
    sand = mix(sand, vec3(0.070, 0.086, 0.062), smoothstep(0.5, 5.0, dep)); // 岸ぎわで急に暗くすると水際が線に見える
  }
}
vec3 wN = normalize(mix(gN, snowN, snowM));

if (tNear > 0.0) {
  // 草の株: 30cm の房のなだらかなドーム（境界の線は出さない）。株ごとに色が少し違う
  float dome = flip_vnoise(tXZ * 3.3 + 1.0);
  float hue = flip_vnoise(tXZ * 1.7 + 6.0);
  float gDet = 1.0 - 0.88 * fFloor; // 林床には草の株・葉の模様を出さない（明るく戻ってしまう）
  float dClump = dNear1 * lodFine; // λ30cm の株。足跡が 26cm を超える画素（＝浅い角度）では標本化できない
  grass *= 1.0 + (0.45 * dome - 0.2 + 0.25 * (hue - 0.5)) * dClump * gDet;
  // 葉の筋（2〜5cm、風向きに少し伸びる）と粒
  vec2 wdir = normalize(uWind.xy + vec2(1e-4, 0.0));
  vec2 xa = vec2(dot(tXZ, wdir), dot(tXZ, vec2(-wdir.y, wdir.x)));
  float blades = dNear0 > 0.01 ? flip_vfbm(xa * vec2(16.0, 42.0) + 5.0, 2) : 0.5;
  float edge = dNear0 > 0.01 ? 1.0 - abs(flip_gnoise(xa * vec2(14.0, 40.0) + 9.0)) : 0.0; // 葉の縁が光る細い筋
  edge = edge * edge * edge;
  float grain = dFine1 > 0.01 ? flip_vnoise(tXZ * 30.0 + 1.0) : 0.5; // λ3.3cm。15m より先では画素を切るので引かない（0.5 = 無効）
  grass *= 1.0 + ((0.8 * blades - 0.4 + 0.5 * edge) * dNear0 + (0.4 * grain - 0.2) * dFine1) * gDet;
  // 土が透ける斑（房の間・踏み跡）
  // 林床の細部: 落ちた針葉・小枝・落ち枝。草の「葉の筋」と同じノイズ（blades / edge）を
  // 色と強さだけ変えて使う（針葉は細長いので形はそのまま合う）。ここが平坦だと砂に見える
  if (fFloor > 0.01) {
    float needles = 1.6 * blades - 0.88 + 0.55 * edge; // 平均 0（明るさを上げずにコントラストだけ足す）
    grass *= 1.0 + (0.80 * needles * dNear0 + (0.85 * dome - 0.42) * dClump + (0.75 * grain - 0.37) * dFine1) * fFloor;
  }
  // 房の間の土（踏み跡）。林床では腐植の色（草地の土より暗い）
  vec3 soil = mix(vec3(0.075, 0.055, 0.035), vec3(0.0060, 0.0064, 0.0048), smoothstep(0.10, 0.45, forest)) * (0.8 + 0.4 * grain); // 林床の踏み跡は腐植（灰茶・暗い）
  float bare = smoothstep(0.58, 0.8, flip_vnoise(tXZ * 0.9 + 2.0)) * (1.0 - 0.7 * dome);
  grass = mix(grass, soil, 0.5 * bare * dNear1 * lodMid);
  // 砂: 粒と小石（水際ほど多い）
  // 小石は水際の帯だけ（tn_cell は 9 ハッシュ。湖底ぜんぶで引くと重く、深い所では水で見えない）。
  // 1 セル 1 個・閾値固定・砂の 1.8 倍の明るさだと「同じ大きさの灰白の楕円の絨毯」になる
  // （批評R3 8位）。大きさを 0.35〜1.15 倍に散らし、密度を 1/4 にし、色は砂から作る
  if (sandM > 0.005 && dFine1 > 0.005 && tShore > -5.0 && tAbove > -0.45) {
    vec3 pb = tn_cell(tXZ * 3.5);
    float rad = 0.075 + 0.20 * pb.z;                       // 大きさのばらつき
    float pebble = (1.0 - smoothstep(rad, rad + 0.10, pb.x)) * step(0.80 + 0.12 * smoothstep(0.0, 6.0, tShore), pb.z);
    sand = mix(sand * (0.85 + 0.3 * grain * dNear0), sand * (0.95 + 0.45 * pb.z), pebble * dFine1); // 小石は 5〜8cm。15m で切る（浜の帯は浅い角度なので延ばすとにじむ）
  }
  if (snowM > 0.001) snow += 0.03 * tn_gnoised(tXZ * 1.2 + 5.0).x * dNear2;
  // 細部の法線（草・土・砂）: 0.45m / 0.13m / 0.08m のこぶ。大きさごとに別の距離で消す
  // 水面から 0.8m 以上沈んだ所は屈折越しにしか見えないので細部の法線を作らない
  float subm = 1.0 - smoothstep(-0.1, -0.8, tAbove);
  vec3 d1 = tn_gnoised(tXZ * 2.2), d2 = vec3(0.0), d3 = vec3(0.0);
  // 13cm / 8cm のこぶは、それぞれの距離ゲートが立っているときだけ引く（ゲートは 12〜15m）
  if (subm > 0.01 && dFine1 > 0.01) d2 = tn_gnoised(tXZ * 7.5 + 3.0);
  if (subm > 0.01 && dNear0 > 0.01) d3 = tn_gnoised(tXZ * 13.0 + 9.0);
  // 13cm / 8cm のこぶは低い太陽で「風紋」に見え、林床では砂丘そのものになる。林床では 45cm の
  // うねり（根・落ち葉の盛り上がり）だけ残す
  float fineB = 1.0 - 0.85 * fFloor;
  // 45cm のこぶは 60m まで（dNear1）。ここが 16m で切れていたので、中景の地面に陰影が一切無かった
  vec2 g = d1.yz * (2.2 * 0.03) * dClump + (d2.yz * (7.5 * 0.02) * dFine1 + d3.yz * (13.0 * 0.01) * dNear0) * fineB * subm;
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
    float det = dFine1 * uDetail; // ブロック割れは tn_cell（9 ハッシュ）。近景だけに閉じる
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
      if (dFine1 > 0.0) gb += tn_gnoised(pt * 4.5 + 7.0).yz * (4.5 * 0.05) * dFine1 * bAmp; // λ22cm。60m では 1.4px なので近景だけ
    }
    vec3 rN = normalize(gN - (T * gb.x + B * gb.y));
    wN = normalize(mix(wN, rN, max(rockM, 0.55 * screeM)));
  }
}

if (dirtM > 0.02 && (dirtN.x != 0.0 || dirtN.y != 0.0)) wN = normalize(wN - vec3(dirtN.x, 0.0, dirtN.y) * gN.y * dirtM);
// 林床の明るい側の裾を切る。近景の針葉・小枝・株の模様は掛け算なので、
// 一部の画素が地色の 2 倍まで持ち上がり、「日なたの林床が日なたの草地より明るい」
// （統合担当の実測 127 対 108）の原因になっていた。暗い側は自由に落とす
if (fFloor > 0.01) grass = min(grass, mix(grass, tDuffCap, fFloor));
// 地面（草地・土・林床）のアルベドを下げる。晴天の昼に「日なたの草地が空より明るい」のは
// ありえない（青空 5000〜8000 cd/m² に対し日なたの草地は 2000〜3000 cd/m²）。
// 実測でも noon_side の dbg=noveg が 近景 ÷ 空 = 126% だった。露出では直せない（比なので）。
// 岩・ガレ・雪・浜は白くて当然なので触らない
float gAlb = 0.52;
vec3 tCol = grass * gAlb;
tCol = mix(tCol, dirt * gAlb, dirtM);
tCol = mix(tCol, scree, screeM);
tCol = mix(tCol, rock, rockM);
tCol = mix(tCol, snow, snowM);
tCol = mix(tCol, sand, sandM);
// 中景（25m〜1.9km）の 2 段ノイズ。ここが空くと 100m 以遠の地面が「のっぺりした塗り」になる
// （批評 R2 の 6 番から 4 ラウンド続けて指摘された箇所）。
// λ36m と λ13m は焼いた場（tMeso / tPatch）の使い回しで無料、λ6m だけ 1 タップ引く。
// 法線にも同じ勾配を入れて、曇天でも起伏として読めるようにする
float midN = (1.0 - smoothstep(900.0, 1900.0, tDist)) * smoothstep(12.0, 40.0, tDist) * (1.0 - snowM) * (1.0 - uReflect); // 始点 25→12m（ridge の 30〜120m の斜面が外に落ちていた）
if (midN > 0.01) {
  vec3 m6 = tn_gnoised(tXZ * 0.17 + 53.0);
  // λ1.5m の段（振幅 0.20）。これが無いと 100m 先が「ぼかした写真」に見える（批評R6 10位①）。
  // 400m で消す（それ以遠は 1 画素を切ってにじみになる）
  float hiF = 1.0 - smoothstep(150.0, 400.0, tDist);
  vec3 m15 = hiF > 0.01 ? tn_gnoised(tXZ * 0.66 + 77.0) : vec3(0.0);
  tCol *= 1.0 + (0.35 * m6.x + 0.20 * tPatch + 0.12 * tMeso) * midN + 0.42 * m15.x * hiF * midN;
  wN = normalize(wN - vec3(m6.y + m15.y * 0.75 * hiF, 0.0, m6.z + m15.z * 0.75 * hiF) * (0.17 * 0.34) * midN * gN.y);
}
// λ40cm の粒（30〜80m でいちばん効く）。株（60m で消える）と岩の粒（110m から）の間の帯には
// これまで何も無く、15〜110m が「エアブラシで塗ったパターゴルフのグリーン」だった（批評R7 上位10の1番）。
// 色と法線の両方に入れる（曇天では法線が、日なたでは色が効く）。雪の上では粒に見えないので外す
if (dMid04 > 0.01) {
  float a09 = dMid04 * (1.0 - snowM) * lodMid;
  // λ40cm は 95m で 2px を切る。そこから先は λ90cm だけにする（細かい側を残すと点々＝砂嵐に見える）
  float a04 = a09 * (1.0 - smoothstep(45.0, 95.0, tDist)) * lodFine;
  vec3 m09 = tn_gnoised(tXZ * 1.1 + 37.0);                        // λ90cm: 株の群れ
  vec3 m04 = a04 > 0.01 ? tn_gnoised(tXZ * 2.5 + 91.0) : vec3(0.0); // λ40cm: 株ひとつ
  // 株の「すき間」は影になるので暗い側に振れる（左右対称のノイズだけだと迷彩になる）
  float gap = smoothstep(0.55, -0.25, m04.x * (a04 / max(a09, 1e-3)) + 0.8 * m09.x);
  tCol *= 1.0 + 0.75 * m04.x * a04 + (0.52 * m09.x - 0.60 * gap + 0.27) * a09;
  // 法線でも見せる（曇天では色より陰影が効く）。太陽が低いと画素より細かい斑点になるので弱める
  float nAmp = (0.45 + 0.55 * smoothstep(0.05, 0.45, uSunDir.y)) * (1.0 - 0.6 * rockM);
  vec2 g04 = m04.yz * (2.5 * 0.040) * a04 + m09.yz * (1.1 * 0.055) * a09;
  wN = normalize(wN - vec3(g04.x, 0.0, g04.y) * nAmp * gN.y);
}
float tRough = mix(0.92, 0.80, dirtM);
tRough = mix(tRough, 0.99, fFloor); // 林床は完全なマット（腐植と針葉に艶は無い。斜めから見たときの照りを消す）
tRough = mix(tRough, 0.85, screeM);
tRough = mix(tRough, 0.82, rockM); // 0.72 は低い太陽で岩がプラスチックのように光った
tRough = mix(tRough, 0.80, snowM); // 0.55 は艶が出すぎて「メレンゲ」に見えた
tRough = mix(tRough, 0.80, sandM);
// 水際の濡れ・雨の濡れ・水たまり
float wet = max(wetBand, uWetness * (1.0 - snowM));
tCol *= 1.0 - mix(0.32, 0.18, smoothstep(25.0, 90.0, tDist)) * wet;
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
tCol *= 1.0 - 0.28 * cavD;
// 焼いた AO は空の照度にだけ掛かる。谷で効かせつつ 0.28 を下限に（影の中が真っ黒にならない）
tAO = 0.40 + 0.60 * tAO * (1.0 - 0.35 * cavD); // 二乗はやめた（曇天では光の全部がここを通るので効きすぎる）
// 樹冠は太陽だけでなく空も隠す。林床の明るさの大半は半球光なので、ここを落とさないと
// いくら直達光を遮っても「日なたの砂」のままだった
tAO *= 1.0 - 0.18 * fFloor; // 曇天は光がほぼ全部これなので、樹冠でここを落としすぎると地面が空の 3% になる
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
// 林床（落ち葉と腐植）は光を内部で散らす多孔質なので、面としての鏡面反射をほとんど返さない。
// 斜めから見た林床に GGX の照りが残ると、アルベドを真っ黒にしても sRGB 110 の明るさが残る
// （実測。批評R2〜R4 の「明るい砂」の主因はこれだった）
reflectedLight.directSpecular *= 1.0 - 0.55 * fFloor;
reflectedLight.indirectSpecular *= 1.0 - 0.35 * fFloor; // 曇天は環境の鏡面も光量の一部。落としすぎない
// 樹冠が直達光を遮る（木漏れ日）。影担当の flip_sunOcclusion は camDist 25m から効くので、
// それより手前の林床には林の遮蔽が一切かかっていなかった。ここで掛けると地形だけに閉じる。
// tCanopy は 2.4m の斑なので、光の差す所は明るいまま残る
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
  // 主線 3px α0.9 / 副線 1px α0.35 の 4:1。副線は 200m で消していたので遠景に主線しか無く、
  // 「全部同じ太さ」に見えていた（批評R2〜R6 で 5 回指摘）。10m 間隔は 2km 先でも 8px あるので残す
  float cMinor = tn_linePx(tH / 10.0, 1.0) * (1.0 - smoothstep(1600.0, 2600.0, tDist));
  float cMajor = tn_linePx(tH / 50.0, 3.0);
  // 成分の族はさらに細く（合計の等高線を邪魔しない）
  float lm = tn_linePx(pm / 20.0, 1.2) * smoothstep(0.5, 3.0, pm) * midR;
  float lb = tn_linePx(pb / 8.0, 1.0) * nearR;
  float lf = tn_linePx(pf / 0.5, 1.0) * (1.0 - smoothstep(40.0, 120.0, tDist));
  fc += FLIP_LINE * (0.90 * cMajor + 0.35 * cMinor) * far; // 主線 3px a0.9 / 副線 1px a0.35
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
if ((uTerrainDebug > 0.5 && uTerrainDebug < 5.5) || (uTerrainDebug > 6.5 && uTerrainDebug < 8.5) || (uTerrainDebug > 11.5 && uTerrainDebug < 14.5)) {
  vec3 dbg = vec3(tSunVis);
  if (uTerrainDebug > 1.5) dbg = vec3(tAO);
  if (uTerrainDebug > 2.5) dbg = wN * 0.5 + 0.5;
  if (uTerrainDebug > 3.5) dbg = vec3(tCav);
  if (uTerrainDebug > 4.5) dbg = texture2D(uTerrainHorizonA, tUv).rgb;
  if (uTerrainDebug > 6.5 && uTerrainDebug < 7.5) dbg = vec3(fFloor, dirtM, screeM);
  if (uTerrainDebug > 7.5 && uTerrainDebug < 8.5) dbg = tCol * 6.0; // 地色（照明抜き）を 6 倍で
  if (uTerrainDebug > 11.5 && uTerrainDebug < 12.5) dbg = vec3(sandM, dirtM, screeM) * 2.0; // 12: 岸まわりの材質マスク（砂/土/ガレ）
  if (uTerrainDebug > 12.5) { dbg = vec3(0.0); if (tDist < 10.0) dbg = vec3(2.0,0.0,0.0); else if (tDist < 20.0) dbg = vec3(2.0,2.0,0.0); else if (tDist < 30.0) dbg = vec3(0.0,2.0,0.0); else if (tDist < 45.0) dbg = vec3(0.0,2.0,2.0); else if (tDist < 60.0) dbg = vec3(0.0,0.0,2.0); else if (tDist < 125.0) dbg = vec3(2.0,0.0,2.0); else if (tDist < 300.0) dbg = vec3(1.0,1.0,1.0); else dbg = vec3(0.3,0.3,0.3); } // 13: 距離帯（赤<10 黄<20 緑<30 水<45 青<60 桃<125 白<300 灰300〜m）。批評の矩形が何 m の地面かを確かめる
  if (uTerrainDebug > 13.5) { float fo = length(fwidth(tXZ)); dbg = vec3(0.0); if (fo < 0.05) dbg = vec3(2.0,0.0,0.0); else if (fo < 0.12) dbg = vec3(2.0,2.0,0.0); else if (fo < 0.25) dbg = vec3(0.0,2.0,0.0); else if (fo < 0.5) dbg = vec3(0.0,2.0,2.0); else if (fo < 1.0) dbg = vec3(0.0,0.0,2.0); else if (fo < 2.0) dbg = vec3(2.0,0.0,2.0); else dbg = vec3(1.0,1.0,1.0); } // 14: 1 画素が地面で覆う長さ（赤<5 黄<12 緑<25 水<50 青<100 桃<200 白200cm〜）。ここが λ の半分を超えたら模様は標本化できない
  gl_FragColor.rgb = dbg * 0.5;
}
`;

/**
 * three の lights_fragment_begin（CSM 版）に「山の影」を差し込む。
 * 月（影を落とさない平行光）に tMoonVis を掛ける。太陽側は core/lighting.ts が
 * flip_sunOcclusion（山の影＋林の帯）で全マテリアルにまとめて掛けるのでここでは触らない。
 * 目印が見つからなければそのまま返す（山の影なしで動く）。
 */
export function injectTerrainShadow(chunk: string): string {
  const marker = "#if ( NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS)";
  const call = "getDirectionalLightInfo( directionalLight, directLight );";
  const idx = chunk.indexOf(marker);
  if (idx < 0 || !chunk.includes(call)) return chunk;
  // 太陽（カスケード）の「山の影」は core/lighting.ts が flip_sunOcclusion で全マテリアルに掛けるので
  // ここでは掛けない（掛けると地形だけ二乗になって、木と地面で影の濃さが食い違う）
  const sun = chunk.slice(0, idx);
  const moon = chunk.slice(idx).split(call).join(`${call} directLight.color *= tMoonVis;`);
  return sun + moon;
}
