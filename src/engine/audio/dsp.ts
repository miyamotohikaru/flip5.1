// 純粋な合成器と数値解析。DOM に依存しない（Node でもそのまま動く）。
// ブラウザ側（resources.ts / 各層）はここで作った Float32Array を AudioBuffer に流し込む。
// 音声ファイルは一切使わない――風も雨も雷も、全部ここの関数と AudioNode から生える。
import { Rng } from "./rng";

export type F32 = Float32Array<ArrayBuffer>;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const dB = (v: number) => Math.pow(10, v / 20);
export const toDb = (v: number) => (v > 1e-12 ? 20 * Math.log10(v) : -240);

export function normalizePeak(x: F32, peak = 0.95): F32 {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  if (m > 0) {
    const s = peak / m;
    for (let i = 0; i < x.length; i++) x[i] *= s;
  }
  return x;
}

/** [min, max] → [0, 1] に伸ばす（制御信号の振れ幅を使い切る） */
export function normalize01(x: F32): F32 {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < mn) mn = x[i];
    if (x[i] > mx) mx = x[i];
  }
  const s = mx > mn ? 1 / (mx - mn) : 0;
  for (let i = 0; i < x.length; i++) x[i] = (x[i] - mn) * s;
  return x;
}

export function rmsOf(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
}

/** 白色雑音 [-1, 1] */
export function whiteNoise(n: number, seed: number): F32 {
  const out = new Float32Array(n);
  const r = new Rng(seed, 1);
  for (let i = 0; i < n; i++) out[i] = r.next() * 2 - 1;
  return out;
}

/** ピンク雑音（Paul Kellet の近似）。ピーク 0.95 */
export function pinkNoise(n: number, seed: number): F32 {
  const out = new Float32Array(n);
  const r = new Rng(seed, 2);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return normalizePeak(out, 0.95);
}

/**
 * ゆっくり変わる決定的な制御信号 [0, 1]。周期的（ループの継ぎ目なし）。
 * cell = 一番大きな山の長さ（サンプル）。octaves を重ねるほど細かい揺らぎが乗る。
 */
export function smoothNoise(n: number, seed: number, cell: number, octaves = 3, gain = 0.5): F32 {
  const out = new Float32Array(n);
  let amp = 1, norm = 0, c = cell;
  for (let o = 0; o < octaves; o++) {
    const cells = Math.max(2, Math.round(n / c));
    const r = new Rng(seed, 101 + o);
    const lat = new Float32Array(cells);
    for (let i = 0; i < cells; i++) lat[i] = r.next();
    for (let i = 0; i < n; i++) {
      const p = (i / n) * cells;
      const i0 = Math.floor(p) % cells, i1 = (i0 + 1) % cells;
      const f = p - Math.floor(p);
      const s = f * f * (3 - 2 * f);
      out[i] += amp * (lat[i0] + (lat[i1] - lat[i0]) * s);
    }
    norm += amp;
    amp *= gain;
    c /= 2;
  }
  for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}

/** 形を尖らせる（突風は「たまに強い」）。[0,1] → [0,1] */
export function shapePow(x: F32, k: number): F32 {
  for (let i = 0; i < x.length; i++) x[i] = Math.pow(clamp01(x[i]), k);
  return x;
}

/** 岸の波の包絡 [0, 1]。「寄せて…引く」を不揃いな間隔で。周期的 */
export function waveEnvelope(n: number, sr: number, seed: number, meanPeriod = 6.5): F32 {
  const out = new Float32Array(n);
  const r = new Rng(seed, 5);
  let t = r.range(0, meanPeriod) * sr;
  const limit = n + sr * meanPeriod * 2;
  while (t < limit) {
    const a = r.range(0.5, 1.0);
    const rise = sr * r.range(0.5, 1.4), fall = sr * r.range(1.4, 3.4);
    const len = Math.floor(rise + fall);
    for (let k = 0; k < len; k++) {
      const v = k < rise ? Math.pow(k / rise, 1.6) : Math.exp(-(k - rise) / (fall / 3.2));
      out[(Math.floor(t) + k) % n] += a * v;
    }
    t += sr * meanPeriod * r.range(0.5, 1.5);
  }
  // 細かい泡立ち
  const fl = smoothNoise(n, seed + 7, Math.max(8, Math.floor(sr * 0.09)), 2);
  let m = 0;
  for (let i = 0; i < n; i++) {
    out[i] = (0.1 + out[i]) * (0.7 + 0.3 * fl[i]);
    if (out[i] > m) m = out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= m;
  return out;
}

export type IROpts = {
  /** −60dB までの秒数 */
  decay: number;
  lpStart: number;
  lpEnd: number;
  hp?: number;
  early?: number;
  predelay?: number;
};

/** 残響のインパルス応答（合成）。[L, R]。ピーク 1 */
export function impulseResponse(sr: number, seconds: number, seed: number, o: IROpts): F32[] {
  const n = Math.floor(sr * seconds);
  const pre = Math.floor((o.predelay ?? 0) * sr);
  const er = new Rng(seed, 30);
  const early: { t: number; a: number }[] = [];
  const cnt = o.early ?? 6;
  for (let k = 0; k < cnt; k++) early.push({ t: er.range(0.006, 0.09), a: er.range(0.2, 0.6) });
  const chans: F32[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const r = new Rng(seed, 20 + ch);
    const x = new Float32Array(n);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      x[i] = (r.next() * 2 - 1) * Math.exp((-6.9078 * t) / o.decay);
    }
    const bl = Math.floor(sr * 0.004);
    for (const e of early) {
      const i0 = pre + Math.floor(e.t * sr);
      const a = e.a * r.range(0.75, 1.25);
      for (let m = 0; m < bl && i0 + m < n; m++) x[i0 + m] += a * (r.next() * 2 - 1) * (1 - m / bl);
    }
    // 時間とともに暗くなるローパス（一次を 2 段 ＝ 12dB/oct）
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const fc = o.lpStart * Math.pow(o.lpEnd / o.lpStart, i / n);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      y1 += a * (x[i] - y1);
      y2 += a * (y1 - y2);
      x[i] = y2;
    }
    onePoleHP(x, o.hp ?? 40, sr);
    normalizePeak(x, 1);
    chans.push(x);
  }
  return chans;
}

export type GrainKind = "hiss" | "leaf" | "ground" | "water" | "tick" | "gravel";

/**
 * 雨粒の列（ポアソン過程）。kind ごとに一粒の音が違う。周期的（末尾を越えた粒は先頭に回る）。
 *  hiss   … 極短いノイズ粒。密度を上げると「ザー」の芯になる
 *  leaf   … 葉に当たる高い減衰正弦（2.5〜7kHz）＋クリック
 *  ground … 地面・草に当たる柔らかい「パタ」（1.1〜2.6kHz）
 *  water  … 水面の気泡（周波数が上がるチャープ＝ミンナート共鳴）
 *  tick   … 裏返しの「数字が現れる」カチカチ
 *  gravel … 砂利のこすれ（足音用の粒）
 */
export function rainGrains(sr: number, seconds: number, seed: number, kind: GrainKind, density: number): F32 {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const r = new Rng(seed, 77);
  const count = Math.floor(density * seconds);
  const TWO_PI = 2 * Math.PI;
  for (let g = 0; g < count; g++) {
    const t0 = Math.floor(r.next() * n);
    let amp = r.logRange(0.06, 1);
    if (kind !== "hiss" && r.chance(0.07)) amp *= 1.8;
    switch (kind) {
      case "hiss": {
        const len = Math.max(4, Math.floor(sr * r.range(0.0003, 0.0015)));
        for (let k = 0; k < len; k++) out[(t0 + k) % n] += amp * (r.next() * 2 - 1) * (1 - k / len);
        break;
      }
      case "leaf":
      case "tick": {
        const f = kind === "leaf" ? r.logRange(2500, 7000) : r.logRange(3000, 6500);
        const tau = kind === "leaf" ? r.range(0.0015, 0.005) : r.range(0.0005, 0.0012);
        const len = Math.floor(sr * tau * 5);
        const w = (TWO_PI * f) / sr;
        for (let k = 0; k < len; k++) {
          let v = Math.sin(w * k) * Math.exp(-k / (sr * tau));
          if (k < 6) v += 0.5 * (r.next() * 2 - 1);
          out[(t0 + k) % n] += amp * v;
        }
        break;
      }
      case "ground": {
        const f = r.logRange(1100, 2600);
        const tau = r.range(0.003, 0.007);
        const len = Math.floor(sr * tau * 5);
        const w = (TWO_PI * f) / sr;
        for (let k = 0; k < len; k++) {
          const e = Math.exp(-k / (sr * tau));
          const v = 0.55 * Math.sin(w * k) * e + 0.45 * (r.next() * 2 - 1) * e * e;
          out[(t0 + k) % n] += amp * v;
        }
        break;
      }
      case "water": {
        const f0 = r.logRange(500, 2200);
        const rise = r.range(0.3, 0.8);
        const tau = r.range(0.006, 0.02);
        const len = Math.floor(sr * tau * 4);
        let ph = 0;
        for (let k = 0; k < len; k++) {
          const f = f0 * (1 + rise * (k / len));
          ph += (TWO_PI * f) / sr;
          let v = 0.9 * Math.sin(ph) * Math.exp(-k / (sr * tau));
          if (k < sr * 0.001) v += 0.35 * (r.next() * 2 - 1);
          out[(t0 + k) % n] += amp * v;
        }
        break;
      }
      case "gravel": {
        const len = Math.max(4, Math.floor(sr * r.range(0.001, 0.004)));
        const f = r.logRange(1800, 5000);
        const w = (TWO_PI * f) / sr;
        for (let k = 0; k < len; k++) {
          const e = 1 - k / len;
          out[(t0 + k) % n] += amp * e * (0.6 * (r.next() * 2 - 1) + 0.4 * Math.sin(w * k));
        }
        break;
      }
    }
  }
  return normalizePeak(out, 0.95);
}

/** 雷鳴の包絡 [0, 1]。立ち上がり → 減衰に、複数の「転がり」が乗る。末尾は 0 */
export function thunderCurve(n: number, seed: number, closeness: number): F32 {
  const out = new Float32Array(n);
  const r = new Rng(seed, 9);
  const attack = 0.012 + 0.07 * (1 - closeness);
  const tau = 0.22 + 0.16 * (1 - closeness);
  const bumps = 3 + r.int(5);
  const bl: { p: number; w: number; h: number }[] = [];
  for (let j = 0; j < bumps; j++) {
    const p = r.range(0.08, 0.85);
    bl.push({ p, w: r.range(0.02, 0.08), h: r.range(0.35, 1.1) * Math.exp(-p / 0.6) });
  }
  const fl = smoothNoise(n, seed + 1, Math.max(4, n / 40), 2);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let v = x < attack ? Math.pow(x / attack, 1.5) : Math.exp(-(x - attack) / tau);
    for (const b of bl) {
      const d = (x - b.p) / b.w;
      v += b.h * Math.exp(-d * d);
    }
    v *= 0.35 + 0.65 * fl[i];
    v *= 1 - smooth(0.88, 1, x); // 末尾は静かに
    out[i] = v;
    if (v > m) m = v;
  }
  for (let i = 0; i < n; i++) out[i] /= m;
  out[n - 1] = 0;
  return out;
}

/**
 * 虫の鳴き方の包絡 [0, 1]（制御レート sr、周期的）。
 *  cricket … コオロギ: 3〜6 発の短いパルス（26〜36Hz）がひと固まり、固まりの間隔は不揃い
 *  bell    … スズムシ: 「リーン」（60Hz 前後の震え）を 0.5〜1.5 秒つづけて、間を置く
 */
export function cricketPattern(sr: number, seed: number, kind: "cricket" | "bell"): F32 {
  const r = new Rng(seed, 12);
  const seconds = kind === "cricket" ? r.range(6, 11) : r.range(8, 14);
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  let t = 0;
  if (kind === "cricket") {
    const rate = r.range(26, 36);
    const period = sr / rate;
    const on = Math.floor(period * 0.5);
    while (t < n) {
      const pulses = 5 + r.int(5);
      const a = r.range(0.7, 1);
      for (let p = 0; p < pulses; p++) {
        const s0 = Math.floor(t + p * period);
        for (let k = 0; k < on; k++) {
          const i = s0 + k;
          if (i >= n) break;
          out[i] = a * 0.5 * (1 - Math.cos((2 * Math.PI * k) / on)); // 上げ下げの丸いパルス
        }
      }
      t += pulses * period + sr * r.range(0.12, 0.45);
    }
  } else {
    const am = r.range(52, 66);
    while (t < n) {
      const on = Math.floor(sr * r.range(0.5, 1.5));
      const att = Math.floor(sr * 0.12), rel = Math.floor(sr * 0.16);
      const a = r.range(0.7, 1);
      for (let k = 0; k < on; k++) {
        const i = Math.floor(t) + k;
        if (i >= n) break;
        const e = Math.min(1, k / att, (on - k) / rel);
        const trem = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((2 * Math.PI * am * k) / sr));
        out[i] = a * e * trem;
      }
      t += on + sr * r.range(0.25, 0.9);
    }
  }
  return out;
}

/** ビットクラッシュ風の階段カーブ（WaveShaper 用） */
export function crusherCurve(levels: number, n = 4096): F32 {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

/** ソフトクリップ（マスターの最後の砦）。|out| ≤ ceiling。knee までは素通し */
export function softClipCurve(ceiling = 0.85, knee = 0.6, n = 4096): F32 {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee));
    c[i] = Math.sign(x) * Math.min(y, ceiling);
  }
  return c;
}

export function onePoleLP(x: F32, hz: number, sr: number): F32 {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}

export function onePoleHP(x: F32, hz: number, sr: number): F32 {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    x[i] -= y;
  }
  return x;
}

// ---------------------------------------------------------------------------
// 数値解析（確認用）。RMS・ピーク・帯域配分・時間変動・クリック検出。

export type Bands = { sub: number; low: number; lowmid: number; mid: number; high: number; air: number };

export type Analysis = {
  rmsDb: number;
  peakDb: number;
  crestDb: number;
  /** 帯域ごとのエネルギー比 0..1（合計 1） */
  bands: Bands;
  /** スペクトル重心 Hz */
  centroid: number;
  /** 100ms ごとの RMS の変動係数（0 = 一定のシャー音） */
  texture: number;
  /** 隣接サンプル差の最大（1 を超えたらクリックを疑う） */
  maxStep: number;
  /** 250ms ごとの RMS dB */
  env250: number[];
  /** L/R の相関（1 = モノ、0 = 無相関） */
  stereo: number;
};

/** 基数 2 の FFT（その場）。長さは 2 のべき乗 */
export function fft(re: F32, im: F32): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export function analyze(chs: F32[], sr: number, opts?: { skip?: number }): Analysis {
  const n = chs[0].length;
  const skip = Math.min(n - 1, Math.floor((opts?.skip ?? 0) * sr));
  let sum = 0, peak = 0, maxStep = 0;
  for (const c of chs) {
    let prev = 0;
    for (let i = skip; i < n; i++) {
      const v = c[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      const d = Math.abs(v - prev);
      if (d > maxStep) maxStep = d;
      prev = v;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, (n - skip) * chs.length));
  // 帯域: 4096 点の平均パワースペクトル
  const N = 4096;
  const re = new Float32Array(N), im = new Float32Array(N);
  const pow = new Float64Array(N / 2);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  let frames = 0;
  const hop = 2048;
  const maxFrames = 400;
  const stride = Math.max(hop, Math.floor((n - skip - N) / maxFrames / hop) * hop || hop);
  for (let start = skip; start + N <= n; start += stride) {
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (const c of chs) v += c[start + i];
      re[i] = (v / chs.length) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  const bands: Bands = { sub: 0, low: 0, lowmid: 0, mid: 0, high: 0, air: 0 };
  let total = 0, cent = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    const p = pow[k];
    total += p;
    cent += p * f;
    if (f < 80) bands.sub += p;
    else if (f < 300) bands.low += p;
    else if (f < 1000) bands.lowmid += p;
    else if (f < 3000) bands.mid += p;
    else if (f < 8000) bands.high += p;
    else bands.air += p;
  }
  if (total > 0) {
    for (const k of Object.keys(bands) as (keyof Bands)[]) bands[k] /= total;
    cent /= total;
  }
  // 100ms の RMS の変動
  const w100 = Math.floor(sr * 0.1);
  const seg: number[] = [];
  for (let s = skip; s + w100 <= n; s += w100) {
    let e = 0;
    for (const c of chs) for (let i = s; i < s + w100; i++) e += c[i] * c[i];
    seg.push(Math.sqrt(e / (w100 * chs.length)));
  }
  let mean = 0;
  for (const v of seg) mean += v;
  mean /= Math.max(1, seg.length);
  let vari = 0;
  for (const v of seg) vari += (v - mean) * (v - mean);
  const texture = mean > 1e-9 ? Math.sqrt(vari / Math.max(1, seg.length)) / mean : 0;
  // 250ms 包絡
  const w250 = Math.floor(sr * 0.25);
  const env250: number[] = [];
  for (let s = 0; s + w250 <= n; s += w250) {
    let e = 0;
    for (const c of chs) for (let i = s; i < s + w250; i++) e += c[i] * c[i];
    env250.push(Math.round(toDb(Math.sqrt(e / (w250 * chs.length))) * 10) / 10);
  }
  // ステレオ相関
  let stereo = 1;
  if (chs.length >= 2) {
    let ab = 0, aa = 0, bb = 0;
    const L = chs[0], R = chs[1];
    for (let i = skip; i < n; i++) {
      ab += L[i] * R[i];
      aa += L[i] * L[i];
      bb += R[i] * R[i];
    }
    stereo = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1;
  }
  void frames;
  return {
    rmsDb: Math.round(toDb(rms) * 10) / 10,
    peakDb: Math.round(toDb(peak) * 10) / 10,
    crestDb: Math.round((toDb(peak) - toDb(rms)) * 10) / 10,
    bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as Bands,
    centroid: Math.round(cent),
    texture: Math.round(texture * 1000) / 1000,
    maxStep: Math.round(maxStep * 1000) / 1000,
    env250,
    stereo: Math.round(stereo * 1000) / 1000,
  };
}
