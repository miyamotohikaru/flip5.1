// 音モジュールの型。Env の「音が読む部分」だけを構造的に切り出す（OfflineAudioContext での検証でも同じ形を渡す）。
import type * as THREE from "three";
import type { QualityTier } from "../core/env";

/**
 * 天気担当が env に足す予定の稲光。存在すれば使う／無ければ動く。
 * 想定する形: env.lightning = { flash, lastStrikeTime, position }
 *  - flash: 閃光の強さ 0..1（0.25 以下 → 0.5 以上へ跳ね上がった瞬間を落雷とみなす）
 *  - lastStrikeTime: 最後の落雷の env.time（秒）。値が変わった瞬間を落雷とみなす（flash より優先）
 *  - position: 落雷のワールド座標（m）。無ければハッシュで 0.5〜4 秒の遅延（＝170〜1360m 相当）
 */
export type LightningLike = {
  flash?: number;
  lastStrikeTime?: number;
  position?: { x: number; y?: number; z: number } | null;
};

export interface AudioEnv {
  time: number;
  hour: number;
  weather: {
    wind: number;
    rain: number;
    storm: number;
    cloud: number;
    fog: number;
    wetness: number;
    /** 天気担当が足す予定の突風 0..1（無ければ自前の変調だけで動く） */
    gust?: number;
  };
  flip: number;
  flipTarget: number;
  flipRadius: number;
  cameraPos: { x: number; y: number; z: number };
  camera: { getWorldDirection(target: THREE.Vector3): THREE.Vector3 };
  tier: QualityTier;
  isMobile: boolean;
  lightning?: LightningLike;
}

export type Surface = "grass" | "rock" | "sand" | "water";

export type LayerName = "wind" | "rain" | "thunder" | "water" | "foot" | "birds" | "insects" | "pad" | "ui";
export const LAYER_NAMES: readonly LayerName[] = ["wind", "rain", "thunder", "water", "foot", "birds", "insects", "pad", "ui"];

/** 1 tick（20Hz）ごとに mixer が組み立てる「いま聞こえるべき状況」 */
export type Scene = {
  /** ctx.currentTime */
  t: number;
  hour: number;
  /** 風 0..1（m/s ÷ 12） */
  wind: number;
  /** 外部の突風 0..1（hasGust が false なら 0） */
  gust: number;
  hasGust: boolean;
  rain: number;
  storm: number;
  cloud: number;
  fog: number;
  wetness: number;
  /** 岸線からの距離 m（負は水の中） */
  shoreDist: number;
  /** 水辺らしさ 0..1 */
  shoreFactor: number;
  /** 地面の高さ m */
  altitude: number;
  grass: number;
  forest: number;
  rock: number;
  /** 歩く速さ m/s */
  speed: number;
  flip: number;
  flipRadius: number;
  pos: { x: number; y: number; z: number };
  fwd: { x: number; z: number };
  right: { x: number; z: number };
  /** 湖の中心の方向（-1 左 … 1 右）と、正面らしさ（1 正面 … -1 背中） */
  lakePan: number;
  lakeFront: number;
  day: number;
  night: number;
  dawn: number;
  dusk: number;
};
