"use client";
// 実験室。右（携帯は下）に引き出しが開き、スライダーが並ぶ。
// **動かすと: 対応する式の項が光る → 数値が変わる → 風景と音が変わる。**
//
// 重くしないための約束:
//   - 閉じている間はこの部品ごと外れる（timer も listener も残らない）
//   - 開いている間の更新は 400ms に 1 回だけ（「いま効いている値」の文字列）。毎フレームは触らない
//   - 項のハイライトは class の付け外しだけ（DOM を作り直さない）
//   - 地形のつまみは、指を置いている間は 256² の粗焼き、離したら本焼き（engine/lab/rebuild.ts）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { World } from "@/engine/world";
import { LAB, LAB_DEFAULTS } from "@/engine/lab/store";
import { LAB_GROUPS, LAB_PARAMS, splitFormula, type LabGroup, type LabParam } from "@/engine/lab/params";
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
/** 項が光っている時間（ms） */
const HOT_MS = 1600;

export default function Lab({ world, open, onClose, sourceLines, isMobile }: Props) {
  const [vals, setVals] = useState<Record<string, number>>(() => ({ ...LAB }));
  const [hot, setHot] = useState<string | null>(null);
  const [status, setStatus] = useState<LabStatus>({ busy: false, step: "", p: 0 });
  const [tick, setTick] = useState(0);
  const hotTimer = useRef<number>(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いている間だけ動く（閉じたら何も残さない）
  useEffect(() => {
    if (!open || !world) return;
    world.lab.onStatus = (s) => setStatus(s);
    const id = window.setInterval(() => setTick((t) => t + 1), LIVE_MS);
    // スライダーを触れるように、マウス固定は外す
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
    return () => {
      window.clearInterval(id);
      world.lab.onStatus = null;
      window.clearTimeout(hotTimer.current);
    };
  }, [open, world]);

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  const change = useCallback(
    (p: LabParam, v: number, dragging: boolean) => {
      setVals((s) => ({ ...s, [p.id]: v }));
      setHot(p.id);
      window.clearTimeout(hotTimer.current);
      hotTimer.current = window.setTimeout(() => setHot(null), HOT_MS);
      if (world) world.lab.set(p.id, v, dragging);
      else LAB[p.id] = v;
    },
    [world],
  );

  const reset = useCallback(() => {
    world?.lab.reset();
    setVals({ ...LAB_DEFAULTS });
    setHot(null);
  }, [world]);

  const dirty = useMemo(() => LAB_PARAMS.some((p) => vals[p.id] !== LAB_DEFAULTS[p.id]), [vals]);
  const groups = useMemo(() => {
    const m = new Map<LabGroup, LabParam[]>();
    for (const p of LAB_PARAMS) {
      const a = m.get(p.group);
      if (a) a.push(p);
      else m.set(p.group, [p]);
    }
    return m;
  }, []);

  if (!open) return null;

  return (
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
              <Row key={p.id} p={p} v={vals[p.id]} hot={hot === p.id} world={world} tick={tick} onChange={change} />
            ))}
          </section>
        ))}

        <SeedFinale world={world} sourceLines={sourceLines} isMobile={isMobile} busy={status.busy} />
      </div>
    </aside>
  );
}

function Row({
  p,
  v,
  hot,
  world,
  tick,
  onChange,
}: {
  p: LabParam;
  v: number;
  hot: boolean;
  world: World | null;
  tick: number;
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
  // 式は 1 回だけ割る（描き直さない）
  const [pre, term, post] = useMemo(() => splitFormula(p.formula), [p.formula]);
  // 「いま効いている値」は 400ms ごと ＋ つまみが動いたときだけ作り直す
  const live = useMemo(() => (p.live ? p.live(v, world) : null), [p, v, world, tick]);
  const dflt = LAB_DEFAULTS[p.id];
  const shown = p.unit === "°" ? `${v > 0 ? "+" : ""}${v.toFixed(0)}°` : `×${v.toFixed(2)}`;

  return (
    <div className={`lab-row ${hot ? "hot" : ""} ${v !== dflt ? "moved" : ""}`}>
      <label className="lab-label" htmlFor={`lab-${p.id}`}>
        <span>{p.label}</span>
        <b>{shown}</b>
      </label>
      <input
        id={`lab-${p.id}`}
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={v}
        aria-valuetext={`${shown}${live ? ` ${live}` : ""}`}
        onPointerDown={grab}
        onChange={(e) => onChange(p, Number(e.target.value), dragging.current)}
      />
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

