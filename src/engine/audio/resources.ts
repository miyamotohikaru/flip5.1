// 起動時に一度だけ作る素材。全部 dsp.ts の関数から生える（ファイルは読まない）。
import { cricketPattern, crusherCurve, impulseResponse, normalize01, pinkNoise, rainGrains, shapePow, smoothNoise, softClipCurve, waveEnvelope, whiteNoise, type F32 } from "./dsp";
import { makeBuffer, periodic, type Ctx } from "./graph";
import type { QualityTier } from "../core/env";

/** 制御信号（突風・波の包絡など）のサンプルレート。音ではないので低くてよい */
export const CTL_RATE = 8000;

export type Resources = {
  sr: number;
  tier: QualityTier;
  /** 携帯・低段階: バッファを短く、残響を短く */
  lite: boolean;
  noiseL: AudioBuffer;
  noiseR: AudioBuffer;
  noiseShort: AudioBuffer;
  pink: AudioBuffer;
  rainHiss: AudioBuffer;
  rainLeafA: AudioBuffer;
  rainLeafB: AudioBuffer;
  rainGround: AudioBuffer;
  rainSparse: AudioBuffer;
  rainWater: AudioBuffer;
  ticks: AudioBuffer;
  gravel: AudioBuffer;
  rustleA: AudioBuffer;
  rustleB: AudioBuffer;
  ctlGust: AudioBuffer;
  ctlDrift: AudioBuffer;
  ctlFlutter: AudioBuffer;
  ctlWave: AudioBuffer;
  ctlFoam: AudioBuffer;
  waveSoft: PeriodicWave;
  crusher: F32;
  clip: F32;
  irForest: AudioBuffer;
  irThunder: AudioBuffer;
  cricketPatterns: AudioBuffer[];
  bellPatterns: AudioBuffer[];
};

export function buildResources(ctx: Ctx, tier: QualityTier, isMobile: boolean): Resources {
  const sr = ctx.sampleRate;
  const lite = isMobile || tier === "low";
  const k = lite ? 0.6 : 1;
  const mono = (x: F32, rate = sr) => makeBuffer(ctx, [x], rate);
  const sec = (s: number) => Math.floor(sr * s * k);

  const noiseL = mono(whiteNoise(sec(6), 11));
  const noiseR = mono(whiteNoise(sec(6), 12));
  const noiseShort = mono(whiteNoise(Math.floor(sr * 2), 13));
  const pink = mono(pinkNoise(sec(4), 14));

  const rainHiss = mono(rainGrains(sr, 6 * k, 21, "hiss", 3500));
  const rainLeafA = mono(rainGrains(sr, 8 * k, 22, "leaf", 90));
  const rainLeafB = mono(rainGrains(sr, 7.3 * k, 23, "leaf", 80));
  const rainGround = mono(rainGrains(sr, 8 * k, 24, "ground", 70));
  const rainSparse = mono(rainGrains(sr, 8 * k, 25, "leaf", 11));
  const rainWater = mono(rainGrains(sr, 8 * k, 26, "water", 45));
  const ticks = mono(rainGrains(sr, 4, 27, "tick", 40));
  const gravel = mono(rainGrains(sr, 3, 28, "gravel", 220));
  // 葉のこすれ（風のざわめきの粒。突風で密度が上がったように聞こえる）
  const rustleA = mono(rainGrains(sr, 5 * k, 29, "gravel", 900));
  const rustleB = mono(rainGrains(sr, 4.6 * k, 30, "gravel", 900));

  // 制御信号（8kHz）。突風は「たまに強い」ので尖らせる
  const c = CTL_RATE;
  const ctlGust = mono(shapePow(normalize01(smoothNoise(c * 40, 31, c * 2.6, 3)), 2.2), c);
  const ctlDrift = mono(normalize01(smoothNoise(c * 40, 32, c * 5, 2)), c);
  const ctlFlutter = mono(shapePow(normalize01(smoothNoise(c * 10, 33, Math.floor(c * 0.13), 2)), 1.3), c);
  const ctlWave = mono(waveEnvelope(c * 60, c, 34, 6.5), c);
  const ctlFoam = mono(smoothNoise(c * 10, 35, Math.floor(c * 0.06), 2), c);

  const waveSoft = periodic(ctx, [1, 0.35, 0.12, 0.04]);
  const crusher = crusherCurve(28);
  const clip = softClipCurve(0.85, 0.6);

  const irForest = makeBuffer(ctx, impulseResponse(sr, lite ? 1.0 : 1.6, 41, { decay: lite ? 0.8 : 1.3, lpStart: 9000, lpEnd: 1800, hp: 120, early: 7, predelay: 0.012 }));
  const irThunder = makeBuffer(ctx, impulseResponse(sr, lite ? 2.2 : 3.6, 42, { decay: lite ? 1.4 : 1.9, lpStart: 1400, lpEnd: 220, hp: 28, early: 4, predelay: 0.03 }));

  const cricketPatterns: AudioBuffer[] = [];
  const bellPatterns: AudioBuffer[] = [];
  for (let i = 0; i < 6; i++) cricketPatterns.push(mono(cricketPattern(c, 51 + i, "cricket"), c));
  for (let i = 0; i < 4; i++) bellPatterns.push(mono(cricketPattern(c, 61 + i, "bell"), c));

  return {
    sr, tier, lite,
    noiseL, noiseR, noiseShort, pink,
    rainHiss, rainLeafA, rainLeafB, rainGround, rainSparse, rainWater, ticks, gravel, rustleA, rustleB,
    ctlGust, ctlDrift, ctlFlutter, ctlWave, ctlFoam,
    waveSoft, crusher, clip, irForest, irThunder, cricketPatterns, bellPatterns,
  };
}
