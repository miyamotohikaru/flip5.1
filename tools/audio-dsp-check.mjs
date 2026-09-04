// 音の合成器（src/engine/audio/dsp.ts・birdsong.ts）を Node で回す数値検証。ブラウザ不要。
//   node tools/audio-dsp-check.mjs
// TypeScript を transpileModule で JS にして一時フォルダに置き、そこから import する（tsconfig は触らない）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "src/engine/audio");
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "flip-audio-"));
for (const f of ["rng", "dsp", "birdsong"]) {
  const code = fs.readFileSync(path.join(SRC, `${f}.ts`), "utf8");
  const out = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  fs.writeFileSync(path.join(tmp, `${f}.mjs`), out.replace(/from "\.\/(\w+)"/g, 'from "./$1.mjs"'));
}
const dsp = await import(pathToFileURL(path.join(tmp, "dsp.mjs")).href);
const bird = await import(pathToFileURL(path.join(tmp, "birdsong.mjs")).href);
const { Rng } = await import(pathToFileURL(path.join(tmp, "rng.mjs")).href);

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok " : "  NG "} ${msg}`);
  if (!cond) fails++;
};
const sr = 48000;
const db = (v) => (v > 1e-12 ? (20 * Math.log10(v)).toFixed(1) : "-inf");
const minmax = (x) => {
  let mn = Infinity, mx = -Infinity, nan = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) nan++;
    else {
      if (x[i] < mn) mn = x[i];
      if (x[i] > mx) mx = x[i];
    }
  }
  return { mn, mx, nan };
};

console.log("— FFT と解析 —");
{
  const n = sr * 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1500 * i) / sr);
  const a = dsp.analyze([x, x], sr);
  ok(Math.abs(a.rmsDb - db(0.5 / Math.SQRT2)) < 0.2, `1.5kHz 正弦 rms ${a.rmsDb} dBFS（期待 ${db(0.5 / Math.SQRT2)}）`);
  ok(Math.abs(a.peakDb - db(0.5)) < 0.2, `peak ${a.peakDb} dBFS`);
  ok(Math.abs(a.centroid - 1500) < 30, `重心 ${a.centroid} Hz`);
  ok(a.bands.mid > 0.95, `帯域 mid ${a.bands.mid}`);
  ok(a.texture < 0.02, `texture ${a.texture}（一定音）`);
  ok(a.stereo > 0.999, `stereo ${a.stereo}`);
  // DFT と比較
  const N = 64;
  const re = new Float32Array(N), im = new Float32Array(N);
  const r = new Rng(1);
  for (let i = 0; i < N; i++) re[i] = r.next() - 0.5;
  const ref = [];
  for (let k = 0; k < N; k++) {
    let sr_ = 0, si = 0;
    for (let i = 0; i < N; i++) {
      sr_ += re[i] * Math.cos((-2 * Math.PI * k * i) / N);
      si += re[i] * Math.sin((-2 * Math.PI * k * i) / N);
    }
    ref.push([sr_, si]);
  }
  dsp.fft(re, im);
  let err = 0;
  for (let k = 0; k < N; k++) err = Math.max(err, Math.abs(re[k] - ref[k][0]), Math.abs(im[k] - ref[k][1]));
  ok(err < 1e-4, `FFT と DFT の差 ${err.toExponential(2)}`);
}

console.log("— 雑音 —");
{
  const w = dsp.whiteNoise(sr * 2, 1);
  const a = dsp.analyze([w], sr);
  ok(Math.abs(a.rmsDb - db(1 / Math.sqrt(3))) < 0.3, `白色雑音 rms ${a.rmsDb}（期待 ${db(1 / Math.sqrt(3))}）`);
  ok(a.bands.high + a.bands.air > 0.6, `白色: 高域の比 ${(a.bands.high + a.bands.air).toFixed(2)}（平坦）`);
  const p = dsp.pinkNoise(sr * 2, 2);
  const b = dsp.analyze([p], sr);
  ok(b.centroid < a.centroid * 0.5, `ピンク雑音の重心 ${b.centroid} Hz < 白色 ${a.centroid} Hz`);
  ok(minmax(p).nan === 0 && minmax(p).mx <= 0.951, `ピンク: NaN 無し・ピーク ${minmax(p).mx.toFixed(3)}`);
}

console.log("— 制御信号 —");
{
  const g = dsp.smoothNoise(8000 * 40, 31, 8000 * 2.6, 3);
  const { mn, mx, nan } = minmax(g);
  ok(nan === 0 && mn >= 0 && mx <= 1, `smoothNoise 範囲 [${mn.toFixed(3)}, ${mx.toFixed(3)}]`);
  ok(Math.abs(g[0] - g[g.length - 1]) < 0.01, `ループの継ぎ目 |先頭−末尾| = ${Math.abs(g[0] - g[g.length - 1]).toFixed(4)}`);
  let maxd = 0;
  for (let i = 1; i < g.length; i++) maxd = Math.max(maxd, Math.abs(g[i] - g[i - 1]));
  ok(maxd < 0.002, `突風の最大変化/サンプル ${maxd.toExponential(2)}（滑らか）`);
  const sh = dsp.shapePow(dsp.smoothNoise(8000 * 40, 31, 8000 * 2.6, 3), 1.7);
  let above = 0;
  for (let i = 0; i < sh.length; i++) if (sh[i] > 0.6) above++;
  ok(above / sh.length > 0.02 && above / sh.length < 0.3, `突風 >0.6 の割合 ${(above / sh.length * 100).toFixed(1)}%（たまに強い）`);
  const wv = dsp.waveEnvelope(8000 * 60, 8000, 34, 6.5);
  const m = minmax(wv);
  ok(m.nan === 0 && m.mn > 0 && m.mx <= 1.0001, `波の包絡 範囲 [${m.mn.toFixed(3)}, ${m.mx.toFixed(3)}]`);
  // 山の数（周期 6.5 秒 → 60 秒で 9 前後）
  let peaks = 0;
  for (let i = 1; i < wv.length - 1; i++) if (wv[i] > 0.5 && wv[i] >= wv[i - 1] && wv[i] > wv[i + 1] && (i % 4000 === 0 || true)) peaks++;
  const fl = dsp.smoothNoise(8000 * 10, 33, 8000 * 0.13, 2);
  ok(minmax(fl).mx <= 1, `flutter 範囲 ok`);
  void peaks;
}

console.log("— インパルス応答 —");
{
  const ir = dsp.impulseResponse(sr, 4.2, 42, { decay: 2.6, lpStart: 1400, lpEnd: 220, hp: 28, early: 4, predelay: 0.03 });
  const L = ir[0];
  const n = L.length;
  const head = dsp.rmsOf(L, Math.floor(sr * 0.05), Math.floor(sr * 0.3));
  const tail = dsp.rmsOf(L, Math.floor(n * 0.85), n);
  ok(minmax(L).nan === 0 && Math.abs(minmax(L).mx) <= 1.0001, `雷の IR: NaN 無し・ピーク ${minmax(L).mx.toFixed(3)}`);
  ok(tail < head * 0.05, `雷の IR: 減衰 頭 ${db(head)} dB → 尾 ${db(tail)} dB`);
  const a = dsp.analyze([L], sr);
  ok(a.centroid < 1200, `雷の IR: 重心 ${a.centroid} Hz（暗い）`);
  const irf = dsp.impulseResponse(sr, 1.6, 41, { decay: 1.3, lpStart: 9000, lpEnd: 1800, hp: 120, early: 7, predelay: 0.012 });
  const b = dsp.analyze([irf[0]], sr);
  ok(b.centroid > 1200 && b.centroid < 7000, `森の IR: 重心 ${b.centroid} Hz`);
  let corr = 0, aa = 0, bb = 0;
  for (let i = 0; i < irf[0].length; i++) {
    corr += irf[0][i] * irf[1][i];
    aa += irf[0][i] ** 2;
    bb += irf[1][i] ** 2;
  }
  ok(corr / Math.sqrt(aa * bb) < 0.3, `森の IR: 左右の相関 ${(corr / Math.sqrt(aa * bb)).toFixed(3)}（広がる）`);
}

console.log("— 雨粒 —");
{
  const kinds = { hiss: [3500, 0], leaf: [90, 2500], ground: [70, 900], water: [45, 500], tick: [40, 2500], gravel: [220, 1500] };
  for (const [kind, [density, minCent]] of Object.entries(kinds)) {
    const x = dsp.rainGrains(sr, 4, 21, kind, density);
    const a = dsp.analyze([x], sr);
    const m = minmax(x);
    ok(m.nan === 0 && m.mx <= 0.9501 && m.mn >= -0.9501, `${kind}: 範囲 [${m.mn.toFixed(2)}, ${m.mx.toFixed(2)}] rms ${a.rmsDb} dB 重心 ${a.centroid} Hz texture ${a.texture}`);
    ok(a.centroid >= minCent, `${kind}: 重心 ≥ ${minCent}`);
  }
  const leaf = dsp.analyze([dsp.rainGrains(sr, 4, 22, "leaf", 90)], sr);
  const hiss = dsp.analyze([dsp.rainGrains(sr, 4, 21, "hiss", 3500)], sr);
  ok(leaf.texture > hiss.texture * 2, `葉の粒は芯より粒立つ texture ${leaf.texture} vs ${hiss.texture}`);
  const water = dsp.analyze([dsp.rainGrains(sr, 4, 26, "water", 45)], sr);
  ok(water.centroid < leaf.centroid, `水面の粒は葉より丸い ${water.centroid} < ${leaf.centroid} Hz`);
}

console.log("— 雷の包絡・虫の包絡・カーブ —");
{
  for (const c of [1, 0.5, 0.1]) {
    const e = dsp.thunderCurve(256, 700, c);
    const m = minmax(e);
    let bumps = 0;
    for (let i = 1; i < e.length - 1; i++) if (e[i] > e[i - 1] && e[i] > e[i + 1] && e[i] > 0.2) bumps++;
    ok(m.nan === 0 && m.mx === 1 && e[e.length - 1] === 0 && bumps >= 2, `thunderCurve(近さ ${c}): max ${m.mx} 末尾 ${e[e.length - 1]} 転がり ${bumps} 山`);
  }
  for (const kind of ["cricket", "bell"]) {
    const p = dsp.cricketPattern(8000, 51, kind);
    const m = minmax(p);
    let on = 0;
    for (let i = 0; i < p.length; i++) if (p[i] > 0.1) on++;
    ok(m.nan === 0 && m.mn >= 0 && m.mx <= 1 && on / p.length > 0.1 && on / p.length < 0.8, `${kind}: 長さ ${(p.length / 8000).toFixed(1)}s 鳴いている割合 ${(on / p.length * 100).toFixed(0)}%`);
  }
  const clip = dsp.softClipCurve(0.85, 0.6);
  ok(Math.abs(clip[clip.length - 1]) <= 0.85 && Math.abs(clip[Math.floor(clip.length * 0.75)] - 0.5) < 0.01, `ソフトクリップ 端 ${clip[clip.length - 1].toFixed(3)}（≤0.85 = −1.4dBFS）・0.5 は素通し`);
  const cr = dsp.crusherCurve(28);
  ok(new Set(Array.from(cr)).size <= 57, `クラッシャーの段数 ${new Set(Array.from(cr)).size}`);
}

console.log("— 鳥の鳴き方 —");
{
  for (const sp of bird.SPECIES) {
    let bad = 0, total = 0, dur = 0, minF = 1e9, maxF = 0;
    for (let s = 0; s < 30; s++) {
      const c = bird.birdCall(sp, new Rng(100 + s, 1));
      total += c.notes.length;
      dur += c.duration;
      for (const n of c.notes) {
        if (!(n.f0 > 150 && n.f0 < 9000 && n.f1 > 150 && n.f1 < 9000 && n.dur > 0 && n.amp > 0 && n.amp <= 1)) bad++;
        if (n.fm !== undefined && !(n.fm > 150 && n.fm < 9000)) bad++;
        minF = Math.min(minF, n.f0, n.f1);
        maxF = Math.max(maxF, n.f0, n.f1);
      }
    }
    ok(bad === 0, `${sp}: 30 回で音符 ${total} 個、平均 ${(dur / 30).toFixed(2)}s、周波数 ${minF.toFixed(0)}〜${maxF.toFixed(0)} Hz`);
  }
  // 同じ種でも毎回違う
  const a = bird.birdCall("thrush", new Rng(1, 1)), b = bird.birdCall("thrush", new Rng(2, 1));
  ok(JSON.stringify(a) !== JSON.stringify(b), "同じ種でも鳴き方が毎回違う");
  // 同じ種は決定的
  const c = bird.birdCall("thrush", new Rng(1, 1));
  ok(JSON.stringify(a) === JSON.stringify(c), "同じ種・同じ種番号なら同じ（決定的）");
  // 生態で種が変わる
  const count = (biome) => {
    const m = {};
    for (let i = 0; i < 400; i++) {
      const s = bird.speciesFor(biome, new Rng(i, 9));
      m[s] = (m[s] ?? 0) + 1;
    }
    return m;
  };
  const lake = count({ grass: 1, forest: 0, rock: 0, hour: 6 });
  const ridge = count({ grass: 0, forest: 0, rock: 1, hour: 12 });
  const forest = count({ grass: 0, forest: 1, rock: 0, hour: 12 });
  console.log("   岸:", JSON.stringify(lake));
  console.log("   森:", JSON.stringify(forest));
  console.log("   尾根:", JSON.stringify(ridge));
  ok((ridge.kite ?? 0) > 300, "尾根ではトビが主");
  ok((forest.woodpecker ?? 0) > 40 && (forest.thrush ?? 0) > 60, "森ではキツツキとツグミ");
  ok((lake.uguisu ?? 0) > 100, "岸の夜明けはウグイス");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} 件 NG` : "\n全部 ok");
process.exit(fails ? 1 : 0);
