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
  /** 影の落ちる距離（m）。core/lighting.ts が 25m を起点に等比でカスケードを割る */
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
  /** 1フレームの目標時間（ms）。動的解像度（controls/performance）がこれを守ろうとする */
  targetFrameMs: number;
};

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    tier: "low", renderScale: 0.75, maxPixelRatio: 1.5, msaaSamples: 0, heightmapRes: 1024,
    shadowMapSize: 1024, shadowCascades: 2, shadowMaxFar: 120, grassCount: 12000, grassRadius: 35,
    treeDistance: 900, cloudScale: 0.25, cloudSteps: 24, reflectionScale: 0.25,
    postFx: { bloom: true, godrays: false, ao: false, dof: false, smaa: false },
    targetFrameMs: 33.3,
  },
  mid: {
    tier: "mid", renderScale: 0.85, maxPixelRatio: 2, msaaSamples: 2, heightmapRes: 1024,
    shadowMapSize: 2048, shadowCascades: 3, shadowMaxFar: 220, grassCount: 40000, grassRadius: 55,
    treeDistance: 1500, cloudScale: 0.35, cloudSteps: 40, reflectionScale: 0.4,
    postFx: { bloom: true, godrays: true, ao: false, dof: false, smaa: true },
    targetFrameMs: 33.3,
  },
  high: {
    tier: "high", renderScale: 1, maxPixelRatio: 2, msaaSamples: 4, heightmapRes: 2048,
    shadowMapSize: 2048, shadowCascades: 3, shadowMaxFar: 600, grassCount: 150000, grassRadius: 90,
    treeDistance: 2600, cloudScale: 0.5, cloudSteps: 64, reflectionScale: 0.5,
    postFx: { bloom: true, godrays: true, ao: true, dof: true, smaa: true },
    targetFrameMs: 16.7,
  },
  ultra: {
    tier: "ultra", renderScale: 1, maxPixelRatio: 2, msaaSamples: 4, heightmapRes: 2048,
    shadowMapSize: 4096, shadowCascades: 4, shadowMaxFar: 900, grassCount: 300000, grassRadius: 120,
    treeDistance: 3500, cloudScale: 0.75, cloudSteps: 96, reflectionScale: 0.75,
    postFx: { bloom: true, godrays: true, ao: true, dof: true, smaa: true },
    targetFrameMs: 16.7,
  },
};

export const TIER_ORDER: QualityTier[] = ["low", "mid", "high", "ultra"];

/** 1つ下の段階（low はそのまま） */
export function lowerTier(t: QualityTier): QualityTier {
  return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(t) - 1)];
}
/** 1つ上の段階（ultra はそのまま） */
export function higherTier(t: QualityTier): QualityTier {
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(t) + 1)];
}

export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (touch && /Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// ---------------------------------------------------------------------------
// 「次回起動時の段階」の保存。段階（q）は各モジュールが起動時にしか読まないので、
// 実測で重いと分かっても今回は解像度で凌ぎ、次回のために段階を書き残す。
// ---------------------------------------------------------------------------

const TIER_KEY = "mathscape.tier";
/** 保存した段階の有効期間。環境が変わっても（外付け GPU、ブラウザ更新）そのうち測り直す */
const TIER_TTL_MS = 7 * 24 * 3600 * 1000;

export type SavedTier = { tier: QualityTier; reason: string; at: number; ua: string };

export function loadSavedTier(): SavedTier | null {
  try {
    const raw = localStorage.getItem(TIER_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SavedTier>;
    if (!s || !s.tier || !TIER_ORDER.includes(s.tier)) return null;
    if (typeof s.at !== "number" || Date.now() - s.at > TIER_TTL_MS) return null;
    // 端末（ブラウザ）が変わっていたら信用しない
    if (s.ua !== navigator.userAgent) return null;
    return { tier: s.tier, reason: s.reason ?? "", at: s.at, ua: s.ua };
  } catch {
    return null;
  }
}

export function saveTierForNextLaunch(tier: QualityTier, reason: string) {
  try {
    const s: SavedTier = { tier, reason, at: Date.now(), ua: navigator.userAgent };
    localStorage.setItem(TIER_KEY, JSON.stringify(s));
  } catch {
    /* プライベートモードなどで保存できなくても構わない */
  }
}

export function clearSavedTier() {
  try {
    localStorage.removeItem(TIER_KEY);
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// 端末判定
// ---------------------------------------------------------------------------

export type DeviceInfo = {
  tier: QualityTier;
  /** 判定の根拠（stats 表示・報告用） */
  reason: string;
  /** GPU 名（WEBGL_debug_renderer_info。取れなければ空） */
  gpu: string;
  /** GPU 名などから確信が持てず、起動直後の実測で決め直すべき */
  uncertain: boolean;
  /** localStorage に保存された「次回の段階」を使った */
  saved: boolean;
  mobile: boolean;
};

let cachedDevice: DeviceInfo | null = null;

function readGpuName(gl?: WebGL2RenderingContext | WebGLRenderingContext | null): string {
  try {
    let ctx: WebGL2RenderingContext | WebGLRenderingContext | null = gl ?? null;
    let scratch: WebGL2RenderingContext | null = null;
    if (!ctx) {
      const canvas = document.createElement("canvas");
      scratch = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
      ctx = scratch;
    }
    if (!ctx) return "";
    const ext = ctx.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "") : "";
    // 判定のためだけに作ったコンテキストは手放す（iOS はコンテキスト数の上限が小さい）
    if (scratch) scratch.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "";
  }
}

/** iPhone / iPad は GPU 名が "Apple GPU" 固定でモデルが分からないので、画面の物理サイズで世代を推定する */
function classifyApple(ua: string): { tier: QualityTier; reason: string; uncertain: boolean } {
  const w = Math.min(screen.width, screen.height);
  const h = Math.max(screen.width, screen.height);
  const dpr = window.devicePixelRatio || 1;
  const ipad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (ipad) {
    // iPad Pro / Air（M 系）は幅 820〜1032pt。無印・mini は 744〜810pt
    if (w >= 820) return { tier: "mid", reason: `iPad ${w}×${h}（M 系相当）`, uncertain: false };
    return { tier: "low", reason: `iPad ${w}×${h}（A 系）`, uncertain: false };
  }
  if (dpr >= 3) {
    // 393pt 以上 @3x = iPhone 14 Pro / 15 以降（A16 以降）
    if (w >= 393) return { tier: "mid", reason: `iPhone ${w}×${h}@3（15 以降相当）`, uncertain: false };
    // 390×844 @3x は iPhone 12/13/14（A14/A15）と 16e（A18）が同居する。仮に mid、実測で決め直す
    // （重ければ動的解像度で凌ぎ、次回から low。tools/shoot.mjs --mobile もこの画面）
    if (w === 390 && h === 844) return { tier: "mid", reason: `iPhone ${w}×${h}@3（12〜14 / 16e）`, uncertain: true };
    return { tier: "low", reason: `iPhone ${w}×${h}@3（古い／mini）`, uncertain: false };
  }
  return { tier: "low", reason: `iPhone ${w}×${h}@${dpr}（古い）`, uncertain: false };
}

function classifyAndroid(gpu: string): { tier: QualityTier; reason: string; uncertain: boolean } {
  const adreno = /Adreno[^0-9]*(\d{3})/i.exec(gpu);
  if (adreno) return { tier: Number(adreno[1]) >= 700 ? "mid" : "low", reason: `Adreno ${adreno[1]}`, uncertain: false };
  const mali = /Mali-G(\d+)/i.exec(gpu);
  if (mali) {
    // Mali-G710 / G715 / G720 / G725 …（3桁）が mid。G77 / G78 など2桁は low
    const n = Number(mali[1]);
    return { tier: n >= 700 ? "mid" : "low", reason: `Mali-G${mali[1]}`, uncertain: false };
  }
  if (/Immortalis/i.test(gpu)) return { tier: "mid", reason: "Immortalis", uncertain: false };
  if (/Xclipse/i.test(gpu)) return { tier: "mid", reason: "Xclipse (Exynos)", uncertain: false };
  if (/PowerVR|Tegra|Vivante|VideoCore/i.test(gpu)) return { tier: "low", reason: gpu, uncertain: false };
  return { tier: "low", reason: gpu ? `不明な GPU: ${gpu}` : "GPU 名が取れない", uncertain: !gpu };
}

function classifyDesktop(gpu: string): { tier: QualityTier; reason: string; uncertain: boolean } {
  if (!gpu) return { tier: "mid", reason: "GPU 名が取れない（実測で決める）", uncertain: true };
  if (/SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(gpu)) return { tier: "low", reason: "ソフトウェア描画", uncertain: false };
  // 内蔵 GPU は mid。Intel Arc は外付け相当
  if (/Intel/i.test(gpu) && !/Arc/i.test(gpu)) return { tier: "mid", reason: `内蔵 GPU: ${gpu}`, uncertain: false };
  if (/Radeon\(TM\) Graphics|Radeon Vega|Radeon (6[1-9]0|7[0-9]0|8[0-9]0)M|Radeon Graphics/i.test(gpu) && !/RX /i.test(gpu)) {
    return { tier: "mid", reason: `内蔵 GPU: ${gpu}`, uncertain: false };
  }
  if (/GeForce (MX|GT |GTX 9|GTX 10[2-5]0|GTX 16[35]0)/i.test(gpu)) return { tier: "mid", reason: `小さめの GPU: ${gpu}`, uncertain: false };
  return { tier: "high", reason: gpu, uncertain: false };
}

/**
 * 端末の詳しい判定。結果は覚えておく（判定用の WebGL コンテキストを何度も作らない）。
 * 優先順位: localStorage に保存された「次回の段階」 > GPU 名／機種 > 実測（uncertain のとき controls/performance が行う）。
 */
export function detectDevice(gl?: WebGL2RenderingContext | WebGLRenderingContext | null): DeviceInfo {
  if (cachedDevice) return cachedDevice;
  if (typeof window === "undefined") return { tier: "high", reason: "server", gpu: "", uncertain: false, saved: false, mobile: false };
  const mobile = isMobileDevice();
  const gpu = readGpuName(gl);
  const ua = navigator.userAgent;
  const saved = loadSavedTier();
  let info: DeviceInfo;
  if (saved) {
    info = { tier: saved.tier, reason: `前回の実測より（${saved.reason}）`, gpu, uncertain: false, saved: true, mobile };
  } else if (mobile) {
    const apple = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) || /Apple/i.test(gpu);
    const c = apple ? classifyApple(ua) : /Android/i.test(ua) ? classifyAndroid(gpu) : { tier: "low" as QualityTier, reason: "その他の携帯", uncertain: false };
    info = { ...c, gpu, saved: false, mobile };
  } else {
    info = { ...classifyDesktop(gpu), gpu, saved: false, mobile };
  }
  cachedDevice = info;
  return info;
}

/** 端末から初期段階を推定。実測（フレーム時間）での上下は controls/performance 側で行う。 */
export function detectTier(gl?: WebGL2RenderingContext | WebGLRenderingContext | null): QualityTier {
  return detectDevice(gl).tier;
}
