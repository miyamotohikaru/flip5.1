// 実験室のスライダーの定義。**「実際に効くもの」だけを並べる**（効かない飾りは作らない）。
// 各つまみは engine/lab/store.ts の LAB の 1 項目と、実際のコードの 1 行に対応している。
// 式の文面は `formula`。動かす項を 〔…〕 で囲む（UI がそこだけ光らせる。DOM は作り直さない）。
import type { World } from "../world";
import { LAB, LAB_DEFAULTS, type LabKey } from "./store";

export type LabGroup = "terrain" | "sky" | "water" | "veg" | "audio";

export type LabParam = {
  id: LabKey;
  /** URL（?p=…）で使う短い名前 */
  key: string;
  group: LabGroup;
  label: string;
  /** 目盛りの下端（つまみを左いっぱいにしたとき） */
  min: number;
  /** 目盛りの上端 */
  max: number;
  step: number;
  /** 対数目盛り（倍率のつまみ。×0.5 と ×2 が既定から同じ距離になる） */
  log?: boolean;
  /** つまみの目盛りの単位（× の倍率なら "×"、角度なら "°"） */
  unit: string;
  /** 実際に使っている式。動かす項を 〔…〕 で囲む */
  formula: string;
  /** 出典（実際のコード） */
  src: string;
  /** 「いま効いている値」を作る。世界が無ければ null（式だけ出す） */
  live?: (v: number, w: World | null) => string | null;
  /** 変えたら焼き直しが要る */
  rebake?: "terrain" | "trees";
};

export const LAB_GROUPS: { id: LabGroup; label: string }[] = [
  { id: "terrain", label: "地形" },
  { id: "sky", label: "空" },
  { id: "water", label: "水" },
  { id: "veg", label: "木と草" },
  { id: "audio", label: "音" },
];

const f = (v: number, d = 2) => v.toFixed(d);

export const LAB_PARAMS: LabParam[] = [
  // ------------------------------ 地形（焼き直しが要る） ------------------------------
  {
    id: "terrainAmp", key: "terrain.amp", group: "terrain", label: "山脈の高さ", min: 0.3, max: 2.4, step: 0.01, unit: "×", log: true,
    formula: "amp = (320 + 360·n²) · massif(θ) · 〔A〕",
    src: "core/height.ts heightAt() の mtn",
    live: (v, w) => `amp ≈ ${f(680 * v, 0)} m ／ 最高 ${w?.env.heightmap ? f(w.env.heightmap.max, 0) : "…"} m`,
    rebake: "terrain",
  },
  {
    id: "terrainRidge", key: "terrain.ridge", group: "terrain", label: "尾根の鋭さ", min: 0, max: 1.8, step: 0.01, unit: "×",
    formula: "m = round + (sharp − round) · s(x,z) · 〔R〕",
    src: "core/height.ts ridgedBoth() の混ぜ方",
    live: (v) => `s·R = ${f(0.62 * v)} 〜 ${f(Math.min(1.6, 1.0 * v))}（0 = 丸い稜線／1 = 鋭い）`,
    rebake: "terrain",
  },
  {
    id: "terrainErode", key: "terrain.erode", group: "terrain", label: "侵食の強さ", min: 0, max: 4, step: 0.01, unit: "×",
    formula: "Σ aᵢ·nᵢ / (1 + 0.55·〔E〕·|Σ∇nᵢ|²)",
    src: "core/height.ts erodedFbm()",
    live: (v) => `傾きの減衰 k = ${f(0.55 * v, 3)}`,
    rebake: "terrain",
  },

  // ------------------------------ 空（uniform だけで効く） ------------------------------
  {
    id: "skyMie", key: "sky.mie", group: "sky", label: "ミー散乱（もや）", min: 0.15, max: 6, step: 0.01, unit: "×", log: true,
    formula: "σs,Mie = 〔M〕 · 8.0e−3 · e^(−h/2.5) · K(λ)",
    src: "sky/atmosphere.glsl.ts flip_atmoMedium()",
    live: (v) => `σs = ${f(8.0 * v, 2)}e−3 /km`,
  },
  {
    id: "skyRayleigh", key: "sky.rayleigh", group: "sky", label: "レイリー散乱（青）", min: 0.2, max: 4, step: 0.01, unit: "×", log: true,
    formula: "σs,Ray = 〔R〕 · (5.8, 13.6, 33.1)e−3 · e^(−h/8)",
    src: "sky/atmosphere.glsl.ts flip_atmoMedium()",
    live: (v) => `σs = (${f(5.8 * v, 1)}, ${f(13.6 * v, 1)}, ${f(33.1 * v, 1)})e−3 /km`,
  },
  {
    id: "skyOzone", key: "sky.ozone", group: "sky", label: "オゾン層", min: 0, max: 4, step: 0.01, unit: "×",
    formula: "σa,O₃ = 〔O〕 · (0.65, 1.88, 0.09)·1.0e−3 · Λ(h)",
    src: "sky/atmosphere.glsl.ts flip_atmoMedium()",
    live: (v) => `σa = ${f(1.88 * v, 2)}e−3 /km（緑）`,
  },
  {
    id: "skyCloud", key: "sky.cloud", group: "sky", label: "雲量", min: 0, max: 3, step: 0.01, unit: "×",
    formula: "cov = 〔C〕 · (0.16 + cloud^1.05 − 0.20·storm)",
    src: "sky/index.ts uCloudLayer.z",
    live: (v, w) => `cov = ${f((0.16 + Math.pow(w?.env.weather.cloud ?? 0.18, 1.05) - 0.2 * (w?.env.weather.storm ?? 0)) * v)}`,
  },
  {
    id: "skyCloudBase", key: "sky.base", group: "sky", label: "雲の高さ", min: 0.35, max: 2.8, step: 0.01, unit: "×", log: true,
    formula: "base = 〔B〕 · (1900 − 900·storm − 250·rain)",
    src: "sky/index.ts uCloudLayer.x",
    live: (v, w) => `雲底 ${f((1900 - 900 * (w?.env.weather.storm ?? 0) - 250 * (w?.env.weather.rain ?? 0)) * v, 0)} m`,
  },

  // ------------------------------ 水 ------------------------------
  {
    id: "waterWind", key: "water.wind", group: "water", label: "風速", min: 0.15, max: 5, step: 0.01, unit: "×", log: true,
    formula: "Hs = 0.0025 + 0.0042·〔U〕²",
    src: "water/wavesim.ts setWind()",
    live: (v, w) => {
      const U = Math.max((w?.env.weather.wind ?? 2) * v, 0.3);
      return `U = ${f(U, 1)} m/s ／ 波高 Hs = ${f((0.0025 + 0.0042 * U * U) * 100, 1)} cm`;
    },
  },
  {
    id: "waterPeriod", key: "water.period", group: "water", label: "波の周期", min: 0.25, max: 4, step: 0.01, unit: "×", log: true,
    formula: "λp = 〔P〕·(0.35 + 0.062·U²)  ,  T = √(2πλp/g)",
    src: "water/wavesim.ts setWind()",
    live: (v, w) => {
      const U = Math.max((w?.env.weather.wind ?? 2) * LAB.waterWind, 0.3);
      const lp = (0.35 + 0.062 * U * U) * v;
      return `λp = ${f(lp, 2)} m ／ T = ${f(Math.sqrt((2 * Math.PI * lp) / 9.81), 2)} 秒`;
    },
  },
  {
    id: "waterDir", key: "water.dir", group: "water", label: "うねりの向き", min: -180, max: 180, step: 1, unit: "°",
    formula: "S(k) ·= mix(0.03, 1, max(k̂·〔d̂〕, 0)^p)",
    src: "water/wavesim.ts SPECTRUM_FRAG",
    live: (v) => `風向から ${v > 0 ? "+" : ""}${v.toFixed(0)}°`,
  },

  // ------------------------------ 木と草 ------------------------------
  {
    id: "vegGrass", key: "veg.grass", group: "veg", label: "草の密度", min: 0, max: 2.5, step: 0.01, unit: "×",
    formula: "density ·= 〔G〕  ,  生える ⇔ density·fade > hash(cell)",
    src: "vegetation/grass.ts GRASS_PLACE",
    live: (v, w) => `上限 ${((w?.q.grassCount ?? 150000) / 1000).toFixed(0)}k 本 の ${f(Math.min(1, v) * 100, 0)}% まで`,
  },
  {
    id: "vegTree", key: "veg.tree", group: "veg", label: "木の密度", min: 0, max: 2.5, step: 0.02, unit: "×",
    formula: "生える ⇔ hash(i,j) < 〔T〕 · forest(x,z,h,nᵧ)",
    src: "vegetation/placement.ts scatterTrees()",
    live: (_v, w) => `いま ${(w?.vegetation?.trees?.stats.trees ?? 0).toLocaleString("ja-JP")} 本`,
    rebake: "trees",
  },

  // ------------------------------ 音 ------------------------------
  {
    id: "audioGust", key: "audio.gust", group: "audio", label: "突風の変調の深さ", min: 0, max: 4, step: 0.01, unit: "×",
    formula: "g(t) = base + 〔D〕 · depth · gust(t)",
    src: "audio/wind.ts tick()（各帯の変調量）",
    live: (v) => `変調量 ×${f(v)}（0 で一定の「ゴー」、3 で息づく）`,
  },
  {
    id: "audioBand", key: "audio.band", group: "audio", label: "ざわめきの帯", min: 0.25, max: 4, step: 0.01, unit: "×", log: true,
    formula: "f_rustle = 〔F〕 · (1000 + 1200·w)",
    src: "audio/wind.ts tick()（bandpass の中心周波数）",
    live: (v, w) => {
      const ww = Math.min(1.25, (w?.env.weather.wind ?? 2) / 8);
      return `中心 ${f((1000 + 1200 * ww) * v, 0)} Hz`;
    },
  },
  {
    id: "audioRain", key: "audio.rain", group: "audio", label: "雨粒の密度", min: 0.25, max: 4, step: 0.01, unit: "×", log: true,
    formula: "粒/秒 = 〔ρ〕 · N / T   （N 粒の列を速さ ρ で回す）",
    src: "audio/rain.ts（rainGrains の列の再生速度）",
    live: (v) => `芯 ${f(3500 * v, 0)} 粒/秒 ／ 葉 ${f(90 * v, 0)} 粒/秒`,
  },
];

export const LAB_BY_ID = new Map<LabKey, LabParam>(LAB_PARAMS.map((p) => [p.id, p]));
const BY_KEY = new Map<string, LabParam>(LAB_PARAMS.map((p) => [p.key, p]));

// ---------------------------------------------------------------------------
// つまみの位置 ↔ 値。**既定値をいつも真ん中（0.5）に置く。**
// これが無いと「全部 ×1.00 なのにハンドルの位置がばらばら」＝バグに見える。
// 倍率のつまみ（log: true）は対数目盛り: ×0.5 と ×2 が既定から同じ距離になる。

function side(a: number, b: number, u: number, log: boolean): number {
  if (log && a > 0 && b > 0) return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u);
  return a + (b - a) * u;
}
function invSide(a: number, b: number, v: number, log: boolean): number {
  if (log && a > 0 && b > 0) return (Math.log(v) - Math.log(a)) / (Math.log(b) - Math.log(a));
  return (v - a) / (b - a);
}

/** つまみの位置 0..1 → 値 */
export function posToValue(p: LabParam, t: number): number {
  const d = LAB_DEFAULTS[p.id] as number;
  const v = t <= 0.5 ? side(p.min, d, t * 2, !!p.log) : side(d, p.max, (t - 0.5) * 2, !!p.log);
  const q = Math.round(v / p.step) * p.step;
  return Math.min(p.max, Math.max(p.min, Number(q.toFixed(4))));
}

/** 値 → つまみの位置 0..1（既定値はぴったり 0.5） */
export function valueToPos(p: LabParam, v: number): number {
  const d = LAB_DEFAULTS[p.id] as number;
  if (v === d) return 0.5;
  const t = v < d ? 0.5 * invSide(p.min, d, v, !!p.log) : 0.5 + 0.5 * invSide(d, p.max, v, !!p.log);
  return Math.min(1, Math.max(0, t));
}

/** 式を「前 / 光らせる項 / 後ろ」に割る（〔…〕で囲んだところ）。描くのは 1 回きり */
export function splitFormula(formula: string): [string, string, string] {
  const a = formula.indexOf("〔"), b = formula.indexOf("〕");
  if (a < 0 || b < a) return [formula, "", ""];
  return [formula.slice(0, a), formula.slice(a + 1, b), formula.slice(b + 1)];
}

// ---------------------------------------------------------------------------
// URL（?p=terrain.amp:1.4,sky.mie:2）

/** 既定から動いているつまみだけを短く並べる。何も動いていなければ "" */
export function encodeLabParams(): string {
  const out: string[] = [];
  for (const p of LAB_PARAMS) {
    const v = LAB[p.id];
    if (v === LAB_DEFAULTS[p.id]) continue;
    out.push(`${p.key}:${Number(v.toFixed(3))}`);
  }
  return out.join(",");
}

/** ?p=… を LAB に流し込む。知らない名前・範囲外は黙って捨てる */
export function decodeLabParams(s: string | null | undefined): boolean {
  if (!s) return false;
  let any = false;
  for (const kv of s.split(",")) {
    const i = kv.indexOf(":");
    if (i <= 0) continue;
    const p = BY_KEY.get(kv.slice(0, i).trim());
    if (!p) continue;
    const v = Number(kv.slice(i + 1));
    if (!Number.isFinite(v)) continue;
    LAB[p.id] = Math.min(p.max, Math.max(p.min, v));
    any = true;
  }
  return any;
}

/** 読み込み時に URL から読む（World を作る前に呼ぶ） */
export function readLabParamsFromLocation(): boolean {
  if (typeof location === "undefined") return false;
  try {
    return decodeLabParams(new URLSearchParams(location.search).get("p"));
  } catch {
    return false;
  }
}

/** 全部を既定へ */
export function resetLabParams() {
  for (const p of LAB_PARAMS) LAB[p.id] = LAB_DEFAULTS[p.id];
}
