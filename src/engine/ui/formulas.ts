// 画面に出す「数式」の文面。KaTeX などは使わず、Unicode と等幅フォントで組む。
// 式はどれも実際のコードに対応している（core/heightfield.ts, water/index.ts, core/glsl/atmosphere.glsl.ts）。
// 等幅で桁を揃えるため、列の中には和文を入れない（和文は等幅でも全角幅になる）。
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
  /** 数式（pre で出す） */
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

/** 地形: h(x,z) を項ごとに、その場所の値つきで */
function terrainPanel(hit: Extract<ProbeHit, { kind: "terrain" }>, compact: boolean): FormulaPanel {
  const t = hit.terms;
  const here = compact
    ? `x ${num(hit.x, 1)} z ${num(hit.z, 1)} h ${num(hit.y, 1)} m ／ ${num(hit.dist, 0)} m 先 ／ 傾き ${num(hit.slopeDeg, 0)}°`
    : `ここ x = ${num(hit.x, 1)}  z = ${num(hit.z, 1)}  h = ${num(hit.y, 2)} m ／ 距離 ${num(hit.dist, 0)} m ／ 傾き ${num(hit.slopeDeg, 0)}°`;
  const row = (name: string, v: number, def: string) =>
    compact ? `${pad(name, 9)}= ${num(v, 2, 6)}  ${def}` : `  ${pad(name, 10)}= ${num(v, 2, 7)}   ${def}`;
  const lines = compact
    ? [
        `h = ${MINUS}depth + 0.8·s₁ + rise + hills·s₂`,
        `    + 2.2·fbm₃ + mtn`,
        row(`${MINUS}depth`, -t.depth, `34·(1${MINUS}e^(sd/70))`),
        row("0.8·s₁", t.shoreStep, `s(${MINUS}20,20,sd)`),
        row("rise", t.rise, "0.032·max(sd,0)"),
        row("hills·s₂", t.hillsTerm, "26·fbm₄(0.0031·xz)"),
        row("2.2·fbm₃", t.h3Term, "fbm₃(0.021·xz)"),
        row("mtn", t.mtn, "660·ridged₅(warp)^1.55"),
        `${pad("h", 9)}= ${num(t.sum, 2, 6)} m`,
        `sd = |xz| ${MINUS} r_shore(θ) = ${num(t.sd, 1)}`,
      ]
    : [
        `h(x,z) = ${MINUS}depth + 0.8·s₁ + rise + hills·s₂ + 2.2·fbm₃ + mtn`,
        row(`${MINUS}depth`, -t.depth, `depth = sd<0 ? 34·(1 ${MINUS} e^(sd/70)) : 0`),
        row("0.8·s₁", t.shoreStep, `s₁ = smoothstep(${MINUS}20, 20, sd)`),
        row("rise", t.rise, `0.032·max(sd, 0)·(1 ${MINUS} 0.5·mask)`),
        row("hills·s₂", t.hillsTerm, "26·fbm₄(0.0031·xz)·(0.12 + 0.88·s(0,900,sd))"),
        row("2.2·fbm₃", t.h3Term, `fbm₃(0.021·x ${MINUS} 8.2, 0.021·z + 4.4)`),
        row("mtn", t.mtn, "660·ridged₅(0.00072·warp(xz))^1.55·mask"),
        `  ${pad("h", 10)}= ${num(t.sum, 2, 7)} m${t.ok ? "" : "  (≈)"}`,
        `sd = |xz| ${MINUS} r_shore(θ)                   = ${num(t.sd, 1)}`,
        `r_shore = 330 + 70·n(1.7·û) + 26·n(4.1·û)  = ${num(t.rShore, 1)}`,
      ];
  return { kind: "terrain", title: "地形", latin: "TERRAIN", source: "core/heightfield.ts · heightAt(x, z)", here, lines };
}

/** 湖: Gerstner 波 3 つと、いまの風 */
function lakePanel(hit: Extract<ProbeHit, { kind: "lake" }>, compact: boolean): FormulaPanel {
  const w = Math.min(1.5, Math.max(0.15, hit.windSpeed / 8));
  const here = compact
    ? `x ${num(hit.x, 1)} z ${num(hit.z, 1)} 水面 y 0 ／ 水深 ${num(hit.depth, 1)} m ／ ${num(hit.dist, 0)} m 先`
    : `ここ x = ${num(hit.x, 1)}  z = ${num(hit.z, 1)}  水面 y = 0 ／ 水深 ${num(hit.depth, 1)} m ／ 距離 ${num(hit.dist, 0)} m`;
  const wd = `(${num(hit.windDir.x, 2)}, ${num(hit.windDir.y, 2)})`;
  const lines = compact
    ? [
        `y = Σᵢ Aᵢ·sin(φᵢ)   φᵢ = kᵢ(Dᵢ·xz ${MINUS} cᵢt)`,
        `xz′ = xz + Σᵢ 0.6·Aᵢ·Dᵢ·cos(φᵢ)  kᵢ = 2π/λᵢ`,
        `i A       λ     c       D`,
        `1 0.060w  9.0m  3.0m/s  wind`,
        `2 0.035w  4.2m  2.2m/s  wind+(0.6,${MINUS}0.4)`,
        `3 0.020w  2.1m  1.6m/s  wind+(${MINUS}0.5,0.7)`,
        `w = clamp(v/8,0.15,1.5) = ${num(w, 2)}  v = ${num(hit.windSpeed, 1)} m/s`,
        `t = ${num(hit.time, 1)} s   wind = ${wd}`,
      ]
    : [
        `y(xz,t) = Σᵢ Aᵢ·sin(φᵢ)        φᵢ = kᵢ·(Dᵢ·xz ${MINUS} cᵢ·t),  kᵢ = 2π/λᵢ`,
        `xz′ = xz + Σᵢ 0.6·Aᵢ·Dᵢ·cos(φᵢ)`,
        `  i  A        λ      c        D`,
        `  1  0.060·w  9.0 m  3.0 m/s  wind`,
        `  2  0.035·w  4.2 m  2.2 m/s  wind + (0.6, ${MINUS}0.4)`,
        `  3  0.020·w  2.1 m  1.6 m/s  wind + (${MINUS}0.5, 0.7)`,
        `w = clamp(v/8, 0.15, 1.5) = ${num(w, 2)}      v = ${num(hit.windSpeed, 1)} m/s   wind = ${wd}`,
        `t = ${num(hit.time, 1)} s                           y_surface = 0 (uLakeLevel)`,
      ];
  return { kind: "lake", title: "湖", latin: "LAKE", source: "water/index.ts · gerstner() × 3", here, lines };
}

/** 空: 大気散乱の積分と、いまの透過率 */
function skyPanel(hit: Extract<ProbeHit, { kind: "sky" }>, compact: boolean): FormulaPanel {
  const sign = (v: number) => (v >= 0 ? "+" : MINUS) + Math.abs(v).toFixed(1);
  const here = compact
    ? `仰角 ${sign(hit.elevDeg)}°  方位 ${num(hit.azDeg, 0)}° ／ 太陽 ${sign(hit.sunElevDeg)}° ／ ${clock(hit.hour)}`
    : `視線 仰角 ${sign(hit.elevDeg)}°  方位 ${num(hit.azDeg, 0)}° ／ 太陽 高度 ${sign(hit.sunElevDeg)}° ／ ${clock(hit.hour)}`;
  const lines = compact
    ? [
        `L = ∫₀ᴰ T(0,s)·σₛ(s)·P(θ)·E☉ ds + T·L_sky`,
        `T(a,b) = exp(${MINUS}∫ₐᵇ σ(h) ds)`,
        `σ(h) = σ₀·e^(${MINUS}0.0035h)  σ₀ = ${hit.sigma0.toFixed(6)}`,
        `T(0, 5 km) = ${num(hit.transmittance, 2)}   fog = ${num(hit.fog, 2)}`,
        `sky = mix(zenith, horizon, (1${MINUS}ω_y)^2.6)`,
        `    + dusk·(1${MINUS}ω_y)^6 + halo·(ω·☉)^14`,
      ]
    : [
        `L(ω) = ∫₀ᴰ T(0,s)·σₛ(s)·P(θ)·E☉ ds + T(0,D)·L_sky`,
        `T(a,b) = exp(${MINUS}∫ₐᵇ σ(h(s)) ds)         σ(h) = σ₀·e^(${MINUS}0.0035·h)`,
        `σ₀ = 0.00026·(0.35 + 1.4·fog)         = ${hit.sigma0.toFixed(6)}   fog = ${num(hit.fog, 2)}`,
        `T(0, 5 km)                            = ${num(hit.transmittance, 2)}`,
        `sky(ω) = mix(zenith, horizon, (1 ${MINUS} ω_y)^2.6)`,
        `       + dusk·(1 ${MINUS} ω_y)^6·(0.35 + 0.65·(ω·☉)^3) + halo·(ω·☉)^14`,
      ];
  return { kind: "sky", title: "空", latin: "SKY", source: "core/glsl/atmosphere.glsl.ts · flip_aerial", here, lines };
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
      `h(x,z) = ${MINUS}depth(sd) + 0.8·s(${MINUS}20,20,sd) + rise + hills·s(${MINUS}40,60,sd) + 2.2·fbm₃ + mtn`,
      `mtn = 660·ridged₅(0.00072·warp(x,z))^1.55·s(420,1500,sd)^1.4      × ${heightmapRes}² 点`,
    ];
  }
  if (/光|空気/.test(step)) {
    return [
      `L(ω) = ∫₀ᴰ T(0,s)·σₛ(s)·P(θ)·E☉ ds + T(0,D)·L_sky`,
      `T(a,b) = exp(${MINUS}∫ₐᵇ σ₀·e^(${MINUS}0.0035·h(s)) ds)`,
    ];
  }
  if (/描画/.test(step)) {
    return [`y(xz,t) = Σᵢ Aᵢ·sin(kᵢ·(Dᵢ·xz ${MINUS} cᵢ·t)),  kᵢ = 2π/λᵢ      湖の波 × 3`];
  }
  return [];
}
