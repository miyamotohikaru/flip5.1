// 針葉樹（トウヒ／モミ系）のプロシージャルな形と材質。
//   幹: テーパー付き円柱（根元に張り出し、少し曲がる）。樹皮の凹凸はフラグメントのノイズ→法線
//   枝: 螺旋（黄金角）の輪生だが、段の高さ（±0.05H）と枝ごとの高さ（±0.05H）を散らして
//       「段々の皿」に見えないようにする。1 段 13〜16 本、枝長 ±45%、垂れ角 15+35(1−u)°±10°。
//       梢は短い輪生 3 段の小さな円錐。上ほど短く、下ほど垂れる。針葉はアルファテストのカード
//       （上から見た扇 + 横から見た垂れ + 梢）。カードの模様は textures.ts が Canvas で描く
//   LOD0 = フル、LOD1 = 枝カード減。LOD2（インポスター）は impostor.ts
//   風: 高さの2乗で全体がしなり、枝は flex に応じてはためく
//   裏返し: 幹と枝が L-system の骨組み（細い線）になり、針葉は消える
import * as THREE from "three";
import { hash2 } from "../core/noise";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { patchMaterial, replaceOnce } from "../core/patch";
import { VEG_FRAG_DITHER, VEG_LIGHTS_FRAGMENT, VEG_VERT_COMMON } from "./shaders";
import { ALPHA_CUTOFF } from "./textures";

export type TreeVariant = {
  /** 高さ（m）。個体はこれに 0.55〜1.5 のスケール */
  H: number;
  /** 樹冠の始まる高さ（H に対する比） */
  crownBase: number;
  /** いちばん長い枝（H に対する比） */
  lmax: number;
  whorls: number;
  perWhorl: number;
  /** 上から見た扇カードも付ける枝の割合（横向きの垂れカードは全枝に付く） */
  sideRatio: number;
  seed: number;
};

// 輪生（同じ高さに枝が輪になって並ぶ）を「見せない」のが要点。
// 段数を減らして 1 段あたりの枝を増やし、枝ごとに高さ・長さ・垂れ角をばらけさせると、
// 段々の皿ではなく「もじゃもじゃした円錐」になる。
// **1 段あたりの枝を減らしてはいけない。** 9 → 6 にしたら、樹冠の内側の暗い殻を隠す
// 針葉が足りなくなり、中景の木が「針葉の見えないなめらかな薄緑の円錐（アイスクリームの
// コーン）」になった（`forest` (380,40)-(820,450) の「のっぺり」画素 0.4% → 3.1%）。
export const TREE_VARIANTS: TreeVariant[] = [
  { H: 15, crownBase: 0.16, lmax: 0.155, whorls: 13, perWhorl: 9, sideRatio: 0.50, seed: 1 },
  { H: 12.5, crownBase: 0.05, lmax: 0.19, whorls: 13, perWhorl: 7, sideRatio: 0.50, seed: 2 },
  { H: 17, crownBase: 0.10, lmax: 0.16, whorls: 14, perWhorl: 9, sideRatio: 0.45, seed: 3 },
  { H: 10, crownBase: 0.03, lmax: 0.21, whorls: 12, perWhorl: 7, sideRatio: 0.55, seed: 4 },
];


export type TreeGeo = { geometry: THREE.BufferGeometry; H: number; radius: number; topY: number; tris: number };

/**
 * 影だけの遠景プロキシ（幹の四角柱 ＋ 樹冠の円錐 = 16 三角形）。
 * 100〜300m の木にも落ち影を出したいが、LOD1（88 三角形）を影のパスで何千本も描くと
 * 予算を超える。この距離では影の輪郭しか読めないので、solid な円錐で足りる。
 */
export function buildShadowProxy(v: TreeVariant, radius: number): THREE.BufferGeometry {
  const H = v.H;
  const pos: number[] = [];
  const idx: number[] = [];
  const seg = 6;
  // 幹（四角柱）
  const r0 = 0.014 * H + 0.05;
  const base = 0;
  for (let ring = 0; ring < 2; ring++) {
    const y = ring === 0 ? -0.3 : H * 0.98;
    const rr = ring === 0 ? r0 : r0 * 0.35;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
  }
  for (let k = 0; k < 4; k++) {
    const a = base + k, b = base + ((k + 1) % 4), c = base + 4 + k, d = base + 4 + ((k + 1) % 4);
    idx.push(a, c, b, b, c, d);
  }
  // 樹冠（円錐）: 枝の届く半径の 8 割
  const cb = pos.length / 3;
  const rc = radius * 0.8;
  const yb = v.crownBase * H;
  pos.push(0, H * 1.0, 0);
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * rc, yb, Math.sin(a) * rc);
  }
  for (let k = 0; k < seg; k++) idx.push(cb, cb + 1 + ((k + 1) % seg), cb + 1 + k);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H * 0.5, 0), Math.hypot(H * 0.55, rc));
  return geo;
}

const CELL = 0.5; // 針葉アトラスは 2×2

export function buildConifer(v: TreeVariant, lod: 0 | 1): TreeGeo {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], data: number[] = [], axis: number[] = [], dir: number[] = [];
  const idx: number[] = [];
  let rc = 0;
  let maxR = 0, topY = 0;
  const rnd = () => hash2(rc++, v.seed * 31 + lod * 7, 5);
  const H = v.H;
  const r0 = 0.011 * H + 0.04;
  const curveA = rnd() * Math.PI * 2;
  const curveAmt = 0.008 * H * (0.5 + rnd());
  const axisAt = (t: number) => ({ x: Math.cos(curveA) * curveAmt * t * t, y: t * H, z: Math.sin(curveA) * curveAmt * t * t });
  const radiusAt = (t: number) => r0 * (Math.pow(1 - t, 0.85) + 0.015) * (1 + 0.6 * Math.exp(-t * 30));

  // ---- 幹
  // 幹の周りの分割。8 → 7（カードを 1 枚増やしたぶんの三角形をここで返す）
  const segs = lod === 0 ? 7 : 5;
  // 幹は樹冠の頂点より 0.5m 下で切る。上まで伸ばすと、梢の葉より上に
  // 幹が「角材」として突き出て見える（批評R5 の退行）
  const trunkTop = Math.max(0.5, 1.0 - 0.5 / H);
  const ringsT = lod === 0 ? [0, 0.04, 0.12, 0.25, 0.42, 0.6, 0.78, 0.9, 1.0] : [0, 0.35, 1.0];
  const rings = ringsT.map((t) => t * trunkTop);
  const base0 = 0;
  for (let ri = 0; ri < rings.length; ri++) {
    const t = rings[ri];
    const a0 = axisAt(t), r = radiusAt(t);
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(a0.x + ca * r, a0.y, a0.z + sa * r);
      nrm.push(ca, 0.08, sa);
      uv.push(k / segs, t * H);
      data.push(0, t * t * 0.4, 0, 0);
      axis.push(a0.x, a0.y, a0.z);
      dir.push(0, 1, 0);
    }
  }
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let k = 0; k < segs; k++) {
      const a = base0 + ri * (segs + 1) + k, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // ---- 樹冠の内側の「暗い殻」（8 面・3 段の円錐）
  // 葉カードの隙間から明るい空が 1px 抜けるのを、内側の暗い面で塞ぐ。
  // 半径は枝の 0.6 倍なので輪郭は変えず、樹冠の中が暗くなって立体にも見える
  {
    const shellSeg = 8;
    const shellRings: number[] = [];
    const tTop = 0.985;
    const nSR = lod === 0 ? 4 : 3;
    for (let i = 0; i < nSR; i++) shellRings.push(v.crownBase + (tTop - v.crownBase) * (i / (nSR - 1)));
    const shellBase = pos.length / 3;
    for (let ri = 0; ri < shellRings.length; ri++) {
      const t = shellRings[ri];
      const u = (t - v.crownBase) / Math.max(tTop - v.crownBase, 1e-3);
      const a0 = axisAt(t);
      // 枝の届く半径のおおよそ 0.6 倍（いちばん上は 0 に絞る）
      // 枝は 50〜66° 垂れるので、樹冠の**水平**の届きは枝長のおよそ半分しかない。
      // 殻はそのさらに 3 割 = 枝長の 0.14 倍。これ以上大きいと殻自身が輪郭として読める
      // **枝の細り方（1 - 0.95·u^1.1）と同じ形にする。** 違う形にすると、
      // 樹冠が円錐になった上の方で殻だけが外へはみ出して「緑の芯」が見える。
      // 半径は 0.14 → 0.16。**ここを 0.34 にしてはいけない**: 実行時に 1.6 倍まで太らせると
      // 実効 0.54×L となり、枝の水平の届き（0.59〜0.87×L）に並んで、
      // 20〜60m の木が**縁のなめらかな緑の円錐**になる（実測・`forest` で確認）。
      // 葉と葉の 1px の隙間から空が抜ける（＝ピンホール）のを内側の暗い面で塞ぐ
      // 半径は **0.14**（前のラウンドで「殻が輪郭になる」のを直したときの値。ここを動かさない）。
      // 枝は 50〜66° 垂れるので水平の届きは枝長のおよそ半分しかない。
      // 実行時にこれを 0.34 まで太らせたら、中景の木が「なめらかな薄緑の円錐」になった。
      // **焼き込みだけ 3.4 倍**にして実効 0.476×L で樹冠の内側を埋める（下の VEG_BAKE）
      const rr = v.lmax * H * (1 - 0.97 * Math.pow(u, 1.02)) * 0.44 * (1 - Math.pow(u, 6));
      for (let k = 0; k <= shellSeg; k++) {
        const a = (k / shellSeg) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        pos.push(a0.x + ca * rr, a0.y, a0.z + sa * rr);
        nrm.push(ca, 0.35, sa);
        uv.push(k / shellSeg, t);
        data.push(2, 0.25 + 0.5 * t, 0, 0);
        axis.push(a0.x, a0.y, a0.z);
        dir.push(0, 1, 0);
      }
    }
    for (let ri = 0; ri < shellRings.length - 1; ri++) {
      for (let k = 0; k < shellSeg; k++) {
        const a = shellBase + ri * (shellSeg + 1) + k, b = a + 1, c = a + shellSeg + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }

  // ---- カード
  // 1 枚のカードは「コマ全体」ではなく **コマの中の小さな窓** を引く（texU0..texU1 / texV0..texV1）。
  // カードを小さくしても窓を同じ割合で小さくすれば、**針の実寸（世界の cm）が変わらない**。
  // 窓を切らずにカードだけ小さくすると、針まで一緒に縮んで画素より細くなり、
  // カードが「1 色の緑の面」に戻ってしまう
  const addCard = (
    bx: number, by: number, bz: number,
    d: THREE.Vector3, w: THREE.Vector3, L: number, vA: number, vB: number,
    cell: number, texU0: number, texU1: number, texV0: number, texV1: number, flex: number, phase: number, spire: boolean,
  ) => {
    const n = new THREE.Vector3().crossVectors(w, d).normalize();
    if (!spire && n.y < 0) n.negate();
    const start = pos.length / 3;
    // コマの縁に余白を取る。縁ちょうどを引くと、ミップの段でとなりのコマ
    // （梢の明るい主軸）の色がにじんで、葉の上に明るい茶色の点が出る
    const PAD = 0.010;
    const cx = (cell % 2) * CELL + PAD, cy = Math.floor(cell / 2) * CELL + PAD;
    const SPAN = CELL - 2 * PAD;
    const corners: [number, number][] = [[0, vA], [1, vA], [0, vB], [1, vB]];
    for (const [u, vv] of corners) {
      const px = bx + d.x * u * L + w.x * vv, py = by + d.y * u * L + w.y * vv, pz = bz + d.z * u * L + w.z * vv;
      maxR = Math.max(maxR, Math.hypot(px, pz));
      topY = Math.max(topY, py);
      pos.push(px, py, pz);
      nrm.push(n.x, n.y, n.z);
      const tv = (vv - vA) / (vB - vA);
      if (spire) uv.push(cx + (0.15 + 0.7 * tv) * SPAN, cy + (0.98 - 0.94 * u) * SPAN);
      else uv.push(cx + (texU0 + (texU1 - texU0) * u) * SPAN, cy + (texV0 + (texV1 - texV0) * tv) * SPAN);
      data.push(1, flex * (0.35 + 0.65 * u), phase, cell);
      axis.push(bx + d.x * u * L, by + d.y * u * L, bz + d.z * u * L);
      dir.push(d.x, d.y, d.z);
    }
    idx.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  };

  const up = new THREE.Vector3(0, 1, 0);

  // ---- 下枝の枯れ枝（樹冠の下、幹の 5〜30% のあたりに 5〜8 本）
  // 森の針葉樹は下枝が枯れて残る。これが無いと幹が「つるつるの棒」に見える
  if (lod === 0) {
    const nDead = 5 + Math.floor(rnd() * 4);
    for (let b = 0; b < nDead; b++) {
      const t = 0.05 + (Math.max(v.crownBase, 0.26) - 0.05) * ((b + 0.25 + 0.5 * rnd()) / nDead);
      const a0 = axisAt(t), rt = radiusAt(t);
      const az = rnd() * Math.PI * 2;
      const dr = ((22 + 26 * rnd()) * Math.PI) / 180; // 下向きに垂れる
      // **短い折れ枝**。ここが長いと、葉の付いていない茶色の棒が樹冠の外へ突き出して
      // 地面まで届き、「木に竹の支柱を刺した」画になる（批評 R6 の新規 1 番）
      let len = (0.20 + 0.32 * rnd()) * v.lmax * H;
      // 先が地面（y = 0.35m）より下に行かない長さで頭打ちにする
      const drop = Math.sin(dr);
      if (drop > 1e-3) len = Math.min(len, Math.max(0.12, (a0.y - 0.35) / drop));
      const d0 = new THREE.Vector3(Math.cos(az) * Math.cos(dr), -Math.sin(dr), Math.sin(az) * Math.cos(dr)).normalize();
      const w = new THREE.Vector3().crossVectors(d0, up).normalize();
      const w1 = rt * 0.45, w2 = rt * 0.12;
      const bx = a0.x + Math.cos(az) * rt * 0.7, by = a0.y, bz = a0.z + Math.sin(az) * rt * 0.7;
      const start = pos.length / 3;
      const n0 = new THREE.Vector3().crossVectors(w, d0).normalize();
      for (const [uu, ww] of [[0, -w1], [0, w1], [1, -w2], [1, w2]] as [number, number][]) {
        pos.push(bx + d0.x * uu * len + w.x * ww, by + d0.y * uu * len + w.y * ww, bz + d0.z * uu * len + w.z * ww);
        nrm.push(n0.x, n0.y, n0.z);
        uv.push(uu, ww);
        data.push(0, 0.25 + 0.4 * t, rnd() * 6.2832, 0);
        axis.push(bx + d0.x * uu * len, by + d0.y * uu * len, bz + d0.z * uu * len);
        dir.push(d0.x, d0.y, d0.z);
      }
      idx.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
    }
  }

  // LOD1 は「段数を減らして 1 段の枝を増やす」と、遠くで段が分離して**パゴダ（塔の相輪）**に見える。
  // 三角形の総数は同じまま、段を増やして 1 段の枝を減らすと、段が重なって円錐に読める
  const nW = lod === 0 ? v.whorls : Math.max(7, Math.round(v.whorls * 0.95));
  // 輪生の上端。0.88 だと、ここから上（樹高の 12%）が「細い幹に小さな房が 3〜4 個」の
  // アンテナになる（批評 R6 の新規 2 番）。梢の輪生と連続させるため 0.94 まで上げる
  const top = 0.94;
  // 1 段の枝を丸ごと 1 つの高さに置くと「皿」に見える。段の高さ（±0.05H）と
  // 枝ごとの高さ（±0.05H）を別々に散らして、段の境目を溶かす。
  const spanT = top - v.crownBase;
  const branch = (t: number, u: number, L: number, az: number, flex: number, spire: boolean) => {
    const a0 = axisAt(t), rt = radiusAt(t);
    // 垂れ角。**下ほど強く垂れ、上ほど水平〜やや上向き**だが、幅（水平の届き）は
    // 枝の長さで決めるので、角度の差は小さくする。ここを 24〜66° にすると
    // cos が上ほど大きくなって長さの細りを打ち消し、**上から下まで同じ幅の円筒**になる
    // （＝ 400m 以遠で「緑の杭」に見えていた正体。統合担当の 1 位）
    const droop = ((30 + 24 * (1 - u)) * Math.PI) / 180 + (rnd() - 0.5) * 0.22;
    const Lb = Math.max(L * (0.55 + 0.9 * rnd()), 0.28); // 枝長 ±45%
    maxR = Math.max(maxR, Lb * Math.cos(droop) + rt);
    const cd = Math.cos(droop), sd = Math.sin(droop);
    const d = new THREE.Vector3(Math.cos(az) * cd, -sd, Math.sin(az) * cd).normalize();
    const bx = a0.x + Math.cos(az) * rt * 0.6, by = a0.y, bz = a0.z + Math.sin(az) * rt * 0.6;
    const w0 = new THREE.Vector3().crossVectors(d, up).normalize();
    const phase = rnd() * 6.2832;
    // 枝 1 本を「大きな 1 枚のカード」で表すと、10〜40m で紙を貼った棒に見える（批評 R3 の 3 位）。
    // 面積 1/3 の小さなカードを 3 枚、枝に沿って位置をずらし、向きと捻りを変えて出す。
    // 総面積はほぼ同じだが、輪郭が細かくなって「もじゃもじゃした枝」に見える
    // 1 枚が大きいと「板」に見える（批評R7 の 4 番①）。ただし**枚数を増やすために枝を減らすと
    // 樹冠の内側の殻が透けて円錐に見える**ので、枚数は 9 のまま、1 枚の寸法だけ 0.87 倍にする
    const nCards = lod === 0 ? (spire ? 3 : 9) : 1;
    for (let ci = 0; ci < nCards; ci++) {
      const along = nCards === 1 ? 0 : (0.02 + (0.88 / nCards) * ci) * Lb;
      const len = nCards === 1 ? Lb : Lb * (0.240 + 0.105 * rnd()) * (1 - 0.04 * ci);
      // 枝の向きから左右に振る（枝先が扇状に分かれる）
      const yawOff = nCards === 1 ? 0 : (rnd() - 0.5) * 0.62;
      const dc = d.clone().applyAxisAngle(up, yawOff).normalize();
      // いちばん内側の 2 枚は幹に沿って強く垂らす。これが無いと幹が上から下まで
      // 1 本の棒として見通せる（統合担当の指摘・R6）
      let inner = 1.0;
      if (nCards > 1 && ci < 3) {
        const side = new THREE.Vector3().crossVectors(dc, up).normalize();
        dc.applyAxisAngle(side, -(0.45 + 0.25 * rnd())).normalize();
        // 幹に沿って垂れる 3 枚は一回り大きく。ここが小さいと幹が上から下まで
        // 1 本のピンクの棒として見通せる（批評 R6 の 6 番）。
        // さらに、樹冠の**内側**をこの 3 枚で埋める。ここが薄いと近景の木の樹冠の中に
        // 空が 3〜10px の白い塊として点々と抜ける（`cloudy_side` のピンホール 248 個）
        inner = 1.36;
      }
      // 幅方向は「下」。カードごとに捻りを変えて、平らな面が揃わないようにする
      let dn = new THREE.Vector3().crossVectors(new THREE.Vector3().crossVectors(dc, up).normalize(), dc).normalize();
      if (dn.y > 0) dn = dn.negate();
      dn.applyAxisAngle(dc, (rnd() - 0.5) * (nCards === 1 ? 0.8 : 0.75));
      // 9 枚中 8 枚が同じコマ（横から見た垂れ）だと、コマの中の茶色い主軸が
      // どのカードでも同じ位置に出て「格子状のサーモンの点」に見える（批評 R6 の 5 位③）。
      // 3 つのコマに散らし、さらに半分は上下を反転して同じ模様が並ばないようにする
      const cr = rnd();
      const cell = nCards === 1 ? 1 : cr < 0.46 ? 1 : cr < 0.73 ? 0 : 3;
      // 幅を 1.10·L に広げてみたが、コマの上下の透明な余白まで引くことになり
      // ピンホールが 168 → 180 に**増えた**ので戻した
      let v0 = cell === 1 ? 0.34 : 0.16, v1 = cell === 1 ? 0.94 : 0.88;
      if (rnd() < 0.5) { const t = v0; v0 = v1; v1 = t; }
      // 幅は長さの 0.62 倍。ほぼ正方形（0.98 倍）だとアトラスの絵が縦に 1.6 倍伸びて
      // 針が太くなり、1 枚が「切った工作用紙」として読める（批評 R6 の 5 位①）
      const Lc = len * inner;
      // **窓はコマ全体（0..1）のまま**にする。コマの内側だけを小さく切り出すと、
      // 針の実寸は保てる代わりに「枝先のぎざぎざした輪郭」が窓の外に出てしまい、
      // 1 枚が**縁のまっすぐな平行四辺形＝もっと工作用紙**になる（実測: 高周波 std が 0.036 → 0.032 に低下）。
      // 半分は左右を反転して、同じ絵柄が並ばないようにする
      const flipU = rnd() < 0.5;
      addCard(
        bx + d.x * along, by + d.y * along, bz + d.z * along,
        dc, dn, Lc, -0.27 * Lc, 0.58 * Lc, cell,
        flipU ? 1 : 0, flipU ? 0 : 1, v0, v1,
        flex, phase + 1.0 + ci * 2.1, false,
      );
    }
  };
  for (let j = 0; j < nW; j++) {
    const u = nW > 1 ? j / (nW - 1) : 0;
    const tW = v.crownBase + spanT * u + (rnd() - 0.5) * 0.10;
    // 上ほど短く。**ここが本体の細り**。0.62 だと梢でも 38% 残って円錐にならない。
    // 0.97·u^1.02 にすると、樹高の 80% の位置での水平の届きが根元の 3 割ほどになり、
    // 遠景で「先の尖った円錐」として読める
    const L = v.lmax * H * (1 - 0.97 * Math.pow(u, 1.02));
    const nB = lod === 0 ? v.perWhorl + (rnd() < 0.5 ? 1 : 0) : Math.max(3, Math.round(v.perWhorl * 0.36));
    for (let b = 0; b < nB; b++) {
      // 黄金角で回して、段どうしの枝が同じ方位に並ばないようにする
      const az = j * 2.39996 + (b * Math.PI * 2) / nB + (rnd() - 0.5) * 0.9;
      const t = Math.min(Math.max(tW + (rnd() - 0.5) * 0.10, v.crownBase * 0.8), top);
      branch(t, Math.max(0, Math.min(1, (t - v.crownBase) / Math.max(spanT, 1e-3))), L, az, 0.45 + 0.55 * t, false);
    }
  }
  // 梢: 交差カード 2 枚だと電球に見えるので、短い輪生 3 段の小さな円錐にする
  {
    // 頂芽は「樹高の 4% の短い円錐」。段を上に詰め、いちばん上を 0.999 まで持ち上げる
    const tips = lod === 0 ? [0.945, 0.965, 0.982, 0.996] : [0.95];
    const nb = lod === 0 ? 6 : 3;
    for (let s = 0; s < tips.length; s++) {
      const t0 = tips[s];
      // 梢は**細く短く**。ここが長いと樹冠の最上部が輪生より広がり、
      // 頭が「丸い塊」になって遠景で杭の平らな頭に見える（統合担当の要件 2）
      const Ls = v.lmax * H * 0.155 * (1 - 0.5 * s);
      for (let b = 0; b < nb; b++) {
        const az = s * 1.7 + (b * Math.PI * 2) / nb + (rnd() - 0.5) * 0.6;
        // LOD1 は梢が 1 段しかないので、ここで長い枝を出すと「きのこの傘」になる
        // 梢の枝は垂れ角を強くする（u=1 のままだと 15° でほぼ水平になり、遠景で「きのこの傘」に見える）
        branch(t0, 0.62, Ls * (lod === 0 ? 1.0 + 0.3 * rnd() : 0.5), az, 1.0, true);
      }
    }
    // 先端の一本（頂芽）
    const a0 = axisAt(0.975);
    // 頂芽の縦カードは置かない。梢のテクスチャが潰れて、40〜70m の木の頭に
    // 「緑の矩形が乗った」ように見えるため（統合担当の指摘・R6）。
    // 梢は下の 3 段の短い輪生でつくる
    void a0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("aData", new THREE.Float32BufferAttribute(data, 4));
  geo.setAttribute("aAxis", new THREE.Float32BufferAttribute(axis, 3));
  geo.setAttribute("aDir", new THREE.Float32BufferAttribute(dir, 3));
  geo.setIndex(idx);
  const radius = Math.max(maxR, 0.5);
  const topOut = Math.max(topY, H);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, topOut * 0.5, 0), Math.hypot(topOut * 0.55, radius));
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-radius, -0.5, -radius), new THREE.Vector3(radius, topOut, radius));
  return { geometry: geo, H, radius, topY: topOut, tris: idx.length / 3 };
}

// ---------------------------------------------------------------- GLSL

/** 頂点: 配置（インスタンス行列）・風・LOD フェード・裏返し（骨組み）。VEG_VERT_COMMON と flip_noise の後に置く。 */
export const TREE_VERT = /* glsl */ `
attribute vec4 aData;   // x = 種類(0 幹, 1 カード), y = flex, z = 位相, w = カード種別
attribute vec3 aAxis;   // 骨組みの上の点（幹の軸 / 枝の軸）
attribute vec3 aDir;    // 骨組みの向き
uniform vec4 uLod;      // x = r0, y = r1, z = 帯, w = 0: LOD0 / 1: LOD1 / 2: 常に表示
uniform float uTreeH;
uniform float uForceFlip;
uniform float uLineMin;
uniform float uReflect;   // 1 = 映り込みカメラ（近景 LOD0 は映さないので、LOD1 が 0m から受け持つ）
varying vec4 vTree;     // fade, 裏返し, 種類, 個体シード
varying vec3 vVegWorld;
varying vec3 vConeN;
varying vec2 vTreeUv;
varying vec3 vBark;
varying float vAlphaK;   // 遠いカードのアルファの持ち上げ（ピンホール対策）
void veg_tree(out vec3 p, out vec3 n){
  mat4 im = instanceMatrix;
  vec3 root = im[3].xyz;
  float scl = max(length(im[1].xyz), 1e-4);
  mat3 rot = mat3(im) / scl;
  mat3 rotT = transpose(rot);
  float dist = distance(root.xz, uCamPos.xz);
  float seed = flip_hash12(floor(root.xz * 3.7 + 0.5));
  // LOD の切り替え: 画素ごとのディザで溶かすと「網戸」に見えるので、木ごとに切り替え距離を
  // ばらけさせて 1 本ずつパッと入れ替える。LOD0 と LOD1 の輪郭はほぼ同じなので飛びは目立たない
  // 遠いカードだけアルファを持ち上げる（＝しきい値を 0.30 → 0.19 に下げるのと同じ）。
  // カードとカードの間に残る 1〜2px の空の穴が塞がる。7m 以内は素通しなので
  // 近景が「板」に戻ることはない（批評 R6 のピンホール代案 1）
  vAlphaK = 1.0 + 0.60 * smoothstep(7.0, 40.0, dist);
  #ifdef VEG_BAKE
  vAlphaK = 1.0;
  #endif
  float lodJit = flip_hash11(seed * 31.0 + 5.0);
  float sw0 = uLod.x - uLod.z * lodJit;
  float sw1 = uLod.y - uLod.z * lodJit;
  float fade = 1.0;
  // LOD1 は r0 の外では描かない。1 枚カードの枝が遠くで段に分離して「パゴダ（塔の相輪）」に見えるため、
  // r0 の外はインポスター（LOD0 を焼いた板）に任せる。
  // r0 の内側では 8% 縮めて LOD0 の**裏当て**にする。枝と枝の隙間から明るい空が
  // 1px の白い点として抜けるのを、奥の葉で塞ぐため（映り込みでは等倍で 0〜r1 を受け持つ）
  float backdrop = 0.0;
  if (uLod.w < 0.5) fade = step(dist, sw0);
  else if (uLod.w < 1.5) fade = uReflect * step(dist, sw1);
  // 樹冠の内側の殻は 14m より近いと「のっぺりした緑の壁」として見えてしまう。
  // 近景では畳む（近くは葉の枚数が足りているので隙間も自然に見える）
  // **焼き込み（インポスター）では畳まない。** 畳むと焼いた木の樹冠に穴が開き、
  // 150m の木の真ん中に幹色のひし形が縦に並ぶ（批評 R6 の 2 位「緑のサボテン」）
  #ifdef VEG_BAKE
  if (false) {
  #else
  if (aData.x > 1.5 && dist < 6.0) {
  #endif
    p = aAxis;
    n = vec3(0.0, 1.0, 0.0);
    vTree = vec4(fade, 0.0, aData.x, seed);
    vVegWorld = (im * vec4(p, 1.0)).xyz;
    vTreeUv = uv;
    vConeN = vec3(0.0, 0.0, 1.0);
    vBark = p;
    return;
  }
  vec3 lp = position * mix(1.0, 0.92, backdrop);
  // 樹冠の内側の殻は**遠いほど少しだけ太らせる**（実効 0.077×L 〜 0.182×L）。
  // 近景で太いと殻がそのまま輪郭になって「なめらかな円錐」に見え、
  // 遠景で細いと葉と葉の 1px の隙間から空が抜けて白い点（ピンホール）になる。
  // **1.0 を超えさせないこと**（0.14×1.3 = 0.182×L が上限。枝の水平の届きは 0.59〜0.87×L）
  #ifndef VEG_BAKE
  // **実行時は 0.106〜0.167×L（＝検証済みの 0.14 のあたり）。ここを広げてはいけない。**
  // 殻は「枝の隙間から暗がりとして見える」ためのもので、輪郭や面になってはいけない。
  // 0.44×L まで広げたらピンホールは減ったが、樹冠が「表面にノイズの乗った中身の詰まった円錐」になり、
  // 枝カードの間から見えていた空と幹が埋まった（すかし率 3.09% → 1.45%）。
  // **焼き込み側は 0.475×L のままでよい**（遠くから見るインポスターでは殻が面でも問題にならない）
  if (aData.x > 1.5) lp = aAxis + (lp - aAxis) * mix(0.24, 0.38, smoothstep(9.0, 18.0, dist));
  #endif
  #ifdef VEG_BAKE
  // 焼き込みのときは殻を**細らせる**。殻は 8 面のなめらかな円錐なので、
  // 枝の水平の届き（0.62〜0.87×L）に並ぶ太さで焼くと、殻が輪郭を決めてしまい、
  // 遠景の木が**縁のなめらかな三角形（クリスマスツリーの型抜き）**になる。
  // 輪郭はカードが決め、殻は内側を埋めるだけにする
  if (aData.x > 1.5) lp = aAxis + (lp - aAxis) * 1.08;
  #endif
  float hN = clamp(lp.y / uTreeH, 0.0, 1.0);
  vec2 wd = veg_windDir();
  float gust = veg_gust(root.xz);
  float sway = (0.004 + 0.010 * uWind.z) * gust * uTreeH * hN * hN;
  float flut = sin(uTime * (1.7 + seed * 0.8) + aData.z + hN * 2.0 + dot(root.xz, wd) * 0.3) * aData.y * (0.03 + 0.04 * uWind.z) * (0.5 + gust);
  #ifdef VEG_BAKE
  sway = 0.0; flut = 0.0; fade = 1.0;
  #endif
  vec3 wOff = vec3(wd.x, 0.0, wd.y) * sway;
  vec3 lOff = rotT * wOff / scl + normal * flut;
  float fm = veg_flipMask(root);
  float flipped = max(step(flip_hash11(seed * 13.0 + 0.5), fm) * step(0.001, fm), uForceFlip);
  if (flipped > 0.5) {
    // 数式ビュー: 骨組み（幹 1 本＋輪生の線）。カードを全部線にすると「白い粒の雲」になるので、
    // 枝は 1/7 だけ残す（1 本あたり 50 本前後の線）
    float isTrunk = step(aData.x, 0.5);
    float keepLine = max(isTrunk, step(flip_hash11(dot(aAxis, vec3(12.9898, 78.233, 37.719)) + seed * 3.0), 0.145));
    if (keepLine < 0.5) {
      p = aAxis;
      n = vec3(0.0, 1.0, 0.0);
      vTree = vec4(fade, 1.0, aData.x, seed);
      vVegWorld = (im * vec4(p, 1.0)).xyz;
      vTreeUv = uv;
      vConeN = vec3(0.0, 0.0, 1.0);
      vBark = p;
      return;
    }
    vec3 camL = rotT * (cameraPosition - root) / scl;
    vec3 toCam = normalize(camL - aAxis + vec3(1e-4, 0.0, 0.0));
    vec3 wdir = normalize(cross(aDir, toCam) + vec3(1e-4, 0.0, 1e-4));
    float sideSign = dot(lp - aAxis, wdir) >= 0.0 ? 1.0 : -1.0;
    float lw = max(uLineMin, 0.012 + dist * 0.0016) / scl;
    lp = aAxis + wdir * sideSign * lw;
    lOff = rotT * wOff / scl;
    n = vec3(0.0, 1.0, 0.0);
  } else {
    n = normal;
  }
  p = lp + lOff;
  vTree = vec4(fade, flipped, aData.x, seed);
  vVegWorld = (im * vec4(p, 1.0)).xyz;
  vTreeUv = uv;
  float rr = length(lp.xz);
  vec3 coneL = rr > 1e-3 ? normalize(vec3(lp.x, 0.45 * rr + 0.02, lp.z)) : vec3(0.0, 1.0, 0.0);
  vConeN = normalize((viewMatrix * vec4(rot * coneL, 0.0)).xyz);
  vBark = lp;
}
`;

/** フラグメント: 樹皮と針葉の色（線形）。flip_noise / flip_flip の後に置く。 */
export const TREE_FRAG_COLOR = /* glsl */ `
uniform sampler2D uNeedle;
uniform float uNeedleSize;   // 針葉アトラスの 1 辺（画素）
uniform float uTreeH;
varying vec4 vTree;
varying vec3 vVegWorld;
varying vec3 vConeN;
varying vec2 vTreeUv;
varying vec3 vBark;
varying float vAlphaK;
uniform float uTintMix;   // 1 = 個体ごとの色味を掛ける / 0 = 掛けない（インポスターの焼き込み用）
vec3 veg_bark(vec3 lp, float seed, out float relief){
  float streak = flip_vnoise(vec3(lp.x * 14.0, lp.y * 0.9 + seed * 7.0, lp.z * 14.0));
  float streak2 = flip_vnoise(vec3(lp.x * 30.0, lp.y * 2.2 + seed * 3.0, lp.z * 30.0));
  float plates = flip_vnoise(vec3(lp.x * 6.0, lp.y * 1.6, lp.z * 6.0) + seed * 10.0);
  // λ3cm の**縦の裂け**。幹の周りで 3cm ごとに暗い溝が縦に走る（縦には 90cm で緩く変わる）。
  // これが無いと幹の横断方向の明るさが「単峰の滑らかな山」になり、
  // どんなに色を直しても**つるつるの円筒**に見える（批評R7 の 4 番②）
  float fis = flip_vnoise(vec3(lp.x * 34.0, lp.y * 1.15 + seed * 5.0, lp.z * 34.0));
  float groove = smoothstep(0.60, 0.24, fis);
  relief = streak * 0.48 + streak2 * 0.26 - groove * 0.44;
  // 針葉樹の樹皮は暗い灰褐色。筋のコントラストを強く（ピンクの円筒に見せない）
  vec3 dark = vec3(0.023, 0.021, 0.018);
  vec3 light = vec3(0.104, 0.096, 0.078);
  vec3 c = mix(dark, light, smoothstep(0.24, 0.80, streak * 0.65 + streak2 * 0.35) * 0.8 + 0.2 * plates);
  c = mix(c, vec3(0.098, 0.086, 0.062), 0.35 * smoothstep(0.62, 0.9, plates));
  // 縦の裂けを暗い溝として焼き込む
  c *= 1.0 - 0.52 * groove;
  // 枝が幹へ落とす影（λ 45cm の帯）。縦の模様だけだと「縞の入った棒」で終わる
  float limbShade = flip_vnoise(vec3(lp.x * 1.1, lp.y * 2.2 + seed * 9.0, lp.z * 1.1));
  c *= 0.66 + 0.34 * smoothstep(0.22, 0.72, limbShade);
  // **赤みを 0.5 倍に落とす。** ここが桃色だと、樹冠の外から中まで
  // 肌色の棒が縦に通って見える（批評R7 の 4 番②・3 ラウンド同じ）
  c.r = c.g + (c.r - c.g) * 0.50;
  return c;
}
vec4 veg_treeAlbedo(out float relief){
  relief = 0.0;
  if (vTree.y > 0.5) return vec4(FLIP_LINE, 1.0);
  if (vTree.z > 1.5) {
    // 樹冠の内側の殻。葉の 0.35 倍の暗さ（葉の隙間から見える「奥の影」）。
    // **1 色の面にしない。** 殻は 8 面のなめらかな円錐なので、針葉の隙間から見えたときに
    // 「アイスクリームのコーン」として読めてしまう。針葉と同じ細かさのむらを乗せて、
    // 見えても「葉の奥のざらざらした暗がり」に見えるようにする
    float shellM = flip_vnoise(vBark * 11.0) * 0.60 + flip_vnoise(vBark * 31.0) * 0.40;
    relief = shellM;
    vec3 deep = vec3(0.030, 0.066, 0.030) * (0.8 + 0.4 * flip_hash11(vTree.w * 5.0 + 1.0));
    // **穴あきの殻**。半径を 0.14 → 0.42×L に広げて樹冠の中の空の抜けを塞ぐが、
    // 面のままだと「なめらかな緑の円錐」になる。ノイズでアルファを抜いて、
    // 輪郭がぎざぎざの「葉の奥の暗がり」にする
    float shellA = smoothstep(0.04, 0.34, shellM + 0.10);
    return vec4(deep * (0.5 + 1.05 * shellM), shellA);
  }
  if (vTree.z < 0.5) return vec4(veg_bark(vBark, vTree.w, relief), 1.0);
  // アルファのミップは textures.ts が被覆率を保つように作ってあるので、ここでは持ち上げない
  vec4 tex = texture2D(uNeedle, vTreeUv);
  // カードの中の「針の明暗」。法線と AO をこれで揺らすと、1 枚 100px の平らな紙が
  // 針の塊に見える（三角形は 1 枚も増えない。批評 R6 の 5 位②）
  relief = clamp(dot(tex.rgb, vec3(0.30, 0.60, 0.10)) * 13.0, 0.0, 1.0);
  vec3 tint = mix(vec3(1.02, 1.0, 0.88), vec3(0.88, 1.0, 1.10), vTree.w) * (0.86 + 0.28 * flip_hash11(vTree.w * 3.0 + 0.2));
  tint = mix(vec3(1.0), tint, uTintMix);
  return vec4(tex.rgb * tint, min(tex.a * vAlphaK, 1.0));
}
float veg_treeAO(){
  // 樹冠の中ほど・下ほど暗い（自己遮蔽）。枝は幹側ほど暗い
  float hN = clamp(vBark.y / uTreeH, 0.0, 1.0);
  if (vTree.z > 1.5) return 0.5;
  if (vTree.z > 0.5) return (0.42 + 0.58 * fract(vTreeUv.x * 2.0)) * (0.55 + 0.45 * smoothstep(0.05, 0.9, hN));
  // 幹は樹冠の中ほど・上ほど**暗い**（葉に囲まれて光が届かない）。
  // 逆にすると幹が明るい棒として樹冠を突き抜けて見える
  return mix(0.88, 0.26, smoothstep(0.04, 0.34, hN));
}
`;

export type TreeMaterialOpts = { lod: 0 | 1 | 2; H: number; r0: number; r1: number; band: number };

/** 木の材質（幹＋針葉カードを 1 つで）。 */
export function makeTreeMaterial(env: Env, lighting: Lighting, needle: THREE.Texture, o: TreeMaterialOpts, msaa: boolean, uReflect: THREE.IUniform<number> = { value: 0 }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: ALPHA_CUTOFF });
  // アルファ→カバレッジは近景（LOD0）で 4x MSAA のときだけ。
  // サンプル数が少ない／遠い枝では「網戸」のディザとして読めてしまう
  // アルファのミップを被覆率保存で作ったので中間値が減り、4x MSAA なら遠景でも
  // カバレッジのディザが「網戸」に見えない。逆に切ると 1px の空の穴が点として残る
  mat.alphaToCoverage = msaa;
  const uLod = { value: new THREE.Vector4(o.r0, o.r1, o.band, o.lod) };
  patchMaterial(
    mat,
    env,
    (shader) => {
      shader.uniforms.uNeedle = { value: needle };
      shader.uniforms.uLod = uLod;
      shader.uniforms.uTreeH = { value: o.H };
      shader.uniforms.uForceFlip = { value: 0 };
      shader.uniforms.uLineMin = { value: 0 };
      shader.uniforms.uTintMix = { value: 1 };
      shader.uniforms.uReflect = uReflect;
      shader.uniforms.uNeedleSize = { value: needle.image ? (needle.image as HTMLCanvasElement).width : 512 };
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <common>",
        `#include <common>
        #include <flip_noise>
        ${VEG_VERT_COMMON}
        ${TREE_VERT}`,
        "tree vs common",
      );
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <beginnormal_vertex>",
        `vec3 vegP; vec3 vegN; veg_tree(vegP, vegN);
        vec3 objectNormal = vegN;`,
        "tree vs normal",
      );
      shader.vertexShader = replaceOnce(shader.vertexShader, "#include <begin_vertex>", `vec3 transformed = vegP;`, "tree vs begin");
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <common>",
        `#include <common>
        #include <flip_noise>
        #include <flip_height>
        #include <flip_atmosphere>
        #include <flip_flip>
        ${VEG_FRAG_DITHER}
        ${TREE_FRAG_COLOR}`,
        "tree fs common",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        if (vTree.x < fract(veg_ign(gl_FragCoord.xy) + vTree.w)) discard;
        float vegRelief = 0.0;`,
        "tree fs clip",
      );
      shader.fragmentShader = replaceOnce(shader.fragmentShader, "#include <map_fragment>", `diffuseColor = veg_treeAlbedo(vegRelief);`, "tree fs map");
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        if (vTree.z > 0.5 && vTree.z < 1.5) {
          normal = normalize(mix(normal, vConeN, 0.6));
          // 葉のカードの法線を下に向けない（裏を向いたカードだけ真っ黒になるのを止める）。
          // 針葉は薄いので裏から見ても上からの光で明るい
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float dnv = dot(normal, upV);
          if (dnv < 0.0) normal = normalize(normal - 1.7 * dnv * upV);
          // 針の明暗から法線を曲げる（カードの中が 1 色の面にならない）
          vec3 cx1 = dFdx(-vViewPosition), cy1 = dFdy(-vViewPosition);
          vec3 C1 = cross(cy1, normal), C2 = cross(normal, cx1);
          float cdet = dot(cx1, C1);
          vec3 cgrad = sign(cdet) * (dFdx(vegRelief) * 0.030 * C1 + dFdy(vegRelief) * 0.030 * C2);
          normal = normalize(abs(cdet) * normal - cgrad);
        } else if (vTree.y < 0.5) {
          // 樹皮の凹凸（ノイズの画面微分から法線を曲げる）
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
          float det = dot(sx, R1);
          // 樹皮の凹凸を強く出す（縦の裂けを法線に効かせる）
          float bs = 0.090;
          vec3 grad = sign(det) * (dFdx(vegRelief) * bs * R1 + dFdy(vegRelief) * bs * R2);
          normal = normalize(abs(det) * normal - grad);
        }`,
        "tree fs normal",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <lights_fragment_begin>",
        `float vegTrans = (vTree.z > 0.5 && vTree.z < 1.5) ? 0.20 : 0.0;
        // カードは針ごとの陰影を掛ける。これが無いと 1 枚が均一な明るさの紙に見える
        float vegAO = veg_treeAO() * ((vTree.z > 0.5 && vTree.z < 1.5) ? (0.58 + 0.80 * vegRelief) : 1.0);
        float vegSpec = 0.0;
        float vegGloss = 18.0;
        float vegUpMix = 0.25;
        ${VEG_LIGHTS_FRAGMENT}`,
        "tree fs lights",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <fog_fragment>",
        `gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, vVegWorld);
        if (vTree.y > 0.5) {
          vec3 fc = FLIP_LINE * (vTree.z < 0.5 ? 1.3 : 0.8);
          fc += FLIP_ACCENT * flip_edgeGlow(vVegWorld) * 1.5;
          gl_FragColor.rgb = flip_applyAerial(fc, vVegWorld) * 0.7 + fc * 0.3;
        }`,
        "tree fs fog",
      );
    },
    { csm: lighting, key: `veg_tree_v1_${o.lod}` },
  );
  return mat;
}

/** 影用（同じ風・同じ骨組み・同じアルファ） */
export function makeTreeDepthMaterial(env: Env, needle: THREE.Texture, o: TreeMaterialOpts, ignoreFade = false): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide, alphaTest: ALPHA_CUTOFF });
  if (ignoreFade) mat.defines = { VEG_DEPTH_ALL: 1 };
  patchMaterial(
    mat,
    env,
    (shader) => {
      shader.uniforms.uNeedle = { value: needle };
      shader.uniforms.uNeedleSize = { value: needle.image ? (needle.image as HTMLCanvasElement).width : 512 };
      shader.uniforms.uLod = { value: new THREE.Vector4(o.r0, o.r1, o.band, o.lod) };
      shader.uniforms.uTreeH = { value: o.H };
      shader.uniforms.uForceFlip = { value: 0 };
      shader.uniforms.uLineMin = { value: 0 };
      shader.uniforms.uReflect = { value: 0 };
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <common>",
        `#include <common>
        #include <flip_noise>
        ${VEG_VERT_COMMON}
        ${TREE_VERT}`,
        "tree depth vs common",
      );
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <begin_vertex>",
        `vec3 vegP; vec3 vegN; veg_tree(vegP, vegN);
        vec3 transformed = vegP;`,
        "tree depth vs begin",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <common>",
        `#include <common>
        ${VEG_FRAG_DITHER}
        uniform sampler2D uNeedle;
        uniform float uNeedleSize;
        varying vec4 vTree;
        varying vec2 vTreeUv;
        varying float vAlphaK;`,
        "tree depth fs common",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <map_fragment>",
        `#ifndef VEG_DEPTH_ALL
        if (vTree.x < veg_ign(gl_FragCoord.xy)) discard;
        #endif
        if (vTree.z > 0.5 && vTree.z < 1.5 && vTree.y < 0.5) diffuseColor.a = min(texture2D(uNeedle, vTreeUv).a * vAlphaK, 1.0);`,
        "tree depth fs map",
      );
    },
    { key: `veg_tree_depth_v1_${o.lod}_${ignoreFade ? "all" : "fade"}` },
  );
  return mat;
}
