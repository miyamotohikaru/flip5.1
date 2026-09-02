// 世界の形。地形の高さ heightAt() の本体は height.ts（three に依存しない。Worker からも使う）。
// ここは three を使う部分（法線・ハイトマップのテクスチャ）と、従来の import 先としての再輸出。
// 画像のハイトマップは読み込まない。実行時に heightAt() から焼く。
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RedFormat, Vector3 } from "three";
import { WORLD, heightAt, bakeHeightRows } from "./height";

export { WORLD, shoreRadius, heightAt, startPosition, bakeHeightRows } from "./height";

/** 地形の法線（有限差分）。 */
export function normalAt(x: number, z: number, eps = 1.5): Vector3 {
  const hl = heightAt(x - eps, z), hr = heightAt(x + eps, z);
  const hd = heightAt(x, z - eps), hu = heightAt(x, z + eps);
  return new Vector3(hl - hr, 2 * eps, hd - hu).normalize();
}

export type Heightmap = {
  res: number;
  data: Float32Array;
  texture: DataTexture;
  min: number;
  max: number;
};

/** 焼き済みの Float32Array からハイトマップ（テクスチャ込み）を組み立てる。Worker で焼いた結果の受け取りにも使う。 */
export function heightmapFromData(data: Float32Array, res: number, min?: number, max?: number): Heightmap {
  if (min === undefined || max === undefined) {
    min = Infinity;
    max = -Infinity;
    for (let k = 0; k < data.length; k++) {
      const h = data[k];
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  const texture = new DataTexture(data, res, res, RedFormat, FloatType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { res, data, texture, min, max };
}

/**
 * heightAt() を res×res に焼いたテクスチャ。GPU 側（地形・草・木・水深）は
 * これを参照する。CPU 側（当たり判定・配置）は heightAt() を直接呼ぶ。
 * texel (i, j) は world (x, z) = ((i/res − 0.5)·size, (j/res − 0.5)·size)。
 * メインスレッドを 1 秒以上止めるので、起動時は controls/bake.ts の bakeHeightmapAsync（Worker）を使う。
 */
export function bakeHeightmap(res: number, onProgress?: (p: number) => void): Heightmap {
  const data = new Float32Array(res * res);
  let min = Infinity, max = -Infinity;
  const step = 64;
  for (let j = 0; j < res; j += step) {
    const r = bakeHeightRows(data, res, j, Math.min(res, j + step));
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
    if (onProgress) onProgress(j / res);
  }
  return heightmapFromData(data, res, min, max);
}

/** ハイトマップからの高さ（バイリニア）。GPUと同じ値が欲しいときに使う。 */
export function sampleHeightmap(hm: Heightmap, x: number, z: number): number {
  const u = (x / WORLD.size + 0.5) * hm.res - 0.5;
  const v = (z / WORLD.size + 0.5) * hm.res - 0.5;
  const i0 = Math.max(0, Math.min(hm.res - 2, Math.floor(u)));
  const j0 = Math.max(0, Math.min(hm.res - 2, Math.floor(v)));
  const fu = Math.min(1, Math.max(0, u - i0));
  const fv = Math.min(1, Math.max(0, v - j0));
  const d = hm.data, r = hm.res;
  const a = d[j0 * r + i0], b = d[j0 * r + i0 + 1];
  const c = d[(j0 + 1) * r + i0], e = d[(j0 + 1) * r + i0 + 1];
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
}
