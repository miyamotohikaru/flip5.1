// 生態の推定。植生モジュールが未実装なので、docs/ARCHITECTURE.md の標高の目安
// （湖 0 / 岸の草地 1〜10 / 針葉樹の斜面 10〜400 / 岩 300〜 / 雪 450〜）から
// 「草地らしさ」「森らしさ」「岩らしさ」を 0..1 で出す。鳥の種・虫の量・風のざわめきがこれを見る。
// 統合時に植生担当が密度関数を用意したら、ここを差し替えるだけでよい。
import { smooth } from "./dsp";

export type Biome = { grass: number; forest: number; rock: number };

export function biomeAt(h: number): Biome {
  return {
    grass: smooth(-1.5, 1.5, h) * (1 - smooth(8, 25, h)),
    forest: smooth(8, 20, h) * (1 - smooth(280, 400, h)),
    rock: smooth(220, 340, h),
  };
}
