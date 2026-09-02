"use client";
// 入口。世界がうっすら透ける暗い地に、題字と 4 行の言葉と「入る」。
// 読み込み中は、いま本当に計算している数式が 1 行ずつタイプされる。
import { useEffect, useRef } from "react";
import MobileBreak from "./MobileBreak";
import { loadingLines } from "@/engine/ui/formulas";

export type LandingPhase = "loading" | "ready" | "in";

type Props = {
  phase: LandingPhase;
  progress: { step: string; p: number };
  heightmapRes: number;
  isMobile: boolean;
  onEnter: () => void;
  onAbout: () => void;
};

export default function Landing({ phase, progress, heightmapRes, isMobile, onEnter, onAbout }: Props) {
  // 「入る」は Enter / Space でも押せる（WorldView のキー処理）。自動フォーカスはしない（枠が出て騒がしい）
  const loading = phase === "loading";
  const pct = Math.round(Math.min(1, progress.p) * 100);

  return (
    <div className={`landing ${phase === "in" ? "hidden" : ""}`} aria-hidden={phase === "in"}>
      <div className="landing-head">
        <span>こす.くま ／ ふりっぷ</span>
        <span className="landing-latin">MATHSCAPE</span>
      </div>

      <div className="landing-body">
        <h1 className="landing-title">数式の絶景</h1>
        <p className="landing-lead">
          リアルな3Dには、大量の素材がいる。
          <MobileBreak />
          その常識を、ひっくり返しました。
          <br />
          この風景に、画像は1枚もありません。
          <br />
          3Dモデルも、音のファイルも0個です。
          <br />
          全部、<strong>数式</strong>です。
          <MobileBreak />
          裏返すと、確かめられます。
        </p>

        <div className="landing-actions">
          <button
            className={`enter ${loading ? "loading" : ""}`}
            onClick={onEnter}
            disabled={loading}
            aria-label={loading ? `計算中 ${pct}%` : "風景に入る"}
            aria-busy={loading}
          >
            {loading && <span className="enter-bar" style={{ width: `${pct}%` }} aria-hidden />}
            <span className="enter-label">{loading ? "計算中" : "入る"}</span>
            {loading && <span className="enter-pct">{pct}%</span>}
          </button>
          <button className="about-link" onClick={onAbout} type="button">
            この風景について
          </button>
        </div>

        <LoadingLog step={progress.step} heightmapRes={heightmapRes} done={!loading} />
      </div>

      <div className="landing-foot">
        <span className="landing-howto">
          {isMobile ? (
            <>左で歩く ／ 右で見回す ／ 画面のボタンで裏返す</>
          ) : (
            <>WASD 歩く ／ ドラッグで見回す ／ F 裏返す ／ P 写真</>
          )}
        </span>
        <span className="landing-credit">制作: こす.くま × Claude Fable 5.1</span>
      </div>
    </div>
  );
}

/**
 * 数式のタイプライター。React の state は使わず、rAF で <pre> の文字を直接書く。
 * 時間基準なので、ハイトマップの焼き込みで主スレッドが止まっても、戻った瞬間に追いつく。
 */
function LoadingLog({ step, heightmapRes, done }: { step: string; heightmapRes: number; done: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const linesRef = useRef<{ text: string; at: number }[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const raf = useRef(0);

  useEffect(() => {
    if (!step || seen.current.has(step)) return;
    seen.current.add(step);
    const now = performance.now();
    const prev = linesRef.current;
    const lastEnd = prev.length ? prev[prev.length - 1].at + prev[prev.length - 1].text.length * 22 : now;
    let at = Math.max(now, lastEnd);
    for (const text of loadingLines(step, heightmapRes)) {
      linesRef.current.push({ text, at });
      at += text.length * 22 + 250;
    }
  }, [step, heightmapRes]);

  useEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cps = reduced ? Infinity : 45; // 1 秒あたりの文字数
    const tick = () => {
      const pre = preRef.current;
      if (!pre) return;
      const now = performance.now();
      const out: string[] = [];
      let typing = false;
      for (const l of linesRef.current) {
        const n = cps === Infinity ? l.text.length : Math.max(0, Math.floor(((now - l.at) / 1000) * cps));
        if (n <= 0) break;
        if (n < l.text.length) {
          out.push(l.text.slice(0, n) + "▍");
          typing = true;
          break;
        }
        out.push(l.text);
      }
      // 見せるのは最後の 3 行だけ（ログが流れていく感じ）
      pre.textContent = out.slice(-3).join("\n");
      if (!(done && !typing)) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [done]);

  return <pre className={`loading-log ${done ? "done" : ""}`} ref={preRef} aria-hidden />;
}
