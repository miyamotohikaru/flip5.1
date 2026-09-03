// URL パラメータと「定点撮影」の定義。
//   ?auto=1        … 入口を飛ばして即入場（撮影用）
//   ?nohud=1       … HUD を消す
//   ?freeze=1      … 時間を止める（決定的なフレーム）
//   ?t=17.5        … 時刻
//   ?w=storm       … 天気プリセット
//   ?pos=x,y,z     … カメラ位置（y は省略可: 地面＋目線）
//   ?look=yaw,pitch… 向き（度）
//   ?flip=1        … 裏返し（0/1、または半径 m を flipr で）
//   ?flipr=300     … 裏返しの波の半径（m）
//   ?q=high        … 品質段階
//   ?shot=<name>   … 下の SHOTS に定義した定点
//   ?seed=12345    … 世界のシード（core/seed.ts。ここが読む前に seed.ts が location から読んでいる）
//   ?p=terrain.amp:1.4,sky.mie:2 … 実験室のつまみ（engine/lab/params.ts）
//   ?lab=1         … 実験室を開いた状態で始める
import type { WeatherPresetName, QualityTier } from "./env";
import { startPosition } from "./heightfield";

export type ShotDef = {
  name: string;
  /** 説明（日本語）。批評ログにも出る */
  desc: string;
  hour: number;
  weather: WeatherPresetName;
  /** x, z（y は地面＋目線）。y を明示するときは第3要素 */
  pos: [number, number] | [number, number, number];
  /** yaw（0 = −Z を向く。three.js の rotation.y と同じで、上から見て左回り＝反時計回りが正）、pitch（上が正）。度 */
  look: [number, number];
  flip?: number;
  flipRadius?: number;
};

const start = startPosition();

export const SHOTS: ShotDef[] = [
  { name: "golden", desc: "開始地点・夕方の湖と山脈", hour: 17.4, weather: "clear", pos: [start.x, start.z], look: [0, 4] },
  // 2026-09-03 変更: 旧位置は太陽がカメラの真後ろ 23°で、影が物陰に隠れ「昼なのに影が無い」画になっていた。
  // 木の近く・太陽が横から当たる向きへ移し、落ち影が見える構図にした（影の仕組みは変えていない）。
  { name: "noon", desc: "真昼の草地と針葉樹", hour: 12.2, weather: "clear", pos: [start.x + 260, start.z + 350], look: [100, 2] },
  { name: "dawn", desc: "夜明けの霧の湖", hour: 5.9, weather: "mist", pos: [start.x - 40, start.z + 10], look: [20, 3] },
  // 2026-09-03 変更: 同上（旧位置は太陽がカメラの真後ろ 23°）。
  { name: "cloudy", desc: "曇りの午後・斜面の森", hour: 14.5, weather: "cloudy", pos: [start.x + 430, start.z + 470], look: [128, 3] },
  { name: "rain", desc: "雨の湖岸", hour: 15.0, weather: "rain", pos: [start.x, start.z - 4], look: [10, -6] },
  { name: "storm", desc: "嵐の稜線", hour: 18.2, weather: "storm", pos: [start.x - 300, start.z + 260], look: [45, 8] },
  { name: "night", desc: "星と月の湖", hour: 23.5, weather: "clear", pos: [start.x, start.z], look: [0, 12] },
  { name: "sunset_water", desc: "水面すれすれの夕日", hour: 18.0, weather: "clear", pos: [start.x + 10, start.z - 12, 0.6], look: [-30, 2] },
  { name: "forest", desc: "森の中（幹と下草）", hour: 16.0, weather: "clear", pos: [start.x + 180, start.z + 420], look: [200, 0] },
  { name: "ridge", desc: "尾根から谷を見下ろす", hour: 10.0, weather: "clear", pos: [start.x - 900, start.z + 700], look: [60, -10] },
  { name: "flip_half", desc: "裏返しの波が半分まで来たところ", hour: 17.4, weather: "clear", pos: [start.x, start.z], look: [0, 4], flip: 1, flipRadius: 260 },
  { name: "flip_full", desc: "全部が数式になった状態", hour: 17.4, weather: "clear", pos: [start.x, start.z], look: [0, 4], flip: 1, flipRadius: 6000 },
];

export type Params = {
  auto: boolean;
  nohud: boolean;
  freeze: boolean;
  hour?: number;
  weather?: WeatherPresetName;
  pos?: [number, number, number | undefined];
  look?: [number, number];
  flip?: number;
  flipRadius?: number;
  tier?: QualityTier;
  shot?: ShotDef;
  /** 実験室（いじる）を開いた状態で始める */
  lab: boolean;
  /** 描画の負荷計測を出す */
  stats: boolean;
  /** デバッグ: 描画段階を飛ばす（noref / nocopy / notrans / nopost / noshadow） */
  dbg: string[];
};

export function parseParams(search: string): Params {
  const q = new URLSearchParams(search);
  const p: Params = {
    auto: q.get("auto") === "1",
    nohud: q.get("nohud") === "1",
    freeze: q.get("freeze") === "1",
    lab: q.get("lab") === "1",
    stats: q.get("stats") === "1",
    dbg: (q.get("dbg") ?? "").split(",").filter(Boolean),
  };
  const shotName = q.get("shot");
  if (shotName) {
    const s = SHOTS.find((x) => x.name === shotName);
    if (s) {
      p.shot = s;
      p.auto = true;
      p.nohud = q.get("nohud") !== "0";
      p.freeze = q.get("freeze") !== "0";
      p.hour = s.hour;
      p.weather = s.weather;
      p.pos = [s.pos[0], s.pos[1], s.pos[2]];
      p.look = s.look;
      p.flip = s.flip;
      p.flipRadius = s.flipRadius;
    }
  }
  if (q.get("t")) p.hour = Number(q.get("t"));
  const w = q.get("w") as WeatherPresetName | null;
  if (w && ["clear", "cloudy", "mist", "rain", "storm"].includes(w)) p.weather = w;
  if (q.get("pos")) {
    const a = q.get("pos")!.split(",").map(Number);
    if (a.length >= 2) p.pos = [a[0], a[1], a.length >= 3 ? a[2] : undefined];
  }
  if (q.get("look")) {
    const a = q.get("look")!.split(",").map(Number);
    if (a.length >= 2) p.look = [a[0], a[1]];
  }
  if (q.get("flip")) p.flip = Number(q.get("flip"));
  if (q.get("flipr")) p.flipRadius = Number(q.get("flipr"));
  const t = q.get("q") as QualityTier | null;
  if (t && ["low", "mid", "high", "ultra"].includes(t)) p.tier = t;
  return p;
}
