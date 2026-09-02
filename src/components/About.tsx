"use client";
// 「この風景について」。何をひっくり返したか／どう作ったか／操作／行数／ふりっぷ一覧へ。
import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  /** src/ 以下の行数（ビルド時に数える。取れなければ null） */
  sourceLines: number | null;
  isMobile: boolean;
};

export const FLIPLIST_URL = "https://fliplist.kosukuma.com/";

export default function About({ open, onClose, sourceLines, isMobile }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restore = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      (restore.current as HTMLElement | null)?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;
  const lines = sourceLines ? sourceLines.toLocaleString("ja-JP") : null;

  return (
    <div className="about-backdrop" onClick={onClose}>
      <div className="about" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2 id="about-title">この風景について</h2>
          <button ref={closeRef} className="btn icon about-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <p className="about-label">ひっくり返したもの</p>
        <p>
          「リアルな3Dには素材がいる」という常識。
        </p>

        <p className="about-label">どう作ったか</p>
        <ul>
          <li>地形も、水も、空も、木も、音も、数式で全部生成</li>
          <li>画像 0 枚 ／ 3Dモデル 0 個 ／ 音源 0 個</li>
          <li>制作: こす.くま × Claude Fable 5.1</li>
        </ul>

        <p className="about-label">操作</p>
        {isMobile ? (
          <ul>
            <li>左で歩く ／ 右で見回す</li>
            <li>右上のボタンで 裏返す・写真・音・天気・時刻</li>
          </ul>
        ) : (
          <ul className="about-keys">
            <li>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> 歩く ／ <kbd>Shift</kbd> 走る ／ マウス 見回す
            </li>
            <li>
              <kbd>F</kbd> 裏返す ／ <kbd>P</kbd> 写真 ／ <kbd>M</kbd> 音 ／ <kbd>T</kbd> 時間を進める
            </li>
            <li>
              <kbd>H</kbd> 表示を全部消す ／ <kbd>Esc</kbd> マウスを戻す
            </li>
          </ul>
        )}

        <p className="about-label">中身</p>
        <p>
          {lines ? (
            <>
              コード {lines} 行（src/ 以下）。
              <br />
            </>
          ) : null}
          この中に、画像も、3Dモデルも、音源も、1つも入っていません。
        </p>

        <p className="about-foot">
          <a href={FLIPLIST_URL} target="_blank" rel="noopener noreferrer">
            ふりっぷ一覧へ →
          </a>
        </p>
      </div>
    </div>
  );
}
