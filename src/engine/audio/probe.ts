// 数値検証。OfflineAudioContext で Mixer をそのまま走らせ、RMS・ピーク・帯域配分などを返す。
// ヘッドレスでは音が聞けないので、tools/audio-probe.mjs がこれを puppeteer から叩く。
// 実装は本番と同じ（同じ Mixer・同じ層）。時刻・天気・位置・イベント（足音・落雷・裏返し）を指定できる。
import * as THREE from "three";
import { WEATHER_PRESETS, type QualityTier, type WeatherPresetName } from "../core/env";
import { analyze, type Analysis } from "./dsp";
import { Mixer } from "./mixer";
import type { AudioEnv, LayerName, LightningLike, Surface } from "./types";

export type ProbeEvent =
  | { t: number; type: "step"; surface: Surface; speed?: number }
  | { t: number; type: "strike"; distance: number }
  | { t: number; type: "flip"; on: boolean }
  | { t: number; type: "shutter" }
  | { t: number; type: "weather"; name: WeatherPresetName }
  | { t: number; type: "hour"; hour: number };

export type ProbeConfig = {
  hour: number;
  weather: WeatherPresetName;
  /** x, z（y は地面＋目線相当。音には効かない） */
  pos?: [number, number];
  /** 度。0 で −Z を向く */
  yaw?: number;
  seconds?: number;
  sampleRate?: number;
  solo?: LayerName | null;
  events?: ProbeEvent[];
  /** 解析から外す先頭の秒数 */
  skip?: number;
  segments?: { t0: number; t1: number }[];
  tier?: QualityTier;
  enter?: boolean;
  /** 開始時から裏返し済み */
  flip?: boolean;
  /** 開始時から突風を与える（天気担当の gust を模す） */
  gust?: number;
  /** 濡れ 0..1 を上書き（雨上がりの雫の確認用） */
  wetness?: number;
};

export type ProbeResult = Analysis & {
  seconds: number;
  sampleRate: number;
  segments?: ({ t0: number; t1: number } & Analysis)[];
  birdCalls: number;
  lastBird: string | null;
  lastStrike: { at: number; distance: number; delay: number } | null;
  insectLevel: number;
  frogs: number;
  drips: number;
  ticks: number;
};

class FakeEnv implements AudioEnv {
  time = 0;
  hour: number;
  weather: AudioEnv["weather"];
  flip = 0;
  flipTarget = 0;
  flipRadius = 0;
  cameraPos: { x: number; y: number; z: number };
  camera: AudioEnv["camera"];
  tier: QualityTier;
  isMobile = false;
  lightning?: LightningLike;
  private yaw: number;

  constructor(cfg: ProbeConfig) {
    this.hour = cfg.hour;
    this.weather = { ...WEATHER_PRESETS[cfg.weather], wetness: WEATHER_PRESETS[cfg.weather].rain > 0 ? 1 : 0, windDir: { x: 0.9701, y: 0.2425 } };
    if (cfg.gust !== undefined) this.weather.gust = cfg.gust;
    if (cfg.wetness !== undefined) this.weather.wetness = cfg.wetness;
    const [x, z] = cfg.pos ?? [0, 360];
    this.cameraPos = { x, y: 1.7, z };
    this.yaw = THREE.MathUtils.degToRad(cfg.yaw ?? 0);
    const yaw = this.yaw;
    this.camera = {
      getWorldDirection(v: THREE.Vector3) {
        return v.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
      },
    };
    this.tier = cfg.tier ?? "high";
    if (cfg.flip) {
      this.flip = 1;
      this.flipTarget = 1;
      this.flipRadius = 6000;
    }
  }

  setWeather(name: WeatherPresetName) {
    this.weather = { ...this.weather, ...WEATHER_PRESETS[name] };
  }

  /** Env.update と同じ裏返しの進み方 */
  tick(dt: number, t: number) {
    this.time = t;
    const fk = 1 - Math.exp(-dt * 3.5);
    this.flip += (this.flipTarget - this.flip) * fk;
    const target = this.flipTarget > 0.5 ? 6000 : 0;
    const speed = 900;
    if (this.flipRadius < target) this.flipRadius = Math.min(target, this.flipRadius + speed * dt);
    else if (this.flipRadius > target) this.flipRadius = Math.max(target, this.flipRadius - speed * 1.6 * dt);
  }

  /** 正面 distance[m] の位置に落雷 */
  strike(distance: number) {
    const v = this.camera.getWorldDirection(new THREE.Vector3());
    this.lightning = { flash: 1, lastStrikeTime: this.time, position: { x: this.cameraPos.x + v.x * distance, y: 300, z: this.cameraPos.z + v.z * distance } };
  }
}

export async function renderOffline(cfg: ProbeConfig): Promise<ProbeResult> {
  const sr = cfg.sampleRate ?? 48000;
  const seconds = cfg.seconds ?? 8;
  const n = Math.ceil(sr * seconds);
  const ctx = new OfflineAudioContext(2, n, sr);
  const env = new FakeEnv(cfg);
  const mixer = new Mixer(ctx, env, { tier: cfg.tier ?? "high", isMobile: false, tickInterval: 0 });
  mixer.setSolo(cfg.solo ?? null);
  mixer.enter(cfg.enter ?? false, 0);
  const events = cfg.events ?? [];
  const step = 1 / 30;
  const pending: Promise<void>[] = [];
  const done = new Set<ProbeEvent>();
  for (let k = 1; k * step < seconds - step * 0.5; k++) {
    const tt = k * step;
    pending.push(
      ctx.suspend(tt).then(() => {
        env.tick(step, tt);
        for (const e of events) {
          if (done.has(e) || e.t > tt) continue;
          done.add(e);
          switch (e.type) {
            case "step":
              mixer.speed = (e.speed ?? 1) * 3.4;
              mixer.footstep(e.surface);
              break;
            case "strike":
              env.strike(e.distance);
              break;
            case "flip":
              env.flipTarget = e.on ? 1 : 0;
              mixer.flipWave(e.on);
              break;
            case "shutter":
              mixer.shutter();
              break;
            case "weather":
              env.setWeather(e.name);
              break;
            case "hour":
              env.hour = e.hour;
              break;
          }
        }
        mixer.update(step);
        void ctx.resume();
      }),
    );
  }
  const buf = await ctx.startRendering();
  await Promise.all(pending);
  const chs = [buf.getChannelData(0), buf.getChannelData(1)];
  const out: ProbeResult = {
    ...analyze(chs, sr, { skip: cfg.skip ?? 0.5 }),
    seconds,
    sampleRate: sr,
    birdCalls: mixer.birds.calls,
    lastBird: mixer.birds.lastCall?.species ?? null,
    lastStrike: mixer.thunder.lastStrike,
    insectLevel: mixer.insects.level,
    frogs: mixer.insects.frogs,
    drips: mixer.rain.drips,
    ticks: mixer.ticks,
  };
  if (cfg.segments) {
    out.segments = cfg.segments.map(({ t0, t1 }) => {
      const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(n, Math.floor(t1 * sr));
      return { t0, t1, ...analyze(chs.map((c) => c.slice(a, b)), sr) };
    });
  }
  return out;
}
