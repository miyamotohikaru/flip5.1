// 写真モードの書き出し: RGBA8 の RT を読み戻して PNG（Blob）にする。
import * as THREE from "three";

/** 写真の解像度を決める（2 倍、幅・高さ 4096 まで、画素数の上限あり） */
export function photoSize(width: number, height: number, mobile: boolean): { w: number; h: number; scale: number } {
  const maxPx = mobile ? 5e6 : 12e6;
  let scale = Math.min(2, 4096 / width, 4096 / height, Math.sqrt(maxPx / (width * height)));
  scale = Math.max(1, scale);
  return { w: Math.floor(width * scale), h: Math.floor(height * scale), scale };
}

/** RT の中身を PNG にする。行を上下反転する（GL は下から並ぶ） */
export async function renderTargetToPng(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget): Promise<Blob | null> {
  const w = rt.width, h = rt.height;
  const buf = new Uint8Array(w * h * 4);
  try {
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h, buf);
  } catch {
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  }
  const hasOffscreen = typeof OffscreenCanvas !== "undefined";
  const canvas: OffscreenCanvas | HTMLCanvasElement = hasOffscreen ? new OffscreenCanvas(w, h) : document.createElement("canvas");
  if (!hasOffscreen) {
    (canvas as HTMLCanvasElement).width = w;
    (canvas as HTMLCanvasElement).height = h;
  }
  const ctx = (canvas as HTMLCanvasElement).getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * row;
    img.data.set(buf.subarray(src, src + row), y * row);
  }
  ctx.putImageData(img, 0, 0);
  if ("convertToBlob" in canvas) return (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
  return new Promise((resolve) => (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), "image/png"));
}
