"use client";
// 入口の黒板（ガリレオ演出）。読み込みの待ち時間に、世界を作っている式が書かれていく。
// 手書きフォントのファイルは使わない ― 字はすべて src/blackboard/strokefont.ts のポリライン。
//
// 2 つの姿:
//   通常  … 入口の言葉（Landing）を避けて空いた所から書く。**全 6 分野を 12〜15 秒で書き終える**
//   ぜんぶ … 「黒板をぜんぶ見る」を押したとき。前面に出て、導出を全部・書き終わった姿で並べる（縦に流す）
//
// 軽さの約束（docs/ARCHITECTURE.md「訪れる人の端末を重くしない」）:
//   ・feTurbulence はタイル 2 枚だけ。画面全体には掛けない
//   ・書き取りは CSS。JS は「次の行を出す」瞬間しか動かない（1 行につき setState 1 回）
//   ・書き終わった行は数本の <path> に畳む（生きた <path> は 150 本を超えない）
//   ・入場したら DOM ごと外す（世界の描画には 1 円も払わせない）
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import "@/blackboard/blackboard.css";
import { ChalkDefs, ChalkLine, inkDuration, inkOfNodes, inkOfText, type InkLine } from "@/blackboard/render";
import { handLine } from "@/blackboard/strokefont";
import { boardScript, boardScriptFull, type Cue } from "@/blackboard/script";
import { E } from "@/data/formulas";
import { hash2 } from "@/engine/core/noise";

type Props = {
  phase: "loading" | "ready" | "in";
  isMobile: boolean;
  /** 「黒板をぜんぶ見る」で前面に出ているか */
  full?: boolean;
  onClose?: () => void;
};

type Placed = {
  cue: Cue;
  line?: InkLine;
  x: number;
  y: number;
  size: number;
  at: number;
  dur: number;
  back?: boolean;
  note?: string[];
  /** その行が入っている段の幅（出典行を収めるのに使う） */
  colW: number;
  tilt?: number;
  ink?: number;
};

type Rect = { x: number; y: number; w: number; h: number };
/** 段。かつて「入口の言葉の裏に薄く書く段（dim）」があったが、重なって両方読めなくなるので外した */
type Region = Rect;
type Opts = { off: boolean; hold: boolean; all: boolean; still: boolean; pen: number; font: boolean; fullp: boolean };

const PAD = 42;
/**
 * ペンの速さ（em に対する倍率）。全 6 分野が 12〜15 秒で書き終わる速さ。
 * 速いが「書いている」のは見える（1 行 1.2〜1.6 秒）。
 */
const PEN = 50;
const GAP_LINE = 130;
const GAP_HEAD = 90;
const GAP_FAIL = 280;
const NOTE_DESKTOP = 10.2;
const NOTE_NARROW = 11.5;

/** 字形と組みの見本（?bbfont=1）。開発用。 */
const SPECIMEN: Cue[] = [
  { k: "head", text: "線文字の見本", latin: "STROKE FONT" },
  { k: "line", nodes: E(`ABCDEFGHIJKLM`), note: "大文字" },
  { k: "line", nodes: E(`NOPQRSTUVWXYZ`) },
  { k: "line", nodes: E(`abcdefghijklmnopqrstuvwxyz`), note: "小文字" },
  { k: "line", nodes: E(`0123456789`), note: "数字と記号" },
  { k: "line", nodes: E(`+-×·/=()[]\\{\\}<>,.'^_| ≈≤≥→ ±∈~#%°*?!:;`) },
  { k: "line", nodes: E(`Σ∫∂√π θλωαβγδεσμρτφξΨΔ∇∞☉`), note: "ギリシャ・数学記号" },
  { k: "line", nodes: E(`\\r{9.81k + 7.4·10^{-5}k^{3}}`), note: "√ の上棒（中身の端まで伸びるか）" },
  { k: "line", nodes: E(`\\f{a + b}{c^{2} - d}  \\S{i=0}{N-1}{x_i}  \\I{0}{D}{f(s)}{s}  \\F{clamp}{x, 0, 1}`), note: "分数・Σ・∫・関数" },
  { k: "line", nodes: E(`\\c{k}·\\c{w}  x^{2}_{i}  \\t{hot}{term}`), note: "ハット・上下付き・項" },
];

function param(name: string): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get(name);
}
/** 和文は線文字を作れないのでシステムフォントだが、**1 字ずつ傾けて上下に振る**と手書きに寄る。
 *  SVG の rotate / dy はグリフ単位に効くので、tspan を足さずに済む（DOM が増えない）。
 *  ばらつきは hash2 で決定的（同じ字は毎回同じ揺れ方をする）。 */
function hand(text: string, seed: number, tilt = 3.0, jump = 0.8) {
  const n = [...text].length;
  const rot: string[] = [];
  const dy: string[] = [];
  for (let i = 0; i < n; i++) {
    rot.push(((hash2(seed, i, 31) - 0.5) * 2 * tilt).toFixed(1));
    dy.push(((hash2(seed, i, 53) - 0.5) * 2 * jump).toFixed(2));
  }
  return { rotate: rot.join(" "), dy: dy.join(" ") };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 和文の添え書きを列幅で折る（最大 2 行） */
function wrapNote(s: string, colW: number, noteSize: number): string[] {
  const per = Math.max(8, Math.floor(colW / noteSize));
  if (s.length <= per) return [s];
  const a = s.slice(0, per);
  const rest = s.slice(per);
  return [a, rest.length <= per ? rest : rest.slice(0, per - 1) + "…"];
}

export default function Blackboard({ phase, isMobile, full = false, onClose }: Props) {
  const [vp, setVp] = useState({ w: 1440, h: 900 });
  const [shown, setShown] = useState(0);
  const [gone, setGone] = useState(false);

  // URL と prefers-reduced-motion はブラウザにしかない。サーバ描画とずれないよう、載ってから読む
  const [opts, setOpts] = useState<Opts | null>(null);
  useEffect(() => {
    const bb = param("bb");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setOpts({
      off: param("nohud") === "1" || bb === "off",
      hold: bb === "hold",
      all: param("bball") === "1" || still,
      still,
      pen: Number(param("bbpen")) || PEN,
      font: param("bbfont") === "1",
      fullp: param("bbfull") === "1", // 撮影・共有用に「ぜんぶ見る」を直接開く
    });
  }, []);

  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // Esc で「ぜんぶ見る」を閉じる
  useEffect(() => {
    if (!full || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full, onClose]);

  // ---- 版を組む（画面の大きさ・姿が変わったときだけ）
  const plan = useMemo(() => {
    const pen = opts?.pen ?? PEN;
    const wide = full || !!opts?.font || !!opts?.fullp; // 見本も「ぜんぶ見る」と同じ版面で組む
    const aspect = vp.w / Math.max(1, vp.h);
    const narrow = aspect < 1.15;
    const VW = narrow ? 440 : 1000;
    const VHview = Math.round(VW / Math.max(0.34, aspect));
    const size = wide ? (narrow ? 19 : 15) : narrow ? 15.5 : 13;
    const noteSize = narrow ? NOTE_NARROW : NOTE_DESKTOP;
    const pad = narrow ? 26 : PAD;

    // 入口の言葉が載る所（実測: desktop は左 0〜45%・上下 26.5〜69%、携帯は中ほど）
    const landing: Rect = narrow
      ? { x: 0, y: VHview * 0.245, w: VW, h: VHview * 0.45 }
      : { x: 0, y: VHview * 0.265, w: VW * 0.45, h: VHview * 0.425 };

    let regions: Region[];
    if (wide) {
      // 前面。入口を避ける必要は無いので、画面いっぱいを「見開き」にして、
      // 足りなければ下へ次の見開きを継ぎ足す（縦に流して読む）
      const cols = narrow ? 1 : 2;
      const gap = 46;
      const colW = (VW - pad * 2 - gap * (cols - 1)) / cols;
      const top = narrow ? 68 : 72;
      const pageH = VHview;
      regions = [];
      for (let p = 0; p < 8; p++) {
        for (let c = 0; c < cols; c++) {
          regions.push({ x: pad + c * (colW + gap), y: p * pageH + top, w: colW, h: pageH - top - 40 });
        }
      }
    } else if (narrow) {
      regions = [
        { x: pad, y: 62, w: VW - pad * 2, h: landing.y - 62 - 8 },
        { x: pad, y: landing.y + landing.h + 24, w: VW - pad * 2, h: VHview - (landing.y + landing.h) - 24 - 74 },
      ];
    } else {
      regions = [
        { x: VW * 0.5, y: 38, w: VW * 0.965 - VW * 0.5, h: VHview - 38 - 40 },
        { x: PAD, y: 34, w: VW * 0.44 - PAD, h: landing.y - 34 - 6 },
        { x: PAD, y: landing.y + landing.h + 24, w: VW * 0.44 - PAD, h: VHview - (landing.y + landing.h) - 24 - 38 },
      ];
    }
    // 入口の言葉の裏に薄く書く段（dim）は外した。批評R4〜R7 が 4 ラウンド続けて
    // 「15 秒後に左段が言葉の真下に書かれ、両方読めなくなる」と指摘したため。
    // 同じ内容は「黒板を読む」の全景で読める。

    const cues = opts?.font ? SPECIMEN : wide ? boardScriptFull() : boardScript(24);
    const placed: Placed[] = [];
    let ri = 0;
    let y = regions[0].y;
    let t = 200;
    let bottom = 0;
    for (const cue of cues) {
      if (ri >= regions.length) break;
      const R = regions[ri];
      if (cue.k === "head") {
        const h = wide ? 40 : 29;
        // 見出しだけが段の底に取り残されないよう、次の 1 行ぶんの余りも見る
        if (y + h + 46 > R.y + R.h) {
          ri++;
          if (ri >= regions.length) break;
          y = regions[ri].y;
        }
        const RR = regions[ri];
        placed.push({ cue, x: RR.x, y: y + (wide ? 16 : 12), size, at: t, dur: 240, colW: RR.w });
        y += h;
        bottom = Math.max(bottom, y);
        t += GAP_HEAD;
        continue;
      }
      let ln = inkOfNodes(cue.nodes, size, placed.length + 1);
      if (ln.w > R.w) ln = inkOfNodes(cue.nodes, size * (R.w / ln.w), placed.length + 1);
      const note = cue.note ? wrapNote(cue.note, R.w, noteSize) : undefined;
      const noteH = note ? note.length * (noteSize + 2.5) + 2 : 0;
      const h = ln.asc + ln.desc + noteH + (cue.src ? (wide ? 17 : 13) : 0) + (wide ? 15 : 7);
      if (y + h > R.y + R.h) {
        ri++;
        if (ri >= regions.length) break;
        y = regions[ri].y;
      }
      const RR = regions[ri];
      const dur = inkDuration(ln, size * pen);
      const k = placed.length;
      placed.push({
        cue,
        line: ln,
        colW: RR.w,
        tilt: (hash2(k, 3, 61) - 0.5) * 1.1,
        ink: 0.9 + hash2(k, 5, 17) * 0.1,
        x: RR.x + hash2(k, 7, 29) * size * 0.5,
        y: y + noteH + ln.asc,
        size,
        at: t,
        dur,
        note,
      });
      y += h;
      bottom = Math.max(bottom, y);
      t += dur + (cue.failed ? GAP_FAIL : GAP_LINE);
    }
    // 「ぜんぶ見る」は中身の高さぶんだけ縦に伸ばす（それを縦に流して読む）
    const VH = wide ? Math.max(VHview, Math.ceil(bottom + 40)) : VHview;
    return { VW, VH, VHview, placed, noteSize, total: t };
  }, [vp.w, vp.h, isMobile, opts?.pen, opts?.font, full]);

  // ---- 1 行ずつ出す（rAF も setInterval も使わない。行ごとに setTimeout 1 回）
  useEffect(() => {
    if (!opts) return;
    if (opts.off || opts.all || full || opts.font || opts.fullp) {
      setShown(plan.placed.length);
      return;
    }
    setShown(0);
    const t0 = performance.now();
    let timer = 0;
    let i = 0;
    const tick = () => {
      i++;
      setShown(i);
      if (i >= plan.placed.length) return;
      timer = window.setTimeout(tick, Math.max(0, t0 + plan.placed[i].at - performance.now()));
    };
    timer = window.setTimeout(tick, plan.placed[0]?.at ?? 0);
    return () => window.clearTimeout(timer);
  }, [plan, opts, full]);

  // ---- 入口の暗幕は黒板があるとき弱める（globals.css は書き換えない）
  useEffect(() => {
    if (!opts || opts.off) return;
    document.body.classList.add("bb-on");
    return () => document.body.classList.remove("bb-on");
  }, [opts]);

  // ---- 入場したら消す
  const out = phase === "in" && !opts?.hold;
  useEffect(() => {
    if (!out) return;
    const t = window.setTimeout(() => setGone(true), 1300);
    return () => window.clearTimeout(t);
  }, [out]);

  if (!opts || opts.off || gone) return null;
  const wide = full || opts.font || opts.fullp;

  // 書き進むほど板が薄くなる（式が風景になる）。ぜんぶ見るときは薄くしない
  const prog = plan.placed.length ? shown / plan.placed.length : 0;
  const ground = full ? 1 : 0.985 - 0.105 * Math.min(1, prog * 1.2) - (phase === "loading" ? 0 : 0.03);

  return (
    <div
      className={`bb${out ? " bb-out" : ""}${opts.still ? " bb-still" : ""}${wide ? " bb-full" : ""}`}
      aria-hidden={!full}
      role={full ? "dialog" : undefined}
      aria-label={full ? "黒板 — 世界の作り方" : undefined}
    >
      <svg viewBox={`0 0 ${plan.VW} ${plan.VH}`} preserveAspectRatio={wide ? "xMidYMin meet" : "xMidYMid slice"}>
        <ChalkDefs />
        <g>
          <rect className="bb-ground" width={plan.VW} height={plan.VH} opacity={ground} />
          <rect width={plan.VW} height={plan.VH} fill="url(#bbBoard)" opacity={0.8 * ground} />
          {/* 前の授業の消し跡（放射グラデーション＝フィルタ無しで縁が柔らかい） */}
          <ellipse cx={plan.VW * 0.28} cy={plan.VHview * 0.34} rx={plan.VW * 0.3} ry={plan.VHview * 0.15} fill="url(#bbSmear)" />
          <ellipse cx={plan.VW * 0.74} cy={plan.VHview * 0.7} rx={plan.VW * 0.24} ry={plan.VHview * 0.12} fill="url(#bbSmear)" />
          <ellipse cx={plan.VW * 0.5} cy={plan.VHview * 0.1} rx={plan.VW * 0.36} ry={plan.VHview * 0.07} fill="url(#bbSmear)" opacity="0.7" />
          {/* 拭き跡の横筋（黒板消しを横に走らせた跡）。板であることの手掛かり */}
          {[0, 1, 2, 3, 4].map((k) => {
            const yy = plan.VHview * (0.13 + k * 0.19);
            const l = handLine(plan.VW * (k % 2 ? 0.05 : 0.18), yy, plan.VW * (k % 2 ? 0.88 : 0.99), yy + plan.VHview * 0.02, 3300 + k * 7, 2.2);
            return <path key={k} className="bb-sweep" d={l.d} strokeWidth={plan.VHview * (0.012 + (k % 3) * 0.006)} stroke="#dfeee2" />;
          })}
          {/* 板の下にたまった粉 */}
          <rect x="0" y={plan.VH - plan.VHview * 0.09} width={plan.VW} height={plan.VHview * 0.09} fill="url(#bbDust)" />
          {wide && plan.VH > plan.VHview && (
            <ellipse cx={plan.VW * 0.4} cy={plan.VHview * 1.3} rx={plan.VW * 0.34} ry={plan.VHview * 0.14} fill="url(#bbSmear)" opacity="0.8" />
          )}
        </g>

        {wide && (
          <text
            className="bb-title"
            x={plan.VW < 600 ? 26 : plan.VW * 0.5}
            y={plan.VW < 600 ? 30 : 34}
            textAnchor={plan.VW < 600 ? "start" : "middle"}
            {...hand("世界の作り方 ／ 消した式もそのまま", 3, 2.2, 0.7)}
          >
            世界の作り方 ／ 消した式もそのまま
          </text>
        )}

        {plan.placed.slice(0, shown).map((p, i) =>
          p.cue.k === "head" ? (
            <Head key={i} p={p} full={wide} />
          ) : (
            <g
              key={i}
              className={p.cue.failed ? "bb-fail" : undefined}
              style={{ "--fd": `${p.dur}ms`, opacity: (p.back ? 0.42 : 1) * (p.ink ?? 1) } as CSSProperties}
              transform={`rotate(${(p.tilt ?? 0).toFixed(2)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
            >
              {p.note?.map((t, k) => (
                <text
                  key={k}
                  className="bb-note"
                  style={{ fontSize: plan.noteSize }}
                  x={p.x}
                  y={p.y - p.line!.asc - 6 - (p.note!.length - 1 - k) * (plan.noteSize + 2.5)}
                  {...hand(t, i * 7 + k)}
                >
                  {t}
                </text>
              ))}
              <ChalkLine
                line={p.line!}
                x={p.x}
                y={p.y}
                size={p.size}
                speed={p.size * (opts.pen || PEN)}
                still={opts.still || opts.all || wide}
                failed={p.cue.failed}
                seed={i + 1}
              />
              {p.cue.src && (
                <SrcLine text={p.cue.src} x={p.x + 2} y={p.y + p.line!.desc + (wide ? 15 : 12)} size={p.size * 0.72} seed={i + 400} maxW={p.colW} />
              )}
            </g>
          ),
        )}
      </svg>

      <div className="bb-frame" aria-hidden>
        <div className="bb-tray">
          <span className="bb-chalk" style={{ left: "7%", width: 34 }} />
          <span className="bb-chalk" style={{ left: "12.5%", width: 22, opacity: 0.8 }} />
          <span className="bb-eraser" />
        </div>
      </div>

      {(full || opts.fullp) && (
        <button className="bb-close" type="button" onClick={onClose}>
          閉じる
        </button>
      )}
    </div>
  );
}

/** 出典（ASCII なので線文字で書ける ― 板の上の字を UI のフォントにしない） */
function SrcLine({ text, x, y, size, seed, maxW }: { text: string; x: number; y: number; size: number; seed: number; maxW: number }) {
  const line = useMemo(() => {
    const l = inkOfText(text, size, seed);
    return l.w > maxW ? inkOfText(text, size * (maxW / l.w), seed) : l;
  }, [text, size, seed, maxW]);
  return (
    <g className="bb-srcline">
      <ChalkLine line={line} x={x} y={y} size={size} still dim seed={seed} />
    </g>
  );
}

/** 章の見出し。和文だけシステムフォント（線文字を作れない）、欧文は線文字 */
function Head({ p, full }: { p: Placed; full: boolean }) {
  const cue = p.cue as Extract<Cue, { k: "head" }>;
  const fs = full ? 19 : 15;
  // 和文の幅ぶんだけ右に置く（字数 × 字送り。全角なので font-size とほぼ同じ）
  const jaW = cue.text.length * fs * 1.26;
  const latin = useMemo(() => inkOfText(cue.latin, fs * 0.62, 900 + cue.latin.length), [cue.latin, fs]);
  const rule = useMemo(() => Math.max(52, jaW * 0.86), [jaW]);
  return (
    <g style={{ opacity: p.back ? 0.42 : 1 }}>
      <text className="bb-head" style={{ fontSize: fs }} x={p.x} y={p.y} {...hand(cue.text, 41, 2.0, 0.6)}>
        {cue.text}
      </text>
      <ChalkLine line={latin} x={p.x + jaW + 10} y={p.y - 1} size={fs * 0.62} still dim seed={7} />
      <path
        className="bb-w"
        style={{ "--l": "160", "--l0": "164", "--t": "420ms", "--d": "0ms" } as CSSProperties}
        d={`M${p.x} ${p.y + 8}L${p.x + rule * 0.64} ${p.y + 7.4}L${p.x + rule} ${p.y + 8.8}`}
        strokeWidth={full ? 3.1 : 2.7}
        stroke="url(#bbChalk)"
      />
    </g>
  );
}
