// 水面の GLSL。頂点: 極座標メッシュ＋FFT 変位＋浅瀬の波。フラグメント: 傾き（ミップで遠景をならす）→
// 屈折（深さで吸収・散乱・コースティクス）→ 平面鏡の映り込み（波で崩し、粗さで縦にぼかす）→
// GGX の太陽のギラつき → 泡 → 空気遠近 → 裏返し。
// 共有 uniforms は env.uniforms（uTime, uWind, uRain, uStorm, uSunDir, uSunColor, uSkyAmbient, uCamPos, uLakeLevel …）。

/** 頂点・フラグメント共通: 風の斑（cat's paw）・浅瀬の波 */
export const WATER_COMMON = /* glsl */ `
// 風の斑。風向に長く伸びた斑が流れ、無風〜微風ではさざ波が斑の中だけに立つ。強風では一面に
float water_gust(vec2 xz, vec2 wd, float speed, float t){
  vec2 perp = vec2(-wd.y, wd.x);
  vec2 q = vec2(dot(xz, wd), dot(xz, perp));
  float g = flip_fbm(q * vec2(0.007, 0.02) + vec2(-t * 0.045, 0.0) + 3.7, 3);
  float g2 = flip_gnoise(q * vec2(0.025, 0.11) + vec2(-t * 0.3, 0.0) + 11.0);
  float w = clamp(speed / 7.0, 0.0, 1.0);
  float v = g + 0.3 * g2;
  float patches = smoothstep(0.26 - 0.6 * w, 0.42 - 0.3 * w, v);
  return mix(patches * (0.4 + 0.6 * w), 1.0, w * w);
}
// 岸線からの符号付き距離（負が湖）。湖底の形 34(1-exp(sd/70)) を逆に解く
float water_shoreDist(float depth){
  return 70.0 * log(max(1.0 - depth / 34.0, 0.02));
}
// 浅瀬へ向かう長い波。x = 高さ, y = 位相
vec2 water_shoreWave(vec2 xz, float depth, float t, float speed){
  float sd = water_shoreDist(depth);
  float k = 6.2831853 / 9.0;
  float ph = sd * k - 1.9 * t + flip_gnoise(xz * 0.04 + 2.0) * 1.6;
  float env = smoothstep(0.0, 0.6, depth) * (1.0 - smoothstep(4.0, 30.0, depth));
  float amp = (0.012 + 0.05 * smoothstep(1.0, 10.0, speed)) * env;
  return vec2(amp * cos(ph), ph);
}
`;

export const WATER_VERT = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WATER_COMMON}
uniform sampler2D tDisp;
uniform vec4 uTiles;     // L0, L1, N, tilesN
uniform vec4 uWaveAmp;   // amp0, amp1, chop, -
uniform vec3 uWind;
uniform float uTime;
uniform float uLakeLevel;
uniform vec3 uCamPos;
varying vec3 vWorld;
varying vec3 vDisp;
varying float vViewZ;
varying float vDepthA;
varying float vGust;
varying vec2 vShoreDir;

// アトラスの手動バイリニア（タイルの縁で繰り返す）
vec4 sampleDisp(float tile, vec2 uv){
  float N = uTiles.z;
  vec2 atlas = vec2(N * uTiles.w, N);
  vec2 p = uv * N - 0.5;
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 off = vec2(tile * N, 0.0) + 0.5;
  vec4 a = texture2D(tDisp, (off + mod(i, N)) / atlas);
  vec4 b = texture2D(tDisp, (off + mod(i + vec2(1.0, 0.0), N)) / atlas);
  vec4 c = texture2D(tDisp, (off + mod(i + vec2(0.0, 1.0), N)) / atlas);
  vec4 d = texture2D(tDisp, (off + mod(i + vec2(1.0, 1.0), N)) / atlas);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main(){
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  float dist = length(position.xz);
  float depth = uLakeLevel - flip_height(world.xz);
  vec3 tn = flip_terrainNormal(world.xz, 3.0);
  vShoreDir = normalize(-tn.xz + vec2(1e-4, 0.0));   // 岸へ向かう向き（湖底の上り）
  float shoreFade = smoothstep(0.0, 2.2, depth);
  vec2 wd = normalize(uWind.xy + vec2(1e-4, 0.0));
  float gust = water_gust(world.xz, wd, uWind.z, uTime);
  float fade0 = 1.0 - smoothstep(70.0, 320.0, dist);
  float fade1 = 1.0 - smoothstep(10.0, 40.0, dist);
  vec4 d0 = sampleDisp(0.0, world.xz / uTiles.x) * (fade0 * uWaveAmp.x);
  vec4 d1 = sampleDisp(1.0, world.xz / uTiles.y) * (fade1 * uWaveAmp.y * gust);
  vec3 disp = vec3((d0.x + d1.x) * uWaveAmp.z, d0.z + d1.z, (d0.y + d1.y) * uWaveAmp.z) * shoreFade;
  vec2 sw = water_shoreWave(world.xz, depth, uTime, uWind.z);
  disp.y += sw.x * (1.0 - smoothstep(40.0, 140.0, dist));
  world += disp;
  vWorld = world;
  vDisp = disp;
  vDepthA = depth;
  vGust = gust;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const WATER_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
#include <flip_atmosphere>
#include <flip_flip>
${WATER_COMMON}
uniform sampler2D tReflection;
uniform sampler2D tSceneColor;
uniform sampler2D tSceneDepth;
uniform sampler2D tDeriv0;
uniform sampler2D tDeriv1;
uniform vec2 uResolution;
uniform vec2 uReflSize;
uniform mat4 uReflMatrix;
uniform mat4 uViewProj;
uniform vec3 uCamFwd;
uniform vec4 uTiles;      // L0, L1, N, tilesN
uniform vec4 uWaveAmp;    // amp0, amp1, chop, hs
uniform vec4 uWaterA;     // reflValid, reflLodMax, foamAmount, causticStrength
uniform vec4 uWaterB;     // underwater, tanHalfFovV, rainDetail, lambdaP
uniform vec3 uExtinction;
uniform vec3 uScatterColor;
uniform float uDebug;   // 調査用 ?wdbg=1 法線 2 水の色 3 映り込み 4 屈折の元 5 分散 6 泡の元 7 太陽・月のギラつき 8 泡と岸の透け 9 水中の光路長
uniform vec3 uWind;
uniform vec3 uSkyAmbient;
uniform float uRain;
uniform float uWetness;
uniform float uLakeLevel;
varying vec3 vWorld;
varying vec3 vDisp;
varying float vViewZ;
varying float vDepthA;
varying float vGust;
varying vec2 vShoreDir;

// 空モジュールの flip_atmosphere が PI を #define するので、const で宣言しない（識別子が数値に置換されて構文エラーになる）
#ifndef PI
#define PI 3.14159265
#endif
#define WATER_F0 0.02

vec2 projectRefl(vec3 p){
  vec4 c = uReflMatrix * vec4(p, 1.0);
  return c.xy / max(c.w, 1e-4);
}

// 雨粒の波紋。白い点（王冠）は出さない。法線だけのリング:
//   振幅 4mm、半径は 0.6 m/s で広がる、L0 で約 34 個/m²/s（3 層で約 38）。
// 格子ごとに 1 粒、周囲 3×3 を見て輪が格子の縁で切れないように（輪の最大半径 ≤ 格子の一辺）。
// 返り値は傾き（水面の法線に足す）。しぶきの白い粒は天気モジュールの 1px リングに任せる。
vec2 water_rain(vec2 p, float t, float amount, int layers){
  vec2 s = vec2(0.0);
  float cellSize = 0.26;
  float life = 0.44;                                     // 寿命 s（半径 0.6·life ≈ 格子の一辺）
  for (int L = 0; L < 3; L++){
    if (L >= layers) break;
    vec2 pc = p / cellSize + float(L) * 7.3;
    vec2 cell = floor(pc);
    for (int y = -1; y <= 1; y++){
      for (int x = -1; x <= 1; x++){
        vec2 c = cell + vec2(float(x), float(y));
        vec3 h = flip_hash33(vec3(c, float(L) * 3.1));
        if (h.z > amount) continue;                        // 雨量で粒の数
        vec2 dropPos = (c + h.xy) * cellSize;
        float period = life * (0.82 + 0.36 * h.x);
        float tt = fract(t / period + h.y);                // 0..1 で一生
        float radius = tt * period * 0.6;                  // 0.6 m/s で広がる
        vec2 dv = p - dropPos;
        float r = length(dv);
        float ring = r - radius;
        float ww = 0.032;                                  // 輪の幅（ガウス）
        float win = exp(-ring * ring / (2.0 * ww * ww));
        float ampl = 0.004 * (1.0 - tt) * (1.0 - tt);      // 振幅 4mm、時間で減衰
        // 波面 A·cos(k·ring) の傾き（k = 2π/10cm）
        s += (-ampl * 62.8 * sin(62.8 * ring) * win) * dv / max(r, 0.012);
      }
    }
    cellSize *= 2.1;
    life *= 2.1;
  }
  return s;
}

// コースティクス（湖底の光のゆらぎ）。2 方向の稜線ノイズの積
// flip_gnoise は ±1 を超えることがあるので 0..1 に留める（負の値の pow は NaN になり、ポストのブルーム／ゴッドレイが
// それを画面全体に筋として広げる）
float water_caustic(vec2 p, float t){
  float a = clamp(1.0 - abs(flip_gnoise(p * 1.9 + vec2(t * 0.35, -t * 0.2))), 0.0, 1.0);
  float b = clamp(1.0 - abs(flip_gnoise(p * 2.3 + vec2(-t * 0.25, t * 0.3) + 5.0)), 0.0, 1.0);
  float c = clamp(1.0 - abs(flip_gnoise(p * 4.1 + vec2(t * 0.5, t * 0.1) + 9.0)), 0.0, 1.0);
  return pow(a * b, 2.5) * (0.6 + 0.4 * c) * 3.0;
}

float ggx(float NdotH, float a2){
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float smithVis(float NdotL, float NdotV, float a2){
  float gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-4);
}

// 細い線（整数のところで 1、それ以外 0）。core の flip_line は現状「線の上で 0」なので、水は自前のものを使う
float water_line(float v, float wPx){
  float f = abs(fract(v) - 0.5);
  float d = max(fwidth(v), 1e-5);
  float w = wPx * d;
  return smoothstep(0.5 - w - d, 0.5 - w + d, f);
}
// 風向の矢印（裏返し用）。cell 内の線分 SDF
float water_arrow(vec2 xz, vec2 wd, float cell){
  vec2 g = xz / cell;
  vec2 p = (fract(g) - 0.5) * cell;
  vec2 perp = vec2(-wd.y, wd.x);
  vec2 q = vec2(dot(p, wd), dot(p, perp));
  float w = fwidth(q.x) * 1.2;
  float shaft = (1.0 - smoothstep(0.03, 0.03 + w, abs(q.y))) * step(abs(q.x), 2.4);
  vec2 h1 = q - vec2(2.4, 0.0);
  float a1 = abs(dot(h1, normalize(vec2(0.7, -0.7))));
  float a2 = abs(dot(h1, normalize(vec2(0.7, 0.7))));
  float head = (1.0 - smoothstep(0.03, 0.03 + w, a1)) * step(dot(h1, normalize(vec2(-0.7, 0.7))), 0.0) * step(-1.5, dot(h1, normalize(vec2(-0.7, 0.7))))
             + (1.0 - smoothstep(0.03, 0.03 + w, a2)) * step(dot(h1, normalize(vec2(-0.7, -0.7))), 0.0) * step(-1.5, dot(h1, normalize(vec2(-0.7, -0.7))));
  head *= step(h1.x, 0.0) * step(-1.1, h1.x);
  return clamp(shaft + head, 0.0, 1.0);
}

void main(){
  vec3 toP = vWorld - uCamPos;
  float dist = length(toP);
  vec3 Vdir = toP / max(dist, 1e-4);
  vec3 V = -Vdir;
  vec2 suv = gl_FragCoord.xy / uResolution;
  bool under = uWaterB.x > 0.5;
  vec2 wd = normalize(uWind.xy + vec2(1e-4, 0.0));
  float wind = uWind.z;

  // ---- 傾き（2 カスケード。ミップで距離に応じてならされる。消えた分の分散 = 粗さ）
  float shoreFade = smoothstep(0.0, 2.2, vDepthA);
  // 画素の足跡（湖面の上での大きさ, m）。dFdx(vWorld) から作ると、頂点変位のせいで
  // 極座標メッシュの三角形ごとにミップが跳んで「楔状の継ぎ目」になる。カメラの幾何から解析的に出す。
  float pixAngS = 2.0 * uWaterB.y / max(uResolution.y, 1.0);
  float fpW = dist * pixAngS;                                       // 視線に直交する向き
  float fpL = min(fpW / max(abs(Vdir.y), 0.004), 3000.0);           // 視線に沿う向き（浅いほど長い）
  float fp = mix(fpW, fpL, 0.75);
  vec2 g0 = vec2(fp / uTiles.x, 0.0), g1 = vec2(fp / uTiles.y, 0.0);
  vec4 d0 = texture2DGradEXT(tDeriv0, vWorld.xz / uTiles.x, g0, g0.yx);
  vec4 d1 = texture2DGradEXT(tDeriv1, vWorld.xz / uTiles.y, g1, g1.yx);
  float w0 = uWaveAmp.x * shoreFade;
  float w1 = uWaveAmp.y * shoreFade * vGust;
  vec2 slope = d0.xy * w0 + d1.xy * w1;
  float var = max(d0.z - dot(d0.xy, d0.xy), 0.0) * w0 * w0 + max(d1.z - dot(d1.xy, d1.xy), 0.0) * w1 * w1;
  // 浅瀬の波（解析的な傾き）
  {
    vec2 sw = water_shoreWave(vWorld.xz, vDepthA, uTime, wind);
    float env = smoothstep(0.0, 0.6, vDepthA) * (1.0 - smoothstep(4.0, 30.0, vDepthA));
    float amp = (0.012 + 0.05 * smoothstep(1.0, 10.0, wind)) * env;
    float k = 6.2831853 / 9.0;
    // 寄せ波は波長 9m しかないので、浅い視線で 1 画素が波長に近づくと
    // 「等間隔の横縞」に潰れる（夜の湖面のバンディング）。画素の足跡で消す
    slope += -amp * k * sin(sw.y) * vShoreDir
           * (1.0 - smoothstep(40.0, 140.0, dist)) * (1.0 - smoothstep(0.30, 1.4, fp));
  }
  // 雨の波紋（法線のリング）。輪の波長は 10cm しかないので、1 画素で解けなくなったら描かない
  // （描くと 1 画素ごとに法線が暴れ、スペキュラが 2px の市松ノイズになる）。約 10m 以遠で切れる
  float ringRes = 1.0 - smoothstep(0.02, 0.12, fp);        // 1 = 輪が解ける
  float rainNear = uRain * ringRes * (1.0 - 0.6 * smoothstep(3.0, 9.0, wind));
  if (rainNear > 0.005) {
    int layers = int(uWaterB.z);
    slope += water_rain(vWorld.xz, uTime, uRain, layers) * rainNear;
  }
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // シミュに載らない細かいさざ波（2cm 以下＝表面張力波）。1 画素より細かい分を粗さとして戻す。
  // これが無いと無風〜微風の湖が「完全な鏡」になる（Cox–Munk の傾き分散を湖向けに控えめにしたもの）
  // 岸ぎわほど静か。smoothstep で切ると、深さが一定の所に「まっすぐな帯（楔）」の縁が出るので指数で
  float calmShore = 1.0 - 0.6 * exp(-max(vDepthA, 0.0) / 2.2);
  float mssCap = (0.0011 + 0.0021 * wind) * mix(0.25, 1.15, vGust) * calmShore;
  float varCap = mssCap * smoothstep(0.002, 0.02, fp);
  // 解けなくなった雨の輪の傾きの分散（振幅 4mm × 波数 62.8 rad/m を面積で均したもの）。
  // dFdx(N) で測ると値が 2×2 画素の塊ごとに跳ぶ（微分は quad 単位）ので、市松ノイズの元になる。
  // 解析的に、しかも ringRes と連続につながる形で足す
  float varRing = 0.0075 * uRain * (1.0 - ringRes) * calmShore;
  // 粗さ²
  float a2 = 0.0009 + var + varCap + varRing;
  float sigma = sqrt(0.5 * var + 0.00005);

  vec3 sunL = uSunColor;
  vec3 lightIn = (uSkyAmbient + sunL * clamp(uSunDir.y * 3.0, 0.0, 1.0) * 0.35) / PI;
  vec3 col;

  if (!under) {
    // ---- 水深（コピーした線形深度 → 視線に沿った水中の長さ）
    float cosV = max(dot(Vdir, uCamFwd), 0.05);
    float sceneZ = texture2D(tSceneDepth, suv).r;
    float rayS = vViewZ / cosV;
    float along = max(sceneZ / cosV - rayS, 0.0);
    float sinDown = max(-Vdir.y, 0.0);

    // ---- 屈折: 屈折した視線が湖底に当たる点を画面に投影し直す（深さ・角度で自然に歪む）
    vec3 T = refract(Vdir, N, 0.7519);
    float vert0 = along * sinDown;
    float alongT = min(vert0 / max(-T.y, 0.08), 40.0);
    vec3 Pb = vWorld + T * alongT;
    vec4 cb = uViewProj * vec4(Pb, 1.0);
    vec2 rraw = cb.xy / max(cb.w, 1e-4) * 0.5 + 0.5;
    // ずらす量の上限。±0.06（96px）は波の揺らぎに要る量よりずっと大きく、遠くの岸まで届いてしまい
    // 「使えない → 戻す」の境目が湖の真ん中に直線の帯として出ていた
    vec2 roff = clamp(rraw - suv, vec2(-0.02), vec2(0.02));
    float zb = texture2D(tSceneDepth, suv + roff).r;
    // 屈折先が水面より上の物（岸・木）や水面より手前の物なら使わない（岸の砂が水中に写り込むのを防ぐ）。
    // 急に戻すと湖面の途中に継ぎ目の線が出るので、ずらす量をなだらかに 0 へ縮める
    float ySample = uCamPos.y + Vdir.y * (zb / cosV);
    float bad = smoothstep(uLakeLevel - 0.05, uLakeLevel + 0.55, ySample);
    // 手前の物に当たった判定は「距離に比例した幅」でなだらかに（固定 0.9m だと浅い視線で 1px の段になる）
    bad = max(bad, 1.0 - smoothstep(vViewZ, vViewZ + max(0.8, 0.08 * vViewZ), zb));
    vec2 uvT = suv + roff;
    bad = max(bad, 1.0 - smoothstep(0.0, 0.02, min(min(uvT.x, uvT.y), min(1.0 - uvT.x, 1.0 - uvT.y))));
    roff *= 1.0 - bad;
    vec2 ruv = suv + roff;
    zb = mix(zb, sceneZ, bad);
    float alongR = max(zb / cosV - rayS, 0.0);
    float vert = alongR * sinDown;
    if (uDebug > 8.5) { gl_FragColor = vec4(alongR * 0.0015, vert * 0.006, bad * 0.03, 1.0); return; }
    // 上流（コピーした景色）の異常値を水中に通さない。湖底の草・小石の鏡面が 1 画素の
    // 白／マゼンタの点になって残るのを防ぐ（発生源は地形・植生側）
    vec3 refr = clamp(texture2D(tSceneColor, ruv).rgb, vec3(0.0), vec3(8.0));

    // ---- コースティクス（浅瀬の湖底）
    float causticVis = (1.0 - smoothstep(1.2, 6.0, vert)) * (1.0 - smoothstep(30.0, 120.0, dist)) * clamp(uSunDir.y * 4.0, 0.0, 1.0);
    if (causticVis > 0.002) {
      vec2 bp = (vWorld + T * alongT).xz;
      float calm = 1.0 - 0.6 * smoothstep(2.0, 9.0, wind);
      // 網目が 1 画素より細かくなったらならす（残すと稜線の頂点が白い輝点＝デッドピクセルになる）
      float caa = 1.0 - smoothstep(0.05, 0.30, fp);
      float c = min(water_caustic(bp * 0.9, uTime), 2.0) * calm * caa;
      refr *= 1.0 + c * uWaterA.w * causticVis * (0.5 + 0.5 * vGust);
    }

    // ---- 吸収と散乱（浅瀬は砂が透け、深いと青緑へ）
    vec3 trans = exp(-uExtinction * (alongR + vert * 1.3));
    vec3 deep = uScatterColor * lightIn;
    vec3 body = refr * trans + deep * (1.0 - exp(-0.22 * alongR));

    // ---- フレネルと映り込み
    float NdotV = max(dot(N, V), 0.0);
    float F = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - NdotV, 5.0);
    vec3 R = reflect(Vdir, N);
    // ぼかし: 縦は粗さで広く、横は視線の浅さで狭い（波の面の反射は縦に伸びる）
    // 景色の映り込みは物理どおりに全部ぼかすと「絵」にならないので、FFT の分散は 3 割。
    // 一方、細かいさざ波（varCap）は遠いほど像を崩す ＝ 遠方が鏡そのものにならない
    // （風 3m/s・300m 先で σ ≈ 0.06。近くは像の形が残る）
    float farMix = 0.18 + 0.55 * smoothstep(60.0, 320.0, dist);
    float sigmaR = sqrt(0.30 * var + farMix * varCap + 0.30 * varRing + 0.00004);
    float pixAng = 2.0 * uWaterB.y / uReflSize.y;
    float blurPx = 2.0 * sigmaR / pixAng;
    // タップ 5 本の隙間をミップで埋める。埋めないと明るい物が「等間隔の横縞」に分裂する
    // （夜の湖面のバンディング。隙間 = 0.5·spread、その 0.45 倍をならす）
    float tapGapPx = 0.5 * min(2.0 * sigmaR, 0.10) / pixAng;
    float lod = clamp(max(log2(max(blurPx * max(sinDown, 0.06), 1.0)),
                          log2(max(tapGapPx * 0.45, 1.0))), 0.0, uWaterA.y);
    // 5 タップの縦ずらしを広げすぎると、映った山の形まで平らな灰色に潰れる（雨・曇天で
    // 「映り込みが消えた」に見える）。広い方のぼけはミップ（lod）に任せ、ずらしは 0.10 rad まで
    float spread = min(2.0 * sigmaR, 0.10);
    // 「映る物までの距離」の見当。平らな水面なら鏡像カメラは水面上の点で主カメラと一致するので、
    // L をいくつにしても像は自分の画素（suv）に戻る。L は「波で像がどれだけずれるか」だけを決める。
    // 以前の 6·dist+10 は遠くで像が RT の外へ飛び、clamp した縁が引き伸ばされて継ぎ目になっていた
    float dRefl = min(6.0 * dist + 10.0, 140.0);
    vec2 base = suv;
    vec3 refl = vec3(0.0);
    float wsum = 0.0;
    for (int k = -2; k <= 2; k++){
      float fk = float(k);
      float wk = 3.0 - abs(fk);
      vec3 Rk = R + vec3(0.0, fk * 0.5 * spread, 0.0);
      Rk.y = max(Rk.y, 0.012);
      vec2 off = projectRefl(vWorld + Rk * dRefl) - base;
      // RT からはみ出す分は「縮める」（clamp すると縁の色が伸びて継ぎ目になる）
      vec2 room = max(mix(base - 0.003, 0.997 - base, step(0.0, off)), vec2(0.0));
      vec2 sc = min(vec2(1.0), room / max(abs(off), vec2(1e-5)));
      vec2 uvk = clamp(base + off * min(sc.x, sc.y), vec2(0.002), vec2(0.998));
      refl += texture2DLodEXT(tReflection, uvk, lod).rgb * wk;
      wsum += wk;
    }
    refl /= wsum;
    if (uWaterA.x < 0.5) {
      vec3 Rs = R; Rs.y = max(Rs.y, 0.02);
      refl = flip_skyColor(normalize(Rs));
    }
    col = mix(body, refl, F);
    if (uDebug > 0.5 && uDebug < 6.5) {
      if (uDebug < 1.5) col = vec3(N.x * 4.0 + 0.5, N.z * 4.0 + 0.5, 0.5);
      else if (uDebug < 2.5) col = body;
      else if (uDebug < 3.5) col = refl;
      else if (uDebug < 4.5) col = refr;
      else if (uDebug < 5.5) col = vec3(var * 50.0, sigma * 10.0, 0.0);
      else col = vec3(d0.a, vDepthA * 0.2, vGust);
      gl_FragColor = vec4(col, 1.0); return;
    }

    // ---- 逆光の波頭の散乱（薄い緑に透ける）
    float back = pow(max(dot(Vdir, uSunDir), 0.0), 3.0);
    float crest = clamp(vDisp.y / max(uWaveAmp.w * 0.35, 0.02), 0.0, 1.0);
    col += uScatterColor * sunL * (0.12 / PI) * back * crest * (1.0 - F) * shoreFade;

    // ---- 太陽・月のギラつき（GGX。粗さは「ならされた波」の分散 → 光の方向に細長い帯になる）
    // 低い太陽・月では帯が長く伸びる（α 0.05 → 0.12）。狭いままだと 1 画素の白い輝点になる
    {
      vec3 H = normalize(V + uSunDir);
      float NdotL = max(dot(N, uSunDir), 0.0);
      float NdotH = max(dot(N, H), 0.0);
      float VdotH = max(dot(V, H), 0.0);
      float Fs = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - VdotH, 5.0);
      float a2s = max(a2, mix(0.0025, 0.0144, 1.0 - smoothstep(0.04, 0.30, uSunDir.y)));
      float spec = Fs * ggx(NdotH, a2s) * smithVis(NdotL, max(NdotV, 1e-3), a2s) * NdotL;
      // 月（uMoonColor は放射輝度の 1/4 で入っている。sky/lighting と同じ ×4）
      vec3 Hm = normalize(V + uMoonDir);
      float NdotLm = max(dot(N, uMoonDir), 0.0);
      float NdotHm = max(dot(N, Hm), 0.0);
      float VdotHm = max(dot(V, Hm), 0.0);
      float Fm = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - VdotHm, 5.0);
      float a2m = max(a2, mix(0.0025, 0.0144, 1.0 - smoothstep(0.04, 0.30, uMoonDir.y)));
      float specm = Fm * ggx(NdotHm, a2m) * smithVis(NdotLm, max(NdotV, 1e-3), a2m) * NdotLm;
      vec3 glint = sunL * min(spec, 9.0) * step(-0.02, uSunDir.y) + uMoonColor * 4.0 * min(specm, 9.0) * step(0.0, uMoonDir.y);
      col += glint;
      if (uDebug > 6.5 && uDebug < 7.5) { gl_FragColor = vec4(glint, 1.0); return; }
    }

    // ---- 泡: 波頭（ヤコビアン）＋ 岸の寄せ波
    {
      float foamCrest = d0.a * w0 * uWaterA.z;
      vec2 sw = water_shoreWave(vWorld.xz, vDepthA, uTime, wind);
      float wash = 0.5 + 0.5 * cos(sw.y + 1.2);
      // 岸からの距離（m）で細い帯にする。深さで作ると湖底の傾きで幅が暴れて「白い煙」になった
      float sdist = -water_shoreDist(max(vDepthA, 0.0));
      float bandOut = 0.75 + 0.55 * wash + 1.3 * smoothstep(2.0, 10.0, wind);   // 0.3〜1.2m（強風で広い）
      float band = smoothstep(0.03, 0.30, sdist) * (1.0 - smoothstep(bandOut * 0.5, bandOut, sdist));
      float foamShore = band * (0.25 + 0.75 * wash) * (0.30 + 0.70 * smoothstep(1.0, 8.0, wind));
      float foamN = flip_vfbm(vWorld.xz * 4.5 + vec2(uTime * 0.12, 0.0), 3);
      float foamN2 = flip_vnoise(vWorld.xz * 14.0 - vec2(0.0, uTime * 0.25));
      float m = clamp(foamCrest * 1.6 + foamShore, 0.0, 1.0);
      // 泡は「閾値で切り出した白い島」ではなく連続の濃淡にする（硬い縁だと白い紙片が並んで見える）。
      // 縁は画素 3 つぶん相当ぼかす（ノイズの特徴長 ≈ 0.22m あたりの変化量で閾値の幅を広げる）
      float f = foamN * 0.8 + foamN2 * 0.2 + 0.22 * m;
      float fw = clamp(3.0 * fpW / 0.22, 0.0, 0.30);
      float foamTex = smoothstep(0.55 - fw, 0.95 + fw, f);
      // 濃さは 0.5 まで。1 画素で泡の粒が解けなくなる 30m 以遠は出さない
      float foam = min(m * foamTex, 0.5);
      foam *= 1.0 - smoothstep(12.0, 30.0, dist);
      vec3 foamCol = (sunL * max(dot(N, uSunDir), 0.0) * 0.85 + uSkyAmbient * 0.9) / PI;
      col = mix(col, foamCol, foam);
      // 岸ぎわは透ける（水深 0 で湖底そのもの）
      // 岸線は解析的な深さ（なめらか）で、深いところの物との交線は深度バッファで
      float vertEdge = along * sinDown;
      // 交線の幅。fwidth を上限なしで使うと、浅い視線では湖底のうねりで数 m まで跳ね、
      // 湖の真ん中に「明るい破線」（湖底の砂がそのまま透ける筋）が出る。25cm で頭打ちにする
      float ew = clamp(3.0 * fwidth(vertEdge), 0.03, 0.25);
      float edgeA = smoothstep(0.0, 0.12, vDepthA);
      float edgeD = smoothstep(0.0, ew, vertEdge) * smoothstep(0.0, 0.15, along);
      // 深度バッファの交線は近く（地形 LOD が細かい範囲）だけ。遠くは地形メッシュの粗さで岸に点が並ぶ。
      // 深さの重みは指数（smoothstep だと深さ一定の所に真っ直ぐな帯の縁が出る）
      float edge = edgeA * mix(1.0, edgeD, (1.0 - exp(-max(vDepthA, 0.0) / 0.8)) * (1.0 - smoothstep(40.0, 90.0, dist)));
      if (uDebug > 7.5 && uDebug < 8.5) { gl_FragColor = vec4(foam, edge, 0.0, 1.0); return; }
      col = mix(texture2D(tSceneColor, suv).rgb, col, edge);
    }
  } else {
    // ---- 水中から見た水面: スネルの窓（屈折した空と山）と全反射（暗い水の色）
    vec3 Nd = -N;
    vec3 T = refract(Vdir, Nd, 1.333);
    bool tir = dot(T, T) < 0.5;
    float F = tir ? 1.0 : (WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - max(T.y, 0.0), 5.0));
    vec3 above = uScatterColor * lightIn * 0.4;
    if (!tir) {
      vec2 uva = projectRefl(vWorld + T * 40.0);
      if (uWaterA.x > 0.5 && all(greaterThan(uva, vec2(0.0))) && all(lessThan(uva, vec2(1.0)))) above = texture2D(tReflection, uva).rgb;
      else above = flip_skyColor(T);
      // 水面を通った太陽（窓の中で強い）
      float sunT = pow(max(dot(T, uSunDir), 0.0), 600.0);
      above += sunL * sunT * 3.0;
    }
    vec3 body = uScatterColor * lightIn * (0.35 + 0.65 * max(dot(Nd, Vdir), 0.0));
    col = mix(above * (1.0 - WATER_F0), body, F);
    // 水面のうねりが透ける光の筋
    col += uScatterColor * sunL * (0.4 / PI) * max(dot(N, uSunDir), 0.0) * (1.0 - F) * 0.5;
    // カメラから水面までの水の吸収と散乱
    col = col * exp(-uExtinction * dist) + uScatterColor * lightIn * (1.0 - exp(-0.25 * dist));
  }

  col = flip_applyAerial(col, vWorld);

  // ---- 裏返し: 青黒い紙に、波の関数を線で見せる
  float fm = flip_mask(vWorld);
  if (fm > 0.0) {
    vec3 fc = FLIP_BG;
    vec2 xz = vWorld.xz;
    float lp = uWaterB.w;
    float lineFade = 1.0 - smoothstep(120.0, 500.0, dist);
    // 各成分の等位相線（波数ベクトルに直交する線の族。周期の違うものを重ねる）。
    // 遠くは長い成分、近くは実際のピーク波長に近い成分が見える
    float lines = 0.0;
    for (int i = 0; i < 5; i++){
      float fi = float(i);
      float ang = (fi - 2.0) * 0.36;
      vec2 dir = vec2(wd.x * cos(ang) - wd.y * sin(ang), wd.x * sin(ang) + wd.y * cos(ang));
      float lam = (i == 0 ? 24.0 : (i == 1 ? 11.0 : (i == 2 ? 5.0 : (i == 3 ? max(lp, 1.6) : max(lp * 0.5, 0.7)))));
      float om = sqrt(9.81 * 6.2831853 / lam);
      float ph = dot(dir, xz) / lam - om * uTime / 6.2831853;
      float dens = fwidth(ph);
      float vis = (1.0 - smoothstep(0.12, 0.35, dens)) * (i == 2 ? 0.45 : 0.22);
      lines += water_line(ph, 0.5) * vis;
    }
    fc += FLIP_LINE * min(lines, 1.0) * lineFade;
    // 実際の変位の等高線（波の高さ。間隔は有義波高の 1/3）
    {
      float step = max(uWaveAmp.w / 3.0, 0.004);
      float hv = vDisp.y / step;
      float vis = (1.0 - smoothstep(0.2, 0.5, fwidth(hv))) * (1.0 - smoothstep(60.0, 220.0, dist));
      fc += FLIP_LINE * 0.7 * water_line(hv + 0.5, 1.0) * vis;
    }
    // 風向の矢印の格子
    float arrow = water_arrow(xz, wd, 12.0) * (1.0 - smoothstep(60.0, 220.0, dist));
    fc += FLIP_ACCENT * 0.8 * arrow;
    // 紙の上でも鏡であることは残す（裏返った山の等高線が薄く映る）
    if (uWaterA.x > 0.5 && !under) {
      vec3 R0 = reflect(Vdir, vec3(0.0, 1.0, 0.0));
      vec2 uv0 = clamp(projectRefl(vWorld + R0 * (6.0 * dist + 10.0)), vec2(0.002), vec2(0.998));
      vec3 rr = texture2DLodEXT(tReflection, uv0, 0.0).rgb;
      fc += FLIP_LINE * 0.3 * dot(rr, vec3(0.3, 0.5, 0.2));
    }
    fc += FLIP_ACCENT * flip_edgeGlow(vWorld) * 1.5;
    fc = flip_applyAerial(fc, vWorld) * 0.25 + fc * 0.75;   // 紙は遠くでも暗いまま（水だと分かる）
    col = mix(col, fc, fm);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;
