// 世界のシード。**この作品の全部の乱数は、ここのひとつの数から生える。**
//   地形の置換表 / 角度の表 → core/height.ts
//   共通ノイズの置換表 ・ 配置のハッシュ → core/noise.ts
//   空（雲の天気マップ）/ 水（波のスペクトル）/ 音（層ごとの乱数）→ 各モジュールが subSeed() を引く
//
// three も DOM も import しない（controls/bake.worker.ts から読むため）。
// URL の ?seed=12345 を**モジュールの読み込み時**に読む。
// （core/params.ts が module scope で startPosition() を呼ぶので、そこより先に決まっていないといけない）

/** 種を配る先 */
export type SeedKey =
  /** 地形の高さ関数（置換表・角度の表） */
  | "terrain"
  /** 共通のグラディエントノイズ（植生マップ・岸線） */
  | "noise"
  /** 配置のハッシュ（木・岩・草の格子ジッタ、樹形、岩の形） */
  | "place"
  /** 空（雲の天気マップ） */
  | "sky"
  /** 水（波のスペクトルのガウス乱数） */
  | "water"
  /** 音（各層の乱数列） */
  | "audio";

/**
 * 既定のシード。この番号のときだけ、置換表の種は「作りながら手で選んだ数」を使う。
 * 上4桁 2027 が地形、下4桁 1337 が共通ノイズ ―― この2つが、いま見えている谷の形を決めている。
 * ほかの番号を入れると、下の subSeed() が全部の種をその数ひとつから導く（＝丸ごと別の谷）。
 */
export const DEFAULT_SEED = 20271337;

/** 既定のシードのときに配る値（＝これまでコードに散らばっていた固定の数） */
const SHIPPED: Record<SeedKey, number> = {
  terrain: 2027,
  noise: 1337,
  place: 0,
  sky: 0,
  water: 0,
  audio: 0,
};

/** 用途ごとの塩。同じシードから違う種を作るための定数（意味は無い。混ぜるためだけ） */
const SALT: Record<SeedKey, number> = {
  terrain: 0x9e3779b1,
  noise: 0x85ebca77,
  place: 0xc2b2ae3d,
  sky: 0x27d4eb2f,
  water: 0x165667b1,
  audio: 0xd3a2646c,
};

/** 32bit の混ぜ合わせ（murmur3 の finalizer）。決定的・Math.random は使わない */
export function mix32(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** シードとして受け付ける形にそろえる（0 以上 2^31 未満の整数） */
export function normalizeSeed(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SEED;
  const v = Math.floor(Math.abs(n)) % 2147483647;
  return v === 0 ? DEFAULT_SEED : v;
}

function fromLocation(): number {
  if (typeof location === "undefined") return DEFAULT_SEED;
  try {
    const v = new URLSearchParams(location.search).get("seed");
    if (v === null || v === "") return DEFAULT_SEED;
    return normalizeSeed(Number(v));
  } catch {
    return DEFAULT_SEED;
  }
}

let current = fromLocation();
const rebuilders: (() => void)[] = [];

/** 今のシード */
export function getSeed(): number {
  return current;
}

/** 既定のシード（＝作品の顔になった谷）かどうか */
export function isDefaultSeed(): boolean {
  return current === DEFAULT_SEED;
}

/**
 * シードを変える。登録された「表の作り直し」を全部呼ぶ（置換表・角度の表）。
 * ハイトマップ・植生・空の天気マップの焼き直しは呼び出し側（engine/lab/rebuild.ts）が行う。
 */
export function setSeed(n: number): number {
  const v = normalizeSeed(n);
  if (v === current) return current;
  current = v;
  for (const fn of rebuilders) fn();
  return current;
}

/** 表の作り直しを登録する（登録した時点で一度呼ばれる）。noise.ts / height.ts が使う */
export function onSeed(fn: () => void) {
  rebuilders.push(fn);
  fn();
}

/** 用途ごとの種。既定のシードなら、作りながら選んだ数をそのまま返す */
export function subSeed(key: SeedKey): number {
  return current === DEFAULT_SEED ? SHIPPED[key] : mix32(current, SALT[key]);
}

/** 用途ごとの 0..1 の乱数（i で何個でも） */
export function subFloat(key: SeedKey, i = 0): number {
  return mix32(subSeed(key) ^ 0x5bf03635, i * 0x9e3779b1 + 1) / 4294967296;
}

/**
 * 用途ごとの「振れ幅つきの値」。**既定のシードでは neutral**（＝今の見た目のまま）を返し、
 * ほかのシードでは lo..hi の決定的な値になる。
 * 「この世界は湖が広い」「この世界は山が近い」を、種ひとつから決めるための道具。
 */
export function seedPick(key: SeedKey, i: number, lo: number, hi: number, neutral = 1): number {
  if (current === DEFAULT_SEED) return neutral;
  return lo + (hi - lo) * subFloat(key, i + 1000);
}

/**
 * 用途ごとの「ノイズ座標のずらし量」。**既定のシードでは 0**（＝今の見た目のまま）。
 * ほかのシードでは 0..1000 の決定的な実数になる。
 * 「noise(x·k + 5.3)」のような手で置いた定数に足して使うと、シードで模様が丸ごと変わる。
 */
export function seedOffset(key: SeedKey, i = 0): number {
  if (current === DEFAULT_SEED) return 0;
  return subFloat(key, i + 1) * 1000;
}
