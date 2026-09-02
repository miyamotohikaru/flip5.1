// 針葉樹（トウヒ／モミ系）のプロシージャルな形と材質。
//   幹: テーパー付き円柱（根元に張り出し、少し曲がる）。樹皮の凹凸はフラグメントのノイズ→法線
//   枝: 螺旋（黄金角）の輪生。上ほど短く、下ほど垂れる。針葉はアルファテストのカード
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

export const TREE_VARIANTS: TreeVariant[] = [
  { H: 15, crownBase: 0.2, lmax: 0.14, whorls: 17, perWhorl: 6, sideRatio: 0.55, seed: 1 },
  { H: 12.5, crownBase: 0.05, lmax: 0.185, whorls: 16, perWhorl: 7, sideRatio: 0.55, seed: 2 },
  { H: 17, crownBase: 0.13, lmax: 0.15, whorls: 18, perWhorl: 6, sideRatio: 0.5, seed: 3 },
  { H: 10, crownBase: 0.03, lmax: 0.2, whorls: 14, perWhorl: 7, sideRatio: 0.6, seed: 4 },
];

export type TreeGeo = { geometry: THREE.BufferGeometry; H: number; radius: number; tris: number };

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
  const segs = lod === 0 ? 8 : 6;
  const rings = lod === 0 ? [0, 0.04, 0.12, 0.25, 0.42, 0.6, 0.78, 0.9, 1.0] : [0, 0.12, 0.5, 1.0];
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
  const nW = lod === 0 ? v.whorls : Math.max(6, Math.round(v.whorls * 0.55));
  const top = 0.93;
  let maxR = 0;
  for (let j = 0; j < nW; j++) {
    const u = nW > 1 ? j / (nW - 1) : 0;
    let t = v.crownBase + (top - v.crownBase) * u + (rnd() - 0.5) * 0.02;
    t = Math.min(Math.max(t, v.crownBase), top);
    let L = v.lmax * H * (1 - 0.85 * Math.pow(u, 0.9)) * (0.85 + 0.3 * rnd());
    L = Math.max(L, 0.35);
    const nB = lod === 0 ? v.perWhorl + (rnd() < 0.4 ? 1 : 0) : Math.max(3, v.perWhorl - 2);
    const droop = ((8 + 30 * (1 - u)) * Math.PI) / 180 + (rnd() - 0.5) * 0.25;
    const a0 = axisAt(t), rt = radiusAt(t);
    for (let b = 0; b < nB; b++) {
      const az = j * 2.39996 + (b * Math.PI * 2) / nB + (rnd() - 0.5) * 0.5;
      const Lb = L * (0.8 + 0.4 * rnd());
      maxR = Math.max(maxR, Lb + rt);
      const cd = Math.cos(droop), sd = Math.sin(droop);
      const d = new THREE.Vector3(Math.cos(az) * cd, -sd, Math.sin(az) * cd).normalize();
      const bx = a0.x + Math.cos(az) * rt * 0.6, by = a0.y, bz = a0.z + Math.sin(az) * rt * 0.6;
      const w0 = new THREE.Vector3().crossVectors(d, up).normalize();
      const roll = (rnd() - 0.5) * 1.2;
      const w = w0.clone().applyAxisAngle(d, roll);
      const flex = 0.45 + 0.55 * t;
      const phase = rnd() * 6.2832;
      const cellTop = rnd() < 0.5 ? 0 : 3;
      // 横向きカード（垂れる小枝）: 全部の枝に。幅方向は「下」。少し捻る
      let dn = new THREE.Vector3().crossVectors(w0, d).normalize();
      if (dn.y > 0) dn = dn.negate();
      dn.applyAxisAngle(d, (rnd() - 0.5) * 0.7);
      addCard(bx, by, bz, d, dn, Lb, -0.14 * Lb, 0.42 * Lb, 1, 0.34, 0.9, flex, phase + 1.0, false);
      // 上から見た扇カード: 近景の一部の枝に（上・斜め上から見たときの厚み）
      if (lod === 0 && rnd() < v.sideRatio) addCard(bx, by, bz, d, w, Lb * 0.95, -0.34 * Lb, 0.34 * Lb, cellTop, 0.14, 0.86, flex, phase, false);
    }
  }
  // 梢: 交差する縦カード
  {
    const t0 = 0.86;
    const a0 = axisAt(t0);
    const Ls = (1.03 - t0) * H;
    const wS = 0.05 * H;
    const dx = new THREE.Vector3(1, 0, 0), dz = new THREE.Vector3(0, 0, 1);
    addCard(a0.x, a0.y, a0.z, up, dx, Ls, -wS, wS, 2, 0, 1, 1.0, 0.3, true);
    addCard(a0.x, a0.y, a0.z, up, dz, Ls, -wS, wS, 2, 0, 1, 1.0, 1.9, true);
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
  float fade = 1.0;
  if (uLod.w < 0.5) fade = 1.0 - smoothstep(uLod.x - uLod.z, uLod.x, dist);
  else if (uLod.w < 1.5) fade = smoothstep(uLod.x - uLod.z, uLod.x, dist) * (1.0 - smoothstep(uLod.y - uLod.z, uLod.y, dist));
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
uniform float uTreeH;
varying vec4 vTree;
varying vec3 vVegWorld;
varying vec3 vConeN;
varying vec2 vTreeUv;
varying vec3 vBark;
vec3 veg_bark(vec3 lp, float seed, out float relief){
  float streak = flip_vnoise(vec3(lp.x * 14.0, lp.y * 0.9 + seed * 7.0, lp.z * 14.0));
  float streak2 = flip_vnoise(vec3(lp.x * 30.0, lp.y * 2.2 + seed * 3.0, lp.z * 30.0));
  float plates = flip_vnoise(vec3(lp.x * 6.0, lp.y * 1.6, lp.z * 6.0) + seed * 10.0);
  relief = streak * 0.65 + streak2 * 0.35;
  vec3 dark = vec3(0.10, 0.078, 0.062);
  vec3 light = vec3(0.34, 0.27, 0.21);
  vec3 c = mix(dark, light, smoothstep(0.3, 0.8, relief) * 0.75 + 0.25 * plates);
  c = mix(c, vec3(0.36, 0.33, 0.20), 0.3 * smoothstep(0.62, 0.9, plates));
  return c;
}
vec4 veg_treeAlbedo(out float relief){
  relief = 0.0;
  if (vTree.y > 0.5) return vec4(FLIP_LINE, 1.0);
  if (vTree.z < 0.5) return vec4(veg_bark(vBark, vTree.w, relief), 1.0);
  vec4 tex = texture2D(uNeedle, vTreeUv);
  vec3 tint = mix(vec3(1.08, 1.0, 0.78), vec3(0.82, 1.0, 1.2), vTree.w) * (0.8 + 0.4 * flip_hash11(vTree.w * 3.0 + 0.2));
  return vec4(tex.rgb * tint, tex.a);
}
float veg_treeAO(){
  if (vTree.z > 0.5) return 0.55 + 0.45 * fract(vTreeUv.x * 2.0);
  return 0.55 + 0.45 * smoothstep(0.0, 0.35, vBark.y / uTreeH);
}
`;

export type TreeMaterialOpts = { lod: 0 | 1 | 2; H: number; r0: number; r1: number; band: number };

/** 木の材質（幹＋針葉カードを 1 つで）。 */
export function makeTreeMaterial(env: Env, lighting: Lighting, needle: THREE.Texture, o: TreeMaterialOpts, msaa: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.4 });
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
        if (vTree.x < veg_ign(gl_FragCoord.xy)) discard;
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
        `float vegTrans = vTree.z > 0.5 ? 0.22 : 0.0;
        float vegAO = veg_treeAO();
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
export function makeTreeDepthMaterial(env: Env, needle: THREE.Texture, o: TreeMaterialOpts): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide, alphaTest: 0.4 });
  patchMaterial(
    mat,
    env,
    (shader) => {
      shader.uniforms.uNeedle = { value: needle };
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
        varying vec4 vTree;
        varying vec2 vTreeUv;`,
        "tree depth fs common",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <map_fragment>",
        `if (vTree.x < veg_ign(gl_FragCoord.xy)) discard;
        if (vTree.z > 0.5 && vTree.y < 0.5) diffuseColor.a = texture2D(uNeedle, vTreeUv).a;`,
        "tree depth fs map",
      );
    },
    { key: `veg_tree_depth_v1_${o.lod}` },
  );
  return mat;
}
