"use client";
// 携帯の仮想スティックの円。操作担当が Controls に公開する stick 状態を読んで描くだけ。
// 浮動式（触れた所が中心）なので、**指が触れている間だけ**出す。
// stick.active は一度も触られていなければ false（中心は 0,0 のまま）なので、
// active を見ずに描くと画面の左上に迷子の円が残る。離した後は FADE_MS かけて薄れて消える。
// React の state は使わず、rAF で DOM を直接動かす。
import { useEffect, useRef } from "react";
import type { World } from "@/engine/world";
import { extras } from "@/engine/ui/controlsApi";

/** 指を離してから消えるまで（ms）。globals.css の .stick-base / .stick-knob の transition と合わせる */
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
    let held = false;
    let releasedAt = -1e9;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const stick = extras(world.controls).stick;
      const now = performance.now();
      const on = !!stick && stick.active;
      if (held && !on) releasedAt = now;
      held = on;
      // 触れている間は出す。離したら透明にしてから（CSS の transition）消す
      const want = on || now - releasedAt < FADE_MS;
      if (want !== shown) {
        shown = want;
        root.style.display = want ? "block" : "none";
      }
      if (!want || !stick) return;
      const r = stick.radius || 56;
      root.style.transform = `translate(${stick.x}px, ${stick.y}px)`;
      base.style.width = base.style.height = `${r * 2}px`;
      base.style.margin = `${-r}px`;
      base.style.opacity = on ? "1" : "0";
      // dy は「上（前進）が正」なので、CSS の Y（下が正）に直すときは符号を反転する
      knob.style.transform = `translate(${stick.dx * r * 0.7}px, ${-stick.dy * r * 0.7}px)`;
      knob.style.opacity = on ? "0.9" : "0";
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
