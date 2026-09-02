// 鳥の鳴き方（純粋関数）。音符の列を返すだけで、AudioNode には触らない（Node で検証できる）。
// 種ごとに「周波数の動き」が違うのが本物らしさの芯。ピコピコにならないよう、
// 必ず滑らかなスイープ・ビブラート・息のノイズを持たせる。
import { Rng } from "./rng";

export type Wave = "sine" | "soft" | "buzz" | "knock";

export type Note = {
  /** 鳴き始めからの秒 */
  t: number;
  dur: number;
  f0: number;
  f1: number;
  /** 途中（50%）の周波数。あれば曲線的なスライドになる */
  fm?: number;
  amp: number;
  wave: Wave;
  vib?: { rate: number; depth: number };
  /** 息のノイズの量 0..1 */
  noise?: number;
  attack?: number;
  release?: number;
};

export type Species = "uguisu" | "thrush" | "tit" | "woodpecker" | "kite" | "dove" | "crow" | "owl";
export const SPECIES: readonly Species[] = ["uguisu", "thrush", "tit", "woodpecker", "kite", "dove", "crow", "owl"];

export type Call = { species: Species; notes: Note[]; duration: number };

function finish(species: Species, notes: Note[]): Call {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.t + n.dur + (n.release ?? 0.03));
  return { species, notes, duration: end };
}

/** ウグイス「ホーホケキョ」（谷渡り「ケキョケキョ」の変奏あり） */
function uguisu(r: Rng): Call {
  const notes: Note[] = [];
  if (r.chance(0.25)) {
    // 谷渡り
    const reps = 3 + r.int(4);
    let t = 0;
    for (let i = 0; i < reps; i++) {
      notes.push({ t, dur: r.range(0.05, 0.07), f0: r.range(2700, 2900), f1: r.range(3300, 3600), amp: 0.9, wave: "sine", attack: 0.004, release: 0.015 });
      notes.push({ t: t + 0.075, dur: r.range(0.08, 0.11), f0: r.range(3300, 3600), f1: r.range(2300, 2600), fm: 3100, amp: 0.85, wave: "sine", attack: 0.004, release: 0.03 });
      t += r.range(0.2, 0.26);
    }
    return finish("uguisu", notes);
  }
  const base = r.range(1350, 1550);
  const d0 = r.range(0.45, 0.7);
  notes.push({ t: 0, dur: d0, f0: base, f1: base * 1.06, amp: 0.55, wave: "sine", vib: { rate: r.range(12, 18), depth: r.range(8, 20) }, attack: 0.14, release: 0.05 });
  const t1 = d0 + r.range(0.03, 0.07);
  notes.push({ t: t1, dur: r.range(0.07, 0.1), f0: r.range(2100, 2400), f1: r.range(3400, 3900), amp: 1, wave: "sine", attack: 0.006, release: 0.02 });
  notes.push({ t: t1 + 0.1, dur: r.range(0.1, 0.14), f0: r.range(3300, 3700), f1: r.range(2300, 2700), fm: r.range(3000, 3400), amp: 0.9, wave: "sine", attack: 0.005, release: 0.04 });
  return finish("uguisu", notes);
}

/** クロツグミ風: 笛のような 3〜5 音の句。1〜2 回くり返す */
function thrush(r: Rng): Call {
  const notes: Note[] = [];
  const phrase: Omit<Note, "t">[] = [];
  const count = 3 + r.int(3);
  for (let i = 0; i < count; i++) {
    const f0 = r.logRange(1800, 3400);
    phrase.push({
      dur: r.range(0.12, 0.24),
      f0,
      f1: f0 * r.logRange(0.78, 1.28),
      fm: r.chance(0.5) ? f0 * r.logRange(0.9, 1.15) : undefined,
      amp: r.range(0.6, 1),
      wave: "soft",
      vib: r.chance(0.4) ? { rate: r.range(20, 35), depth: f0 * 0.012 } : undefined,
      noise: 0.06,
      attack: 0.012,
      release: 0.04,
    });
  }
  const reps = r.chance(0.5) ? 2 : 1;
  let t = 0;
  for (let k = 0; k < reps; k++) {
    for (const p of phrase) {
      notes.push({ t, ...p });
      t += p.dur + r.range(0.05, 0.12);
    }
    t += r.range(0.5, 0.8);
  }
  return finish("thrush", notes);
}

/** シジュウカラ「ツピツピ」 */
function tit(r: Rng): Call {
  const notes: Note[] = [];
  const reps = 3 + r.int(4);
  const period = r.range(0.16, 0.22);
  const hi = r.range(6500, 7500);
  const lo = r.range(4100, 4500);
  for (let i = 0; i < reps; i++) {
    const t = i * period;
    notes.push({ t, dur: 0.028, f0: hi, f1: hi * 0.88, amp: 0.7, wave: "sine", noise: 0.35, attack: 0.003, release: 0.008 });
    notes.push({ t: t + 0.05, dur: r.range(0.06, 0.08), f0: lo, f1: lo * 1.09, amp: 0.85, wave: "sine", attack: 0.005, release: 0.015 });
  }
  return finish("tit", notes);
}

/** キツツキのドラミング: 12〜18 打、だんだん弱く */
function woodpecker(r: Rng): Call {
  const notes: Note[] = [];
  const count = 12 + r.int(7);
  const rate = r.range(15, 19);
  let t = 0;
  for (let i = 0; i < count; i++) {
    const a = 1 - 0.55 * (i / count);
    notes.push({ t, dur: 0.011, f0: r.range(1800, 2200), f1: 1500, amp: a, wave: "knock", noise: 1, attack: 0.001, release: 0.006 });
    t += 1 / rate + i * 0.0006;
  }
  return finish("woodpecker", notes);
}

/** トビ「ピーヒョロロ」 */
function kite(r: Rng): Call {
  const d0 = r.range(0.42, 0.5);
  const notes: Note[] = [
    { t: 0, dur: d0, f0: r.range(2500, 2800), f1: r.range(2100, 2300), amp: 0.9, wave: "sine", noise: 0.12, attack: 0.03, release: 0.05 },
    { t: d0 + 0.02, dur: r.range(0.55, 0.75), f0: 2200, f1: 1700, amp: 0.8, wave: "sine", vib: { rate: r.range(10, 13), depth: r.range(90, 140) }, noise: 0.1, attack: 0.02, release: 0.12 },
  ];
  return finish("kite", notes);
}

/** キジバト「デーデー・ポッポー」 */
function dove(r: Rng): Call {
  const base = r.range(0.92, 1.08);
  const pat: [number, number, number, number][] = [
    [560, 540, 0.15, 0],
    [640, 600, 0.14, 0.06],
    [470, 460, 0.24, 0.13],
    [470, 450, 0.26, 0.05],
  ];
  const notes: Note[] = [];
  let t = 0;
  for (const [f0, f1, d, gap] of pat) {
    t += gap;
    notes.push({ t, dur: d, f0: f0 * base, f1: f1 * base, amp: 0.5, wave: "soft", attack: 0.03, release: 0.05 });
    t += d;
  }
  return finish("dove", notes);
}

/** カラス「カア」 */
function crow(r: Rng): Call {
  const notes: Note[] = [];
  const reps = 1 + r.int(3);
  let t = 0;
  for (let i = 0; i < reps; i++) {
    const f0 = r.range(520, 620);
    const d = r.range(0.28, 0.36);
    notes.push({ t, dur: d, f0, f1: f0 * 0.75, fm: f0 * 1.05, amp: 0.9, wave: "buzz", noise: 0.4, attack: 0.02, release: 0.06 });
    t += d + r.range(0.3, 0.45);
  }
  return finish("crow", notes);
}

/** フクロウ「ホー…ホー」（夜の森。たまに「ゴロスケ・ホーホー」） */
function owl(r: Rng): Call {
  const base = r.range(0.9, 1.1);
  const notes: Note[] = [];
  let t = 0;
  if (r.chance(0.35)) {
    // ゴロスケ
    for (let i = 0; i < 3; i++) {
      notes.push({ t, dur: 0.11, f0: 420 * base, f1: 380 * base, amp: 0.45, wave: "soft", attack: 0.02, release: 0.05 });
      t += 0.16;
    }
    t += 0.15;
  }
  notes.push({ t, dur: r.range(0.32, 0.4), f0: 380 * base, f1: 355 * base, amp: 0.6, wave: "soft", attack: 0.06, release: 0.12 });
  t += r.range(0.55, 0.7);
  notes.push({ t, dur: r.range(0.45, 0.6), f0: 350 * base, f1: 320 * base, fm: 345 * base, amp: 0.55, wave: "soft", attack: 0.06, release: 0.16 });
  return finish("owl", notes);
}

export function birdCall(species: Species, r: Rng): Call {
  switch (species) {
    case "uguisu": return uguisu(r);
    case "thrush": return thrush(r);
    case "tit": return tit(r);
    case "woodpecker": return woodpecker(r);
    case "kite": return kite(r);
    case "dove": return dove(r);
    case "crow": return crow(r);
    case "owl": return owl(r);
  }
}

export type Biome = { grass: number; forest: number; rock: number; hour: number };

/** その場所・その時刻に居そうな種を重み付きで選ぶ */
export function speciesFor(b: Biome, r: Rng): Species {
  const h = b.hour;
  const dawn = h >= 4.5 && h < 8 ? 1 : 0;
  const dusk = h >= 16.5 && h < 19.5 ? 1 : 0;
  const weights = [
    1.2 * b.grass + 0.8 * b.forest + 0.5 * dawn, // uguisu
    1.5 * b.forest + 0.3 * b.grass, // thrush
    1.0 * b.forest + 0.7 * b.grass, // tit
    1.2 * b.forest, // woodpecker
    0.25 + 1.5 * b.rock, // kite
    0.6 * (b.grass + b.forest) * (0.3 + dusk + dawn), // dove
    0.35 * (b.grass + b.forest) * (0.4 + dusk), // crow
    0, // owl は夜だけ（BirdLayer が別に呼ぶ）
  ];
  return r.weighted(SPECIES, weights);
}
