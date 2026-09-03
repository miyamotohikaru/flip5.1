"use client";
// 実験室。右（携帯は下）に引き出しが開き、スライダーが並ぶ。
// **動かすと: 対応する式の項が光る → 数値が変わる → 風景と音が変わる。**
//
// 見せ方の約束（批評 R3 の指摘への答え）:
//   - **既定値ではハンドルが全部まん中**（位置は engine/lab/params.ts の posToValue / valueToPos）。
//     ×0.5 と ×2 が既定から同じ距離になる対数目盛りを使う
//   - **文字の壁にしない。** 式・現在値・出典を出すのは「いま触っている 1 本」だけ。ほかは名前と値だけ
//   - **変化を見せる。** 動かし始めた瞬間の画面を左半分に重ねて、前 / 後 を並べる
//
// 重くしないための約束:
//   - 閉じている間はこの部品ごと外れる（timer も listener も残らない）
//   - 開いている間の更新は 400ms に 1 回だけ。毎フレームは触らない
//   - 前後比べの絵は「変え始めた 1 フレーム」だけ写す（毎フレーム写さない）
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { World } from "@/engine/world";
import { LAB, LAB_DEFAULTS, type LabKey } from "@/engine/lab/store";
import {
  LAB_BY_ID, LAB_GROUPS, LAB_PARAMS, posToValue, splitFormula, valueToPos,
  type LabGroup, type LabParam,
} from "@/engine/lab/params";
import type { LabStatus } from "@/engine/lab/rebuild";
import SeedFinale from "./SeedFinale";

type Props = {
  world: World | null;
  open: boolean;
  onClose: () => void;
  sourceLines: number | null;
  isMobile: boolean;
};

/** 「いま効いている値」を作り直す間隔（ms）。毎フレームは触らない */
const LIVE_MS = 400;
/** 項が光っている時間 ＝ 前後比べを出しておく時間（ms） */
const HOT_MS = 2600;

export default function Lab({ world, open, onClose, sourceLines, isMobile }: Props) {
  const [vals, setVals] = useState<Record<string, number>>(() => ({ ...LAB }));
  const [hot, setHot] = useState<string | null>(null);
  const [status, setStatus] = useState<LabStatus>({ busy: false, step: "", p: 0 });
  const [tick, setTick] = useState(0);
  const [ab, setAb] = useState(false);
  const hotTimer = useRef<number>(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const abRef = useRef<HTMLCanvasElement>(null);
  /** 動かしている間は写さない（「前」の絵を保つ） */
  const holdSnap = useRef(false);
  const lastSnap = useRef(0);

  // 開いている間だけ動く（閉じたら何も残さない）
  useEffect(() => {
    if (!open || !world) return;
    world.lab.onStatus = (s) => setStatus(s);
    const id = window.setInterval(() => setTick((t) => t + 1), LIVE_MS);
    // 「動かす直前の画面」を持っておく。350ms に 1 枚だけ写し、動かしている間は更新を止める。
    // （描いた直後＝frame の中でないと WebGL の絵は取れない。preserveDrawingBuffer は使わない）
    const off = world.on("frame", () => {
      if (holdSnap.current) return;
      const now = performance.now();
      if (now - lastSnap.current < 350) return;
      lastSnap.current = now;
      const c = abRef.current;
      const src = world.canvas;
      if (!c) return;
      // CSS ピクセル等倍で写す（半分だと「前」だけぼけて、描画の不具合に見える）
      const w = Math.max(2, Math.min(1920, Math.round(src.clientWidth)));
      const h = Math.max(2, Math.min(1200, Math.round(src.clientHeight)));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const g = c.getContext("2d");
      if (!g) return;
      try {
        g.drawImage(src, 0, 0, w, h);
      } catch {
        /* 撮れなくても実験室は動く */
      }
    });
    // スライダーを触れるように、マウス固定は外す
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
    return () => {
      window.clearInterval(id);
      off();
      world.lab.onStatus = null;
      window.clearTimeout(hotTimer.current);
    };
  }, [open, world]);

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
    if (!open) setAb(false);
  }, [open]);

  const change = useCallback(
    (p: LabParam, v: number, dragging: boolean) => {
      // 持っている「直前の絵」を左半分に出す。動かしている間は写し直さない
      holdSnap.current = true;
      setAb(true);
      setVals((s) => ({ ...s, [p.id]: v }));
      setHot(p.id);
      window.clearTimeout(hotTimer.current);
      hotTimer.current = window.setTimeout(() => {
        setHot(null);
        setAb(false);
        holdSnap.current = false;
      }, HOT_MS);
      if (world) world.lab.set(p.id, v, dragging);
      else LAB[p.id] = v;
    },
    [world],
  );

  const reset = useCallback(() => {
    world?.lab.reset();
    setVals({ ...LAB_DEFAULTS });
    setHot(null);
    setAb(false);
    holdSnap.current = false;
  }, [world]);

  const dirty = useMemo(() => LAB_PARAMS.some((p) => vals[p.id] !== LAB_DEFAULTS[p.id]), [vals]);
  const lives = useMemo(() => {
    const m: Record<string, string | null> = {};
    for (const p of LAB_PARAMS) m[p.id] = p.live ? p.live(vals[p.id], world) : null;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, world, tick]);
  const groups = useMemo(() => {
    const m = new Map<LabGroup, LabParam[]>();
    for (const p of LAB_PARAMS) {
      const a = m.get(p.group);
      if (a) a.push(p);
      else m.set(p.group, [p]);
    }
    return m;
  }, []);
  // いちばん上の 1 本は最初から開いておく（何が起きるかを 1 本で見せる）
  const shown = hot ?? LAB_PARAMS[0].id;

  if (!open) return null;

  return (
    <>
      {/* 前後比べ: 動かし始めた瞬間の画面を左半分に重ねる */}
      <div className={`lab-ab ${ab ? "on" : ""}`} aria-hidden>
        <canvas ref={abRef} />
        <div className="lab-ab-line">
          <span className="l">前</span>
          <span className="r">後</span>
        </div>
      </div>

      <aside className="lab" aria-label="実験室">
        <div className="lab-head">
          <div>
            <h2>実験室</h2>
            <p>数式のここを動かすと、目の前がこう変わる。</p>
          </div>
          <div className="lab-head-btns">
            <button className={`btn ${dirty ? "" : "dim"}`} onClick={reset} disabled={!dirty} aria-label="つまみを全部もとに戻す">
              戻す
            </button>
            <button ref={closeRef} className="btn icon" onClick={onClose} aria-label="実験室を閉じる（L）">
              ×
            </button>
          </div>
        </div>

        <Focus p={LAB_BY_ID.get(shown as LabKey)!} v={vals[shown]} live={lives[shown]} hot={hot !== null} />

        {status.busy && (
          <div className="lab-bake" role="status">
            <span>{status.step}</span>
            <i style={{ transform: `scaleX(${Math.max(0.02, status.p)})` }} />
          </div>
        )}

        <div className="lab-body">
          {LAB_GROUPS.map((g) => (
            <section key={g.id} className="lab-group">
              <h3>{g.label}</h3>
              {(groups.get(g.id) ?? []).map((p) => (
                <Row key={p.id} p={p} v={vals[p.id]} hot={hot === p.id} onChange={change} />
              ))}
            </section>
          ))}

          <SeedFinale world={world} sourceLines={sourceLines} isMobile={isMobile} busy={status.busy} />
        </div>
      </aside>
    </>
  );
}

/** いま動かしているつまみの式。**位置は動かさない**（行が伸び縮みすると、指の下でつまみが逃げる） */
function Focus({ p, v, live, hot }: { p: LabParam; v: number; live: string | null; hot: boolean }) {
  const [pre, term, post] = useMemo(() => splitFormula(p.formula), [p.formula]);
  const shownVal = p.unit === "°" ? `${v > 0 ? "+" : ""}${v.toFixed(0)}°` : `×${v.toFixed(2)}`;
  return (
    <div className={`lab-focus ${hot ? "hot" : ""}`}>
      <div className="lab-focus-head">
        <span>{p.label}</span>
        <b>{shownVal}</b>
      </div>
      <div className="lab-formula" aria-hidden>
        {pre}
        <em>{term}</em>
        {post}
      </div>
      {live && <div className="lab-live">{live}</div>}
      <div className="lab-src" aria-hidden>
        {p.src}
      </div>
    </div>
  );
}

const Row = memo(function Row({
  p,
  v,
  hot,
  onChange,
}: {
  p: LabParam;
  v: number;
  hot: boolean;
  onChange: (p: LabParam, v: number, dragging: boolean) => void;
}) {
  const dragging = useRef(false);
  const latest = useRef(v);
  latest.current = v;
  // 指がつまみの外へ出て離されても「離した」を取りこぼさない
  const grab = useCallback(() => {
    if (dragging.current) return;
    dragging.current = true;
    const up = () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!dragging.current) return;
      dragging.current = false;
      onChange(p, latest.current, false); // 離した ＝ 本焼き
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [onChange, p]);
  const dflt = LAB_DEFAULTS[p.id];
  const shownVal = p.unit === "°" ? `${v > 0 ? "+" : ""}${v.toFixed(0)}°` : `×${v.toFixed(2)}`;
  const pos = valueToPos(p, v);

  return (
    <div className={`lab-row ${hot ? "hot" : ""} ${v !== dflt ? "moved" : ""}`}>
      <label className="lab-label" htmlFor={`lab-${p.id}`}>
        <span>{p.label}</span>
        <b>{shownVal}</b>
      </label>
      <input
        id={`lab-${p.id}`}
        type="range"
        min={0}
        max={1}
        step={0.002}
        value={pos}
        aria-valuetext={shownVal}
        onPointerDown={grab}
        onChange={(e) => onChange(p, posToValue(p, Number(e.target.value)), dragging.current)}
      />
    </div>
  );
});
