// 粒子。昼の花粉・埃（逆光で光る。森に多い）／夜の蛍（岸辺と森の際、20〜4時、暖色でゆっくり明滅）／風に舞う林床のくず。
// 全て決定的（ハッシュ＋時刻）・世界固定・ソフトパーティクル。裏返しでは「座標の点＋速度ベクトル」になる。
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { WX_COMMON, WX_QUAD_ATTR, WX_FLIP_VS } from "./glsl";
import { makeQuadInstances } from "./rain";
import type { Weather } from "./index";

const MATH_VIEW = /* glsl */ `
// 数式ビュー: 中心の点＋速度ベクトルの短い線（q は板の -1..1 座標、vel は板の 2D 速度）
float wx_mathDot(vec2 q, vec2 vel){
  float r = length(q);
  float d = 1.0 - smoothstep(0.0, 0.1, r);
  vec2 vd = normalize(vel + vec2(1e-5, 0.0));
  float vl = clamp(length(vel), 0.0, 0.95);
  float along = dot(q, vd);
  float perp = abs(dot(q, vec2(-vd.y, vd.x)));
  float line = step(0.0, along) * step(along, vl) * (1.0 - smoothstep(0.0, 0.05, perp));
  return max(d, line * 0.9);
}
`;

const DUST_VERT = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WX_FLIP_VS}
${WX_COMMON}
${WX_QUAD_ATTR}
uniform vec3 uCamPos;
uniform vec3 uWind;
uniform float uGust;
uniform float uRain;
uniform vec3 uSunDir;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying vec2 vVel;
void main(){
  // 埃が見えるのは近くだけ（遠いと昼の空に白い点として散る）
  float box = 13.0;
  vec3 fwd = wx_camFwd(viewMatrix);
  vec3 boxC = uCamPos + vec3(fwd.x, 0.0, fwd.z) * box * 0.28;
  vec3 wind3 = vec3(uWind.x, 0.0, uWind.y) * uWind.z * (0.18 + 0.25 * uGust);
  float t = uTime;
  vec3 ph = aSeed.xyz * 6.2832;
  vec3 wander = vec3(sin(t * 0.6 + ph.x), cos(t * 0.45 + ph.y), sin(t * 0.7 + ph.z)) * 0.35;
  vec3 p = aSeed.xyz * box + wind3 * t + vec3(0.0, -0.03 * t, 0.0) + wander;
  vec3 rel = mod(p - boxC, vec3(box)) - 0.5 * box;
  vec3 center = boxC + rel;
  float th = flip_height(center.xz);
  float forest = smoothstep(6.0, 18.0, th) * (1.0 - smoothstep(300.0, 420.0, th));
  float dens = 0.3 + 0.7 * forest;
  float on = step(aSeed.w, dens) * step(th + 0.15, center.y) * step(center.y, th + 4.5);
  float dist = distance(center, uCamPos);
  float px = dist * uWxPixel;
  float dropS = 0.006 + 0.008 * aSeed.x;
  float size = max(dropS, px * 1.5);
  vec3 right = wx_camRight(viewMatrix);
  vec3 up = wx_camUp(viewMatrix);
  float sunUp = smoothstep(-0.02, 0.1, uSunDir.y);
  vec3 e = abs(rel) / box;
  float edge = (1.0 - smoothstep(0.3, 0.5, e.x)) * (1.0 - smoothstep(0.3, 0.5, e.y)) * (1.0 - smoothstep(0.3, 0.5, e.z));
  float alpha = on * edge * sunUp * (1.0 - uRain) * smoothstep(0.25, 1.2, dist) * clamp(dropS / size, 0.35, 1.0);
  // 6m より遠い埃は描かない
  alpha *= 1.0 - smoothstep(4.0, 6.0, dist);
  vFm = wx_flipMask(center);
  // 数式ビューでは板を少し大きくして「点＋速度ベクトルの短い軌跡」を描く（線が長いと空に白い短線が散る）
  float msize = max(size, px * 10.0);
  size = mix(size, msize, step(0.001, vFm));
  vec3 pos = center + (right * position.x + up * (position.y - 0.5)) * size * 2.0;
  vec3 vel = wind3 + vec3(0.0, -0.03, 0.0) + vec3(cos(t * 0.6 + ph.x) * 0.6, -sin(t * 0.45 + ph.y) * 0.45, cos(t * 0.7 + ph.z) * 0.7) * 0.35;
  vec3 vv = mat3(viewMatrix) * vel;
  vVel = vv.xy * 0.6;
  vQ = position.xy;
  vAlpha = alpha;
  vWorld = center;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const DUST_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
${MATH_VIEW}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying vec2 vVel;
void main(){
  vec2 q = vec2(vQ.x, vQ.y - 0.5) * 2.0;
  float r = length(q);
  float shape = exp(-r * r * 4.0) * (1.0 - smoothstep(0.7, 1.0, r));
  vec3 vdir = normalize(vWorld - uCamPos);
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  // HG 位相（g=0.7）。太陽の側を向いたときだけ光る。順光では完全に見えない
  float back = wx_phaseHG(dot(vdir, uSunDir), 0.70);
  float lit = clamp(back * 0.75, 0.0, 1.0);
  vec3 col = uSunColor * back * 0.55 * sunUp + uSkyAmbient * 0.05 * lit;
  float soft = wx_soft(gl_FragCoord.xy, gl_FragCoord.z, 0.15);
  vec4 aer = flip_aerial(vWorld);
  float alpha = vAlpha * shape * soft * aer.a * exp(-wx_fogOD(uCamPos, vWorld)) * lit * sunUp * 0.9;
  float m = wx_mathDot(q, vVel);
  col = mix(col, FLIP_LINE, vFm);
  alpha = mix(alpha, m * soft * 0.9 * step(0.001, vAlpha), vFm);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

const FIREFLY_VERT = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WX_FLIP_VS}
${WX_COMMON}
${WX_QUAD_ATTR}
uniform vec3 uCamPos;
uniform float uHour;
uniform vec3 uSunDir;
uniform float uRain;
uniform float uFfGrid;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying vec2 vVel;
void main(){
  // 世界固定の格子（カメラ周り 64m 四方）。1セルに最大3匹（layer）
  float k = uFfGrid;
  float cs = 64.0 / k;
  float cellIdx = mod(aIndex, k * k);
  float layer = floor(aIndex / (k * k));
  float ix = mod(cellIdx, k), iz = floor(cellIdx / k);
  vec2 camCell = floor(uCamPos.xz / cs);
  vec2 cell = camCell + vec2(ix, iz) - 0.5 * k;
  vec2 jit = flip_hash22(cell * 0.731 + 3.1 + layer * 17.0);
  vec2 xz = (cell + jit) * cs;
  float th = flip_height(xz);
  float hL = th - uWxLake;
  // 岸の草地と森の際に多い。湖の上には出さない（水面に浮く光の玉になる）
  float shore = smoothstep(0.15, 1.1, hL) * (1.0 - smoothstep(4.0, 9.0, hL));
  float forestEdge = smoothstep(7.0, 12.0, hL) * (1.0 - smoothstep(20.0, 35.0, hL));
  float dens = max(shore, forestEdge * 0.6);
  // 群れ感: λ≈22m の低周波ノイズで「いる場所・いない場所」を作る（一様にばら撒かない）
  float swarm = smoothstep(0.38, 0.68, flip_vnoise(xz * 0.045));
  dens *= 0.35 + 0.9 * swarm;
  float on = step(aSeed.w, dens);
  float t = uTime;
  vec3 ph = aSeed.xyz * 6.2832;
  vec3 wander = vec3(sin(t * 0.5 + ph.x) + sin(t * 1.3 + ph.y) * 0.3, sin(t * 0.8 + ph.y) * 0.5, cos(t * 0.45 + ph.z) + cos(t * 1.1 + ph.x) * 0.3) * 0.6;
  vec3 vel = vec3(cos(t * 0.5 + ph.x) * 0.5 + cos(t * 1.3 + ph.y) * 0.39, cos(t * 0.8 + ph.y) * 0.4, -sin(t * 0.45 + ph.z) * 0.45 - sin(t * 1.1 + ph.x) * 0.33) * 0.6;
  // 地上 1.4m 以内（草の高さ〜腰の高さ）
  vec3 center = vec3(xz.x, th + 0.12 + 1.05 * aSeed.z, xz.y) + wander;
  // 揺らいだ「今いる場所」で陸かどうかを見る。置いた場所が岸でも、
  // ±1.1m の揺らぎで水の上へはみ出すと「湖面に浮かぶ光の玉」になる
  on *= step(uWxLake + 0.05, flip_height(center.xz));
  // さらに「画面の中で湖に重なる」個体も消す。陸にいても、カメラから見て背景が湖だと
  // 水面に浮かぶ光の玉に見える（批評が 4 ラウンド指摘しているのはこれ）。
  // 視線をそのまま伸ばして湖面に当たる点を調べ、そこが水なら消す
  {
    vec3 vdir = normalize(center - uCamPos);
    float tw = (uWxLake - uCamPos.y) / min(vdir.y, -1e-4);
    vec2 hitXZ = (uCamPos + vdir * tw).xz;
    float behind = step(distance(center, uCamPos) + 0.5, tw) * step(vdir.y, -1e-4);
    on *= 1.0 - behind * step(flip_height(hitXZ), uWxLake - 0.05);
  }
  // 明滅: 虫ごとに周期も点灯の長さも違う。素早く点いてゆっくり消える
  float period = 1.5 + 3.4 * aSeed.y;
  float bp = fract(t / period + aSeed.x);
  float dur = 0.14 + 0.20 * aSeed.z;
  float blink = smoothstep(0.0, dur * 0.25, bp) * (1.0 - smoothstep(dur * 0.5, dur * 1.7, bp));
  blink = pow(clamp(blink, 0.0, 1.0), 1.4) * (0.5 + 0.5 * flip_hash11(aIndex * 0.371 + 5.0));
  float night = uHour > 12.0 ? smoothstep(19.6, 20.6, uHour) : smoothstep(4.8, 3.8, uHour);
  night *= smoothstep(0.02, -0.05, uSunDir.y);
  float dist = distance(center, uCamPos);
  float px = dist * uWxPixel;
  // 1〜3px の光の点（テニスボールにしない）
  float size = max(0.02, px * 3.4);
  float alpha = on * night * blink * (1.0 - smoothstep(20.0, 30.0, dist)) * (1.0 - uRain) * smoothstep(0.3, 1.0, dist);
  vFm = wx_flipMask(center);
  float msize = max(size, px * 10.0);
  size = mix(size, msize, step(0.001, vFm));
  vec3 right = wx_camRight(viewMatrix);
  vec3 up = wx_camUp(viewMatrix);
  vec3 pos = center + (right * position.x + up * (position.y - 0.5)) * size * 2.0;
  vec3 vv = mat3(viewMatrix) * vel;
  vVel = vv.xy * 0.8;
  vQ = position.xy;
  vAlpha = alpha;
  vWorld = center;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const FIREFLY_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
${MATH_VIEW}
uniform float uExposure;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying vec2 vVel;
void main(){
  vec2 q = vec2(vQ.x, vQ.y - 0.5) * 2.0;
  float r = length(q);
  float core = exp(-r * r * 34.0);
  float halo = exp(-r * 3.4) * 0.30 * (1.0 - smoothstep(0.30, 0.95, r));
  // 蛍の黄緑（白くしない）。夜は露出が 6 倍近くまで開くので、放射輝度をそのまま置くと
  // トーンマップで飽和して「白い四角のドット」になる。表示輝度を狙って露出で割る
  float ex = clamp(uExposure, 0.2, 8.0);
  vec3 col = vec3(0.85, 1.0, 0.32) * core * (2.4 / ex) + vec3(0.45, 0.85, 0.2) * halo * (1.1 / ex);
  float soft = wx_soft(gl_FragCoord.xy, gl_FragCoord.z, 0.12);
  vec4 aer = flip_aerial(vWorld);
  col *= vAlpha * soft * aer.a * exp(-wx_fogOD(uCamPos, vWorld));
  float m = wx_mathDot(q, vVel) * soft * step(0.001, vAlpha);
  col = mix(col, FLIP_LINE * m * 0.8, vFm);
  gl_FragColor = vec4(col, 0.0);
}
`;

// 風に舞う「林床のくず」。この森は針葉樹なので、広葉樹の落ち葉は出さない（批評R7 storm_bolt）。
//   0 = 松葉の束（細い針が 2〜3 本、根元でつながっている）
//   1 = 樹皮の小片（角ばった薄片。いちばん大きい）
//   2 = 枯れ草の切れ端（細長い帯。ねじれている）
// 3 つとも「乾いた林床の色」で、彩度は 0.4 未満。空を背にした黄色い板にならないようにする。
const LEAF_VERT = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WX_FLIP_VS}
${WX_COMMON}
${WX_QUAD_ATTR}
uniform vec3 uCamPos;
uniform vec3 uWind;
uniform float uGust;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying vec3 vN;
varying vec3 vCol;
varying vec2 vVel;
varying vec2 vKind;   // x = 種類 0/1/2, y = 視線に対する面の向き |N・V|
vec3 rot(vec3 v, vec3 ax, float a){ float c = cos(a), s = sin(a); return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c); }
void main(){
  // 撒く箱は xz だけ（高さは地面からの高さで持つ）。
  // R7 までは 11m の立方体に一様に撒いていたので、目線より上へ出た粒が
  // 「空に浮いた黄色い平たい木の葉」として残った。林床のくずは空へは上がらない
  float box = 11.0;
  vec3 fwd = wx_camFwd(viewMatrix);
  vec2 boxC = uCamPos.xz + vec2(fwd.x, fwd.z) * box * 0.28;
  vec3 wind3 = vec3(uWind.x, 0.0, uWind.y) * uWind.z * (0.35 + 0.5 * uGust);
  float t = uTime;
  vec3 ph = aSeed.xyz * 6.2832;
  vec2 sway = vec2(sin(t * 1.7 + ph.x), cos(t * 1.3 + ph.z)) * 0.4;
  vec2 pxz = aSeed.xz * box + wind3.xz * t + sway;
  vec2 rel = mod(pxz - boxC, vec2(box)) - 0.5 * box;
  vec2 cxz = boxC + rel;
  float th = flip_height(cxz);
  // 舞い上がる高さ。突風で持ち上がり、また落ちる（0 の近くで転がっている時間が長い）
  float lift = (0.50 + 1.30 * uGust) * (0.35 + 0.65 * aSeed.z);
  float bob = 0.5 - 0.5 * cos(t * (0.35 + 0.5 * aSeed.y) + ph.y);
  float hag = 0.04 + lift * pow(bob, 1.5);
  vec3 center = vec3(cxz.x, th + hag, cxz.y);
  float forest = smoothstep(6.0, 18.0, th) * (1.0 - smoothstep(300.0, 420.0, th));
  float on = step(aSeed.w, forest * 0.9 + 0.1);
  float windy = smoothstep(2.5, 6.0, uWind.z);
  float dist = distance(center, uCamPos);
  vec2 e = abs(rel) / box;
  float edge = (1.0 - smoothstep(0.3, 0.5, e.x)) * (1.0 - smoothstep(0.3, 0.5, e.y));
  float alpha = on * windy * edge * (1.0 - smoothstep(6.0, 9.0, dist)) * smoothstep(0.3, 0.8, dist);

  float kind = floor(flip_hash11(aSeed.w * 37.0 + aSeed.x * 11.0) * 3.0);
  // 実寸: 松葉の束 5〜9cm・樹皮の小片 3〜5cm・枯れ草 6〜10cm（長さ）。板の半分の大きさで持つ
  float sz = kind < 0.5 ? (0.026 + 0.018 * aSeed.z)
           : kind < 1.5 ? (0.016 + 0.010 * aSeed.z)
                        : (0.030 + 0.020 * aSeed.z);
  // 縦横比。針と枯れ草は細長い（＝画面の面積が小さく、黄色い板に見えない）
  float aspect = kind < 0.5 ? 0.34 : kind < 1.5 ? 0.72 : 0.22;

  float ang = t * (2.0 + 3.0 * aSeed.x) + ph.y;
  vec3 axis = normalize(vec3(aSeed.x - 0.5, aSeed.y - 0.5, aSeed.z - 0.5) + vec3(0.01, 0.02, 0.03));
  vec3 lx = rot(vec3(1.0, 0.0, 0.0), axis, ang);
  vec3 ly = rot(vec3(0.0, 1.0, 0.0), axis, ang);
  vFm = wx_flipMask(center);
  vec3 pos = center + (lx * position.x * aspect + ly * (position.y - 0.5)) * sz * 2.0;
  if (vFm > 0.001) {
    float px = dist * uWxPixel;
    vec3 right = wx_camRight(viewMatrix);
    vec3 up = wx_camUp(viewMatrix);
    vec3 mpos = center + (right * position.x + up * (position.y - 0.5)) * max(sz, px * 10.0) * 2.0;
    pos = mix(pos, mpos, vFm);
  }
  float vy = lift * 1.5 * pow(max(bob, 1e-3), 0.5) * 0.5 * sin(t * (0.35 + 0.5 * aSeed.y) + ph.y) * (0.35 + 0.5 * aSeed.y);
  vec3 vel = wind3 + vec3(0.0, vy, 0.0) + vec3(cos(t * 1.7 + ph.x) * 1.7, 0.0, -sin(t * 1.3 + ph.z) * 1.3) * 0.4;
  vec3 vv = mat3(viewMatrix) * vel;
  vVel = vv.xy * 0.25;
  vec3 nrm = cross(lx, ly);
  vN = nrm;
  // 舞うものは「向きが変わると見え方が変わる」。真横を向いた瞬間はほとんど見えない
  vec3 vdir = normalize(center - uCamPos);
  float facing = abs(dot(normalize(nrm), vdir));
  vKind = vec2(kind, facing);
  // 乾いた林床の色（彩度 0.30〜0.38）。黄色い広葉樹の葉はやめた
  vec3 needle = vec3(0.150, 0.128, 0.098);   // 枯れた松葉: 赤みの少ない焦茶
  vec3 bark   = vec3(0.148, 0.132, 0.116);   // 樹皮: ほぼ灰
  vec3 straw  = vec3(0.196, 0.170, 0.128);   // 枯れ草: くすんだ麦わら
  vCol = kind < 0.5 ? needle : (kind < 1.5 ? bark : straw);
  vCol *= 0.72 + 0.5 * aSeed.z;
  vQ = position.xy;
  vAlpha = alpha;
  vWorld = center;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const LEAF_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
${MATH_VIEW}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uLightning;
varying vec2 vQ;
varying float vAlpha;
varying vec3 vWorld;
varying float vFm;
varying vec3 vN;
varying vec3 vCol;
varying vec2 vVel;
varying vec2 vKind;
void main(){
  vec2 q = vec2(vQ.x, vQ.y - 0.5) * 2.0;
  float kind = vKind.x;
  float a, shade;
  if (kind < 0.5) {
    // 松葉の束: 細い針が 3 本、根元（q.y = -1）でまとまって先で開く
    float open = 0.10 + 0.42 * (q.y * 0.5 + 0.5);
    float d = 1e9;
    for (int i = 0; i < 3; i++) {
      float o = (float(i) - 1.0) * open;
      d = min(d, abs(q.x - o));
    }
    a = 1.0 - smoothstep(0.05, 0.16, d);
    a *= step(abs(q.y), 1.0) * (1.0 - smoothstep(0.86, 1.0, abs(q.y)));
    shade = 0.72 + 0.42 * (1.0 - smoothstep(0.0, 0.10, d));   // 針の丸み
  } else if (kind < 1.5) {
    // 樹皮の小片: 角ばった薄片。縁が割れている
    float n = flip_vnoise(q * 2.3 + 5.0);
    float d = max(abs(q.x) - 0.78 + 0.22 * n, abs(q.y) - 0.82 + 0.18 * flip_vnoise(q.yx * 3.1));
    a = 1.0 - smoothstep(-0.04, 0.06, d);
    // 樹皮の筋（縦の木目）。一様な塗りに見せない
    shade = 0.62 + 0.66 * flip_vnoise(vec2(q.x * 7.0, q.y * 1.6));
  } else {
    // 枯れ草の切れ端: 細長い帯がねじれている（中ほどでくびれる）
    float w = 0.62 * (1.0 - 0.55 * abs(sin(q.y * 2.2 + 1.0)));
    a = 1.0 - smoothstep(w - 0.06, w + 0.06, abs(q.x));
    a *= 1.0 - smoothstep(0.90, 1.0, abs(q.y));
    shade = 0.66 + 0.5 * (1.0 - abs(q.x) / max(w, 1e-3));
  }
  float sunUp = smoothstep(-0.05, 0.05, uSunDir.y);
  vec3 N = normalize(vN);
  // 表と裏で明るさが違う（裏返ると暗くなる）。舞うものはこれで「回っている」と分かる
  float sgn = dot(N, uSunDir);
  float ndl = max(sgn, 0.0) + max(-sgn, 0.0) * 0.22;
  // 上を向いた面は空を、下を向いた面は地面を映す
  float up = N.y * 0.5 + 0.5;
  vec3 amb = mix(uGroundAmbient * 0.55, uSkyAmbient * 0.95, up);
  vec3 col = vCol * shade * (amb + uSunColor * 0.30 * ndl * sunUp + vec3(0.8, 0.85, 1.0) * uLightning * 0.05);
  // くずは空より明るくならない（閃光で白い点になり「空に浮かぶ埃」に見えていた）
  vec3 skyB = flip_skyColor(normalize(vWorld - uCamPos));
  col = min(col, skyB * 0.72);
  col = flip_applyAerial(col, vWorld);
  float soft = wx_soft(gl_FragCoord.xy, gl_FragCoord.z, 0.08);
  float alpha = vAlpha * a * soft * exp(-wx_fogOD(uCamPos, vWorld));
  // 真横を向いた瞬間は薄い（厚さがほぼゼロの板なので）。ちらつきが「舞っている」に見える
  alpha *= 0.25 + 0.75 * vKind.y;
  // 空を背にした小さなくずは、雨のカーテン越しの逆光で色も形も飛ぶ。
  // 背景が「空」かどうかは線形深度で見る。遠景の山は 4km 台までなので、
  // fog.ts と同じ「8500m 超え＝空」の線引きを使う（3000m で切ると遠くの山も空と判定して
  // 尾根の定点でくずが丸ごと消える。実際に消えた）
  float bg = wx_sceneDepth(gl_FragCoord.xy);
  float onSky = smoothstep(6000.0, 8500.0, bg);
  alpha *= 1.0 - 0.88 * onSky;
  // 彩度も落とす（空を背にした 1〜2mm の粒に色は残らない）
  float y = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(y), onSky * 0.85);
  float m = wx_mathDot(q, vVel) * soft * step(0.001, vAlpha);
  col = mix(col, FLIP_LINE, vFm);
  alpha = mix(alpha, m * 0.9, vFm);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export class Particles {
  dust: THREE.Mesh;
  fireflies: THREE.Mesh;
  leaves: THREE.Mesh;

  constructor(public w: Weather) {
    const c = w.counts;
    const mk = (geo: THREE.InstancedBufferGeometry, mat: THREE.ShaderMaterial, order: number, name: string) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.layers.set(LAYER.TRANSPARENT);
      m.renderOrder = order;
      m.castShadow = false;
      m.name = name;
      w.group.add(m);
      return m;
    };
    this.dust = mk(
      makeQuadInstances(c.dust, 301),
      new THREE.ShaderMaterial({
        uniforms: w.bind({}),
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
      }),
      50,
      "weather.dust",
    );
    const grid = Math.ceil(Math.sqrt(c.fireflies / 4));
    this.fireflies = mk(
      makeQuadInstances(grid * grid * 4, 401),
      new THREE.ShaderMaterial({
        uniforms: w.bind({ uFfGrid: { value: grid } }),
        vertexShader: FIREFLY_VERT,
        fragmentShader: FIREFLY_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
      }),
      52,
      "weather.fireflies",
    );
    this.leaves = mk(
      makeQuadInstances(c.leaves, 501),
      new THREE.ShaderMaterial({
        uniforms: w.bind({}),
        vertexShader: LEAF_VERT,
        fragmentShader: LEAF_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
      }),
      54,
      "weather.leaves",
    );
  }

  update() {
    const env = this.w.env;
    const h = env.hour;
    const sunUp = env.sunDir.y > -0.03;
    const night = h >= 19.5 || h <= 4.9;
    this.dust.visible = sunUp && env.weather.rain < 0.98;
    this.fireflies.visible = night && env.sunDir.y < 0.03 && env.weather.rain < 0.98;
    this.leaves.visible = env.weather.wind > 2.6;
  }
}
