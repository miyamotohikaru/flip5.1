// 実験室のつまみの値だけを持つ小さな箱。**three も DOM も import しない**（どのモジュールからでも読める）。
// 値はどれも「既定＝1（または 0）」の倍率。既定のままなら世界の見た目は今のまま。
// 定義（ラベル・範囲・対応する式）は engine/lab/params.ts、焼き直しは engine/lab/rebuild.ts。

export const LAB = {
  // ---- 地形（変えたらハイトマップを焼き直す）----
  /** 山脈の高さ（amp の倍率） */
  terrainAmp: 1,
  /** 尾根の鋭さ（sharp と round の混ぜ方の倍率） */
  terrainRidge: 1,
  /** 侵食の強さ（傾き減衰の倍率） */
  terrainErode: 1,
  // ---- 空 ----
  /** ミー散乱 σs の倍率（基準 3.2e-3 /km） */
  skyMie: 1,
  /** レイリー散乱 σs の倍率（基準 (5.802, 13.558, 33.1)e-3 /km） */
  skyRayleigh: 1,
  /** オゾン吸収の倍率 */
  skyOzone: 1,
  /** 雲量の倍率（天気で決まる被覆率に掛かる） */
  skyCloud: 1,
  /** 雲底の高さの倍率（基準 1900m） */
  skyCloudBase: 1,
  // ---- 水 ----
  /** 風速の倍率（波のスペクトルへ入る U） */
  waterWind: 1,
  /** ピーク波長 λp の倍率（周期 T = √(2πλ/g) が変わる） */
  waterPeriod: 1,
  /** うねりの向きのずれ（度） */
  waterDir: 0,
  // ---- 植生 ----
  /** 草の密度の倍率（GPU の間引きしきい値） */
  vegGrass: 1,
  /** 木の密度の倍率（林の密度 p の倍率。変えたら並べ直す） */
  vegTree: 1,
  // ---- 音 ----
  /** 突風の変調の深さ（風の各帯に掛かる変調量） */
  audioGust: 1,
  /** 風のざわめきの帯（中心周波数）の倍率 */
  audioBand: 1,
  /** 雨粒の密度の倍率（粒の列の再生速度＝粒/秒） */
  audioRain: 1,
};

export type LabKey = keyof typeof LAB;
export type LabValues = typeof LAB;

/** 既定値（「戻す」で戻る先） */
export const LAB_DEFAULTS: Readonly<LabValues> = { ...LAB };

/** 既定から動いているつまみがあるか */
export function labDirty(): boolean {
  for (const k of Object.keys(LAB) as LabKey[]) if (LAB[k] !== LAB_DEFAULTS[k]) return true;
  return false;
}
