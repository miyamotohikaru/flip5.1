// 太陽（CSM のカスケード影）・半球光・月光。env を毎フレーム反映する。
//
// 影の質はここが唯一の持ち主。カスケードごとの PCF 半径・法線オフセット・深度バイアスを
// 毎フレーム決める（`updateShadowParams`）。**他のモジュールは `csm.lights[i].shadow` を書かないこと**
// （地形・植生が別々に書くと、どちらが勝つかが描画順で変わって画が跳ねる）。
//
// 考え方:
//   - 影の縁が階段に見えるのは「シャドウマップのテクセルが画面で数 px あるのに、ぼかしがその幅に足りない」から。
//     ぼかし（PCF 半径）を**ワールドの半影幅**で決め、テクセル幅で割ってテクセル数に直す。
//     カスケードが変わるとテクセル幅は 2 倍前後に跳ぶが、狙う半影幅は距離の連続関数なので、
//     `csm.fade` の重なりの中で両側の見た目が近くなり、境目で跳ばない。
//   - 半影はカスケードが遠いほどワールドで広い（遠景の影は輪郭を持たない方が自然で、テクセルも大きい）。
//   - 法線オフセット（normalBias）は「PCF がテクセルを何枚舐めるか」に比例させる。足りないと縞状のアクネ、
//     大きすぎると影が足元から浮く（peter-panning）ので、半径 + 定数の 0.8 倍に留めて上限を切る。
//   - CSM が届く外（600m 以遠）は、シャドウマップの代わりに `flip_sunOcclusion`（core/glsl/height.glsl.ts）
//     ＝「地形の地平角＋林の天蓋のレイマーチ」で太陽を遮る。CSM が差し替えた lights_fragment_begin に
//     さらに差し込むので、それを使う全マテリアル（地形・木・岩・インポスター）に一度に効く
//     （草だけは自前の lights_fragment_begin なので vegetation/shaders.ts 側で同じものを掛けている）。
//   - 影の中は真っ黒にしない。太陽（directLight）だけを影で消し、半球光（hemi）と環境マップ
//     （scene.environment）はそのまま残す＝日陰は「空の色」で満たされる。
//   - カスケードの割り方は CSM 既定の practical をやめて、**25m を起点にした等比**にする。
//     practical は 1 枚目が 0〜64m と広く、足元（幹の根元・株の際）の影がテクセルに埋もれて出ない。
//     等比なら 1 枚目が 0〜25m に締まって接地影が出て、最後の 1 枚が遠くまで伸びる。
//     画面に映るテクセルの大きさ（texel/距離）はどのカスケードでもほぼ一定になる。
import * as THREE from "three";
import { CSM } from "three/examples/jsm/csm/CSM.js";
import type { Env } from "./env";
import type { QualitySettings } from "./quality";
import { LAYER } from "./pipeline";

/**
 * 1 枚目のカスケードが受け持つ距離（m）。ここから maxFar まで等比で割る。
 * 小さいほど足元の接地影が細かく出るが、2 枚目以降が粗くなる。
 */
const CASCADE_NEAR_M = 25;

/** 近景で狙う半影の幅（m）。ここを大きくすると足元の接地影がぼやける */
const PENUMBRA_NEAR = 0.015;
/**
 * 見ている距離 1m ごとに増える半影の幅（m）。
 * 本来の半影は「遮る物と地面の距離」で決まる（太陽の見かけの直径 0.53° ≒ 0.0093）が、
 * 遮蔽距離は分からないので視距離で代用する。遠景がふわりと柔らかくなり、
 * 大きくなったシャドウマップのテクセル（＝階段）もちょうど隠れる。
 */
const PENUMBRA_RATE = 0.0045;
/**
 * 日陰に残す太陽の割合。周りの日なたから跳ね返ってくる光（1 回目の相互反射）の代用で、
 * 半球光・環境マップだけでは屋外の日陰が実際より 2 倍暗くなるのを埋める。
 * 日なたの明るさは変わらない（getShadow は mix(1, shadow, intensity) なので shadow=1 では素通り）。
 */
const SHADOW_FILL = 0.12;

/** 段階ごとの PCF: [ぼかしの上限（テクセル）, 標本数] */
const PCF: Record<string, { maxRadius: number; taps: number }> = {
  low: { maxRadius: 2.0, taps: 5 },
  mid: { maxRadius: 2.6, taps: 8 },
  high: { maxRadius: 3.2, taps: 12 },
  ultra: { maxRadius: 3.6, taps: 16 },
};

/** three.js の既定チャンク（差し替える前）。二度目の差し替えで壊れないよう最初の 1 回だけ覚える */
let pcfChunkOriginal: string | null = null;
let pcfChunkTaps = 0;

/**
 * three.js の PCF 影を「Vogel ディスク N 標本」に差し替える。
 * 既定は 5 標本で、半径を広げると縞（バンド）とざらつきが出て縁が階段に見える。
 * 標本を増やすと縁がなめらかになる（1 標本がハードウェア 2×2 PCF なので実効 4N タップ）。
 * three.js 側の書き方が変わったら黙って既定のまま（画は出る）。
 */
function installPcfTaps(taps: number) {
  if (pcfChunkTaps === taps) return;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  if (pcfChunkOriginal === null) pcfChunkOriginal = chunks.shadowmap_pars_fragment;
  const src = pcfChunkOriginal;
  const tail = ") * 0.2;";
  const end = src.indexOf(tail);
  const head = end < 0 ? -1 : src.lastIndexOf("shadow = (", end);
  if (end < 0 || head < 0 || !src.includes("vogelDiskSample")) {
    pcfChunkTaps = taps;
    return;
  }
  if (taps === 5) {
    chunks.shadowmap_pars_fragment = src;
    pcfChunkTaps = taps;
    return;
  }
  const lines: string[] = [];
  for (let i = 0; i < taps; i++) {
    lines.push(`texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( ${i}, ${taps}, phi ) * radius, shadowCoord.z ) )`);
  }
  const body = `shadow = (\n\t\t\t\t\t${lines.join(" +\n\t\t\t\t\t")}\n\t\t\t\t) * ${(1 / taps).toFixed(7)};`;
  chunks.shadowmap_pars_fragment = src.slice(0, head) + body + src.slice(end + tail.length);
  pcfChunkTaps = taps;
}

/**
 * カスケードの分割。1 枚目の終わりを `CASCADE_NEAR_M` に固定し、そこから maxFar まで等比で割る。
 * CSM 既定の practical（uniform と log の中点）は 1 枚目が 0〜64m と広く、
 * 足元（幹の根元・株の際）の影がテクセルに埋もれて出ないので使わない。
 * target には「far で割った 0..1」を cascades 個入れる（最後は必ず 1）。
 */
function geometricSplits(cascades: number, _near: number, far: number, target: number[]) {
  const d0 = Math.max(4, Math.min(CASCADE_NEAR_M, far * 0.4));
  const ratio = Math.pow(far / d0, 1 / Math.max(1, cascades - 1));
  for (let i = 0; i < cascades - 1; i++) target.push(Math.min(1, (d0 * Math.pow(ratio, i)) / far));
  target.push(1);
}

/** CSM が差し替えた lights_fragment_begin（遠景の遮蔽を足す前）。二度目の差し替えで壊れないよう覚える */
let sunOccChunkOriginal: string | null = null;

/**
 * 太陽に「遠景の遮蔽」（山の影＋林が落とす帯）を掛ける。
 * CSM が差し替えた `lights_fragment_begin` にさらに差し込むことで、
 * それを使う全マテリアル（地形・木・岩・インポスター）に一度に効く。
 * 実体は `flip_sunOcclusion`（core/glsl/height.glsl.ts）。呼ぶ側は `#include <flip_height>` と
 * `#include <flip_atmosphere>`（uCamPos / uSunDir）を持っていること。
 * three.js / CSM の書き方が変わったら黙って何もしない（画は出る）。
 */
function installSunOcclusion() {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  if (sunOccChunkOriginal === null) sunOccChunkOriginal = chunks.lights_fragment_begin;
  const src = sunOccChunkOriginal;
  const decl = "vec3 geometryPosition = - vViewPosition;";
  const marker = "#if ( NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS)";
  const call = "getDirectionalLightInfo( directionalLight, directLight );";
  const idx = src.indexOf(marker);
  if (!src.includes("USE_CSM") || idx < 0 || !src.includes(decl) || !src.includes(call)) return;
  const head = `${decl}
#if defined( USE_CSM ) && defined( CSM_CASCADES )
  // viewMatrix は回転＋平行移動なので、逆回転は転置で足りる
  vec3 flipSunWP = uCamPos + transpose( mat3( viewMatrix ) ) * geometryPosition;
  float flipSunOcc = flip_sunOcclusion( flipSunWP, uSunDir, length( flipSunWP - uCamPos ) );
#endif`;
  let out = src.replace(decl, head);
  const at = out.indexOf(marker);
  out = out.slice(0, at).split(call).join(`${call} directLight.color *= flipSunOcc;`) + out.slice(at);
  chunks.lights_fragment_begin = out;
}

export class Lighting {
  csm: CSM;
  hemi: THREE.HemisphereLight;
  moon: THREE.DirectionalLight;
  /** カスケードごとの影の実測値（調査・報告用。`window.__flip.lighting.shadowInfo` で読める） */
  readonly shadowInfo: { texel: number; penumbra: number; radius: number; normalBias: number }[] = [];
  private tmp = new THREE.Vector3();
  private pcf: { maxRadius: number; taps: number };

  constructor(public scene: THREE.Scene, public env: Env, public q: QualitySettings) {
    this.pcf = PCF[q.tier] ?? PCF.high;
    // マテリアルが 1 つでもコンパイルされる前に差し替える（Lighting は Terrain/Vegetation より先に作られる）
    installPcfTaps(this.pcf.taps);
    this.csm = new CSM({
      maxFar: q.shadowMaxFar,
      cascades: q.shadowCascades,
      mode: "custom",
      customSplitsCallback: geometricSplits,
      parent: scene,
      shadowMapSize: q.shadowMapSize,
      lightDirection: new THREE.Vector3(-0.3, -1, -0.2).normalize(),
      lightIntensity: 3,
      camera: env.camera,
      shadowBias: -0.00015,
      lightMargin: 250,
    });
    // CSM が lights_fragment_begin を差し替えた後に、遠景の遮蔽を足す
    installSunOcclusion();
    // カスケードの境目を重ねて混ぜる（跳ばない）。重なり幅の分だけ影の範囲も広がる
    this.csm.fade = true;
    for (const l of this.csm.lights) {
      l.shadow.normalBias = 0.05;
      l.shadow.camera.layers.enable(LAYER.MAIN_ONLY);
      l.shadow.camera.layers.enable(LAYER.TRANSPARENT);
      l.castShadow = true;
      this.shadowInfo.push({ texel: 0, penumbra: 0, radius: 0, normalBias: 0 });
    }
    this.hemi = new THREE.HemisphereLight(0x8fb4e6, 0x4a3a2a, 0.6);
    scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x9fb2ff, 0);
    scene.add(this.moon);
    scene.add(this.moon.target);
    this.updateShadowParams();
  }

  update() {
    const env = this.env;
    const sunUp = env.sunDir.y > -0.02;
    this.csm.lightDirection.copy(env.sunDir).multiplyScalar(-1).normalize();
    for (const l of this.csm.lights) {
      l.intensity = sunUp ? env.sunIntensity : 0;
      l.color.copy(env.sunColor);
    }
    this.csm.update();
    this.updateShadowParams();
    // 遠景の遮蔽が読む植生マップ（vegetation が焼いた後に入る。名前が違うのは二重宣言を避けるため）
    env.uniforms.uSunVeg.value = env.uniforms.uVegMap.value;
    this.hemi.color.copy(env.skyAmbient);
    this.hemi.groundColor.copy(env.groundAmbient);
    // 日陰を満たすのは半球光と環境マップ（sky が scene.environmentIntensity で半分持つ）。
    // ここを下げると影の中が黒くなるので 1.0 のまま
    this.hemi.intensity = 1.0;
    this.moon.position.copy(this.tmp.copy(env.moonDir).multiplyScalar(500)).add(env.cameraPos);
    this.moon.target.position.copy(env.cameraPos);
    // 月光。env.moonColor は基準色（強さは含まない）、env.moonIntensity が強さ。
    this.moon.intensity = env.moonIntensity * 4;
    this.moon.color.copy(env.moonColor);
  }

  /**
   * カスケードごとの PCF 半径・法線オフセット・深度バイアス。`csm.update()` の後に毎フレーム。
   * CSM は影のカメラの大きさ（= テクセル幅）を `updateFrustums()` でしか変えないが、
   * 太陽の高さで必要なバイアスが変わるので毎フレーム決め直す（3〜4 回のループなので安い）。
   */
  private updateShadowParams() {
    const csm = this.csm;
    const lights = csm.lights;
    if (lights.length === 0) return;
    const cam = this.env.camera;
    const far = Math.min(cam.far, csm.maxFar);
    // 太陽が低いほど光と地面が平行に近く、細かい起伏が縞状のアクネになる。2.6 倍を上限に濃くする
    const elev = Math.min(1, Math.max(0.05, this.env.sunDir.y));
    const graze = Math.min(2.6, 1 / Math.sqrt(elev));
    let dNear = cam.near;
    for (let i = 0; i < lights.length; i++) {
      const sh = lights[i].shadow;
      const c = sh.camera as THREE.OrthographicCamera;
      const dFar = (csm.breaks[i] ?? 1) * far;
      const dMid = 0.5 * (dNear + dFar);
      dNear = dFar;
      // シャドウマップ 1 テクセルがワールドで何 m か
      const texel = (c.right - c.left) / sh.mapSize.x;
      if (!(texel > 0)) continue;
      // 狙う半影の幅（m）。距離の連続関数なので、カスケードが変わっても見た目が大きくは跳ばない
      const penumbra = PENUMBRA_NEAR + PENUMBRA_RATE * dMid;
      // 下限はカスケードが遠いほど大きく（テクセルが粗いので階段が出やすい）。
      // テクセル 1.5 枚を下回るとハードウェアの 2×2 PCF に埋もれて縁が段になる
      const t = lights.length > 1 ? i / (lights.length - 1) : 0;
      const rMin = 1.5 + 1.0 * t;
      const radius = Math.min(this.pcf.maxRadius, Math.max(rMin, penumbra / texel));
      sh.radius = radius;
      sh.intensity = 1 - SHADOW_FILL;
      // 法線オフセット: PCF が舐めるテクセル数に比例。大きすぎると影が幹の根元から離れて
      // 別の場所に落ちて見える（peter-panning。批評 R2 の ridge「影が根元から 80px ずれる」）ので、
      // 「テクセル 2.6 枚」と 0.8m を上限に切る
      sh.normalBias = Math.min(2.6 * texel, 0.8, texel * (radius + 0.9) * 0.6 * graze);
      // 深度バイアス（光の向きへのずらし）。three.js は影のカメラの奥行き（既定 1〜2000m）に対する
      // 比で持つので、テクセル幅の 0.36〜0.74 倍（m）を割って渡す
      const depthRange = Math.max(1, c.far - c.near);
      sh.bias = (-(0.12 + 0.24 * graze) * texel) / depthRange;
      const info = this.shadowInfo[i];
      if (info) {
        info.texel = texel;
        info.penumbra = radius * texel;
        info.radius = radius;
        info.normalBias = sh.normalBias;
      }
    }
  }

  resize() {
    this.csm.updateFrustums();
    this.updateShadowParams();
  }
}
