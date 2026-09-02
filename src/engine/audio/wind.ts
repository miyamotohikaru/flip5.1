// 風。白色雑音を帯域に分けて、突風で変調する。
//   roar   … 耳元の低い「ゴー」（100〜300Hz）。左右で同じ雑音（遠くの森を渡る音は拡散して両耳に同じ）
//   rustle … 木々を渡る「ざわめき」（1〜3kHz、突風で上がる）。左右で別々に漂う
//   leaves … 葉のこすれの粒（rainGrains "gravel"）。突風の二乗で密度が上がったように聞こえる
//   hiss   … 岩場の「シュー」（3.8kHz〜）
//   buffet … 強風で耳に当たる低域の「バフバフ」（〜80Hz、速い揺れ）。左右で別々（乱流は耳ごと）
//   howl   … 強風の「ヒュー」（Q の高い共鳴、突風で音程が上がる）。風上側から
// 突風は両耳ほぼ同時（右は 0.12 秒遅れ）。風上側の耳を少し強くする。
import { smooth } from "./dsp";
import { biquad, control, gainNode, loop, setT, type Ctx } from "./graph";
import type { Resources } from "./resources";
import type { Scene } from "./types";

type Side = {
  gRoar: GainNode;
  gRustle: GainNode;
  gLeaves: GainNode;
  gHiss: GainNode;
  gBuffet: GainNode;
  roar1: BiquadFilterNode;
  rustle: BiquadFilterNode;
  dRoar: GainNode;
  dRustle: GainNode;
  dRustleF: GainNode;
  dRoarF: GainNode;
  dLeaves: GainNode;
  dBuffet: GainNode;
  dDrift: GainNode;
};

export class WindLayer {
  out: GainNode;
  private sides: Side[] = [];
  private howl: BiquadFilterNode;
  private gHowl: GainNode;
  private dHowl: GainNode;
  private dHowlF: GainNode;
  private howlPan: StereoPannerNode;

  constructor(ctx: Ctx, dest: AudioNode, res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    const merger = ctx.createChannelMerger(2);
    merger.connect(this.out);
    const shared = loop(ctx, res.noiseR, { offset: 4.05 });
    for (let ch = 0; ch < 2; ch++) {
      const src = loop(ctx, ch ? res.noiseR : res.noiseL, { offset: ch ? 2.37 : 0.61 });
      const roar1 = biquad(ctx, "lowpass", 160, 1.0);
      const roar2 = biquad(ctx, "lowpass", 380, 0.6);
      const gRoar = gainNode(ctx, 0);
      shared.connect(roar1);
      roar1.connect(roar2);
      roar2.connect(gRoar);
      gRoar.connect(merger, 0, ch);

      const rustle = biquad(ctx, "bandpass", 1500, 0.9);
      const gRustle = gainNode(ctx, 0);
      src.connect(rustle);
      rustle.connect(gRustle);
      gRustle.connect(merger, 0, ch);

      const leaves = loop(ctx, ch ? res.rustleB : res.rustleA, { offset: ch ? 1.3 : 0, rate: ch ? 0.95 : 1 });
      const lbp = biquad(ctx, "bandpass", 2600, 0.7);
      const gLeaves = gainNode(ctx, 0);
      leaves.connect(lbp);
      lbp.connect(gLeaves);
      gLeaves.connect(merger, 0, ch);

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
      const dLeaves = control(ctx, res.ctlGust, gLeaves.gain, 0, 1, gustOff + 0.05).depth;
      const dBuffet = control(ctx, res.ctlFlutter, gBuffet.gain, 0, 1, ch ? 3.3 : 0).depth;
      const dDrift = control(ctx, res.ctlDrift, gRustle.gain, 0, 1, ch ? 20 : 0).depth;
      this.sides.push({ gRoar, gRustle, gLeaves, gHiss, gBuffet, roar1, rustle, dRoar, dRustle, dRustleF, dRoarF, dLeaves, dBuffet, dDrift });
    }
    // ヒュー
    this.howl = biquad(ctx, "bandpass", 520, 18);
    this.gHowl = gainNode(ctx, 0);
    this.howlPan = ctx.createStereoPanner();
    shared.connect(this.howl);
    this.howl.connect(this.gHowl);
    this.gHowl.connect(this.howlPan);
    this.howlPan.connect(this.out);
    this.dHowl = control(ctx, res.ctlGust, this.gHowl.gain, 0, 1, 0.3).depth;
    this.dHowlF = control(ctx, res.ctlGust, this.howl.frequency, 0, 1, 0.3).depth;
  }

  tick(s: Scene) {
    const t = s.t;
    const ext = s.hasGust ? s.gust : 0;
    const w = Math.min(1.25, s.wind * (s.hasGust ? 0.7 + 0.6 * ext : 1));
    // 帯域が狭いほど雑音の通る量が少ない（roar は白色雑音の約 1.4%、rustle は約 15%、hiss は約 84%）ので、
    // 「耳で聞いた配分」になるよう低域ほど大きく掛ける
    const roar = 0.03 + 0.6 * Math.pow(w, 1.7);
    const veg = 0.3 + 0.7 * s.forest + 0.35 * s.grass;
    const rustle = (0.06 + 0.4 * Math.pow(w, 1.25)) * veg;
    const leaves = (0.02 + 0.5 * Math.pow(w, 1.5)) * (0.15 + 0.85 * s.forest + 0.3 * s.grass);
    const hiss = 0.03 * w * w * (0.5 + 0.8 * s.rock + 0.3 * s.forest);
    const buffet = 0.8 * smooth(0.4, 1, w);
    const howl = 0.5 * smooth(0.5, 1.05, w) * (0.4 + 0.6 * s.rock + 0.3 * s.forest);
    for (let ch = 0; ch < 2; ch++) {
      const sd = this.sides[ch];
      // 風上側の耳（右が +）を少し強く
      const side = 1 + 0.35 * s.windPan * (ch ? 1 : -1);
      setT(sd.gRoar.gain, roar * 0.7 * side, t, 0.3);
      setT(sd.dRoar.gain, roar * 3.5 * side, t, 0.3);
      setT(sd.gRustle.gain, rustle * 0.3, t, 0.3);
      setT(sd.dRustle.gain, rustle * 1.4, t, 0.3);
      setT(sd.dDrift.gain, rustle * 0.35, t, 0.3);
      setT(sd.gLeaves.gain, leaves * 0.3, t, 0.3);
      setT(sd.dLeaves.gain, leaves * 3.2, t, 0.3);
      setT(sd.gHiss.gain, hiss * side, t, 0.3);
      setT(sd.gBuffet.gain, buffet * 0.7 * side, t, 0.3);
      setT(sd.dBuffet.gain, buffet * 2.0 * side, t, 0.3);
      setT(sd.roar1.frequency, 110 + 220 * w, t, 0.5);
      setT(sd.dRoarF.gain, 90 + 120 * w, t, 0.5);
      setT(sd.rustle.frequency, 1000 + 1200 * w, t, 0.5);
      setT(sd.dRustleF.gain, 600 + 900 * w, t, 0.5);
      setT(sd.rustle.Q, 1.2 - 0.6 * Math.min(1, w), t, 0.5);
    }
    setT(this.gHowl.gain, howl * 1.5, t, 0.4);
    setT(this.dHowl.gain, howl * 9, t, 0.4);
    setT(this.howl.frequency, 420 + 200 * w, t, 0.5);
    setT(this.dHowlF.gain, 350 + 250 * w, t, 0.5);
    setT(this.howlPan.pan, s.windPan * 0.5, t, 0.5);
  }
}
