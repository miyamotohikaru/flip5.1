// 雨。粒の列（dsp.rainGrains）を層ごとに重ねる。
//   hiss   … 無数の粒の芯「ザー」（密度で強さ。突風で揺れる）
//   leaf   … 葉に当たる高い「パチ」（森で多い）
//   ground … 地面・草に当たる柔らかい「パタ」
//   sparse … 降り始めの数滴（弱い雨のときだけ）
//   water  … 水面の気泡「ピチョ」（岸に近いほど。湖の方向から）
//   rumble … 嵐の低いうねり
import { smooth } from "./dsp";
import { biquad, control, gainNode, loop, setT, type Ctx } from "./graph";
import type { Resources } from "./resources";
import type { Scene } from "./types";

export class RainLayer {
  out: GainNode;
  private gHiss: GainNode[] = [];
  private dHiss: GainNode[] = [];
  private hissLP: BiquadFilterNode[] = [];
  private gLeaf: GainNode[] = [];
  private gGround: GainNode[] = [];
  private gSparse: GainNode[] = [];
  private gWater: GainNode;
  private waterPan: StereoPannerNode;
  private gRumble: GainNode;
  private dRumble: GainNode;

  constructor(ctx: Ctx, dest: AudioNode, res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    const merger = ctx.createChannelMerger(2);
    merger.connect(this.out);

    for (let ch = 0; ch < 2; ch++) {
      // 芯
      const src = loop(ctx, res.rainHiss, { offset: ch ? 3.1 : 0.4, rate: ch ? 1 : 0.97 });
      const hp = biquad(ctx, "highpass", 500, 0.6);
      const lp = biquad(ctx, "lowpass", 5000, 0.5);
      const g = gainNode(ctx, 0);
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(merger, 0, ch);
      this.gHiss.push(g);
      this.hissLP.push(lp);
      this.dHiss.push(control(ctx, res.ctlGust, g.gain, 0, 1, ch ? 0.12 : 0).depth);

      // 葉
      const leaf = loop(ctx, ch ? res.rainLeafB : res.rainLeafA, { rate: ch ? 0.93 : 1, offset: ch ? 2.2 : 0 });
      const lbp = biquad(ctx, "bandpass", 4200, 0.8);
      const lg = gainNode(ctx, 0);
      leaf.connect(lbp);
      lbp.connect(lg);
      lg.connect(merger, 0, ch);
      this.gLeaf.push(lg);

      // 地面
      const ground = loop(ctx, res.rainGround, { rate: ch ? 1.06 : 1, offset: ch ? 4.4 : 1.1 });
      const gbp = biquad(ctx, "bandpass", 1900, 0.8);
      const gg = gainNode(ctx, 0);
      ground.connect(gbp);
      gbp.connect(gg);
      gg.connect(merger, 0, ch);
      this.gGround.push(gg);

      // 数滴
      const sparse = loop(ctx, res.rainSparse, { rate: ch ? 0.96 : 1, offset: ch ? 3.7 : 0 });
      const shp = biquad(ctx, "highpass", 1500, 0.6);
      const sg = gainNode(ctx, 0);
      sparse.connect(shp);
      shp.connect(sg);
      sg.connect(merger, 0, ch);
      this.gSparse.push(sg);
    }

    // 水面（湖の方向へ）
    this.gWater = gainNode(ctx, 0);
    this.waterPan = ctx.createStereoPanner();
    for (let i = 0; i < 2; i++) {
      const w = loop(ctx, res.rainWater, { rate: i ? 1.04 : 1, offset: i ? 3.3 : 0.7 });
      const bp = biquad(ctx, "bandpass", 1300, 1.2);
      w.connect(bp);
      bp.connect(this.gWater);
    }
    this.gWater.connect(this.waterPan);
    this.waterPan.connect(this.out);

    // 嵐のうねり
    const rn = loop(ctx, res.noiseR, { offset: 4.2 });
    const rlp = biquad(ctx, "lowpass", 130, 1.0);
    this.gRumble = gainNode(ctx, 0);
    rn.connect(rlp);
    rlp.connect(this.gRumble);
    this.gRumble.connect(this.out);
    this.dRumble = control(ctx, res.ctlGust, this.gRumble.gain, 0, 0.7, 7.7).depth;
  }

  tick(s: Scene) {
    const t = s.t, r = s.rain;
    const on = r > 0.004;
    const hiss = on ? 0.9 * Math.pow(smooth(0.12, 1, r), 1.3) : 0;
    const leaf = on ? 0.55 * Math.sqrt(r) * (0.45 + 0.55 * s.forest + 0.25 * s.grass) : 0;
    const ground = on ? 0.5 * Math.sqrt(r) * (0.5 + 0.5 * s.grass + 0.4 * s.rock) : 0;
    const sparse = on ? 0.7 * smooth(0, 0.12, r) * (1 - smooth(0.25, 0.55, r)) : 0;
    const water = on ? 0.7 * Math.sqrt(r) * s.shoreFactor : 0;
    const rumble = on ? 0.6 * r * (0.3 + 0.7 * s.storm) : 0;
    for (let ch = 0; ch < 2; ch++) {
      setT(this.gHiss[ch].gain, hiss * 0.7, t, 0.4);
      setT(this.dHiss[ch].gain, hiss * 0.45 * (0.3 + s.wind), t, 0.4);
      setT(this.hissLP[ch].frequency, 3500 + 7000 * r, t, 0.6);
      setT(this.gLeaf[ch].gain, leaf, t, 0.4);
      setT(this.gGround[ch].gain, ground, t, 0.4);
      setT(this.gSparse[ch].gain, sparse, t, 0.4);
    }
    setT(this.gWater.gain, water, t, 0.4);
    setT(this.waterPan.pan, s.lakePan * (s.shoreDist < -3 ? 0.15 : 0.7), t, 0.3);
    setT(this.gRumble.gain, rumble * 0.5, t, 0.5);
    setT(this.dRumble.gain, rumble * 0.8, t, 0.5);
  }
}
