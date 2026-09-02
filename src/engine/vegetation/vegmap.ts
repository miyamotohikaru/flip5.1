// 植生マップ。CPU で一度だけ焼いて、CPU（木・岩の配置）と GPU（草の密度）が同じ答えを見る。
//   R = 草の密度 0..1（岸の草地で濃く、林の下で薄く、急斜面・水中・400m 超で 0）
//   G = 林の密度 0..1（群落ノイズ。密な林と開けた草地の斑）
//   B = 乾き 0..1（草の色の斑）
//   A = 岩っぽさ 0..1（斜面・ガレ場）
// 決定的: noise2 / fbm2 / hash2 だけを使う。
import * as THREE from "three";
import { fbm2, noise2, smoothstep, clamp } from "../core/noise";
import { WORLD, sampleHeightmap, shoreRadius, type Heightmap } from "../core/heightfield";

export type VegMap = {
  res: number;
  data: Uint8Array;
  texture: THREE.DataTexture;
  /** (worldSize, 1/worldSize, res, 0) */
  info: THREE.Vector4;
  /** 岸線からの近さ 0..1（水際で 1、12m で 0）。小石の帯に使う。R8 */
  shore: THREE.DataTexture;
  shoreData: Uint8Array;
  shoreRes: number;
};

/** 林の密度（群落）。木の配置と草の間引きの両方がこれを見る。 */
export function forestDensity(x: number, z: number, h: number, ny: number): number {
  // 標高: 3m から生え始め、8m で本格化、340〜400m で森林限界
  const elev = smoothstep(2.5, 9.0, h) * (1 - smoothstep(330, 400, h));
  if (elev <= 0) return 0;
  // 斜度 35° 未満
  const slope = smoothstep(0.78, 0.86, ny);
  if (slope <= 0) return 0;
  // 群落: 大きなうねり（~900m）＋ 中くらいの斑（~200m）
  const big = fbm2(x * 0.00105 + 5.3, z * 0.00105 + 9.1, 3);
  const mid = fbm2(x * 0.0047 - 2.2, z * 0.0047 + 4.8, 2);
  let f = smoothstep(-0.28, 0.32, big * 0.75 + mid * 0.45);
  // 岸の草地には孤立木がまばらに
  const sd = Math.hypot(x, z) - shoreRadius(x, z);
  const meadow = 1 - smoothstep(150, 320, sd);
  f = f * (1 - meadow) + meadow * 0.08 * smoothstep(3.5, 7.0, h);
  return clamp(f * elev * slope, 0, 1);
}

export function bakeVegMap(hm: Heightmap, res = 512): VegMap {
  const data = new Uint8Array(res * res * 4);
  const step = WORLD.size / res;
  const eps = 3.0;
  for (let j = 0; j < res; j++) {
    const z = (j / res - 0.5) * WORLD.size + step * 0.5;
    for (let i = 0; i < res; i++) {
      const x = (i / res - 0.5) * WORLD.size + step * 0.5;
      const h = sampleHeightmap(hm, x, z);
      const hl = sampleHeightmap(hm, x - eps, z), hr = sampleHeightmap(hm, x + eps, z);
      const hd = sampleHeightmap(hm, x, z - eps), hu = sampleHeightmap(hm, x, z + eps);
      const nx = (hl - hr), nz = (hd - hu), nyl = 2 * eps;
      const ny = nyl / Math.hypot(nx, nyl, nz);
      const forest = forestDensity(x, z, h, ny);

      // 草: 岸の草地で濃く、林の中で薄く、急斜面と 400m 超と水中では 0
      const sd = Math.hypot(x, z) - shoreRadius(x, z);
      let grass = smoothstep(WORLD.lakeLevel + 0.25, WORLD.lakeLevel + 1.2, h);
      grass *= 1 - smoothstep(0.62, 0.86, 1 - ny);
      grass *= 1 - smoothstep(360, 410, h);
      const meadow = 1 - smoothstep(120, 420, sd);
      const patch = fbm2(x * 0.011 + 1.7, z * 0.011 - 3.9, 3) * 0.5 + 0.5;
      grass *= 0.55 + 0.45 * meadow;
      grass *= 0.7 + 0.5 * patch;
      grass *= 1 - 0.72 * forest;

      const dry = clamp(fbm2(x * 0.0065 + 8.8, z * 0.0065 + 2.1, 3) * 0.6 + 0.5 + 0.25 * smoothstep(60, 300, h), 0, 1);

      // 岩: 斜面の中腹〜急斜面。ガレ場は斑。ゆるい斜面にもまばらな転石
      const steep = smoothstep(0.18, 0.42, 1 - ny);
      const scree = smoothstep(0.1, 0.6, noise2(x * 0.006 + 3.3, z * 0.006 - 7.7)) * smoothstep(0.1, 0.3, 1 - ny);
      const boulder = 0.16 * smoothstep(0.04, 0.16, 1 - ny) * smoothstep(0.2, 0.7, noise2(x * 0.004 - 9.1, z * 0.004 + 2.2) * 0.5 + 0.5);
      let rock = clamp(steep * 0.8 + scree * 0.9 + boulder, 0, 1) * smoothstep(3, 25, h) * (1 - smoothstep(0.75, 0.95, 1 - ny));
      rock *= 1 - 0.5 * forest;

      const k = (j * res + i) * 4;
      data[k] = Math.round(clamp(grass, 0, 1) * 255);
      data[k + 1] = Math.round(forest * 255);
      data[k + 2] = Math.round(dry * 255);
      data[k + 3] = Math.round(rock * 255);
    }
  }
  const texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  // 岸線からの近さ（細かめ）
  const shoreRes = 768;
  const shoreData = new Uint8Array(shoreRes * shoreRes);
  const sstep = WORLD.size / shoreRes;
  for (let j = 0; j < shoreRes; j++) {
    const z = (j / shoreRes - 0.5) * WORLD.size + sstep * 0.5;
    for (let i = 0; i < shoreRes; i++) {
      const x = (i / shoreRes - 0.5) * WORLD.size + sstep * 0.5;
      const d = Math.hypot(x, z);
      if (d > WORLD.lakeRadius + 160 || d < WORLD.lakeRadius - 140) continue;
      const sd = d - shoreRadius(x, z);
      shoreData[j * shoreRes + i] = Math.round((1 - smoothstep(1.5, 12, sd)) * smoothstep(-6, -0.5, sd) * 255);
    }
  }
  const shore = new THREE.DataTexture(shoreData, shoreRes, shoreRes, THREE.RedFormat, THREE.UnsignedByteType);
  shore.magFilter = THREE.LinearFilter;
  shore.minFilter = THREE.LinearFilter;
  shore.wrapS = THREE.ClampToEdgeWrapping;
  shore.wrapT = THREE.ClampToEdgeWrapping;
  shore.generateMipmaps = false;
  shore.colorSpace = THREE.NoColorSpace;
  shore.needsUpdate = true;
  return { res, data, texture, info: new THREE.Vector4(WORLD.size, 1 / WORLD.size, res, 0), shore, shoreData, shoreRes };
}

/** CPU 側からの参照（バイリニア）。channel: 0=草 1=林 2=乾き 3=岩 */
export function sampleVegMap(vm: VegMap, x: number, z: number, channel: number): number {
  const u = (x / WORLD.size + 0.5) * vm.res - 0.5;
  const v = (z / WORLD.size + 0.5) * vm.res - 0.5;
  const i0 = Math.max(0, Math.min(vm.res - 2, Math.floor(u)));
  const j0 = Math.max(0, Math.min(vm.res - 2, Math.floor(v)));
  const fu = Math.min(1, Math.max(0, u - i0));
  const fv = Math.min(1, Math.max(0, v - j0));
  const d = vm.data, r = vm.res;
  const a = d[(j0 * r + i0) * 4 + channel], b = d[(j0 * r + i0 + 1) * 4 + channel];
  const c = d[((j0 + 1) * r + i0) * 4 + channel], e = d[((j0 + 1) * r + i0 + 1) * 4 + channel];
  return ((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv) / 255;
}

/** 木の根元の周りの草を薄くする（木の配置後に呼ぶ） */
export function stampTreeRoots(vm: VegMap, xs: ArrayLike<number>, zs: ArrayLike<number>, count: number, strength = 0.45) {
  const r = vm.res;
  for (let n = 0; n < count; n++) {
    const u = (xs[n] / WORLD.size + 0.5) * r;
    const v = (zs[n] / WORLD.size + 0.5) * r;
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= r || j >= r) continue;
    const k = (j * r + i) * 4;
    vm.data[k] = Math.round(vm.data[k] * (1 - strength));
  }
  vm.texture.needsUpdate = true;
}
