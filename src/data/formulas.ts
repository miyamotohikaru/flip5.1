// 黒板に書く式。**実際に使っている式だけ**を、出典（file:line）つきで持つ。
// 式は文字列ではなく木（Node）。項を指して光らせ、実行中の数値を差し込むため。
//
// 書き方は E(`...`) の小さな記法（下の parse を見る）:
//   \f{分子}{分母}   分数        \r{中身}        √
//   \S{下}{上}{中身} Σ           \I{下}{上}{中身}{変数}  ∫
//   \t{id}{中身}     項（光らせる単位）          \v{id}{桁}  実行中の値
//   \F{名}{引数}     関数（括弧が中身の高さに伸びる）
//   \c{k}            k ハット（k\u0302）
//   ^{...} 上付き   _{...} 下付き   -（半角）は自動で − になる
//
// **嘘を書かない。** ここに無い式は世界にも無い。failed: true の段は本当にあった失敗（docs/critique/round1.md）。
import type { World } from "@/engine/world";
import { heightPartsAt } from "@/engine/core/height";

export type Op = "+" | "−" | "·" | "/" | "=" | "<" | ">" | "≈" | "≤" | "≥" | "→" | "×";

export type Node =
  | { t: "sym"; s: string }
  | { t: "num"; v: number; d?: number }
  | { t: "op"; s: Op }
  | { t: "fn"; name: string; args: Node[][] }
  | { t: "frac"; num: Node[]; den: Node[] }
  | { t: "sup"; base: Node[]; sup: Node[] }
  | { t: "sub"; base: Node[]; sub: Node[] }
  | { t: "sum"; from: Node[]; to: Node[]; body: Node[] }
  | { t: "int"; from: Node[]; to: Node[]; body: Node[]; d: string }
  | { t: "term"; id: string; body: Node[] }
  | { t: "live"; id: string; d?: number }
  | { t: "brk" };

export type Area = "terrain" | "sky" | "water" | "vegetation" | "weather" | "audio" | "core";

export type Step = {
  /** 段の説明（黒板の隅に小さく添える和文） */
  note: string;
  body: Node[];
  /** 本当にあった失敗。打ち消し線＋黒板消しの跡が残る */
  failed?: boolean;
};

export type Param = {
  /** term の id と対応（動かすとその項が光る） */
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get: (w: World) => number;
  set: (w: World, v: number) => void;
  /** 変えたら世界を焼き直す必要があるか */
  rebake?: boolean;
};

export type Formula = {
  id: string;
  /** 黒板の見出し（日本語・短く） */
  title: string;
  area: Area;
  /** 出典（実際のコード。file:line） */
  src: string;
  /** 式そのもの */
  body: Node[];
  /** 実行中の値つきの短い1行（世界の中の隅・実験室で使う）。live ノートを含む */
  now?: Node[];
  /** 導出の段階（黒板で順に書かれる） */
  steps?: Step[];
  /** 実行中の値。100ms に1回でよい */
  live?: (w: World) => Record<string, number>;
  params?: Param[];
};

// ---------------------------------------------------------------------------
// 小さな記法 → 木
const OPS = new Set<string>(["+", "−", "·", "/", "=", "<", ">", "≈", "≤", "≥", "→", "×"]);

export function E(src: string): Node[] {
  let i = 0;

  const group = (): Node[] => {
    if (src[i] !== "{") return [];
    i++;
    const out = seq();
    if (src[i] === "}") i++;
    return out;
  };
  const groupText = (): string => {
    if (src[i] !== "{") return "";
    i++;
    let s = "";
    while (i < src.length && src[i] !== "}") s += src[i++];
    if (src[i] === "}") i++;
    return s;
  };
  const groupOrChar = (): Node[] => {
    if (src[i] === "{") return group();
    const c = src[i++];
    return [{ t: "sym", s: c === "-" ? "−" : c }];
  };

  const command = (): Node[] => {
    const name = src[i++];
    switch (name) {
      case "f":
        return [{ t: "frac", num: group(), den: group() }];
      case "r":
        return [{ t: "fn", name: "√", args: [group()] }];
      case "S":
        return [{ t: "sum", from: group(), to: group(), body: group() }];
      case "I": {
        const from = group(), to = group(), body = group();
        return [{ t: "int", from, to, body, d: groupText() }];
      }
      case "t":
        return [{ t: "term", id: groupText(), body: group() }];
      case "v": {
        const id = groupText();
        const d = Number(groupText());
        return [{ t: "live", id, d: Number.isFinite(d) ? d : 2 }];
      }
      case "F":
        return [{ t: "fn", name: groupText(), args: [group()] }];
      case "c": {
        // 結合の ^（k\u0302 = k ハット）
        const inner = groupText();
        return [{ t: "sym", s: inner + "\u0302" }];
      }
      case "n":
        return [{ t: "brk" }];
      default:
        return [{ t: "sym", s: name }];
    }
  };

  function seq(): Node[] {
    const list: Node[] = [];
    while (i < src.length) {
      const c = src[i];
      if (c === "}") break;
      i++;
      if (c === "\\") {
        list.push(...command());
        continue;
      }
      if (c === "^" || c === "_") {
        const arg = groupOrChar();
        const base = list.pop() ?? ({ t: "sym", s: "" } as Node);
        list.push(c === "^" ? { t: "sup", base: [base], sup: arg } : { t: "sub", base: [base], sub: arg });
        continue;
      }
      if (c === "{") {
        i--;
        list.push(...group());
        continue;
      }
      if (c === "-") {
        list.push({ t: "op", s: "−" });
        continue;
      }
      if (OPS.has(c)) {
        list.push({ t: "op", s: c as Op });
        continue;
      }
      list.push({ t: "sym", s: c });
    }
    return list;
  }

  return seq();
}

// ---------------------------------------------------------------------------
// 式（実際に使っているものだけ）

const terrain: Formula[] = [
  {
    id: "terrain.h",
    title: "地形の高さ",
    area: "terrain",
    src: "src/engine/core/height.ts:176 heightAt(x, z)",
    body: E(`h(x,z) = \\t{base}{base}(x,z) + \\t{mtn}{mtn}(x,z) + \\t{fine}{fine}(x,z)`),
    now: E(`h(\\v{x}{0}, \\v{z}{0}) = \\v{base}{1} + \\v{mtn}{1} + \\v{fine}{2} = \\v{h}{2} m`),
    steps: [
      {
        note: "はじめ: ノイズをただ重ねた → 山が団子になった",
        failed: true,
        body: E(`h = 700·\\S{i=0}{7}{2^{-i}·n(2^{i}·0.0008·xz)}`),
      },
      {
        note: "尾根ノイズ: 折り返して二乗し、前の層を重みにする",
        body: E(`R(p) = \\S{i}{}{a_i·r_i^{2}·w_i},   r_i = 1 - |n(2^{i}p)|,   w_i = \\F{clamp}{2r_{i-1}^{2}, 0, 1}`),
      },
      {
        note: "走向: 座標をゆがめ、東西に引き伸ばす",
        body: E(`p = ((x + 300·n(0.00052·xz))·0.00048,  (z + 300·n(0.00052·xz))·0.00078)`),
      },
      {
        note: "侵食: 傾きが立つほど細かい層を弱める",
        body: E(`E(p) = \\S{i}{}{\\f{a_i·n(2^{i}p)}{1 + 0.55·|\\S{j≤i}{}{∇n_j}|^{2}}}`),
      },
      { note: "段丘: 高さを 46 m ごとの段にする", body: E(`T(h) = (\\F{floor}{h/46} + s^{2}(3-2s))·46,   s = \\F{clamp}{(h/46 - \\F{floor}{h/46} - 0.32)/0.36}`) },
      { note: "3 つを足す。世界の高さはこれだけ", body: E(`h = base + mtn + fine`) },
    ],
    live: (w) => {
      const p = w.controls?.position;
      const x = p ? p.x : 0, z = p ? p.z : 0;
      const t = heightPartsAt(x, z);
      return { x, z, h: t.h, base: t.base, mtn: t.mtn, fine: t.fine, sd: t.shore };
    },
  },
  {
    id: "terrain.shore",
    title: "岸線",
    area: "terrain",
    src: "src/engine/core/height.ts:142 angShore",
    body: E(`r_s(θ) = 330 + 70·n(1.7·\\c{u}(θ)) + 26·n(4.1·\\c{u}(θ))`),
    now: E(`sd = |xz| - r_s(θ) = \\v{sd}{1} m`),
    steps: [{ note: "岸線からの距離 sd が負の所だけ掘る", body: E(`depth(sd) = 34·(1 - e^{sd/70})·bed(xz)`) }],
    live: (w) => {
      const p = w.controls?.position;
      const t = heightPartsAt(p ? p.x : 0, p ? p.z : 0);
      return { sd: t.shore };
    },
  },
];

const sky: Formula[] = [
  {
    id: "sky.scatter",
    title: "空の色（大気散乱）",
    area: "sky",
    src: "src/engine/sky/lut.glsl.ts:108 flip_scatterMarch",
    body: E(`L(ω) = \\I{0}{D}{T(0,s)·(σ^{R}(s)·p^{R}(θ) + σ^{M}(s)·p^{M}(θ))·E_☉ + T(0,s)·σ_s(s)·Ψ(s)}{s}`),
    now: E(`θ = \\v{theta}{1}°,   p^{M}(θ) = \\v{pM}{4},   T(5km) = \\v{T}{2}`),
    steps: [
      { note: "透過率: 光が減る分（Beer–Lambert）", body: E(`T(a,b) = \\F{exp}{-\\I{a}{b}{σ_e(h(s))}{s}}`) },
      {
        note: "レイリー散乱: 青がいちばんよく散る",
        body: E(`σ^{R}(h) = (5.802, 13.558, 33.10)·10^{-3}·e^{-h/8.0km}`),
      },
      {
        note: "はじめ: ミーが弱く、夕焼けが白いままだった",
        failed: true,
        body: E(`σ^{M}(h) = 3.2·10^{-3}·e^{-h/2.5km}`),
      },
      { note: "直し: ミーと靄を上げたら橙が出た", body: E(`σ^{M}(h) = 8.0·10^{-3}·e^{-h/2.5km} + haze(h)`) },
      { note: "位相関数: レイリーは前後対称", body: E(`p^{R}(θ) = \\f{3}{16π}(1 + \\F{cos}{θ}^{2})`) },
      {
        note: "ミーは前方に強い（g = 0.76）",
        body: E(`p^{M}(θ) = \\f{3(1-g^{2})(1+\\F{cos}{θ}^{2})}{2(2+g^{2})(1+g^{2}-2g\\F{cos}{θ})^{3/2}}`),
      },
      { note: "霧と雲は Henyey–Greenstein", body: E(`p_{HG}(θ) = \\f{1-g^{2}}{4π(1+g^{2}-2g\\F{cos}{θ})^{3/2}}`) },
      { note: "多重散乱: 無限級数の和を1回で解く", body: E(`Ψ = \\f{L_{2}}{1 - f}`) },
    ],
    live: (w) => ({ hour: w.env.hour, T: 0, theta: 0 }),
  },
  {
    id: "sky.aerial",
    title: "空気遠近",
    area: "sky",
    src: "src/engine/sky/atmosphere.glsl.ts:186 flip_aerial",
    body: E(`C' = C·T(0,d) + L_s(0,d)`),
    steps: [
      { note: "地表の霧は指数層。閉じた式で解く", body: E(`τ = ρ·\\f{H}{Δy}(e^{-y_a/H} - e^{-y_b/H})·d`) },
      { note: "むら: 一様な霧は「フィルター」に見える", body: E(`τ  →  τ·(0.4 + 1.2·n(0.0032·xz))`) },
    ],
  },
];

const water: Formula[] = [
  {
    id: "water.wave",
    title: "湖の波",
    area: "water",
    src: "src/engine/water/wavesim.ts:41 spectrum / :72 分散関係 / :76 h(k,t)",
    body: E(`h(x,t) = \\S{k}{}{\\c{h}(k,t)·e^{i k·x}}`),
    now: E(`U = \\v{U}{1} m/s   h_s = \\v{hs}{3} m   λ_p = \\v{lp}{2} m`),
    steps: [
      { note: "風波のスペクトル（Phillips 型）", body: E(`S(k) = \\t{amp}{A}·\\f{e^{-k_p^{2}/k^{2}}}{k^{4}}·\\F{mix}{0.03, 1, (\\c{k}·\\c{w})^{p}}`) },
      { note: "2 cm 以下の波は表面張力で消える", body: E(`S  →  S·e^{-0.0004k^{2}}·(1 + k^{2}/k_t^{2})^{-1/2}`) },
      { note: "初期振幅はガウス乱数 × √S（決定的）", body: E(`\\c{h}_{0}(k) = \\f{ξ_r + iξ_i}{\\r{2}}·\\r{S(k)}·Δk`) },
      { note: "分散関係: 波長ごとに進む速さが違う", body: E(`ω(k) = \\r{9.81k + 7.4·10^{-5}k^{3}}`) },
      { note: "共役の項が逆向きの波。和は実数になる", body: E(`\\c{h}(k,t) = \\c{h}_{0}(k)e^{-iωt} + \\c{h}_{0}^{*}(-k)e^{+iωt}`) },
      { note: "波頭へ寄る変位。波が尖る", body: E(`D(x,t) = \\S{k}{}{i·\\c{k}·\\c{h}(k,t)·e^{i k·x}}`) },
      { note: "2 段のカスケードで逆 FFT する", body: E(`h = FFT^{-1}[\\c{h}],   N = 256, L = 250 m / 12 m`) },
    ],
    live: (w) => {
      const U = Math.max(w.env.weather.wind, 0.3);
      return { U, hs: 0.0025 + 0.0042 * U * U, lp: 0.35 + 0.062 * U * U };
    },
  },
  {
    id: "water.surface",
    title: "水面の反射",
    area: "water",
    src: "src/engine/water/shaders.ts:307 フレネル / :185 GGX",
    body: E(`F(θ) = F_{0} + (1 - F_{0})(1 - N·V)^{5},   F_{0} = 0.02`),
    steps: [
      { note: "ギラつきは GGX。粗さは消えた波の分散", body: E(`D(H) = \\f{α^{2}}{π((N·H)^{2}(α^{2}-1) + 1)^{2}}`) },
      { note: "遮蔽は Smith の式", body: E(`V = \\f{0.5}{(N·L)\\r{(N·V)^{2}(1-α^{2}) + α^{2}} + (N·V)\\r{(N·L)^{2}(1-α^{2}) + α^{2}}}`) },
      {
        note: "はじめ: a·b が負だと NaN。空に黒い筋が伸びた",
        failed: true,
        body: E(`c = (a·b)^{2.5}·(0.6 + 0.4c')·3`),
      },
      { note: "直し: 0..1 に留めてから累乗する", body: E(`c = (\\F{clamp}{a}·\\F{clamp}{b})^{2.5}·(0.6 + 0.4c')·3`) },
      { note: "浅瀬は砂が透け、深いと青緑になる", body: E(`C = C_r·e^{-σ_e(d_h + 1.3d_v)} + C_s(1 - e^{-0.22d_h})`) },
    ],
  },
];

const vegetation: Formula[] = [
  {
    id: "veg.tree",
    title: "針葉樹",
    area: "vegetation",
    src: "src/engine/vegetation/conifer.ts:50 幹 / :113 垂れ角 / :116 螺旋",
    body: E(`r(t) = r_{0}((1-t)^{0.85} + 0.015)(1 + 0.6e^{-30t}),   r_{0} = 0.011H + 0.04`),
    steps: [
      { note: "枝は黄金角 137.5° の螺旋に並ぶ", body: E(`φ_{j,b} = 2.39996·j + \\f{2πb}{n_B} + ε`) },
      { note: "下ほど長く、上ほど短い枝", body: E(`L(u) = l_{max}·H·(1 - 0.85u^{0.9})·(0.85 + 0.3ξ)`) },
      {
        note: "はじめ: 輪生 6 本 →「パゴダ」と言われた",
        failed: true,
        body: E(`δ(u) = 8° + 30°(1-u),   n_B = 6`),
      },
      { note: "直し: 枝を増やし、垂らし、ばらつかせる", body: E(`δ(u) = 15° + 35°(1-u) ± 10°,   n_B = 12~16`) },
    ],
  },
  {
    id: "veg.grass",
    title: "草",
    area: "vegetation",
    src: "src/engine/vegetation/grass.ts:47 葉の寸法 / :20 色",
    body: E(`w_leaf = 0.010 m,   h_tuft = 0.32(0.4 + 1.0ξ) m`),
    steps: [
      {
        note: "はじめ: 葉幅 3.4 cm の藁色 →「麦畑」",
        failed: true,
        body: E(`w_leaf = 0.034 m,   c_tip = (0.30, 0.42, 0.115)`),
      },
      { note: "直し: 本物の葉身は 3〜8 mm。緑も地形に合わせる", body: E(`w_leaf = 0.010 m,   c_tip = (0.11, 0.21, 0.05)`) },
    ],
  },
];

const audio: Formula[] = [
  {
    id: "audio.bird",
    title: "鳥の声",
    area: "audio",
    src: "src/engine/audio/birds.ts:148 スイープ / :152 ビブラート",
    body: E(`f(t) = f_{0}(f_{1}/f_{0})^{t/T} + D·\\F{sin}{2πrt}`),
    steps: [
      { note: "指数スイープ（耳は比で聞く）", body: E(`f(t) = f_{0}(f_{m}/f_{0})^{2t/T}   (t < T/2)`) },
      { note: "ビブラートは FM。変調指数 β = D/r", body: E(`β = D/r,   r = 12~18 Hz,   D = 8~20 Hz`) },
      { note: "ウグイスの1音目は 1350〜1550 Hz", body: E(`f_{0} = 1350~1550 Hz,   T = 0.45~0.7 s`) },
      { note: "包絡は線形の立ち上がりと減衰", body: E(`a(t) = \\F{min}{t/t_a, 1}·(1 - t/T)`) },
    ],
    live: (w) => ({ hour: w.env.hour }),
  },
  {
    id: "audio.rain",
    title: "雨粒",
    area: "audio",
    src: "src/engine/audio/dsp.ts:194 rainGrains",
    body: E(`x(t) = \\S{j}{}{a_j·g(t - t_j)},   t_j ~ Poisson(λ)`),
    steps: [
      { note: "一粒は減衰する正弦（葉に当たる音）", body: E(`g(t) = \\F{sin}{2πft}·e^{-t/τ},   f = 2.5~7 kHz`) },
      { note: "水面の粒は上がるチャープ（泡の共鳴）", body: E(`f(t) = f_{0}(1 + ρt/T),   f_{0} = 0.5~2.2 kHz`) },
      { note: "振幅は対数一様。大粒がときどき混じる", body: E(`a ~ \\F{logU}{0.06, 1},   P(a → 1.8a) = 0.07`) },
    ],
  },
  {
    id: "audio.thunder",
    title: "雷",
    area: "audio",
    src: "src/engine/audio/dsp.ts:266 包絡 / :146 インパルス応答",
    body: E(`y(t) = (x * r)(t) = \\I{0}{t}{x(s)r(t-s)}{s}`),
    steps: [
      { note: "包絡: 1.5 乗で立ち、指数で減る", body: E(`E(t) = (t/a)^{1.5}   (t < a),   e^{-(t-a)/τ}   (t ≥ a)`) },
      { note: "「ごろごろ」は山をいくつも足す", body: E(`E  →  E + \\S{j}{}{h_j·e^{-((t-p_j)/w_j)^{2}}}`) },
      { note: "谷の残響は雑音 × 減衰 × 暗くなる LPF", body: E(`r(t) = ξ(t)·e^{-6.9078t/T_{60}},   f_c(t) = f_{0}(f_{1}/f_{0})^{t/T}`) },
    ],
  },
];

const core: Formula[] = [
  {
    id: "core.noise",
    title: "ノイズ",
    area: "core",
    src: "src/engine/core/noise.ts:34 noise2 / :53 fbm2",
    body: E(`n(p) = \\F{mix}{\\F{mix}{g_{00}·d_{00}, g_{10}·d_{10}, f(u)}, \\F{mix}{g_{01}·d_{01}, g_{11}·d_{11}, f(u)}, f(v)}`),
    steps: [
      { note: "補間の重み。端で 1 階も 2 階も 0 になる", body: E(`f(t) = 6t^{5} - 15t^{4} + 10t^{3}`) },
      { note: "格子の勾配は座標のハッシュから引く", body: E(`g_{ij} = G[P[P[x_i] + y_j] mod 16]`) },
      { note: "fbm: 半分の振幅で倍の細かさを重ねる", body: E(`fbm(p) = \\f{\\S{i=0}{N-1}{g^{i}·n(l^{i}p)}}{\\S{i=0}{N-1}{g^{i}}},   l = 2, g = 0.5`) },
    ],
  },
  {
    id: "core.pi",
    title: "円周率",
    area: "core",
    src: "docs/critique/round1.md · シェーダの二重宣言",
    body: E(`π = 3.14159265358979`),
    steps: [
      {
        note: "空と水で PI を二度宣言。シェーダが無言で死んだ",
        failed: true,
        body: E(`#define PI  |  const float PI`),
      },
      { note: "直し: 囲って一度だけにする", body: E(`#ifndef PI ... #endif`) },
    ],
  },
];

export const FORMULAS: Formula[] = [...terrain, ...sky, ...water, ...vegetation, ...audio, ...core];

export const formulaById = (id: string): Formula | undefined => FORMULAS.find((f) => f.id === id);
export const formulasOf = (area: Area): Formula[] => FORMULAS.filter((f) => f.area === area);

/** 黒板に書く順（地形 → 空 → 水 → 木 → 音） */
export const BOARD_ORDER: Area[] = ["terrain", "sky", "water", "vegetation", "audio", "core"];
export const AREA_LABEL: Record<Area, string> = {
  terrain: "地形",
  sky: "空",
  water: "水",
  vegetation: "木と草",
  weather: "天気",
  audio: "音",
  core: "共通",
};
