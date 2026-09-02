// 世界の形。ここにある heightAt() が、この風景の地形の「正体」。
// 画像のハイトマップは読み込まない。実行時にこの関数から焼く。
//
// 座標系: three.js 準拠（Y up、単位はメートル）。原点は湖の中心。
// プレイヤーは +Z 側（南岸）から -Z（北）を向いて始まり、湖の向こうに山脈を見る。
// 太陽は +X（東）から昇り、+Z（南・背中側）を通って -X（西）へ沈む。
//
// 地形は3つの成分の足し算（裏返しで別々の線の族として見せる）:
//   base = 湖底 + 岸の土手 + 盆地のゆるい上り + 侵食風の丘 + 沢筋
//   mtn  = 山脈（東西に走る尾根 × 山腹を流れ下る谷筋 × 段丘）。方角で高さが変わる（北が主峰）
//   fine = 数m〜数十mの細かい起伏
import * as THREE from "three";
import { noise2, smoothstep } from "./noise";

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

// ---------------------------------------------------------------------------
// 地形専用の速いグラディエントノイズ（固定 seed の置換表。TypedArray で分岐なし）。
// noise.ts の noise2 と同じ考え方だが 4M 回×20 層を 1.5 秒で焼くために別に持つ。
const P2 = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 2027 >>> 0;
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
  for (let i = 0; i < 512; i++) P2[i] = p[i & 255];
}
const GX = new Float64Array(16), GY = new Float64Array(16);
for (let k = 0; k < 16; k++) {
  GX[k] = Math.cos((k * Math.PI) / 8 + 0.31);
  GY[k] = Math.sin((k * Math.PI) / 8 + 0.31);
}
/** グラディエントノイズ（おおよそ [-1, 1]） */
function nz(x: number, y: number): number {
  const X = Math.floor(x), Y = Math.floor(y);
  const xf = x - X, yf = y - Y;
  const xi = X & 255, yi = Y & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const h00 = P2[P2[xi] + yi] & 15, h10 = P2[P2[xi + 1] + yi] & 15;
  const h01 = P2[P2[xi] + yi + 1] & 15, h11 = P2[P2[xi + 1] + yi + 1] & 15;
  const a = GX[h00] * xf + GY[h00] * yf, b = GX[h10] * (xf - 1) + GY[h10] * yf;
  const c = GX[h01] * xf + GY[h01] * (yf - 1), e = GX[h11] * (xf - 1) + GY[h11] * (yf - 1);
  return (a + u * (b - a) + v * (c - a) + u * v * (a - b - c + e)) * 1.414;
}
/** 微分つき（侵食風の減衰に使う）。微分は dNx / dNy に置く（配列生成を避ける） */
let dNx = 0, dNy = 0;
function nzd(x: number, y: number): number {
  const X = Math.floor(x), Y = Math.floor(y);
  const xf = x - X, yf = y - Y;
  const xi = X & 255, yi = Y & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const du = 30 * xf * xf * (xf * (xf - 2) + 1), dv = 30 * yf * yf * (yf * (yf - 2) + 1);
  const h00 = P2[P2[xi] + yi] & 15, h10 = P2[P2[xi + 1] + yi] & 15;
  const h01 = P2[P2[xi] + yi + 1] & 15, h11 = P2[P2[xi + 1] + yi + 1] & 15;
  const ax = GX[h00], ay = GY[h00], bx = GX[h10], by = GY[h10], cx = GX[h01], cy = GY[h01], ex = GX[h11], ey = GY[h11];
  const a = ax * xf + ay * yf, b = bx * (xf - 1) + by * yf, c = cx * xf + cy * (yf - 1), e = ex * (xf - 1) + ey * (yf - 1);
  const k0 = b - a, k1 = c - a, k2 = a - b - c + e;
  dNx = (ax + u * (bx - ax) + v * (cx - ax) + u * v * (ax - bx - cx + ex) + du * (k0 + v * k2)) * 1.414;
  dNy = (ay + u * (by - ay) + v * (cy - ay) + u * v * (ay - by - cy + ey) + dv * (k1 + u * k2)) * 1.414;
  return (a + u * k0 + v * k1 + u * v * k2) * 1.414;
}

/** 侵食風フラクタル: 累積した傾きが大きいところほど高いオクターブを弱める（斜面は滑らか、平地は細かい）。 */
function erodedFbm(x: number, y: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0, gx = 0, gy = 0;
  for (let i = 0; i < octaves; i++) {
    const n = nzd(x, y);
    gx += dNx;
    gy += dNy;
    sum += (amp * n) / (1 + 0.55 * (gx * gx + gy * gy));
    norm += amp;
    x = x * 2.0 + 19.1;
    y = y * 2.0 + 7.9;
    amp *= 0.5;
  }
  return sum / norm;
}

/** 尾根ノイズ。sharp（鋭い稜線 1-|n|）と round（丸い稜線 1-n²）を同じサンプルから同時に出す。 */
let ridgeRound = 0;
function ridgedBoth(x: number, y: number, octaves: number): number {
  let sum = 0, sumR = 0, amp = 0.5, norm = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    const n = nz(x, y);
    const an = n < 0 ? -n : n;
    let r = 1 - an;
    r = r * r * weight;
    const rr = (1 - an * an) * weight;
    weight = Math.min(1, Math.max(0, r * 2));
    sum += r * amp;
    sumR += rr * amp;
    norm += amp;
    x = x * 2.0 + 11.1;
    y = y * 2.0 + 7.7;
    amp *= 0.5;
  }
  ridgeRound = sumR / norm;
  return sum / norm;
}

/** 段丘: 高さを T ごとの段にする（段の間は滑らか）。 */
function terrace(h: number, T: number): number {
  const q = h / T;
  const fl = Math.floor(q);
  let t = (q - fl - 0.32) / 0.36;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (fl + t * t * (3 - 2 * t)) * T;
}

// ---------------------------------------------------------------------------
// 方角だけで決まる量（岸線の半径・土手の幅・山脈の始まる距離・山塊の高さ）は角度の表にして引く。
// 4M サンプルの焼き込みで 5 本のノイズを 1 回の atan2 に置き換えるため。
const ANG_N = 2048;
const angShore = new Float32Array(ANG_N + 1);
const angBank = new Float32Array(ANG_N + 1);
const angRange = new Float32Array(ANG_N + 1);
const angMassif = new Float32Array(ANG_N + 1);
for (let i = 0; i <= ANG_N; i++) {
  const a = (i / ANG_N) * Math.PI * 2 - Math.PI;
  const ca = Math.cos(a), sa = Math.sin(a);
  angShore[i] = WORLD.lakeRadius + 70 * noise2(ca * 1.7 + 5.2, sa * 1.7 + 5.2) + 26 * noise2(ca * 4.1 + 1.3, sa * 4.1 + 9.1);
  angBank[i] = nz(ca * 2.6 + 3.3, sa * 2.6 + 8.1);
  angRange[i] = 120 * nz(ca * 1.9 + 1.2, sa * 1.9 + 4.4);
  angMassif[i] = 0.74 + 0.26 * nz(ca * 1.4 + 7.7, sa * 1.4 + 2.2);
}
let angI = 0, angF = 0;
function angIndex(x: number, z: number) {
  const fi = ((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * ANG_N;
  let i = Math.floor(fi);
  if (i >= ANG_N) i = ANG_N - 1;
  if (i < 0) i = 0;
  angI = i;
  angF = fi - i;
}
const angGet = (t: Float32Array) => t[angI] + (t[angI + 1] - t[angI]) * angF;

/** 岸線の半径（角度でうねらせる）。 */
export function shoreRadius(x: number, z: number): number {
  angIndex(x, z);
  return angGet(angShore);
}

// 主峰の向き（北北西）と氷河谷の向き（北北東・西南西）。単位ベクトル (cos, sin)
const PEAK_DIR_X = Math.cos(-Math.PI / 2 - 0.3), PEAK_DIR_Z = Math.sin(-Math.PI / 2 - 0.3);
const VALLEY_DIR_X = Math.cos(-Math.PI / 2 + 0.24), VALLEY_DIR_Z = Math.sin(-Math.PI / 2 + 0.24);
const VALLEY2_DIR_X = Math.cos(Math.PI - 0.5), VALLEY2_DIR_Z = Math.sin(Math.PI - 0.5);

/** 直近の heightAt() の3成分と岸線からの距離（bakeHeightmap が読む。毎回の配列生成を避ける） */
let partBase = 0, partMtn = 0, partFine = 0, partShore = 0;

/**
 * 地形の高さ（m）。決定的・連続・どこでも呼べる。
 * 湖 → 岸の草地 → 針葉樹の斜面 → 岩 → 雪の稜線、という一つの谷。
 */
export function heightAt(x: number, z: number): number {
  const d = Math.sqrt(x * x + z * z);
  const inv = d > 1e-6 ? 1 / d : 0;
  const ca = d > 1e-6 ? x * inv : 1, sa = d > 1e-6 ? z * inv : 0; // 湖の中心から見た方角
  angIndex(x, z);
  const shoreR = angGet(angShore);
  const sd = d - shoreR; // 岸線からの符号付き距離（負が湖）
  partShore = sd;
  const northness = 0.5 - 0.5 * sa; // 1 = 北（山脈が近く高い）, 0 = 南（低い丘）

  // ---- base: 湖底 ----
  let base = 0;
  if (sd < 0) {
    const bed = 0.85 + 0.15 * nz(x * 0.012 + 3.0, z * 0.012 - 5.0);
    base -= 34 * (1 - Math.exp(sd / 70)) * bed;
  }
  // 岸の土手（角度で幅が変わる: 砂浜になる所と草の土手が水に落ちる所）
  base += 2.4 * smoothstep(-2, 9 + 6 * angGet(angBank), sd);

  // 山脈の始まる距離（方角で違う）と、そこまでのゆるい上り
  const rangeR = 1580 - 450 * northness + angGet(angRange);
  const riseT = smoothstep(12, rangeR - 350 - shoreR, sd);
  base += (70 + 65 * northness) * riseT * (0.5 + 0.5 * riseT);

  // 侵食風の丘（岸辺では小さく、離れるほど大きい）と、丘のノイズでうねらせた沢筋
  const landT = smoothstep(-30, 40, sd);
  if (landT > 0) {
    const hills = erodedFbm(x * 0.0021 + 3.1, z * 0.0021 - 1.7, 4);
    base += hills * (5 + 50 * smoothstep(0, 800, sd)) * landT;
    const creaseT = smoothstep(30, 380, sd);
    if (creaseT > 0) {
      const c1 = 1 - Math.abs(nz(x * 0.0029 + hills * 0.6 + 0.7, z * 0.0029 - hills * 0.5 + 2.1));
      base -= 9 * c1 * c1 * c1 * c1 * creaseT;
      const fineCrease = 1 - smoothstep(1000, 1300, sd);
      if (fineCrease > 0) {
        const c2 = 1 - Math.abs(nz(x * 0.0071 - hills * 0.3 + 4.2, z * 0.0071 + hills * 0.4 + 6.6));
        base -= 3 * c2 * c2 * c2 * creaseT * fineCrease;
      }
    }
  }

  // ---- mtn: 山脈 ----
  let mtn = 0;
  const rd = d - rangeR;
  const mtnMask = smoothstep(-560, 560, rd);
  if (mtnMask > 0) {
    // 方角ごとの高さ: 北ほど高い。主峰（北北西）を盛り、氷河谷（北北東・西南西）を切る
    const dotPeak = ca * PEAK_DIR_X + sa * PEAK_DIR_Z;
    const dotValley = ca * VALLEY_DIR_X + sa * VALLEY_DIR_Z;
    const dotValley2 = ca * VALLEY2_DIR_X + sa * VALLEY2_DIR_Z;
    let amp = (320 + 360 * northness * northness) * angGet(angMassif);
    amp *= 1 + 0.24 * smoothstep(0.86, 1.0, dotPeak);
    const valleyCut = smoothstep(0.955, 0.993, dotValley) + 0.8 * smoothstep(0.965, 0.995, dotValley2);
    amp *= 1 - 0.72 * Math.min(1, valleyCut);

    // 尾根: 東西に走る走向（x を引き伸ばす）。ドメインワープで蛇行させる
    const wx = 300 * nz(x * 0.00052 + 7.1, z * 0.00052 + 3.3);
    const wz = 300 * nz(x * 0.00052 - 2.7, z * 0.00052 + 9.9);
    const px = (x + wx) * 0.00048 + 0.5, pz = (z + wz) * 0.00078 + 0.9;
    const sharp = ridgedBoth(px, pz, 5);
    const round = ridgeRound;
    const sharpness = 0.45 + 0.55 * smoothstep(-0.35, 0.45, nz(x * 0.0008 + 2.9, z * 0.0008 + 8.8));
    let m = round + (sharp - round) * sharpness;
    m = m * m * (1.9 - 0.9 * m); // 谷底を締め、山頂は残す

    // 山腹を流れ下る谷筋（北側では南北に、東西側では東西に伸びた溝）。稜線と裾は残す
    const flank = smoothstep(0.1, 0.4, m) * (1 - smoothstep(0.6, 0.92, m));
    if (flank > 0.02) {
      const gN = 1 - Math.abs(nz(x * 0.011 + 2.0, z * 0.0036 + 5.0));
      const gE = 1 - Math.abs(nz(x * 0.0036 + 8.0, z * 0.011 + 1.0));
      const g1 = sa * sa * gN + ca * ca * gE;
      m -= 0.1 * g1 * g1 * g1 * flank;
    }

    mtn = m * amp * mtnMask;
    // 段丘（崖の帯）: 上部の岩場だけ、場所によって
    if (mtn > 160) {
      const terrT = smoothstep(0.25, 0.7, nz(x * 0.0013 + 5.5, z * 0.0013 + 0.4)) * smoothstep(160, 320, mtn);
      if (terrT > 0) mtn += (terrace(mtn, 46) - mtn) * 0.65 * terrT;
    }
  }

  // ---- fine: 細かい起伏（歩ける範囲で強く、遠くはメッシュが粗いので省く）----
  let fine = 0;
  {
    const shoreT = 0.3 + 0.7 * smoothstep(-10, 60, sd);
    fine = 1.6 * nz(x * 0.021 - 8.2, z * 0.021 + 4.4) * shoreT;
    const nearT = 1 - smoothstep(1400, 1650, d);
    if (nearT > 0) {
      const f2 = nz(x * 0.047 + 1.1, z * 0.047 - 9.3);
      const f3 = nz(x * 0.115 + 5.5, z * 0.115 + 2.2);
      fine += (0.45 * f2 + 0.18 * f3) * shoreT * nearT;
    }
  }

  partBase = base;
  partMtn = mtn;
  partFine = fine;
  return base + mtn + fine;
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
  /**
   * 高さの3成分（RGBA16F、m）。r = 山脈, g = 土台（湖底・土手・上り・丘・沢筋）, b = 細部, a = 岸線からの距離（±500 で飽和）。
   * r + g + b = 高さ。裏返しの「数式の足し算」表示に使う。texel の対応は texture と同じ。
   */
  parts: THREE.DataTexture;
};

/**
 * heightAt() を res×res に焼いたテクスチャ。GPU 側（地形・草・木・水深）は
 * これを参照する。CPU 側（当たり判定・配置）は heightAt() を直接呼ぶ。
 * texel (i, j) は world (x, z) = ((i/res − 0.5)·size, (j/res − 0.5)·size)。
 */
export function bakeHeightmap(res: number, onProgress?: (p: number) => void): Heightmap {
  const data = new Float32Array(res * res);
  const parts = new Uint16Array(res * res * 4);
  const half = THREE.DataUtils.toHalfFloat;
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < res; j++) {
    const z = (j / res - 0.5) * WORLD.size;
    for (let i = 0; i < res; i++) {
      const x = (i / res - 0.5) * WORLD.size;
      const h = heightAt(x, z);
      const k = j * res + i;
      data[k] = h;
      if (h < min) min = h;
      if (h > max) max = h;
      parts[k * 4] = half(partMtn);
      parts[k * 4 + 1] = half(partBase);
      parts[k * 4 + 2] = half(partFine);
      parts[k * 4 + 3] = half(partShore < -500 ? -500 : partShore > 500 ? 500 : partShore);
    }
    if (onProgress && (j & 63) === 0) onProgress(j / res);
  }
  const texture = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  // 端の外は鏡像で続ける（遠景の霧の中に「もう一つ向こうの山脈」が見える。端に台地の壁ができない）
  texture.wrapS = THREE.MirroredRepeatWrapping;
  texture.wrapT = THREE.MirroredRepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const partsTex = new THREE.DataTexture(parts, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
  partsTex.magFilter = THREE.LinearFilter;
  partsTex.minFilter = THREE.LinearFilter;
  partsTex.wrapS = THREE.MirroredRepeatWrapping;
  partsTex.wrapT = THREE.MirroredRepeatWrapping;
  partsTex.generateMipmaps = false;
  partsTex.needsUpdate = true;
  return { res, data, texture, min, max, parts: partsTex };
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
