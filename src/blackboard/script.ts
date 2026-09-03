// 黒板に書く順番（地形 → 空 → 水 → 木 → 音）。
// 全部を書くと長いので、いちばん効く段だけを選ぶ。**失敗した式を必ず混ぜる。**
import { formulaById, type Node } from "@/data/formulas";

export type Cue =
  | { k: "head"; text: string; latin: string }
  | { k: "line"; nodes: Node[]; note?: string; failed?: boolean; src?: string };

/** 式 id と段の番号から1行つくる */
function step(id: string, i: number, withSrc = false): Cue | null {
  const f = formulaById(id);
  const s = f?.steps?.[i];
  if (!f || !s) return null;
  return { k: "line", nodes: s.body, note: s.note, failed: s.failed, src: withSrc ? f.src : undefined };
}
/** その式の「最初の失敗」を1行（段の番号を数えなくていいように） */
function failedStep(id: string, withSrc = false): Cue | null {
  const f = formulaById(id);
  const i = f?.steps?.findIndex((s) => s.failed) ?? -1;
  return i >= 0 ? step(id, i, withSrc) : null;
}
function body(id: string, note?: string): Cue | null {
  const f = formulaById(id);
  if (!f) return null;
  return { k: "line", nodes: f.body, note, src: f.src };
}

/**
 * @param n 何行まで書くか（携帯は少なく）
 */
export function boardScript(n: number): Cue[] {
  const all: (Cue | null)[] = [
    // 5 つの分野を必ず一巡させる（地形 → 空 → 水 → 木 → 音）。各分野に「失敗」を1つ必ず入れる
    { k: "head", text: "地形", latin: "TERRAIN" },
    failedStep("terrain.h"), // 失敗: ノイズを重ねただけ → 団子
    body("terrain.h", "この 3 つの和が、世界でただ一つの高さ"),

    { k: "head", text: "空", latin: "SKY" },
    failedStep("sky.scatter"), // 失敗: ミーが弱くて夕焼けが白い
    step("sky.scatter", 3), // 直し（橙が出た）

    { k: "head", text: "水", latin: "WATER" },
    failedStep("water.surface"), // 失敗: 負の数の累乗で NaN

    { k: "head", text: "木と草", latin: "FLORA" },
    failedStep("veg.grass"), // 失敗: 葉幅 3.4cm の藁色

    { k: "head", text: "音", latin: "SOUND" },
    body("audio.bird", "ウグイスの声も、周波数の動きを書いただけ"),

    // ここから先は画面が広いときだけ
    step("water.wave", 3), // 分散関係
    step("veg.grass", 1), // 直し（葉幅）
    { k: "head", text: "共通", latin: "CORE" },
    failedStep("core.pi"), // 失敗: PI の二重宣言
    step("core.noise", 2), // fbm の和
    step("terrain.h", 1), // 尾根ノイズ
    body("audio.rain", "雨は一粒ずつのインパルス列。音の素材ゼロ"),
    step("veg.tree", 0), // 黄金角の螺旋
  ];


  return all.filter((c): c is Cue => !!c).slice(0, n);
}
