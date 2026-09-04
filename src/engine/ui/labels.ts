// 裏返した世界の中に貼る、小さな数式のふだ。
//
// 「正体（数式）が画の中に無い」（批評R1）への答え。照準のパネルとは別に、
// 地形・湖・空・木の 4 か所へ、その場所を本当に作っている式を 3D の位置に置く。
// 位置は裏返しを始めた瞬間に一度だけ決めて、あとは世界に固定する（歩いて近づけば読める）。
// 数式の波（uFlipRadius）が通り過ぎた所から順に現れる。
//
// ここは純粋なロジック（描画に触らない）。位置決めに使うのは heightAt() と forestDensity()、
// つまり地形と林を本当に作っている関数そのもの。
import * as THREE from "three";
import type { Env } from "../core/env";
import { heightAt, normalAt, WORLD } from "../core/heightfield";
import { forestDensity } from "../vegetation/vegmap";
import { waveParams } from "./formulas";
import { E, formulaById, type Node } from "../../data/formulas";

export type LabelKind = "terrain" | "lake" | "sky" | "tree";

export type WorldLabel = {
  kind: LabelKind;
  /** 見出し（和文） */
  title: string;
  /** 見出し（欧文） */
  latin: string;
  /** 数式。入口の黒板と同じ線文字で書くので、文字列ではなく木（Node）で持つ */
  nodes: Node[][];
  /** ひとことの説明（和文。専門知識ゼロの人向け） */
  note: string;
  /** 世界座標 */
  pos: THREE.Vector3;
  /** 地形に隠れるかを見るか（空は見ない） */
  occlude: boolean;
  /** これより遠ければ出さない（m） */
  maxDist: number;
  /** 大きさ・濃さを決める距離。空のように「遠いが手前に見せたい」ものだけ指定する */
  screenDist?: number;
};

const DEG = Math.PI / 180;

// ふだに貼る式は、黒板と同じ src/data/formulas.ts から取る（二重に書くと必ずずれる）
const HEIGHT = formulaById("terrain.h")!.body;
const WAVE = formulaById("water.wave")!.body;

/** 角 a（rad）方向、距離 d の水平座標 */
function at(px: number, pz: number, a: number, d: number): [number, number] {
  return [px + Math.sin(a) * d, pz - Math.cos(a) * d];
}

/**
 * bias（正面からの振り、rad）を中心に扇形へ広げて探し、test を満たす最初の地点を返す。
 * 角は bias から左右へ広げ、その中では近い所から見る＝なるべく「その向き・手前」を選ぶ。
 */
function sweep(
  px: number,
  pz: number,
  yaw: number,
  bias: number,
  maxAngleDeg: number,
  dists: number[],
  test: (x: number, z: number, h: number) => boolean,
): [number, number, number] | null {
  for (let a = 0; a <= maxAngleDeg; a += 8) {
    for (const s of a === 0 ? [0] : [1, -1]) {
      const ang = yaw + bias + s * a * DEG;
      for (const d of dists) {
        const [x, z] = at(px, pz, ang, d);
        if (Math.hypot(x, z) > WORLD.half - 40) continue;
        const h = heightAt(x, z);
        if (test(x, z, h)) return [x, z, h];
      }
    }
  }
  return null;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

/**
 * 裏返しを始めた場所・向きから、ふだを置く 4 点を決める。
 * heightAt を 2000 回ほど呼ぶ（数 ms）。裏返し 1 回につき 1 度だけ呼ぶこと。
 */
export function buildLabels(env: Env, compact: boolean): WorldLabel[] {
  const cam = env.camera;
  const p = cam.position;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const yaw = Math.atan2(fwd.x, -fwd.z); // 北(−Z)=0
  const lake = WORLD.lakeLevel;
  const out: WorldLabel[] = [];
  // ふだ同士が画面で重ならないよう、正面から少しずつ振った向きを持ち場にする。
  // 携帯は縦画面で横の視野が狭いので振りを小さく。
  const sp = compact ? 0.42 : 1;
  const bias = (deg: number) => deg * sp * DEG;
  const vis = (x: number, z: number, y: number) => !occluded(p, _t.set(x, y, z));

  // ── 湖: 水の上。岸から離れた所（周り 30m も水）を選ぶ ──────────────
  const lakeHit = sweep(p.x, p.z, yaw, bias(-12), 100, range(80, 460, 20), (x, z, h) => {
    if (h > lake - 1.2) return false;
    for (let k = 0; k < 4; k++) {
      const a = k * 90 * DEG;
      if (heightAt(x + Math.cos(a) * 30, z + Math.sin(a) * 30) > lake - 0.3) return false;
    }
    return true;
  });
  if (lakeHit) {
    const w = waveParams(env.weather.wind);
    out.push({
      kind: "lake",
      title: "湖",
      latin: "LAKE",
      nodes: compact
        ? [WAVE, E(`ω(k) = \\r{9.81k + 7.4·10^{-5}k^{3}}`)]
        : [
            WAVE,
            E(`ω(k) = \\r{9.81k + 7.4·10^{-5}k^{3}}`),
            E(`λ_p = ${w.lambdaP.toFixed(2)} m`),
          ],
      note: "波は風の強さから計算",
      pos: new THREE.Vector3(lakeHit[0], lake + 1.1, lakeHit[1]),
      occlude: true,
      maxDist: 900,
    });
  }

  // ── 地形: 湖の向こうの斜面。高くて傾きがあって、ここから見えている所 ──
  const terHit = sweep(p.x, p.z, yaw, bias(-36), 80, range(220, 1250, 40), (x, z, h) => {
    if (h < lake + 25) return false;
    if (normalAt(x, z, 6).y > 0.965) return false; // 15° 未満は「斜面」に見えない
    return vis(x, z, h + 16);
  });
  if (terHit) {
    const hh = terHit[2];
    out.push({
      kind: "terrain",
      title: "地形",
      latin: "TERRAIN",
      nodes: compact
        ? [HEIGHT, E(`h = ${hh.toFixed(1)} m`)]
        : [
            HEIGHT,
            E(`mtn = R(\\F{warp}{x,z})·\\F{amp}{θ}`),
            E(`h = ${hh.toFixed(1)} m`),
          ],
      note: "山の形は 1 本の関数",
      pos: new THREE.Vector3(terHit[0], hh + 16, terHit[1]),
      occlude: true,
      maxDist: 1500,
    });
  }

  // ── 木: 本当に林になっている所（木の配置に使っている forestDensity が濃い所）──
  const treeHit = sweep(p.x, p.z, yaw, bias(30), 70, range(90, 1000, 30), (x, z, h) => {
    if (h < lake + 6) return false;
    const n = normalAt(x, z, 4);
    if (forestDensity(x, z, h, n.y) < 0.45) return false;
    return vis(x, z, h + 20);
  });
  if (treeHit) {
    out.push({
      kind: "tree",
      title: "木",
      latin: "TREES",
      // ここは「失敗した式（δ = 8° + 30°(1-u), n_B = 6）」を貼ってしまっていた。
      // formulas.ts の直したほう（輪生 12〜16 本）に合わせる。**嘘を書かない**
      nodes: compact
        ? [E(`φ_{j,b} = 2.39996·j + \\f{2πb}{n_B}`), E(`δ(u) = 15° + 35°(1-u)`)]
        : [
            E(`φ_{j,b} = 2.39996·j + \\f{2πb}{n_B}`),
            E(`δ(u) = 15° + 35°(1-u) ± 10°`),
            E(`n_B = 12~16`),
          ],
      note: "枝は幹から生える規則",
      pos: new THREE.Vector3(treeHit[0], treeHit[2] + 20, treeHit[1]),
      occlude: true,
      maxDist: 900,
    });
  }

  // ── 空: 見ている向きから少し振った上空。遠い 1 点として世界に置く ──
  const sun = env.sunDir;
  const sunYaw = Math.atan2(sun.x, -sun.z);
  // 太陽が視野の中にあれば太陽の側へ寄せる（散乱がいちばん見える所）
  let side = 1;
  const dy = ((sunYaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (sun.y > -0.05 && Math.abs(dy) < 1.2) side = dy >= 0 ? 1 : -1;
  const skyYaw = yaw + side * bias(18);
  const el = (compact ? 24 : 30) * DEG;
  const d = 1600;
  const skyPos = new THREE.Vector3(
    p.x + Math.sin(skyYaw) * Math.cos(el) * d,
    p.y + Math.sin(el) * d,
    p.z - Math.cos(skyYaw) * Math.cos(el) * d,
  );
  out.push({
    kind: "sky",
    title: "空",
    latin: "SKY",
    nodes: compact
      ? [
          E(`L = \\I{0}{D}{T·(σ^{R}p^{R} + σ^{M}p^{M})·E_☉}{s}`),
          E(`σ^{R} ∝ e^{-h/8km}`),
        ]
      : [
          E(`L(ω) = \\I{0}{D}{T·(σ^{R}p^{R}(θ) + σ^{M}p^{M}(θ))·E_☉}{s}`),
          E(`σ^{R} = (5.8, 13.6, 33.1)·10^{-3}·e^{-h/8km}`),
        ],
    note: "空の色は光の散らばり",
    pos: skyPos,
    occlude: false,
    maxDist: 1e9,
    screenDist: 260,
  });

  return out;
}

const _a = new THREE.Vector3();
const _t = new THREE.Vector3();

/** cam から pos までの間に地面があるか（8 点だけ見る簡易版） */
export function occluded(camPos: THREE.Vector3, pos: THREE.Vector3): boolean {
  const N = 9;
  for (let i = 1; i < N; i++) {
    const t = i / N;
    _a.copy(camPos).lerp(pos, t);
    if (_a.y < heightAt(_a.x, _a.z) - 1.0) return true;
  }
  return false;
}
