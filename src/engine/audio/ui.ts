// UI の音と、裏返しの波の音。
//   enter   … 入場の柔らかい「ふわっ」（上がるバンドパスの雑音＋薄い和音）
//   shutter … 写真のシャッター（ミラーアップのクリック→共鳴、幕のクリック→戻りの余韻）
//   FlipVoice … 裏返しの波: 上昇するフィルタスイープ＋きらきらした倍音の群れ＋低い唸り＋数字が現れるカチカチ。
//               戻すときは逆向きに下降。全域が数式になった後は薄く持続する。
import { attackDecay, biquad, gainNode, lfo, loop, oneShot, setT, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";

export function playEnter(ctx: Ctx, dest: AudioNode, res: Resources, t: number) {
  const n = oneShot(ctx, res.noiseL, t, 2.6, 1.2);
  const bp = biquad(ctx, "bandpass", 400, 1.4);
  bp.frequency.setValueAtTime(380, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 1.2);
  const g = gainNode(ctx, 0);
  n.connect(bp);
  bp.connect(g);
  g.connect(dest);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.22, t + 0.55);
  g.gain.setTargetAtTime(0, t + 0.7, 0.45);
  n.stop(t + 2.6);
  const freqs = [330, 495, 660, 880];
  freqs.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    o.detune.value = i % 2 ? 3 : -3;
    const og = gainNode(ctx, 0);
    o.connect(og);
    og.connect(dest);
    og.gain.setValueAtTime(0, t + 0.1);
    og.gain.linearRampToValueAtTime(i === 3 ? 0.02 : 0.045, t + 0.5);
    og.gain.setTargetAtTime(0, t + 0.7, 0.6);
    o.start(t);
    o.stop(t + 3.2);
  });
}

export function playShutter(ctx: Ctx, dest: AudioNode, res: Resources, t: number) {
  const r = new Rng(Math.floor(t * 1000), 8);
  const click = (when: number, amp: number, hp: number) => {
    const n = oneShot(ctx, res.noiseShort, when, 0.03, r.range(0, 1.5));
    const f = biquad(ctx, "highpass", hp, 0.7);
    const g = gainNode(ctx, 0);
    n.connect(f);
    f.connect(g);
    g.connect(dest);
    n.stop(attackDecay(g.gain, when, amp, 0.0008, 0.006));
  };
  const ring = (when: number, amp: number, freq: number, q: number, decay: number) => {
    const n = oneShot(ctx, res.noiseShort, when, 0.01, r.range(0, 1.5));
    const f = biquad(ctx, "bandpass", freq, q);
    const g = gainNode(ctx, 0);
    n.connect(f);
    f.connect(g);
    g.connect(dest);
    n.stop(attackDecay(g.gain, when, amp, 0.001, decay) + 0.15);
  };
  const thump = (when: number, amp: number, lp: number, decay: number) => {
    const n = oneShot(ctx, res.noiseShort, when, 0.1, r.range(0, 1.5));
    const f = biquad(ctx, "lowpass", lp, 0.9);
    const g = gainNode(ctx, 0);
    n.connect(f);
    f.connect(g);
    g.connect(dest);
    n.stop(attackDecay(g.gain, when, amp, 0.002, decay));
  };
  // ミラーアップ
  click(t, 0.8, 2500);
  ring(t, 0.35, 2300, 18, 0.04);
  thump(t + 0.002, 0.5, 500, 0.03);
  // 機構の「シュッ」
  const n = oneShot(ctx, res.noiseShort, t + 0.015, 0.08, r.range(0, 1.5));
  const bp = biquad(ctx, "bandpass", 4500, 2);
  const g = gainNode(ctx, 0);
  n.connect(bp);
  bp.connect(g);
  g.connect(dest);
  n.stop(attackDecay(g.gain, t + 0.015, 0.12, 0.01, 0.05));
  // 幕が閉じる
  click(t + 0.05, 0.65, 1800);
  ring(t + 0.05, 0.3, 1800, 14, 0.05);
  thump(t + 0.052, 0.6, 300, 0.045);
  // ばねの余韻
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.value = 1750;
  const og = gainNode(ctx, 0);
  o.connect(og);
  og.connect(dest);
  lfo(ctx, 28, 40, o.frequency, t + 0.055, t + 0.4);
  const end = attackDecay(og.gain, t + 0.055, 0.05, 0.003, 0.12);
  o.start(t + 0.055);
  o.stop(end + 0.05);
}

const RATIOS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 9, 12, 15];

export class FlipVoice {
  private sweepSrc: AudioBufferSourceNode;
  private sweepBP: BiquadFilterNode;
  private gSweep: GainNode;
  private partials: { o: OscillatorNode; g: GainNode }[] = [];
  private gShim: GainNode;
  private drone: OscillatorNode[] = [];
  private gDrone: GainNode;
  private tickSrc: AudioBufferSourceNode;
  private gTicks: GainNode;
  private stopped = false;

  constructor(private ctx: Ctx, dest: AudioNode, res: Resources, t: number) {
    const r = new Rng(4444, Math.floor(t));
    // スイープ
    this.sweepSrc = loop(ctx, res.noiseL, { offset: 2.2, when: t });
    this.sweepBP = biquad(ctx, "bandpass", 140, 5);
    this.gSweep = gainNode(ctx, 0);
    this.sweepSrc.connect(this.sweepBP);
    this.sweepBP.connect(this.gSweep);
    this.gSweep.connect(dest);
    // きらきら
    this.gShim = gainNode(ctx, 0);
    const hp = biquad(ctx, "highpass", 500, 0.7);
    this.gShim.connect(hp);
    hp.connect(dest);
    const base = 660;
    for (const ratio of RATIOS) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = base * ratio * r.logRange(0.995, 1.005);
      const amp = (0.55 / Math.pow(ratio, 0.8)) * r.range(0.6, 1);
      const g = gainNode(ctx, amp * 0.5);
      lfo(ctx, r.range(0.4, 3.2), amp * 0.5, g.gain, t);
      o.connect(g);
      g.connect(this.gShim);
      o.start(t);
      this.partials.push({ o, g });
    }
    // 唸り
    this.gDrone = gainNode(ctx, 0);
    const dlp = biquad(ctx, "lowpass", 220, 0.8);
    dlp.connect(this.gDrone);
    this.gDrone.connect(dest);
    for (const [f, type] of [[42, "sine"], [63.5, "triangle"]] as [number, OscillatorType][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(dlp);
      o.start(t);
      this.drone.push(o);
    }
    lfo(ctx, 0.35, 0.3, this.gDrone.gain, t);
    // 数字が現れるカチカチ
    this.tickSrc = loop(ctx, res.ticks, { when: t });
    const tbp = biquad(ctx, "bandpass", 3500, 1.5);
    this.gTicks = gainNode(ctx, 0);
    this.tickSrc.connect(tbp);
    tbp.connect(this.gTicks);
    this.gTicks.connect(dest);
  }

  /** p = 波の半径 / 6000、dir = +1 広がる / −1 縮む、flipView = env.flip、complete = 全域が数式 */
  update(p: number, dir: 1 | -1, flipView: number, t: number, complete: boolean) {
    if (this.stopped) return;
    const q = Math.min(1, Math.max(0, p));
    const mid = Math.sin(Math.PI * q);
    setT(this.sweepBP.frequency, 140 * Math.pow(64, q), t, 0.06);
    const sweep = complete ? 0.02 * flipView : (dir > 0 ? 0.32 : 0.26) * Math.pow(mid, 0.6);
    setT(this.gSweep.gain, sweep, t, 0.08);
    const det = 1200 * q;
    for (const pt of this.partials) setT(pt.o.detune, det, t, 0.08);
    const shim = complete ? 0.07 * flipView : (dir > 0 ? 0.3 : 0.22) * Math.pow(q, 0.7);
    setT(this.gShim.gain, shim, t, 0.1);
    const drone = complete ? 0.12 * flipView : 0.28 * Math.pow(q, 0.8);
    setT(this.gDrone.gain, drone, t, 0.15);
    setT(this.gTicks.gain, complete ? 0.03 * flipView : 0.22 * mid, t, 0.08);
  }

  stop(t: number) {
    if (this.stopped) return;
    this.stopped = true;
    for (const g of [this.gSweep, this.gShim, this.gDrone, this.gTicks]) setT(g.gain, 0, t, 0.15);
    const end = t + 0.9;
    this.sweepSrc.stop(end);
    this.tickSrc.stop(end);
    for (const p of this.partials) p.o.stop(end);
    for (const o of this.drone) o.stop(end);
  }
}
