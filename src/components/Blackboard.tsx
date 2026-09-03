"use client";
// 入口の黒板（ガリレオ演出）。読み込みの待ち時間に、世界を作っている式が書かれていく。
// 手書きフォントのファイルは使わない ― 字はすべて src/blackboard/strokefont.ts のポリライン。
//
// 版: 入口の言葉（Landing）が載る所は避けて書く。空いている場所（desktop は右の段 → 左の段、
//     携帯は上の帯 → 下の帯）の順に埋める。入口の言葉と重なる行は薄く（黒板の「前の書き込み」に見える）。
//
// 軽さの約束（docs/ARCHITECTURE.md「訪れる人の端末を重くしない」）:
//   ・feTurbulence はタイル 2 枚だけ。画面全体には掛けない
//   ・書き取りは CSS。JS は「次の行を出す」瞬間しか動かない（1 行につき setState 1 回）
//   ・書き終わった行は数本の <path> に畳む
//   ・入場したら DOM ごと外す（世界の描画には 1 円も払わせない）
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import "@/blackboard/blackboard.css";
import { ChalkDefs, ChalkLine, inkDuration, inkOfNodes, type InkLine } from "@/blackboard/render";
import { boardScript, type Cue } from "@/blackboard/script";
import { hash2 } from "@/engine/core/noise";
import { E } from "@/data/formulas";

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

type Props = {
  phase: "loading" | "ready" | "in";
  isMobile: boolean;
};

type Placed = {
  cue: Cue;
  line?: InkLine;
  x: number;
  y: number;
  size: number;
  at: number;
  dur: number;
  /** 入口の言葉と重なる → 薄く */
  back?: boolean;
  note?: string[];
  /** 行の傾き（度）。人は水平に書けない */
  tilt?: number;
  /** チョークの濃さ（0.9〜1.0） */
  ink?: number;
};

type Rect = { x: number; y: number; w: number; h: number };
type Opts = { off: boolean; hold: boolean; all: boolean; still: boolean; pen: number; font: boolean };

const PAD = 42;
/** ペンの速さ（em に対する倍率）。おおよそ 5 文字/秒 */
const PEN = 16;
const GAP_LINE = 320;
const GAP_HEAD = 220;
const GAP_FAIL = 700;
/** 添え書きの大きさ（版面の単位）。携帯は版面が小さいので少し大きく取る */
const NOTE_DESKTOP = 10.2;
const NOTE_NARROW = 11.5;

function param(name: string): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get(name);
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

export default function Blackboard({ phase, isMobile }: Props) {
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
    });
  }, []);

  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // ---- 版を組む（画面の大きさが変わったときだけ）
  const plan = useMemo(() => {
    const pen = opts?.pen ?? PEN;
    const aspect = vp.w / Math.max(1, vp.h);
    const narrow = aspect < 1.15;
    const VW = narrow ? 440 : 1000;
    const VH = Math.round(VW / Math.max(0.34, aspect));
    const size = narrow ? 17 : 13.5;
    const noteSize = narrow ? NOTE_NARROW : NOTE_DESKTOP;
    const pad = narrow ? 26 : PAD;

    // 入口の言葉が載る所（実測: desktop は左 0〜44%・上下 26〜68%、携帯は中ほど）
    const landing: Rect = narrow
      ? { x: 0, y: VH * 0.245, w: VW, h: VH * 0.45 }
      : { x: 0, y: VH * 0.265, w: VW * 0.45, h: VH * 0.425 };

    // 空いている所から順に埋める（いま書いている行がいつも見える所に来るように）。
    // 携帯は空きが少ないので 1 段で通し、入口の言葉と重なる行だけ薄くする
    const regions: Rect[] = narrow
      ? [{ x: pad, y: 58, w: VW - pad * 2, h: VH - 58 - 92 }]
      : [
          { x: VW * 0.5, y: PAD, w: VW * 0.965 - VW * 0.5, h: VH - PAD * 2 },
          { x: PAD, y: 34, w: VW * 0.44 - PAD, h: landing.y - 34 - 8 },
          { x: PAD, y: landing.y + landing.h + 14, w: VW * 0.44 - PAD, h: VH - (landing.y + landing.h) - PAD - 30 },
        ];

    const cues = opts?.font ? SPECIMEN : boardScript(24);
    const placed: Placed[] = [];
    let ri = 0;
    let y = regions[0].y;
    let t = 700;
    for (const cue of cues) {
      if (ri >= regions.length) break;
      const R = regions[ri];
      if (cue.k === "head") {
        const h = 31;
        // 見出しだけが段の底に取り残されないよう、次の 1 行ぶんの余りも見る
        if (y + h + 46 > R.y + R.h) {
          ri++;
          if (ri >= regions.length) break;
          y = regions[ri].y;
        }
        const RR = regions[ri];
        placed.push({ cue, x: RR.x, y: y + 12, size, at: t, dur: 240, back: overlaps({ x: RR.x, y, w: 150, h }, landing) });
        y += h;
        t += GAP_HEAD;
        continue;
      }
      let ln = inkOfNodes(cue.nodes, size, placed.length + 1);
      if (ln.w > R.w) ln = inkOfNodes(cue.nodes, size * (R.w / ln.w), placed.length + 1);
      const note = cue.note ? wrapNote(cue.note, R.w, noteSize) : undefined;
      const noteH = note ? note.length * (noteSize + 2.5) + 2 : 0;
      const h = ln.asc + ln.desc + noteH + (cue.src ? 11 : 0) + 9;
      if (y + h > R.y + R.h) {
        ri++;
        if (ri >= regions.length) break;
        y = regions[ri].y;
      }
      const RR = regions[ri];
      const dur = inkDuration(ln, size * pen);
      const box: Rect = { x: RR.x, y: y, w: ln.w, h };
      const k = placed.length;
      placed.push({
        cue,
        line: ln,
        tilt: (hash2(k, 3, 61) - 0.5) * 1.1,
        ink: 0.9 + hash2(k, 5, 17) * 0.1,
        x: RR.x + hash2(k, 7, 29) * size * 0.5,
        y: y + noteH + ln.asc,
        size,
        at: t,
        dur,
        note,
        back: overlaps(box, landing),
      });
      y += h;
      t += dur + (cue.failed ? GAP_FAIL : GAP_LINE);
    }
    return { VW, VH, placed, noteSize };
  }, [vp.w, vp.h, isMobile, opts?.pen, opts?.font]);

  // ---- 1 行ずつ出す（rAF も setInterval も使わない。行ごとに setTimeout 1 回）
  useEffect(() => {
    if (!opts) return;
    if (opts.off || opts.all) {
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
  }, [plan, opts]);

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

  // 書き進むほど板が薄くなる（式が風景になる）
  const prog = plan.placed.length ? shown / plan.placed.length : 0;
  const ground = 0.975 - 0.105 * Math.min(1, prog * 1.2) - (phase === "loading" ? 0 : 0.03);

  return (
    <div className={`bb${out ? " bb-out" : ""}${opts.still ? " bb-still" : ""}`} aria-hidden>
      <svg viewBox={`0 0 ${plan.VW} ${plan.VH}`} preserveAspectRatio="xMidYMid slice">
        <ChalkDefs />
        <g style={{ opacity: ground }}>
          <rect className="bb-ground" width={plan.VW} height={plan.VH} />
          <rect width={plan.VW} height={plan.VH} fill="url(#bbBoard)" opacity="0.8" />
          {/* 前の授業の消し跡（放射グラデーション＝フィルタ無しで縁が柔らかい） */}
          <ellipse cx={plan.VW * 0.28} cy={plan.VH * 0.34} rx={plan.VW * 0.3} ry={plan.VH * 0.15} fill="url(#bbSmear)" />
          <ellipse cx={plan.VW * 0.74} cy={plan.VH * 0.7} rx={plan.VW * 0.24} ry={plan.VH * 0.12} fill="url(#bbSmear)" />
          <ellipse cx={plan.VW * 0.5} cy={plan.VH * 0.1} rx={plan.VW * 0.36} ry={plan.VH * 0.07} fill="url(#bbSmear)" opacity="0.7" />
        </g>

        {plan.placed.slice(0, shown).map((p, i) =>
          p.cue.k === "head" ? (
            <Head key={i} p={p} />
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
                >
                  {t}
                </text>
              ))}
              <ChalkLine
                line={p.line!}
                x={p.x}
                y={p.y}
                size={p.size}
                speed={p.size * opts.pen}
                still={opts.still || opts.all}
                failed={p.cue.failed}
                seed={i + 1}
              />
              {p.cue.src && (
                <text className="bb-src" x={p.x + 2} y={p.y + p.line!.desc + 11}>
                  {p.cue.src}
                </text>
              )}
            </g>
          ),
        )}
      </svg>
    </div>
  );
}

/** 章の見出し（和文はシステムフォント。線文字は作らない） */
function Head({ p }: { p: Placed }) {
  const cue = p.cue as Extract<Cue, { k: "head" }>;
  return (
    <g style={{ opacity: p.back ? 0.42 : 1 }}>
      <text className="bb-head" x={p.x} y={p.y}>
        {cue.text}
      </text>
      <text className="bb-src" x={p.x + 74} y={p.y}>
        {cue.latin}
      </text>
      <path
        className="bb-w"
        style={{ "--l": "120", "--l0": "124", "--t": "420ms", "--d": "0ms" } as CSSProperties}
        d={`M${p.x} ${p.y + 8}L${p.x + 40} ${p.y + 7.4}L${p.x + 62} ${p.y + 8.6}`}
        strokeWidth={2.7}
        stroke="url(#bbChalk)"
      />
    </g>
  );
}
