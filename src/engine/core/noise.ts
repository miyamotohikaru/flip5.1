// CPU側の決定的ノイズ。地形の高さ関数や配置の乱数に使う。
// 画像も乱数表ファイルも使わない――全部この関数群から生える。
// GPU側の同等品は glsl/noise.glsl.ts（値は一致しない。役割が違う）。

const PERM = new Uint8Array(512);
{
  // 固定seedのLCGで置換表をつくる（Math.randomは使わない＝毎回同じ世界）
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 1337 >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 2Dグラディエントノイズ。おおよそ [-1, 1]。 */
export function noise2(x: number, y: number): number {
  const X = Math.floor(x), Y = Math.floor(y);
  const xf = x - X, yf = y - Y;
  const xi = X & 255, yi = Y & 255;
  const u = fade(xf), v = fade(yf);
  const g = (h: number, dx: number, dy: number) => {
    const gr = GRAD[h % 12];
    return gr[0] * dx + gr[1] * dy;
  };
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  const x1 = lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u);
  const x2 = lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 1.4142;
}

/** フラクタル和。octaves を重ねるほど細かい。おおよそ [-1, 1]。 */
export function fbm2(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x, y);
    norm += amp;
    x = x * lacunarity + 31.7;
    y = y * lacunarity + 17.3;
    amp *= gain;
  }
  return sum / norm;
}

/** 尾根の立つノイズ。[0, 1]。山脈に使う。 */
export function ridged2(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
  let sum = 0, amp = 0.5, norm = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2(x, y));
    n = n * n * weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += n * amp;
    norm += amp;
    x = x * lacunarity + 11.1;
    y = y * lacunarity + 7.7;
    amp *= gain;
  }
  return sum / norm;
}

/** 整数座標のハッシュ [0, 1)。配置の乱数用。 */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const mix = lerp;
