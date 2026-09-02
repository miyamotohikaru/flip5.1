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
uniform float uDebug;   // 調査用 ?wdbg=1 法線 2 水の色 3 映り込み 4 屈折の元 5 分散 6 泡
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

const float F0 = 0.02;
#ifndef PI
#define PI 3.14159265
#endif

vec2 projectRefl(vec3 p){
  vec4 c = uReflMatrix * vec4(p, 1.0);
  return c.xy / max(c.w, 1e-4);
}

// 雨粒の波紋。格子ごとに 1 粒、周囲 3×3 を見て輪が格子の縁で切れないように。返り値は傾き
float g_rainSplash = 0.0;
vec2 water_rain(vec2 p, float t, float amount, int layers){
  vec2 s = vec2(0.0);
  float cellSize = 1.6;
  for (int L = 0; L < 3; L++){
    if (L >= layers) break;
    vec2 pc = p / cellSize + float(L) * 7.3;
    vec2 cell = floor(pc);
    for (int y = -1; y <= 1; y++){
      for (int x = -1; x <= 1; x++){
        vec2 c = cell + vec2(float(x), float(y));
        vec3 h = flip_hash33(vec3(c, float(L) * 3.1));
        if (h.z > amount * 1.15) continue;                 // 雨量で粒の数
        vec2 dropPos = (c + h.xy) * cellSize;
        float period = 1.6 + 0.6 * h.x;
        float tt = fract(t / period + h.y);                // 0..1 で一生
        float radius = tt * 0.55;
        vec2 dv = p - dropPos;
        float r = length(dv);
        float ring = r - radius;
        float win = 1.0 - smoothstep(0.0, 0.16, abs(ring));
        float ampl = (1.0 - tt) * (1.0 - tt) * 0.011;
        // 波面: sin(60 ring) の傾き
        float dh = ampl * cos(60.0 * ring) * 60.0 * win;
        s += dh * dv / max(r, 0.02);
        // 落ちた瞬間の王冠（白い点）
        g_rainSplash += (1.0 - smoothstep(0.03, 0.11, r)) * (1.0 - smoothstep(0.0, 0.14, tt));
      }
    }
    cellSize *= 0.62;
  }
  return s;
}

// コースティクス（湖底の光のゆらぎ）。2 方向の稜線ノイズの積
float water_caustic(vec2 p, float t){
  float a = 1.0 - abs(flip_gnoise(p * 1.9 + vec2(t * 0.35, -t * 0.2)));
  float b = 1.0 - abs(flip_gnoise(p * 2.3 + vec2(-t * 0.25, t * 0.3) + 5.0));
  float c = 1.0 - abs(flip_gnoise(p * 4.1 + vec2(t * 0.5, t * 0.1) + 9.0));
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
  // 傾きテクスチャは「画素の足跡の長い方」でミップを選ぶ（浅い視線で行ごとにちらつかない）
  vec2 fx = dFdx(vWorld.xz), fy = dFdy(vWorld.xz);
  float fl = max(length(fx), length(fy)), fs = min(length(fx), length(fy));
  float fp = mix(fs, fl, 0.75);
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
    slope += -amp * k * sin(sw.y) * vShoreDir * (1.0 - smoothstep(40.0, 140.0, dist));
  }
  // 雨の波紋
  float rainNear = (1.0 - smoothstep(12.0, 60.0, dist)) * uRain * (1.0 - 0.75 * smoothstep(3.0, 9.0, wind));
  float splash = 0.0;
  if (rainNear > 0.005) {
    int layers = int(uWaterB.z);
    slope += water_rain(vWorld.xz, uTime, uRain, layers) * rainNear;
    splash = min(g_rainSplash, 1.0) * rainNear;
  }
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // 粗さ²: 素の水 + ならされた傾きの分散 + 雨で荒れる
  float a2 = 0.0009 + var + uRain * 0.006 * (1.0 - rainNear * 0.6) + 0.0004 * smoothstep(40.0, 600.0, dist);
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
    vec2 ruv = cb.xy / max(cb.w, 1e-4) * 0.5 + 0.5;
    ruv = suv + clamp(ruv - suv, vec2(-0.06), vec2(0.06));
    float zb = texture2D(tSceneDepth, ruv).r;
    // 屈折先が水面より上の物（岸・木）なら使わない（岸の砂が水中に写り込むのを防ぐ）
    float ySample = uCamPos.y + Vdir.y * (zb / cosV);
    if (zb < vViewZ + 0.05 || ySample > uLakeLevel + 0.03 || any(lessThan(ruv, vec2(0.0))) || any(greaterThan(ruv, vec2(1.0)))) { ruv = suv; zb = sceneZ; }
    float alongR = max(zb / cosV - rayS, 0.0);
    float vert = alongR * sinDown;
    vec3 refr = texture2D(tSceneColor, ruv).rgb;

    // ---- コースティクス（浅瀬の湖底）
    float causticVis = (1.0 - smoothstep(1.2, 6.0, vert)) * (1.0 - smoothstep(30.0, 120.0, dist)) * clamp(uSunDir.y * 4.0, 0.0, 1.0);
    if (causticVis > 0.002) {
      vec2 bp = (vWorld + T * alongT).xz;
      float calm = 1.0 - 0.6 * smoothstep(2.0, 9.0, wind);
      float c = water_caustic(bp * 0.9, uTime) * calm;
      refr *= 1.0 + c * uWaterA.w * causticVis * (0.5 + 0.5 * vGust);
    }

    // ---- 吸収と散乱（浅瀬は砂が透け、深いと青緑へ）
    vec3 trans = exp(-uExtinction * (alongR + vert * 1.3));
    vec3 deep = uScatterColor * lightIn;
    vec3 body = refr * trans + deep * (1.0 - exp(-0.22 * alongR));

    // ---- フレネルと映り込み
    float NdotV = max(dot(N, V), 0.0);
    float F = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
    vec3 R = reflect(Vdir, N);
    // ぼかし: 縦は粗さで広く、横は視線の浅さで狭い（波の面の反射は縦に伸びる）
    // 景色の映り込みは物理どおりに全部ぼかすと「絵」にならないので、分散の 3 割だけ使う（ギラつきは全部使う）
    float sigmaR = sqrt(0.15 * var + 0.00004);
    float pixAng = 2.0 * uWaterB.y / uReflSize.y;
    float blurPx = 2.0 * sigmaR / pixAng;
    float lod = clamp(log2(max(blurPx * max(sinDown, 0.06), 1.0)), 0.0, uWaterA.y);
    float spread = min(2.0 * sigmaR, 0.08);
    float dRefl = 6.0 * dist + 10.0;
    vec3 refl = vec3(0.0);
    float wsum = 0.0;
    for (int k = -2; k <= 2; k++){
      float fk = float(k);
      float wk = 3.0 - abs(fk);
      vec3 Rk = R + vec3(0.0, fk * 0.5 * spread, 0.0);
      Rk.y = max(Rk.y, 0.015);
      vec2 uvk = projectRefl(vWorld + Rk * dRefl);
      uvk = clamp(uvk, vec2(0.002), vec2(0.998));
      refl += texture2DLodEXT(tReflection, uvk, lod).rgb * wk;
      wsum += wk;
    }
    refl /= wsum;
    if (uWaterA.x < 0.5) {
      vec3 Rs = R; Rs.y = max(Rs.y, 0.02);
      refl = flip_skyColor(normalize(Rs));
    }
    col = mix(body, refl, F);
    if (uDebug > 0.5) {
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

    // ---- 太陽・月のギラつき（GGX。粗さは「ならされた波」の分散 → 太陽方向に細長い帯になる）
    {
      vec3 Ns = N;
      float a2g = a2;
      vec3 H = normalize(V + uSunDir);
      float NdotL = max(dot(Ns, uSunDir), 0.0);
      float NdotH = max(dot(Ns, H), 0.0);
      float VdotH = max(dot(V, H), 0.0);
      float Fs = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
      float a2s = max(a2g, 0.0012);
      float spec = Fs * ggx(NdotH, a2s) * smithVis(NdotL, max(NdotV, 1e-3), a2s) * NdotL;
      col += sunL * min(spec, 14.0) * step(-0.02, uSunDir.y);
      vec3 Hm = normalize(V + uMoonDir);
      float NdotLm = max(dot(N, uMoonDir), 0.0);
      float specm = F0 * ggx(max(dot(N, Hm), 0.0), max(a2, 0.002)) * smithVis(NdotLm, max(NdotV, 1e-3), max(a2, 0.002)) * NdotLm;
      col += uMoonColor * 9.0 * min(specm, 60.0);
    }

    // ---- 泡: 波頭（ヤコビアン）＋ 岸の寄せ波
    {
      float foamCrest = d0.a * w0 * uWaterA.z;
      vec2 sw = water_shoreWave(vWorld.xz, vDepthA, uTime, wind);
      float wash = 0.5 + 0.5 * cos(sw.y + 1.2);
      float shallow = 1.0 - smoothstep(0.02, 0.9 + 0.8 * smoothstep(2.0, 10.0, wind), vDepthA);
      float foamShore = shallow * (0.1 + 0.9 * wash) * smoothstep(0.0, 0.05, vDepthA) * (0.35 + 0.65 * smoothstep(1.0, 8.0, wind)) * (1.0 - smoothstep(60.0, 220.0, dist));
      float foamN = flip_vfbm(vWorld.xz * vec2(1.7, 1.7) + vec2(uTime * 0.12, 0.0), 3);
      float foamN2 = flip_vnoise(vWorld.xz * 6.0 - vec2(0.0, uTime * 0.2));
      float m = clamp(foamCrest * 1.6 + foamShore, 0.0, 1.0);
      float foamTex = smoothstep(0.62 - 0.3 * m, 0.82 - 0.2 * m, foamN * 0.85 + foamN2 * 0.15 + m * 0.18);
      float texFade = 1.0 - smoothstep(0.25, 0.9, fp);   // 画素より細かい泡はならして消す
      float foam = m * mix(foamTex * texFade, 1.0, 0.35 * smoothstep(0.75, 1.0, m));
      foam *= 1.0 - smoothstep(60.0, 400.0, dist) * 0.5;
      vec3 foamCol = (sunL * max(dot(N, uSunDir), 0.0) * 0.85 + uSkyAmbient * 0.9) / PI;
      col = mix(col, foamCol, foam);
      col = mix(col, foamCol * 1.3, splash * 0.85);
      // 岸ぎわは透ける（水深 0 で湖底そのもの）
      // 岸線は解析的な深さ（なめらか）で、深いところの物との交線は深度バッファで
      float vertEdge = along * sinDown;
      float ew = max(0.05, 3.0 * fwidth(vertEdge));
      float edgeA = smoothstep(0.0, 0.12, vDepthA);
      float edgeD = smoothstep(0.0, ew, vertEdge) * smoothstep(0.0, 0.15, along);
      // 深度バッファの交線は近く（地形 LOD が細かい範囲）だけ。遠くは地形メッシュの粗さで岸に点が並ぶ
      float edge = edgeA * mix(1.0, edgeD, smoothstep(1.5, 3.0, vDepthA) * (1.0 - smoothstep(40.0, 90.0, dist)));
      col = mix(texture2D(tSceneColor, suv).rgb, col, edge);
    }
  } else {
    // ---- 水中から見た水面: スネルの窓（屈折した空と山）と全反射（暗い水の色）
    vec3 Nd = -N;
    vec3 T = refract(Vdir, Nd, 1.333);
    bool tir = dot(T, T) < 0.5;
    float F = tir ? 1.0 : (F0 + (1.0 - F0) * pow(1.0 - max(T.y, 0.0), 5.0));
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
    col = mix(above * (1.0 - F0), body, F);
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
