// 音の数値検証（ヘッドレス Chrome の本物の WebAudio で OfflineAudioContext レンダリング）。
//   FLIP_URL=http://localhost:3058 node tools/audio-probe.mjs            全シナリオ
//   FLIP_URL=... node tools/audio-probe.mjs --only wind                  名前に wind を含むものだけ
//   FLIP_URL=... node tools/audio-probe.mjs --json out.json              結果を JSON にも
//   FLIP_URL=... node tools/audio-probe.mjs --seconds 10
// window.__flip.audio.renderOffline(cfg) を叩き、層ごと・時刻ごと・天気ごとの RMS／ピーク／帯域配分／時間変動を表にする。
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const argv = process.argv.slice(2);
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const base = process.env.FLIP_URL ?? "http://localhost:3051";
const only = flag("only", null);
const SEC = Number(flag("seconds", 8));
const jsonOut = flag("json", null);

const start = [0, 360];
const forest = [180, 780];
const ridge = [-900, 1060];
const far = [0, 700];
const shore = [0, 345];
const inWater = [0, 320];

const steps = (surface, n = 6, from = 0.6, gap = 0.55, speed = 1) => Array.from({ length: n }, (_, i) => ({ t: from + i * gap, type: "step", surface, speed }));
const stepSegs = (n = 6, from = 0.6, gap = 0.55) => Array.from({ length: n }, (_, i) => ({ t0: from + i * gap, t1: from + i * gap + 0.45 }));

const S = [
  // 全体（マスター）: 時刻・天気
  { name: "all clear noon @start", hour: 12.2, weather: "clear", pos: start },
  { name: "all clear dawn @start", hour: 5.9, weather: "clear", pos: start },
  { name: "all clear golden @start", hour: 17.4, weather: "clear", pos: start },
  { name: "all clear night @start", hour: 23.5, weather: "clear", pos: start },
  { name: "all cloudy 14h @forest", hour: 14.5, weather: "cloudy", pos: forest },
  { name: "all mist dawn @shore", hour: 5.9, weather: "mist", pos: shore },
  { name: "all rain 15h @shore", hour: 15, weather: "rain", pos: shore },
  { name: "all storm 18h @ridge", hour: 18.2, weather: "storm", pos: ridge, events: [{ t: 1, type: "strike", distance: 500 }], seconds: 10 },
  { name: "all storm night @start", hour: 23.5, weather: "storm", pos: start, seconds: 10 },
  { name: "all flip view clear golden", hour: 17.4, weather: "clear", pos: start, flip: true },
  // 風
  { name: "wind clear 2m/s", hour: 12, weather: "clear", pos: start, solo: "wind" },
  { name: "wind cloudy 3.5m/s @forest", hour: 12, weather: "cloudy", pos: forest, solo: "wind" },
  { name: "wind rain 5m/s", hour: 12, weather: "rain", pos: start, solo: "wind" },
  { name: "wind storm 11m/s @ridge", hour: 12, weather: "storm", pos: ridge, solo: "wind", seconds: 12 },
  { name: "wind storm 11m/s +gust1", hour: 12, weather: "storm", pos: ridge, solo: "wind", gust: 1 },
  // 雨
  { name: "rain rain @shore", hour: 12, weather: "rain", pos: shore, solo: "rain" },
  { name: "rain rain @forest", hour: 12, weather: "rain", pos: forest, solo: "rain" },
  { name: "rain storm @start", hour: 12, weather: "storm", pos: start, solo: "rain" },
  { name: "rain clear (silent)", hour: 12, weather: "clear", pos: start, solo: "rain" },
  // 雷
  { name: "thunder near 300m", hour: 18, weather: "storm", pos: start, solo: "thunder", seconds: 12, events: [{ t: 0.5, type: "strike", distance: 300 }], segments: [{ t0: 1.3, t1: 1.6 }, { t0: 1.6, t1: 2.6 }, { t0: 3.5, t1: 5 }, { t0: 6, t1: 8 }, { t0: 9, t1: 11 }] },
  { name: "thunder far 2500m", hour: 18, weather: "storm", pos: start, solo: "thunder", seconds: 16, events: [{ t: 0.5, type: "strike", distance: 2500 }], segments: [{ t0: 7.5, t1: 8.5 }, { t0: 8.5, t1: 10 }, { t0: 10, t1: 12 }, { t0: 12, t1: 14 }] },
  { name: "thunder auto (no lightning obj)", hour: 18, weather: "storm", pos: start, solo: "thunder", seconds: 14 },
  // 水
  { name: "water shore (2m) clear", hour: 12, weather: "clear", pos: shore, solo: "water" },
  { name: "water start (18m) clear", hour: 12, weather: "clear", pos: start, solo: "water" },
  { name: "water far (300m) clear", hour: 12, weather: "clear", pos: far, solo: "water" },
  { name: "water shore storm", hour: 12, weather: "storm", pos: shore, solo: "water", seconds: 10 },
  { name: "water in-lake clear", hour: 12, weather: "clear", pos: inWater, solo: "water" },
  { name: "water shore yaw180", hour: 12, weather: "clear", pos: shore, yaw: 180, solo: "water" },
  // 足音
  { name: "foot grass x6", hour: 12, weather: "clear", pos: start, solo: "foot", events: steps("grass"), segments: stepSegs(), seconds: 5 },
  { name: "foot rock x6", hour: 12, weather: "clear", pos: start, solo: "foot", events: steps("rock"), segments: stepSegs(), seconds: 5 },
  { name: "foot sand x6", hour: 12, weather: "clear", pos: start, solo: "foot", events: steps("sand"), segments: stepSegs(), seconds: 5 },
  { name: "foot water x6", hour: 12, weather: "clear", pos: start, solo: "foot", events: steps("water"), segments: stepSegs(), seconds: 5 },
  { name: "foot grass sprint x6", hour: 12, weather: "clear", pos: start, solo: "foot", events: steps("grass", 6, 0.6, 0.4, 1.9), segments: stepSegs(6, 0.6, 0.4), seconds: 5 },
  // 鳥
  { name: "birds dawn chorus @start", hour: 5.9, weather: "clear", pos: start, solo: "birds", seconds: 16 },
  { name: "birds noon @forest", hour: 12.2, weather: "clear", pos: forest, solo: "birds", seconds: 16 },
  { name: "birds ridge 10h", hour: 10, weather: "clear", pos: ridge, solo: "birds", seconds: 16 },
  { name: "birds rain (fewer)", hour: 12.2, weather: "rain", pos: forest, solo: "birds", seconds: 16 },
  { name: "birds night (silent)", hour: 23.5, weather: "clear", pos: start, solo: "birds", seconds: 8 },
  // 虫
  { name: "insects night @start", hour: 23.5, weather: "clear", pos: start, solo: "insects", seconds: 10 },
  { name: "insects night @shore wet (frogs)", hour: 22, weather: "clear", pos: shore, solo: "insects", seconds: 12 },
  { name: "insects night storm (quiet)", hour: 23.5, weather: "storm", pos: start, solo: "insects", seconds: 8 },
  { name: "insects noon (silent)", hour: 12, weather: "clear", pos: start, solo: "insects", seconds: 6 },
  // パッド
  { name: "pad dawn", hour: 5.9, weather: "clear", pos: start, solo: "pad" },
  { name: "pad night", hour: 23.5, weather: "clear", pos: start, solo: "pad" },
  // UI・裏返し
  { name: "ui enter", hour: 12, weather: "clear", pos: start, solo: "ui", enter: true, seconds: 4, skip: 0 },
  { name: "ui shutter", hour: 12, weather: "clear", pos: start, solo: "ui", events: [{ t: 1, type: "shutter" }], seconds: 3, skip: 0, segments: [{ t0: 0.95, t1: 1.4 }] },
  { name: "ui flip wave on→hold", hour: 17.4, weather: "clear", pos: start, solo: "ui", events: [{ t: 0.5, type: "flip", on: true }], seconds: 11, skip: 0, segments: [{ t0: 1, t1: 2 }, { t0: 3, t1: 4 }, { t0: 5, t1: 6 }, { t0: 6.5, t1: 7.2 }, { t0: 9, t1: 11 }] },
  { name: "ui flip wave off", hour: 17.4, weather: "clear", pos: start, solo: "ui", flip: true, events: [{ t: 0.5, type: "flip", on: false }], seconds: 7, skip: 0, segments: [{ t0: 1, t1: 2 }, { t0: 3, t1: 4 }, { t0: 5.5, t1: 7 }] },
  { name: "all flip wave (mix)", hour: 17.4, weather: "clear", pos: start, events: [{ t: 0.5, type: "flip", on: true }], seconds: 9 },
  // 携帯（lite）
  { name: "all storm 18h lite(mid)", hour: 18.2, weather: "storm", pos: start, tier: "mid", seconds: 8 },
];

const targets = S.filter((s) => !only || s.name.includes(String(only)));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--headless=new", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 800, height: 500 },
});
const page = await browser.newPage();
const problems = [];
page.on("console", (m) => {
  if (/error|warn/i.test(m.type())) problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto(`${base}/?auto=1&nohud=1&q=low`, { waitUntil: "networkidle0", timeout: 120000 });
await page.waitForFunction(() => window.__flip && window.__flip.ready, { timeout: 120000 });

const rt = await page.evaluate(() => {
  const a = window.__flip.audio;
  return { started: a.started, state: a.ctx ? a.ctx.state : "none", error: a.error, sr: a.ctx ? a.ctx.sampleRate : 0 };
});
console.log(`実時間の AudioContext: started=${rt.started} state=${rt.state} sr=${rt.sr}${rt.error ? " error=" + rt.error : ""}`);

const fmtBands = (b) => ["sub", "low", "lowmid", "mid", "high", "air"].map((k) => `${k[0]}${String(Math.round(b[k] * 100)).padStart(2)}`).join(" ");
const results = [];
console.log("\n名前                               rms     peak   crest  帯域%(sub low lowmid mid high air) 重心Hz texture step  stereo  備考");
for (const s of targets) {
  const cfg = { ...s, seconds: s.seconds ?? SEC };
  delete cfg.name;
  const t0 = Date.now();
  let r;
  try {
    r = await page.evaluate((c) => window.__flip.audio.renderOffline(c), cfg);
  } catch (e) {
    console.log(`${s.name.padEnd(34)} ERROR ${String(e).slice(0, 200)}`);
    results.push({ name: s.name, error: String(e) });
    continue;
  }
  const extra = [];
  if (s.solo === "birds" || s.name.startsWith("all")) extra.push(`birds=${r.birdCalls}${r.lastBird ? "(" + r.lastBird + ")" : ""}`);
  if (r.lastStrike) extra.push(`strike d=${Math.round(r.lastStrike.distance)}m +${r.lastStrike.delay.toFixed(2)}s`);
  if (s.solo === "insects") extra.push(`insect=${r.insectLevel.toFixed(2)} frogs=${r.frogs}`);
  console.log(
    `${s.name.padEnd(34)} ${String(r.rmsDb).padStart(6)} ${String(r.peakDb).padStart(6)} ${String(r.crestDb).padStart(6)}  ${fmtBands(r.bands)}  ${String(r.centroid).padStart(5)}  ${String(r.texture).padStart(5)} ${String(r.maxStep).padStart(5)}  ${String(r.stereo).padStart(5)}  ${extra.join(" ")} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  if (r.segments) {
    for (const g of r.segments) console.log(`    ${g.t0.toFixed(2)}-${g.t1.toFixed(2)}s  rms ${String(g.rmsDb).padStart(6)} peak ${String(g.peakDb).padStart(6)}  ${fmtBands(g.bands)}  重心 ${g.centroid}`);
  }
  if (s.name.startsWith("thunder") || s.name.startsWith("ui flip") || s.name.startsWith("birds")) console.log(`    env250: ${r.env250.map((v) => (v <= -90 ? "  ." : String(Math.round(v)).padStart(4))).join("")}`);
  results.push({ name: s.name, ...r });
}
await browser.close();

// 合否（数値の物差し）
console.log("\n— 判定 —");
let ng = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok " : "  NG "} ${msg}`);
  if (!cond) ng++;
};
const byName = (n) => results.find((r) => r.name === n);
for (const r of results) {
  if (r.error) continue;
  if (r.name.startsWith("all")) check(r.peakDb <= -1.0, `${r.name}: ピーク ${r.peakDb} ≤ −1 dBFS`);
  if (r.name.startsWith("all") && !r.name.includes("flip")) check(r.rmsDb >= -26 && r.rmsDb <= -9, `${r.name}: RMS ${r.rmsDb} dBFS（−26〜−9）`);
}
const w2 = byName("wind clear 2m/s"), w11 = byName("wind storm 11m/s @ridge");
if (w2 && w11) {
  check(w11.rmsDb > w2.rmsDb + 8, `風: 11m/s は 2m/s より 8dB 以上大きい（${w2.rmsDb} → ${w11.rmsDb}）`);
  check(w11.bands.high + w11.bands.air < 0.35, `風: 白色雑音ではない（高域の比 ${(w11.bands.high + w11.bands.air).toFixed(2)} < 0.35）`);
  check(w11.bands.sub + w11.bands.low > 0.3, `風: 耳元の低い唸り（sub+low ${(w11.bands.sub + w11.bands.low).toFixed(2)} > 0.3）`);
  check(w11.texture > 0.12, `風: 突風で揺れる（texture ${w11.texture} > 0.12）`);
  check(w11.stereo < 0.9, `風: ステレオ（相関 ${w11.stereo} < 0.9）`);
}
const rs = byName("rain rain @shore"), rf = byName("rain rain @forest"), rc = byName("rain clear (silent)"), rst = byName("rain storm @start");
if (rs && rf && rc) {
  check(rc.rmsDb < -70, `雨: 晴れは無音（${rc.rmsDb}）`);
  check(rs.texture > 0.05, `雨: 一定のシャーではない（texture ${rs.texture} > 0.05）`);
  check(rs.bands.lowmid > rf.bands.lowmid, `雨: 岸では水面の丸い音が増える（lowmid 岸 ${rs.bands.lowmid} > 森 ${rf.bands.lowmid}）`);
  check(rf.bands.high > rs.bands.high, `雨: 森では葉の高い音が増える（high 森 ${rf.bands.high} > 岸 ${rs.bands.high}）`);
  if (rst) check(rst.bands.sub + rst.bands.low > rs.bands.sub + rs.bands.low, `雨: 嵐では低いうねり（sub+low 嵐 ${(rst.bands.sub + rst.bands.low).toFixed(2)} > 雨 ${(rs.bands.sub + rs.bands.low).toFixed(2)}）`);
}
const tn = byName("thunder near 300m"), tf = byName("thunder far 2500m"), ta = byName("thunder auto (no lightning obj)");
if (tn && tn.segments) {
  const [crack, roll1, roll2, roll3, tail] = tn.segments;
  check(tn.lastStrike && Math.abs(tn.lastStrike.delay - 300 / 340) < 0.2, `雷: 300m は約 ${(300 / 340).toFixed(2)}s 遅れ（${tn.lastStrike?.delay.toFixed(2)}）`);
  check(crack.centroid > roll2.centroid * 1.5, `雷(近): 最初は高く（${crack.centroid}Hz）その後低く転がる（${roll2.centroid}Hz）`);
  check(roll2.rmsDb > tail.rmsDb + 3 && roll3.rmsDb > tail.rmsDb, `雷(近): 3.5〜5s ${roll2.rmsDb} > 6〜8s ${roll3.rmsDb} > 9〜11s ${tail.rmsDb}（長く減衰）`);
  check(roll3.rmsDb > -60, `雷(近): 6〜8 秒後もまだ転がっている（${roll3.rmsDb} dB）`);
}
if (tf && tf.segments) {
  const [a, b, c, d] = tf.segments;
  check(tf.lastStrike && Math.abs(tf.lastStrike.delay - 2500 / 340) < 0.2, `雷(遠): 2500m は約 ${(2500 / 340).toFixed(2)}s 遅れ（${tf.lastStrike?.delay.toFixed(2)}）`);
  check(a.rmsDb < -90 || a.rmsDb < b.rmsDb, `雷(遠): 到達前は静か（${a.rmsDb} → ${b.rmsDb}）`);
  check(b.centroid < 500, `雷(遠): 低い（重心 ${b.centroid} Hz）`);
  check(c.rmsDb > -70 && d.rmsDb > -80, `雷(遠): 長く転がる（${b.rmsDb} / ${c.rmsDb} / ${d.rmsDb}）`);
}
if (ta) check(ta.lastStrike !== null, `雷: env.lightning が無くても嵐なら自前で鳴る（${ta.lastStrike ? "鳴った" : "鳴らない"}）`);
const ws = byName("water shore (2m) clear"), w18 = byName("water start (18m) clear"), wfar = byName("water far (300m) clear"), wst = byName("water shore storm"), wy = byName("water shore yaw180");
if (ws && w18 && wfar) {
  check(ws.rmsDb > w18.rmsDb + 3 && w18.rmsDb > wfar.rmsDb + 10, `波: 岸 ${ws.rmsDb} > 18m ${w18.rmsDb} > 300m ${wfar.rmsDb}`);
  check(ws.texture > 0.15, `波: 寄せて引く（texture ${ws.texture} > 0.15）`);
  if (wst) check(wst.rmsDb > ws.rmsDb + 3 && wst.centroid > ws.centroid, `波: 嵐で荒く大きく（${ws.rmsDb} → ${wst.rmsDb}、重心 ${ws.centroid} → ${wst.centroid}）`);
  if (wy) check(Math.abs(wy.rmsDb - ws.rmsDb) < 3, `波: 後ろを向いても音量はほぼ同じ（${ws.rmsDb} / ${wy.rmsDb}）`);
}
for (const nm of ["foot grass x6", "foot rock x6", "foot sand x6", "foot water x6"]) {
  const r = byName(nm);
  if (!r || !r.segments) continue;
  const cents = r.segments.map((g) => g.centroid), rmss = r.segments.map((g) => g.rmsDb);
  const spread = (Math.max(...cents) - Math.min(...cents)) / (cents.reduce((a, b) => a + b, 0) / cents.length);
  check(spread > 0.06 || Math.max(...rmss) - Math.min(...rmss) > 1.5, `${nm}: 毎回違う（重心のばらつき ${(spread * 100).toFixed(0)}%、RMS 幅 ${(Math.max(...rmss) - Math.min(...rmss)).toFixed(1)}dB）`);
  check(Math.min(...rmss) > -60, `${nm}: 全部鳴っている（最小 ${Math.min(...rmss)} dB）`);
}
const fg = byName("foot grass x6"), fr = byName("foot rock x6"), fs_ = byName("foot grass sprint x6");
if (fg && fr) check(fr.centroid > fg.centroid && fr.crestDb > fg.crestDb, `足音: 岩は草より硬い（重心 ${fr.centroid} > ${fg.centroid}、crest ${fr.crestDb} > ${fg.crestDb}）`);
if (fg && fs_) check(fs_.rmsDb > fg.rmsDb + 1, `足音: 走ると強い（${fg.rmsDb} → ${fs_.rmsDb}）`);
const bd = byName("birds dawn chorus @start"), bn = byName("birds noon @forest"), br = byName("birds rain (fewer)"), bnight = byName("birds night (silent)"), bridge = byName("birds ridge 10h");
if (bd && bn && br && bnight) {
  check(bd.birdCalls >= 4, `鳥: 夜明けの合唱 16 秒で ${bd.birdCalls} 回`);
  check(bd.birdCalls > bn.birdCalls, `鳥: 夜明け ${bd.birdCalls} 回 > 昼 ${bn.birdCalls} 回`);
  check(bn.birdCalls > br.birdCalls, `鳥: 昼 ${bn.birdCalls} 回 > 雨 ${br.birdCalls} 回`);
  check(bnight.birdCalls === 0 && bnight.rmsDb < -70, `鳥: 夜は鳴かない（${bnight.birdCalls} 回, ${bnight.rmsDb} dB）`);
  check(bd.centroid > 2000, `鳥: 高い声（重心 ${bd.centroid} Hz）`);
  const e = bd.env250, mx = Math.max(...e), med = [...e].sort((a, b) => a - b)[Math.floor(e.length / 2)];
  check(mx - med > 8, `鳥: 鳴いては止む（250ms 包絡の最大−中央値 ${(mx - med).toFixed(1)} dB > 8）`);
  if (bridge) check(bridge.birdCalls >= 1, `鳥: 尾根でも（トビ）鳴く ${bridge.birdCalls} 回 (${bridge.lastBird})`);
}
const iN = byName("insects night @start"), iS = byName("insects night @shore wet (frogs)"), iSt = byName("insects night storm (quiet)"), iD = byName("insects noon (silent)");
if (iN && iD) {
  check(iN.rmsDb > -45 && iD.rmsDb < -70, `虫: 夜 ${iN.rmsDb} dB、昼 ${iD.rmsDb} dB`);
  check(iN.centroid > 3000, `虫: 高い（重心 ${iN.centroid} Hz）`);
  check(iN.texture > 0.15, `虫: パルス（texture ${iN.texture} > 0.15）`);
  if (iSt) check(iSt.rmsDb < iN.rmsDb - 10, `虫: 嵐では静か（${iN.rmsDb} → ${iSt.rmsDb}）`);
  if (iS) check(iS.frogs >= 1, `カエル: 濡れた岸辺の夜に ${iS.frogs} 回`);
}
const pd = byName("pad dawn"), pn = byName("pad night"), allNoon = byName("all clear noon @start");
if (pd && pn && allNoon) {
  check(pd.rmsDb < allNoon.rmsDb - 8, `パッド: 環境音より十分小さい（${pd.rmsDb} vs 全体 ${allNoon.rmsDb}）`);
  check(pn.centroid < pd.centroid, `パッド: 夜は低い（${pn.centroid} < ${pd.centroid} Hz）`);
}
const fo = byName("ui flip wave on→hold"), foff = byName("ui flip wave off");
if (fo && fo.segments) {
  const [a, b, c, d, hold] = fo.segments;
  check(a.centroid < b.centroid && b.centroid < c.centroid, `裏返し: 上昇スイープ（重心 ${a.centroid} → ${b.centroid} → ${c.centroid} Hz）`);
  check(hold.rmsDb < c.rmsDb - 6 && hold.rmsDb > -70, `裏返し: 全域が数式になった後は薄く持続（${c.rmsDb} → ${hold.rmsDb} dB）`);
  check(fo.peakDb <= -1, `裏返し: ピーク ${fo.peakDb} ≤ −1`);
  void d;
}
if (foff && foff.segments) {
  const [a, b, c] = foff.segments;
  check(a.centroid > b.centroid, `もどす: 下降スイープ（${a.centroid} → ${b.centroid} Hz）`);
  check(c.rmsDb < -60, `もどす: 終わったら止まる（${c.rmsDb} dB）`);
}
const fv = byName("all flip view clear golden"), fg2 = byName("all clear golden @start");
if (fv && fg2) check(fv.centroid < fg2.centroid * 0.8, `数式ビュー: 環境音がローファイ（重心 ${fg2.centroid} → ${fv.centroid} Hz）`);
const sh = byName("ui shutter");
if (sh && sh.segments) check(sh.segments[0].rmsDb > -40 && sh.segments[0].crestDb > 12, `シャッター: 鳴る・鋭い（${sh.segments[0].rmsDb} dB, crest ${sh.segments[0].crestDb}）`);
const en = byName("ui enter");
if (en) check(en.rmsDb > -45 && en.peakDb < -6, `入場: ふわっ（${en.rmsDb} dB, peak ${en.peakDb}）`);
for (const r of results) if (!r.error) check(r.maxStep < 1.2, `${r.name}: クリック無し（最大段差 ${r.maxStep}）`);

if (problems.length) {
  console.log("\n--- ページ内の警告/エラー ---");
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(p);
}
if (jsonOut) fs.writeFileSync(String(jsonOut), JSON.stringify(results, null, 1));
console.log(ng ? `\n${ng} 件 NG` : "\n判定 全部 ok");
process.exit(ng ? 1 : 0);
