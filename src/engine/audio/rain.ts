// 雨。粒の列（dsp.rainGrains）を層ごとに重ねる。
//   hiss   … 無数の粒の芯「ザー」（密度で強さ。突風で揺れる）
//   leaf   … 葉に当たる高い「パチ」（森で多い）
//   ground … 地面・草に当たる柔らかい「パタ」
//   sparse … 降り始めの数滴（弱い雨のときだけ）
//   water  … 水面の気泡「ピチョ」（岸に近いほど。湖の方向から）
//   rumble … 嵐の低いうねり
import { smooth } from "./dsp";
import { attackDecay, biquad, control, gainNode, lfo, loop, oneShot, setT, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";
import type { Scene } from "./types";
import { LAB } from "../lab/store";

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
  private nextDrip = 0;
  private rng = new Rng(8080);
  /** 粒の列（rainGrains）の音源と、作ったときの再生速度。実験室の「雨粒の密度」で速度を変える＝粒/秒が変わる */
  private grains: { src: AudioBufferSourceNode; base: number }[] = [];
  private grainRate = 1;
  /** 検証用: 雨上がりの雫の数 */
  drips = 0;

  constructor(private ctx: Ctx, dest: AudioNode, private res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    const merger = ctx.createChannelMerger(2);
    merger.connect(this.out);
    // 粒のループが「同じ並び」に聞こえないよう、再生速度をごくゆっくり揺らす
    const now = ctx.currentTime;
    const drift = (src: AudioBufferSourceNode, rate: number, phase: number) => lfo(ctx, rate, 0.02, src.playbackRate, now + phase);

    for (let ch = 0; ch < 2; ch++) {
      // 芯
      const src = loop(ctx, res.rainHiss, { offset: ch ? 3.1 : 0.4, rate: ch ? 1 : 0.97 });
      this.grains.push({ src, base: ch ? 1 : 0.97 });
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
      this.grains.push({ src: leaf, base: ch ? 0.93 : 1 });
      drift(leaf, 0.031 + 0.01 * ch, ch * 0.3);
      const lbp = biquad(ctx, "bandpass", 4200, 0.8);
      const lg = gainNode(ctx, 0);
      leaf.connect(lbp);
      lbp.connect(lg);
      lg.connect(merger, 0, ch);
      this.gLeaf.push(lg);

      // 地面
      const ground = loop(ctx, res.rainGround, { rate: ch ? 1.06 : 1, offset: ch ? 4.4 : 1.1 });
      this.grains.push({ src: ground, base: ch ? 1.06 : 1 });
      drift(ground, 0.023 + 0.013 * ch, 0.7 + ch * 0.4);
      const gbp = biquad(ctx, "bandpass", 1900, 0.8);
      const gg = gainNode(ctx, 0);
      ground.connect(gbp);
      gbp.connect(gg);
      gg.connect(merger, 0, ch);
      this.gGround.push(gg);

      // 数滴
      const sparse = loop(ctx, res.rainSparse, { rate: ch ? 0.96 : 1, offset: ch ? 3.7 : 0 });
      this.grains.push({ src: sparse, base: ch ? 0.96 : 1 });
      drift(sparse, 0.017 + 0.009 * ch, 1.1 + ch * 0.5);
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
      this.grains.push({ src: w, base: i ? 1.04 : 1 });
      drift(w, 0.027 + 0.011 * i, 2 + i * 0.6);
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
    // 実験室の「雨粒の密度」: 粒の列の再生速度を変える（列は N 粒／T 秒なので、速度 k で N·k/T 粒/秒）
    if (LAB.audioRain !== this.grainRate) {
      this.grainRate = LAB.audioRain;
      for (const g of this.grains) g.src.playbackRate.setTargetAtTime(g.base * this.grainRate, t, 0.08);
    }
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
    // 雨上がり: 濡れた木から雫が落ちる（雨が弱いほど・森ほど）
    const drip = s.wetness * (1 - smooth(0.05, 0.3, r)) * (0.25 + 0.75 * s.forest + 0.2 * s.grass);
    if (drip > 0.05 && t >= this.nextDrip) {
      this.drip(t + 0.03, drip);
      this.nextDrip = t + this.rng.range(0.35, 2.6) / (0.4 + drip);
    }
  }

  private drip(t: number, level: number) {
    const ctx = this.ctx, r = new Rng(8100 + this.drips++);
    const pan = ctx.createStereoPanner();
    pan.pan.value = r.range(-0.85, 0.85);
    const dist = r.logRange(0.5, 1);
    pan.connect(this.out);
    // 気泡の「ピチョ」（周波数が上がる）
    const o = ctx.createOscillator();
    const f0 = r.logRange(600, 1900);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * r.range(1.25, 1.6), t + 0.03);
    const og = gainNode(ctx, 0);
    o.connect(og);
    og.connect(pan);
    const end = attackDecay(og.gain, t, 0.28 * level * dist, 0.002, r.range(0.012, 0.03));
    o.start(t);
    o.stop(end + 0.05);
    // 当たった瞬間の小さなクリック
    const n = oneShot(ctx, this.res.noiseShort, t, 0.01, r.range(0, 1.5));
    const bp = biquad(ctx, "bandpass", r.range(2500, 5000), 3);
    const ng = gainNode(ctx, 0);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(pan);
    n.stop(attackDecay(ng.gain, t, 0.12 * level * dist, 0.001, 0.004) + 0.02);
  }
}
