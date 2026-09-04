// 湖面の雨の波紋。
//
// 【なぜ画素シェーダの1パスなのか】
// R7 までは「波紋1つ＝寝かせた板1インスタンス」だった。これには2つの持病があった:
//   1. 十字の光条になる。板の中で `aa = max(fwidth(rq), …)` を輪の太さに使っていたが、
//      湖面は視線に対してほぼ平行なので、画面の縦方向へ1画素動くと rq が大きく飛ぶ。
//      つまり fwidth は「輪のどの向きか」で桁が変わる（左右の端では小さく、上下では巨大）。
//      `exp(-e*e)` は太さを変えても頂点の値が 1 のままなので、太った側は輪の内側まで
//      まるごと明るくなる＝中心を貫く縦の帯ができ、鋭いままの左右の端と合わさって「＋」に見えた。
//   2. 数を増やせない。1つ増やすたびにインスタンスが1つ増え、しかも板は 60m 四方にしか撒けなかった。
//
// なので「板を撒く」のをやめた。画面いっぱいの1パスで、画素ごとに
//   ① 視線と湖面（y = uLakeLevel）の交点を解析的に出し、
//   ② その点の周りの格子セル 3×3 を見て、セルごとに1つの波紋の高さと勾配を足す。
// 描画呼び出しは 1、三角形は 1 枚、波紋の数は格子の細かさだけで決まる（＝いくらでも増やせる）。
// 距離の上限も無い（画面の水面すべてに出る）。
//
// 【十字が出ない理由】
// 半径は必ず world の `length(p - center)` から作る（`abs(x)+abs(y)` も、x と y を別々に評価した
// 積・和も使わない）。ぼかし幅は画素の footprint から解析的に出し、**太らせたぶんだけ振幅を落とす**
// （面積を保つ）。これで浅い角度から見ても、輪は「潰れた楕円」になるだけで中は埋まらない。
//
// 【密度】
// セル1つに常に波紋1つ（周期＝寿命）なので、密度 = 1/(セル² × 周期) × 当たる割合。
//   細かい格子 0.30m / 0.30s  → 当たる割合 1 で 37.0 個/m²/秒（同時に 11 個/m² が生きている）
//   荒い格子   0.75m / 1.15s  → 当たる割合 1 で  1.5 個/m²/秒（大粒。遠くの水面まで面を生かす）
// 当たる割合は雨の強さで動く: rain(0.7) で 30.8 個/m²/秒、storm(1.0) で 38.6 個/m²/秒。
// 批評ラウンド7 の指示「密度 40 個/m²/秒・60m 四方では足りない」に対して、
// 場の広さは「画面の水面すべて」（距離の上限 high 320m）。
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { WX_COMMON, WX_FS_VERT } from "./glsl";
import type { Weather } from "./index";

const RIPPLE_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uLightning;
uniform vec3 uLightningPos;
/** 細かい格子: x = セルの一辺(m), y = 周期=寿命(s), z = 輪の速さ(m/s), w = 当たる割合 0..1 */
uniform vec4 uRipFine;
/** 荒い格子（大粒。遠くの水面用）。同じ並び */
uniform vec4 uRipCoarse;
/** x = 細かい波の最大傾き(tan), y = 荒い波の最大傾き, z = 水そのものの明るさ／空の明るさ, w = 着弾の閃きの強さ */
uniform vec4 uRipAmp;
/** x = 描く上限距離(m), y = 波紋の全体の強さ 0..1 */
uniform vec2 uRipRange;
/** 調査用（JS から weather.rain.rippleFx.mat.uniforms.uRipDebug.value = n）
 *  1 = 面の傾き |∇h| ／ 2 = 明暗 m（＋赤 −青） ／ 3 = 波紋のある画素を白 ／ 4 = 半径 r の等値線 */
uniform float uRipDebug;
varying vec2 vUv;
varying vec3 vRay;

// ガウスの輪 1 本。u = 半径 / 先端の半径。高さと du 微分を足す
void wx_ring(float u, float c0, float w, float k, inout float h, inout float dh){
  float e = (u - c0) / w;
  float g = exp(-e * e) * k;
  h += g;
  dh += -2.0 * e / w * g;
}

// 格子のセルごとに1つの波紋。返り値 = vec3(∂h/∂x, ∂h/∂z, h)。crown = 着弾の閃き
vec3 wx_rippleField(vec2 p, vec4 gridDef, float amp0, float seed,
                    vec2 fwdXZ, vec2 sideXZ, float fpAlong, float fpAcross, out float crown){
  float cs = gridDef.x, period = gridDef.y, speed = gridDef.z, gate = gridDef.w;
  vec3 acc = vec3(0.0);
  crown = 0.0;
  vec2 base = floor(p / cs);
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      vec2 cell = base + vec2(float(i), float(j));
      // セルごとにずれた時計。cycle が変わるたびに位置・大きさ・当たり外れを引き直す
      float off = flip_hash12(cell * 1.13 + seed);
      float ph = uTime / period + off;
      float cyc = floor(ph);
      float age = ph - cyc;
      if (flip_hash12(cell * 1.71 + cyc * 4.31 + seed + 3.0) > gate) continue;
      // 着弾点はセルの中で好きなところ（正方格子の並びを消す）
      vec2 c = (cell + flip_hash22(cell * 2.29 + cyc * 9.17 + seed)) * cs;
      // 粒の大小。2 乗で小粒に偏らせる（本物の雨も小粒が圧倒的に多い）
      float hz = flip_hash12(cell * 3.97 + cyc * 6.53 + seed);
      float sz = 0.42 + 0.95 * hz * hz;
      // 輪は広がりながら減速する（毛細管波はエネルギーを失って遅くなる）。
      // 等速 R = c·t のままだと「いちばん大きいとき＝いちばん薄いとき」になって輪が読めない
      float R = speed * period * sz * sqrt(age);
      if (R < 1e-4) continue;
      vec2 d = p - c;
      float r = length(d);                     // ← 半径は必ずこれ。軸ごとの式は使わない
      // 着弾の閃き（王冠）。画素より小さくなったぶんだけ暗くする（面積を保つ）ので、
      // 遠くでは自然に消える。奥行き方向は浅い角度で長く伸びるので楕円で持つ。
      // 寿命の頭 1/4 だけなので、そこだけ計算する
      if (age < 0.25) {
        float ca = 1.0 - age * 4.0;
        float cr = 0.020 * sz;
        float cwA = max(cr, 0.62 * fpAcross);
        float cwB = max(cr, 0.62 * fpAlong);
        float da = dot(d, sideXZ), db = dot(d, fwdXZ);
        crown += ca * ca * (cr * cr) / (cwA * cwB)
               * exp(-(da * da) / (cwA * cwA) - (db * db) / (cwB * cwB));
      }
      if (r > R) continue;                     // 輪の先端の外には何も無い
      vec2 rh = r > 1e-4 ? d / r : vec2(1.0, 0.0);
      float u = r / R;
      // この画素が半径方向に何 m ぶんを覆うか（浅い角度では奥行き方向だけが伸びる）
      float fpR = fpAlong * abs(dot(rh, fwdXZ)) + fpAcross * abs(dot(rh, sideXZ));
      const float W0 = 0.11;                   // 輪の素の太さ（u 単位）。R=0.15m なら 1.6cm ≒ 毛細管波の波長
      const float DHMAX = 0.857;               // exp(-e²) の |dh/du| の最大値 × w
      float w = max(W0, fpR / R);
      // amp0 は「輪の頂点での面の傾き」。高さに直すと a = 傾き × w × R / DHMAX。
      // ここに面積を保つ係数 (W0/w) を掛けると w が約分され、傾きは amp0 × (W0/w) になる。
      // ＝ 画素より細い輪は「にじんで太る」のではなく「平らになって消える」。ここが十字を止める要。
      // 太さだけ広げると exp(-e²) の頂点は 1 のままなので、輪の内側までまるごと明るくなり、
      // 中心を貫く帯（＝光条）ができる。R7 の十字はこれだった。
      // 消え方は寿命の後半で（前半で消すと、輪が大きくなる前に見えなくなる）
      float decay = smoothstep(0.0, 0.07, age) * (1.0 - smoothstep(0.45, 1.0, age));
      float a = amp0 * R * (W0 / DHMAX) * decay;
      float h = 0.0, dh = 0.0;
      wx_ring(u, 0.90, w,        1.00, h, dh);   // 先端の輪（いちばん強い）
      wx_ring(u, 0.62, w * 1.35, -0.34, h, dh);  // 1 つ内側の谷
      wx_ring(u, 0.34, w * 1.75, 0.11, h, dh);   // その内側の山
      acc.xy += rh * (dh * a / R);
      acc.z += h * a;
    }
  }
  return acc;
}

float wx_fresnel(float c){
  float m = clamp(1.0 - c, 0.0, 1.0);
  float m2 = m * m;
  return 0.02 + 0.98 * m2 * m2 * m;
}

void main(){
  float lin = texture2D(tWxDepth, gl_FragCoord.xy / uWxResolution).r;
  float rayLen = length(vRay);
  vec3 rd = vRay / rayLen;
  vec3 ro = uCamPos;
  // 湖面（平面 y = uWxLake）との交点。上を向いた視線と水中のカメラは対象外
  if (rd.y > -2e-4 || ro.y <= uWxLake + 0.02) discard;
  float tHit = (uWxLake - ro.y) / rd.y;
  float tEnd = lin * rayLen;                 // 手前の物（草・岩・地形・湖底）までの距離
  if (tHit <= 0.05 || tHit >= tEnd) discard; // 水面の手前に何かある
  if (tHit > uRipRange.x) discard;           // 遠すぎる（波紋が画素より細かい）
  vec3 P = ro + rd * tHit;
  if (flip_height(P.xz) > uWxLake - 0.04) discard;  // そこは水ではない

  // 画素の footprint（湖面の上での大きさ）。浅い角度では奥行き方向だけが長く伸びる
  float px = tHit * uWxPixel;
  vec2 fwdXZ = normalize(rd.xz + vec2(1e-6, 0.0));
  vec2 sideXZ = vec2(-fwdXZ.y, fwdXZ.x);
  float fpAcross = px;
  float fpAlong = min(px / max(-rd.y, 2e-4), 60.0);

  // 格子が画素より細かくなったら、その格子はまるごと評価しない（振幅がどのみち 0 に落ちる）。
  // 代表半径 = 速さ × 周期 × 0.9。1 画素の横幅がそれを超えたら打ち切り
  float crownA = 0.0, crownB = 0.0;
  vec3 f = vec3(0.0);
  if (fpAcross < 1.4 * uRipFine.z * uRipFine.y * 0.9)
    f = wx_rippleField(P.xz, uRipFine, uRipAmp.x, 0.0, fwdXZ, sideXZ, fpAlong, fpAcross, crownA);
  if (fpAcross < 1.4 * uRipCoarse.z * uRipCoarse.y * 0.9)
    f += wx_rippleField(P.xz, uRipCoarse, uRipAmp.y, 37.0, fwdXZ, sideXZ, fpAlong, fpAcross, crownB);
  float crown = crownA + crownB * 0.4;
  vec2 g = f.xy * uRipRange.y;
  crown *= uRipRange.y;
  // 波紋がまったく無い画素はここで抜ける（空の引き直しと空気遠近を払わない）
  if (uRipDebug < 0.5 && abs(g.x) + abs(g.y) + crown < 2e-4) discard;

  // 波紋が見えるのは「面が傾いて、別の向きのものを映すから」。
  // 水そのものの色（映り込み・水深の色・泡）は水担当のもので、ここからは読めないので、
  // **すでにそこに描かれている色の倍率**として明暗をつける（合成は dst *= 1 + m）。
  // 倍率なので色相は動かない＝「濡れた紫」のような色かぶりが原理的に出ない
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 R0 = normalize(vec3(rd.x, max(-rd.y, 0.004), rd.z));   // 平らな水面が映す向き
  vec3 R1 = reflect(rd, N);
  R1.y = max(R1.y, 0.004);                                    // 地平の下には空が無い
  R1 = normalize(R1);
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float l0 = dot(flip_skyColor(R0), LUMA);
  float l1 = dot(flip_skyColor(R1), LUMA);
  // 浅い角度から見た水面で波紋が「見える」いちばん大きな理由は、向きが変わることそのものより
  // **フレネルの反射率が変わること**。視線と 13°の水面は反射率 0.28 だが、こちらへ 10°傾いた面は
  // 0.10（暗い水が透けて暗くなる）、向こうへ 10°傾いた面は 0.74（空を映して明るくなる）。
  // 輪の山と谷でこれが交互に起きる＝同心の明暗の輪。利得を勝手に決めなくても十分な差が出る
  float F0 = wx_fresnel(max(-rd.y, 0.0));
  float F1 = wx_fresnel(max(dot(N, -rd), 0.0));
  float lb = uRipAmp.z * l0;                                  // 水そのものの明るさ（映り込み以外）
  float L0 = F0 * l0 + (1.0 - F0) * lb;
  float L1 = F1 * l1 + (1.0 - F1) * lb;
  float m = L1 / max(L0, 1e-7) - 1.0;

  // 空気遠近。遠いほど画素の中身は「途中の散乱光」になり、水面の明暗は効かなくなる。
  // flip_aerial の透過率と散乱光から「この画素のうち水面から来た光の割合」を出して掛ける
  vec4 aer = flip_aerial(P);
  float ly = l0 * aer.a;
  float surf = ly / max(ly + dot(aer.rgb, LUMA), 1e-7);
  m *= surf * (1.0 - smoothstep(uRipRange.x * 0.55, uRipRange.x, tHit));
  // 着弾の閃き（王冠のしぶき）。水面が一瞬だけ強く光る
  m += clamp(crown * uRipAmp.w, 0.0, 3.0) * surf;
  m = clamp(m, -0.62, 2.2);

  // 数式ビュー: 波の場そのものの等値線（＝中心から外へ広がる同心円）。
  // 湖面には水担当の線がすでに密に引かれているので、その上に薄く重ねるだけにする
  // （倍率合成なので強くすると相手の線を焼いてしまう）
  float fm = flip_mask(P);
  if (fm > 0.001) {
    float iso = clamp(flip_line(f.z * 420.0, 0.08), 0.0, 1.0);
    m = mix(m, iso * 0.85 - 0.12, fm);
  }
  if (uRipDebug > 0.5) {
    // 調査用。合成は dst*(1+src) のままなので、水面の色に対する「強い倍率」として出る
    vec3 dbg = vec3(0.0);
    if (uRipDebug < 1.5) dbg = vec3(length(g) * 3.0);
    else if (uRipDebug < 2.5) dbg = vec3(max(m, 0.0) * 2.0, 0.0, max(-m, 0.0) * 2.0);
    else if (uRipDebug < 3.5) dbg = vec3(step(0.004, length(g)));
    else dbg = vec3(clamp(f.z * 2000.0, 0.0, 1.0), 0.0, clamp(-f.z * 2000.0, 0.0, 1.0));
    gl_FragColor = vec4(dbg * 40.0, 1.0);
    return;
  }
  gl_FragColor = vec4(vec3(m), 1.0);
}
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

/** 格子の刻み: [セルの一辺(m), 周期=寿命(s), 輪の速さ(m/s), 当たる割合] */
export type RippleGrid = [number, number, number, number];

/**
 * 波紋の密度（個/m²/秒）= 1 / (セル² × 周期) × 当たる割合。
 * 既定の細かい格子 0.25m / 0.40s は 40 個/m²/秒（批評ラウンド7 の指示値）。
 * 周期＝寿命なので「常にセル1つに波紋1つ」＝ 16 個/m² が同時に見えている。
 */
export function rippleDensity(g: RippleGrid): number {
  return (1 / (g[0] * g[0] * g[1])) * g[3];
}

export class Ripples {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** 外から `mesh.visible = false` で止められたか（水担当が法線リングを入れたとき） */
  private stoppedOutside = false;
  private lastWrote = false;

  constructor(public w: Weather) {
    // low/mid では荒い格子だけ細かさを落とす（画素が大きいのでどのみち見えない）
    const tier = w.env.tier;
    const fine: RippleGrid = tier === "low" ? [0.40, 0.30, 0.62, 1] : [0.30, 0.30, 0.62, 1];
    const coarse: RippleGrid = [0.75, 1.15, 0.42, 0.78];
    const range = tier === "low" ? 160 : tier === "mid" ? 220 : 320;
    this.mat = new THREE.ShaderMaterial({
      uniforms: w.bind({
        uRipFine: { value: new THREE.Vector4(...fine) },
        uRipCoarse: { value: new THREE.Vector4(...coarse) },
        uRipAmp: { value: new THREE.Vector4(1.10, 0.55, 0.10, 1.3) },
        uRipRange: { value: new THREE.Vector2(range, 1) },
        uRipDebug: { value: 0 },
      }),
      vertexShader: WX_FS_VERT,
      fragmentShader: RIPPLE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // dst' = dst * src + dst * 1 = dst * (1 + m)。すでにある水の色に明暗を掛けるだけなので、
      // 色相が動かない（雨の水面が紫や黄に転ばない）。α は触らない
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(fullscreenTriangle(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.TRANSPARENT);
    // 水面(0)の後、霧の合成(10)の前。霧・雨のヴェールが波紋の上に掛かる
    this.mesh.renderOrder = 6;
    this.mesh.castShadow = false;
    this.mesh.name = "weather.ripple";
    this.mesh.visible = false;
    // 霧が出ていないフレームでも視線レイの行列が要る（fog.ts と同じものを同じ参照へ書く）
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      const wx = this.w.wx;
      const cam = camera as THREE.PerspectiveCamera;
      wx.uWxInvProj.value.copy(cam.projectionMatrix).invert();
      wx.uWxCamWorld.value.copy(cam.matrixWorld);
    };
    w.group.add(this.mesh);
  }

  /** 既定の密度（個/m²/秒）。報告・検証用 */
  get density(): number {
    const f = this.mat.uniforms.uRipFine.value as THREE.Vector4;
    const c = this.mat.uniforms.uRipCoarse.value as THREE.Vector4;
    return rippleDensity([f.x, f.y, f.z, f.w]) + rippleDensity([c.x, c.y, c.z, c.w]);
  }

  update() {
    const wt = this.w.env.weather;
    // 雨の強さで「当たるセルの割合」を変える（rain 0.7 → 8 割、storm 1.0 → 全部）
    const fine = this.mat.uniforms.uRipFine.value as THREE.Vector4;
    const coarse = this.mat.uniforms.uRipCoarse.value as THREE.Vector4;
    fine.w = Math.min(1, 0.28 + 0.74 * wt.rain);
    coarse.w = Math.min(1, 0.25 + 0.75 * wt.rain);
    // 嵐は輪が速く大きく広がり、波紋も強い
    fine.z = 0.62 + 0.24 * wt.storm;
    coarse.z = 0.42 + 0.3 * wt.storm;
    const amp = this.mat.uniforms.uRipAmp.value as THREE.Vector4;
    amp.x = 1.10 * (1 + 0.3 * wt.storm);
    (this.mat.uniforms.uRipRange.value as THREE.Vector2).y = Math.min(1, wt.rain * 1.25);
    // 水担当が `weather.rain.ripples.visible = false` で止めたら、それを尊重して以後こちらから触らない
    // （ARCHITECTURE.md の担当をまたぐ申し送り。毎フレーム visible を書き戻して打ち消さないため）
    if (this.mesh.visible !== this.lastWrote) this.stoppedOutside = !this.mesh.visible;
    const v = !this.stoppedOutside && wt.rain > 0.03;
    this.mesh.visible = v;
    this.lastWrote = v;
  }
}
