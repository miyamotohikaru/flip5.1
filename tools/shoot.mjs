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
const flagWait = flag("wait") !== null;
const wait = Number(flag("wait", 2500));
const q = flag("q", null);
const base = process.env.FLIP_URL ?? "http://localhost:3051";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOT_NAMES = ["golden", "noon", "dawn", "cloudy", "rain", "storm", "night", "sunset_water", "forest", "ridge", "noon_side", "cloudy_side", "storm_live", "storm_bolt", "flip_half", "flip_full"];
// 時間を止めずに撮る定点（`live` 秒）は、**実時間ではなく世界の時計（env.time）で待つ**。
// world.ts が dt を 0.1 秒で頭打ちにしているので、機が混んでフレームが 150ms かかると
// env.time が実時間から遅れ、同じ待ち時間でも落雷の位相が変わってしまう
// （「storm_bolt は撮るたびに閃光の位相が変わる」の正体）。
// 秒数は params.ts の `live` をページから直接読むので、ここに書き写さない
// （書き写して食い違わせ、落雷の写らない絵で採点する事故が実際に起きた）。
let targets = [];
if (flag("url")) targets = [{ name, url: String(flag("url")) }];
else if (flag("all")) targets = SHOT_NAMES.map((s) => ({ name: `${name}_${s}`, url: `/?shot=${s}` }));
else targets = [{ name, url: `/?shot=${flag("shot", "golden")}` }];

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
  // 定点に live（秒）があれば、世界の時計がその秒数に届くまで待つ
  const live = await page.evaluate(() => window.__flip?.params?.shot?.live ?? null);
  if (live !== null && !flagWait) {
    await page.waitForFunction((s) => window.__flip.env.time >= s, { timeout: 180000, polling: "raf" }, live)
      .catch(() => console.log(`  ※ 世界の時計が ${live}s に届かなかった（この絵は採点に使わないこと）`));
  } else {
    await sleep(flagWait ? wait : (t.wait ?? wait));
  }
  const stats = await page.evaluate(() => {
    const w = window.__flip;
    return { frameMs: w.stats.frameMs, calls: w.stats.drawCalls, tris: w.stats.triangles, tier: w.stats.tier, size: `${w.stats.width}x${w.stats.height}`, t: w.env.time };
  });
  const file = path.join(OUT, `${t.name}.png`);
  await page.screenshot({ path: file });
  const tt = live !== null ? ` 世界の時計 ${stats.t.toFixed(2)}s` : "";
  console.log(`${file}  (${stats.tier} ${stats.size} ${stats.frameMs.toFixed(1)}ms/frame ${stats.calls} calls ${(stats.tris / 1000).toFixed(0)}k tris,${tt} ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
await browser.close();
if (problems.length) {
  console.log("--- ページ内の警告/エラー ---");
  for (const p of [...new Set(problems)].slice(0, 30)) console.log(p);
}
