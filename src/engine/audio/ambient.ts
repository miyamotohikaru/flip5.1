// 環境の音楽。ごく薄い持続音（パッド）。時刻で和音が変わる。目立たない（環境音の 1/4 程度）。
//   夜明け … 澄んだ長調寄り（D A E F#）
//   昼     … 開いた五度（A E B E）
//   夕方   … 温かい（F C A E ＝ Fmaj7）
//   夜     … 低く静か（D A F C ＝ Dm7）
import { biquad, gainNode, lfo, setT, type Ctx } from "./graph";
import type { Resources } from "./resources";
import type { Scene } from "./types";

type Zone = "dawn" | "day" | "evening" | "night";
const CHORDS: Record<Zone, number[]> = {
  dawn: [146.83, 220, 329.63, 369.99],
  day: [110, 164.81, 246.94, 329.63],
  evening: [87.31, 130.81, 220, 329.63],
  night: [73.42, 110, 174.61, 261.63],
};

export class PadLayer {
  out: GainNode;
  private voices: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode }[] = [];
  private lp: BiquadFilterNode;
  private level: GainNode;
  zone: Zone | "" = "";

  constructor(ctx: Ctx, dest: AudioNode, res: Resources) {
    void res;
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    this.level = gainNode(ctx, 1);
    this.lp = biquad(ctx, "lowpass", 700, 0.5);
    this.lp.connect(this.level);
    this.level.connect(this.out);
    const now = ctx.currentTime;
    const chord = CHORDS.evening;
    for (let i = 0; i < 4; i++) {
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.value = chord[i];
      o1.detune.value = i % 2 ? 4 : -4;
      const o2 = ctx.createOscillator();
      o2.type = "triangle";
      o2.frequency.value = chord[i];
      o2.detune.value = i % 2 ? -3 : 5;
      const g2 = gainNode(ctx, 0.18);
      const g = gainNode(ctx, i === 3 ? 0.11 : 0.17);
      o1.connect(g);
      o2.connect(g2);
      g2.connect(g);
      g.connect(this.lp);
      lfo(ctx, 0.05 + 0.03 * i, 0.045, g.gain, now);
      o1.start(now);
      o2.start(now);
      this.voices.push({ o1, o2, g });
    }
    lfo(ctx, 0.017, 160, this.lp.frequency, now);
  }

  tick(s: Scene) {
    const h = s.hour;
    const zone: Zone = h >= 4 && h < 8 ? "dawn" : h >= 8 && h < 16 ? "day" : h >= 16 && h < 20 ? "evening" : "night";
    if (zone !== this.zone) {
      this.zone = zone;
      const chord = CHORDS[zone];
      for (let i = 0; i < 4; i++) {
        setT(this.voices[i].o1.frequency, chord[i], s.t, 3.0);
        setT(this.voices[i].o2.frequency, chord[i], s.t, 3.0);
      }
    }
    setT(this.level.gain, (1 - 0.5 * s.storm) * (0.75 + 0.25 * s.night), s.t, 1.0);
    setT(this.lp.frequency, 560 + 320 * s.day, s.t, 2.0);
  }
}
