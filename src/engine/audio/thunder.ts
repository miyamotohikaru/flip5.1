// 雷。env.lightning の閃光（あれば）を検知して、距離ぶん遅れて鳴る。
//   crack … 近い雷の「バリッ」（高域のノイズ、瞬間）
//   tear  … 「ビリビリ」と裂ける中域（0.3〜0.7 秒）
//   body  … 低域のノイズが転がる（dsp.thunderCurve の包絡 × 下がっていくローパス、3〜10 秒）
//   sub   … 胸に来る 30〜50Hz
// 全部を合成した残響（impulseResponse）に通して「ゴロゴロ…」と谷に転がす。
// env.lightning が無くて嵐なら、自前の決定的な間隔で鳴らす（見た目の閃光は出せない。報告書に明記）。
import { thunderCurve } from "./dsp";
import { attackDecay, biquad, gainNode, oneShot, setT, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";
import type { AudioEnv, Scene } from "./types";

export class ThunderLayer {
  out: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private conv: ConvolverNode;
  private lastStrikeTime: number | undefined = undefined;
  private prevFlash = 0;
  private nextAuto = Infinity;
  private strikes = 0;
  private rng = new Rng(9001);
  /** 最後に鳴らした落雷（検証用） */
  lastStrike: { at: number; distance: number; delay: number } | null = null;

  constructor(private ctx: Ctx, dest: AudioNode, private res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    this.dry = gainNode(ctx, 0.7);
    this.wet = gainNode(ctx, 0.9);
    this.conv = ctx.createConvolver();
    this.conv.buffer = res.irThunder;
    this.conv.normalize = true;
    this.dry.connect(this.out);
    this.wet.connect(this.conv);
    this.conv.connect(this.out);
  }

  /** 毎フレーム（安い）。閃光の跳ね上がりか lastStrikeTime の変化で落雷を検知 */
  detect(env: AudioEnv, now: number) {
    const L = env.lightning;
    if (!L) return;
    let hit = false;
    if (typeof L.lastStrikeTime === "number") {
      if (this.lastStrikeTime === undefined) {
        // 初めて見た値: いま起きたばかり（1 秒以内）なら落雷、古い値なら見送る
        if (env.time - L.lastStrikeTime < 1.0 && env.time - L.lastStrikeTime >= 0) hit = true;
      } else if (L.lastStrikeTime !== this.lastStrikeTime) hit = true;
      this.lastStrikeTime = L.lastStrikeTime;
    } else if (typeof L.flash === "number") {
      if (L.flash > 0.5 && this.prevFlash < 0.25) hit = true;
      this.prevFlash = L.flash;
    }
    if (!hit) return;
    let d: number;
    const p = L.position;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) d = Math.hypot(p.x - env.cameraPos.x, p.z - env.cameraPos.z);
    else d = 340 * new Rng(Math.floor(now * 100), 5).range(0.5, 4);
    this.strike(d, now);
  }

  tick(s: Scene, env: AudioEnv) {
    if (env.lightning) return;
    // 自前の雷（嵐のとき）
    if (s.storm > 0.35) {
      if (this.nextAuto === Infinity) this.nextAuto = s.t + this.rng.range(2, 6);
      if (s.t >= this.nextAuto) {
        this.strike(this.rng.logRange(350, 6000), s.t);
        this.nextAuto = s.t + this.rng.range(7, 26) / Math.max(0.35, s.storm);
      }
    } else this.nextAuto = Infinity;
  }

  /** 距離 d[m] の落雷を now に発生させる（音は d/340 秒遅れて届く） */
  strike(d: number, now: number) {
    const ctx = this.ctx, res = this.res;
    const seed = 700 + this.strikes++;
    const r = new Rng(seed, 44);
    const delay = d / 340 + r.range(0, 0.12);
    const t0 = now + 0.05 + delay;
    const bright = Math.exp(-d / 1000);
    const loud = 1 / Math.pow(1 + d / 700, 1.1);
    this.lastStrike = { at: t0, distance: d, delay };

    const g = gainNode(ctx, loud);
    g.connect(this.dry);
    const send = gainNode(ctx, 0.35 + 0.55 * (1 - bright));
    g.connect(send);
    send.connect(this.wet);

    // crack（近い雷ほど鋭く大きい。胴体より先に来る）
    if (d < 2000) {
      const n = oneShot(ctx, res.noiseShort, t0, 0.4, r.range(0, 1.5));
      const hp = biquad(ctx, "highpass", 1500 + 4000 * bright, 0.7);
      const gc = gainNode(ctx, 0);
      n.connect(hp);
      hp.connect(gc);
      gc.connect(g);
      const end = attackDecay(gc.gain, t0, 1.0 * Math.pow(bright, 1.2), 0.004, 0.08 + 0.12 * bright);
      n.stop(end + 0.1);
    }
    // tear
    {
      const n = oneShot(ctx, res.noiseShort, t0 + 0.01, 1.5, r.range(0, 0.5));
      const bp = biquad(ctx, "bandpass", 300 + 900 * bright, 1.2);
      const gt = gainNode(ctx, 0);
      n.connect(bp);
      bp.connect(gt);
      gt.connect(g);
      const end = attackDecay(gt.gain, t0 + 0.01, 0.6 * bright + 0.1, 0.01, 0.3 + 0.4 * (1 - bright));
      n.stop(end + 0.1);
    }
    // body（転がる）
    {
      const D = 3.5 + 5 * (1 - bright) + r.range(0, 2);
      const tb = t0 + 0.02 + (1 - bright) * 0.3;
      const n = oneShot(ctx, res.noiseL, tb, D + 0.5, r.range(0, 4));
      const lp = biquad(ctx, "lowpass", 400 + 1600 * bright, 0.9);
      lp.frequency.setValueAtTime(400 + 1600 * bright, tb);
      lp.frequency.exponentialRampToValueAtTime(70, tb + D * 0.8);
      const gb = gainNode(ctx, 0);
      n.connect(lp);
      lp.connect(gb);
      gb.connect(g);
      const curve = thunderCurve(256, seed, bright);
      gb.gain.setValueAtTime(0, tb);
      gb.gain.setValueCurveAtTime(curve, tb + 0.001, D);
      n.stop(tb + D + 0.3);
      // もう一段低い胴体（ゆっくり）
      const n2 = oneShot(ctx, res.pink, tb + 0.1, D + 0.5, r.range(0, 2));
      const lp2 = biquad(ctx, "lowpass", 120, 1.1);
      const gb2 = gainNode(ctx, 0);
      n2.connect(lp2);
      lp2.connect(gb2);
      gb2.connect(g);
      gb2.gain.setValueAtTime(0, tb + 0.1);
      gb2.gain.setValueCurveAtTime(thunderCurve(128, seed + 1, bright * 0.5), tb + 0.101, D * 1.15);
      n2.stop(tb + D * 1.15 + 0.4);
    }
    // sub（バリッの少し後に胸に来る）
    {
      const ts = t0 + 0.06 + 0.1 * (1 - bright);
      const o = ctx.createOscillator();
      o.type = "sine";
      const f0 = r.range(42, 55);
      o.frequency.setValueAtTime(f0, ts);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.7, ts + 2.2);
      const gs = gainNode(ctx, 0);
      o.connect(gs);
      gs.connect(g);
      const end = attackDecay(gs.gain, ts, 0.5 * (0.5 + 0.5 * bright), 0.05 + 0.2 * (1 - bright), 1.2 + 1.5 * (1 - bright));
      o.start(ts);
      o.stop(end + 0.2);
    }
  }
}
