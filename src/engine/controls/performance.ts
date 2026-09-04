// 性能監視と動的解像度。
// GPU 時間は取れないので、rAF の間隔（＝実効フレーム時間）と CPU 側の frameMs を 1 秒の移動平均で見る。
//   目標（q.targetFrameMs: high/ultra 16.7ms、mid/low 33.3ms）を超え続けたら描画解像度の倍率
//   renderScale を 0.05 刻みで下げ（下限 0.5）、余裕があれば上げる（上限 1.0）。
//   上げてすぐ下がったら、次に上げてみるまでの間隔を倍にする（振動しない）。
//   下限でも 10 秒足りなければ「次回起動時の段階」を 1 つ下げて localStorage に保存する（7 日で期限切れ）
//   （段階 q は各モジュールが起動時にしか読まないので、今回は解像度で凌ぐ）。
//   GPU 名が取れず段階に確信がない端末は、起動直後 30 フレームの実測で「次回の段階」を決める。
import type { QualityTier } from "../core/env";
import { higherTier, lowerTier, saveTierForNextLaunch, type QualitySettings } from "../core/quality";

export type PerfHooks = {
  /** 描画解像度の倍率が変わった（renderer.setPixelRatio に掛け直して RT を作り直す） */
  setScale: (scale: number) => void;
  /** 次回起動時の段階を決めた（persist なら localStorage に保存済み） */
  onTier?: (next: QualityTier, reason: string) => void;
};

export type PerfOptions = {
  /** GPU 名が取れなかった等で段階に確信がない。起動直後の 30 フレームで決め直す */
  calibrate?: boolean;
  /** 段階を localStorage に保存してよいか（?q= 指定時は false） */
  persist?: boolean;
  minScale?: number;
  maxScale?: number;
  initialScale?: number;
};

export class PerformanceMonitor {
  /** 描画解像度の倍率（q.renderScale にさらに掛かる） */
  renderScale: number;
  /** 実効 fps（rAF の間隔、直近 1 秒の平均） */
  fps = 0;
  /** rAF の間隔（ms、直近 1 秒の平均） */
  intervalMs = 0;
  /** CPU 側のフレーム時間（ms、直近 1 秒の平均） */
  cpuMs = 0;
  readonly targetMs: number;
  /** 決めた「次回起動時の段階」（今回は変わらない） */
  tierNext: QualityTier | null = null;
  tierReason = "";
  /** 解像度を変えた回数 */
  changes = 0;
  /** false なら測るだけで解像度・段階を変えない（?freeze=1 / ?shot= の定点撮影） */
  active = true;
  readonly minScale: number;
  readonly maxScale: number;
  private persist: boolean;
  private calibrating: boolean;
  private lastNow = 0;
  private winStart = 0;
  private sumIv = 0;
  private sumCpu = 0;
  private n = 0;
  private measured = 0;
  private startedAt = 0;
  private warmupMs = 2000;
  private lastChange = -1e9;
  private lastUp = -1e9;
  private probeMs = 3000;
  private overSince = -1;

  constructor(
    private q: QualitySettings,
    private tier: QualityTier,
    private hooks: PerfHooks,
    opts: PerfOptions = {},
  ) {
    this.targetMs = q.targetFrameMs;
    this.minScale = opts.minScale ?? 0.5;
    this.maxScale = opts.maxScale ?? 1.0;
    this.renderScale = opts.initialScale ?? 1.0;
    this.persist = opts.persist ?? true;
    this.calibrating = !!opts.calibrate;
  }

  /** 毎フレーム呼ぶ。now = フレーム開始の performance.now()、cpuMs = CPU 側の所要時間 */
  frame(now: number, cpuMs: number) {
    if (this.startedAt === 0) {
      this.startedAt = now;
      this.winStart = now;
    }
    if (this.lastNow > 0) {
      const iv = now - this.lastNow;
      // タブ切替やシェーダのコンパイルによる大きなつっかえは平均に入れない
      if (iv > 0 && iv < this.targetMs * 4) {
        this.sumIv += iv;
        this.sumCpu += cpuMs;
        this.n++;
      }
    }
    this.lastNow = now;
    if (now - this.winStart >= 1000) this.evaluate(now);
  }

  /**
   * タブが戻った・コンテキストが戻った・解像度以外の理由で止まった後に呼ぶ（平均をやり直す）。
   * warmupMs の間は判断しない（コンテキスト復帰直後はシェーダの作り直しで重いので長めに）。
   */
  reset(now = performance.now(), warmupMs = 1000) {
    this.lastNow = 0;
    this.winStart = now;
    this.sumIv = this.sumCpu = 0;
    this.n = 0;
    this.startedAt = now;
    this.warmupMs = warmupMs;
    this.overSince = -1;
  }

  private evaluate(now: number) {
    const n = this.n;
    if (n >= 5) {
      this.intervalMs = this.sumIv / n;
      this.cpuMs = this.sumCpu / n;
      this.fps = 1000 / this.intervalMs;
      this.measured += n;
    }
    this.winStart = now;
    this.sumIv = this.sumCpu = 0;
    this.n = 0;
    if (n < 5) return;

    const t = this.targetMs, iv = this.intervalMs;
    if (this.active && this.calibrating && this.measured >= 30 && now - this.startedAt > 1500) {
      this.calibrating = false;
      if (iv < t * 0.62 && this.tier !== "ultra") {
        this.decideTier(higherTier(this.tier), `起動直後の実測 ${iv.toFixed(1)}ms が目標 ${t}ms より十分速い`);
      }
    }
    if (!this.active) return;
    if (now - this.startedAt < this.warmupMs) return;
    if (now - this.lastChange < 900) return; // 解像度を変えた直後は落ち着くまで見ない（1 秒に 1 段まで）

    const over = iv > t * 1.12;
    const under = iv < t * 1.04;
    if (over) {
      if (this.overSince < 0) this.overSince = now;
      if (this.renderScale > this.minScale + 1e-6) {
        const step = iv > t * 2 ? 0.15 : iv > t * 1.5 ? 0.1 : 0.05;
        this.setScale(this.renderScale - step, now);
        // 上げた直後に戻したなら、次に上げてみるまでの間隔を倍に
        if (now - this.lastUp < 4000) this.probeMs = Math.min(60000, this.probeMs * 2);
      } else if (now - this.overSince > 10000 && !this.tierNext && this.tier !== "low") {
        // 下限で 10 秒重いままなら次回の段階を下げる（一時的な負荷で誤って下げないよう長めに見る）
        this.decideTier(lowerTier(this.tier), `解像度 ${this.minScale} でも ${iv.toFixed(1)}ms（目標 ${t}ms）`);
      }
    } else {
      this.overSince = -1;
      if (under && this.renderScale < this.maxScale - 1e-6 && now - this.lastChange >= this.probeMs) {
        this.setScale(this.renderScale + 0.05, now);
        this.lastUp = now;
      }
      // 上げたまま 10 秒もてば、探りの間隔を元に戻す
      if (this.lastUp > 0 && now - this.lastUp > 10000) this.probeMs = 3000;
    }
  }

  private setScale(s: number, now: number) {
    s = Math.round(s * 20) / 20;
    s = Math.min(this.maxScale, Math.max(this.minScale, s));
    if (Math.abs(s - this.renderScale) < 1e-6) return;
    this.renderScale = s;
    this.lastChange = now;
    this.changes++;
    this.hooks.setScale(s);
  }

  private decideTier(next: QualityTier, reason: string) {
    if (next === this.tier) return;
    this.tierNext = next;
    this.tierReason = reason;
    if (this.persist) saveTierForNextLaunch(next, reason);
    this.hooks.onTier?.(next, reason);
  }
}
