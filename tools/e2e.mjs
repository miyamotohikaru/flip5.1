// 訪れる人と同じ順で触って、壊れがないか見る（ヘッドレス Chrome＝実 GPU）。
//
//   node tools/e2e.mjs
//   FLIP_URL=https://flip5-1.vercel.app node tools/e2e.mjs   本番プレビューを触る
//
// 入口 → 黒板 → 入場 → WASD で歩く → F でふりっぷ → ふだ → もどす →
// L で実験室 → つまみを動かす → 閉じる → P で写真 → ? で解説 → 負荷、の順。
// 定点の撮影（tools/shoot.mjs）では出ない「操作の壊れ」を見るためのもの。
//
// 実際にこれで見つけた不具合: **実験室のつまみを1度触るとフォーカスが input に残り、
// F も L も P も効かなくなっていた**（キー処理が INPUT を一律に素通りさせていたため）。
// 見た目を撮るだけでは絶対に見つからない類なので、変更のあとは通しておくこと。
import puppeteer from "puppeteer-core";
const base = process.env.FLIP_URL ?? "http://localhost:3051";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--headless=new", "--use-angle=metal", "--ignore-gpu-blocklist"], defaultViewport: { width: 1600, height: 900 } });
const p = await b.newPage();
const bad = [];
p.on("console", (m) => { if (m.type() === "error" || /THREE\.WebGL|shader|NaN/i.test(m.text())) bad.push(`[${m.type()}] ${m.text().slice(0,200)}`); });
p.on("pageerror", (e) => bad.push(`[pageerror] ${String(e).slice(0,200)}`));
const t0 = Date.now();
await p.goto(base + "/", { waitUntil: "networkidle0", timeout: 120000 });
const step = async (name, fn) => { try { const r = await fn(); console.log(`  ${String(name).padEnd(26)} ${r ?? "ok"}`); } catch (e) { console.log(`  ${String(name).padEnd(26)} 失敗: ${String(e).slice(0,120)}`); bad.push(name); } };

await step("入口が出る", async () => (await p.$(".landing")) ? "ok" : "見当たらない");
await step("黒板が書かれている", async () => `パス ${(await p.$$(".bb path")).length} 本`);
await p.waitForFunction(() => window.__flip && window.__flip.ready, { timeout: 120000 });
await step("世界ができるまで", async () => `${((Date.now()-t0)/1000).toFixed(1)}s`);
await step("「入る」を押す", async () => { await p.click(".enter"); await new Promise(r=>setTimeout(r,1600)); return (await p.$(".landing")) ? "入口が残っている" : "入場した"; });
await step("操作ヒントが出ている", async () => (await p.$(".hud-hint")) ? "ok" : "出ていない");
const pos0 = await p.evaluate(() => { const c = window.__flip.controls; return [c.position.x, c.position.z]; }).catch(()=>null);
await step("WASD で歩く", async () => {
  await p.evaluate(() => { const w = window.__flip; w.controls.keys ??= {}; });
  await p.keyboard.down("w"); await new Promise(r=>setTimeout(r,1500)); await p.keyboard.up("w");
  const pos1 = await p.evaluate(() => { const c = window.__flip.controls; return [c.position.x, c.position.z]; });
  const d = pos0 ? Math.hypot(pos1[0]-pos0[0], pos1[1]-pos0[1]) : NaN;
  return `${d.toFixed(1)} m 進んだ`;
});
await step("F でふりっぷ", async () => { await p.keyboard.press("f"); await new Promise(r=>setTimeout(r,2500));
  return `波の半径 ${(await p.evaluate(() => window.__flip.env.flipRadius)).toFixed(0)} m`; });
await step("数式のふだが出る", async () => `${(await p.$$(".wlabel svg path")).length} パス`);
await step("F でもどす", async () => { await p.keyboard.press("f"); await new Promise(r=>setTimeout(r,2500));
  return `半径 ${(await p.evaluate(() => window.__flip.env.flipRadius)).toFixed(0)} m`; });
await step("L で実験室", async () => { await p.keyboard.press("l"); await new Promise(r=>setTimeout(r,900));
  return `つまみ ${(await p.$$(".lab-row input[type=range]")).length} 本 / 式 ${(await p.$$("svg.lab-formula")).length} 本`; });
await step("つまみを動かす", async () => {
  const s = (await p.$$(".lab-row input[type=range]"))[0]; const box = await s.boundingBox();
  await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down();
  await p.mouse.move(box.x+box.width*0.75, box.y+box.height/2); await p.mouse.up();
  await new Promise(r=>setTimeout(r,2500));
  const v = await p.evaluate(() => { const l = window.__flip.lab; return l.values?.terrainAmp ?? l.terrainAmp ?? l.get?.("terrainAmp") ?? null; });
  return v === null ? "値は読めないが例外なし" : `山脈の高さ = ${Number(v).toFixed(2)}`;
});
await step("L で実験室を閉じる", async () => { await p.keyboard.press("l"); await new Promise(r=>setTimeout(r,500)); return (await p.$(".lab")) ? "★残っている" : "閉じた"; });
await step("P で写真", async () => { await p.keyboard.press("p"); await new Promise(r=>setTimeout(r,4000));
  return await p.evaluate(() => window.__flip.stats ? "撮れた（例外なし）" : "?"); });
await step("? で解説", async () => { await p.keyboard.press("?"); await new Promise(r=>setTimeout(r,600));
  const on = !!(await p.$(".about-backdrop")); await p.keyboard.press("Escape"); await new Promise(r=>setTimeout(r,400)); return on ? "開いて閉じた" : "開かない"; });
await step("最後の負荷", async () => { const s = await p.evaluate(() => window.__flip.stats);
  return `${s.frameMs.toFixed(1)}ms/frame  ${s.drawCalls} calls  ${(s.triangles/1000).toFixed(0)}k tris`; });
console.log(bad.length ? `\n⚠ 問題 ${bad.length} 件:\n` + [...new Set(bad)].slice(0,10).map(x=>"  "+x).join("\n") : "\nコンソールのエラー・警告 0 件");
await b.close();
