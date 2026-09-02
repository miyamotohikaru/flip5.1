// 合成と色調（HDR → LDR）。1 パスで:
//   レンズの水滴（雨）→ 水中のゆらぎ → 裏返しの縁のリップル/色収差 → 被写界深度 → AO → 水中の霧
//   → ブルーム（mix）→ ゴッドレイ → レンズフレア → 自動露出 → AgX → グレーディング（白バランス・
//   スプリットトーン・コントラスト・彩度）→ ビネット → sRGB エンコード。alpha に裏返しマスク（最終パスのシャープ用）。
import * as THREE from "three";
import { POST_COMMON } from "./pass";
import { AGX_GLSL } from "./agx.glsl";
import { DOF_COC } from "./dof";

export const GRADE_FRAG = /* glsl */ `
${POST_COMMON}
${AGX_GLSL}
${DOF_COC}
#include <flip_flip>
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform sampler2D tBloomFine;
uniform sampler2D tGod;
uniform sampler2D tGodMask;
uniform sampler2D tAO;
uniform sampler2D tDof;
uniform sampler2D tAdapt;
uniform vec2 uRes;
uniform vec2 uTexel;
uniform vec2 uHalfRes;
uniform float uNear;
uniform float uFar;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColorN;
uniform vec2 uSunScreen;
uniform float uSunFront;
uniform float uBloomNorm;
uniform float uBloomStrength;
uniform float uGodStrength;
uniform float uFlareStrength;
uniform float uAoStrength;
uniform float uDofOn;
uniform float uExposure;
uniform float uAutoStrength;
uniform float uAutoRef;
uniform vec2 uAutoRange;
uniform float uWarmth;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform vec2 uSplit;
uniform float uVignette;
uniform float uGradeOn;
uniform float uDebug;
uniform float uRain;
uniform float uUnderwater;
uniform float uAspect;
varying vec2 vUv;

vec3 sceneAt(vec2 uv){ return texture2D(tScene, uv).rgb; }

// ---- レンズの水滴。xy = 屈折による uv のずれ, z = 水滴マスク, w = 縁のハイライト
vec4 rainDrops(vec2 uv){
  float rain = smoothstep(0.08, 0.6, uRain);
  if (rain <= 0.0) return vec4(0.0);
  vec2 p = uv * vec2(uAspect, 1.0);
  vec2 cellSize = vec2(0.11, 0.14);
  vec2 cell = floor(p / cellSize);
  vec2 f = fract(p / cellSize);
  float h = post_hash12(cell + 7.1);
  // 画面の縁ほど付きやすい（中央は視界を邪魔しない）
  vec2 dc = abs(uv - 0.5) * 2.0;
  float edgeBias = 0.35 + 0.65 * smoothstep(0.3, 1.0, max(dc.x, dc.y));
  float density = (0.06 + 0.16 * rain) * edgeBias;
  if (h > density) return vec4(0.0);
  vec2 rnd = vec2(post_hash12(cell + 1.7), post_hash12(cell + 3.9));
  float speed = 0.003 + 0.012 * post_hash12(cell + 9.3);
  vec2 center = vec2(0.25 + 0.5 * rnd.x, fract(rnd.y - uTime * speed));
  float radius = (0.007 + 0.009 * post_hash12(cell + 5.5)) / cellSize.y;
  vec2 dv = (f - center) / radius;
  dv.x *= 1.0 + 0.3 * (post_hash12(cell + 2.2) - 0.5);
  dv.y *= 0.8;
  float r2 = dot(dv, dv);
  if (r2 > 1.0) return vec4(0.0);
  float mask = smoothstep(1.0, 0.6, r2);
  float nz = sqrt(max(1.0 - r2, 0.0));
  vec2 offset = -dv * 0.035 * vec2(1.0 / uAspect, 1.0);
  // 上の縁が空を映して光る
  float rim = pow(1.0 - nz, 2.0) * smoothstep(-0.2, 0.9, dv.y) * 0.5;
  return vec4(offset * mask, mask, rim * mask);
}

// ---- レンズフレア（ゴースト 3 つ＋ハロー）
vec3 lensFlare(vec2 uv, float vis){
  if (vis <= 0.002) return vec3(0.0);
  vec2 asp = vec2(uAspect, 1.0);
  vec2 s = uSunScreen;
  vec2 d = (uv - s) * asp;
  float r = length(d);
  // ハロー（太陽を囲むリング）
  float halo = smoothstep(0.24, 0.30, r) * (1.0 - smoothstep(0.30, 0.38, r));
  vec3 col = vec3(0.9, 0.75, 0.6) * halo * 0.16;
  // ゴースト: 画面中心を挟んで反対側
  vec2 axis = vec2(0.5) - s;
  const float ks[3] = float[3](0.55, 1.15, 1.7);
  const float sz[3] = float[3](0.055, 0.09, 0.14);
  const float it[3] = float[3](0.6, 0.35, 0.22);
  for (int i = 0; i < 3; i++) {
    vec2 p = vec2(0.5) + axis * ks[i];
    float rr = length((uv - p) * asp) / sz[i];
    float g = pow(1.0 - smoothstep(0.0, 1.0, rr), 1.5);
    // 縁が色付く（内側が暖色、外側が寒色）
    vec3 tint = mix(vec3(1.0, 0.85, 0.6), vec3(0.5, 0.75, 1.0), smoothstep(0.55, 1.0, rr));
    col += tint * g * it[i];
  }
  // 太陽が画面の縁へ行くほど弱く
  vec2 e = max(abs(s - 0.5) - 0.4, 0.0);
  float edgeFade = 1.0 - smoothstep(0.0, 0.25, length(e));
  return col * vis * uSunColorN * uFlareStrength * edgeFade;
}

float aoUpsample(vec2 uv, float lin){
  vec2 hp = uv * uHalfRes - 0.5;
  vec2 ip = floor(hp);
  vec2 fr = fract(hp);
  float sum = 0.0, tw = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 suv = (ip + vec2(float(i), float(j)) + 0.5) / uHalfRes;
      vec2 s = texture2D(tAO, suv).rg;
      float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
      w *= exp(-abs(s.g - lin) / (lin * 0.04 + 0.03));
      sum += s.r * w;
      tw += w;
    }
  }
  return tw > 1e-4 ? sum / tw : texture2D(tAO, uv).r;
}

vec3 gradeColor(vec3 c){
  // 白バランス
  c *= vec3(1.0 + uWarmth * 0.10, 1.0 + uWarmth * 0.025, 1.0 - uWarmth * 0.13);
  float l = post_luma(c);
  // スプリットトーン: 影は青く、ハイライトは暖かく
  float sw = 1.0 - smoothstep(0.0, 0.45, l);
  float hw = smoothstep(0.30, 1.0, l);
  c *= mix(vec3(1.0), uShadowTint, sw * uSplit.x);
  c *= mix(vec3(1.0), uHighlightTint, hw * uSplit.y);
  // コントラスト（ガンマ空間で 0.5 を軸に）＋ わずかなフィルム S 字
  vec3 g = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  g = (g - 0.5) * uContrast + 0.5;
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.12);
  c = pow(clamp(g, 0.0, 1.0), vec3(2.2));
  // 彩度
  l = post_luma(c);
  c = mix(vec3(l), c, uSaturation);
  return c;
}

void main(){
  vec2 uv = vUv;
  // 水中のゆらぎ
  if (uUnderwater > 0.0) {
    uv += vec2(sin(uv.y * 21.0 + uTime * 1.6), cos(uv.x * 17.0 + uTime * 1.2)) * 0.004 * uUnderwater;
  }
  // レンズの水滴
  vec4 drop = rainDrops(uv);
  uv += drop.xy;

  // 深度と世界座標
  float z = texture2D(tDepth, uv).r;
  float lin = post_linearDepth(z, uNear, uFar);
  vec4 wp4 = uInvViewProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 worldPos = wp4.xyz / wp4.w;
  vec3 viewDir = normalize(worldPos - uCamPos);
  float isSky = step(0.999999, z);
  vec3 flipPos = mix(worldPos, uCamPos + viewDir * 5000.0, isSky);
  float fm = flip_mask(flipPos);

  // 裏返しの縁: 画面空間のリップルと色収差の走査線
  float distC = distance(flipPos, uFlipCenter);
  float edgeK = exp(-abs(distC - uFlipRadius) / 30.0) * step(0.001, uFlipRadius) * (1.0 - step(5990.0, uFlipRadius));
  vec2 gdir = vec2(dFdx(distC), dFdy(distC));
  float gl = length(gdir);
  gdir = gl > 1e-5 ? gdir / gl : vec2(0.0);
  float rippleWave = sin((distC - uFlipRadius) * 0.35 - uTime * 7.0);
  vec2 ripple = gdir * edgeK * rippleWave * 6.0 * uTexel;
  uv += ripple;

  vec3 c;
  if (edgeK > 0.02) {
    vec2 ca = gdir * edgeK * 3.0 * uTexel;
    c = vec3(sceneAt(uv + ca).r, sceneAt(uv).g, sceneAt(uv - ca).b);
  } else {
    c = sceneAt(uv);
  }

  // 水滴の中は少しぼけて見え、縁が光る
  if (drop.z > 0.0) {
    c = mix(c, texture2D(tBloomFine, uv).rgb, drop.z * 0.6);
    c += drop.w * (texture2D(tBloom, vec2(uv.x, 0.85)).rgb * uBloomNorm + vec3(0.02)) * 0.8;
  }

  // 被写界深度
  if (uDofOn > 0.5) {
    float coc = dof_coc(lin);
    vec4 b = texture2D(tDof, uv);
    float k = smoothstep(0.8, 2.6, max(coc, b.a * 0.7));
    c = mix(c, b.rgb, k);
  }

  // AO（半分解像度を深度で持ち上げる）
  if (uAoStrength > 0.0 && isSky < 0.5) {
    float ao = aoUpsample(uv, lin);
    ao = pow(clamp(ao, 0.0, 1.0), uAoStrength);
    // 多重反射の近似（GTAO 論文）: アルベドが明るいほど黒く沈まない
    vec3 alb = clamp(c / (post_luma(c) + 1e-3) * 0.35, 0.0, 1.0);
    vec3 a = 2.0404 * alb - 0.3324;
    vec3 bb = -4.7951 * alb + 0.6417;
    vec3 cc = 2.7552 * alb + 0.6903;
    vec3 aoc = max(vec3(ao), ((ao * a + bb) * ao + cc) * ao);
    // 直射の当たる明るい面では弱く（直接光まで暗くしない）
    float ln = post_luma(c) * uExposure;
    float k = mix(1.0, 0.45, smoothstep(0.35, 1.3, ln));
    aoc = mix(vec3(1.0), aoc, k * (1.0 - fm));
    c *= aoc;
  }

  // 水中の霧
  if (uUnderwater > 0.0) {
    float f = 1.0 - exp(-lin * 0.09);
    vec3 fogC = vec3(0.015, 0.075, 0.085) * (0.3 + 0.7 * max(uSunDir.y, 0.0)) / max(uExposure, 0.2);
    c = mix(c, fogC, f * uUnderwater);
  }

  // ブルーム（混ぜる。足さないので全体は白く霞まない）
  vec3 bloom = texture2D(tBloom, uv).rgb * uBloomNorm;
  float bs = uBloomStrength * (1.0 - 0.7 * fm);
  c = mix(c, bloom, bs);

  // ゴッドレイ
  float god = texture2D(tGod, uv).r;
  c += uSunColorN * god * uGodStrength;

  // レンズフレア（遮蔽は太陽位置のマスクを見る）
  float sunVis = 0.0;
  if (uSunFront > 0.0 && uSunScreen.x > -0.1 && uSunScreen.x < 1.1 && uSunScreen.y > -0.1 && uSunScreen.y < 1.1) {
    vec2 su = clamp(uSunScreen, 0.002, 0.998);
    vec2 r = vec2(0.006 / uAspect, 0.006);
    sunVis = texture2D(tGodMask, su).r * 0.4
           + (texture2D(tGodMask, su + vec2(r.x, 0.0)).r + texture2D(tGodMask, su - vec2(r.x, 0.0)).r
           +  texture2D(tGodMask, su + vec2(0.0, r.y)).r + texture2D(tGodMask, su - vec2(0.0, r.y)).r) * 0.15;
    sunVis *= uSunFront;
  }
  c += lensFlare(uv, sunVis);

  // 裏返しの縁の走査線（材質側の広い光りの上に、細い線）
  float scan = exp(-abs(distC - uFlipRadius) / 2.5) * step(0.001, uFlipRadius) * (1.0 - step(5990.0, uFlipRadius));
  c += FLIP_ACCENT * scan * 1.2 / max(uExposure, 0.3);

  // 調査用: 裏返しの縁の値をそのまま出す（uDebug=2 は距離: R = 中心からの距離/100, G = 視線距離/100, B = 高さ/50）
  if (uDebug > 1.5) { gl_FragColor = vec4(distC / 100.0, lin / 100.0, worldPos.y / 50.0, 1.0); return; }
  if (uDebug > 0.5) { gl_FragColor = vec4(fm, scan, edgeK, 1.0); return; }

  // 自動露出（env.exposure を基準に ±）。露出後の平均輝度が uAutoRef から離れた分だけ、部分的に寄せる
  float logAvg = texture2D(tAdapt, vec2(0.5)).r;
  float L = exp2(logAvg) * uExposure;
  float autoScale = pow(uAutoRef / max(L, 1e-4), uAutoStrength * (1.0 - uFlip * 0.8));
  autoScale = clamp(autoScale, uAutoRange.x, uAutoRange.y);
  c *= uExposure * autoScale;

  // トーンマップ
  c = post_agx(c);
  // グレーディング
  if (uGradeOn > 0.5) c = gradeColor(c);
  // ビネット
  vec2 d = (uv - 0.5) * vec2(1.0, 1.0 / max(uAspect, 0.3) * 0.9);
  float v = 1.0 - uVignette * smoothstep(0.12, 0.95, dot(d, d) * 2.6);
  c *= v;

  gl_FragColor = vec4(post_linearToSrgb(c), fm);
}
`;

export function gradeUniforms(): Record<string, THREE.IUniform> {
  return {
    tScene: { value: null },
    tDepth: { value: null },
    tBloom: { value: null },
    tBloomFine: { value: null },
    tGod: { value: null },
    tGodMask: { value: null },
    tAO: { value: null },
    tDof: { value: null },
    tAdapt: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uHalfRes: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 },
    uFar: { value: 9000 },
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColorN: { value: new THREE.Vector3(1, 1, 1) },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uSunFront: { value: 0 },
    uBloomNorm: { value: 1 },
    uBloomStrength: { value: 0.06 },
    uGodStrength: { value: 0 },
    uFlareStrength: { value: 0 },
    uAoStrength: { value: 0 },
    uDofOn: { value: 0 },
    uDof: { value: new THREE.Vector4(0.02, 0.007, 0.024, 900) },
    uFocus: { value: 5 },
    uCocMax: { value: 14 },
    uExposure: { value: 1 },
    uAutoStrength: { value: 0.45 },
    uAutoRef: { value: 0.5 },
    uAutoRange: { value: new THREE.Vector2(0.7, 1.45) },
    uWarmth: { value: 0 },
    uSaturation: { value: 0.96 },
    uContrast: { value: 1.04 },
    uShadowTint: { value: new THREE.Vector3(0.92, 0.96, 1.1) },
    uHighlightTint: { value: new THREE.Vector3(1.06, 1.01, 0.94) },
    uSplit: { value: new THREE.Vector2(0.35, 0.35) },
    uVignette: { value: 0.3 },
    uGradeOn: { value: 1 },
    uDebug: { value: 0 },
    uRain: { value: 0 },
    uUnderwater: { value: 0 },
    uAspect: { value: 16 / 9 },
  };
}
