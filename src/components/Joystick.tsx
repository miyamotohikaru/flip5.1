"use client";
// 携帯の仮想スティックの円。操作担当が Controls に公開する stick 状態を読んで描くだけ。
// 触れている間だけ出す（触れていないのに左上に円が浮いていた。批評R1-9）。
// React の state は使わず、rAF で DOM を直接動かす。
import { useEffect, useRef } from "react";
import type { World } from "@/engine/world";
import { extras } from "@/engine/ui/controlsApi";

/** 指を離してから消えるまで（ms）。CSS の transition と合わせる */
const FADE_MS = 200;

export default function Joystick({ world, active }: { world: World | null; active: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current, base = baseRef.current, knob = knobRef.current;
    if (!world || !active || !root || !base || !knob) return;
    let raf = 0;
    let shown = false;
    let hideAt = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const stick = extras(world.controls).stick;
      // 触れている間だけ。中心は「触れた所」（cx, cy）
      const want = !!stick && stick.active;
      const now = performance.now();
      if (want && !shown) {
        shown = true;
        hideAt = 0;
        root.style.display = "block";
        root.style.opacity = "1";
      } else if (!want && shown) {
        if (!hideAt) {
          hideAt = now + FADE_MS;
          root.style.opacity = "0";
        } else if (now >= hideAt) {
          shown = false;
          hideAt = 0;
          root.style.display = "none";
        }
      }
      if (!stick || !shown) return;
      const r = stick.radius || 56;
      const cx = stick.cx ?? stick.x, cy = stick.cy ?? stick.y;
      root.style.transform = `translate(${cx}px, ${cy}px)`;
      base.style.width = base.style.height = `${r * 2}px`;
      base.style.margin = `${-r}px`;
      // つまみは controls が半径で丸めた後の位置（x, y）。中心からの差だけ動かす
      knob.style.transform = `translate(${stick.x - cx}px, ${stick.y - cy}px)`;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      root.style.display = "none";
    };
  }, [world, active]);

  return (
    <div className="stick" ref={rootRef} style={{ display: "none" }} aria-hidden>
      <div className="stick-base" ref={baseRef} />
      <div className="stick-knob" ref={knobRef} />
    </div>
  );
}
