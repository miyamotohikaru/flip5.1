// 天気の表現。雨（筋・しぶき・ヴェール）・地表霧のむら・稲光・花粉・蛍・葉・風の見える化。
// 契約:
//   - 状態は env.weather（cloud / rain / fog / wind / wetness / storm / gust）。ここでは見た目だけを担当
//   - env.lightning（flash / lastStrikeTime / position / strikeIndex）と uniforms.uLightning / uLightningPos / uGust は
//     ここが毎フレーム更新する（音担当は env.lightning.strikeIndex の変化で雷鳴を鳴らす）
//   - 半透明は全て LAYER.TRANSPARENT（水面の後に描かれる）。ソフトパーティクルは pipeline.copyDepthRT を読む
//   - 裏返し: 粒子は座標の点＋速度ベクトル、雨は落下の直線、霧は密度の等値線
//   - 空担当の flip_aerial は「均一な霧」。ここは「むらのある局所的な霧」と「雨粒の層」を受け持つ
import * as THREE from "three";
import type { Env, QualityTier } from "../core/env";
import type { Lighting } from "../core/lighting";
import type { QualitySettings } from "../core/quality";
import type { Pipeline } from "../core/pipeline";
import { WORLD } from "../core/heightfield";
import { bindEnvUniforms } from "../core/patch";
import { smoothstep } from "../core/noise";
import { Rain } from "./rain";
import { GroundFog } from "./fog";
import { LightningFx } from "./lightning";
import { Particles } from "./particles";

/** 天気モジュールの全マテリアルが共有する uniforms（env.uniforms に加えて配る） */
export type WeatherUniforms = {
  tWxDepth: THREE.IUniform<THREE.Texture | null>;
  uWxResolution: THREE.IUniform<THREE.Vector2>;
  uWxNearFar: THREE.IUniform<THREE.Vector2>;
  uWxPixel: THREE.IUniform<number>;
  uWxFog: THREE.IUniform<THREE.Vector4>;
  uWxFogDrift: THREE.IUniform<THREE.Vector3>;
  uWxLake: THREE.IUniform<number>;
  uWxInvProj: THREE.IUniform<THREE.Matrix4>;
  uWxCamWorld: THREE.IUniform<THREE.Matrix4>;
  uWxCloudBase: THREE.IUniform<number>;
};

export type WeatherCounts = {
  /** 雨の筋の最大本数（嵐で全部、雨で約4割） */
  rain: number;
  /** 着弾のしぶき（カメラ周り半径 6.5m） */
  splash: number;
  /** 地表霧のレイマーチ段数 */
  fogSteps: number;
  /** 昼の花粉・埃 */
  dust: number;
  /** 夜の蛍 */
  fireflies: number;
  /** 風に飛ぶ葉 */
  leaves: number;
};

export const WEATHER_COUNTS: Record<QualityTier, WeatherCounts> = {
  low: { rain: 1500, splash: 120, fogSteps: 6, dust: 220, fireflies: 90, leaves: 16 },
  mid: { rain: 3000, splash: 240, fogSteps: 9, dust: 450, fireflies: 150, leaves: 32 },
  high: { rain: 5000, splash: 400, fogSteps: 16, dust: 900, fireflies: 320, leaves: 44 },
  ultra: { rain: 8000, splash: 620, fogSteps: 20, dust: 1500, fireflies: 400, leaves: 100 },
};

/** 稲妻の上端（雲底）の高さの既定（world y）。空担当が env.lightning.cloudHeight を書き換えれば追従する */
export const CLOUD_BASE_DEFAULT = 700;

export class Weather {
  group = new THREE.Group();
  wx: WeatherUniforms;
  counts: WeatherCounts;
  /** copyDepthRT / 解像度の取り出し元。world.ts から渡されなければ window.__flip から拾う */
  pipeline: Pipeline | null = null;
  /** 負荷計測用: false で天気を全部描かない */
  enabled = true;
  rain: Rain;
  fog: GroundFog;
  lightning: LightningFx;
  particles: Particles;

  constructor(public scene: THREE.Scene, public env: Env, public lighting: Lighting, public q: QualitySettings, pipeline?: Pipeline) {
    this.pipeline = pipeline ?? null;
    this.counts = WEATHER_COUNTS[q.tier];
    this.wx = {
      tWxDepth: { value: null },
      uWxResolution: { value: new THREE.Vector2(1, 1) },
      uWxNearFar: { value: new THREE.Vector2(0.08, 9000) },
      uWxPixel: { value: 0.001 },
      uWxFog: { value: new THREE.Vector4(0, 8, WORLD.lakeLevel + 40, 0) },
      uWxFogDrift: { value: new THREE.Vector3() },
      uWxLake: { value: WORLD.lakeLevel },
      uWxInvProj: { value: new THREE.Matrix4() },
      uWxCamWorld: { value: new THREE.Matrix4() },
      uWxCloudBase: { value: CLOUD_BASE_DEFAULT },
    };
    this.group.name = "weather";
    scene.add(this.group);
    this.fog = new GroundFog(this);
    this.lightning = new LightningFx(this);
    this.rain = new Rain(this);
    this.particles = new Particles(this);
  }

  /** env.uniforms と天気共通 uniforms を同じ参照で流し込む */
  bind(uniforms: Record<string, THREE.IUniform>): Record<string, THREE.IUniform> {
    bindEnvUniforms(uniforms, this.env);
    for (const [k, v] of Object.entries(this.wx)) uniforms[k] = v as THREE.IUniform;
    return uniforms;
  }

  private resolvePipeline(): Pipeline | null {
    if (this.pipeline) return this.pipeline;
    const g = globalThis as unknown as { __flip?: { pipeline?: Pipeline } };
    this.pipeline = g.__flip?.pipeline ?? null;
    return this.pipeline;
  }

  update(dt: number) {
    const env = this.env;
    const wx = this.wx;
    const p = this.resolvePipeline();
    this.group.visible = this.enabled;
    if (p) {
      wx.tWxDepth.value = p.copyDepthRT.texture;
      wx.uWxResolution.value.set(p.width, p.height);
    }
    const cam = env.camera;
    wx.uWxNearFar.value.set(cam.near, cam.far);
    wx.uWxPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, p?.height ?? 900);

    // 地表霧のパラメータ（プリセットの fog を「局所の霧」へ写す。clear 0.22→0, rain 0.6→0.32, storm 0.7→0.51, mist 1→1）
    const w = env.weather;
    const mist = smoothstep(0.3, 1.0, w.fog);
    const dayness = smoothstep(-0.1, 0.25, env.sunDir.y);
    const amount = mist * (0.72 + 0.28 * (1 - dayness)) * (1 - 0.7 * w.rain);
    // 薄い層（スケール高さ 2〜3m）。塊のところは fog.ts 側で最大 2.75 倍まで厚くなる
    const scaleH = 1.8 + 1.2 * mist;
    wx.uWxFog.value.set(amount, scaleH, WORLD.lakeLevel + scaleH * 16, w.rain * 0.00030 * (1 + 1.3 * w.storm));
    // むらの流れ（風で進む。決定的: 時刻だけの関数）
    const drift = env.time * w.wind * 0.35;
    wx.uWxFogDrift.value.set(-w.windDir.x * drift, env.time * 0.15, -w.windDir.y * drift);
    wx.uWxCloudBase.value = env.lightning.cloudHeight || CLOUD_BASE_DEFAULT;

    this.lightning.update(dt);
    this.fog.update();
    this.rain.update();
    this.particles.update();
  }
}
