"use client";
// 写真。world.takePhoto() の Blob を受け取り、シャッターの白、右下のサムネイル、保存。
// キャプション「数式の絶景 ／ 画像 0 枚」を Canvas で右下に小さく焼き込む（これも画像ファイルではなくコード）。
// iOS Safari は <a download> が効かないことがあるので、サムネイルをタップ → 共有シート／新しいタブ。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { World } from "@/engine/world";

export type PhotoHandle = { take: () => Promise<void> };

type Shot = { url: string; blob: Blob; name: string };

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function stamp(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

/** 右下にキャプションを焼く。失敗したら元の Blob をそのまま返す */
async function burnCaption(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return blob;
    g.drawImage(img, 0, 0);
    const fs = Math.max(13, Math.round(c.width / 105));
    g.font = `${fs}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    g.textAlign = "right";
    g.textBaseline = "alphabetic";
    const text = "数式の絶景 ／ 画像 0 枚";
    const x = c.width - fs * 1.5, y = c.height - fs * 1.4;
    g.fillStyle = "rgba(0, 0, 0, 0.45)";
    g.fillText(text, x + 1, y + 1);
    g.fillStyle = "rgba(242, 239, 232, 0.88)";
    g.fillText(text, x, y);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? blob), "image/png"));
  } catch {
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const PhotoMode = forwardRef<PhotoHandle, { world: World | null }>(function PhotoMode({ world }, ref) {
  const [flash, setFlash] = useState(0);
  const [shot, setShot] = useState<Shot | null>(null);
  const [visible, setVisible] = useState(false);
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  const ios = useRef(false);
  useEffect(() => {
    ios.current = isIOS();
  }, []);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const take = useCallback(async () => {
    if (!world || !world.ready || busy.current) return;
    busy.current = true;
    try {
      const raw = await world.takePhoto();
      if (!raw) return;
      setFlash((n) => n + 1);
      const blob = await burnCaption(raw);
      const name = `mathscape-${stamp()}.png`;
      const url = URL.createObjectURL(blob);
      setShot((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, blob, name };
      });
      setVisible(true);
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [window.setTimeout(() => setVisible(false), ios.current ? 6000 : 3000)];
      if (!ios.current) {
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.rel = "noopener";
        a.click();
      }
    } finally {
      busy.current = false;
    }
  }, [world]);

  useImperativeHandle(ref, () => ({ take }), [take]);

  const onTapThumb = async () => {
    if (!shot) return;
    const file = new File([shot.blob], shot.name, { type: "image/png" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: "数式の絶景" });
        return;
      } catch {
        /* キャンセルは無視 */
      }
    }
    window.open(shot.url, "_blank", "noopener");
  };

  return (
    <>
      <div key={flash} className={`shutter ${flash ? "go" : ""}`} aria-hidden />
      {shot && (
        <div className={`photo ${visible ? "show" : ""}`} aria-hidden={!visible}>
          {ios.current ? (
            <button className="photo-thumb" onClick={onTapThumb} aria-label="写真を保存する">
              <img src={shot.url} alt="" />
            </button>
          ) : (
            <a className="photo-thumb" href={shot.url} download={shot.name} aria-label="写真をもう一度保存する">
              <img src={shot.url} alt="" />
            </a>
          )}
          <div className="photo-label">{ios.current ? "タップで保存" : "保存しました"}</div>
        </div>
      )}
    </>
  );
});

export default PhotoMode;
