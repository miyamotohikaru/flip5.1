// 地表霧のむら（半解像度レイマーチ → 深度を見て拡大合成）＋ 雨のヴェール ＋ 稲光の暫定ライティング。
//   - 密度: 湖面からの高さで薄くなる層 × 谷筋（地形が低いところ）に溜まる × 地面を這う × 3D ノイズのむら（風で流れる）
//   - 光: 太陽の前方散乱（HG）で太陽側が明るい・半球光・月・稲光
//   - 合成: rgb = 散乱光（premultiplied）, a = 1 - 透過率。水面の後（TRANSPARENT）に描くので水にも掛かる
//   - 稲光の暫定ライティング（flashMesh）: 空担当・地形担当が uLightning を読むまでの間、地面と空を一瞬明るくする
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { WX_COMMON, WX_FS_VERT } from "./glsl";
import type { Weather } from "./index";

/** 空担当・地形担当が uLightning を読むようになったら false にする（二重に明るくなるのを防ぐ） */
export const INTERIM_FLASH_LIGHTING = true;

const MARCH_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uLightning;
uniform vec3 uLightningPos;
uniform float uWxSteps;
uniform float uWxDebug;
varying vec2 vUv;
varying vec3 vRay;

float wx_noise3(vec3 p){ return 0.7 * flip_vnoise(p) + 0.3 * flip_vnoise(p.xz * 3.1 + 7.3 + p.y * 0.7); }

// 霧・雨に入ってくる「空の光」。晴れならその向きの空の色、曇り・嵐では雲を透けた光。
// flip_skyColor は雲の無い空を返すので、そのまま使うと嵐でも明るい空色の板になって雲の構造が消える。
// uSkyAmbient は空の照度の半分（空担当が雲を織り込んで更新する）→ 平均放射輝度 = uSkyAmbient * 2/π
vec3 wx_skyLit(vec3 skyH){
  vec3 c = mix(skyH, uSkyAmbient * 0.64, smoothstep(0.35, 1.0, uCloud));
  // 嵐の夕方は uSkyAmbient がほぼ黒（1e-4 台）で、そのわずかな色かぶりが
  // 雨のカーテン全体の色になる（露出 12 倍で増幅されて空がマゼンタに転ぶ）。
  // 暗いときほど色を捨てて明るさだけを残す
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float neutral = 1.0 - smoothstep(0.002, 0.05, y);
  return mix(c, vec3(y), 0.35 + 0.6 * neutral);
}

// 霧の密度（0..1 相当）。湖面すれすれの薄い層（場所ごとに厚さの違う「塊」）＋谷底＋斜面を這う霧＋細かいむら
// fp = その標本の「1画素の footprint（m）」。fp より細かいむらは平らにならす（＝手前でだけ細かい）。
// これをやらないと、遠くの水面のような「浅い角度で長く伸びる面」で標本ごとに値が飛び、
// 半解像度の格子が 2px の市松ノイズとして出る。
float mistDensity(vec3 p, float fp){
  float th = flip_height(p.xz);
  float hL = p.y - uWxLake;
  float hag = p.y - th;
  // 低周波の「霧の塊」で層の厚さ（スケール高さ）が場所ごとに変わる → たなびく帯と切れ目
  vec2 q2 = (p.xz + uWxFogDrift.xz * 0.6) * 0.012;
  float bank = flip_vnoise(q2) * 0.7 + flip_vnoise(q2 * 2.3 + 5.0) * 0.3;
  float Hs = uWxFog.y * (0.3 + 3.6 * bank * bank);
  float layer = exp(-max(hL, 0.0) / Hs) * smoothstep(60.0, 0.0, th - uWxLake);
  float creep = exp(-max(hag, 0.0) / (uWxFog.y * 0.8)) * smoothstep(200.0, 15.0, th - uWxLake) * 0.22;
  float base = max(layer, creep) * step(-1.0, hag);
  // 細かいむら: 横に長く、縦に薄い「たなびき」。コントラストを強く（濃い塊と切れ目）
  vec3 q = (p + uWxFogDrift) * vec3(0.045, 0.3, 0.045);
  // 22m 級（k22）と 6m 級（k6）と 2m 級（k2）のむら。足跡より細かいものは平均値（0.5）へ寄せて消す
  float k6 = 1.0 - smoothstep(2.5, 9.0, fp);
  float k2 = 1.0 - smoothstep(0.8, 3.0, fp);
  float n = mix(0.5, wx_noise3(q), mix(1.0, k6, 0.3)) * 0.75 + 0.25 * mix(0.5, flip_vnoise(q.xz * 3.5 + q.y * 0.5 + 3.0), k2);
  // 遠いほど閾値をなだらかに（硬い境目はエイリアスの元）
  float sw = 0.15 * (1.0 - k6);
  n = smoothstep(0.42 - sw, 0.72 + sw, n);
  // 湖面すれすれ（〜70cm）の濃い「たなびき」: 風向きに引き伸ばした 2D ノイズで筋状に
  vec2 wd = normalize(uWxFogDrift.xz + vec2(1e-3, 0.0));
  vec2 pw = vec2(dot(p.xz, wd), dot(p.xz, vec2(-wd.y, wd.x)));
  // 33m×9m の帯 → 9m×2.5m → 3m×0.8m の3オクターブ（近景でも模様が見える細かさ）
  vec2 pn = vec2(pw.x * 0.03, pw.y * 0.11) + uWxFogDrift.xz * 0.05;
  float n2 = 0.5 * flip_vnoise(pn) + 0.3 * mix(0.5, flip_vnoise(pn * 3.7 + 11.0), k6) + 0.2 * mix(0.5, flip_vnoise(pn * 11.0 + 5.0), k2);
  float wsw = 0.02 + 0.14 * (1.0 - k2);
  // たなびきは湖面から 1m の帯なので、水面を舐める視線では長さがそのまま厚みになる（＝湖が消える）。
  // 「霧の朝」だけに出し、雨・嵐のうっすらした地表霧では出さない
  float wispGate = smoothstep(0.35, 0.75, uWxFog.x);
  float wisp = exp(-max(hL, 0.0) / 1.0) * smoothstep(0.44 - wsw, 0.6 + wsw, n2) * smoothstep(3.0, -0.5, th - uWxLake) * step(-1.0, hag) * wispGate;
  return base * (0.08 + 0.92 * n) + wisp * 4.0;
}

// 1歩ぶんの散乱光。skyH = その視線の地平近くの空の色（霧は空の色で光る: 曇りなら灰、夜明けなら薄紅）
vec3 stepLight(vec3 p, vec3 rd, vec3 skyH){
  float sunUp = smoothstep(-0.06, 0.04, uSunDir.y);
  float cs = dot(rd, uSunDir);
  vec3 sun = uSunColor * (wx_phaseHG(cs, 0.6) * 0.75 + 0.06) * sunUp;
  // 霧の粒は空全体の光を散らすので、地平の空より少し明るく白い
  // 地面の照り返しも「明るさだけ」を取る（1e-4 台の色かぶりが霧全体の色になるのを防ぐ）
  float gy = dot(uGroundAmbient, vec3(0.2126, 0.7152, 0.0722));
  vec3 amb = mix(vec3(dot(uSkyAmbient, vec3(0.2126, 0.7152, 0.0722))) * 0.6, wx_skyLit(skyH), 0.65) * 1.35 + vec3(gy) * 0.15;
  vec3 moon = uMoonColor * (wx_phaseHG(dot(rd, uMoonDir), 0.5) * 0.7 + 0.1) * 2.0;
  vec3 lp = uLightningPos + vec3(0.0, uWxCloudBase * 0.45, 0.0);
  float dl = distance(p, lp);
  vec3 flash = vec3(0.94, 0.96, 1.0) * uLightning * 0.22 / (1.0 + dl * dl / (500.0 * 500.0));
  return sun + amb + moon + flash;
}

void main(){
  vec2 uvFull = (floor(gl_FragCoord.xy) * 2.0 + 0.5) / uWxResolution;
  float lin = texture2D(tWxDepth, uvFull).r;
  float rayLen = length(vRay);
  vec3 rd = vRay / rayLen;
  vec3 ro = uCamPos;
  float tEnd = lin * rayLen;
  float mist = uWxFog.x;
  float T = 1.0;
  vec3 L = vec3(0.0);
  float odTotal = 0.0;
  vec3 skyH = flip_skyColor(normalize(vec3(rd.x, max(rd.y, 0.015), rd.z)));
  if (mist > 1e-4) {
    float top = uWxFog.z, bottom = uWxLake - 4.0;
    float t0 = 0.0, t1 = tEnd;
    if (abs(rd.y) > 1e-4) {
      float ta = (top - ro.y) / rd.y;
      float tb = (bottom - ro.y) / rd.y;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
      // 水面より下には霧が無い（深度は水底なので、水面で打ち切る）
      if (ro.y > uWxLake && rd.y < 0.0) t1 = min(t1, (uWxLake - ro.y) / rd.y);
    } else if (ro.y > top || ro.y < bottom) {
      t1 = t0;
    }
    if (ro.y < uWxLake) t1 = t0;
    if (t1 > t0) {
      float marchEnd = min(t1, t0 + 380.0);
      // 霧が薄いときは段数を減らす（雨・嵐の中の薄い地表霧に全段は要らない）
      float N = ceil(uWxSteps * clamp(mist * 2.5 + 0.2, 0.35, 1.0));
      // 標本位置は「区間の中点」で固定する。画素ごとにずらす（白色ノイズでも秩序ディザでも）と、
      // 半解像度の格子がそのまま 2px の粒／斜めの綾になって水面のような平らな面に出る。
      // 中点法は 2 次精度で、隣の画素と連続に変化する＝拡大しても模様が出ない。
      float dither = 0.5;
      float k = mist * WX_FOG_K;
      float span = marchEnd - t0;
      float prevT = t0;
      for (int i = 0; i < 24; i++) {
        if (float(i) >= N) break;
        float f1 = (float(i) + 1.0) / N;
        float tNext = t0 + span * f1 * f1;
        float fm = (float(i) + dither) / N;
        float t = t0 + span * fm * fm;
        float dt = tNext - prevT;
        prevT = tNext;
        vec3 p = ro + rd * t;
        // その距離での 1 画素の大きさ（半解像度なので 2 倍）
        float fp = t * uWxPixel * 2.0;
        float od = mistDensity(p, fp) * k * dt;
        float Ti = exp(-od);
        L += stepLight(p, rd, skyH) * (1.0 - Ti) * T;
        T *= Ti;
        odTotal += od;
        if (T < 0.004) break;
      }
      if (t1 > marchEnd && T > 0.004) {
        float odt = wx_fogOD(ro + rd * marchEnd, ro + rd * t1) * 0.7;
        float Tt = exp(-odt);
        L += stepLight(ro + rd * (marchEnd + 40.0), rd, skyH) * (1.0 - Tt) * T;
        T *= Tt;
        odTotal += odt;
      }
    }
  }
  // 雨のヴェール: 遠くほど雨粒の層で白む。うっすら縦に流れるむら（雨の幕）
  if (uWxFog.w > 1e-7) {
    // 雨は雲底より下にしかない。見上げるほど早く雨の層を抜ける（天頂では雲の構造が見える）
    float dV = min(tEnd, 6000.0);
    if (rd.y > 0.01) dV = min(dV, max(uWxCloudBase - ro.y, 0.0) / rd.y);
    vec3 ps = ro + rd * min(tEnd, 200.0);
    // 雨脚の帯（λ≈125m）が風で流れる＝「雨のカーテンが景色を横切る」。その上に細かい縦のむら
    float band = 0.55 + 0.9 * flip_vnoise((ps.xz + uWxFogDrift.xz * 2.5) * 0.008);
    float fine = 0.80 + 0.40 * flip_vnoise(vec3(ps.x * 0.035, ps.y * 0.01 - uTime * 2.2, ps.z * 0.035));
    float sheet = band * fine;
    float odv = wx_veilOD(dV) * sheet;
    float Tv = exp(-odv);
    // 稲光は稲妻の方向の雨のカーテンだけを強く照らす（一様に足すと空全体が白飛びする）。
    // さらに落雷までの距離で 1/(1+(d/500m)^2) に減衰させ、遠い落雷では世界が明るくならないようにする
    vec3 boltP = uLightningPos + vec3(0.0, uWxCloudBase * 0.5, 0.0);
    vec3 toBolt = normalize(boltP - ro);
    float dBolt = distance(boltP, ro);
    float attBolt = 1.0 / (1.0 + dBolt * dBolt / (500.0 * 500.0));
    float flashDir = (0.02 + 0.28 * pow(max(dot(rd, toBolt), 0.0), 8.0)) * attBolt;
    // 雨のカーテンが空の 2 倍より明るくならないよう頭を打つ
    vec3 lit = wx_skyLit(skyH);
    vec3 fl = min(vec3(0.94, 0.96, 1.0) * uLightning * flashDir, lit * 2.0 + 0.005);
    // 雨のカーテンは「そこに届いている空の光」で光る（空より明るくならない）
    // 下を向いた視線ほど地面の照り返しを拾う（カーテンの下側が地面の色に寄る）
    float sy = dot(uSkyAmbient, vec3(0.2126, 0.7152, 0.0722));
    float gy2 = dot(uGroundAmbient, vec3(0.2126, 0.7152, 0.0722));
    vec3 vcol = lit * 0.92 + vec3(sy) * 0.06 + vec3(gy2) * (0.04 + 0.10 * max(-rd.y, 0.0)) + fl;
    L += vcol * (1.0 - Tv) * T;
    T *= Tv;
    odTotal += odv;
  }
  // 裏返し: 光学的厚さ（解析・むら無し）の等値線を紙の上に細い線で。霧そのものは薄い青の洗い
  vec3 pm = ro + rd * min(tEnd, 200.0);
  float fmask = flip_mask(pm);
  if (fmask > 0.0) {
    float odA = wx_fogOD(ro, ro + rd * min(tEnd, 2000.0)) * 2.0 + wx_veilOD(min(tEnd, 6000.0));
    float iso = flip_line(odA * 6.0, 0.05) * 0.7 + flip_line(odA * 1.5, 0.08);
    float wash = (1.0 - T) * 0.3;
    vec3 mc = FLIP_LINE * min(iso, 1.0) * 0.55 * (1.0 - T) + FLIP_BG * 0.8 * wash;
    L = mix(L, mc, fmask);
    T = mix(T, 1.0 - max(wash, min(iso, 1.0) * 0.55 * (1.0 - T)), fmask);
  }
  if (uWxDebug > 0.5) L = vec3(1.0, 0.0, 0.0) * (1.0 - T);
  if (uWxDebug > 1.5) {
    // 生の線形深度: R = 20m 周期, G = 200m 周期, B = 1m 未満なら 1
    L = vec3(fract(lin / 20.0), fract(lin / 200.0), step(lin, 1.0));
    T = 0.0;
  }
  gl_FragColor = vec4(L, T);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${WX_COMMON}
uniform sampler2D tWxFog;
uniform vec2 uWxFogRes;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  vec2 fc = gl_FragCoord.xy;
  float myD = texture2D(tWxDepth, fc / uWxResolution).r;
  // 深度の「1画素あたりの傾き」。水面のように浅い角度で伸びる面ではこれが大きい。
  // 許容差をこの傾きで決めると、平らな面では 4 タップとも同じ重み（＝素直な双一次）になり、
  // 物のシルエット（傾きでは説明できない段差）だけを弾ける。
  // 固定の相対誤差で重み付けすると、水面で重みが画素ごとに入れ替わって 2px の市松になる。
  float grad = abs(dFdx(myD)) + abs(dFdy(myD));
  float sigma = 3.0 * grad + 0.02 * myD + 0.35;
  vec2 hp = fc * 0.5 - 0.5;
  vec2 b = floor(hp);
  vec2 f = hp - b;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 n = clamp(b + vec2(float(i), float(j)), vec2(0.0), uWxFogRes - 1.0);
      float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float d = texture2D(tWxDepth, (n * 2.0 + 0.5) / uWxResolution).r;
      float w = bw * exp(-abs(d - myD) / sigma) + 1e-3;
      acc += texture2D(tWxFog, (n + 0.5) / uWxFogRes) * w;
      wsum += w;
    }
  }
  vec4 fog = acc / wsum;
  gl_FragColor = vec4(fog.rgb, 1.0 - fog.a);
}
`;

const FLASH_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WX_COMMON}
uniform vec3 uCamPos;
uniform float uLightning;
uniform vec3 uLightningPos;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  float lin = texture2D(tWxDepth, gl_FragCoord.xy / uWxResolution).r;
  vec3 rd = normalize(vRay);
  vec3 p = uCamPos + vRay * lin;
  vec3 lp = uLightningPos + vec3(0.0, uWxCloudBase * 0.4, 0.0);
  // 落雷までの距離で減衰（1/(1+(d/500m)^2)）。遠い落雷では画面全体が明るくならない
  vec3 toCam = lp - uCamPos;
  float dCam = length(toCam);
  float attCam = 1.0 / (1.0 + dCam * dCam / (500.0 * 500.0));
  float b;
  if (lin > 8500.0) {
    // 空: 稲妻の方向だけ光る。基準輝度の3倍（= 1 + 2）を上限にして雲の構造を残す
    vec3 toL = toCam / max(dCam, 1e-3);
    b = min((0.10 + 1.7 * pow(max(dot(rd, toL), 0.0), 6.0)) * attCam, 2.0);
  } else {
    vec3 N = flip_terrainNormal(p.xz, 2.5);
    vec3 toL = lp - p;
    float d = length(toL);
    toL /= d;
    float ndl = max(dot(N, toL), 0.0);
    float att = 1.0 / (1.0 + d * d / (500.0 * 500.0));
    // 稲妻の向きの影（地形のレイマーチ）。80ms だけ差す「影付きの方向光」になる。
    // 遠景は雨のヴェールで潰れるので近くだけ（負荷を 600m 以内に閉じ込める）
    float occ = 0.0;
    if (lin < 600.0) {
      for (int i = 1; i <= 8; i++) {
        float s = float(i) * float(i) * 5.0;
        vec3 qs = p + toL * s;
        occ = max(occ, smoothstep(0.0, 16.0, flip_height(qs.xz) - qs.y));
      }
    }
    float sh = 1.0 - occ * 0.85;
    b = min(ndl * sh * att * 5.0 + 0.10 * attCam, 2.0);
  }
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * b * uLightning, 1.0);
}
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

export class GroundFog {
  rt: THREE.WebGLRenderTarget;
  marchMat: THREE.ShaderMaterial;
  compMat: THREE.ShaderMaterial;
  flashMat: THREE.ShaderMaterial;
  compMesh: THREE.Mesh;
  flashMesh: THREE.Mesh;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private marchMesh: THREE.Mesh;
  private rtW = 0;
  private rtH = 0;
  /** この霧を描くか（量がゼロなら丸ごと飛ばす） */
  active = false;

  constructor(public w: Weather) {
    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.marchMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ uWxSteps: { value: w.counts.fogSteps }, uWxDebug: { value: 0 } }),
      vertexShader: WX_FS_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.marchMesh = new THREE.Mesh(fullscreenTriangle(), this.marchMat);
    this.marchMesh.frustumCulled = false;
    this.fsScene.add(this.marchMesh);

    this.compMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ tWxFog: { value: this.rt.texture }, uWxFogRes: { value: new THREE.Vector2(2, 2) } }),
      vertexShader: WX_FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
    });
    this.compMesh = new THREE.Mesh(fullscreenTriangle(), this.compMat);
    this.compMesh.frustumCulled = false;
    this.compMesh.layers.set(LAYER.TRANSPARENT);
    this.compMesh.renderOrder = 10;
    this.compMesh.castShadow = false;
    this.compMesh.name = "weather.fog";
    this.compMesh.onBeforeRender = (renderer, _scene, camera) => this.march(renderer, camera as THREE.PerspectiveCamera);
    w.group.add(this.compMesh);

    this.flashMat = new THREE.ShaderMaterial({
      uniforms: w.bind({}),
      vertexShader: WX_FS_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.flashMesh = new THREE.Mesh(fullscreenTriangle(), this.flashMat);
    this.flashMesh.frustumCulled = false;
    this.flashMesh.layers.set(LAYER.TRANSPARENT);
    this.flashMesh.renderOrder = 20;
    this.flashMesh.castShadow = false;
    this.flashMesh.name = "weather.flash";
    this.flashMesh.visible = false;
    // 稲光の暫定ライティングはカメラ行列が要る（compMesh が描かれないフレームもあるので自前で更新）
    this.flashMesh.onBeforeRender = (_r, _s, camera) => this.updateCamera(camera as THREE.PerspectiveCamera);
    w.group.add(this.flashMesh);
  }

  private updateCamera(camera: THREE.PerspectiveCamera) {
    const wx = this.w.wx;
    wx.uWxInvProj.value.copy(camera.projectionMatrix).invert();
    wx.uWxCamWorld.value.copy(camera.matrixWorld);
  }

  /** 半解像度で霧を積分（compMesh の描画直前に呼ばれる。Reflector と同じ入れ子描画） */
  private march(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) {
    this.updateCamera(camera);
    const p = this.w.pipeline;
    const fw = Math.max(1, Math.floor((p?.width ?? 2) / 2));
    const fh = Math.max(1, Math.floor((p?.height ?? 2) / 2));
    if (fw !== this.rtW || fh !== this.rtH) {
      this.rtW = fw;
      this.rtH = fh;
      this.rt.setSize(fw, fh);
      (this.compMat.uniforms.uWxFogRes.value as THREE.Vector2).set(fw, fh);
    }
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.fsScene, this.fsCam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadow;
  }

  update() {
    const w = this.w;
    const fog = w.wx.uWxFog.value;
    const flash = w.env.lightning.flash;
    this.active = fog.x > 0.002 || fog.w > 1e-7;
    this.compMesh.visible = this.active;
    this.flashMesh.visible = INTERIM_FLASH_LIGHTING && flash > 0.004;
  }
}
