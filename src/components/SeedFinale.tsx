"use client";
// 締め ――「ここまで全部、この数ひとつから」。
// 実験室のいちばん下と、「この風景について」の末尾に同じものを置く。
// 変えると、置換表 → ハイトマップ → 山の陰 → 木と草 → 波と雲 が順に焼き直され、まったく別の谷になる。
import { useCallback, useEffect, useRef, useState } from "react";
import type { World } from "@/engine/world";
import { DEFAULT_SEED, getSeed, mix32, normalizeSeed } from "@/engine/core/seed";
import type { LabStatus } from "@/engine/lab/rebuild";

type Props = {
  world: World | null;
  sourceLines: number | null;
  isMobile: boolean;
  /** 親（実験室）がすでに進み具合を出しているなら true。二重に出さない */
  busy?: boolean;
  /** 「この風景について」の中に置くとき */
  inAbout?: boolean;
};

/** サイコロ。Math.random は使わない ―― 時計の数を混ぜる（押すたび違い、手続きは決まっている） */
function rollSeed(prev: number): number {
  const t = Date.now();
  let v = mix32(t & 0x7fffffff, ((t / 1000) | 0) ^ prev) % 99999999;
  if (v < 1000) v += 1000;
  return normalizeSeed(v);
}

export default function SeedFinale({ world, sourceLines, isMobile, busy, inAbout }: Props) {
  const first = useRef(getSeed());
  const [seed, setSeed] = useState(() => getSeed());
  const [work, setWork] = useState<LabStatus | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const go = useCallback(
    async (n: number) => {
      const w = world;
      if (!w || !w.ready || work) return;
      const prev = w.lab.onStatus;
      w.lab.onStatus = (s) => {
        if (alive.current) setWork(s.busy ? s : null);
      };
      setSeed(n);
      try {
        await w.lab.reseed(n);
      } finally {
        w.lab.onStatus = prev;
        if (alive.current) setWork(null);
      }
    },
    [world, work],
  );

  const lines = sourceLines ? sourceLines.toLocaleString("ja-JP") : null;
  const busyNow = !!work || !!busy;
  const isFirst = seed === first.current;

  return (
    <section className={`seedfin ${inAbout ? "in-about" : ""}`}>
      <p className="seedfin-lead">
        ここまで全部、
        {isMobile || !inAbout ? <br /> : null}
        この数ひとつから。
      </p>
      <div className="seedfin-num" aria-label={`いまのシード ${seed}`}>
        {String(seed)}
      </div>
      <p className="seedfin-note">
        {seed === DEFAULT_SEED ? "作りながら選んだ、この谷の数" : "この数から生えた谷"}
        {" ・ "}
        <code>?seed={seed}</code>
      </p>

      {/* 「この風景について」では、すぐ上の「中身」が同じ数を出しているので重ねない */}
      {inAbout ? null : (
        <ul className="seedfin-counts">
          {lines ? (
            <li>
              数式 <b>{lines}</b> 行
            </li>
          ) : null}
          <li>
            画像 <b>0</b> 枚
          </li>
          <li>
            3Dモデル <b>0</b> 個
          </li>
          <li>
            音源 <b>0</b> 個
          </li>
        </ul>
      )}

      {work ? (
        <div className="seedfin-bake" role="status">
          <span>{work.step}</span>
          <i style={{ transform: `scaleX(${Math.max(0.02, work.p)})` }} />
        </div>
      ) : null}

      <div className="seedfin-btns">
        <button className="btn flip" onClick={() => void go(rollSeed(seed))} disabled={busyNow || !world?.ready}>
          変えてみる
        </button>
        <button className="btn" onClick={() => void go(first.current)} disabled={busyNow || isFirst || !world?.ready}>
          もとの谷へ
        </button>
      </div>
      <p className="seedfin-tail">
        変えると、湖も、山脈も、
        <br />
        森の場所も、雲の並びも、鳥の鳴き方も、
        <br />
        丸ごと別物になります。
        <br />
        「南岸から北の山脈を見る」ことと、
        <br />
        湖があることだけが、この世界の決まりごとです。
      </p>
    </section>
  );
}
