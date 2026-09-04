// 見た目を確かめるためのスクリーンショット（ヘッドレスChrome＝実GPUで描く）。
//
//   node tools/shoot.mjs <出力名> [オプション]
//     --shot golden            定点（src/engine/core/params.ts の SHOTS）
//     --all                    全定点を撮る（出力名は接頭辞）
//     --url "/?t=12&w=rain"    任意のURL（--shot より優先）
//     --w 1600 --h 900         ビューポート
//     --dpr 1                  デバイスピクセル比
//     --wait 2500              描画が落ち着くまでの待ち(ms)
//     --q high                 品質段階
//     --mobile                 iPhone相当の画面とUAで撮る
//     --out shots              出力フォルダ
//
// 拡張機能経由のタブは背景扱いになって rAF が止まるので、必ずこれで撮る。
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const argv = process.argv.slice(2);
const name = argv[0] && !argv[0].startsWith("--") ? argv[0] : "shot";
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const OUT = path.resolve(String(flag("out", "shots")));
fs.mkdirSync(OUT, { recursive: true });
const mobile = !!flag("mobile");
const W = Number(flag("w", mobile ? 390 : 1600));
const H = Number(flag("h", mobile ? 844 : 900));
const DPR = Number(flag("dpr", mobile ? 3 : 1));
const wait = Number(flag("wait", 2500));
const q = flag("q", null);
const base = process.env.FLIP_URL ?? "http://localhost:3051";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOT_NAMES = ["golden", "noon", "dawn", "cloudy", "rain", "storm", "night", "sunset_water", "forest", "ridge", "noon_side", "cloudy_side", "storm_live", "storm_bolt", "flip_half", "flip_full"];
// 時間を止めずに撮る定点（src/engine/core/params.ts の live）。待ち時間をその秒数に延ばす
// params.ts の live（秒）＋描画が落ち着くまでの余裕。**ここを params.ts と食い違わせない**
// （storm_bolt を 2600ms で撮って落雷が写らず、批評が別フレームで採点する事故が起きた）
const LIVE_WAIT = { storm_live: 11800, storm_bolt: 3850 };
let targets = [];
if (flag("url")) targets = [{ name, url: String(flag("url")) }];
else if (flag("all")) targets = SHOT_NAMES.map((s) => ({ name: `${name}_${s}`, url: `/?shot=${s}`, wait: LIVE_WAIT[s] }));
else targets = [{ name, url: `/?shot=${flag("shot", "golden")}`, wait: LIVE_WAIT[String(flag("shot", "golden"))] }];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR, isMobile: mobile, hasTouch: mobile },
});
const page = await browser.newPage();
if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
const problems = [];
page.on("console", (m) => {
  const t = m.text();
  if (/error|warn/i.test(m.type()) || /THREE|WebGL|shader/i.test(t)) problems.push(`[${m.type()}] ${t.slice(0, 600)}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 600)}`));

for (const t of targets) {
  let url = base + t.url;
  if (q) url += (url.includes("?") ? "&" : "?") + `q=${q}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
  await page.waitForFunction(() => window.__flip && window.__flip.ready, { timeout: 120000 });
  // 入場する URL では、入口（黒板つき）が DOM から消えるまで待つ。
  // 機が混んでいると 1.1 秒のフェードが終わる前に撮れて、**チョークの式が世界の上に写る**
  // （2026-09-04 に storm で発生。155ms/frame のとき）。撮り直しでは出ないので気づきにくい。
  if (/[?&](shot|auto)=/.test(url)) {
    await page.waitForFunction(() => !document.querySelector(".landing"), { timeout: 30000 })
      .catch(() => console.log("  ※ 入口が消えるのを待てなかった（この絵は採点に使わないこと）"));
  }
  await sleep(flag("wait") ? wait : (t.wait ?? wait));
  const stats = await page.evaluate(() => {
    const w = window.__flip;
    return { frameMs: w.stats.frameMs, calls: w.stats.drawCalls, tris: w.stats.triangles, tier: w.stats.tier, size: `${w.stats.width}x${w.stats.height}` };
  });
  const file = path.join(OUT, `${t.name}.png`);
  await page.screenshot({ path: file });
  console.log(`${file}  (${stats.tier} ${stats.size} ${stats.frameMs.toFixed(1)}ms/frame ${stats.calls} calls ${(stats.tris / 1000).toFixed(0)}k tris, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
await browser.close();
if (problems.length) {
  console.log("--- ページ内の警告/エラー ---");
  for (const p of [...new Set(problems)].slice(0, 30)) console.log(p);
}
