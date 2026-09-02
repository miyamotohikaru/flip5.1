// 湖岸の波。ローパスした雑音を「寄せて…引く」包絡（dsp.waveEnvelope）で揺らし、時々「チャプ」。
// 岸からの距離で音量、湖の中心の方向へパン。風が強いと荒く、チャプが増える。
import { attackDecay, biquad, control, gainNode, loop, oneShot, setT, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";
import type { Scene } from "./types";

export class WaterLayer {
  out: GainNode;
  private pan: StereoPannerNode;
  private gWash: GainNode[] = [];
  private dWash: GainNode[] = [];
  private washLP: BiquadFilterNode[] = [];
  private gFoam: GainNode;
  private dFoam: GainNode;
  private nextChap = 0;
  private rng = new Rng(4242);
  private chaps = 0;

  constructor(private ctx: Ctx, dest: AudioNode, private res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    this.pan = ctx.createStereoPanner();
    this.pan.connect(this.out);
    const merger = ctx.createChannelMerger(2);
    const hp = biquad(ctx, "highpass", 180, 0.6);
    merger.connect(hp);
    hp.connect(this.pan);
    for (let ch = 0; ch < 2; ch++) {
      const src = loop(ctx, ch ? res.noiseL : res.noiseR, { offset: ch ? 1.9 : 3.3 });
      const lp = biquad(ctx, "lowpass", 900, 0.6);
      const g = gainNode(ctx, 0);
      src.connect(lp);
      lp.connect(g);
      g.connect(merger, 0, ch);
      this.gWash.push(g);
      this.washLP.push(lp);
      // 包絡は両耳同じ（同じ波）。右はほんの少し遅れる
      this.dWash.push(control(ctx, res.ctlWave, g.gain, 0, 1, ch ? 0.05 : 0).depth);
    }
    // 泡（高い帯域、速い揺らぎ）
    const fs = loop(ctx, res.noiseL, { offset: 5.1 });
    const fbp = biquad(ctx, "bandpass", 2600, 1.0);
    this.gFoam = gainNode(ctx, 0);
    fs.connect(fbp);
    fbp.connect(this.gFoam);
    this.gFoam.connect(this.pan);
    this.dFoam = control(ctx, res.ctlFoam, this.gFoam.gain, 0, 1, 0).depth;
    // 泡は波の包絡にも乗せる
    control(ctx, res.ctlWave, this.gFoam.gain, 0, 1, 0);
  }

  tick(s: Scene) {
    const t = s.t;
    const near = s.shoreFactor;
    const w = s.wind;
    const inWater = s.shoreDist < 0;
    const wash = near * (0.22 + 0.7 * w) * (inWater ? 1.15 : 1);
    const foam = near * (0.04 + 0.4 * w);
    for (let ch = 0; ch < 2; ch++) {
      setT(this.gWash[ch].gain, wash * 0.18, t, 0.4);
      setT(this.dWash[ch].gain, wash * 0.85, t, 0.4);
      setT(this.washLP[ch].frequency, 650 + 1100 * w + (inWater ? 250 : 0) - 250 * (1 - near), t, 0.6);
    }
    setT(this.gFoam.gain, foam * 0.2, t, 0.4);
    setT(this.dFoam.gain, foam * 0.8, t, 0.4);
    setT(this.pan.pan, s.lakePan * (s.shoreDist < -3 ? 0.15 : 0.8), t, 0.3);
    // チャプ
    if (near > 0.02 && t >= this.nextChap) {
      this.chap(t + 0.05, s);
      this.nextChap = t + this.rng.range(1.2, 5.5) / (1 + 2.5 * w);
    }
  }

  private chap(t: number, s: Scene) {
    const ctx = this.ctx, r = new Rng(5000 + this.chaps++);
    const near = s.shoreFactor, w = s.wind;
    const amp = near * (0.3 + 0.45 * w) * r.range(0.45, 1);
    const n = oneShot(ctx, this.res.noiseShort, t, 0.3, r.range(0, 1.6));
    const bp = biquad(ctx, "bandpass", r.logRange(380, 1100), r.range(2, 5));
    const g = gainNode(ctx, 0);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, s.lakePan * 0.8 + r.range(-0.35, 0.35)));
    n.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(this.out);
    const end = attackDecay(g.gain, t, amp, 0.006, r.range(0.04, 0.11));
    n.stop(end + 0.05);
    if (r.chance(0.35)) {
      // 小さな気泡
      const o = ctx.createOscillator();
      const f0 = r.range(300, 500);
      o.frequency.setValueAtTime(f0, t + 0.01);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.9, t + 0.045);
      const og = gainNode(ctx, 0);
      o.connect(og);
      og.connect(pan);
      const e2 = attackDecay(og.gain, t + 0.01, amp * 0.35, 0.004, 0.03);
      o.start(t + 0.01);
      o.stop(e2 + 0.05);
    }
  }
}
