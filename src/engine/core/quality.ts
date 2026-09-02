// 端末の力に合わせた品質段階。ここで決めた値を各モジュールが参照する。
import type { QualityTier } from "./env";

export type QualitySettings = {
  tier: QualityTier;
  /** 描画解像度の倍率（1 = 端末のピクセル比そのまま、上限あり） */
  renderScale: number;
  maxPixelRatio: number;
  msaaSamples: number;
  heightmapRes: number;
  shadowMapSize: number;
  shadowCascades: number;
  shadowMaxFar: number;
  /** 草の本数（上限） */
  grassCount: number;
  grassRadius: number;
  /** 木の見える距離（m） */
  treeDistance: number;
  /** 雲のレイマーチ解像度倍率 */
  cloudScale: number;
  cloudSteps: number;
  /** 湖面の映り込み解像度倍率 */
  reflectionScale: number;
  postFx: { bloom: boolean; godrays: boolean; ao: boolean; dof: boolean; smaa: boolean };
};

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    tier: "low", renderScale: 0.75, maxPixelRatio: 1.5, msaaSamples: 0, heightmapRes: 1024,
    shadowMapSize: 1024, shadowCascades: 2, shadowMaxFar: 120, grassCount: 12000, grassRadius: 35,
    treeDistance: 900, cloudScale: 0.25, cloudSteps: 24, reflectionScale: 0.25,
    postFx: { bloom: true, godrays: false, ao: false, dof: false, smaa: false },
  },
  mid: {
    tier: "mid", renderScale: 0.85, maxPixelRatio: 2, msaaSamples: 2, heightmapRes: 1024,
    shadowMapSize: 2048, shadowCascades: 3, shadowMaxFar: 220, grassCount: 40000, grassRadius: 55,
    treeDistance: 1500, cloudScale: 0.35, cloudSteps: 40, reflectionScale: 0.4,
    postFx: { bloom: true, godrays: true, ao: false, dof: false, smaa: true },
  },
  high: {
    tier: "high", renderScale: 1, maxPixelRatio: 2, msaaSamples: 4, heightmapRes: 2048,
    shadowMapSize: 2048, shadowCascades: 3, shadowMaxFar: 380, grassCount: 150000, grassRadius: 90,
    treeDistance: 2600, cloudScale: 0.5, cloudSteps: 64, reflectionScale: 0.5,
    postFx: { bloom: true, godrays: true, ao: true, dof: true, smaa: true },
  },
  ultra: {
    tier: "ultra", renderScale: 1, maxPixelRatio: 2, msaaSamples: 4, heightmapRes: 2048,
    shadowMapSize: 4096, shadowCascades: 4, shadowMaxFar: 600, grassCount: 300000, grassRadius: 120,
    treeDistance: 3500, cloudScale: 0.75, cloudSteps: 96, reflectionScale: 0.75,
    postFx: { bloom: true, godrays: true, ao: true, dof: true, smaa: true },
  },
};

export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (touch && /Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** 端末から初期段階を推定。実測（フレーム時間）での上下は controls/performance 側で行う。 */
export function detectTier(gl?: WebGL2RenderingContext | null): QualityTier {
  if (typeof window === "undefined") return "high";
  const mobile = isMobileDevice();
  let renderer = "";
  try {
    const canvas = document.createElement("canvas");
    const ctx = gl ?? (canvas.getContext("webgl2") as WebGL2RenderingContext | null);
    const ext = ctx?.getExtension("WEBGL_debug_renderer_info");
    if (ctx && ext) renderer = String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* 取れなければ端末種別だけで決める */
  }
  if (mobile) {
    // 近年の iPhone / iPad は mid、それ以外は low
    if (/Apple/i.test(renderer) || /iPhone|iPad/.test(navigator.userAgent)) return "mid";
    return "low";
  }
  if (/SwiftShader|llvmpipe|Software/i.test(renderer)) return "low";
  if (/Intel/i.test(renderer) && !/Arc/i.test(renderer)) return "mid";
  return "high";
}
