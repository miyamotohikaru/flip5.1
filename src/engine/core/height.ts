// 地形の「正体」= heightAt()。three に依存しない純粋な数式だけを置く。
// Web Worker（controls/bake.worker.ts）からも import するので、ここに DOM や three を持ち込まないこと。
// 外からは従来どおり core/heightfield から import できる（heightfield.ts が再輸出する）。
//
// 座標系: three.js 準拠（Y up、単位はメートル）。原点は湖の中心。
// プレイヤーは +Z 側（南岸）から -Z（北）を向いて始まり、湖の向こうに山脈を見る。
// 太陽は +X（東）から昇り、+Z（南・背中側）を通って -X（西）へ沈む。
//
// 地形は3つの成分の足し算（裏返しで別々の線の族として見せる）:
//   base = 湖底 + 岸の土手 + 盆地のゆるい上り + 侵食風の丘 + 沢筋
//   mtn  = 山脈（東西に走る尾根 × 山腹を流れ下る谷筋 × 支尾根の族 × 段丘）。方角で高さが変わる（北が主峰）
//   fine = 数m〜数十mの細かい起伏
import { noise2, smoothstep } from "./noise";
import { onSeed, subSeed } from "./seed";

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
function buildP2() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = subSeed("terrain") >>> 0;
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

/**
 * 地形の式のつまみ（実験室が動かす）。1 が既定＝今の谷。
 * 変えたらハイトマップを焼き直す（engine/lab/rebuild.ts）。Worker にも同じ値を送ること。
 */
export type TerrainTune = {
  /** 山脈の高さ（amp の倍率）。h の mtn 項 */
  amp: number;
  /** 尾根の鋭さ（sharp と round の混ぜ方）。1 で今、0 で丸い稜線だけ、2 で全部鋭い */
  ridge: number;
  /** 侵食の強さ（erodedFbm の傾き減衰 0.55 の倍率）。大きいほど斜面が滑らかで平地に細部が残る */
  erode: number;
};
export const TERRAIN_TUNE_DEFAULT: TerrainTune = { amp: 1, ridge: 1, erode: 1 };
const TUNE: TerrainTune = { ...TERRAIN_TUNE_DEFAULT };
export function setTerrainTune(t: Partial<TerrainTune>) {
  if (t.amp !== undefined) TUNE.amp = t.amp;
  if (t.ridge !== undefined) TUNE.ridge = t.ridge;
  if (t.erode !== undefined) TUNE.erode = t.erode;
}
export function getTerrainTune(): TerrainTune {
  return { ...TUNE };
}

/** 侵食風フラクタル: 累積した傾きが大きいところほど高いオクターブを弱める（斜面は滑らか、平地は細かい）。 */
function erodedFbm(x: number, y: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0, gx = 0, gy = 0;
  const k = 0.55 * TUNE.erode;
  for (let i = 0; i < octaves; i++) {
    const n = nzd(x, y);
    gx += dNx;
    gy += dNy;
    sum += (amp * n) / (1 + k * (gx * gx + gy * gy));
    norm += amp;
    x = x * 2.0 + 19.1;
    y = y * 2.0 + 7.9;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * 尾根ノイズ。sharp（鋭い稜線 1-|n|）と round（丸い稜線 1-n²）を同じサンプルから同時に出す。
 * 減衰は 0.58（0.5 だと 130〜500m の帯が空いて、山脈が一つのなだらかなドーム＝「団子」になる）。
 */
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
    amp *= 0.58;
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
const angShelf = new Float32Array(ANG_N + 1);
function buildAngleTables() {
  for (let i = 0; i <= ANG_N; i++) {
    const a = (i / ANG_N) * Math.PI * 2 - Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a);
    angShore[i] = WORLD.lakeRadius + 70 * noise2(ca * 1.7 + 5.2, sa * 1.7 + 5.2) + 26 * noise2(ca * 4.1 + 1.3, sa * 4.1 + 9.1);
    angBank[i] = nz(ca * 2.6 + 3.3, sa * 2.6 + 8.1);
    angRange[i] = 120 * nz(ca * 1.9 + 1.2, sa * 1.9 + 4.4);
    angMassif[i] = 0.74 + 0.26 * nz(ca * 1.4 + 7.7, sa * 1.4 + 2.2);
  // 浅瀬の棚の幅（m）。方角で 3〜17m。ここが無いと湖底が岸で垂直に落ちて「プールの縁」になる
  angShelf[i] = 2.5 + 4.8 * (1 + nz(ca * 3.1 + 6.7, sa * 3.1 - 2.3)) + 3.0 * nz(ca * 7.3 + 1.9, sa * 7.3 + 4.1);
  }
}
// 置換表 → 角度の表 の順に作り直す（角度の表は nz / noise2 を引くので後）
onSeed(() => {
  buildP2();
  buildAngleTables();
});
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
    // 岸から数 m は浅い棚。棚が無いと水際 2m で 1m の深さになり、明るい岸と暗い湖底が
    // 接して「プールの縁」に見える。棚と本体を式で繋ぐ（段で切り替えると棚の外縁に線が出る）:
    // 指数の落ち込みに、幅 shelf×2.4 の smoothstep を掛けるだけ。微分が連続なので折れ目が無い
    const shelf = angGet(angShelf);
    base -= 33.7 * (1 - Math.exp(sd / 62)) * smoothstep(0, -shelf * 2.4, sd) * bed;
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
    // 中スケールの起伏（λ 130 / 65 m）。この帯が空いていて斜面が「粘土」に見えていた。
    // 岸から 60m 以内は 0（湖・岸線・開始地点は変えない）
    const midT = smoothstep(60, 300, sd);
    if (midT > 0) base += (5.5 * nz(x * 0.0077 + 6.3, z * 0.0077 - 3.1) + 2.2 * nz(x * 0.0154 - 1.9, z * 0.0154 + 7.4)) * midT;
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
    let amp = (320 + 360 * northness * northness) * angGet(angMassif) * TUNE.amp;
    amp *= 1 + 0.24 * smoothstep(0.86, 1.0, dotPeak);
    const valleyCut = smoothstep(0.955, 0.993, dotValley) + 0.8 * smoothstep(0.965, 0.995, dotValley2);
    amp *= 1 - 0.72 * Math.min(1, valleyCut);

    // 尾根: 東西に走る走向（x を引き伸ばす）。ドメインワープで蛇行させる
    const wx = 300 * nz(x * 0.00052 + 7.1, z * 0.00052 + 3.3);
    const wz = 300 * nz(x * 0.00052 - 2.7, z * 0.00052 + 9.9);
    const px = (x + wx) * 0.00048 + 0.5, pz = (z + wz) * 0.00078 + 0.9;
    const sharp = ridgedBoth(px, pz, 5);
    const round = ridgeRound;
    // 0.45 → 0.62: 稜線を鋭く（山が「団子」に見えていた）。TUNE.ridge は実験室の「尾根の鋭さ」
    let sharpness = (0.62 + 0.38 * smoothstep(-0.35, 0.45, nz(x * 0.0008 + 2.9, z * 0.0008 + 8.8))) * TUNE.ridge;
    sharpness = sharpness < 0 ? 0 : sharpness > 1.6 ? 1.6 : sharpness;
    let m = round + (sharp - round) * sharpness;
    m = m < 0 ? 0 : m > 1 ? 1 : m; // sharpness を 1 より上へ振ったときの外挿を止める
    m = m * m * (1.9 - 0.9 * m); // 谷底を締め、山頂は残す

    // 山腹を流れ下る谷筋（北側では南北に、東西側では東西に伸びた溝）。稜線と裾は残す
    const flank = smoothstep(0.1, 0.4, m) * (1 - smoothstep(0.62, 0.95, m));
    if (flank > 0.02) {
      const gN = 1 - Math.abs(nz(x * 0.011 + 2.0, z * 0.0036 + 5.0));
      const gE = 1 - Math.abs(nz(x * 0.0036 + 8.0, z * 0.011 + 1.0));
      const g1 = sa * sa * gN + ca * ca * gE;
      const g4 = g1 * g1 * g1 * g1; // ^3 → ^4: 溝を細く深く（幅の広い皿ではなく谷にする）
      m -= 0.15 * g4 * flank;
    }

    mtn = m * amp * mtnMask;
    // 支尾根の族（λ 90 / 45 m、振幅 17 / 8 m）。稜線から下る小さな尾根と、その間の凹み。
    // 丸い山腹に「光の面」と「陰の面」の縞ができて、団子が山になる
    const spurT = smoothstep(0.10, 0.46, m) * mtnMask;
    if (spurT > 0.01) {
      const r1 = 1 - Math.abs(nz(x * 0.0111 + 3.7, z * 0.0111 + 8.3));
      const r2 = 1 - Math.abs(nz(x * 0.0222 - 5.1, z * 0.0222 + 2.4));
      mtn += ((r1 * r1 - 0.34) * 17 + (r2 * r2 - 0.34) * 8) * spurT;
    }
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

/** 直近の heightAt() の3成分（base / mtn / fine）と岸線からの符号付き距離。UI の数式パネルなどが使う。 */
export function heightPartsAt(x: number, z: number): { h: number; base: number; mtn: number; fine: number; shore: number } {
  const h = heightAt(x, z);
  return { h, base: partBase, mtn: partMtn, fine: partFine, shore: partShore };
}

// float → half float（three の DataUtils.toHalfFloat と同じ結果。Worker でも使えるよう自前で持つ）
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
export function toHalfFloat(v: number): number {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >> 13);
}

/**
 * heightAt() を行 j0..j1（j1 は含まない）だけ焼く。Worker で分担して焼くための部品。
 * data の行 (j − dataRow0) に書く（部分配列に焼くときは dataRow0 = j0）。戻り値はその範囲の最小・最大。
 * parts を渡すと、texel ごとに (mtn, base, fine, shore±500) を half float で書く（Heightmap.parts の元）。
 */
export function bakeHeightRows(
  data: Float32Array,
  res: number,
  j0: number,
  j1: number,
  dataRow0 = 0,
  parts?: Uint16Array,
): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let j = j0; j < j1; j++) {
    const z = (j / res - 0.5) * WORLD.size;
    const row = (j - dataRow0) * res;
    for (let i = 0; i < res; i++) {
      const x = (i / res - 0.5) * WORLD.size;
      const h = heightAt(x, z);
      const k = row + i;
      data[k] = h;
      if (h < min) min = h;
      if (h > max) max = h;
      if (parts) {
        parts[k * 4] = toHalfFloat(partMtn);
        parts[k * 4 + 1] = toHalfFloat(partBase);
        parts[k * 4 + 2] = toHalfFloat(partFine);
        parts[k * 4 + 3] = toHalfFloat(partShore < -500 ? -500 : partShore > 500 ? 500 : partShore);
      }
    }
  }
  return { min, max };
}

/** 開始地点: 南岸の草地。湖越しに北の山脈を見る。 */
export function startPosition(): { x: number; z: number; yaw: number } {
  // 岸線から +18m ほど陸側
  const a = Math.PI / 2; // +Z
  const r = shoreRadius(Math.cos(a) * 10, Math.sin(a) * 10) + 18;
  return { x: 0, z: r, yaw: 0 };
}
