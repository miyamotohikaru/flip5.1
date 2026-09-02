// 実行時に Canvas で描く植生のテクスチャ。画像ファイルは使わない。決定的（hash2 ベースの乱数）。
//   針葉のカード: 2×2 のアトラス。0 = 枝を上から見た扇（top）、1 = 横から見た垂れ（side）、
//   2 = 梢（spire）、3 = top の別種。縁は乱れ、内側（幹側）ほど暗い。
import * as THREE from "three";
import { hash2 } from "../core/noise";

export const NEEDLE_ATLAS_CELLS = 2; // 2×2

/** 決定的な乱数列（seed ごと） */
function rng(seed: number) {
  let i = 0;
  return () => hash2(i++, seed * 7919, 17);
}

type Ctx = CanvasRenderingContext2D;

/** 針葉の小枝を 1 本描く。(x0,y0) から角度 ang、長さ len。needles = 針の密度 */
function drawTwig(ctx: Ctx, r: () => number, x0: number, y0: number, ang: number, len: number, needleLen: number, dark: number, hue: number) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  // 芯
  ctx.strokeStyle = `rgba(${55 + dark * 20}, ${40 + dark * 15}, ${25}, 1)`;
  ctx.lineWidth = Math.max(1.2, len * 0.045);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + dx * len, y0 + dy * len);
  ctx.stroke();
  // 針: 芯の両側に、先端ほど短く、少し前へ倒れる
  const n = Math.floor(len / 1.4);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    if (r() < 0.3) continue; // 隙間（向こうが透ける）
    const px = x0 + dx * len * t, py = y0 + dy * len * t;
    for (const s of [-1, 1]) {
      const a = ang + s * (0.95 + 0.35 * (r() - 0.5)) - 0.25 * t;
      const l = needleLen * (0.55 + 0.7 * r()) * (1.0 - 0.4 * t);
      const shade = dark * (0.5 + 0.5 * t) * (0.8 + 0.4 * r());
      const g = Math.round(48 + 58 * shade);
      const rr = Math.round(30 + 46 * shade * (0.6 + 0.8 * hue));
      const b = Math.round(26 + 30 * shade * (1.4 - hue));
      ctx.strokeStyle = `rgb(${rr}, ${g}, ${b})`;
      ctx.lineWidth = 0.8 + 0.6 * r();
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
      ctx.stroke();
    }
  }
}

/** 枝（扇）: 左端（幹側）から右へ伸びる主軸と、斜めに出る小枝 */
function drawSpray(ctx: Ctx, seed: number, size: number, kind: "top" | "side" | "spire") {
  const r = rng(seed);
  const cx0 = size * 0.02, cy0 = size * 0.5;
  const len = size * 0.94;
  if (kind === "spire") {
    // 梢: 下から上へ。細く、小枝は短い
    const bx = size * 0.5, by = size * 0.98;
    ctx.strokeStyle = "rgb(60, 45, 28)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx, size * 0.04);
    ctx.stroke();
    const n = 14;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const y = by - (by - size * 0.06) * t;
      const l = size * (0.32 - 0.26 * t) * (0.8 + 0.4 * r());
      const dark = 0.55 + 0.45 * t;
      drawTwig(ctx, r, bx, y, -Math.PI / 2 - 1.15 - 0.3 * r(), l, size * 0.045, dark, 0.5);
      drawTwig(ctx, r, bx, y, -Math.PI / 2 + 1.15 + 0.3 * r(), l, size * 0.045, dark, 0.5);
    }
    return;
  }
  // 主軸
  ctx.strokeStyle = "rgb(58, 42, 26)";
  ctx.lineWidth = size * 0.02;
  ctx.beginPath();
  ctx.moveTo(cx0, cy0);
  ctx.lineTo(cx0 + len, cy0 + (kind === "side" ? size * 0.05 : 0));
  ctx.stroke();
  const n = kind === "top" ? 14 : 11;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.3) / n;
    const x = cx0 + len * t;
    const y = cy0 + (kind === "side" ? size * 0.05 * t : 0);
    const dark = 0.35 + 0.65 * t; // 幹側ほど暗い
    if (kind === "top") {
      const l = size * (0.4 - 0.26 * t) * (0.85 + 0.3 * r());
      const spread = 0.7 + 0.3 * r();
      drawTwig(ctx, r, x, y, -spread - 0.2 * (1 - t), l, size * 0.045, dark, 0.5 + 0.3 * (r() - 0.5));
      drawTwig(ctx, r, x, y, spread + 0.2 * (1 - t), l, size * 0.045, dark, 0.5 + 0.3 * (r() - 0.5));
      if (i % 3 === 0) drawTwig(ctx, r, x, y, (r() - 0.5) * 0.5, l * 0.4, size * 0.04, dark, 0.5);
    } else {
      // 垂れ下がる小枝（横から見た枝: 下へ長く、上へ短く。先端ほど短い）
      const l = size * (0.4 - 0.24 * t) * (0.75 + 0.5 * r());
      drawTwig(ctx, r, x, y, 1.2 + 0.25 * r(), l, size * 0.042, dark, 0.5);
      drawTwig(ctx, r, x, y, 1.75 + 0.25 * r(), l * 0.85, size * 0.042, dark, 0.5);
      drawTwig(ctx, r, x, y, 0.45 + 0.3 * r(), l * 0.6, size * 0.04, dark, 0.5);
      drawTwig(ctx, r, x, y, -0.6 - 0.3 * r(), l * 0.35, size * 0.035, dark, 0.5);
    }
  }
  // 先端の小枝
  const tipAng = kind === "side" ? 0.35 : 0;
  drawTwig(ctx, r, cx0 + len * 0.93, cy0, tipAng, size * 0.09, size * 0.045, 1.0, 0.6);
}

/** 針葉カードのアトラス（RGBA・sRGB）。返る texture の colorSpace は sRGB。 */
export function makeNeedleAtlas(cell = 256): THREE.CanvasTexture {
  const size = cell * NEEDLE_ATLAS_CELLS;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = "round";
  const kinds: ("top" | "side" | "spire")[] = ["top", "side", "spire", "top"];
  for (let i = 0; i < 4; i++) {
    const cx = (i % NEEDLE_ATLAS_CELLS) * cell, cy = Math.floor(i / NEEDLE_ATLAS_CELLS) * cell;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.rect(0, 0, cell, cell);
    ctx.clip();
    drawSpray(ctx, 11 + i * 3, cell, kinds[i]);
    ctx.restore();
  }
  // ミップで縁が痩せないように、不透明画素の色を透明側へ 1px にじませる（アルファはそのまま）
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const out = new Uint8ClampedArray(d);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const k = (y * size + x) * 4;
      if (d[k + 3] > 8) continue;
      let rr = 0, gg = 0, bb = 0, n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const j = ((y + oy) * size + (x + ox)) * 4;
          if (d[j + 3] > 8) {
            rr += d[j];
            gg += d[j + 1];
            bb += d[j + 2];
            n++;
          }
        }
      }
      if (n > 0) {
        out[k] = rr / n;
        out[k + 1] = gg / n;
        out[k + 2] = bb / n;
      }
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
