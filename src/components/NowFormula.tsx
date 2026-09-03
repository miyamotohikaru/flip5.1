"use client";
// 世界の中の隅「いま計算していること」。
// 照準の先にあるもの（地形／湖／空）を作っている式を **1 本だけ**、実行中の数値つきで。
// 裏返し中は出さない（FormulaOverlay の役目とぶつかるため）。キー G で出し入れ。
//
// 軽さ: 値の取り直しは 180ms に 1 回。式の線は formula が変わったときだけ組み直す（React.memo）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { World } from "@/engine/world";
import { probe } from "@/engine/ui/probe";
import { formulaById } from "@/data/formulas";
import { FormulaSvg } from "@/blackboard/render";
import "@/blackboard/blackboard.css";

type Props = { world: World | null; active: boolean; compact: boolean };

const PICK = { terrain: "terrain.h", lake: "water.wave", sky: "sky.scatter" } as const;
/** 入場して何秒で薄くなるか */
const FADE_AFTER = 8000;

export default function NowFormula({ world, active, compact }: Props) {
  const [id, setId] = useState<string>("terrain.h");
  const [values, setValues] = useState<Record<string, number>>({});
  const [on, setOn] = useState(true);
  const [faint, setFaint] = useState(false);
  const [hidden, setHidden] = useState(false); // 裏返し中
  const idRef = useRef(id);
  idRef.current = id;

  // G で出し入れ。出したときは 8 秒でまた薄くなる
  const wake = useCallback(() => {
    setFaint(false);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyG" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      setOn((v) => {
        if (!v) wake();
        return !v;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wake]);

  useEffect(() => {
    if (!on || !active) return;
    setFaint(false);
    const t = window.setTimeout(() => setFaint(true), FADE_AFTER);
    return () => window.clearTimeout(t);
  }, [on, active, id]);

  // 値の取り直し（180ms に 1 回）
  useEffect(() => {
    if (!world || !active || !on) return;
    let last = 0;
    const off = world.on("frame", () => {
      const now = performance.now();
      if (now - last < 180) return;
      last = now;
      const env = world.env;
      const flipping = env.flip > 0.02 || env.flipRadius > 0;
      setHidden(flipping);
      if (flipping) return;
      const hit = probe(env);
      const nextId = PICK[hit.kind];
      if (nextId !== idRef.current) setId(nextId);
      const f = formulaById(nextId);
      const v: Record<string, number> = f?.live ? { ...f.live(world) } : {};
      if (hit.kind === "terrain") {
        v.x = hit.x;
        v.z = hit.z;
        v.h = hit.terms.sum;
        v.base = hit.terms.base;
        v.mtn = hit.terms.mtn;
        v.fine = hit.terms.fine;
        v.sd = hit.terms.sd;
      } else if (hit.kind === "lake") {
        const U = Math.max(hit.windSpeed, 0.3);
        v.U = U;
        v.hs = 0.0025 + 0.0042 * U * U;
        v.lp = 0.35 + 0.062 * U * U;
      } else {
        v.theta = hit.atmo.thetaDeg;
        v.pR = hit.atmo.phaseR;
        v.pM = hit.atmo.phaseM;
        v.T = hit.atmo.T[1];
      }
      setValues(v);
    });
    return () => {
      off();
    };
  }, [world, active, on]);

  const f = formulaById(id);
  const show = active && on && !hidden;
  // 入場前・?nohud=1 では DOM ごと出さない（世界の描画に一切のせない）
  if (!active || !f || !f.now) return null;
  return (
    <div className={`bbnow${show ? " show" : ""}${faint ? " faint" : ""}`} aria-hidden>
      <div className="bbnow-head">
        <span>いま計算していること — {f.title}</span>
      </div>
      <FormulaSvg nodes={f.now} size={compact ? 13 : 15} seed={11} values={values} grain={false} />
      <div className="bbnow-src">{f.src}</div>
    </div>
  );
}
