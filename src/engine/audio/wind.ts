// 風。白色雑音を 4 つの帯域に分けて、突風で変調する。
//   roar   … 耳元の低い「ゴー」（100〜300Hz）
//   rustle … 木々を渡る「ざわめき」（1〜3kHz、突風で上がる）
//   hiss   … 岩場の「シュー」（3.8kHz〜）
//   buffet … 強風で耳に当たる低域の「バフバフ」（〜80Hz、速い揺れ）
// 左右は別々の雑音。突風は両耳ほぼ同時（右は 0.12 秒遅れ）、木のざわめきは左右で別々に漂う。
import { smooth } from "./dsp";
import { biquad, control, gainNode, loop, setT, type Ctx } from "./graph";
import type { Resources } from "./resources";
import type { Scene } from "./types";

type Side = {
  gRoar: GainNode;
  gRustle: GainNode;
  gHiss: GainNode;
  gBuffet: GainNode;
  roar1: BiquadFilterNode;
  rustle: BiquadFilterNode;
  dRoar: GainNode;
  dRustle: GainNode;
  dRustleF: GainNode;
  dRoarF: GainNode;
  dBuffet: GainNode;
  dDrift: GainNode;
};

export class WindLayer {
  out: GainNode;
  private sides: Side[] = [];

  constructor(ctx: Ctx, dest: AudioNode, res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    const merger = ctx.createChannelMerger(2);
    merger.connect(this.out);
    for (let ch = 0; ch < 2; ch++) {
      const src = loop(ctx, ch ? res.noiseR : res.noiseL, { offset: ch ? 2.37 : 0.61 });
      const roar1 = biquad(ctx, "lowpass", 160, 1.0);
      const roar2 = biquad(ctx, "lowpass", 380, 0.6);
      const gRoar = gainNode(ctx, 0);
      src.connect(roar1);
      roar1.connect(roar2);
      roar2.connect(gRoar);
      gRoar.connect(merger, 0, ch);

      const rustle = biquad(ctx, "bandpass", 1500, 0.9);
      const gRustle = gainNode(ctx, 0);
      src.connect(rustle);
      rustle.connect(gRustle);
      gRustle.connect(merger, 0, ch);

      const hiss = biquad(ctx, "highpass", 3800, 0.6);
      const gHiss = gainNode(ctx, 0);
      src.connect(hiss);
      hiss.connect(gHiss);
      gHiss.connect(merger, 0, ch);

      const buf = biquad(ctx, "lowpass", 80, 1.4);
      const gBuffet = gainNode(ctx, 0);
      src.connect(buf);
      buf.connect(gBuffet);
      gBuffet.connect(merger, 0, ch);

      const gustOff = ch ? 0.12 : 0;
      const dRoar = control(ctx, res.ctlGust, gRoar.gain, 0, 1, gustOff).depth;
      const dRustle = control(ctx, res.ctlGust, gRustle.gain, 0, 1, gustOff).depth;
      const dRustleF = control(ctx, res.ctlGust, rustle.frequency, 0, 1, gustOff).depth;
      const dRoarF = control(ctx, res.ctlGust, roar1.frequency, 0, 1, gustOff).depth;
      const dBuffet = control(ctx, res.ctlFlutter, gBuffet.gain, 0, 1, ch ? 3.3 : 0).depth;
      const dDrift = control(ctx, res.ctlDrift, gRustle.gain, 0, 1, ch ? 20 : 0).depth;
      this.sides.push({ gRoar, gRustle, gHiss, gBuffet, roar1, rustle, dRoar, dRustle, dRustleF, dRoarF, dBuffet, dDrift });
    }
  }

  tick(s: Scene) {
    const t = s.t;
    const ext = s.hasGust ? s.gust : 0;
    const w = Math.min(1.25, s.wind * (s.hasGust ? 0.7 + 0.6 * ext : 1));
    const roar = 0.012 + 0.6 * Math.pow(w, 1.7);
    const veg = 0.3 + 0.7 * s.forest + 0.35 * s.grass;
    const rustle = (0.02 + 0.5 * Math.pow(w, 1.25)) * veg;
    const hiss = 0.1 * w * w * (0.5 + 0.8 * s.rock + 0.3 * s.forest);
    const buffet = 0.8 * smooth(0.4, 1, w);
    for (const sd of this.sides) {
      setT(sd.gRoar.gain, roar * 0.45, t, 0.3);
      setT(sd.dRoar.gain, roar * 0.9, t, 0.3);
      setT(sd.gRustle.gain, rustle * 0.35, t, 0.3);
      setT(sd.dRustle.gain, rustle * 0.9, t, 0.3);
      setT(sd.dDrift.gain, rustle * 0.35, t, 0.3);
      setT(sd.gHiss.gain, hiss, t, 0.3);
      setT(sd.gBuffet.gain, buffet * 0.25, t, 0.3);
      setT(sd.dBuffet.gain, buffet, t, 0.3);
      setT(sd.roar1.frequency, 110 + 220 * w, t, 0.5);
      setT(sd.dRoarF.gain, 90 + 120 * w, t, 0.5);
      setT(sd.rustle.frequency, 1000 + 1200 * w, t, 0.5);
      setT(sd.dRustleF.gain, 600 + 900 * w, t, 0.5);
      setT(sd.rustle.Q, 1.2 - 0.6 * Math.min(1, w), t, 0.5);
    }
  }
}
