// 黒板に書く順番（地形 → 空 → 水 → 木 → 音 → 共通）。
// 入口では「いちばん効く段」だけを速く書く。「ぜんぶ見る」では導出を全部並べる。
// **失敗した式（打ち消し線）を必ず混ぜる。**
import { AREA_LABEL, BOARD_ORDER, FORMULAS, formulaById, formulasOf, type Node } from "@/data/formulas";

export type Cue =
  | { k: "head"; text: string; latin: string }
  | { k: "line"; nodes: Node[]; note?: string; failed?: boolean; src?: string };

const LATIN: Record<string, string> = {
  terrain: "TERRAIN",
  sky: "SKY",
  water: "WATER",
  vegetation: "FLORA",
  weather: "WEATHER",
  audio: "SOUND",
  core: "CORE",
};

/** 式 id と段の番号から1行つくる */
function step(id: string, i: number, withSrc = false): Cue | null {
  const f = formulaById(id);
  const s = f?.steps?.[i];
  if (!f || !s) return null;
  return { k: "line", nodes: s.body, note: s.note, failed: s.failed, src: withSrc ? f.src : undefined };
}
/** その式の n 番目の失敗（段の番号を数えなくていいように） */
function failedStep(id: string, n = 0): Cue | null {
  const f = formulaById(id);
  const idx = (f?.steps ?? []).map((s, i) => (s.failed ? i : -1)).filter((i) => i >= 0);
  return idx.length > n ? step(id, idx[n]) : null;
}
/** 最後の失敗のすぐ次の段 ＝「直し」 */
function fixStep(id: string): Cue | null {
  const f = formulaById(id);
  const st = f?.steps ?? [];
  let last = -1;
  for (let i = 0; i < st.length; i++) if (st[i].failed) last = i;
  return last >= 0 && last + 1 < st.length ? step(id, last + 1) : null;
}
function body(id: string, note?: string): Cue | null {
  const f = formulaById(id);
  if (!f) return null;
  return { k: "line", nodes: f.body, note, src: f.src };
}
const head = (area: string): Cue => ({ k: "head", text: AREA_LABEL[area as keyof typeof AREA_LABEL], latin: LATIN[area] });

/**
 * 入口の黒板。**最初の 5 秒に「失敗 → 直し」が来る**ように、各分野は
 * 「失敗 → 直し（または結論）」の 2〜3 本だけにする。
 * @param n 何本まで（画面に入る数。足りないぶんは後ろから落ちる）
 */
export function boardScript(n: number): Cue[] {
  const all: (Cue | null)[] = [
    head("terrain"),
    failedStep("terrain.h"), // 失敗: ノイズを重ねただけ → 団子
    body("terrain.h", "この 3 つの和が、世界でただ一つの高さ"),

    head("sky"),
    failedStep("sky.scatter", 0), // 失敗1: ミーが弱くて夕焼けが白い
    failedStep("sky.scatter", 1), // 失敗2: ミーを上げても白いまま
    fixStep("sky.scatter"), // 直し: 吸収を分けたら橙になった

    head("water"),
    failedStep("water.surface"), // 失敗: 負の数の累乗で NaN
    fixStep("water.surface"), // 直し: clamp してから累乗

    head("vegetation"),
    failedStep("veg.grass"), // 失敗: 葉幅 3.4cm の藁色
    fixStep("veg.grass"), // 直し

    head("audio"),
    body("audio.bird", "ウグイスの声も、周波数の動きを書いただけ"),

    // ここから先は画面に余りがあるときだけ（5 分野は必ず入る）
    head("core"),
    failedStep("core.pi"), // 失敗: PI の二重宣言
    step("core.noise", 2), // fbm の和
    step("water.wave", 3), // 分散関係
    step("terrain.h", 1), // 尾根ノイズ
    step("veg.tree", 0), // 黄金角の螺旋
    body("audio.rain", "雨は一粒ずつのインパルス列。音の素材ゼロ"),
  ];
  return all.filter((c): c is Cue => !!c).slice(0, n);
}

/**
 * 「黒板をぜんぶ見る」。分野ごとに、式の結論とその導出を全部並べる。
 * 書き取りはしない（もう書き終わった黒板を読む）。
 */
export function boardScriptFull(): Cue[] {
  const out: Cue[] = [];
  for (const area of BOARD_ORDER) {
    const fs = formulasOf(area);
    if (!fs.length) continue;
    out.push(head(area));
    for (const f of fs) {
      const b = body(f.id);
      if (b) out.push(b);
      (f.steps ?? []).forEach((s, i) => {
        const c = step(f.id, i);
        if (c) out.push(c);
      });
    }
  }
  return out;
}

/** 数えるだけ（About や締めの「思考量」の表示に使える） */
export const boardCounts = () => ({
  formulas: FORMULAS.length,
  steps: FORMULAS.reduce((a, f) => a + (f.steps?.length ?? 0), 0),
  failed: FORMULAS.reduce((a, f) => a + (f.steps ?? []).filter((s) => s.failed).length, 0),
});
