// 音の全体。層（風・雨・雷・波・足音・鳥・虫・パッド・UI）を束ね、裏返しのローファイ、コンプ／リミッタ／ソフトクリップ。
// AudioContext でも OfflineAudioContext でも同じように動く（probe.ts が数値検証に使う）。
//
// メインスレッドの仕事は update() だけ。毎フレームは「速さの推定」と「稲光の検知」のみ、
// 20Hz の tick で状況（Scene）を組み立てて各層に setTargetAtTime を投げる。合成は全部 AudioNode に任せる。
import * as THREE from "three";
import type { QualityTier } from "../core/env";
import { heightAt, shoreRadius } from "../core/heightfield";
import { PadLayer } from "./ambient";
import { BirdLayer } from "./birds";
import { smooth } from "./dsp";
import { FootstepLayer } from "./footsteps";
import { biquad, gainNode, setT, type Ctx } from "./graph";
import { InsectLayer } from "./insects";
import { RainLayer } from "./rain";
import { buildResources, type Resources } from "./resources";
import { ThunderLayer } from "./thunder";
import { FlipVoice, playEnter, playShutter } from "./ui";
import { LAYER_NAMES, type AudioEnv, type LayerName, type Scene, type Surface } from "./types";
import { WaterLayer } from "./water";
import { WindLayer } from "./wind";

export type MixerOpts = {
  tier: QualityTier;
  isMobile: boolean;
  /** tick の間隔（秒）。0 で毎 update */
  tickInterval?: number;
};

/** マスターの基準（＋2dB）。静かな晴れの昼で −26dBFS、嵐で −11dBFS 前後になる */
const MASTER_LEVEL = 1.25;

/** 層ごとの基準音量 */
const TRIM: Record<LayerName, number> = {
  wind: 1.0,
  rain: 0.9,
  thunder: 1.0,
  water: 1.4,
  foot: 0.7,
  birds: 0.75,
  insects: 0.32,
  pad: 0.03,
  ui: 0.8,
};

export class Mixer {
  res: Resources;
  master: GainNode;
  analyser: AnalyserNode;
  private envBus: GainNode;
  private lofiLP: BiquadFilterNode;
  private crushDry: GainNode;
  private crushWet: GainNode;
  private musicBus: GainNode;
  private uiBus: GainNode;
  private uiMute: GainNode;
  private trims: Record<LayerName, GainNode>;
  private solo: LayerName | null = null;
  muted = false;
  wind: WindLayer;
  rain: RainLayer;
  thunder: ThunderLayer;
  water: WaterLayer;
  foot: FootstepLayer;
  birds: BirdLayer;
  insects: InsectLayer;
  pad: PadLayer;
  private flipVoice: FlipVoice | null = null;
  private flipDir: 1 | -1 = 1;
  private tickInterval: number;
  private lastTick = -1;
  private lastX = 0;
  private lastZ = 0;
  private hasPos = false;
  speed = 0;
  scene: Scene | null = null;
  ticks = 0;
  private tmpDir = new THREE.Vector3();

  constructor(public ctx: Ctx, public env: AudioEnv, opts: MixerOpts) {
    this.tickInterval = opts.tickInterval ?? 1 / 20;
    this.res = buildResources(ctx, opts.tier, opts.isMobile);
    const res = this.res;

    // マスター: envSum → comp → limiter → clip → master → analyser → destination
    // ゆるい糊（突風や足音で環境音がポンピングしないよう浅く）と、速いリミッタ
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 12;
    comp.ratio.value = 1.6;
    comp.attack.value = 0.015;
    comp.release.value = 0.5;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    const clip = ctx.createWaveShaper();
    clip.curve = res.clip;
    clip.oversample = "2x";
    // master（音量・ミュート・フェード）は圧縮の前。最後のソフトクリップが天井（−1.4dBFS）を守る
    this.master = gainNode(ctx, 0);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    this.master.connect(comp);
    comp.connect(limiter);
    limiter.connect(clip);
    clip.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // 環境音バス → 裏返しのローファイ（LP ＋ 階段の歪み）→ master
    this.envBus = gainNode(ctx, 1);
    this.lofiLP = biquad(ctx, "lowpass", 20000, 0.5);
    this.crushDry = gainNode(ctx, 1);
    this.crushWet = gainNode(ctx, 0);
    const crusher = ctx.createWaveShaper();
    crusher.curve = res.crusher;
    this.envBus.connect(this.lofiLP);
    this.lofiLP.connect(this.crushDry);
    this.lofiLP.connect(crusher);
    crusher.connect(this.crushWet);
    this.crushDry.connect(this.master);
    this.crushWet.connect(this.master);
    this.musicBus = gainNode(ctx, 1);
    this.musicBus.connect(this.master);
    // UI は糊を通さず、リミッタの手前へ
    this.uiBus = gainNode(ctx, 1);
    const uiLevel = gainNode(ctx, MASTER_LEVEL);
    this.uiBus.connect(uiLevel);
    uiLevel.connect(limiter);
    this.uiMute = uiLevel;

    const trims = {} as Record<LayerName, GainNode>;
    for (const name of LAYER_NAMES) {
      const g = gainNode(ctx, TRIM[name]);
      g.connect(name === "pad" ? this.musicBus : name === "ui" ? this.uiBus : this.envBus);
      trims[name] = g;
    }
    this.trims = trims;

    const insectCount = opts.isMobile || opts.tier === "low" ? 4 : opts.tier === "mid" ? 6 : 10;
    this.wind = new WindLayer(ctx, trims.wind, res);
    this.rain = new RainLayer(ctx, trims.rain, res);
    this.thunder = new ThunderLayer(ctx, trims.thunder, res);
    this.water = new WaterLayer(ctx, trims.water, res);
    this.foot = new FootstepLayer(ctx, trims.foot, res);
    this.birds = new BirdLayer(ctx, trims.birds, res);
    this.insects = new InsectLayer(ctx, trims.insects, res, insectCount);
    this.pad = new PadLayer(ctx, trims.pad, res);
    // 開幕は 1 tick ぶん先に状況を反映しておく（静かな状態から始めない）
    this.tick(ctx.currentTime);
  }

  /** 入場: マスターをゆっくり上げて「ふわっ」 */
  enter(withSound: boolean, fade = 2.5) {
    const t = this.ctx.currentTime;
    if (!this.muted) {
      if (fade <= 0) this.master.gain.setValueAtTime(MASTER_LEVEL, t);
      else this.master.gain.setTargetAtTime(MASTER_LEVEL, t, fade / 3);
    }
    if (withSound) playEnter(this.ctx, this.trims.ui, this.res, t + 0.05);
  }

  setMuted(m: boolean) {
    this.muted = m;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(m ? 0 : MASTER_LEVEL, t, 0.05);
    this.uiMute.gain.setTargetAtTime(m ? 0 : MASTER_LEVEL, t, 0.05);
  }

  /** 隠れたときに素早く絞る（suspend の前に） */
  duck(on: boolean) {
    if (this.muted) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(on ? 0 : MASTER_LEVEL, t, 0.04);
    this.uiMute.gain.setTargetAtTime(on ? 0 : MASTER_LEVEL, t, 0.04);
  }

  /** 検証用: 1 層だけ鳴らす */
  setSolo(name: LayerName | null) {
    this.solo = name;
    const t = this.ctx.currentTime;
    for (const n of LAYER_NAMES) this.trims[n].gain.setValueAtTime(name === null || name === n ? TRIM[n] : 0, t);
  }

  footstep(surface: Surface) {
    this.foot.step(surface, this.speed / 3.4, this.ctx.currentTime);
  }

  shutter() {
    playShutter(this.ctx, this.trims.ui, this.res, this.ctx.currentTime + 0.01);
  }

  flipWave(on: boolean) {
    this.flipDir = on ? 1 : -1;
    if (!this.flipVoice) this.flipVoice = new FlipVoice(this.ctx, this.trims.ui, this.res, this.ctx.currentTime);
  }

  update(dt: number) {
    const env = this.env;
    const now = this.ctx.currentTime;
    const p = env.cameraPos;
    if (dt > 0 && this.hasPos) {
      const v = Math.hypot(p.x - this.lastX, p.z - this.lastZ) / dt;
      if (v < 25) this.speed += (v - this.speed) * (1 - Math.exp(-dt * 5));
    }
    this.lastX = p.x;
    this.lastZ = p.z;
    this.hasPos = true;
    this.thunder.detect(env, now);
    if (now - this.lastTick < this.tickInterval) return;
    this.lastTick = now;
    this.tick(now);
  }

  private buildScene(t: number): Scene {
    const env = this.env, w = env.weather, p = env.cameraPos;
    const h = heightAt(p.x, p.z);
    const sd = Math.hypot(p.x, p.z) - shoreRadius(p.x, p.z);
    const hour = ((env.hour % 24) + 24) % 24;
    const day = smooth(5.2, 7.2, hour) * (1 - smooth(17.2, 19.3, hour));
    const g = w.gust;
    const hasGust = typeof g === "number" && Number.isFinite(g);
    const dir = env.camera.getWorldDirection(this.tmpDir);
    let fx = dir.x, fz = dir.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const rx = -fz, rz = fx; // 右手（Y up、yaw=0 で −Z を向く → 右は +X）
    const dl = Math.hypot(p.x, p.z) || 1;
    const lx = -p.x / dl, lz = -p.z / dl;
    // 風が吹いてくる側: windDir は「風の向かう向き」なので、風上は −windDir
    const wd = w.windDir;
    const windPan = wd && Number.isFinite(wd.x) && Number.isFinite(wd.y) ? -(wd.x * rx + wd.y * rz) : 0;
    return {
      t,
      hour,
      wind: Math.min(1, Math.max(0, w.wind / 12)),
      gust: hasGust ? Math.min(1, Math.max(0, (g as number) > 1.5 ? (g as number) / 12 : (g as number))) : 0,
      hasGust,
      rain: Math.min(1, Math.max(0, w.rain)),
      storm: Math.min(1, Math.max(0, w.storm)),
      cloud: w.cloud,
      fog: w.fog,
      wetness: w.wetness,
      shoreDist: sd,
      shoreFactor: sd <= 0 ? 1 : Math.exp(-sd / 30),
      altitude: h,
      grass: smooth(-1.5, 1.5, h) * (1 - smooth(70, 180, h)),
      forest: smooth(9, 45, h) * (1 - smooth(300, 430, h)),
      rock: smooth(260, 420, h),
      speed: this.speed,
      flip: env.flip,
      flipRadius: env.flipRadius,
      pos: { x: p.x, y: p.y, z: p.z },
      fwd: { x: fx, z: fz },
      right: { x: rx, z: rz },
      lakePan: lx * rx + lz * rz,
      lakeFront: lx * fx + lz * fz,
      windPan,
      day,
      night: 1 - day,
      dawn: smooth(4.3, 5.5, hour) * (1 - smooth(7, 8.5, hour)),
      dusk: smooth(16.5, 17.5, hour) * (1 - smooth(19, 20, hour)),
    };
  }

  private tick(now: number) {
    this.ticks++;
    const s = (this.scene = this.buildScene(now));
    const env = this.env;
    this.wind.tick(s);
    this.rain.tick(s);
    this.thunder.tick(s, env);
    this.water.tick(s);
    this.birds.tick(s);
    this.insects.tick(s);
    this.pad.tick(s);
    // 裏返し
    const flip = Math.min(1, Math.max(0, env.flip));
    setT(this.lofiLP.frequency, 20000 * Math.pow(1900 / 20000, flip), now, 0.1);
    setT(this.crushWet.gain, 0.45 * flip, now, 0.1);
    setT(this.crushDry.gain, 1 - 0.45 * flip, now, 0.1);
    if (this.flipVoice) {
      const p = Math.min(1, Math.max(0, env.flipRadius / 6000));
      const dir = env.flipTarget > 0.5 ? 1 : -1;
      this.flipDir = dir;
      const complete = dir > 0 && p >= 0.999;
      this.flipVoice.update(p, dir, flip, now, complete);
      if (dir < 0 && p <= 0.001) {
        this.flipVoice.stop(now);
        this.flipVoice = null;
      }
    }
  }

  /** いまの出力の RMS（dBFS）。実時間の確認用 */
  level(): number {
    const a = this.analyser;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const rms = Math.sqrt(s / buf.length);
    return rms > 1e-9 ? 20 * Math.log10(rms) : -180;
  }

  dispose() {
    try {
      this.master.disconnect();
    } catch {
      /* 既に切れている */
    }
  }
}
