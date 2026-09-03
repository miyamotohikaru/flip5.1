"use client";
// 入口。世界がうっすら透ける暗い地に、題字と 4 行の言葉と「入る」。
// 読み込み中は、いま本当に計算している数式が 1 行ずつタイプされる。
import MobileBreak from "./MobileBreak";

export type LandingPhase = "loading" | "ready" | "in";

type Props = {
  phase: LandingPhase;
  progress: { step: string; p: number };
  heightmapRes: number;
  isMobile: boolean;
  onEnter: () => void;
  onAbout: () => void;
  /** 黒板をぜんぶ見る（入口の黒板を前面に出して読む） */
  onBoard?: () => void;
};

export default function Landing({ phase, progress, heightmapRes, isMobile, onEnter, onAbout, onBoard }: Props) {
  // 「入る」は Enter / Space でも押せる（WorldView のキー処理）。自動フォーカスはしない（枠が出て騒がしい）
  const loading = phase === "loading";
  const pct = Math.round(Math.min(1, progress.p) * 100);

  return (
    <div className={`landing ${phase === "in" ? "hidden" : ""}`} aria-hidden={phase === "in"}>
      {/* 作者の指示（2026-09-03）で「こす.くま ／ ふりっぷ」の肩書きは外した。そこまで主張しない */}
      <div className="landing-head">
        <span />
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
          ふりっぷすると、確かめられます。
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
          {onBoard && (
            <button className="about-link bb-link" onClick={onBoard} type="button">
              黒板を読む
            </button>
          )}
          <button className="about-link" onClick={onAbout} type="button">
            この風景について
          </button>
        </div>
      </div>

      <div className="landing-foot">
        <span className="landing-howto">
          {isMobile ? (
            <>左で歩く ／ 右で見回す ／ 画面のボタンでふりっぷ</>
          ) : (
            <>WASD 歩く ／ ドラッグで見回す ／ F ふりっぷ ／ P 写真</>
          )}
        </span>
        {/* 作者の指示（2026-09-03）で制作クレジットは外した。「この風景について」の中には残してある */}
      </div>
    </div>
  );
}
