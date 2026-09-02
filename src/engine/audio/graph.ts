// WebAudio のノードを組むための小道具。各層はこれだけで配線する。
import type { F32 } from "./dsp";
import type { Scene } from "./types";

export type Ctx = BaseAudioContext;

export const dB = (v: number) => Math.pow(10, v / 20);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function makeBuffer(ctx: Ctx, chans: F32[], sampleRate = ctx.sampleRate): AudioBuffer {
  const b = ctx.createBuffer(chans.length, chans[0].length, sampleRate);
  chans.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

/** ループ再生のソース（すぐ始める） */
export function loop(ctx: Ctx, buffer: AudioBuffer, opts: { rate?: number; offset?: number; when?: number } = {}): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = opts.rate ?? 1;
  s.start(opts.when ?? ctx.currentTime, (opts.offset ?? 0) % buffer.duration);
  return s;
}

/** 一回だけ鳴らすソース */
export function oneShot(ctx: Ctx, buffer: AudioBuffer, when: number, dur?: number, offset = 0, rate = 1): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = rate;
  const off = offset % Math.max(1e-3, buffer.duration - (dur ?? 0));
  if (dur !== undefined) s.start(when, Math.max(0, off), dur);
  else s.start(when, Math.max(0, off));
  return s;
}

export function biquad(ctx: Ctx, type: BiquadFilterType, frequency: number, Q = 0.707, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gainDb;
  return f;
}

export function gainNode(ctx: Ctx, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/**
 * 制御信号（0..1 のループバッファ）を AudioParam に足す。
 * param の値は「基準」、これに depth × 信号 が加わる。戻り値の gain を変えれば深さを変えられる。
 */
export function control(ctx: Ctx, buffer: AudioBuffer, param: AudioParam, depth: number, rate = 1, offset = 0): { depth: GainNode; src: AudioBufferSourceNode } {
  const src = loop(ctx, buffer, { rate, offset });
  const g = gainNode(ctx, depth);
  src.connect(g);
  g.connect(param);
  return { depth: g, src };
}

/** setTargetAtTime の薄い包み（NaN 防止・負値防止） */
export function setT(param: AudioParam, value: number, t: number, tc: number): void {
  if (!Number.isFinite(value)) return;
  param.setTargetAtTime(Math.max(0, value), t, tc);
}

/** 立ち上がり→減衰の包絡。戻り値は「止めてよい時刻」 */
export function attackDecay(param: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, decay / 4);
  return t + attack + decay * 1.6;
}

export function lfo(ctx: Ctx, rate: number, depth: number, param: AudioParam, when: number, stop?: number, type: OscillatorType = "sine"): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = rate;
  const g = gainNode(ctx, depth);
  o.connect(g);
  g.connect(param);
  o.start(when);
  if (stop !== undefined) o.stop(stop);
  return o;
}

export function periodic(ctx: Ctx, harmonics: number[]): PeriodicWave {
  const real = new Float32Array(harmonics.length + 1);
  const imag = new Float32Array(harmonics.length + 1);
  for (let i = 0; i < harmonics.length; i++) imag[i + 1] = harmonics[i];
  return ctx.createPeriodicWave(real, imag);
}

export type Spatial = { pan: number; dist: number; gain: number; lp: number; front: number; send: number };

/** 音源のワールド座標 → 聞き手から見た pan・距離減衰・空気吸収 */
export function spatialize(sx: number, sz: number, s: Scene, refDist = 25, rolloff = 1.35): Spatial {
  const dx = sx - s.pos.x, dz = sz - s.pos.z;
  const dist = Math.max(1, Math.hypot(dx, dz));
  const nx = dx / dist, nz = dz / dist;
  const front = nx * s.fwd.x + nz * s.fwd.z;
  const pan = clamp((nx * s.right.x + nz * s.right.z) * 0.85, -1, 1);
  let gain = 1 / Math.pow(1 + dist / refDist, rolloff);
  if (front < 0) gain *= 0.85 + 0.15 * (1 + front);
  const lp = 1500 + 13000 * Math.exp(-dist / 220);
  const send = 0.12 + 0.55 * clamp((dist - 8) / 110, 0, 1);
  return { pan, dist, gain, lp, front, send };
}

/** 聞こえる方向のチェーン: gain → LP → panner → dest（＋残響送り） */
export function spatialChain(ctx: Ctx, dest: AudioNode, reverb?: AudioNode): { input: GainNode; lp: BiquadFilterNode; pan: StereoPannerNode; send: GainNode | null; apply: (sp: Spatial, amp: number, t: number) => void } {
  const input = gainNode(ctx, 0);
  const lp = biquad(ctx, "lowpass", 12000, 0.5);
  const pan = ctx.createStereoPanner();
  input.connect(lp);
  lp.connect(pan);
  pan.connect(dest);
  let send: GainNode | null = null;
  if (reverb) {
    send = gainNode(ctx, 0);
    lp.connect(send);
    send.connect(reverb);
  }
  const apply = (sp: Spatial, amp: number, t: number) => {
    input.gain.setValueAtTime(sp.gain * amp, t);
    lp.frequency.setValueAtTime(sp.lp, t);
    pan.pan.setValueAtTime(sp.pan, t);
    if (send) send.gain.setValueAtTime(sp.send, t);
  };
  return { input, lp, pan, send, apply };
}
