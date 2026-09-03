"use client";
// 「この風景について」。専門知識ゼロの人が読んで分かる言葉で、
// 何をひっくり返したか／中に何が入っているか／ふりっぷするとは／どう作ったか、を書く。
import { useEffect, useRef } from "react";
import MobileBreak from "./MobileBreak";
import SeedFinale from "./SeedFinale";
import type { World } from "@/engine/world";

type Props = {
  open: boolean;
  onClose: () => void;
  /** src/ 以下の行数（ビルド時に数える。取れなければ null） */
  sourceLines: number | null;
  isMobile: boolean;
  /** 締め（シード）で使う。まだ無ければボタンは押せない */
  world: World | null;
};

export const FLIPLIST_URL = "https://fliplist.kosukuma.com/";

export default function About({ open, onClose, sourceLines, isMobile, world }: Props) {
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
          「リアルな3Dの風景には、
          <MobileBreak />
          大量の素材がいる」という常識です。
          <br />
          素材とは、写真をもとにした質感の画像、
          <br />
          人が手で作った3Dモデル、
          <MobileBreak />
          録音した音のことです。
          <br />
          大作ゲームの景色は、
          <MobileBreak />
          それを何百人ものプロが、
          <br />
          何年もかけて積み上げたものです。
        </p>

        <p className="about-label">この風景に入っているもの</p>
        <p>
          画像 <b>0</b> 枚。3Dモデル <b>0</b> 個。音源 <b>0</b> 個。
          <br />
          入っているのは、
          <MobileBreak />
          <strong>数式（プログラム）だけ</strong>です。
        </p>
        <ul className="about-what">
          <li>
            山や谷の形は、
            <MobileBreak />
            座標を入れると高さが返る 1 本の関数。
          </li>
          <li>
            湖の波は、風の強さから物理の式で計算。
            <br />
            映り込みも、岸の泡も。
          </li>
          <li>
            空の色も夕焼けも、太陽の光が
            <br />
            空気の中で散らばる
            <MobileBreak />
            仕組みそのものの計算。
          </li>
          <li>
            雲は、空に浮かぶ密度の塊。
            <br />
            光を通しながら描いています。
          </li>
          <li>
            草は 1 本ずつ風で揺れ、
            <br />
            木は幹から枝が生える規則で生えます。
          </li>
          <li>
            雨・風・鳥・虫・雷の音も、
            <br />
            録音ではなくその場で合成しています。
          </li>
        </ul>
        <p>
          これを、ブラウザが
          <MobileBreak />
          毎秒 60 回計算して描いています。
          <br />
          スマホでも動きます。
        </p>

        <p className="about-label">「ふりっぷする」とは</p>
        <p>
          {isMobile ? "画面の「ふりっぷする」ボタンを押すと、" : "「ふりっぷする」ボタン（パソコンは F キー）を押すと、"}
          <br />
          足元から波が広がって、
          <MobileBreak />
          風景が数式の姿に変わります。
          <br />
          山は等高線に、湖は波の式に、
          <MobileBreak />
          空は光の散らばりの線に。
          <br />
          素材を使っていないことを、
          <MobileBreak />
          自分の目で確かめられます。
        </p>

        <p className="about-label">どうやって作ったか</p>
        <p>
          こす.くまが企画し、
          <MobileBreak />
          AI（Claude Fable 5.1）が
          <MobileBreak />
          作りました。
          <br />
          空・地形・水・植生・天気・
          <MobileBreak />
          音・光・操作・画面を、
          <br />
          それぞれ担当の AI が
          <MobileBreak />
          並行して書いています。
          <br />
          別の「辛口審査」の AI が、
          <MobileBreak />
          大作ゲームの画面と並べて、
          <br />
          見分けがつくかを何度も採点し、
          <MobileBreak />
          直させています。
        </p>
        <p className="about-more">
          <a href="/log" target="_blank" rel="noopener noreferrer">
            その採点の記録（検証ログ）を見る →
          </a>
        </p>

        <p className="about-label">先にやった人たち</p>
        <p>
          「数式だけで風景を描く」には、
          <MobileBreak />
          20 年以上の歴史があります。
          <br />
          <b>Elevated</b>（2009年・Rgba &amp; TBC）は、
          <MobileBreak />
          4,096 バイトの実行ファイルの中で、
          <br />
          山も湖も霧も音楽も
          <MobileBreak />
          その場で計算して描きました。
          <br />
          <b>Shadertoy</b>（2013年〜）には、
          <MobileBreak />
          素材ゼロの風景が何千と並んでいます。
          <br />
          <b>.kkrieger</b>（2004年）は、
          <MobileBreak />
          96 キロバイトに収めた FPS でした。
          <br />
          この作品は、その系譜の上にあります。
        </p>
        <p>そのうえで、ここが違います。</p>
        <ul className="about-what">
          <li>
            <b>歩ける。</b>
            先行作の多くは「見るもの」でした。
            <br />
            ここは、自分の足で入っていけます。
          </li>
          <li>
            <b>ふりっぷできる。</b>
            素材ゼロは普通、
            <MobileBreak />
            ソースを読める人しか確かめられません。
            <br />
            ここでは、ボタン 1 つで誰でも確かめられます。
          </li>
          <li>
            <b>音も合成。</b>
            雷は、落ちた場所までの距離のぶん
            <MobileBreak />
            遅れて鳴ります。
            <br />
            風景と音が、同じ数式でつながっています。
          </li>
          <li>
            <b>作り方そのものが作品。</b>
            9 分野を別々の AI が並行して作り、
            <br />
            別の審査 AI が大作ゲームと見比べて、
            <MobileBreak />
            採点し直させています。
            <br />
            その記録は <a href="/log" target="_blank" rel="noopener noreferrer">/log</a> にあります。
          </li>
        </ul>

        <p className="about-label">たとえるなら</p>
        <p>
          絵の具も写真も使わず、自然のルール
          <br />
          （光の進み方、波の立ち方、
          <MobileBreak />
          枝の分かれ方）を式で書いて、
          <br />
          その場で描かせています。
        </p>

        <p className="about-label">操作</p>
        {isMobile ? (
          <ul>
            <li>左で歩く ／ 右で見回す</li>
            <li>
              右上のボタンで
              <MobileBreak />
              ふりっぷする・写真・音・天気・時刻
            </li>
            <li>
              「いじる」で数式のつまみ
              <MobileBreak />
              （動かすと目の前が変わります）
            </li>
          </ul>
        ) : (
          <ul className="about-keys">
            <li>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> 歩く ／ <kbd>Shift</kbd> 走る ／ ドラッグで見回す
            </li>
            <li>
              <kbd>F</kbd> ふりっぷ ／ <kbd>P</kbd> 写真 ／ <kbd>M</kbd> 音 ／ <kbd>T</kbd> 時間を進める
            </li>
            <li>
              <kbd>L</kbd> 数式をいじる ／ <kbd>H</kbd> 表示を全部消す ／ <kbd>Esc</kbd> マウス固定をやめる
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
          この中に、画像も、3Dモデルも、音源も、
          <br />
          1つも入っていません。
        </p>

        <SeedFinale world={world} sourceLines={sourceLines} isMobile={isMobile} inAbout />

        <p className="about-foot">
          <a href={FLIPLIST_URL} target="_blank" rel="noopener noreferrer">
            ふりっぷ一覧へ →
          </a>
        </p>
      </div>
    </div>
  );
}
