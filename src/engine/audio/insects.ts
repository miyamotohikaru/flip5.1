// 夜の生き物。コオロギ・スズムシ（高い正弦波を dsp.cricketPattern の包絡で鳴らす。個体ごとにテンポが違う）と、
// 岸辺のカエル（のこぎり波にフォルマント）。
// 虫はプレイヤーの周りに配置し、向きが変わればパンが変わる。草地で多く、雨・嵐・強風で静かになる。
import { smooth } from "./dsp";
import { attackDecay, biquad, control, gainNode, lfo, loop, setT, spatialChain, spatialize, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";
import type { Scene } from "./types";

type Bug = {
  kind: "cricket" | "bell";
  ang: number;
  dist: number;
  base: number;
  input: GainNode;
  pan: StereoPannerNode;
  lp: BiquadFilterNode;
};

export class InsectLayer {
  out: GainNode;
  private bugs: Bug[] = [];
  private nextFrog = 0;
  private rng = new Rng(3131);
  frogs = 0;
  private lastYaw = 999;
  private lastPos = { x: 1e9, z: 1e9 };
  private lastLevel = -1;
  /** 検証用 */
  level = 0;

  constructor(private ctx: Ctx, dest: AudioNode, private res: Resources, count: number) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    const now = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const r = new Rng(2000 + i);
      const kind: Bug["kind"] = i % 5 === 2 || i % 5 === 4 ? "bell" : "cricket";
      const f = kind === "cricket" ? r.range(4100, 4900) : r.range(4300, 4700);
      const am = gainNode(ctx, 0);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(am);
      const o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.value = f * 2;
      const h2 = gainNode(ctx, kind === "cricket" ? 0.12 : 0.05);
      o2.connect(h2);
      h2.connect(am);
      o.start(now);
      o2.start(now);
      // 音程がほんの少し（±0.8%）ゆっくり揺れる（ずっと同じ高さの電子音にしない）
      lfo(ctx, r.range(0.05, 0.16), f * 0.008, o.frequency, now);
      if (kind === "bell") {
        // 空気っぽさ: 搬送波の周りの細い雑音
        const n = loop(ctx, res.noiseR, { offset: i * 0.7 });
        const bp = biquad(ctx, "bandpass", f, 30);
        const ng = gainNode(ctx, 0.08);
        n.connect(bp);
        bp.connect(ng);
        ng.connect(am);
      }
      const pats = kind === "cricket" ? res.cricketPatterns : res.bellPatterns;
      control(ctx, pats[i % pats.length], am.gain, 1, r.range(0.92, 1.08), r.range(0, 6));
      const chain = spatialChain(ctx, this.out);
      am.connect(chain.input);
      this.bugs.push({ kind, ang: r.range(0, Math.PI * 2), dist: r.logRange(3, 30), base: kind === "cricket" ? 0.5 : 0.35, input: chain.input, pan: chain.pan, lp: chain.lp });
    }
  }

  tick(s: Scene) {
    const t = s.t;
    const quiet = (1 - 0.85 * s.rain) * (1 - s.storm) * (1 - 0.6 * smooth(0.4, 0.85, s.wind));
    const habitat = Math.min(1, 0.15 + 0.85 * s.grass + 0.4 * s.forest) * (1 - smooth(120, 260, s.altitude));
    const level = s.night * quiet * habitat;
    this.level = level;
    const yaw = Math.atan2(s.fwd.x, s.fwd.z);
    const moved = Math.hypot(s.pos.x - this.lastPos.x, s.pos.z - this.lastPos.z) > 0.5 || Math.abs(yaw - this.lastYaw) > 0.03;
    const changed = Math.abs(level - this.lastLevel) > 0.01;
    if (moved || changed) {
      this.lastYaw = yaw;
      this.lastPos = { x: s.pos.x, z: s.pos.z };
      this.lastLevel = level;
      for (const b of this.bugs) {
        const sx = s.pos.x + Math.cos(b.ang) * b.dist, sz = s.pos.z + Math.sin(b.ang) * b.dist;
        const sp = spatialize(sx, sz, s, 6, 1.2);
        setT(b.input.gain, level * b.base * sp.gain, t, 0.5);
        if (moved) {
          setT(b.pan.pan, sp.pan, t, 0.2);
          setT(b.lp.frequency, sp.lp, t, 0.5);
        }
      }
    }
    // カエル
    const frogLevel = s.night * s.shoreFactor * (0.35 + 0.65 * s.wetness) * (1 - s.storm) * (1 - 0.5 * s.rain);
    if (frogLevel > 0.04 && t >= this.nextFrog) {
      this.frog(t + 0.05, s, frogLevel);
      this.nextFrog = t + this.rng.range(2.5, 9) / (0.3 + frogLevel);
    }
  }

  private frog(t: number, s: Scene, level: number) {
    const ctx = this.ctx;
    const r = new Rng(6000 + this.frogs++);
    const callers = 1 + r.int(3);
    const toLake = Math.atan2(-s.pos.z, -s.pos.x);
    for (let c = 0; c < callers; c++) {
      const ang = toLake + r.range(-1.1, 1.1);
      const dist = r.range(8, 45);
      const sp = spatialize(s.pos.x + Math.cos(ang) * dist, s.pos.z + Math.sin(ang) * dist, s, 10, 1.3);
      const chain = spatialChain(ctx, this.out);
      const tc = t + c * r.range(0.35, 1.2);
      chain.apply(sp, level * 0.55, Math.max(ctx.currentTime, tc - 0.02));
      const notes = 3 + r.int(5);
      const f = r.range(380, 520);
      const f1 = biquad(ctx, "bandpass", r.range(800, 1000), 2);
      const f2 = biquad(ctx, "bandpass", r.range(1900, 2300), 2.5);
      const m2 = gainNode(ctx, 0.5);
      const lp = biquad(ctx, "lowpass", 3500, 0.7);
      f1.connect(lp);
      f2.connect(m2);
      m2.connect(lp);
      lp.connect(chain.input);
      let tk = tc;
      for (let k = 0; k < notes; k++) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(f * r.logRange(0.97, 1.03), tk);
        o.frequency.exponentialRampToValueAtTime(f * 0.85, tk + 0.07);
        const og = gainNode(ctx, 0);
        o.connect(og);
        og.connect(f1);
        og.connect(f2);
        const end = attackDecay(og.gain, tk, 0.6, 0.006, r.range(0.05, 0.08));
        lfo(ctx, r.range(35, 45), 0.3, og.gain, tk, end + 0.02);
        o.start(tk);
        o.stop(end + 0.02);
        tk += r.range(0.09, 0.13);
      }
    }
  }
}
