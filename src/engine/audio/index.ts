// 音。土台版は無音の枠だけ。音担当が WebAudio の合成だけで 風・雨・雷・波・足音・鳥・虫・環境音・UI音 を作る。
// 契約:
//   - 音声ファイルは一切使わない（OscillatorNode / ノイズバッファ / フィルタ / 畳み込みは自前生成で）
//   - start() はユーザー操作（クリック／タップ）から呼ばれる。AudioContext はそこで resume
//   - update(dt) で env.weather（風速・雨）・時刻（鳥は昼、虫は夜）・controls（足音）に追従
//   - setMuted(bool)。muted でもフレームは止めない
//   - 裏返しの「波」（env.flipRadius が広がる間）には専用の音を鳴らす
import type { Env } from "../core/env";

export class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  muted = false;
  started = false;
  constructor(public env: Env) {}

  start() {
    if (this.started) return;
    this.started = true;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  /** 足音などのイベント。controls から呼ぶ */
  footstep(_surface: "grass" | "rock" | "sand" | "water") {}
  shutter() {}
  flipWave(_on: boolean) {}

  update(_dt: number) {}
}
