// 空のドーム（フルスクリーン三角形）。Sky-View LUT の空 ＋ 太陽の円盤 ＋ 月 ＋ 星・天の川 ＋ 雲の合成 ＋ 地表の霧 ＋ 裏返し。
import { CLOUD_COMMON } from "./clouds.glsl";

export const SKY_VERT = /* glsl */ `
varying vec2 vNdc;
void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

export const SKY_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${CLOUD_COMMON}
uniform vec2 uProjScale;      // 射影行列の [0][0], [1][1]（NDC → 視線）
uniform mat4 uCamWorld;
uniform sampler2D uCloudTex;  // 主カメラのレイマーチ結果（premultiplied）
uniform mat4 uMainViewProj;   // 主カメラ（雲 RT の再投影）
uniform float uCloudMode;     // 0 = RT を使う（外は簡易雲）, 1 = 簡易雲だけ（環境マップ用）
uniform vec3 uSunE;           // 大気の外での太陽の放射照度
uniform float uMoonRadiance;  // 月面の輝度スケール
uniform float uPixelAngle;    // 1 画素の角度 (rad)
uniform mat3 uStarFrame;      // 天球座標（時刻で回る）
uniform vec3 uCheapCloudColor;
uniform float uStarVeil;      // 星の見える度合い（昼は 0）
varying vec2 vNdc;

// 細い線（core の flip_line は反転しているので自前）: v が整数のところで 1
float sky_line(float v, float px){
  float f = abs(fract(v) - 0.5);
  float fw = fwidth(v);
  float d = fw * px;
  return smoothstep(0.5 - d - fw * 0.5, 0.5 - d + fw * 0.5, f);
}

// ---- 星（立方体の面ごとの格子。1 セルに 1 星、位置は決定的） ----
vec3 sky_starDir(vec2 sf, float face){
  vec3 sd;
  if (face < 1.5) sd = vec3(face < 0.5 ? 1.0 : -1.0, sf.x, sf.y);
  else if (face < 3.5) sd = vec3(sf.x, face < 2.5 ? 1.0 : -1.0, sf.y);
  else sd = vec3(sf.x, sf.y, face < 4.5 ? 1.0 : -1.0);
  return normalize(sd);
}
vec3 sky_stars(vec3 d, float band){
  vec3 a = abs(d);
  vec2 f; float face;
  if (a.x >= a.y && a.x >= a.z){ f = d.yz / a.x; face = d.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= a.z){ f = d.xz / a.y; face = d.y > 0.0 ? 2.0 : 3.0; }
  else { f = d.xy / a.z; face = d.z > 0.0 ? 4.0 : 5.0; }
  const float S = 320.0;
  vec2 g = (f * 0.5 + 0.5) * S;
  vec2 base = floor(g - 0.5);
  float density = 0.004 + 0.012 * band;
  float sig0 = max(uPixelAngle * 0.7, 0.00020);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++){
    vec2 cell = base + vec2(float(i), float(j));
    if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(S)))) continue;
    float h = flip_hash12(cell * 1.7 + face * 131.0 + 0.37);
    if (h > density) continue;
    vec2 hs = flip_hash22(cell + face * 977.0);
    vec2 sp = cell + 0.5 + (hs - 0.5) * 0.64;
    vec3 sd = sky_starDir(sp / S * 2.0 - 1.0, face);
    float sinA = length(cross(d, sd));
    float ang = atan(sinA, dot(d, sd));
    float hb = flip_hash12(cell * 3.1 + face * 71.0 + 0.71);
    // 等級のばらつき: 実際の星の数は明るさの -1.5 乗（b = b0·u^(-1/1.5)）。
    // ほとんどは肉眼でぎりぎり、上限 0.25 に届くのは 0.3% だけ
    float b = min(0.0045 * pow(max(hb, 1.0e-3), -0.667), 0.25);
    // 明るい星だけ少し太る（にじみ）。暗い星は 1 画素以下
    float sig = sig0 * (1.0 + 0.55 * smoothstep(0.02, 0.22, b));
    float tw = 1.0 + 0.22 * sin(uTime * (2.0 + 5.0 * hs.y) + h * 100.0) * (1.0 - 0.6 * smoothstep(0.02, 0.1, b));
    vec3 tint = mix(vec3(1.0, 0.74, 0.52), vec3(0.72, 0.82, 1.0), fract(h * 57.13));
    acc += tint * b * tw * exp(-(ang * ang) / (2.0 * sig * sig));
  }
  return acc;
}

// ---- 月（位相は固定。海と地形はノイズ） ----
vec3 sky_moon(vec3 d, out float mask){
  float cM = dot(d, uMoonDir);
  float sinA = length(cross(d, uMoonDir));
  float ang = atan(sinA, cM);
  const float R = 0.0115;
  mask = 1.0 - smoothstep(R - uPixelAngle, R + uPixelAngle, ang);
  if (mask <= 0.0) return vec3(0.0);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
  vec3 up = cross(uMoonDir, right);
  float x = dot(d, right) / R, y = dot(d, up) / R;
  float z = sqrt(max(0.0, 1.0 - x * x - y * y));
  vec3 n = vec3(x, y, z);
  vec3 Lm = normalize(vec3(0.62, 0.22, 0.75));
  float ndl = max(dot(n, Lm), 0.0);
  float maria = smoothstep(0.40, 0.62, flip_fbm(n * 2.4 + vec3(4.1, 7.3, 1.9), 4) * 0.5 + 0.5);
  float crat = flip_vnoise(n * 14.0 + 3.0);
  float alb = mix(1.0, 0.42, maria) * (0.82 + 0.18 * crat);
  return vec3(1.0, 0.97, 0.90) * alb * (ndl + 0.012) * uMoonRadiance;
}

// ---- 簡易雲（雲 RT の外・環境マップ用。天気マップの雲量だけ） ----
vec4 sky_cheapClouds(vec3 d){
  if (d.y < 0.005) return vec4(0.0);
  vec3 o = vec3(0.0, flip_camR(uCamPos), 0.0);
  float mid = mix(uCloudLayer.x, uCloudLayer.y, 0.35);
  float t = flip_raySphere(o, d, FLIP_RGROUND + mid * 0.001);
  if (t < 0.0) return vec4(0.0);
  vec3 p = uCamPos + d * (t * 1000.0);
  vec4 w = cl_weather(p.xz);
  float dens = cl_density(p, 0.35, w, false);
  float a = 1.0 - exp(-dens * (uCloudLayer.y - uCloudLayer.x) * uCloudLayer.w * 0.45);
  a *= smoothstep(0.0, 0.05, d.y);
  vec4 ap = flip_aerial(p);
  return vec4((uCheapCloudColor * ap.a + ap.rgb) * a, a);
}

// 地表の霧: 無限遠まで
float sky_fogOdInfinity(vec3 cam, vec3 d){
  float y0 = max(cam.y, -50.0);
  float p1 = min(uSkyFog.y / max(d.y, 1e-4), 30000.0);
  float p2 = min(uSkyFog2.y / max(d.y, 1e-4), 30000.0);
  return uSkyFog.x * exp(-y0 / uSkyFog.y) * p1 + uSkyFog2.x * exp(-y0 / uSkyFog2.y) * p2;
}

void main(){
  vec3 vd = normalize(vec3(vNdc.x / uProjScale.x, vNdc.y / uProjScale.y, -1.0));
  vec3 d = normalize((uCamWorld * vec4(vd, 0.0)).xyz);
  float camR = flip_camR(uCamPos);

  // 空（散乱）
  vec3 sky = flip_skyColor(d);
  // 視線方向に大気を抜ける透過率（太陽・月・星の減光）
  vec3 Tv = flip_atmoTrans(camR, d.y);

  // 太陽の円盤（周辺減光）と光冠
  float cS = dot(d, uSunDir);
  float sunAng = atan(length(cross(d, uSunDir)), cS);
  const float sunR = 0.0105;   // 実際の 0.27° より大きめ（AAA の慣例）
  float disc = 1.0 - smoothstep(sunR - uPixelAngle, sunR + uPixelAngle, sunAng);
  float limb = 1.0 - 0.55 * (1.0 - sqrt(max(0.0, 1.0 - (sunAng * sunAng) / (sunR * sunR))));
  // 光冠（エアロゾルの前方散乱）。太陽が低いほど広く強い＝日没の「にじむ橙の玉」
  float lowSun = 1.0 - smoothstep(0.02, 0.26, uSunDir.y);
  float coronaA = mix(0.004, 0.020, lowSun);
  float coronaW = mix(0.012, 0.050, lowSun);
  vec3 sunLight = uSunE * Tv * (disc * limb * 60.0 + coronaA * exp(-sunAng / coronaW));

  // 月
  float moonMask;
  vec3 moonLight = sky_moon(d, moonMask) * Tv;

  // 星と天の川
  vec3 starLight = vec3(0.0);
  float band = 0.0;
  if (uStarVeil > 0.001 && d.y > -0.05){
    vec3 e = uStarFrame * d;
    float gp = dot(e, vec3(0.0, 0.87, 0.5));
    band = exp(-(gp * gp) / (2.0 * 0.16 * 0.16));
    starLight = sky_stars(d, band);
    float lanes = flip_fbm(e * 6.0 + 2.0, 4) * 0.5 + 0.5;
    float mw = band * (0.25 + 0.75 * smoothstep(0.28, 0.85, lanes)) * (1.0 - 0.55 * smoothstep(0.55, 0.8, flip_fbm(e * 13.0 + 7.0, 3) * 0.5 + 0.5));
    starLight += vec3(0.95, 0.9, 0.85) * mw * 0.006;
    starLight *= uStarVeil * Tv;
  }

  vec3 col = sky + sunLight + moonLight * (1.0 - disc) + starLight * (1.0 - moonMask);

  // 雲（主カメラの RT を方向で引く。範囲外と環境マップは簡易雲）
  vec4 cl = vec4(0.0);
  if (uCloudMode < 0.5){
    vec4 c = uMainViewProj * vec4(d, 0.0);
    vec2 cuv = c.xy / c.w * 0.5 + 0.5;
    if (c.w > 0.0 && all(greaterThanEqual(cuv, vec2(0.0))) && all(lessThanEqual(cuv, vec2(1.0)))) cl = texture2D(uCloudTex, cuv);
    else cl = sky_cheapClouds(d);
  } else cl = sky_cheapClouds(d);
  col = col * (1.0 - cl.a) + cl.rgb;

  // 地表の霧（空の側。地形側の flip_aerial と同じむらの式）
  float od = sky_fogOdInfinity(uCamPos, d) * flip_fogPatch((uCamPos + d * 2000.0).xz);
  float tf = exp(-od);
  col = col * tf + flip_fogLight(d) * (1.0 - tf);

  // 裏返し: 地平線から天頂へ波が登る
  float skyDist = 2600.0 + 3400.0 * clamp(d.y, 0.0, 1.0);
  vec3 fp = uFlipCenter + d * skyDist;
  float fm = flip_mask(fp);
  if (fm > 0.0){
    vec3 fc = FLIP_BG;
    // 散乱の等値線（空の輝度の log2）
    float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
    float lv = log2(max(lum, 1e-5));   // 1 段（1 EV）刻み。0.5 刻みだと線が多すぎて模様になる
    fc += FLIP_LINE * 0.5 * sky_line(lv, 1.0);
    // 太陽からの角度 20° 刻み（薄く）
    fc += FLIP_LINE * 0.14 * sky_line(degrees(sunAng) / 20.0, 0.7);
    // 天球の格子（赤緯・赤経 30°）
    vec3 e = uStarFrame * d;
    float dec = degrees(asin(clamp(e.z, -1.0, 1.0)));
    float ra = degrees(atan(e.y, e.x));
    float grid = max(sky_line(dec / 30.0, 0.7), sky_line(ra / 30.0, 0.7) * smoothstep(0.0, 0.2, 1.0 - abs(e.z)));
    fc += FLIP_LINE * 0.28 * grid;
    // 雲の密度場のスライス（層の 3 つの高さ）
    if (d.y > 0.01){
      vec3 o = vec3(0.0, camR, 0.0);
      for (int k = 0; k < 3; k++){
        float hf = 0.2 + 0.3 * float(k);
        float alt = mix(uCloudLayer.x, uCloudLayer.y, hf);
        float t = flip_raySphere(o, d, FLIP_RGROUND + alt * 0.001);
        if (t < 0.0) continue;
        vec3 p = uCamPos + d * (t * 1000.0);
        float dens = cl_density(p, hf, cl_weather(p.xz), false);
        float iso = sky_line(dens * 5.0, 0.8) * step(0.02, dens);
        fc += FLIP_LINE * (0.5 - 0.12 * float(k)) * iso * smoothstep(0.01, 0.08, d.y);
      }
    }
    // 太陽・月は輪郭、星は点
    float ring = 1.0 - smoothstep(0.0, uPixelAngle * 1.5, abs(sunAng - sunR * 1.6));
    fc += FLIP_ACCENT * (ring + disc * 0.6);
    fc += FLIP_LINE * moonMask * 0.5;
    fc += FLIP_LINE * clamp(dot(starLight, vec3(6.0)), 0.0, 1.0);
    fc += FLIP_ACCENT * flip_edgeGlow(fp) * 1.6;
    col = mix(col, fc, fm);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;
