// 数式の木（data/formulas.ts の Node）を、置く場所の決まった「駒」に変える。
// ここでは字を描かない（描くのは render.tsx）。分数・上付き・下付き・Σ・∫ の縦位置はここで決める。
//
// 座標: x 右・y 下（SVG と同じ）。y はベースライン。
import type { Node } from "@/data/formulas";
import { METRICS, advanceOf, boundsOf, widthOf } from "./strokefont";

export type Piece =
  /** 字 */
  | { k: "g"; ch: string; x: number; y: number; s: number }
  /** 横棒（分数の線・√ の上棒・打ち消し線） */
  | { k: "r"; x: number; y: number; w: number; s: number }
  /** 実行中の値の枠。中身は毎回描き直すが、枠の位置と幅は動かない（版がぶれない） */
  | { k: "live"; x: number; y: number; w: number; s: number; d: number };

export type Item = {
  p: Piece;
  /** 囲っている term の id（いちばん内側） */
  term?: string;
  /** 実行中の値の差し込み口 */
  live?: string;
};

export type Box = {
  w: number;
  /** ベースラインから上の高さ */
  asc: number;
  /** ベースラインから下の深さ（正の数） */
  desc: number;
  items: Item[];
};

/** 数式の「軸」（分数の線・= の高さ）。em の割合 */
const AXIS = 0.30;

function shift(items: Item[], dx: number, dy: number): Item[] {
  return items.map((it) => ({
    ...it,
    p: it.p.k === "g" ? { ...it.p, x: it.p.x + dx, y: it.p.y + dy } : { ...it.p, x: it.p.x + dx, y: it.p.y + dy },
  }));
}
function tagTerm(items: Item[], id: string): Item[] {
  return items.map((it) => (it.term ? it : { ...it, term: id }));
}

/** 文字列をそのまま置く。U+0302（^ の結合文字）は直前の字の上に載せる（k\u0302 = k ハット） */
function text(s: string, size: number, live?: string): Box {
  const items: Item[] = [];
  let x = 0;
  let asc = 0, desc = 0;
  let prevX = 0, prevAdv = 0, prevTop = 0.6;
  for (const ch of s) {
    if (ch === "\u0302") {
      const as = size * 0.6;
      const ab = boundsOf("^");
      const y = -(prevTop * size + 0.04 * size - ab.y0 * as);
      items.push({ p: { k: "g", ch: "^", x: prevX + (prevAdv * size - advanceOf("^") * as) / 2, y, s: as } });
      asc = Math.max(asc, -y + ab.y1 * as);
      continue;
    }
    const b = boundsOf(ch);
    if (ch !== " ") {
      items.push({ p: { k: "g", ch, x, y: 0, s: size }, live });
      asc = Math.max(asc, b.y1 * size);
      desc = Math.max(desc, -b.y0 * size);
    }
    prevX = x;
    prevAdv = advanceOf(ch);
    prevTop = Math.max(b.y1, 0.6);
    x += prevAdv * size;
  }
  return { w: x, asc, desc, items };
}

/** 演算子の前後の空き（em） */
function opGap(s: string): number {
  if (s === "·") return 0.05;
  if (s === "/") return 0.04;
  if (s === "^") return 0.02;
  return 0.2;
}

/** 数の文字列（負号は U+2212） */
export function numText(v: number, d = 2): string {
  if (!Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(d);
  return (v < 0 && Number(s) !== 0 ? "−" : "") + s;
}

/** live の枠の幅（桁が変わっても版がずれないよう、いつも同じ幅を取る） */
function liveSlot(d: number): string {
  return d > 0 ? "000." + "0".repeat(d) : "0000";
}

/** 木を組む。返り値の items は原点（ベースライン左端）基準 */
export function build(nodes: Node[], size: number): Box {
  let x = 0;
  let asc = 0, desc = 0;
  const items: Item[] = [];
  const add = (b: Box, dx = 0, dy = 0) => {
    items.push(...shift(b.items, x + dx, dy));
    asc = Math.max(asc, b.asc - dy);
    desc = Math.max(desc, b.desc + dy);
    x += b.w + dx;
  };

  for (const n of nodes) {
    switch (n.t) {
      case "sym":
        add(text(n.s, size));
        break;
      case "num":
        add(text(numText(n.v, n.d ?? (Number.isInteger(n.v) ? 0 : 2)), size));
        break;
      case "op": {
        const g = opGap(n.s) * size;
        x += g;
        add(text(n.s, size));
        x += g;
        break;
      }
      case "live": {
        const d = n.d ?? 2;
        const slot = widthOf(liveSlot(d)) * size;
        items.push({ p: { k: "live", x, y: 0, w: slot, s: size, d }, live: n.id });
        asc = Math.max(asc, size * 0.72);
        desc = Math.max(desc, size * 0.02);
        x += slot;
        break;
      }
      case "term": {
        const b = build(n.body, size);
        items.push(...shift(tagTerm(b.items, n.id), x, 0));
        asc = Math.max(asc, b.asc);
        desc = Math.max(desc, b.desc);
        x += b.w;
        break;
      }
      case "frac": {
        const fs = size * 0.9;
        const nb = build(n.num, fs);
        const db = build(n.den, fs);
        const pad = 0.12 * size;
        const w = Math.max(nb.w, db.w) + pad * 2;
        const barY = -AXIS * size;
        const numY = barY - 0.16 * size - nb.desc;
        const denY = barY + 0.26 * size + db.asc;
        items.push({ p: { k: "r", x: x + 0.02 * size, y: barY, w: w - 0.04 * size, s: size } });
        items.push(...shift(nb.items, x + (w - nb.w) / 2, numY));
        items.push(...shift(db.items, x + (w - db.w) / 2, denY));
        asc = Math.max(asc, -numY + nb.asc);
        desc = Math.max(desc, denY + db.desc);
        x += w;
        break;
      }
      case "sup": {
        const b = build(n.base, size);
        add(b);
        const ss = size * 0.66;
        const sb = build(n.sup, ss);
        const dy = -(0.52 * size + Math.max(0, b.asc - 0.72 * size) * 0.5);
        add(sb, 0.02 * size, dy);
        break;
      }
      case "sub": {
        const b = build(n.base, size);
        add(b);
        const ss = size * 0.66;
        const sb = build(n.sub, ss);
        add(sb, 0.02 * size, 0.2 * size);
        break;
      }
      case "fn": {
        if (n.name === "√") {
          const inner = build(n.args[0] ?? [], size);
          const h = inner.asc + inner.desc;
          const rs = size * Math.min(1.9, Math.max(1, (h / size) * 0.95));
          const g = boundsOf("√");
          const gy = inner.desc - 0.02 * size;
          items.push({ p: { k: "g", ch: "√", x, y: gy, s: rs } });
          const rw = advanceOf("√") * rs;
          const top = gy - g.y1 * rs;
          items.push({ p: { k: "r", x: x + rw * 0.86, y: top, w: inner.w + 0.16 * size, s: size } });
          items.push(...shift(inner.items, x + rw * 0.86 + 0.08 * size, 0));
          asc = Math.max(asc, -top);
          desc = Math.max(desc, inner.desc);
          x += rw * 0.86 + inner.w + 0.2 * size;
          break;
        }
        add(text(n.name, size));
        const parts: Box[] = n.args.map((a) => build(a, size));
        let inAsc = 0, inDesc = 0;
        for (const p of parts) {
          inAsc = Math.max(inAsc, p.asc);
          inDesc = Math.max(inDesc, p.desc);
        }
        // 括弧は中身の高さで伸ばす
        const need = Math.max(inAsc + inDesc, size * 0.9);
        const ps = size * Math.min(1.9, Math.max(1, need / (size * 1.0)));
        const py = (inDesc - inAsc) * 0.5 + 0.3 * size;
        const pw = advanceOf("(") * ps;
        items.push({ p: { k: "g", ch: "(", x: x, y: py, s: ps } });
        x += pw;
        for (let i = 0; i < parts.length; i++) {
          if (i) {
            add(text(",", size));
            x += widthOf(" ") * size;
          }
          add(parts[i]);
        }
        items.push({ p: { k: "g", ch: ")", x: x, y: py, s: ps } });
        x += pw;
        asc = Math.max(asc, -py + boundsOf("(").y1 * ps);
        desc = Math.max(desc, py - boundsOf("(").y0 * ps);
        break;
      }
      case "sum":
      case "int": {
        const big = n.t === "sum" ? size * 1.5 : size * 1.85;
        const ch = n.t === "sum" ? "Σ" : "∫";
        const gb = boundsOf(ch);
        const gy = (n.t === "sum" ? 0.16 : 0.24) * size; // 軸に合わせて少し下げる
        items.push({ p: { k: "g", ch, x, y: gy, s: big } });
        const bw = advanceOf(ch) * big;
        const ls = size * 0.6;
        const from = build(n.from, ls);
        const to = build(n.to, ls);
        const top = gy - gb.y1 * big;
        const bot = gy - gb.y0 * big;
        if (n.t === "sum") {
          items.push(...shift(to.items, x + (bw - to.w) / 2, top - 0.1 * size - to.desc));
          items.push(...shift(from.items, x + (bw - from.w) / 2, bot + 0.12 * size + from.asc));
          asc = Math.max(asc, -(top - 0.1 * size - to.desc) + to.asc);
          desc = Math.max(desc, bot + 0.12 * size + from.asc + from.desc);
          x += bw + 0.1 * size;
        } else {
          items.push(...shift(to.items, x + bw * 0.86, top + 0.16 * size));
          items.push(...shift(from.items, x + bw * 0.62, bot - 0.02 * size));
          asc = Math.max(asc, -top);
          desc = Math.max(desc, bot);
          x += bw + Math.max(to.w, from.w) * 0.7 + 0.06 * size;
        }
        const body = build(n.body, size);
        add(body);
        if (n.t === "int" && n.d) {
          x += 0.1 * size;
          add(text("d" + n.d, size));
        }
        break;
      }
      case "brk":
        break;
    }
  }
  return { w: x, asc, desc, items };
}

export type Line = Box & { failed?: boolean; note?: string };

/** brk で行に割る。行ごとに Box を返す */
export function buildLines(nodes: Node[], size: number): Box[] {
  const lines: Box[] = [];
  let cur: Node[] = [];
  for (const n of nodes) {
    if (n.t === "brk") {
      lines.push(build(cur, size));
      cur = [];
    } else cur.push(n);
  }
  lines.push(build(cur, size));
  return lines.filter((l, i) => l.items.length > 0 || i === 0);
}

/** 行の高さ（行送り） */
export const lineHeight = (size: number) => size * METRICS.line;
