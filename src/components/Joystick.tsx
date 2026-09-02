"use client";
// 携帯の仮想スティックの円。操作担当が Controls に公開する stick 状態を読んで描くだけ。
// 状態が無ければ何も描かない。React の state は使わず、rAF で DOM を直接動かす。
import { useEffect, useRef } from "react";
import type { World } from "@/engine/world";
import { extras } from "@/engine/ui/controlsApi";

export default function Joystick({ world, active }: { world: World | null; active: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current, base = baseRef.current, knob = knobRef.current;
    if (!world || !active || !root || !base || !knob) return;
    let raf = 0;
    let shown = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const stick = extras(world.controls).stick;
      const want = !!stick;
      if (want !== shown) {
        shown = want;
        root.style.display = want ? "block" : "none";
      }
      if (!stick) return;
      const r = stick.radius || 56;
      const x = stick.x, y = stick.y;
      root.style.transform = `translate(${x}px, ${y}px)`;
      base.style.width = base.style.height = `${r * 2}px`;
      base.style.margin = `${-r}px`;
      base.style.opacity = stick.active ? "1" : "0.55";
      knob.style.transform = `translate(${stick.dx * r * 0.7}px, ${stick.dy * r * 0.7}px)`;
      knob.style.opacity = stick.active ? "0.9" : "0.4";
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [world, active]);

  return (
    <div className="stick" ref={rootRef} style={{ display: "none" }} aria-hidden>
      <div className="stick-base" ref={baseRef} />
      <div className="stick-knob" ref={knobRef} />
    </div>
  );
}
