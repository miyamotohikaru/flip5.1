// 音。WebAudio の合成だけで 風・雨・雷・波・足音・鳥・虫・環境音・UI音 を作る（音声ファイルは 1 つも使わない）。
// 契約:
//   - start() はユーザー操作（クリック／タップ）から呼ばれる。AudioContext はそこで resume
//   - update(dt) で env.weather（風速・雨）・時刻（鳥は昼、虫は夜）・controls（足音）に追従
//   - setMuted(bool)。muted でもフレームは止めない
//   - 裏返しの「波」（env.flipRadius が広がる間）には専用の音を鳴らす
//   - 隠れたタブでは止め、戻ったら再開。iOS Safari は touch で resume
// 中身は mixer.ts（層の束ね）と各層。ここは公開 API と寿命の管理だけ。
import type { Env } from "../core/env";
import { Mixer } from "./mixer";
import { renderOffline, type ProbeConfig, type ProbeResult } from "./probe";
import type { AudioEnv, Surface } from "./types";

export type { ProbeConfig, ProbeResult } from "./probe";

export class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  muted = false;
  started = false;
  mixer: Mixer | null = null;
  /** 起動に失敗した理由（あれば） */
  error: string | null = null;
  /** メインスレッドの負荷（ms）。update = 毎フレーム、tick = 20Hz の状況更新を含む回 */
  stats = { updateMs: 0, maxUpdateMs: 0, tickMs: 0, maxTickMs: 0, frames: 0 };
  private hidden = false;
  private unhook: (() => void) | null = null;

  constructor(public env: Env) {}

  start() {
    if (this.started) return;
    this.started = true;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.mixer = new Mixer(this.ctx, this.env as unknown as AudioEnv, { tier: this.env.tier, isMobile: this.env.isMobile });
      this.master = this.mixer.master;
      this.mixer.setMuted(this.muted);
      this.mixer.enter(true);
      void this.ctx.resume().catch(() => {});
      this.hook();
    } catch (e) {
      this.error = String(e);
      this.ctx = null;
      this.mixer = null;
    }
  }

  private hook() {
    const ctx = this.ctx;
    if (!ctx) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        this.hidden = true;
        this.mixer?.duck(true);
        setTimeout(() => {
          if (this.hidden) void ctx.suspend().catch(() => {});
        }, 150);
      } else {
        this.hidden = false;
        void ctx.resume().then(() => this.mixer?.duck(false)).catch(() => {});
      }
    };
    // iOS Safari: 操作のたびに止まっていたら起こす
    const onGesture = () => {
      if (!this.hidden && ctx.state !== "running") void ctx.resume().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("touchend", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture);
    this.unhook = () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("touchend", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.mixer?.setMuted(m);
  }

  /** 足音などのイベント。controls から呼ぶ */
  footstep(surface: Surface) {
    this.mixer?.footstep(surface);
  }
  shutter() {
    this.mixer?.shutter();
  }
  flipWave(on: boolean) {
    this.mixer?.flipWave(on);
  }

  update(dt: number) {
    const m = this.mixer;
    if (!m || this.hidden) return;
    const t0 = performance.now();
    const ticksBefore = m.ticks;
    m.update(dt);
    const ms = performance.now() - t0;
    const st = this.stats;
    st.frames++;
    st.updateMs += (ms - st.updateMs) * 0.02;
    if (ms > st.maxUpdateMs) st.maxUpdateMs = ms;
    if (m.ticks !== ticksBefore) {
      st.tickMs += (ms - st.tickMs) * 0.1;
      if (ms > st.maxTickMs) st.maxTickMs = ms;
    }
  }

  /** いまの出力レベル（dBFS）。実時間の確認用 */
  level(): number {
    return this.mixer ? this.mixer.level() : -180;
  }

  /** 数値検証: OfflineAudioContext で同じ Mixer を走らせて解析する（tools/audio-probe.mjs から） */
  renderOffline(cfg: ProbeConfig): Promise<ProbeResult> {
    return renderOffline(cfg);
  }

  dispose() {
    this.unhook?.();
    this.unhook = null;
    this.mixer?.dispose();
    this.mixer = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }
}
