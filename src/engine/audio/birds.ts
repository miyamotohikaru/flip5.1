// 鳥。昼（夜明けの合唱が一番にぎやか）に、離れた方向から時々鳴く。
// 6 つの「席」に種と位置を割り当て（場所の生態で種が変わる）、距離で減衰・空気で丸く・残響に送る。
// 鳴き方そのものは birdsong.ts（純粋関数）。ここは AudioNode に流し込むだけ。
import { heightAt } from "../core/heightfield";
import { birdCall, speciesFor, type Call, type Note, type Species } from "./birdsong";
import { smooth } from "./dsp";
import { biquad, gainNode, oneShot, spatialChain, spatialize, type Ctx } from "./graph";
import { Rng } from "./rng";
import type { Resources } from "./resources";
import type { Scene } from "./types";

type Slot = { x: number; z: number; species: Species; until: number };

export class BirdLayer {
  out: GainNode;
  private reverb: ConvolverNode;
  private slots: (Slot | null)[] = [null, null, null, null, null, null];
  private nextCall = 0;
  private rng = new Rng(777);
  /** 鳴き声の音符はまとめて作らず、鳴る直前の tick で少しずつ作る（メインスレッドの山を作らない） */
  private queue: { n: Note; t0: number; dest: GainNode; r: Rng }[] = [];
  calls = 0;
  /** 検証用: 最後に鳴いた鳥 */
  lastCall: { species: Species; at: number; dist: number } | null = null;

  constructor(private ctx: Ctx, dest: AudioNode, private res: Resources) {
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = res.irForest;
    this.reverb.normalize = true;
    const rg = gainNode(ctx, 0.55);
    this.reverb.connect(rg);
    rg.connect(this.out);
  }

  /** どれくらい鳴くか 0..1（時刻・天気・場所） */
  activity(s: Scene): number {
    const h = s.hour;
    const dawn = smooth(4.4, 5.6, h) * (1 - smooth(8.5, 10.5, h));
    const mid = smooth(6, 8, h) * (1 - smooth(16.5, 18.6, h)) * 0.5;
    const eve = smooth(15.5, 17, h) * (1 - smooth(18.2, 19.2, h)) * 0.45;
    let a = Math.min(1, dawn + mid + eve);
    a *= (1 - 0.95 * s.rain) * (1 - s.storm) * (1 - 0.6 * smooth(0.45, 0.9, s.wind));
    a *= 0.35 + 0.65 * Math.min(1, s.grass + s.forest + 0.4 * s.rock);
    return a;
  }

  tick(s: Scene) {
    const t = s.t;
    if (this.queue.length) {
      // 0.35 秒以内に鳴る音符だけ組む
      const keep: typeof this.queue = [];
      for (const q of this.queue) {
        if (q.t0 + q.n.t < t + 0.35) this.note(q.n, q.t0, q.dest, q.r);
        else keep.push(q);
      }
      this.queue = keep;
    }
    if (t < this.nextCall) return;
    const act = this.activity(s);
    if (act < 0.02) {
      this.nextCall = t + 1.5;
      return;
    }
    const idx = this.rng.int(this.slots.length);
    let slot = this.slots[idx];
    if (!slot || t > slot.until || Math.hypot(slot.x - s.pos.x, slot.z - s.pos.z) > 220) slot = this.slots[idx] = this.spawn(s);
    this.play(birdCall(slot.species, new Rng(100 + this.calls++, idx)), slot, s, t + 0.08);
    // 活発なら 2〜4 秒おき、静かなら 30 秒に一度くらい
    this.nextCall = t + (2.2 + 9 * (1 - act) + 22 * Math.pow(1 - act, 4)) * this.rng.range(0.55, 1.6);
    // 夜明けの合唱: もう一羽が重なる
    if (act > 0.7 && this.rng.chance(0.5)) {
      const j = (idx + 1 + this.rng.int(5)) % this.slots.length;
      let s2 = this.slots[j];
      if (!s2 || t > s2.until) s2 = this.slots[j] = this.spawn(s);
      this.play(birdCall(s2.species, new Rng(100 + this.calls++, j)), s2, s, t + this.rng.range(0.6, 2));
    }
  }

  private spawn(s: Scene): Slot {
    const r = this.rng;
    const ang = r.range(0, Math.PI * 2);
    const dist = r.logRange(12, 110);
    const x = s.pos.x + Math.cos(ang) * dist, z = s.pos.z + Math.sin(ang) * dist;
    const h = heightAt(x, z);
    const grass = smooth(-1.5, 1.5, h) * (1 - smooth(70, 180, h));
    const forest = smooth(9, 45, h) * (1 - smooth(300, 430, h));
    const rock = smooth(260, 420, h);
    return { x, z, species: speciesFor({ grass, forest, rock, hour: s.hour }, r), until: s.t + r.range(45, 90) };
  }

  private play(call: Call, slot: Slot, s: Scene, t0: number) {
    const sp = spatialize(slot.x, slot.z, s, 30, 1.3);
    const chain = spatialChain(this.ctx, this.out, this.reverb);
    const base = call.species === "kite" ? 0.9 : call.species === "crow" ? 0.8 : call.species === "dove" ? 0.6 : 0.7;
    chain.apply(sp, base, Math.max(this.ctx.currentTime, t0 - 0.05));
    this.lastCall = { species: call.species, at: t0, dist: sp.dist };
    const r = new Rng(900 + this.calls, 3);
    for (const n of call.notes) {
      if (n.t < 0.35) this.note(n, t0, chain.input, r);
      else this.queue.push({ n, t0, dest: chain.input, r });
    }
  }

  private note(n: Note, t0: number, dest: AudioNode, r: Rng) {
    const ctx = this.ctx, res = this.res;
    const t = t0 + n.t, end = t + n.dur, att = n.attack ?? 0.008, rel = n.release ?? 0.03;
    const g = gainNode(ctx, 0);
    g.connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(n.amp, t + att);
    const relStart = Math.max(t + att, end - rel * 0.5);
    g.gain.setValueAtTime(n.amp, relStart);
    g.gain.linearRampToValueAtTime(0, end + rel);
    const stopAt = end + rel + 0.02;
    if (n.wave === "knock") {
      const ns = oneShot(ctx, res.noiseShort, t, n.dur + rel, r.range(0, 1.8));
      const bp = biquad(ctx, "bandpass", n.f0, 2.5);
      ns.connect(bp);
      bp.connect(g);
      ns.stop(stopAt + 0.05);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(320, t);
      o.frequency.exponentialRampToValueAtTime(180, end);
      const og = gainNode(ctx, 0.5);
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(stopAt);
      return;
    }
    const o = ctx.createOscillator();
    if (n.wave === "sine") o.type = "sine";
    else if (n.wave === "soft") o.setPeriodicWave(res.waveSoft);
    else o.type = "sawtooth";
    o.frequency.setValueAtTime(n.f0, t);
    if (n.fm) o.frequency.exponentialRampToValueAtTime(n.fm, t + n.dur * 0.5);
    o.frequency.exponentialRampToValueAtTime(n.f1, end);
    if (n.vib) {
      const l = ctx.createOscillator();
      l.frequency.value = n.vib.rate;
      const lg = gainNode(ctx, n.vib.depth);
      l.connect(lg);
      lg.connect(o.frequency);
      l.start(t);
      l.stop(stopAt);
    }
    if (n.wave === "buzz") {
      const f1 = biquad(ctx, "bandpass", 1300, 2.2);
      const f2 = biquad(ctx, "bandpass", 2400, 3);
      const m2 = gainNode(ctx, 0.5);
      o.connect(f1);
      f1.connect(g);
      o.connect(f2);
      f2.connect(m2);
      m2.connect(g);
    } else o.connect(g);
    o.start(t);
    o.stop(stopAt);
    if (n.noise) {
      const ns = oneShot(ctx, res.noiseShort, t, n.dur + rel, r.range(0, 1.8));
      const bp = biquad(ctx, "bandpass", (n.f0 + n.f1) * 0.5, 4);
      const ng = gainNode(ctx, n.noise * 0.6);
      ns.connect(bp);
      bp.connect(ng);
      ng.connect(g);
      ns.stop(stopAt + 0.05);
    }
  }
}
