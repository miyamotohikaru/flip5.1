"use client";
// 裏返しの数式パネル（この作品の芯）。
// 裏返し中、照準の先にあるもの（地形／湖／空）の数式を、その場所の値つきで示す。
// 数式の波がその場所を通過した瞬間に、ふわっと現れる。
import { useEffect, useRef, useState } from "react";
import type { World } from "@/engine/world";
import { probe } from "@/engine/ui/probe";
import { panelFor, type FormulaPanel } from "@/engine/ui/formulas";

type Props = {
  world: World | null;
  /** 入場後で、HUD が隠されていない */
  active: boolean;
  /** 携帯の版面（短い式にする） */
  compact: boolean;
};

export default function FormulaOverlay({ world, active, compact }: Props) {
  const [panel, setPanel] = useState<FormulaPanel | null>(null);
  const [show, setShow] = useState(false);
  // 携帯では背景（風景）を隠しすぎないよう、たたんで見出しだけにできる
  const [collapsed, setCollapsed] = useState(false);
  const lastKey = useRef("");
  const showRef = useRef(false);

  useEffect(() => {
    if (!world || !active) {
      setShow(false);
      showRef.current = false;
      return;
    }
    let last = 0;
    const off = world.on("frame", () => {
      const now = performance.now();
      if (now - last < 120) return; // 毎フレームは走らせない（約 8 回/秒）
      last = now;
      const env = world.env;
      if (env.flipRadius <= 0 || env.flip <= 0.5) {
        if (showRef.current) {
          showRef.current = false;
          setShow(false);
        }
        return;
      }
      const hit = probe(env);
      const visible = hit.flipped;
      if (visible) {
        const next = panelFor(hit, compact);
        const key = next.here + "\n" + next.lines.join("\n");
        if (key !== lastKey.current) {
          lastKey.current = key;
          setPanel(next);
        }
      }
      if (visible !== showRef.current) {
        showRef.current = visible;
        setShow(visible);
      }
    });
    return () => {
      off();
    };
  }, [world, active, compact]);

  if (!panel) return null;
  const foldable = compact; // 携帯だけ、たためる
  return (
    <div
      className={`formula ${show ? "show" : ""} ${panel.kind} ${foldable ? "foldable" : ""} ${foldable && collapsed ? "collapsed" : ""}`}
      aria-hidden={!show}
      aria-live="polite"
      onClick={foldable ? () => setCollapsed((v) => !v) : undefined}
      role={foldable ? "button" : undefined}
      tabIndex={foldable ? 0 : undefined}
      aria-label={foldable ? (collapsed ? "数式をひらく" : "数式をたたむ") : undefined}
      onKeyDown={
        foldable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setCollapsed((v) => !v);
              }
            }
          : undefined
      }
    >
      <div className="formula-head">
        <span className="formula-title">{panel.title}</span>
        <span className="formula-latin">{panel.latin}</span>
        <span className="formula-src">{panel.source}</span>
        {foldable && <span className="formula-fold" aria-hidden>{collapsed ? "＋" : "－"}</span>}
      </div>
      <div className="formula-here">{panel.here}</div>
      {/* 1 行ずつの div。狭い画面で万一はみ出しても折り返さず「…」で切る（携帯で右に流れていた。批評R1-9） */}
      <div className="formula-body">
        {panel.lines.map((t, i) => (
          <div className="formula-line" key={i}>
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
