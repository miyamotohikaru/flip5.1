// 木と岩の配置（CPU・決定的）。ジッタ付き格子 + hash2 + 植生マップの密度で間引く。
// 高さはハイトマップ（heightAt を焼いたもの＝地形メッシュが実際に見せている面）から取る。
// 64m 格子の空間索引を持ち、「カメラの周り半径 r」の問い合わせが速い。
import { hash2, smoothstep, clamp } from "../core/noise";
import { WORLD, sampleHeightmap, type Heightmap } from "../core/heightfield";
import { forestDensity, sampleVegMap, type VegMap } from "./vegmap";

export type Scatter = {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** 一様スケール */
  s: Float32Array;
  yaw: Float32Array;
  /** 傾き（rad）: x 軸回り, z 軸回り */
  tiltX: Float32Array;
  tiltZ: Float32Array;
  /** 種類（形のバリエーション） */
  v: Uint8Array;
  /** 0..1 の個体差シード */
  seed: Float32Array;
  /** 64m 格子の索引 */
  grid: Map<number, Int32Array>;
};

const GRID = 64;
const GN = WORLD.size / GRID; // 64
export function gridKey(x: number, z: number): number {
  const gx = clamp(Math.floor((x + WORLD.half) / GRID), 0, GN - 1);
  const gz = clamp(Math.floor((z + WORLD.half) / GRID), 0, GN - 1);
  return gx * GN + gz;
}

type Builder = {
  x: number[]; y: number[]; z: number[]; s: number[]; yaw: number[]; tiltX: number[]; tiltZ: number[]; v: number[]; seed: number[];
};
function newBuilder(): Builder {
  return { x: [], y: [], z: [], s: [], yaw: [], tiltX: [], tiltZ: [], v: [], seed: [] };
}
function finish(b: Builder): Scatter {
  const count = b.x.length;
  const cells = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const k = gridKey(b.x[i], b.z[i]);
    let a = cells.get(k);
    if (!a) cells.set(k, (a = []));
    a.push(i);
  }
  const grid = new Map<number, Int32Array>();
  for (const [k, a] of cells) grid.set(k, Int32Array.from(a));
  return {
    count,
    x: Float32Array.from(b.x), y: Float32Array.from(b.y), z: Float32Array.from(b.z), s: Float32Array.from(b.s),
    yaw: Float32Array.from(b.yaw), tiltX: Float32Array.from(b.tiltX), tiltZ: Float32Array.from(b.tiltZ),
    v: Uint8Array.from(b.v), seed: Float32Array.from(b.seed), grid,
  };
}

/** ハイトマップの法線 y 成分（eps m の有限差分） */
function groundNy(hm: Heightmap, x: number, z: number, eps = 2.0): number {
  const hl = sampleHeightmap(hm, x - eps, z), hr = sampleHeightmap(hm, x + eps, z);
  const hd = sampleHeightmap(hm, x, z - eps), hu = sampleHeightmap(hm, x, z + eps);
  const nx = hl - hr, nz = hd - hu, ny = 2 * eps;
  return ny / Math.hypot(nx, ny, nz);
}

/** 針葉樹。cell = 格子間隔（m）。密な林で 1 本 / cell² */
export function scatterTrees(hm: Heightmap, vm: VegMap, cell: number, variants: number): Scatter {
  const b = newBuilder();
  const n = Math.floor(WORLD.size / cell);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h1 = hash2(i, j, 101);
      const x = (i + 0.15 + 0.7 * hash2(i, j, 102)) * cell - WORLD.half;
      const z = (j + 0.15 + 0.7 * hash2(i, j, 103)) * cell - WORLD.half;
      // 植生マップで素早く却下（湖・高山）
      if (sampleVegMap(vm, x, z, 1) < 0.02) continue;
      const h = sampleHeightmap(hm, x, z);
      const ny = groundNy(hm, x, z);
      const p = forestDensity(x, z, h, ny);
      if (h1 > p) continue;
      const seed = hash2(i, j, 104);
      const fd = sampleVegMap(vm, x, z, 1);
      // 大きさ: 小さめに偏らせる。密な林ほど高い。森林限界の近くは低い
      let s = 0.55 + 0.95 * Math.pow(hash2(i, j, 105), 1.4);
      s *= 0.78 + 0.42 * fd;
      s *= 1 - 0.45 * smoothstep(260, 380, h);
      b.x.push(x);
      b.z.push(z);
      b.y.push(h - 0.22 * s);
      b.s.push(s);
      b.yaw.push(seed * Math.PI * 2);
      b.tiltX.push((hash2(i, j, 106) - 0.5) * 0.09);
      b.tiltZ.push((hash2(i, j, 107) - 0.5) * 0.09);
      b.v.push(Math.floor(hash2(i, j, 108) * variants) % variants);
      b.seed.push(seed);
    }
  }
  return finish(b);
}

/** 岩。斜面の岩（大、半分埋める）とガレ場（小さく多い）。 */
export function scatterRocks(hm: Heightmap, vm: VegMap, cell: number, variants: number): Scatter {
  const b = newBuilder();
  const n = Math.floor(WORLD.size / cell);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.1 + 0.8 * hash2(i, j, 201)) * cell - WORLD.half;
      const z = (j + 0.1 + 0.8 * hash2(i, j, 202)) * cell - WORLD.half;
      const rock = sampleVegMap(vm, x, z, 3);
      const h1 = hash2(i, j, 203);
      // 岩っぽさが低くても、ごくまれに草地の岩
      const p = rock * 0.85 + 0.012;
      if (h1 > p) continue;
      const h = sampleHeightmap(hm, x, z);
      if (h < WORLD.lakeLevel + 0.4) continue;
      const ny = groundNy(hm, x, z, 1.5);
      const seed = hash2(i, j, 204);
      // 大きさ: ガレ場（rock が高い）は小さめが多い。ときどき大岩
      const big = hash2(i, j, 205);
      let s = 0.35 + 1.1 * Math.pow(big, 2.2);
      if (big > 0.965) s = 2.2 + 2.5 * hash2(i, j, 206);
      s *= 0.8 + 0.4 * (1 - rock);
      b.x.push(x);
      b.z.push(z);
      // 地面に半分埋める（大きいほど深く）
      b.y.push(h - s * (0.28 + 0.2 * hash2(i, j, 207)));
      b.s.push(s);
      b.yaw.push(seed * Math.PI * 2);
      // 斜面に沿って少し傾く
      const lean = (1 - ny) * 1.2;
      b.tiltX.push((hash2(i, j, 208) - 0.5) * 0.6 + lean * (hash2(i, j, 209) - 0.5));
      b.tiltZ.push((hash2(i, j, 210) - 0.5) * 0.6);
      b.v.push(Math.floor(hash2(i, j, 211) * variants) % variants);
      b.seed.push(seed);
    }
  }
  return finish(b);
}

/** 半径 r 内の要素を列挙（格子単位で粗く絞ってから距離で確認） */
export function forEachInRadius(sc: Scatter, cx: number, cz: number, r: number, cb: (i: number, d: number) => void) {
  const g0x = clamp(Math.floor((cx - r + WORLD.half) / GRID), 0, GN - 1);
  const g1x = clamp(Math.floor((cx + r + WORLD.half) / GRID), 0, GN - 1);
  const g0z = clamp(Math.floor((cz - r + WORLD.half) / GRID), 0, GN - 1);
  const g1z = clamp(Math.floor((cz + r + WORLD.half) / GRID), 0, GN - 1);
  const r2 = r * r;
  for (let gx = g0x; gx <= g1x; gx++) {
    for (let gz = g0z; gz <= g1z; gz++) {
      const a = sc.grid.get(gx * GN + gz);
      if (!a) continue;
      for (let k = 0; k < a.length; k++) {
        const i = a[k];
        const dx = sc.x[i] - cx, dz = sc.z[i] - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= r2) cb(i, Math.sqrt(d2));
      }
    }
  }
}
