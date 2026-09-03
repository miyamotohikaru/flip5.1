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
export const TREE_VARIANTS: TreeVariant[] = [
  { H: 15, crownBase: 0.18, lmax: 0.15, whorls: 9, perWhorl: 14, sideRatio: 0.50, seed: 1 },
  { H: 12.5, crownBase: 0.05, lmax: 0.19, whorls: 9, perWhorl: 13, sideRatio: 0.50, seed: 2 },
  { H: 17, crownBase: 0.12, lmax: 0.155, whorls: 10, perWhorl: 15, sideRatio: 0.45, seed: 3 },
  { H: 10, crownBase: 0.03, lmax: 0.21, whorls: 8, perWhorl: 13, sideRatio: 0.55, seed: 4 },
];

export type TreeGeo = { geometry: THREE.BufferGeometry; H: number; radius: number; tris: number };

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
  const rnd = () => hash2(rc++, v.seed * 31 + lod * 7, 5);
  const H = v.H;
  const r0 = 0.011 * H + 0.04;
  const curveA = rnd() * Math.PI * 2;
  const curveAmt = 0.008 * H * (0.5 + rnd());
  const axisAt = (t: number) => ({ x: Math.cos(curveA) * curveAmt * t * t, y: t * H, z: Math.sin(curveA) * curveAmt * t * t });
  const radiusAt = (t: number) => r0 * (Math.pow(1 - t, 0.85) + 0.015) * (1 + 0.6 * Math.exp(-t * 30));

  // ---- 幹
  const segs = lod === 0 ? 8 : 5;
  const rings = lod === 0 ? [0, 0.04, 0.12, 0.25, 0.42, 0.6, 0.78, 0.9, 1.0] : [0, 0.35, 1.0];
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

  // ---- カード
  const addCard = (
    bx: number, by: number, bz: number,
    d: THREE.Vector3, w: THREE.Vector3, L: number, vA: number, vB: number,
    cell: number, texV0: number, texV1: number, flex: number, phase: number, spire: boolean,
  ) => {
    const n = new THREE.Vector3().crossVectors(w, d).normalize();
    if (!spire && n.y < 0) n.negate();
    const start = pos.length / 3;
    const cx = (cell % 2) * CELL, cy = Math.floor(cell / 2) * CELL;
    const corners: [number, number][] = [[0, vA], [1, vA], [0, vB], [1, vB]];
    for (const [u, vv] of corners) {
      const px = bx + d.x * u * L + w.x * vv, py = by + d.y * u * L + w.y * vv, pz = bz + d.z * u * L + w.z * vv;
      pos.push(px, py, pz);
      nrm.push(n.x, n.y, n.z);
      const tv = (vv - vA) / (vB - vA);
      if (spire) uv.push(cx + (0.15 + 0.7 * tv) * CELL, cy + (0.98 - 0.94 * u) * CELL);
      else uv.push(cx + u * CELL, cy + (texV0 + (texV1 - texV0) * tv) * CELL);
      data.push(1, flex * (0.35 + 0.65 * u), phase, cell);
      axis.push(bx + d.x * u * L, by + d.y * u * L, bz + d.z * u * L);
      dir.push(d.x, d.y, d.z);
    }
    idx.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  };

  const up = new THREE.Vector3(0, 1, 0);
  const nW = lod === 0 ? v.whorls : Math.max(4, Math.round(v.whorls * 0.55));
  const top = 0.88;
  let maxR = 0;
  // 1 段の枝を丸ごと 1 つの高さに置くと「皿」に見える。段の高さ（±0.05H）と
  // 枝ごとの高さ（±0.05H）を別々に散らして、段の境目を溶かす。
  const spanT = top - v.crownBase;
  const branch = (t: number, u: number, L: number, az: number, flex: number, spire: boolean) => {
    const a0 = axisAt(t), rt = radiusAt(t);
    // 垂れ角 15+35(1-u)° ±10°
    const droop = ((15 + 35 * (1 - u)) * Math.PI) / 180 + (rnd() - 0.5) * 0.35;
    const Lb = Math.max(L * (0.55 + 0.9 * rnd()), 0.28); // 枝長 ±45%
    maxR = Math.max(maxR, Lb * Math.cos(droop) + rt);
    const cd = Math.cos(droop), sd = Math.sin(droop);
    const d = new THREE.Vector3(Math.cos(az) * cd, -sd, Math.sin(az) * cd).normalize();
    const bx = a0.x + Math.cos(az) * rt * 0.6, by = a0.y, bz = a0.z + Math.sin(az) * rt * 0.6;
    const w0 = new THREE.Vector3().crossVectors(d, up).normalize();
    const phase = rnd() * 6.2832;
    const cellTop = rnd() < 0.5 ? 0 : 3;
    // 横向きカード（垂れる小枝）: 全部の枝に。幅方向は「下」。少し捻る
    let dn = new THREE.Vector3().crossVectors(w0, d).normalize();
    if (dn.y > 0) dn = dn.negate();
    dn.applyAxisAngle(d, (rnd() - 0.5) * 0.8);
    addCard(bx, by, bz, d, dn, Lb, -0.16 * Lb, 0.40 * Lb, 1, 0.32, 0.92, flex, phase + 1.0, false);
    // 上から見た扇カード: 一部の枝に（上・斜め上から見たときの厚み）
    if (lod === 0 && !spire && rnd() < v.sideRatio) {
      const w = w0.clone().applyAxisAngle(d, (rnd() - 0.5) * 1.2);
      addCard(bx, by, bz, d, w, Lb * 0.95, -0.32 * Lb, 0.32 * Lb, cellTop, 0.14, 0.86, flex, phase, false);
    }
  };
  for (let j = 0; j < nW; j++) {
    const u = nW > 1 ? j / (nW - 1) : 0;
    const tW = v.crownBase + spanT * u + (rnd() - 0.5) * 0.10;
    const L = v.lmax * H * (1 - 0.82 * Math.pow(u, 0.95));
    const nB = lod === 0 ? v.perWhorl + (rnd() < 0.5 ? 1 : 0) : Math.max(4, Math.round(v.perWhorl * 0.44));
    for (let b = 0; b < nB; b++) {
      // 黄金角で回して、段どうしの枝が同じ方位に並ばないようにする
      const az = j * 2.39996 + (b * Math.PI * 2) / nB + (rnd() - 0.5) * 0.9;
      const t = Math.min(Math.max(tW + (rnd() - 0.5) * 0.10, v.crownBase * 0.8), top);
      branch(t, Math.max(0, Math.min(1, (t - v.crownBase) / Math.max(spanT, 1e-3))), L, az, 0.45 + 0.55 * t, false);
    }
  }
  // 梢: 交差カード 2 枚だと電球に見えるので、短い輪生 3 段の小さな円錐にする
  {
    const tips = lod === 0 ? [0.88, 0.935, 0.975] : [0.92];
    const nb = lod === 0 ? 5 : 3;
    for (let s = 0; s < tips.length; s++) {
      const t0 = tips[s];
      const Ls = v.lmax * H * 0.30 * (1 - 0.6 * s);
      for (let b = 0; b < nb; b++) {
        const az = s * 1.7 + (b * Math.PI * 2) / nb + (rnd() - 0.5) * 0.6;
        branch(t0, 1.0, Ls * (1.4 + 0.4 * rnd()), az, 1.0, true);
      }
    }
    // 先端の一本（頂芽）
    const a0 = axisAt(0.975);
    const wS = 0.022 * H;
    addCard(a0.x, a0.y, a0.z, up, new THREE.Vector3(1, 0, 0), (1.035 - 0.975) * H, -wS, wS, 2, 0, 1, 1.0, 0.3, true);
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
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H * 0.5, 0), Math.hypot(H * 0.55, radius));
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-radius, -0.5, -radius), new THREE.Vector3(radius, H * 1.05, radius));
  return { geometry: geo, H, radius, tris: idx.length / 3 };
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
varying vec4 vTree;     // fade, 裏返し, 種類, 個体シード
varying vec3 vVegWorld;
varying vec3 vConeN;
varying vec2 vTreeUv;
varying vec3 vBark;
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
  float lodJit = flip_hash11(seed * 31.0 + 5.0);
  float sw0 = uLod.x - uLod.z * lodJit;
  float sw1 = uLod.y - uLod.z * lodJit;
  float fade = 1.0;
  if (uLod.w < 0.5) fade = step(dist, sw0);
  else if (uLod.w < 1.5) fade = step(sw0, dist) * step(dist, sw1);
  vec3 lp = position;
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
uniform float uTintMix;   // 1 = 個体ごとの色味を掛ける / 0 = 掛けない（インポスターの焼き込み用）
vec3 veg_bark(vec3 lp, float seed, out float relief){
  float streak = flip_vnoise(vec3(lp.x * 14.0, lp.y * 0.9 + seed * 7.0, lp.z * 14.0));
  float streak2 = flip_vnoise(vec3(lp.x * 30.0, lp.y * 2.2 + seed * 3.0, lp.z * 30.0));
  float plates = flip_vnoise(vec3(lp.x * 6.0, lp.y * 1.6, lp.z * 6.0) + seed * 10.0);
  relief = streak * 0.65 + streak2 * 0.35;
  // 針葉樹の樹皮は暗い灰褐色。筋のコントラストを強く（ピンクの円筒に見せない）
  vec3 dark = vec3(0.036, 0.028, 0.022);
  vec3 light = vec3(0.20, 0.16, 0.12);
  vec3 c = mix(dark, light, smoothstep(0.24, 0.80, relief) * 0.8 + 0.2 * plates);
  c = mix(c, vec3(0.145, 0.125, 0.085), 0.35 * smoothstep(0.62, 0.9, plates));
  return c;
}
vec4 veg_treeAlbedo(out float relief){
  relief = 0.0;
  if (vTree.y > 0.5) return vec4(FLIP_LINE, 1.0);
  if (vTree.z < 0.5) return vec4(veg_bark(vBark, vTree.w, relief), 1.0);
  vec4 tex = texture2D(uNeedle, vTreeUv);
  // ミップで平均されたアルファを持ち上げる。持ち上げないと遠くの枝が
  // 半透明の膜になり、アルファ→カバレッジのディザが「網戸」として見える
  vec2 duv = fwidth(vTreeUv) * uNeedleSize;
  float ndLod = clamp(log2(max(max(duv.x, duv.y), 1.0)) - 0.4, 0.0, 3.0);
  tex.a = clamp(tex.a * (1.0 + 0.34 * ndLod), 0.0, 1.0);
  vec3 tint = mix(vec3(1.02, 1.0, 0.88), vec3(0.88, 1.0, 1.10), vTree.w) * (0.86 + 0.28 * flip_hash11(vTree.w * 3.0 + 0.2));
  tint = mix(vec3(1.0), tint, uTintMix);
  return vec4(tex.rgb * tint, tex.a);
}
float veg_treeAO(){
  // 樹冠の中ほど・下ほど暗い（自己遮蔽）。枝は幹側ほど暗い
  float hN = clamp(vBark.y / uTreeH, 0.0, 1.0);
  if (vTree.z > 0.5) return (0.42 + 0.58 * fract(vTreeUv.x * 2.0)) * (0.55 + 0.45 * smoothstep(0.05, 0.9, hN));
  return (0.5 + 0.5 * smoothstep(0.0, 0.35, hN)) * (0.6 + 0.4 * smoothstep(0.25, 0.95, hN));
}
`;

export type TreeMaterialOpts = { lod: 0 | 1 | 2; H: number; r0: number; r1: number; band: number };

/** 木の材質（幹＋針葉カードを 1 つで）。 */
export function makeTreeMaterial(env: Env, lighting: Lighting, needle: THREE.Texture, o: TreeMaterialOpts, msaa: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.4 });
  // アルファ→カバレッジは近景（LOD0）で 4x MSAA のときだけ。
  // サンプル数が少ない／遠い枝では「網戸」のディザとして読めてしまう
  mat.alphaToCoverage = msaa && o.lod === 0;
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
        if (vTree.z > 0.5) {
          normal = normalize(mix(normal, vConeN, 0.6));
        } else if (vTree.y < 0.5) {
          // 樹皮の凹凸（ノイズの画面微分から法線を曲げる）
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
          float det = dot(sx, R1);
          float bs = 0.045;
          vec3 grad = sign(det) * (dFdx(vegRelief) * bs * R1 + dFdy(vegRelief) * bs * R2);
          normal = normalize(abs(det) * normal - grad);
        }`,
        "tree fs normal",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <lights_fragment_begin>",
        `float vegTrans = vTree.z > 0.5 ? 0.20 : 0.0;
        float vegAO = veg_treeAO();
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
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide, alphaTest: 0.4 });
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
        varying vec2 vTreeUv;`,
        "tree depth fs common",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <map_fragment>",
        `#ifndef VEG_DEPTH_ALL
        if (vTree.x < veg_ign(gl_FragCoord.xy)) discard;
        #endif
        if (vTree.z > 0.5 && vTree.y < 0.5) {
          vec2 duv = fwidth(vTreeUv) * uNeedleSize;
          float ndLod = clamp(log2(max(max(duv.x, duv.y), 1.0)) - 0.4, 0.0, 3.0);
          diffuseColor.a = clamp(texture2D(uNeedle, vTreeUv).a * (1.0 + 0.34 * ndLod), 0.0, 1.0);
        }`,
        "tree depth fs map",
      );
    },
    { key: `veg_tree_depth_v1_${o.lod}_${ignoreFade ? "all" : "fade"}` },
  );
  return mat;
}
