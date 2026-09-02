// 負荷計測（ヘッドレス Chrome＝実 GPU）。10 秒歩き回りながら、フレーム時間・実効 fps・描画回数・メモリを表にする。
//
//   node tools/perf.mjs                       # high、1600×900、10 秒
//   node tools/perf.mjs --q mid               # 段階を指定（low / mid / high / ultra）
//   node tools/perf.mjs --mobile              # iPhone 相当（390×844 @3、UA も iPhone。段階は自動判定＝mid）
//   node tools/perf.mjs --seconds 20          # 歩く秒数
//   node tools/perf.mjs --url "/?t=12&w=rain" # 任意の URL（auto/nohud/stats は自動で付く）
//   node tools/perf.mjs --flip                # 途中で裏返す（数式ビューの負荷も見る）
//   node tools/perf.mjs --json                # JSON でも出す
//   FLIP_URL=http://localhost:3059 node tools/perf.mjs ...   # 別ポートのサーバーを測る
//
// 出力: CPU 側 frameMs（平均／95%／最大）、rAF の間隔（＝実効 fps。GPU が重いとここが伸びる）、
//       draw calls・三角形数（平均／最大）、renderer.info.memory、JS ヒープ、動的解像度の到達値、
//       ハイトマップの焼き時間。window.__flip.controls にキー状態を注入して歩く（W → 旋回 → 走り → 後退 → 横歩き）。
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const argv = process.argv.slice(2);
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const mobile = !!flag("mobile");
const W = Number(flag("w", mobile ? 390 : 1600));
const H = Number(flag("h", mobile ? 844 : 900));
const DPR = Number(flag("dpr", mobile ? 3 : 1));
const q = flag("q", mobile ? null : "high");
const seconds = Number(flag("seconds", 10));
const doFlip = !!flag("flip");
const asJson = !!flag("json");
const base = process.env.FLIP_URL ?? "http://localhost:3051";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let url = String(flag("url", "/"));
url += (url.includes("?") ? "&" : "?") + "auto=1&nohud=1&stats=1";
if (q) url += `&q=${q}`;

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
  if (/error|warn/i.test(m.type()) || /THREE|WebGL|shader/i.test(t)) problems.push(`[${m.type()}] ${t.slice(0, 400)}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${String(e).slice(0, 400)}`));

const t0 = Date.now();
await page.goto(base + url, { waitUntil: "networkidle0", timeout: 120000 });
await page.waitForFunction(() => window.__flip && window.__flip.ready, { timeout: 120000 });
const tReady = (Date.now() - t0) / 1000;
await sleep(1500); // シェーダのコンパイルなどが落ち着くまで

// フレームごとの計測をページに仕込む（world.frame を包む）
await page.evaluate(() => {
  const w = window.__flip;
  const S = (window.__perf = { cpu: [], iv: [], calls: [], tris: [], last: 0 });
  const orig = w.frame.bind(w);
  w.frame = () => {
    const t = performance.now();
    if (S.last) S.iv.push(t - S.last);
    S.last = t;
    orig();
    S.cpu.push(performance.now() - t);
    S.calls.push(w.renderer.info.render.calls);
    S.tris.push(w.renderer.info.render.triangles);
  };
});

// 歩く: W → W+旋回 → 走り → 後退 → 横歩き＋見回し（合計 seconds 秒）
const key = async (code, down) => (down ? page.keyboard.down(code) : page.keyboard.up(code));
const look = (dx, dy) => page.evaluate((dx, dy) => window.__flip.controls.addLook(dx, dy), dx, dy);
const seg = seconds / 5;
const turnOver = async (ms, total) => {
  const steps = Math.max(1, Math.round(ms / 50));
  for (let i = 0; i < steps; i++) {
    await look(total / steps, 0);
    await sleep(50);
  }
};
await key("KeyW", true);
await sleep(seg * 1000);
if (doFlip) await page.evaluate(() => window.__flip.toggleFlip());
await turnOver(seg * 1000, 1400); // 約 80° 右へ
await key("ShiftLeft", true);
await sleep(seg * 1000);
await key("ShiftLeft", false);
await key("KeyW", false);
await key("KeyS", true);
await sleep(seg * 1000);
await key("KeyS", false);
await key("KeyD", true);
await turnOver(seg * 1000, -1400);
await key("KeyD", false);

const r = await page.evaluate(() => {
  const w = window.__flip;
  const S = window.__perf;
  const stat = (a) => {
    if (!a.length) return { avg: 0, p95: 0, max: 0 };
    const s = [...a].sort((x, y) => x - y);
    return { avg: a.reduce((x, y) => x + y, 0) / a.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
  };
  const mem = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
  return {
    cpu: stat(S.cpu),
    iv: stat(S.iv),
    calls: stat(S.calls),
    tris: stat(S.tris),
    frames: S.cpu.length,
    memory: { ...w.renderer.info.memory, heapMB: mem },
    tier: w.env.tier,
    size: `${w.stats.width}x${w.stats.height}`,
    renderScale: w.stats.renderScale,
    tierNext: w.stats.tierNext,
    bake: w.bakeInfo,
    device: w.runtime.device.reason,
    pos: { x: w.controls.position.x.toFixed(1), z: w.controls.position.z.toFixed(1) },
  };
});
await browser.close();

const f1 = (x) => x.toFixed(1);
const f0 = (x) => Math.round(x).toString();
const rows = [
  ["", "平均", "95%", "最大"],
  ["frameMs (CPU)", f1(r.cpu.avg), f1(r.cpu.p95), f1(r.cpu.max)],
  ["rAF 間隔 ms", f1(r.iv.avg), f1(r.iv.p95), f1(r.iv.max)],
  ["draw calls", f0(r.calls.avg), f0(r.calls.p95), f0(r.calls.max)],
  ["三角形 (k)", f0(r.tris.avg / 1000), f0(r.tris.p95 / 1000), f0(r.tris.max / 1000)],
];
const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => String(row[c]).length)));
console.log(`\n${mobile ? "携帯" : "パソコン"}  ${r.tier}  ${r.size}  ${r.frames} frames / ${seconds}s  実効 ${f1(1000 / (r.iv.avg || 1))} fps  renderScale ${r.renderScale}${r.tierNext ? `  次回 ${r.tierNext}` : ""}`);
console.log(`端末: ${r.device}`);
console.log(`起動 ${tReady.toFixed(1)}s（ハイトマップ ${r.bake.mode} ${f0(r.bake.ms)}ms × ${r.bake.workers} workers）  位置 (${r.pos.x}, ${r.pos.z})`);
for (const row of rows) console.log(row.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  "));
console.log(`メモリ: geometries ${r.memory.geometries} / textures ${r.memory.textures}${r.memory.heapMB != null ? ` / JS heap ${f1(r.memory.heapMB)} MB` : ""}`);
if (asJson) console.log(JSON.stringify(r));
if (problems.length) {
  console.log("--- ページ内の警告/エラー ---");
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(p);
}
