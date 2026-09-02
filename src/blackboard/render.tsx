"use client";
// 駒（layout.ts）→ SVG のチョーク。
//
// 軽くするための約束（docs/ARCHITECTURE.md「訪れる人の端末を重くしない」）:
//   ・feTurbulence は **小さなタイル**（<pattern>）で1回だけ焼く。画面全体には掛けない
//   ・書き取りは CSS アニメーション（stroke-dashoffset）。JS で毎フレーム属性を書き換えない
//   ・書き終わった行は **数本の <path> に畳む**（太さの階級ごと。畳んでも見た目は変わらない）
//   ・will-change は書いている間だけ（.bb-line が畳まれると外れる）
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import type { Node } from "@/data/formulas";
import { build, numText, type Item } from "./layout";
import { advanceOf, coreOf, handLine, handStrokes } from "./strokefont";

/** 線の太さの階級（畳むときに階級ごとにまとめる）。3 段あれば筆圧のばらつきは見える */
const W_STEP = [0.86, 1.0, 1.15];
const W_THIN = 0.079;
const W_CORE = 0.126;
/** 1 本ずつの間（ms）。人はストロークの継ぎ目でわずかに止まる */
const STROKE_GAP = 14;

export type Ink = {
  d: string;
  /** 筆圧の芯（中ほどだけ。始点と終点が細くなる） */
  core: string | null;
  len: number;
  wi: number;
  term?: string;
};
export type LiveSlot = { id: string; x: number; y: number; w: number; s: number; d: number };
export type InkLine = { ink: Ink[]; live: LiveSlot[]; len: number; w: number; asc: number; desc: number };

const wiOf = (w: number) => Math.min(2, Math.max(0, Math.round((w - 0.9) / 0.115 + 1)));
const keyAt = (x: number, y: number, seed: number) =>
  (Math.round(x * 2) * 73856093) ^ (Math.round(y * 2) * 19349663) ^ (seed * 83492791);

/** 駒 → 線。seed が同じなら毎回同じ線（決定的） */
export function inkOf(items: Item[], seed: number): { ink: Ink[]; live: LiveSlot[] } {
  const ink: Ink[] = [];
  const live: LiveSlot[] = [];
  for (const it of items) {
    const p = it.p;
    if (p.k === "live") {
      live.push({ id: it.live ?? "", x: p.x, y: p.y, w: p.w, s: p.s, d: p.d });
      continue;
    }
    const key = keyAt(p.x, p.y, seed);
    const strokes = p.k === "g" ? handStrokes(p.ch, p.x, p.y, p.s, key) : [handLine(p.x, p.y, p.x + p.w, p.y, key, 0.6)];
    for (const s of strokes) {
      const c = coreOf(s);
      ink.push({ d: s.d, core: c ? c.d : null, len: s.len, wi: wiOf(s.w), term: it.term });
    }
  }
  return { ink, live };
}

/** 木 → 1 行分の線 */
export function inkOfNodes(nodes: Node[], size: number, seed: number): InkLine {
  const box = build(nodes, size);
  const { ink, live } = inkOf(box.items, seed);
  let len = 0;
  for (const i of ink) len += i.len;
  return { ink, live, len, w: box.w, asc: box.asc, desc: box.desc };
}

/** 書き終わるまでの時間（ms） */
export function inkDuration(line: InkLine, speed: number): number {
  return (line.len / speed) * 1000 + line.ink.length * STROKE_GAP;
}

// ---------------------------------------------------------------------------
// チョークの地。タイルを1回だけ焼いて敷き詰める（画面全体のフィルタは掛けない）
export function ChalkDefs({ grain = true, idp = "bb" }: { grain?: boolean; idp?: string }) {
  return (
    <defs>
      {grain && (
        <>
          <filter id={`${idp}GrainF`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves={3} seed={7} stitchTiles="stitch" />
            <feColorMatrix type="matrix" values="0 0 0 0 0.075  0 0 0 0 0.105  0 0 0 0 0.088  1.35 0 0 0 -0.42" />
          </filter>
          <filter id={`${idp}BoardF`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.03 0.05" numOctaves={4} seed={19} stitchTiles="stitch" />
            <feColorMatrix type="matrix" values="0 0 0 0 0.58  0 0 0 0 0.72  0 0 0 0 0.62  0.22 0 0 0 -0.085" />
          </filter>
        </>
      )}
      <pattern id={`${idp}Chalk`} width="132" height="132" patternUnits="userSpaceOnUse">
        <rect width="132" height="132" fill="#e9f2ea" />
        {grain && <rect width="132" height="132" filter={`url(#${idp}GrainF)`} />}
      </pattern>
      <pattern id={`${idp}ChalkDim`} width="132" height="132" patternUnits="userSpaceOnUse">
        <rect width="132" height="132" fill="#93a99a" />
        {grain && <rect width="132" height="132" filter={`url(#${idp}GrainF)`} opacity="0.75" />}
      </pattern>
      <pattern id={`${idp}ChalkHot`} width="132" height="132" patternUnits="userSpaceOnUse">
        <rect width="132" height="132" fill="#ffc46b" />
        {grain && <rect width="132" height="132" filter={`url(#${idp}GrainF)`} opacity="0.7" />}
      </pattern>
      <pattern id={`${idp}Board`} width="480" height="480" patternUnits="userSpaceOnUse">
        {grain && <rect width="480" height="480" filter={`url(#${idp}BoardF)`} />}
      </pattern>
      {/* 黒板消しの跡。放射グラデーション＝フィルタ無しで縁が柔らかい */}
      <radialGradient id={`${idp}Smear`}>
        <stop offset="0%" stopColor="#e4f3e8" stopOpacity="0.17" />
        <stop offset="55%" stopColor="#cfe4d6" stopOpacity="0.085" />
        <stop offset="100%" stopColor="#cfe4d6" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// ---------------------------------------------------------------------------
// 1 行

type Run = { term?: string; ink: Ink[] };
function runsOf(ink: Ink[]): Run[] {
  const runs: Run[] = [];
  for (const s of ink) {
    const last = runs[runs.length - 1];
    if (last && last.term === s.term) last.ink.push(s);
    else runs.push({ term: s.term, ink: [s] });
  }
  return runs;
}

type LineProps = {
  line: InkLine;
  x: number;
  y: number;
  size: number;
  /** ペンの速さ（単位/秒） */
  speed?: number;
  /** 書き取りをしない（reduced-motion／もう書き終わっている行） */
  still?: boolean;
  /** 失敗した式（打ち消し線と消し跡がつく） */
  failed?: boolean;
  /** 光らせる項の id */
  hot?: string[];
  /** 弱く（消しかけ・古い行） */
  dim?: boolean;
  values?: Record<string, number>;
  seed?: number;
};

export const ChalkLine = memo(function ChalkLine({
  line,
  x,
  y,
  size,
  speed = size * 10,
  still,
  failed,
  hot,
  dim,
  values,
  seed = 0,
}: LineProps) {
  const total = useMemo(() => inkDuration(line, speed), [line, speed]);
  // 書き終わったら畳む（生きた <path> を DOM に残さない）
  const [flat, setFlat] = useState(!!still);
  useEffect(() => {
    if (still) {
      setFlat(true);
      return;
    }
    setFlat(false);
    const t = window.setTimeout(() => setFlat(true), total + 240);
    return () => window.clearTimeout(t);
  }, [still, total]);

  const paint = dim ? "url(#bbChalkDim)" : "url(#bbChalk)";
  const runs = useMemo(() => runsOf(line.ink), [line]);
  const hotSet = useMemo(() => new Set(hot ?? []), [hot]);

  let acc = 0;
  const groups = runs.map((r, ri) => {
    let inner: ReactElement[];
    if (flat) {
      const thin = ["", "", ""], core = ["", "", ""];
      let all = "";
      for (const s of r.ink) {
        thin[s.wi] += s.d;
        if (s.core) core[s.wi] += s.core;
        all += s.d;
      }
      inner = [
        <path key="dust" className="bb-dust" d={all} strokeWidth={size * W_THIN * 3.2} stroke={paint} />,
        ...thin.map((d, i) => (d ? <path key={`t${i}`} d={d} strokeWidth={size * W_THIN * W_STEP[i]} stroke={paint} /> : null)),
        ...core.map((d, i) => (d ? <path key={`c${i}`} d={d} strokeWidth={size * W_CORE * W_STEP[i]} stroke={paint} /> : null)),
      ].filter(Boolean) as ReactElement[];
    } else {
      inner = [];
      for (let i = 0; i < r.ink.length; i++) {
        const s = r.ink[i];
        const dur = (s.len / speed) * 1000;
        // --l0 は「まだ書いていない」位置。dasharray の切れ目に丸い頭が残らないよう少し余分に送る
        const st = {
          "--l": s.len.toFixed(1),
          "--l0": (s.len + 4).toFixed(1),
          "--t": `${dur.toFixed(0)}ms`,
          "--d": `${acc.toFixed(0)}ms`,
        } as CSSProperties;
        inner.push(
          <path key={`a${i}`} className="bb-w" style={st} d={s.d} strokeWidth={size * W_THIN * W_STEP[s.wi]} stroke={paint} />,
        );
        if (s.core)
          inner.push(
            <path
              key={`b${i}`}
              className="bb-w"
              style={{ ...st, "--l": (s.len * 0.7).toFixed(1), "--l0": (s.len * 0.7 + 4).toFixed(1) } as CSSProperties}
              d={s.core}
              strokeWidth={size * W_CORE * W_STEP[s.wi]}
              stroke={paint}
            />,
          );
        acc += dur + STROKE_GAP;
      }
    }
    return r.term ? (
      <g key={ri} data-term={r.term} className={hotSet.has(r.term) ? "hot" : undefined}>
        {inner}
      </g>
    ) : (
      <g key={ri}>{inner}</g>
    );
  });

  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} className={`bb-line${flat ? " bb-flat" : ""}`}>
      {groups}
      {line.live.map((s) => (
        <LiveNumber key={s.id} slot={s} v={values?.[s.id]} paint={paint} seed={seed} />
      ))}
      {failed && <Struck w={line.w} size={size} delay={still ? 0 : total} still={!!still} />}
    </g>
  );
});

/** 打ち消し線と黒板消しの跡。**消して終わりにしない**（試行錯誤の痕跡が主役） */
function Struck({ w, size, delay, still }: { w: number; size: number; delay: number; still: boolean }) {
  const [on, setOn] = useState(still);
  useEffect(() => {
    if (still) {
      setOn(true);
      return;
    }
    setOn(false);
    const t = window.setTimeout(() => setOn(true), delay + 150);
    return () => window.clearTimeout(t);
  }, [delay, still]);
  const s = useMemo(() => handLine(-size * 0.12, -size * 0.19, w + size * 0.1, -size * 0.27, 5501, 1.9), [w, size]);
  // 黒板消しが残す「拭いた筋」＝細いチョークの残りかす（幅の広い帯は板書に見えないので使わない）
  const wipes = useMemo(
    () =>
      [0, 1, 2, 3, 4].map((k) => {
        const y = -size * (0.62 - k * 0.26);
        const x0 = w * (0.03 + (k % 2) * 0.1);
        const x1 = w * (0.62 + k * 0.09);
        return handLine(x0, y, x1, y + size * (k % 2 ? 0.1 : -0.07), 7700 + k * 13, 2.4).d;
      }),
    [w, size],
  );
  if (!on) return null;
  return (
    <g className="bb-struck">
      {/* 黒板消しの跡: 広いむら ＋ 拭いた筋（フィルタは使わない） */}
      <ellipse
        cx={w * 0.5}
        cy={-size * 0.22}
        rx={w * 0.6}
        ry={size * 0.95}
        fill="url(#bbSmear)"
        transform={`rotate(-1.2 ${(w * 0.5).toFixed(1)} ${(-size * 0.22).toFixed(1)})`}
      />
      <ellipse cx={w * 0.27} cy={-size * 0.05} rx={w * 0.3} ry={size * 0.6} fill="url(#bbSmear)" opacity="0.9" />
      <ellipse cx={w * 0.78} cy={-size * 0.38} rx={w * 0.26} ry={size * 0.5} fill="url(#bbSmear)" opacity="0.75" />
      <ellipse cx={w * 0.55} cy={-size * 0.55} rx={w * 0.22} ry={size * 0.42} fill="url(#bbSmear)" opacity="0.6" />
      <ellipse cx={w * 0.1} cy={-size * 0.3} rx={w * 0.14} ry={size * 0.46} fill="url(#bbSmear)" opacity="0.7" />
      {wipes.map((d, i) => (
        <path key={i} className="bb-wipe" d={d} strokeWidth={size * (0.07 + (i % 3) * 0.02)} stroke="url(#bbChalk)" />
      ))}
      <path
        className="bb-w"
        style={{ "--l": s.len.toFixed(1), "--l0": (s.len + 4).toFixed(1), "--t": "460ms", "--d": "0ms" } as CSSProperties}
        d={s.d}
        strokeWidth={size * 0.1}
        stroke="url(#bbChalk)"
      />
    </g>
  );
}

/** 実行中の値。ここだけ描き直す（版はずれない＝枠の幅は固定） */
const LiveNumber = memo(function LiveNumber({
  slot,
  v,
  paint,
  seed,
}: {
  slot: LiveSlot;
  v: number | undefined;
  paint: string;
  seed: number;
}) {
  const text = v === undefined || !Number.isFinite(v) ? "—" : numText(v, slot.d);
  const paths = useMemo(() => {
    const adv = [...text].reduce((a, ch) => a + advanceOf(ch), 0) * slot.s;
    let x = slot.x + Math.max(0, slot.w - adv); // 右詰め
    const out: { d: string; core: string | null; wi: number }[] = [];
    for (const ch of text) {
      for (const s of handStrokes(ch, x, slot.y, slot.s, keyAt(x, slot.y, seed + 7))) {
        const c = coreOf(s);
        out.push({ d: s.d, core: c ? c.d : null, wi: wiOf(s.w) });
      }
      x += advanceOf(ch) * slot.s;
    }
    return out;
  }, [text, slot.x, slot.y, slot.w, slot.s, seed]);
  return (
    <g className="bb-live" data-live={slot.id}>
      {paths.map((p, i) => (
        <g key={i}>
          <path d={p.d} strokeWidth={slot.s * W_THIN * W_STEP[p.wi]} stroke={paint} />
          {p.core && <path d={p.core} strokeWidth={slot.s * W_CORE * W_STEP[p.wi]} stroke={paint} />}
        </g>
      ))}
    </g>
  );
});

// ---------------------------------------------------------------------------
/**
 * 式を1つ描く（実験室・隅の表示から使う公開部品）。
 *   <FormulaSvg nodes={f.now ?? f.body} size={18} hot={["mtn"]} values={{ mtn: 312.4 }} />
 */
export function FormulaSvg({
  nodes,
  size = 18,
  seed = 3,
  hot,
  values,
  dim,
  still = true,
  grain = true,
  className,
  pad = 5,
}: {
  nodes: Node[];
  size?: number;
  seed?: number;
  hot?: string[];
  values?: Record<string, number>;
  dim?: boolean;
  still?: boolean;
  grain?: boolean;
  className?: string;
  pad?: number;
}) {
  const line = useMemo(() => inkOfNodes(nodes, size, seed), [nodes, size, seed]);
  const w = Math.ceil(line.w + pad * 2);
  const h = Math.ceil(line.asc + line.desc + pad * 2);
  return (
    <svg className={className} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <ChalkDefs grain={grain} />
      <ChalkLine
        line={line}
        x={pad}
        y={pad + line.asc}
        size={size}
        still={still}
        hot={hot}
        values={values}
        dim={dim}
        seed={seed}
      />
    </svg>
  );
}

/** 外から項を光らせる（React の再描画を起こさない経路） */
export function setTermHot(root: Element | null, id: string, on: boolean) {
  if (!root) return;
  root.querySelectorAll(`[data-term="${CSS.escape(id)}"]`).forEach((el) => el.classList.toggle("hot", on));
}
