// ポスト処理。HDR の sceneRT を受け取り、画面（または写真用 RT）へ出す。
//
//   sceneRT(HDR, MSAA 解決済み)
//     ├─ bloom      … 6 段のダウン/アップサンプル（bloom.ts）
//     ├─ godrays    … 1/4 解像度の放射ブラー（godrays.ts）      [q.postFx.godrays]
//     ├─ ao         … 半分解像度の GTAO ＋ バイラテラル（ao.ts） [q.postFx.ao]
//     ├─ exposure   … 1×1 の平均輝度と焦点距離の追従（exposure.ts）
//     ├─ dof        … 近くを見たとき／写真モードだけ（dof.ts）   [q.postFx.dof]
//     ▼
//   grade（合成・レンズ・裏返し・露出・AgX・色調・ビネット → LDR sRGB、alpha = 裏返しマスク）
//     ▼
//   SMAA（high/ultra）／ FXAA（mid）／ なし（low）
//     ▼
//   final（シャープ・色収差・粒子・ディザ）→ 画面
//
// 契約:
//   - 入力は pipeline.sceneRT（HDR 線形）と sceneRT.depthTexture。出力は画面（null）または指定 RT
//   - GLSL は three の既定記法。トーンマップは自前の AgX（three と同じ式）。renderer.toneMapping は最終パスでは使わない
//   - takePhoto() は world から渡された hooks で 2 倍解像度に描き直して PNG を返す
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Pipeline } from "../core/pipeline";
import type { QualitySettings } from "../core/quality";
import { parseParams } from "../core/params";
import { bindEnvUniforms } from "../core/patch";
import { smoothstep, clamp } from "../core/noise";
import { fsMaterial, makeRT, GpuTimer } from "./pass";
import { AGX_GLSL } from "./agx.glsl";
import { Bloom } from "./bloom";
import { GodRays } from "./godrays";
import { AO } from "./ao";
import { DoF } from "./dof";
import { Exposure } from "./exposure";
import { GRADE_FRAG, gradeUniforms } from "./grade";
import { SMAA } from "./smaa";
import { FXAA } from "./fxaa";
import { Final } from "./final";
import { photoSize, renderTargetToPng } from "./photo";

export type PostRenderOptions = {
  /** 写真モード（露出の追従を止め、被写界深度を必ず掛ける） */
  photo?: boolean;
};

export type PhotoHooks = {
  /** 今の描画バッファの大きさ（px） */
  width: number;
  height: number;
  /** pipeline / water / post をこの大きさにする */
  resize: (w: number, h: number) => void;
  /** 1 フレームぶん描いて post.render(pipeline, target, { photo: true }) まで済ませる */
  render: (target: THREE.WebGLRenderTarget) => void;
};

export type AAMode = "smaa" | "fxaa" | "none";

export type PostStats = {
  /** ポスト全体の GPU 時間（ms）。タイマー拡張が無いと NaN */
  ms: number;
  passes: Record<string, number>;
  avgLum: number;
  focus: number;
  aa: AAMode;
  dof: boolean;
};

const V3 = new THREE.Vector3();
const V4 = new THREE.Vector4();

export class Post {
  bloom: Bloom;
  godrays: GodRays | null;
  ao: AO | null;
  dof: DoF | null;
  smaa: SMAA | null;
  fxaa: FXAA | null;
  final: Final;
  grade: THREE.ShaderMaterial;
  exposure: Exposure | null = null;
  timer: GpuTimer | null = null;
  ldrA: THREE.WebGLRenderTarget;
  ldrB: THREE.WebGLRenderTarget;
  width = 1;
  height = 1;
  aaMode: AAMode;
  /** 一人称でも被写界深度を許す焦点距離（m）。これより近くを見たときだけ掛かる */
  dofNearFocus = 4.0;
  stats: PostStats;
  private renderer: THREE.WebGLRenderer | null = null;
  private lastTime = 0;
  private photoMode = false;
  private dofActive = false;
  private lens = new THREE.Vector4();
  /**
   * 調査用フラグ（URL の ?dbg=...）: nobloom / nogod / noao / nodof / noaa / nograde / noauto / nograin / nolens /
   * noflare / nosharp、ポストごと飛ばす: nopost（＝postcopy。sceneRT をそのままトーンマップして出す）、
   * 表示: aoview / aodepth / depthview / godview / maskview / bloomview / edgesview / weightsview / flipview / distview
   */
  dbg: Set<string>;
  private statsOn: boolean;
  private viewMat: THREE.ShaderMaterial;

  constructor(public env: Env, public q: QualitySettings) {
    const fx = q.postFx;
    const params = parseParams(typeof location !== "undefined" ? location.search : "");
    this.dbg = new Set(params.dbg);
    this.statsOn = params.stats;
    this.viewMat = fsMaterial(
      "post_view",
      { tSrc: { value: null }, uMode: { value: 0 }, uNear: { value: 0.1 }, uFar: { value: 9000 }, uExposure: { value: 1 } },
      /* glsl */ `
      ${AGX_GLSL}
      uniform sampler2D tSrc; uniform float uMode; uniform float uNear; uniform float uFar; uniform float uExposure; varying vec2 vUv;
      void main(){
        vec4 t = texture2D(tSrc, vUv);
        vec3 c;
        bool srgb = true;
        if (uMode < 0.5) c = vec3(t.r);
        else if (uMode < 1.5) c = t.rgb / (1.0 + t.rgb);
        else if (uMode < 2.5) c = t.rgb;
        else if (uMode < 3.5) c = vec3(1.0 - t.g / 400.0);
        else if (uMode < 4.5) { float ndc = t.r * 2.0 - 1.0; float lin = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear)); c = vec3(1.0 - lin / 400.0); }
        // 5 = ポストなし: HDR の sceneRT を露出 → AgX → sRGB だけで出す
        else { c = post_linearToSrgb(post_agx(max(t.rgb, 0.0) * uExposure)); srgb = false; }
        if (srgb) c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`,
    );
    this.aaMode = fx.smaa ? (q.tier === "high" || q.tier === "ultra" ? "smaa" : "fxaa") : "none";
    this.bloom = new Bloom(6);
    this.godrays = fx.godrays ? new GodRays() : null;
    this.ao = fx.ao ? new AO() : null;
    this.dof = fx.dof ? new DoF() : null;
    this.smaa = this.aaMode === "smaa" ? new SMAA(0.08) : null;
    this.fxaa = this.aaMode === "fxaa" ? new FXAA() : null;
    this.final = new Final();
    const uniforms = gradeUniforms();
    bindEnvUniforms(uniforms, env);
    this.grade = fsMaterial("post_grade", uniforms, GRADE_FRAG);
    this.ldrA = makeRT(1, 1, { type: THREE.UnsignedByteType });
    this.ldrB = makeRT(1, 1, { type: THREE.UnsignedByteType });
    this.stats = { ms: NaN, passes: {}, avgLum: 0.18, focus: 5, aa: this.aaMode, dof: false };
  }

  private init(pipeline: Pipeline) {
    if (this.renderer) return;
    this.renderer = pipeline.renderer;
    this.exposure = new Exposure(this.renderer, pipeline.floatDepth);
    // GPU タイマーは ?stats=1 のときだけ（ANGLE/Metal ではクエリごとにコマンドバッファが切れて値が当てにならない上に負荷になる）
    this.timer = new GpuTimer(this.renderer, this.statsOn);
    this.lastTime = performance.now();
  }

  resize(w: number, h: number) {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.bloom.resize(this.width, this.height);
    this.godrays?.resize(this.width, this.height);
    this.ao?.resize(this.width, this.height);
    this.dof?.resize(this.width, this.height);
    this.smaa?.resize(this.width, this.height);
    this.ldrA.setSize(this.width, this.height);
    this.ldrB.setSize(this.width, this.height);
    this.exposure?.snap();
  }

  /** 時刻・天気から「ルック」を決める（毎フレーム） */
  private updateLook(photo: boolean) {
    const env = this.env;
    const u = this.grade.uniforms;
    const s = env.sunDir.y;
    const golden = smoothstep(-0.06, 0.02, s) * (1 - smoothstep(0.08, 0.32, s));
    const night = 1 - smoothstep(-0.16, -0.03, s);
    const sunUp = smoothstep(-0.04, 0.06, s);
    const w = env.weather;
    const storm = w.storm, cloud = w.cloud, rain = w.rain;
    const warmth = 0.55 * golden - 0.42 * night - 0.25 * storm - 0.08 * cloud * (1 - storm);
    u.uWarmth.value = clamp(warmth, -1, 1);
    // 夜は彩度を大きく落とす（プルキンエ現象＝暗いと錐体が働かず色が抜ける）。
    // 草の緑が読めるのが「青い昼」に見える一番の原因だった
    // 雨は彩度を上げる（灰色一色にしない）。嵐には掛けない＝嵐は中性に寄せるのが目標なので
    u.uSaturation.value = 0.97 + 0.30 * golden - 0.5 * night + 0.22 * storm + 0.52 * rain * (1 - storm) - 0.05 * cloud * (1 - storm);
    // 黒を締める（夜明けの紫灰の一色フィルターを避ける）。夜は締めない（暗部が全部つぶれる）
    u.uContrast.value = 1.1 + 0.05 * golden - 0.16 * night - 0.1 * storm;
    // 影の青みは控えめに（朝夕が「Instagram のフィルター」にならないように）
    (u.uSplit.value as THREE.Vector2).set(0.2 + 0.16 * night + 0.08 * storm, 0.35 + 0.35 * golden - 0.3 * night);
    u.uVignette.value = this.dbg.has("nograde") ? 0 : 0.18 + 0.1 * storm + 0.05 * night + 0.06 * rain;
    u.uGradeOn.value = this.dbg.has("nograde") ? 0 : 1;
    u.uDebug.value = this.dbg.has("flipview") ? 1 : this.dbg.has("distview") ? 2 : 0;
    u.uBloomStrength.value = 0.055 + 0.02 * golden + 0.02 * night + 0.02 * rain;
    u.uDropRain.value = rain;
    u.uExposure.value = env.exposure;
    u.uAoStrength.value = this.ao ? 1.7 : 0.0;
    const underwater = smoothstep(0, 0.3, env.uniforms.uLakeLevel.value - env.cameraPos.y);
    u.uWaterFade.value = underwater;
    // 太陽の画面位置（太陽方向の遠い点をカメラで射影する）
    const cam = env.camera;
    V3.copy(env.sunDir).transformDirection(cam.matrixWorldInverse);
    const front = -V3.z;
    let sunFront = 0;
    let offFade = 0;
    if (front > 1e-3) {
      V4.set(env.sunDir.x, env.sunDir.y, env.sunDir.z, 0);
      V3.set(V4.x, V4.y, V4.z).multiplyScalar(5000).add(cam.position).project(cam);
      const sx = V3.x * 0.5 + 0.5, sy = V3.y * 0.5 + 0.5;
      (u.uSunScreen.value as THREE.Vector2).set(sx, sy);
      sunFront = smoothstep(0.05, 0.3, front);
      const ox = Math.max(0, Math.abs(sx - 0.5) - 0.5), oy = Math.max(0, Math.abs(sy - 0.5) - 0.5);
      offFade = 1 - smoothstep(0, 0.45, Math.hypot(ox, oy));
    } else {
      (u.uSunScreen.value as THREE.Vector2).set(-10, -10);
    }
    u.uSunFront.value = sunFront;
    (u.uSunDir.value as THREE.Vector3).copy(env.sunDir);
    const sc = env.sunColor;
    const m = Math.max(sc.r, sc.g, sc.b, 1e-3);
    (u.uSunColorN.value as THREE.Vector3).set(sc.r / m, sc.g / m, sc.b / m);
    const dbg = this.dbg;
    u.uGodStrength.value = this.godrays && !dbg.has("nogod") ? (0.12 + 0.38 * golden) * (1 - 0.45 * cloud) * (1 - 0.5 * storm) * sunUp * offFade : 0;
    u.uFlareStrength.value = dbg.has("noflare") || dbg.has("nolens") ? 0 : 0.25 * sunUp * (1 - 0.7 * cloud) * (1 - storm) * (dbg.has("flarex") ? 4 : 1);
    // ハロー（太陽を囲む輪）は氷晶の暈。晴天（cloud 0.18）では出さず、薄雲のときだけ薄く出す
    u.uHalo.value = smoothstep(0.35, 0.75, cloud) * (1 - storm) * (1 - rain);
    // レンズの水滴: 見上げたときと突風のときだけ付く（常時だと空中に灰色の丸が浮いて見える）
    const pitch = Math.asin(clamp(-cam.matrixWorld.elements[9], -1, 1)); // カメラ前方 -Z の Y 成分 → 見上げが正
    const lookUp = smoothstep(0.02, 0.35, pitch);
    const gust = smoothstep(0.3, 0.8, env.weather.gust);
    u.uDropAmt.value = dbg.has("nolens") ? 0 : clamp(Math.max(lookUp, gust * 0.9), 0, 1);
    // 自動露出。
    //   昼: 物理の露出（空モジュールが決める env.exposure）を尊重して、±の幅を小さく取る。
    //       基準を 0.5 → 0.34 に下げて、黄昏の日なたの草が AgX の白側で脱色するのを避ける。
    //   夜・嵐: env.exposure が上限に張り付いて「青い昼」「白飛びした灰色」になる。
    //       ここは追従の強さを 1 に上げて「狙った明るさ」に合わせ切る（空側の上限が 30 でも 6 でも同じ絵になる）。
    const dark = Math.max(night, 0.85 * storm);
    u.uAutoRef.value = THREE.MathUtils.lerp(0.38, 0.045, night);
    u.uAutoStrength.value = dbg.has("noauto") ? 0 : THREE.MathUtils.lerp(0.70, 1.0, dark);
    (u.uAutoRange.value as THREE.Vector2).set(THREE.MathUtils.lerp(0.7, 0.15, dark), THREE.MathUtils.lerp(12.0, 30, dark));
    // 暗部の持ち上げ（影に空の環境光を残す）。夜だけは持ち上げない（空が乳白色になる）
    u.uLift.value = this.dbg.has("nograde") ? 0 : THREE.MathUtils.lerp(0.024, 0.004, night);
    u.uPivot.value = 0.42;
    // 嵐だけ白バランスで中性に寄せる（批評R6: 非閃光フレームの空の R−G を ±4 へ）。
    // 空担当がオゾンを落とすと晴天の薄明の青紫まで失うため、post 側で嵐だけ補正する。
    // smoothstep で立ち上げるので、rain プリセット（storm 0.15）はほぼ素通し
    // 閃光の瞬間は雷光（青白い）が照明なのでマゼンタは出ない。掛けると逆に緑に転ぶので外す
    const flash = clamp(env.lightning.flash, 0, 1);
    const sN = this.dbg.has("nograde") ? 0 : smoothstep(0.35, 0.9, storm) * (1 - smoothstep(0.10, 0.45, flash));
    u.uTintFix.value = 0.9 * sN;
    (u.uNeutral.value as THREE.Vector3).set(THREE.MathUtils.lerp(1, 0.97, sN), 1, 1);
    // AgX の白側の脱色を戻す。露出を上げるほど色が抜けるので、黄昏と嵐で多めに
    u.uChromaBack.value = this.dbg.has("nograde") ? 0 : clamp(0.55 + 0.3 * golden + 0.3 * storm + 0.35 * rain * (1 - storm), 0, 0.9);
    if (dbg.has("nobloom")) u.uBloomStrength.value = 0;
    if (dbg.has("noao")) u.uAoStrength.value = 0;
    if (dbg.has("nolens")) u.uDropRain.value = 0;
    // 最終パス
    const f = this.final.mat.uniforms;
    f.uGrain.value = dbg.has("nograin") ? 0 : (0.022 + 0.008 * night + 0.01 * storm) * (photo ? 0.8 : 1);
    f.uGrainSeed.value = Math.floor(env.time * 24) * 7.31;
    f.uCA.value = dbg.has("nolens") ? 0 : 0.55;
    f.uSharpen.value = dbg.has("nosharp") ? 0 : 0.3;
    f.uSharpenFlip.value = dbg.has("nosharp") ? 0 : 0.4;
    // レンズ（被写界深度）。x = 焦点距離 m, y = 有効口径 m, z = センサ高 m, w = 出力の高さ px
    const focal = 0.024;
    const fnum = photo ? 2.0 : 2.8;
    this.lens.set(focal, focal / fnum, 0.024, this.height);
  }

  /** 一人称で被写界深度を掛けるか（近くを見ているときだけ） */
  private dofWanted(photo: boolean): boolean {
    if (!this.dof) return false;
    if (photo) return true;
    const focus = this.exposure?.focus ?? 100;
    return focus < this.dofNearFocus;
  }

  render(pipeline: Pipeline, target: THREE.WebGLRenderTarget | null = null, opts: PostRenderOptions = {}) {
    this.init(pipeline);
    const photo = !!opts.photo || this.photoMode;
    const env = this.env;
    const cam = env.camera;
    const w = pipeline.width, h = pipeline.height;
    if (w !== this.width || h !== this.height) this.resize(w, h);
    const now = performance.now();
    const dt = photo ? 0 : Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    const timer = this.timer!;
    const scene = pipeline.sceneRT.texture;
    const depth = pipeline.sceneRT.depthTexture as THREE.Texture;
    const u = this.grade.uniforms;
    this.updateLook(photo);

    // 調査用: ポストを飛ばして sceneRT をそのままトーンマップして出す（負荷の比較・切り分け用）。
    // 何も出さないと真っ暗になって切り分けに使えないので、必ずこの経路を通す
    if ((this.dbg.has("nopost") || this.dbg.has("postcopy")) && !photo) {
      const v = this.viewMat.uniforms;
      v.tSrc.value = scene;
      v.uMode.value = 5;
      v.uExposure.value = env.exposure;
      pipeline.blit(this.viewMat, target);
      return;
    }

    // ブルーム
    timer.begin("bloom");
    this.bloom.render(pipeline, scene, w, h);
    timer.end();

    // 逆ビュー射影（世界座標の復元）
    const invVP = u.uInvViewProj.value as THREE.Matrix4;
    invVP.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    (u.uCamPos.value as THREE.Vector3).copy(cam.position);

    // ゴッドレイ
    if (this.godrays) {
      timer.begin("godrays");
      this.godrays.render(pipeline, scene, depth, invVP, cam.position, env.sunDir, u.uSunScreen.value as THREE.Vector2);
      timer.end();
      u.tGod.value = this.godrays.texture;
      u.tGodMask.value = this.godrays.mask.texture;
    }

    // AO
    if (this.ao) {
      timer.begin("ao");
      this.ao.render(pipeline, depth, w, h, cam);
      timer.end();
      u.tAO.value = this.ao.texture;
      (u.uHalfRes.value as THREE.Vector2).set(this.ao.rt.width, this.ao.rt.height);
    }

    // 露出・焦点
    const ex = this.exposure!;
    if (!photo) {
      timer.begin("exposure");
      const sm = this.bloom.smallest;
      ex.render(pipeline, sm.texture, sm.width, sm.height, depth, w, h, cam, dt);
      timer.end();
    }
    u.tAdapt.value = ex.texture;

    // 被写界深度
    const dofOn = this.dofWanted(photo) && !this.dbg.has("nodof");
    this.dofActive = dofOn;
    if (dofOn && this.dof) {
      // 一人称では近づくほど滑らかに開く
      const k = photo ? 1 : smoothstep(this.dofNearFocus, this.dofNearFocus * 0.4, ex.focus);
      const lens = this.lens.clone();
      lens.y *= k;
      const focus = photo ? ex.focus : Math.max(ex.focus, 0.3);
      timer.begin("dof");
      this.dof.cocMax = photo ? 12 : 9;
      this.dof.render(pipeline, scene, depth, w, h, cam, lens, focus);
      timer.end();
      u.tDof.value = this.dof.texture;
      (u.uDof.value as THREE.Vector4).copy(lens);
      u.uFocus.value = focus;
      u.uCocMax.value = this.dof.cocMax;
    }
    u.uDofOn.value = dofOn ? 1 : 0;

    // 合成・色調 → LDR
    u.tScene.value = scene;
    u.tDepth.value = depth;
    u.tBloom.value = this.bloom.texture;
    u.tBloomFine.value = this.bloom.down[0].texture;
    u.uBloomNorm.value = 1 / this.bloom.weightSum;
    (u.uRes.value as THREE.Vector2).set(w, h);
    (u.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uAspect.value = w / h;
    timer.begin("grade");
    pipeline.blit(this.grade, this.ldrA);
    timer.end();

    // 調査用の表示
    if (this.dbg.size > 0 && !photo) {
      const v = this.viewMat.uniforms;
      let tex: THREE.Texture | null = null, mode = 0;
      if (this.dbg.has("flipview") || this.dbg.has("distview")) { tex = this.ldrA.texture; mode = 2; }
      else if (this.dbg.has("aoview") && this.ao) { tex = this.ao.texture; mode = 0; }
      else if (this.dbg.has("aodepth") && this.ao) { tex = this.ao.texture; mode = 3; }
      else if (this.dbg.has("depthview")) { tex = depth; mode = 4; v.uNear.value = cam.near; v.uFar.value = cam.far; }
      else if (this.dbg.has("godview") && this.godrays) { tex = this.godrays.texture; mode = 0; }
      else if (this.dbg.has("maskview") && this.godrays) { tex = this.godrays.mask.texture; mode = 0; }
      else if (this.dbg.has("bloomview")) { tex = this.bloom.texture; mode = 1; }
      else if (this.dbg.has("edgesview") && this.smaa) { this.smaa.render(pipeline, this.ldrA.texture, w, h, this.ldrB); tex = this.smaa.edgesRT.texture; mode = 2; }
      else if (this.dbg.has("weightsview") && this.smaa) { this.smaa.render(pipeline, this.ldrA.texture, w, h, this.ldrB); tex = this.smaa.weightsRT.texture; mode = 2; }
      if (tex) {
        v.tSrc.value = tex;
        v.uMode.value = mode;
        pipeline.blit(this.viewMat, target);
        timer.poll();
        return;
      }
    }

    // AA
    let src: THREE.Texture = this.ldrA.texture;
    if (this.dbg.has("noaa")) {
      /* AA を飛ばす */
    } else if (this.smaa) {
      timer.begin("smaa");
      this.smaa.render(pipeline, src, w, h, this.ldrB);
      timer.end();
      src = this.ldrB.texture;
    } else if (this.fxaa) {
      timer.begin("fxaa");
      this.fxaa.render(pipeline, src, w, h, this.ldrB);
      timer.end();
      src = this.ldrB.texture;
    }

    // 最終
    timer.begin("final");
    const grainPx = Math.max(1, Math.round(w / 1700));
    this.final.render(pipeline, src, w, h, grainPx, target);
    timer.end();
    timer.poll();
    this.stats.ms = timer.total;
    this.stats.passes = timer.ms;
    this.stats.avgLum = ex.avgLum;
    this.stats.focus = ex.focus;
    this.stats.dof = dofOn;
  }

  /** 写真モード: 2 倍解像度（上限 4096）で描き直して PNG にする。画面には触らない */
  async takePhoto(hooks: PhotoHooks): Promise<Blob | null> {
    const r = this.renderer;
    if (!r) return null;
    const { w, h } = photoSize(hooks.width, hooks.height, this.env.isMobile);
    const rt = makeRT(w, h, { type: THREE.UnsignedByteType });
    this.photoMode = true;
    try {
      hooks.resize(w, h);
      hooks.render(rt);
    } finally {
      this.photoMode = false;
      hooks.resize(hooks.width, hooks.height);
      r.setRenderTarget(null);
    }
    try {
      return await renderTargetToPng(r, rt);
    } finally {
      rt.dispose();
    }
  }

  dispose() {
    this.bloom.dispose();
    this.godrays?.dispose();
    this.ao?.dispose();
    this.dof?.dispose();
    this.smaa?.dispose();
    this.fxaa?.dispose();
    this.final.dispose();
    this.exposure?.dispose();
    this.grade.dispose();
    this.ldrA.dispose();
    this.ldrB.dispose();
  }
}
