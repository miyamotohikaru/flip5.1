// 足音。地面の種類ごとに違う作りで、一歩ごとにピッチ・長さ・フィルタが少しずつ違う（ハッシュで決定的）。
//   grass … 草のこすれ（帯域ノイズ）＋柔らかい踏み＋かかと→つま先の二段目
//   rock  … 硬いクリック＋石の共鳴「トッ」＋砂利の粒
//   sand  … さらさら（微細に揺れる包絡）＋粒
//   water … ぱしゃ（帯域ノイズ）＋気泡のチャープ＋低い「ぽちゃ」
// 走ると強く・短く・少し高く。左右の足で僅かにパンが振れる。
import { attackDecay, biquad, clamp, gainNode, oneShot, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";
import type { Surface } from "./types";

export class FootstepLayer {
  out: GainNode;
  count = 0;

  constructor(private ctx: Ctx, dest: AudioNode, private res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
  }

  step(surface: Surface, speedFactor: number, now: number) {
    const ctx = this.ctx, res = this.res;
    const i = this.count++;
    const r = new Rng(3000 + i, surface.length);
    const t = now + 0.01;
    const sf = clamp(speedFactor, 0.5, 2);
    const loud = 0.75 + 0.45 * (sf - 1);
    const durK = 1 / Math.pow(sf, 0.3);
    const pitch = (1 + 0.12 * (sf - 1)) * r.logRange(0.9, 1.11);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (i % 2 ? 0.14 : -0.14) + r.range(-0.05, 0.05);
    pan.connect(this.out);
    const noise = (when: number, dur: number) => oneShot(ctx, res.noiseShort, when, dur, r.range(0, 1.5));

    switch (surface) {
      case "grass": {
        const n = noise(t, 0.4);
        const bp = biquad(ctx, "bandpass", 2200 * pitch, 0.9);
        const g = gainNode(ctx, 0);
        n.connect(bp);
        bp.connect(g);
        g.connect(pan);
        n.stop(attackDecay(g.gain, t, 0.5 * loud * r.range(0.8, 1.1), 0.012, r.range(0.09, 0.15) * durK));
        this.thud(pan, t + 0.004, 0.35 * loud, r.range(70, 95), 0.06);
        if (r.chance(0.6)) {
          const t2 = t + r.range(0.05, 0.09) * durK;
          const n2 = noise(t2, 0.2);
          const bp2 = biquad(ctx, "bandpass", 2800 * pitch, 1.1);
          const g2 = gainNode(ctx, 0);
          n2.connect(bp2);
          bp2.connect(g2);
          g2.connect(pan);
          n2.stop(attackDecay(g2.gain, t2, 0.22 * loud, 0.008, 0.05));
        }
        break;
      }
      case "rock": {
        const n = noise(t, 0.05);
        const hp = biquad(ctx, "highpass", 2500 * pitch, 0.7);
        const g = gainNode(ctx, 0);
        n.connect(hp);
        hp.connect(g);
        g.connect(pan);
        n.stop(attackDecay(g.gain, t, 0.42 * loud, 0.001, 0.008));
        const n2 = noise(t, 0.02);
        const bp = biquad(ctx, "bandpass", r.logRange(900, 1500) * pitch, 14);
        const g2 = gainNode(ctx, 0);
        n2.connect(bp);
        bp.connect(g2);
        g2.connect(pan);
        n2.stop(attackDecay(g2.gain, t, 0.6 * loud, 0.001, r.range(0.03, 0.05)) + 0.1);
        const gr = oneShot(ctx, res.gravel, t + 0.01, r.range(0.06, 0.12) * durK, r.range(0, 2.5), pitch);
        const bp3 = biquad(ctx, "bandpass", 3800 * pitch, 1.2);
        const g3 = gainNode(ctx, 0);
        gr.connect(bp3);
        bp3.connect(g3);
        g3.connect(pan);
        gr.stop(attackDecay(g3.gain, t + 0.01, 0.35 * loud, 0.005, 0.07 * durK));
        this.thud(pan, t, 0.25 * loud, r.range(90, 120), 0.04);
        break;
      }
      case "sand": {
        const n = noise(t, 0.5);
        const bp = biquad(ctx, "bandpass", r.range(1800, 3200) * pitch, 0.6);
        const g = gainNode(ctx, 0);
        n.connect(bp);
        bp.connect(g);
        g.connect(pan);
        const dur = r.range(0.15, 0.22) * durK;
        const curve = new Float32Array(48);
        const amp = 0.45 * loud;
        for (let k = 0; k < 48; k++) {
          const x = k / 47;
          curve[k] = amp * Math.pow(Math.sin(Math.PI * x), 0.8) * (0.75 + 0.25 * r.next());
        }
        curve[47] = 0;
        g.gain.setValueAtTime(0, t);
        g.gain.setValueCurveAtTime(curve, t + 0.0005, dur);
        n.stop(t + dur + 0.05);
        const gr = oneShot(ctx, res.gravel, t + 0.02, 0.1, r.range(0, 2.5), pitch * 1.4);
        const bp2 = biquad(ctx, "bandpass", 5000, 1);
        const g2 = gainNode(ctx, 0);
        gr.connect(bp2);
        bp2.connect(g2);
        g2.connect(pan);
        gr.stop(attackDecay(g2.gain, t + 0.02, 0.15 * loud, 0.01, 0.08));
        this.thud(pan, t, 0.2 * loud, 75, 0.05);
        break;
      }
      case "water": {
        const n = noise(t, 0.6);
        const bp = biquad(ctx, "bandpass", r.range(1500, 2500) * pitch, 0.7);
        const g = gainNode(ctx, 0);
        n.connect(bp);
        bp.connect(g);
        g.connect(pan);
        n.stop(attackDecay(g.gain, t, 0.6 * loud, 0.012, r.range(0.22, 0.35) * durK));
        const nb = 2 + r.int(3);
        let tb = t + 0.03;
        for (let b = 0; b < nb; b++) {
          tb += r.range(0.03, 0.08);
          const o = ctx.createOscillator();
          const f0 = r.range(350, 900);
          o.frequency.setValueAtTime(f0, tb);
          o.frequency.exponentialRampToValueAtTime(f0 * 1.8, tb + 0.03);
          const og = gainNode(ctx, 0);
          o.connect(og);
          og.connect(pan);
          const end = attackDecay(og.gain, tb, 0.25 * loud, 0.003, 0.025);
          o.start(tb);
          o.stop(end + 0.02);
        }
        const n3 = noise(t, 0.15);
        const lp = biquad(ctx, "lowpass", 400, 0.8);
        const g3 = gainNode(ctx, 0);
        n3.connect(lp);
        lp.connect(g3);
        g3.connect(pan);
        n3.stop(attackDecay(g3.gain, t, 0.5 * loud, 0.008, 0.08));
        break;
      }
    }
  }

  /** 低い「ドッ」。周波数が少し下がる正弦波 */
  private thud(dest: AudioNode, t: number, amp: number, f: number, decay: number) {
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t + decay);
    const g = gainNode(this.ctx, 0);
    o.connect(g);
    g.connect(dest);
    const end = attackDecay(g.gain, t, amp, 0.004, decay);
    o.start(t);
    o.stop(end + 0.02);
  }
}
