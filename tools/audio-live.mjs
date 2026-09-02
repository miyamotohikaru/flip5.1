// 実時間の音の確認（ヘッドレス Chrome）。クリックで AudioContext を起こし、
// メインスレッドの負荷（audio.stats）と出力レベル（AnalyserNode）を時刻・天気を変えながら読む。
//   FLIP_URL=http://localhost:3058 node tools/audio-live.mjs
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const base = process.env.FLIP_URL ?? "http://localhost:3051";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--headless=new", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1200, height: 700 },
});
const page = await browser.newPage();
const problems = [];
page.on("console", (m) => {
  if (/error|warn/i.test(m.type())) problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto(`${base}/?auto=1&nohud=1&q=high`, { waitUntil: "networkidle0", timeout: 120000 });
await page.waitForFunction(() => window.__flip && window.__flip.ready, { timeout: 120000 });
// 操作（クリック）で AudioContext を作る
await page.mouse.click(600, 350);
await sleep(600);
const boot = await page.evaluate(() => {
  const a = window.__flip.audio;
  return { started: a.started, state: a.ctx ? a.ctx.state : "none", sr: a.ctx ? a.ctx.sampleRate : 0, error: a.error, baseLatency: a.ctx ? a.ctx.baseLatency : 0 };
});
console.log("起動:", JSON.stringify(boot));

const scenes = [
  { name: "clear 12h", hour: 12, weather: "clear" },
  { name: "clear 5.9h（夜明け）", hour: 5.9, weather: "clear" },
  { name: "rain 15h", hour: 15, weather: "rain" },
  { name: "storm 18h", hour: 18.2, weather: "storm" },
  { name: "clear 23.5h（夜）", hour: 23.5, weather: "clear" },
];
for (const s of scenes) {
  await page.evaluate((c) => {
    const w = window.__flip;
    w.setHour(c.hour);
    w.setWeather(c.weather);
    w.env.weather = { ...w.env.weather, ...w.env.weatherTarget };
    w.audio.stats.maxUpdateMs = 0;
    w.audio.stats.maxTickMs = 0;
  }, s);
  await sleep(4000);
  const levels = [];
  for (let i = 0; i < 10; i++) {
    levels.push(await page.evaluate(() => window.__flip.audio.level()));
    await sleep(200);
  }
  const r = await page.evaluate(() => {
    const a = window.__flip.audio;
    return { stats: { ...a.stats }, state: a.ctx.state, frameMs: window.__flip.stats.frameMs, ticks: a.mixer ? a.mixer.ticks : 0 };
  });
  const avg = levels.reduce((x, y) => x + y, 0) / levels.length;
  console.log(
    `${s.name.padEnd(16)} level 平均 ${avg.toFixed(1)} dBFS（最大 ${Math.max(...levels).toFixed(1)}） update 平均 ${r.stats.updateMs.toFixed(3)}ms 最大 ${r.stats.maxUpdateMs.toFixed(3)}ms／tick 平均 ${r.stats.tickMs.toFixed(3)}ms 最大 ${r.stats.maxTickMs.toFixed(3)}ms／frame ${r.frameMs.toFixed(1)}ms ctx=${r.state} ticks=${r.ticks}`,
  );
}
// 裏返し・写真・足音（イベントも動くか）
await page.evaluate(() => {
  const w = window.__flip;
  w.toggleFlip();
  w.audio.shutter();
  w.audio.footstep("grass");
  w.audio.footstep("rock");
});
await sleep(2500);
const fl = await page.evaluate(() => ({ level: window.__flip.audio.level(), flip: window.__flip.env.flip, r: window.__flip.env.flipRadius, stats: { ...window.__flip.audio.stats } }));
console.log(`裏返し中: level ${fl.level.toFixed(1)} dBFS flip=${fl.flip.toFixed(2)} radius=${fl.r.toFixed(0)}m 最大 update ${fl.stats.maxUpdateMs.toFixed(3)}ms`);
// タブが隠れたら止まるか（visibilitychange を擬似発火）
const hid = await page.evaluate(async () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 500));
  const hidden = window.__flip.audio.ctx.state;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 500));
  return { hidden, back: window.__flip.audio.ctx.state };
});
console.log(`隠れたとき ctx=${hid.hidden} → 戻ったとき ctx=${hid.back}`);
await browser.close();
if (problems.length) {
  console.log("--- ページ内の警告/エラー ---");
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(p);
}
