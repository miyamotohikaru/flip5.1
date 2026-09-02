// 空・大気・雲・光。
//   - 物理ベースの大気散乱（Hillaire 2020: 透過率 / 多重散乱 / Sky-View / 空気遠近 の LUT を毎フレーム小さな RT に焼く）
//   - 体積雲（低解像度 RT にレイマーチ → 空シェーダで合成。前フレームを方向で再投影して時間方向に再利用）
//   - 太陽の円盤・月・星・天の川、地表の霧（ミスト）、雲の影マップ
//   - 半球光（env.skyAmbient / groundAmbient）と環境マップ（PMREM → scene.environment）
//   - 太陽・月の色と強さ、露出は大気モデルから求めて env に上書きする（world.ts は sky.update() の後に env.syncUniforms()）
// 契約:
//   - LAYER.SKY のフルスクリーン三角形として描く（深度 1.0、depthWrite なし）。映り込みカメラでも正しく描ける
//   - flip_atmosphere チャンクの本体はここ（atmosphere.glsl.ts）。overrideChunk で差し替える
//   - GPU の仕事（LUT・雲）は scene.onBeforeRender（主パスの最初）で 1 フレームに 1 回だけ行う
import * as THREE from "three";
import { Env } from "../core/env";
import { LAYER } from "../core/pipeline";
import { bindEnvUniforms } from "../core/patch";
import { overrideChunk } from "../core/chunks";
import type { QualitySettings } from "../core/quality";
import { smoothstep, clamp } from "../core/noise";
import { FLIP_ATMOSPHERE_PBR } from "./atmosphere.glsl";
import { LUT_VERT, TRANS_FRAG, MS_FRAG, SKYVIEW_FRAG, AERIAL_FRAG, PROBE_FRAG } from "./lut.glsl";
import { NOISE_SHAPE_FRAG, NOISE_DETAIL_FRAG, WEATHER_FRAG, CLOUD_FRAG, CLOUD_SHADOW_FRAG } from "./clouds.glsl";
import { SKY_VERT, SKY_FRAG } from "./sky.glsl";
import { ATMO, transmittance, moonDirection, luminance } from "./cpu";
import { seedOffset } from "../core/seed";
import { LAB } from "../lab/store";

type U = Record<string, THREE.IUniform>;

const SHAPE_RES = 128;
const DETAIL_RES = 32;
const WEATHER_RES = 1024;
const WEATHER_TILE = 80000; // m
const SHADOW_RES = 512;
const SHADOW_EXTENT = 8192; // m（原点中心）
const AERIAL_MAX = 32000; // m
const GROUND_ALT_KM = 0.5; // 湖面の海抜（大気モデル上）

function rt2(w: number, h: number, o: THREE.RenderTargetOptions = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    ...o,
  });
}

export class Sky {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** false にすると GPU の仕事を止める（計測用） */
  enabled = true;
  /** 地形が flip_cloudShadow を使うようになったら false にする（太陽を雲量で一律に弱める代わりに、影マップで局所的に暗くなる） */
  globalCloudDim = true;
  /** 露出の倍率（調整・検証用） */
  exposureBias = 1;
  timings: Record<string, number> = {};

  private renderer: THREE.WebGLRenderer | null = null;
  private dirty = false;
  private frame = 0;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsMesh: THREE.Mesh;
  private transRT: THREE.WebGLRenderTarget;
  private msRT: THREE.WebGLRenderTarget;
  private skyViewRT: THREE.WebGLRenderTarget;
  private probeRT: THREE.WebGLRenderTarget;
  private shadowRT: THREE.WebGLRenderTarget;
  private weatherRT: THREE.WebGLRenderTarget;
  private aerialRT: THREE.WebGL3DRenderTarget;
  private shapeRT: THREE.WebGL3DRenderTarget;
  private detailRT: THREE.WebGL3DRenderTarget;
  private cloudRT: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cloudIdx = 0;
  private transMat: THREE.ShaderMaterial;
  private msMat: THREE.ShaderMaterial;
  private skyViewMat: THREE.ShaderMaterial;
  private aerialMat: THREE.ShaderMaterial;
  private probeMat: THREE.ShaderMaterial;
  private shapeMat: THREE.ShaderMaterial;
  private detailMat: THREE.ShaderMaterial;
  private weatherMat: THREE.ShaderMaterial;
  private cloudMat: THREE.ShaderMaterial;
  private shadowMat: THREE.ShaderMaterial;
  private envMat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 1e9;
  private envSunDir = new THREE.Vector3(0, -2, 0);
  private baked = { shape: 0, detail: 0, weather: false, hazeKm: -1, lab: -1 };
  /** シードが変わったとき（engine/lab/rebuild.ts）に呼ぶ。次のフレームで雲の天気マップを焼き直す */
  reseed() {
    (this.weatherMat.uniforms.uWeatherSeed.value as THREE.Vector2).set(seedOffset("sky", 1) * 0.004, seedOffset("sky", 2) * 0.004);
    this.baked.weather = false;
  }
  private probeBuf = new Float32Array(16);
  private probePending = false;
  private probeValid = false;
  private probeAsyncFailed = false;
  private probe = { skyIrr: new THREE.Color(), groundIrr: new THREE.Color(), mean: new THREE.Color(), sunside: new THREE.Color() };
  private viewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private historyValid = 0;
  private cloudSize = new THREE.Vector2(0, 0);
  private drawSize = new THREE.Vector2();
  private exposure = -1;
  // CPU 計算の一時変数
  private sunT = new THREE.Color();
  private moonT = new THREE.Color();
  private cloudSunT = new THREE.Color();
  private cloudMoonT = new THREE.Color();
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private sunGround = new THREE.Color();
  private moonGround = new THREE.Color();
  private sunCloudE = new THREE.Color();
  private moonCloudE = new THREE.Color();
  private ambTop = new THREE.Color();
  private ambBottom = new THREE.Color();
  private skyEff = new THREE.Color();
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();
  private e3 = new THREE.Vector3();
  private skyU: U;
  private cloudU: U;

  constructor(public scene: THREE.Scene, public env: Env, public q: QualitySettings) {
    overrideChunk("flip_atmosphere", FLIP_ATMOSPHERE_PBR);

    // ---- フルスクリーン三角形（LUT 用は uv 付き） ----
    const fsGeo = new THREE.BufferGeometry();
    fsGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    fsGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.fsMesh = new THREE.Mesh(fsGeo);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    // ---- RT ----
    this.transRT = rt2(256, 64);
    this.msRT = rt2(64, 32);
    this.skyViewRT = rt2(256, 128, { wrapS: THREE.RepeatWrapping });
    this.probeRT = rt2(4, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.shadowRT = rt2(SHADOW_RES, SHADOW_RES, { type: THREE.UnsignedByteType });
    this.weatherRT = rt2(WEATHER_RES, WEATHER_RES, { type: THREE.UnsignedByteType, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    this.aerialRT = new THREE.WebGL3DRenderTarget(64, 32, 16, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this.aerialRT.texture.wrapR = THREE.ClampToEdgeWrapping;
    const noiseOpts: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    };
    this.shapeRT = new THREE.WebGL3DRenderTarget(SHAPE_RES, SHAPE_RES, SHAPE_RES, noiseOpts);
    this.detailRT = new THREE.WebGL3DRenderTarget(DETAIL_RES, DETAIL_RES, DETAIL_RES, noiseOpts);
    this.shapeRT.texture.wrapR = THREE.RepeatWrapping;
    this.detailRT.texture.wrapR = THREE.RepeatWrapping;
    this.cloudRT = [rt2(2, 2), rt2(2, 2)];

    const eu = env.uniforms;
    eu.uSkyTransLut.value = this.transRT.texture;
    eu.uSkyViewLut.value = this.skyViewRT.texture;
    eu.uAerialLut.value = this.aerialRT.texture;
    eu.uCloudShadowMap.value = this.shadowRT.texture;
    eu.uSkyParams.value.set(SHADOW_EXTENT, AERIAL_MAX, 0.01, GROUND_ALT_KM);

    // ---- LUT のマテリアル ----
    const lutMat = (frag: string, uniforms: U = {}) => {
      bindEnvUniforms(uniforms, env);
      return new THREE.ShaderMaterial({ uniforms, vertexShader: LUT_VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    };
    const scatterU = (): U => ({
      uMsLut: { value: this.msRT.texture },
      uCamR: { value: ATMO.RG + GROUND_ALT_KM },
      uSunDirK: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDirK: { value: new THREE.Vector3(0, -1, 0) },
      uSunE: { value: new THREE.Vector3(ATMO.sunE0, ATMO.sunE0, ATMO.sunE0) },
      uMoonE: { value: new THREE.Vector3() },
    });
    this.transMat = lutMat(TRANS_FRAG);
    this.msMat = lutMat(MS_FRAG);
    const hiTier = q.tier === "high" || q.tier === "ultra";
    this.skyViewMat = lutMat(SKYVIEW_FRAG, { ...scatterU(), uMarchSteps: { value: hiTier ? 40 : 24 }, uNightGlow: { value: new THREE.Vector3(2.2e-4, 2.6e-4, 3.6e-4) } });
    this.aerialMat = lutMat(AERIAL_FRAG, { ...scatterU(), uMarchSteps: { value: hiTier ? 12 : 8 }, uSlice: { value: 0 }, uMaxDist: { value: AERIAL_MAX } });
    this.probeMat = lutMat(PROBE_FRAG, { uSunDirK: { value: new THREE.Vector3(0, 1, 0) } });
    this.shapeMat = lutMat(NOISE_SHAPE_FRAG, { uZ: { value: 0 } });
    this.detailMat = lutMat(NOISE_DETAIL_FRAG, { uZ: { value: 0 } });
    // 雲の天気マップは世界のシードでずらす（既定のシードでは 0 ＝ 今の並び）
    this.weatherMat = lutMat(WEATHER_FRAG, { uWeatherSeed: { value: new THREE.Vector2(seedOffset("sky", 1) * 0.004, seedOffset("sky", 2) * 0.004) } });

    // ---- 雲（レイマーチ・影） ----
    const cloudCommonU = (): U => ({
      uNoiseShape: { value: this.shapeRT.texture },
      uNoiseDetail: { value: this.detailRT.texture },
      uWeatherMap: { value: this.weatherRT.texture },
      uCloudLayer: { value: new THREE.Vector4(1900, 3400, 0.3, 0.025) },
      uWeatherParams: { value: new THREE.Vector4(1 / WEATHER_TILE, 0, 0, 1) },
      uCloudShape: { value: new THREE.Vector4(0, 1, 0, 0) },
      uWindOffset: { value: new THREE.Vector3() },
    });
    this.cloudU = {
      ...cloudCommonU(),
      uProjScale: { value: new THREE.Vector2(1, 1) },
      uCamWorld: { value: new THREE.Matrix4() },
      uHistory: { value: null },
      uPrevViewProj: { value: this.prevViewProj },
      uHistoryValid: { value: 0 },
      uFrame: { value: 0 },
      uSteps: { value: q.cloudSteps },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightE: { value: new THREE.Vector3() },
      uAmbTop: { value: new THREE.Vector3() },
      uAmbBottom: { value: new THREE.Vector3() },
    };
    this.cloudMat = lutMat(CLOUD_FRAG, this.cloudU);
    this.shadowMat = lutMat(CLOUD_SHADOW_FRAG, cloudCommonU());

    // ---- 空のドーム ----
    const skyUniforms = (mode: number): U => ({
      ...cloudCommonU(),
      uProjScale: { value: new THREE.Vector2(1, 1) },
      uCamWorld: { value: new THREE.Matrix4() },
      uCloudTex: { value: null },
      uMainViewProj: { value: this.viewProj },
      uCloudMode: { value: mode },
      uSunE: { value: new THREE.Vector3(ATMO.sunE0, ATMO.sunE0, ATMO.sunE0) },
      uMoonRadiance: { value: 0.9 },
      uPixelAngle: { value: 0.001 },
      uStarFrame: { value: new THREE.Matrix3() },
      uCheapCloudColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uStarVeil: { value: 0 },
    });
    const skyMat = (mode: number) => {
      const uniforms = skyUniforms(mode);
      bindEnvUniforms(uniforms, env);
      return new THREE.ShaderMaterial({
        uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth,
      });
    };
    this.material = skyMat(0);
    this.skyU = this.material.uniforms;
    const skyGeo = new THREE.BufferGeometry();
    skyGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const onBefore = (mat: THREE.ShaderMaterial) => (_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera) => {
      const cam = camera as THREE.PerspectiveCamera;
      const pe = cam.projectionMatrix.elements;
      (mat.uniforms.uProjScale.value as THREE.Vector2).set(pe[0], pe[5]);
      (mat.uniforms.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    };
    this.mesh = new THREE.Mesh(skyGeo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10000;
    this.mesh.layers.set(LAYER.SKY);
    this.mesh.onBeforeRender = onBefore(this.material);
    scene.add(this.mesh);
    // 環境マップ用（雲は簡易版）
    this.envMat = skyMat(1);
    const envMesh = new THREE.Mesh(skyGeo, this.envMat);
    envMesh.frustumCulled = false;
    envMesh.onBeforeRender = onBefore(this.envMat);
    this.envScene.add(envMesh);

    // ---- 主パスの最初に GPU の仕事をする ----
    const prev = scene.onBeforeRender;
    scene.onBeforeRender = (renderer, sc, camera, geometry, material, group) => {
      prev.call(scene, renderer, sc, camera, geometry, material, group);
      this.onSceneBeforeRender(renderer as THREE.WebGLRenderer);
    };
  }

  // ------------------------------------------------------------------ CPU 側（毎フレーム）
  update(dt: number) {
    const env = this.env;
    const w = env.weather;
    const eu = env.uniforms;
    this.frame++;
    this.dirty = true;

    // ---- 大気: 靄（uFog）と地表の霧 ----
    const fogK = clamp((w.fog - 0.15) / 0.85, 0, 1);
    const hazeKm = 0.008 + 0.10 * Math.pow(fogK, 1.3);
    eu.uSkyParams.value.set(SHADOW_EXTENT, AERIAL_MAX, hazeKm, GROUND_ALT_KM);
    const mistK = smoothstep(0.5, 1.0, w.fog);
    const t = env.time;
    // 第1層: 広いミスト（H=22m）。第2層: 湖面に張り付く濃い層（H=6m）。雨は薄い第1層だけ
    eu.uSkyFog.value.set(3.0e-3 * mistK + 3e-4 * w.rain, 22 + 12 * w.storm, w.windDir.x * w.wind * 0.6 * t, w.windDir.y * w.wind * 0.6 * t);
    eu.uSkyFog2.value.set(1.3e-2 * mistK, 6, 0, 0);

    // ---- 太陽（地上での放射照度 = E0 × 透過率） ----
    const camY = env.cameraPos.y;
    const rCam = ATMO.RG + GROUND_ALT_KM + Math.max(camY, -60) / 1000;
    transmittance(rCam, env.sunDir.y, hazeKm, GROUND_ALT_KM, this.sunT);
    const sunMax = Math.max(this.sunT.r, this.sunT.g, this.sunT.b, 1e-6);
    const cloudDim = this.globalCloudDim ? (1 - 0.9 * Math.pow(w.cloud, 1.4)) * (1 - 0.9 * w.storm) : 1;
    env.sunColor.copy(this.sunT).multiplyScalar(1 / sunMax);
    env.sunIntensity = ATMO.sunE0 * sunMax * cloudDim;

    // ---- 月（向きは満月の軌道。地上の光は lighting.ts が moonColor×4 にするので /4） ----
    moonDirection(env.hour, env.moonDir);
    transmittance(rCam, env.moonDir.y, hazeKm, GROUND_ALT_KM, this.moonT);
    const moonMax = Math.max(this.moonT.r, this.moonT.g, this.moonT.b, 1e-6);
    const moonUp = smoothstep(-0.02, 0.1, env.moonDir.y);
    const moonIrr = ATMO.sunE0 * ATMO.moonRatio * moonMax * moonUp * cloudDim;
    env.moonColor.copy(ATMO.moonTint).multiply(this.moonT).multiplyScalar(moonIrr / moonMax / 4);
    env.moonIntensity = moonIrr > 1e-6 ? 1 : 0;

    // ---- 雲の層 ----
    // 実験室の「雲量」「雲の高さ」はここに掛かる（既定は 1 ＝ 変化なし）
    const cov = (0.16 + 1.0 * Math.pow(w.cloud, 1.05)) * LAB.skyCloud;
    const base = (1900 - 700 * w.storm - 250 * w.rain) * LAB.skyCloudBase;
    const top = base + 1500 + 800 * w.cloud + 500 * w.storm;
    const sigma = 0.03 + 0.025 * w.storm;
    const layer = this.cloudU.uCloudLayer.value as THREE.Vector4;
    layer.set(base, top, cov, sigma);
    const shape = this.cloudU.uCloudShape.value as THREE.Vector4;
    shape.set(-0.55 * w.storm - 0.25 * w.rain, 1.0, 0, 0);
    const drift = w.wind * 1.8 * t;
    const wp = this.cloudU.uWeatherParams.value as THREE.Vector4;
    wp.set(1 / WEATHER_TILE, (-w.windDir.x * drift) / WEATHER_TILE, (-w.windDir.y * drift) / WEATHER_TILE, 1);
    (this.cloudU.uWindOffset.value as THREE.Vector3).set(w.windDir.x * w.wind * 1.4 * t, 0.7 * t, w.windDir.y * w.wind * 1.4 * t);
    for (const m of [this.shadowMat, this.material, this.envMat]) {
      (m.uniforms.uCloudLayer.value as THREE.Vector4).copy(layer);
      (m.uniforms.uCloudShape.value as THREE.Vector4).copy(shape);
      (m.uniforms.uWeatherParams.value as THREE.Vector4).copy(wp);
      (m.uniforms.uWindOffset.value as THREE.Vector3).copy(this.cloudU.uWindOffset.value as THREE.Vector3);
    }
    // 雲に当たる光（層の高さでの透過率）
    const rCloud = ATMO.RG + GROUND_ALT_KM + (base + top) * 0.5e-3;
    transmittance(rCloud, env.sunDir.y, hazeKm, GROUND_ALT_KM, this.cloudSunT);
    transmittance(rCloud, env.moonDir.y, hazeKm, GROUND_ALT_KM, this.cloudMoonT);
    const sunCloudE = this.sunCloudE.copy(this.cloudSunT).multiplyScalar(ATMO.sunE0);
    const moonCloudE = this.moonCloudE.copy(this.cloudMoonT).multiply(ATMO.moonTint).multiplyScalar(ATMO.sunE0 * ATMO.moonRatio * moonUp);
    const useSun = luminance(sunCloudE) >= luminance(moonCloudE);
    (this.cloudU.uLightDir.value as THREE.Vector3).copy(useSun ? env.sunDir : env.moonDir);
    const lightE = useSun ? sunCloudE : moonCloudE;
    (this.cloudU.uLightE.value as THREE.Vector3).set(lightE.r, lightE.g, lightE.b);

    // ---- 半球光（環境プローブの照度。届く前は概算） ----
    const p = this.probe;
    if (!this.probeValid) {
      const day = smoothstep(-0.1, 0.3, env.sunDir.y);
      p.skyIrr.setRGB(0.5, 0.7, 1.0).multiplyScalar(0.9 * day + 0.004).multiplyScalar(1 - 0.5 * w.cloud);
      p.mean.copy(p.skyIrr).multiplyScalar(0.5 / Math.PI);
      p.sunside.copy(p.mean).multiplyScalar(1.5);
    }
    const sunGround = this.sunGround.copy(this.sunT).multiplyScalar(ATMO.sunE0 * cloudDim * Math.max(env.sunDir.y, 0));
    const moonGround = this.moonGround.copy(env.moonColor).multiplyScalar(4 * Math.max(env.moonDir.y, 0));
    // 曇りの下では、空の光は「雲を透けた灰色の光」に置き換わる（晴れの青空の照度 → 全天の照度 × 雲の透過率）
    const coverG = smoothstep(0.25, 1.0, w.cloud);
    const cloudT = 0.38 - 0.28 * w.storm;
    const sunClear = this.tmpC2.copy(this.sunT).multiplyScalar(ATMO.sunE0 * Math.max(env.sunDir.y, 0));
    const overcast = this.tmpC.copy(sunClear).add(p.skyIrr).multiplyScalar(cloudT).multiply(this.tmpC2.setRGB(0.92, 0.94, 1.0));
    const skyEff = this.skyEff.copy(p.skyIrr).lerp(overcast, coverG);
        p.groundIrr.setRGB(0.28, 0.27, 0.22).multiply(this.tmpC.copy(sunGround).add(skyEff).add(moonGround));
    env.skyAmbient.copy(skyEff).multiplyScalar(0.5);
    env.groundAmbient.copy(p.groundIrr).multiplyScalar(0.5);
    // 霧に当たる光: 上半球の平均放射輝度（照度/π）が主。地面からの照り返しを少し
    eu.uSkyFogLight.value.copy(skyEff).multiplyScalar(0.85 / Math.PI).add(this.tmpC.copy(p.groundIrr).multiplyScalar(0.15 / Math.PI));
    const stormDark = 1 - 0.65 * w.storm;
    const ambTop = this.ambTop.copy(p.skyIrr).multiplyScalar((1.05 / Math.PI) * stormDark);
    (this.cloudU.uAmbTop.value as THREE.Vector3).set(ambTop.r, ambTop.g, ambTop.b);
    const ambBottom = this.ambBottom.copy(skyEff).multiplyScalar(0.22 / Math.PI).add(this.tmpC2.copy(p.groundIrr).multiplyScalar(0.40 / Math.PI)).multiplyScalar(stormDark);
    (this.cloudU.uAmbBottom.value as THREE.Vector3).set(ambBottom.r, ambBottom.g, ambBottom.b);
    const cheap = this.tmpC.copy(sunCloudE).multiplyScalar(0.10).add(this.tmpC2.copy(ambTop).multiplyScalar(0.8));
    for (const m of [this.material, this.envMat]) (m.uniforms.uCheapCloudColor.value as THREE.Vector3).set(cheap.r, cheap.g, cheap.b);

    // ---- 露出（物理量から。目の順応のように暗いほど上げるが、上げきらない＝夜は暗いまま） ----
    // 目安 = 地面の平均輝度 ＋ 太陽側の地平線の帯の輝度（夕焼けの明るい帯で露出が決まるように）
    const keyL = 0.064 * (luminance(sunGround) + luminance(skyEff) + 2.0 * luminance(moonGround)) + 0.1 * luminance(p.sunside) * (1 - 0.7 * coverG) + 1e-5;
    const target = clamp(0.8 * Math.pow(0.33 / keyL, 0.65), 0.5, 30);
    if (this.exposure < 0) this.exposure = target;
    else this.exposure += (target - this.exposure) * (1 - Math.exp(-dt * 2.0));
    env.exposure = this.exposure * this.exposureBias;

    // ---- 星の座標系（北へ 45° 傾いた極の周りを 15°/h で回る） ----
    const e3 = this.e3.set(0, Math.SQRT1_2, -Math.SQRT1_2);
    const theta = (env.hour * 15 * Math.PI) / 180;
    const ax = new THREE.Vector3(1, 0, 0).applyAxisAngle(e3, theta);
    const e1 = this.e1.copy(ax).normalize();
    const e2 = this.e2.crossVectors(e3, e1).normalize();
    const veil = 1 - smoothstep(-0.19, -0.04, env.sunDir.y);
    for (const m of [this.material, this.envMat]) {
      (m.uniforms.uStarFrame.value as THREE.Matrix3).set(e1.x, e1.y, e1.z, e2.x, e2.y, e2.z, e3.x, e3.y, e3.z);
      m.uniforms.uStarVeil.value = veil;
      (m.uniforms.uSunE.value as THREE.Vector3).setScalar(ATMO.sunE0);
    }

    // ---- LUT 用のカメラ・太陽・月 ----
    // 空気遠近の LUT だけは、曇りの下では光が弱い（雲の透過率ぶん）
    const aerialScale = 1 - coverG * (1 - cloudT * 1.3);
    for (const m of [this.skyViewMat, this.aerialMat]) {
      const k = m === this.aerialMat ? aerialScale : 1;
      m.uniforms.uCamR.value = rCam;
      (m.uniforms.uSunDirK.value as THREE.Vector3).copy(env.sunDir);
      (m.uniforms.uMoonDirK.value as THREE.Vector3).copy(env.moonDir);
      (m.uniforms.uSunE.value as THREE.Vector3).setScalar(ATMO.sunE0 * k);
      (m.uniforms.uMoonE.value as THREE.Vector3).set(ATMO.moonTint.r, ATMO.moonTint.g, ATMO.moonTint.b).multiplyScalar(ATMO.sunE0 * ATMO.moonRatio * moonUp * k);
    }
    (this.probeMat.uniforms.uSunDirK.value as THREE.Vector3).copy(env.sunDir);

    // ---- 主カメラ（雲 RT と再投影） ----
    const cam = env.camera;
    this.prevViewProj.copy(this.viewProj);
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const pe = cam.projectionMatrix.elements;
    (this.cloudU.uProjScale.value as THREE.Vector2).set(pe[0], pe[5]);
    (this.cloudU.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    this.cloudU.uFrame.value = this.frame;
    this.envTimer += dt;
  }

  // ------------------------------------------------------------------ GPU 側（主パスの最初に 1 回）
  private onSceneBeforeRender(renderer: THREE.WebGLRenderer) {
    if (!this.dirty || !this.enabled) return;
    this.dirty = false;
    this.renderer = renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    const t0 = performance.now();

    // 起動時の焼き込み（3D ノイズは数フレームに分けて）
    const b = this.baked;
    if (!b.weather) { this.blit(this.weatherMat, this.weatherRT); b.weather = true; }
    if (b.shape < SHAPE_RES) {
      const n = Math.min(SHAPE_RES, b.shape + 32);
      for (let z = b.shape; z < n; z++) { this.shapeMat.uniforms.uZ.value = (z + 0.5) / SHAPE_RES; this.blit(this.shapeMat, this.shapeRT, z); }
      b.shape = n;
    }
    if (b.detail < DETAIL_RES) {
      for (let z = 0; z < DETAIL_RES; z++) { this.detailMat.uniforms.uZ.value = (z + 0.5) / DETAIL_RES; this.blit(this.detailMat, this.detailRT, z); }
      b.detail = DETAIL_RES;
    }
    const hazeKm = this.env.uniforms.uSkyParams.value.z;
    // 実験室で媒質（ミー・レイリー・オゾン）を動かしたら、透過率と多重散乱の LUT も焼き直す
    const lb = this.env.uniforms.uLabSky.value as THREE.Vector4;
    const labKey = lb.x + lb.y * 7.13 + lb.z * 31.77;
    if (Math.abs(hazeKm - b.hazeKm) > 0.004 || labKey !== b.lab) {
      this.blit(this.transMat, this.transRT);
      this.blit(this.msMat, this.msRT);
      b.hazeKm = hazeKm;
      b.lab = labKey;
    }

    // 空の LUT
    this.blit(this.skyViewMat, this.skyViewRT);
    for (let z = 0; z < 16; z++) { this.aerialMat.uniforms.uSlice.value = z; this.blit(this.aerialMat, this.aerialRT, z); }
    this.blit(this.probeMat, this.probeRT);
    this.readProbe(renderer);
    this.blit(this.shadowMat, this.shadowRT);

    // 雲
    renderer.getDrawingBufferSize(this.drawSize);
    const cw = Math.max(8, Math.floor(this.drawSize.x * this.q.cloudScale));
    const ch = Math.max(8, Math.floor(this.drawSize.y * this.q.cloudScale));
    if (cw !== this.cloudSize.x || ch !== this.cloudSize.y) {
      this.cloudSize.set(cw, ch);
      for (const rt of this.cloudRT) rt.setSize(cw, ch);
      this.historyValid = 0;
    }
    const pixelAngle = (this.env.camera.fov * Math.PI) / 180 / Math.max(this.drawSize.y, 1);
    for (const m of [this.material, this.envMat]) m.uniforms.uPixelAngle.value = pixelAngle;
    const cur = this.cloudRT[this.cloudIdx], hist = this.cloudRT[1 - this.cloudIdx];
    this.cloudU.uHistory.value = hist.texture;
    this.cloudU.uHistoryValid.value = this.historyValid;
    this.blit(this.cloudMat, cur);
    this.skyU.uCloudTex.value = cur.texture;
    this.cloudIdx = 1 - this.cloudIdx;
    this.historyValid = 0.9;

    // 環境マップ（太陽が動いたか、一定時間ごと）
    const interval = this.q.tier === "high" || this.q.tier === "ultra" ? 0.5 : 1.0;
    if (this.envTimer >= interval || this.envSunDir.distanceToSquared(this.env.sunDir) > 1e-4) {
      this.envTimer = 0;
      this.envSunDir.copy(this.env.sunDir);
      this.updateEnvMap(renderer);
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    this.timings.cpuMs = performance.now() - t0;
  }

  private blit(mat: THREE.Material, target: THREE.WebGLRenderTarget, layer = 0) {
    const r = this.renderer!;
    this.fsMesh.material = mat;
    r.setRenderTarget(target, layer);
    r.render(this.fsScene, this.fsCam);
  }

  private readProbe(renderer: THREE.WebGLRenderer) {
    const apply = () => {
      const b = this.probeBuf, p = this.probe;
      if (!(b[0] >= 0) || !isFinite(b[0])) return;
      p.skyIrr.setRGB(b[0], b[1], b[2]);
      p.groundIrr.setRGB(b[4], b[5], b[6]);
      p.mean.setRGB(b[8], b[9], b[10]);
      p.sunside.setRGB(b[12], b[13], b[14]);
      this.probeValid = true;
    };
    if (!this.probeValid || this.probeAsyncFailed) {
      // 最初の 1 回（と非同期が使えない端末）は同期で読む
      if (this.probeAsyncFailed && this.frame % 20 !== 0) return;
      try { renderer.readRenderTargetPixels(this.probeRT, 0, 0, 4, 1, this.probeBuf); apply(); } catch { /* 読めなければ概算のまま */ }
      return;
    }
    if (this.probePending) return;
    this.probePending = true;
    renderer.readRenderTargetPixelsAsync(this.probeRT, 0, 0, 4, 1, this.probeBuf).then(() => { apply(); this.probePending = false; }).catch(() => { this.probeAsyncFailed = true; this.probePending = false; });
    // three.js は待っている間 PIXEL_PACK_BUFFER を束縛したままにする（他の readPixels が失敗する）ので外しておく
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  private updateEnvMap(renderer: THREE.WebGLRenderer) {
    if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(renderer);
    const size = this.q.tier === "high" || this.q.tier === "ultra" ? 128 : 64;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100, { size });
    const old = this.envRT;
    this.envRT = rt;
    this.scene.environment = rt.texture;
    // 半球光（env.skyAmbient）と二重にならないよう半分ずつ。地形が環境マップだけを使うなら 1.0 にして skyAmbient を 0 に
    this.scene.environmentIntensity = 0.5;
    if (old) old.dispose();
  }
}
