// 世界の形。ここにある heightAt() が、この風景の地形の「正体」。
// 画像のハイトマップは読み込まない。実行時にこの関数から焼く。
//
// 座標系: three.js 準拠（Y up、単位はメートル）。原点は湖の中心。
// プレイヤーは +Z 側（南岸）から -Z（北）を向いて始まり、湖の向こうに山脈を見る。
// 太陽は +X（東）から昇り、+Z（南・背中側）を通って -X（西）へ沈む。
import * as THREE from "three";
import { fbm2, noise2, ridged2, smoothstep } from "./noise";

export const WORLD = {
  /** ハイトマップが覆う一辺（m）。これより外は霧の向こう。 */
  size: 4096,
  half: 2048,
  /** 湖面の高さ（m） */
  lakeLevel: 0,
  /** 湖のおおよその半径（m）。岸線は角度でうねる。 */
  lakeRadius: 330,
  /** 想定する最高標高（m）。テクスチャの正規化に使う */
  maxHeight: 800,
  /** プレイヤーが歩ける半径（m）。これより外は霧で見せない */
  walkRadius: 1500,
} as const;

/** 岸線の半径（角度でうねらせる）。 */
export function shoreRadius(x: number, z: number): number {
  const a = Math.atan2(z, x);
  const ca = Math.cos(a), sa = Math.sin(a);
  return (
    WORLD.lakeRadius +
    70 * noise2(ca * 1.7 + 5.2, sa * 1.7 + 5.2) +
    26 * noise2(ca * 4.1 + 1.3, sa * 4.1 + 9.1)
  );
}

/**
 * 地形の高さ（m）。決定的・連続・どこでも呼べる。
 * 湖 → 岸の草地 → 針葉樹の斜面 → 岩 → 雪の稜線、という一つの谷。
 */
export function heightAt(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const sd = d - shoreRadius(x, z); // 岸線からの符号付き距離（負が湖）

  // 湖底: 岸からなだらかに深くなる椀
  const depth = sd < 0 ? 34 * (1 - Math.exp(sd / 70)) : 0;

  // 中景の丘（岸辺では小さく、離れるほど大きく）
  const h2 = fbm2(x * 0.0031 + 3.1, z * 0.0031 - 1.7, 4);
  const h3 = fbm2(x * 0.021 - 8.2, z * 0.021 + 4.4, 3);
  const shoreMask = smoothstep(0, 900, sd);
  const hills = 26 * h2 * (0.12 + 0.88 * shoreMask);

  // 遠景の山脈: ドメインワープした尾根ノイズ
  const wx = x + 380 * noise2(x * 0.00041 + 7.1, z * 0.00041 + 3.3);
  const wz = z + 380 * noise2(x * 0.00041 - 2.7, z * 0.00041 + 9.9);
  let m = ridged2(wx * 0.00072 + 0.5, wz * 0.00072 + 0.9, 5);
  m = Math.pow(m, 1.55);
  const mtnMask = Math.pow(smoothstep(420, 1500, sd), 1.4);
  const mtn = m * 660 * mtnMask;

  // 岸からのゆるい上り
  const rise = 0.032 * Math.max(sd, 0) * (1 - 0.5 * mtnMask);

  return (
    -depth +
    0.8 * smoothstep(-20, 20, sd) +
    rise +
    hills * smoothstep(-40, 60, sd) +
    2.2 * h3 +
    mtn
  );
}

/** 地形の法線（有限差分）。 */
export function normalAt(x: number, z: number, eps = 1.5): THREE.Vector3 {
  const hl = heightAt(x - eps, z), hr = heightAt(x + eps, z);
  const hd = heightAt(x, z - eps), hu = heightAt(x, z + eps);
  return new THREE.Vector3(hl - hr, 2 * eps, hd - hu).normalize();
}

export type Heightmap = {
  res: number;
  data: Float32Array;
  texture: THREE.DataTexture;
  min: number;
  max: number;
};

/**
 * heightAt() を res×res に焼いたテクスチャ。GPU 側（地形・草・木・水深）は
 * これを参照する。CPU 側（当たり判定・配置）は heightAt() を直接呼ぶ。
 * texel (i, j) は world (x, z) = ((i/res − 0.5)·size, (j/res − 0.5)·size)。
 */
export function bakeHeightmap(res: number, onProgress?: (p: number) => void): Heightmap {
  const data = new Float32Array(res * res);
  let min = Infinity, max = -Infinity;
  const inv = WORLD.size / res;
  for (let j = 0; j < res; j++) {
    const z = (j / res - 0.5) * WORLD.size;
    for (let i = 0; i < res; i++) {
      const x = (i / res - 0.5) * WORLD.size;
      const h = heightAt(x, z);
      data[j * res + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    if (onProgress && (j & 63) === 0) onProgress(j / res);
  }
  void inv;
  const texture = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { res, data, texture, min, max };
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

/** 開始地点: 南岸の草地。湖越しに北の山脈を見る。 */
export function startPosition(): { x: number; z: number; yaw: number } {
  // 岸線から +18m ほど陸側
  const a = Math.PI / 2; // +Z
  const r = shoreRadius(Math.cos(a) * 10, Math.sin(a) * 10) + 18;
  return { x: 0, z: r, yaw: 0 };
}
