// 画面に出す「数式」の文面。KaTeX などは使わず、Unicode と等幅フォントで組む。
// 式はどれも実際のコードに対応している:
//   地形 core/height.ts heightAt() ／ 湖 water/wavesim.ts ／ 空 sky/atmosphere.glsl.ts ／ 木 vegetation/conifer.ts
// 等幅で桁を揃えるため、数の列には和文を入れない（和文は等幅でも全角幅になる）。
// 携帯（compact）は SE 幅 375px に収まる長さにする。目安 36 文字。
import type { ProbeHit } from "./probe";

export type FormulaPanel = {
  kind: ProbeHit["kind"];
  /** 見出し（和文） */
  title: string;
  /** 見出し（欧文） */
  latin: string;
  /** どのコードか */
  source: string;
  /** 「ここ」の値。和文まじりの 1 行 */
  here: string;
  /** 数式（等幅で 1 行ずつ） */
  lines: string[];
};

const MINUS = "−";
/** 固定小数。負号は U+2212、幅を width に揃える */
function num(v: number, digits = 2, width = 0): string {
  const s = Math.abs(v).toFixed(digits);
  const out = (v < 0 && Number(s) !== 0 ? MINUS : "") + s;
  return width ? out.padStart(width) : out;
}
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
function clock(hour: number): string {
  const h = Math.floor(hour), m = Math.min(59, Math.floor((hour - h) * 60 + 1e-4));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 湖の波（water/wavesim.ts の setWind と同じ式）。風速から波の高さと波長が決まる
// ---------------------------------------------------------------------------
export function waveParams(windSpeed: number) {
  const U = Math.max(windSpeed, 0.3);
  const hs = 0.0025 + 0.0042 * U * U;
  const lambdaP = 0.35 + 0.062 * U * U;
  return { U, hs, lambdaP, kp: (2 * Math.PI) / lambdaP };
}

/** 地形: heightAt() の 3 成分を、その場所の値つきで */
function terrainPanel(hit: Extract<ProbeHit, { kind: "terrain" }>, compact: boolean): FormulaPanel {
  const t = hit.terms;
  const here = compact
    ? `x ${num(hit.x, 1)} z ${num(hit.z, 1)} h ${num(hit.y, 1)} m／${num(hit.dist, 0)} m 先／傾き ${num(hit.slopeDeg, 0)}°`
    : `ここ x = ${num(hit.x, 1)}  z = ${num(hit.z, 1)}  h = ${num(hit.y, 2)} m ／ 距離 ${num(hit.dist, 0)} m ／ 傾き ${num(hit.slopeDeg, 0)}°`;
  const row = (name: string, v: number, def: string) =>
    compact ? `${pad(name, 5)}= ${num(v, 1, 7)}  ${def}` : `  ${pad(name, 6)}= ${num(v, 2, 8)}   ${def}`;
  const lines = compact
    ? [
        "h(x,z) = base + mtn + fine",
        row("base", t.base, "湖底+土手+丘"),
        row("mtn", t.mtn, "尾根 ridged₅"),
        row("fine", t.fine, "細かい起伏"),
        row("h", t.sum, "m"),
        `sd = |xz| ${MINUS} r_shore = ${num(t.sd, 0)} m`,
      ]
    : [
        "h(x,z) = base(x,z) + mtn(x,z) + fine(x,z)",
        row("base", t.base, `${MINUS}34(1${MINUS}e^(sd/70))·bed + 土手 + 丘 fbm₄ + 沢`),
        row("mtn", t.mtn, "ridged₅(warp(x,z))·amp(方角)·mask(rd)"),
        row("fine", t.fine, "1.6·n(0.021·xz) + 0.45·n(0.047·xz) + 0.18·n(0.115·xz)"),
        row("h", t.sum, "m"),
        `sd = |xz| ${MINUS} r_shore(θ)                = ${num(t.sd, 1)} m`,
        `r_shore = 330 + 70·n(1.7·û) + 26·n(4.1·û)  = ${num(t.rShore, 1)} m`,
      ];
  return { kind: "terrain", title: "地形", latin: "TERRAIN", source: "core/height.ts · heightAt(x, z)", here, lines };
}

/** 湖: 風のスペクトルから作った波を逆 FFT で並べる（Tessendorf） */
function lakePanel(hit: Extract<ProbeHit, { kind: "lake" }>, compact: boolean): FormulaPanel {
  const w = waveParams(hit.windSpeed);
  const here = compact
    ? `x ${num(hit.x, 1)} z ${num(hit.z, 1)} 水面 y 0／水深 ${num(hit.depth, 1)} m／${num(hit.dist, 0)} m 先`
    : `ここ x = ${num(hit.x, 1)}  z = ${num(hit.z, 1)}  水面 y = 0 ／ 水深 ${num(hit.depth, 1)} m ／ 距離 ${num(hit.dist, 0)} m`;
  const wd = `(${num(hit.windDir.x, 2)}, ${num(hit.windDir.y, 2)})`;
  const lines = compact
    ? [
        "h(x,t) = Σₖ ĥ(k,t)·e^(i k·x)",
        `ĥ(k,t) = ĥ₀(k)e^(${MINUS}iωt) + ĥ₀*(${MINUS}k)e^(iωt)`,
        `ω(k) = √(9.81k + 7.4e${MINUS}5·k³)`,
        `S(k) = A·e^(${MINUS}kₚ²/k²)/k⁴·(k̂·ŵ)^p`,
        `U = ${num(w.U, 1)} m/s   ŵ = ${wd}`,
        `hs = 0.0025+0.0042U² = ${num(w.hs, 3)} m`,
        `λₚ = 0.35+0.062U²   = ${num(w.lambdaP, 2)} m`,
      ]
    : [
        `h(x,t) = Σₖ ĥ(k,t)·e^(i k·x)                  逆FFT（Tessendorf）`,
        `ĥ(k,t) = ĥ₀(k)·e^(${MINUS}iωt) + ĥ₀*(${MINUS}k)·e^(+iωt)`,
        `ω(k)  = √(9.81·k + 7.4e${MINUS}5·k³)              重力 + 表面張力`,
        `S(k)  = A·e^(${MINUS}kₚ²/k²)/k⁴ · (k̂·ŵ)^p       Phillips 型`,
        `D(x)  = i·k̂·h                                 波頭へ寄る変位`,
        `U = ${num(w.U, 1)} m/s   ŵ = ${wd}   t = ${num(hit.time, 1)} s`,
        `hs = 0.0025 + 0.0042·U² = ${num(w.hs, 3)} m      λₚ = 0.35 + 0.062·U² = ${num(w.lambdaP, 2)} m`,
      ];
  return { kind: "lake", title: "湖", latin: "LAKE", source: "water/wavesim.ts · スペクトル → 逆FFT", here, lines };
}

/** 空: 大気散乱の積分と、いまの位相・透過率 */
function skyPanel(hit: Extract<ProbeHit, { kind: "sky" }>, compact: boolean): FormulaPanel {
  const sign = (v: number) => (v >= 0 ? "+" : MINUS) + Math.abs(v).toFixed(1);
  const a = hit.atmo;
  const here = compact
    ? `仰角 ${sign(hit.elevDeg)}° 方位 ${num(hit.azDeg, 0)}°／太陽 ${sign(hit.sunElevDeg)}°／${clock(hit.hour)}`
    : `視線 仰角 ${sign(hit.elevDeg)}°  方位 ${num(hit.azDeg, 0)}° ／ 太陽 高度 ${sign(hit.sunElevDeg)}° ／ ${clock(hit.hour)}`;
  const T = `(${num(a.T[0], 2)}, ${num(a.T[1], 2)}, ${num(a.T[2], 2)})`;
  const lines = compact
    ? [
        `L = ∫₀ᴰ T·(σᴿpᴿ + σᴹpᴹ)·E☉ ds`,
        `T(a,b) = exp(${MINUS}∫ₐᵇ σₑ(h) ds)`,
        `σᴿ(h) = (5.8,13.6,33.1)e${MINUS}3·e^(${MINUS}h/8km)`,
        `σᴹ(h) = 8.0e${MINUS}3·e^(${MINUS}h/2.5km) + 靄`,
        `pᴿ(θ) = 3/16π(1+cos²θ) = ${num(a.phaseR, 3)}`,
        `pᴹ(θ) = C–S(θ, g=0.82) = ${num(a.phaseM, 3)}`,
        `θ = ${num(a.thetaDeg, 0)}°   T(5km) = ${T}`,
      ]
    : [
        `L(ω) = ∫₀ᴰ T(0,s)·(σₛᴿ(s)·pᴿ(θ) + σₛᴹ(s)·pᴹ(θ))·E☉ ds     Hillaire 2020`,
        `T(a,b) = exp(${MINUS}∫ₐᵇ σₑ(h(s)) ds)`,
        `σᴿ(h) = (5.802, 13.558, 33.10)e${MINUS}3 · e^(${MINUS}h/8.0 km)      青が最も散る`,
        `σᴹ(h) = 8.0e${MINUS}3 · e^(${MINUS}h/2.5 km) + 靄 ${num(a.haze, 3)}·e^(${MINUS}h/1 km)`,
        `pᴿ(θ) = 3/(16π)·(1 + cos²θ)                       = ${num(a.phaseR, 4)}`,
        `pᴹ(θ) = Cornette${MINUS}Shanks(θ, g = 0.82)               = ${num(a.phaseM, 4)}`,
        `θ（視線と太陽のなす角） = ${num(a.thetaDeg, 1)}°     T(0, 5km) = ${T}`,
      ];
  return { kind: "sky", title: "空", latin: "SKY", source: "sky/atmosphere.glsl.ts · flip_aerial", here, lines };
}

export function panelFor(hit: ProbeHit, compact: boolean): FormulaPanel {
  if (hit.kind === "terrain") return terrainPanel(hit, compact);
  if (hit.kind === "lake") return lakePanel(hit, compact);
  return skyPanel(hit, compact);
}

/**
 * 読み込み画面で流す式。world.build() の progress の step 文言に対応する。
 * 本当にそのとき計算している式だけを出す（飾りの式は出さない）。
 */
export function loadingLines(step: string, heightmapRes: number): string[] {
  if (/地形/.test(step)) {
    return [
      "h(x,z) = base(x,z) + mtn(x,z) + fine(x,z)",
      `mtn = ridged₅(warp(x,z))·amp(方角)·mask(rd)      × ${heightmapRes}² 点`,
    ];
  }
  if (/光|空気/.test(step)) {
    return [
      `L(ω) = ∫₀ᴰ T(0,s)·(σₛᴿ·pᴿ(θ) + σₛᴹ·pᴹ(θ))·E☉ ds`,
      `T(a,b) = exp(${MINUS}∫ₐᵇ σₑ(h(s)) ds)`,
    ];
  }
  if (/描画/.test(step)) {
    return [`h(x,t) = Σₖ ĥ(k,t)·e^(i k·x),  ω(k) = √(9.81k + 7.4e${MINUS}5·k³)      湖の波（逆FFT）`];
  }
  return [];
}
