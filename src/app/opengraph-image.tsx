// OG 画像（1200×630）。画像ファイルは置かず、ビルド時にコードで描く。
// 暗い地に「数式の絶景」「画像 0 枚 ／ 3Dモデル 0 個 ／ 音源 0 個」。
// 和文の字形だけは Google Fonts（Noto Sans JP、必要な文字だけの部分集合）をビルド時に取りに行く。
// 取れなければ欧文だけの版面に落とす（ビルドは止めない）。
import { ImageResponse } from "next/og";

export const alt = "数式の絶景 ／ 画像 0 枚 ／ 3Dモデル 0 個 ／ 音源 0 個";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#f2efe8";
const DIM = "rgba(242, 239, 232, 0.62)";
const ACCENT = "#ffb847";
const FORMULA = "rgba(140, 217, 255, 0.55)";

const TEXT_JP = "数式の絶景画像枚Dモデル個音源全部数式です。裏返すと、確かめられます制作こす.くま×ふりっぷ／0123456789 MATHSCAPEClaudeFable";

async function loadJapaneseFont(text: string): Promise<ArrayBuffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@500&text=${encodeURIComponent(text)}`;
    const css = await (await fetch(cssUrl, { signal: ctrl.signal })).text();
    const m = css.match(/src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/);
    if (!m) return null;
    const res = await fetch(m[1], { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const Card = ({ jp }: { jp: boolean }) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "52px 64px 48px",
      background: "linear-gradient(180deg, #0c1530 0%, #0b1020 55%, #05070f 100%)",
      color: INK,
      fontFamily: jp ? "NotoSansJP" : "sans-serif",
    }}
  >
    {/* 等高線のつもりの細い線。数式ビュー（青黒い紙に白青の線）の記憶 */}
    <div style={{ position: "absolute", left: 0, right: 0, top: 452, height: 1, background: FORMULA, opacity: 0.35, display: "flex" }} />
    <div style={{ position: "absolute", left: 0, right: 0, top: 484, height: 1, background: FORMULA, opacity: 0.25, display: "flex" }} />
    <div style={{ position: "absolute", left: 0, right: 0, top: 528, height: 1, background: FORMULA, opacity: 0.16, display: "flex" }} />
    <div style={{ position: "absolute", left: 0, right: 0, top: 590, height: 1, background: FORMULA, opacity: 0.1, display: "flex" }} />

    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, letterSpacing: 4, color: DIM }}>
      <span>{jp ? "こす.くま ／ ふりっぷ" : "KOSU.KUMA / FLIP"}</span>
      <span style={{ letterSpacing: 8 }}>MATHSCAPE</span>
    </div>

    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: jp ? 120 : 108, fontWeight: 500, letterSpacing: jp ? 8 : 2, lineHeight: 1.1, display: "flex" }}>
        {jp ? "数式の絶景" : "MATHSCAPE"}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: 34, fontSize: 36, letterSpacing: 2, color: INK }}>
        {jp ? (
          <>
            <span>画像</span>
            <span style={{ color: ACCENT, margin: "0 10px", fontWeight: 500 }}>0</span>
            <span>枚</span>
            <span style={{ color: DIM, margin: "0 22px" }}>／</span>
            <span>3Dモデル</span>
            <span style={{ color: ACCENT, margin: "0 10px", fontWeight: 500 }}>0</span>
            <span>個</span>
            <span style={{ color: DIM, margin: "0 22px" }}>／</span>
            <span>音源</span>
            <span style={{ color: ACCENT, margin: "0 10px", fontWeight: 500 }}>0</span>
            <span>個</span>
          </>
        ) : (
          <>
            <span style={{ color: ACCENT, marginRight: 12 }}>0</span>
            <span>images</span>
            <span style={{ color: DIM, margin: "0 22px" }}>/</span>
            <span style={{ color: ACCENT, marginRight: 12 }}>0</span>
            <span>3D models</span>
            <span style={{ color: DIM, margin: "0 22px" }}>/</span>
            <span style={{ color: ACCENT, marginRight: 12 }}>0</span>
            <span>audio files</span>
          </>
        )}
      </div>
      <div style={{ marginTop: 22, fontSize: 26, letterSpacing: 2, color: DIM, display: "flex" }}>
        {jp ? "全部、数式です。裏返すと、確かめられます。" : "Everything is a formula. Flip it to check."}
      </div>
    </div>

    <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 20, letterSpacing: 2, color: DIM }}>
      {jp ? "制作: こす.くま × Claude Fable 5.1" : "kosu.kuma × Claude Fable 5.1"}
    </div>
  </div>
);

export default async function Image() {
  const font = await loadJapaneseFont(TEXT_JP);
  return new ImageResponse(<Card jp={!!font} />, {
    ...size,
    fonts: font ? [{ name: "NotoSansJP", data: font, style: "normal", weight: 500 }] : [],
  });
}
