// 音まわりの決定的な乱数。Math.random は使わない（同じ操作をすれば同じ音が鳴る）。
// 整数ハッシュで種を作り、xorshift32 で列を出す。
// 世界のシード（core/seed.ts の "audio"）が全部の種に混ざる＝?seed= を変えると鳥の鳴き方も雷の形も変わる。
// （音の素材は起動時に一度だけ合成するので、シードが効くのは読み込みの時点）
import { subSeed } from "../core/seed";

/** 整数のハッシュ → 32bit 符号なし */
export function hashU32(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519) + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number, salt = 0) {
    this.s = hashU32(seed + subSeed("audio"), salt) || 0x1234567;
  }
  /** [0, 1) */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** 対数一様（音の大きさ・長さ・周波数のばらつきはこちらが自然） */
  logRange(a: number, b: number): number {
    return a * Math.pow(b / a, this.next());
  }
  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** 正規分布（平均 0、分散 1） */
  gauss(): number {
    const u = Math.max(1e-9, this.next()), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  /** 重み付き選択 */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let sum = 0;
    for (const w of weights) sum += Math.max(0, w);
    if (sum <= 0) return items[0];
    let x = this.next() * sum;
    for (let i = 0; i < items.length; i++) {
      x -= Math.max(0, weights[i]);
      if (x <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}
