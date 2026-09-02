// 草。GPU 配置: インスタンス ID → カメラ周りの格子セル（距離順に並べた表）→ hash で位置・向き・高さ・色。
// 1 インスタンス = 1 株。3 つの環（近 5葉×3段 / 中 3葉×2段 / 遠 3葉×1段）が相補的にクロスフェードし、
// さらに環の中でも (dRef/dist)^1.4 で間引いて、画面上の密度を距離によらず一定に保つ（環の継ぎ目が消える）。
// 葉幅は 1〜3cm（本物のイネ科は 3〜8mm。遠い環だけ画素より細くならないよう太くする）。
// 林の中（vegmap の G が濃いところ）では、草の代わりに下草（シダ）と落ち葉を生やして「森の床」にする。
// 風は uWind と突風ノイズ。影は落とす（近い環の手前 25% だけ、第1カスケードだけ）。
// 裏返し: 6 本に 1 本だけを線にして、残りは畳む（白い針の塊にしない）。
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { LAYER } from "../core/pipeline";
import { patchMaterial, replaceOnce } from "../core/patch";
import type { QualitySettings } from "../core/quality";
import type { VegMap } from "./vegmap";
import { VEG_LIGHTS_FRAGMENT, VEG_VERT_COMMON } from "./shaders";

/**
 * 草の色（線形 RGB）。地形の草色と揃えること。
 * 地形担当が草地の色を変えたら、ここの TIP / TIP2 / DRY を地形の grass / dryGrass に寄せる。
 * 遠くの草（環 C）は先端色がほぼそのまま見えるので、TIP の平均 ≒ 地形の草色 にするのがコツ。
 */
export const GRASS_COLORS = {
  root: new THREE.Color(0.038, 0.075, 0.020),
  tip: new THREE.Color(0.110, 0.210, 0.050),
  tip2: new THREE.Color(0.140, 0.200, 0.060),
  dry: new THREE.Color(0.265, 0.218, 0.096),
  /** 森の床: 落ち葉（針葉のリター）と下草のシダ・コケ */
  litter: new THREE.Color(0.047, 0.038, 0.021),
  fern: new THREE.Color(0.046, 0.090, 0.036),
};

type Ring = {
  cell: number;
  rIn: number;
  rOut: number;
  band: number;
  blades: number;
  segments: number;
  height: number;
  width: number;
  /** 株の広がり（m）。1 つのインスタンス = 1 株で、葉はこの半径にばらける */
  spread: number;
  /** ここより遠い株は (dRef/dist)^2 で間引く（画面上の密度を一定に保ち、環の継ぎ目を消す） */
  dRef: number;
  /** 森の床（下草・落ち葉）をこの環でどれだけ出すか 0..1 */
  floor: number;
  /** 影を落とすインスタンスの割合（距離順なので手前から） */
  shadowFrac: number;
};

// 葉身の実寸（m）。本物のイネ科は 3〜8mm。環が遠いほど少しだけ太くする（画素より細いと消えるため）
const W_A = 0.010, W_B = 0.021, W_C = 0.030;
// 葉の長さの基準（m）。個体は 0.4〜1.4 倍
const H_A = 0.34, H_B = 0.32, H_C = 0.27;

/**
 * 環の設計。葉が細い（1cm）ぶん、近くは「濃く」ないと芝生に見えない。
 * 画面に占める面積は距離の 2 乗で小さくなるので、株の間隔もおおよそ距離に比例させる
 * （環 A の 6m で 250本/m²、環 B の 20m で 35本/m²、環 C の 90m で 3本/m²）。
 */
function ringSpecs(q: QualitySettings): Ring[] {
  const R = q.grassRadius;
  // 携帯は視界の半径そのものが小さいので、近景の環は相対的に広く取らないと
  // 画面の大半（縦画面の下半分）が疎な中景の環になってしまう
  const small = q.tier === "low" || q.tier === "mid";
  const rA = R * (small ? 0.10 : 0.05), rB = R * 0.24, rC = R;
  const N = q.grassCount * (small ? 1.0 : 0.78);
  // 環ごとの「株の間隔」の比。株あたりの葉数を bA/bB/bC にして、総葉数が N になるよう csA を解く
  const kB = 2.55, kC = 8.4;
  const bA = 5, bB = 3, bC = 3;
  const K =
    bA * Math.PI * rA * rA +
    (bB * Math.PI * (rB * rB - rA * rA)) / (kB * kB) +
    (bC * Math.PI * (rC * rC - rB * rB)) / (kC * kC);
  const csA = Math.sqrt(K / N);
  const segA = small ? 2 : 3;
  return [
    { cell: csA, rIn: 0, rOut: rA, band: 2.0, blades: bA, segments: segA, height: H_A, width: W_A, spread: 0.10, dRef: rA * 0.55, floor: 1.0, shadowFrac: 0.25 },
    { cell: csA * kB, rIn: rA, rOut: rB, band: 2.5, blades: bB, segments: 2, height: H_B, width: W_B, spread: 0.18, dRef: rA * 1.45, floor: 1.0, shadowFrac: 0 },
    { cell: csA * kC, rIn: rB, rOut: rC, band: 10, blades: bC, segments: 1, height: H_C, width: W_C, spread: 0.34, dRef: rB * 1.25, floor: 0.7, shadowFrac: 0 },
  ];
}

/** 環のセル表（カメラのセルからのオフセット、距離順） */
function buildOffsets(ring: Ring): Float32Array {
  const cs = ring.cell;
  const n = Math.ceil((ring.rOut + cs) / cs);
  const inner = Math.max(0, ring.rIn - ring.band - cs);
  const outer = ring.rOut + ring.band * 0.3 + cs;
  const list: { x: number; z: number; d: number }[] = [];
  for (let z = -n; z <= n; z++) {
    for (let x = -n; x <= n; x++) {
      const d = Math.hypot((x + 0.5) * cs, (z + 0.5) * cs);
      if (d < inner || d > outer) continue;
      list.push({ x, z, d });
    }
  }
  list.sort((a, b) => a.d - b.d);
  const out = new Float32Array(list.length * 2);
  for (let i = 0; i < list.length; i++) {
    out[i * 2] = list[i].x;
    out[i * 2 + 1] = list[i].z;
  }
  return out;
}

/** 葉身: 根元が太く先が細い帯。position = (横 -0.5..0.5, 縦 0..1, 株の何本目か) */
function bladeGeometry(segments: number, blades: number, offsets: Float32Array): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const base = pos.length / 3;
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      pos.push(-0.5, t, b, 0.5, t, b);
      uv.push(0, t, 1, t);
    }
    pos.push(0, 1, b);
    uv.push(0.5, 1);
    const tip = base + segments * 2;
    for (let s = 0; s < segments - 1; s++) {
      const a = base + s * 2, c = a + 2;
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
    const last = base + (segments - 1) * 2;
    idx.push(last, last + 1, tip);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(offsets, 2));
  geo.instanceCount = offsets.length / 2;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

const GRASS_PLACE = /* glsl */ `
uniform vec4 uRing;   // x = セル(m), y = 内径, z = 外径, w = 株の広がり(m)
uniform vec4 uBlade;  // x = 高さ(m), y = 幅(m), z = フェード帯(m), w = 間引きの基準距離(m)
uniform float uFloor; // 森の床（下草・落ち葉）をこの環で出す割合 0..1
uniform sampler2D uVegMap;
uniform vec4 uVegMapInfo;
attribute vec2 aCell;
varying vec4 vGrass;   // t, rnd, 乾き, 裏返し
varying vec4 vBlade;   // 横位置(-1..1), 種類(0=葉 1=広葉 2=花穂 3=シダ 4=落ち葉), 接地の暗さ, 葉ごとの位相
varying vec3 vVegWorld;
void veg_grass(out vec3 p, out vec3 n){
  float cs = uRing.x;
  vec2 camCell = floor(uCamPos.xz / cs);
  vec2 cell = camCell + aCell;
  vec2 cw = mod(cell, 8192.0);
  float k = position.z;
  vec2 hj = flip_hash22(cw * 0.731 + 11.0);
  vec2 root2 = (cell + hj) * cs;
  // 株の中で葉を散らす（1 インスタンス = 1 株）。中心の 1 本はそのまま
  if (k > 0.5) {
    vec2 j2 = flip_hash22(cw * 1.37 + k * 3.1) - 0.5;
    root2 += j2 * uRing.w * (0.6 + 0.8 * length(j2));
  }
  float h = flip_height(root2);
  vec3 root = vec3(root2.x, h, root2.y);
  float dist = distance(root2, uCamPos.xz);
  vec3 tn = flip_terrainNormal(root2, 0.9);
  vec4 vm = texture2D(uVegMap, root2 * uVegMapInfo.y + 0.5);
  // 森の床: 草が薄いところ（vm.r）でも林（vm.g）が濃ければ下草と落ち葉を生やす。
  // これが無いと森の地面が「ぼやけた緑一色」になる
  float floorD = smoothstep(0.22, 0.48, vm.g) * vm.g * 0.95 * uFloor;
  float onFloor = step(vm.r * 0.8 + 0.03, floorD);
  float density = max(vm.r, floorD);
  density *= 1.0 - smoothstep(0.42, 0.72, 1.0 - tn.y);
  density *= smoothstep(uLakeLevel + 0.22, uLakeLevel + 0.8, h);
  density *= 1.0 - smoothstep(380.0, 420.0, h);
  // 細かい斑（同じセルの株は同じ斑）
  density *= 0.7 + 0.6 * flip_vnoise(root2 * 0.35 + 3.0);
  // 画面での密度を保つ間引き: 遠いほど 1/d² で減らす。環の内側は密、外側は疎になり継ぎ目が消える
  density *= clamp(pow(uBlade.w / max(dist, 0.5), 1.4), 0.0, 1.0);
  float band = uBlade.z;
  float ringFade = smoothstep(uRing.y - band, uRing.y + band * 0.3, dist) * (1.0 - smoothstep(uRing.z - band, uRing.z + band * 0.3, dist));
  float hh = flip_hash12(cw * 2.17 + 5.0 + k * 0.37);
  float scale = smoothstep(0.0, 0.12, density * ringFade - hh);
  // 乱数: 株ごと（rc）と葉ごと（rb）。高さは株に強く相関させる（1本だけ飛び出さない）
  float rc = flip_hash12(cw * 3.3 + 1.0);
  float rb = flip_hash12(cw * 3.3 + k * 7.7 + 1.0);
  float rnd = mix(rc, rb, 0.3);
  float rnd2 = flip_hash11(rb * 91.7 + 3.0);
  // λ≒12m の斑: 3〜4 割を短く・薄くする（一様な絨毯にしない）
  float pch = flip_vnoise(root2 * 0.083 + 17.0);
  float shortP = smoothstep(0.70, 0.32, pch);
  // 株の種類: 4% は広葉の雑草、1.2% は花穂
  float kindR = flip_hash11(rc * 53.0 + 11.0);
  float broad = step(0.96, kindR) * (1.0 - onFloor);
  float spike = step(0.952, kindR) * (1.0 - broad) * (1.0 - onFloor);
  // 床は 45% がシダ・コケの下草、55% が落ち葉（地面に寝た短い葉）
  float fern = onFloor * step(0.55, kindR);
  float litter = onFloor * (1.0 - step(0.55, kindR));
  float kind = broad + spike * 2.0 + fern * 3.0 + litter * 4.0;
  float H = uBlade.x * (0.4 + 1.0 * rnd) * (0.88 + 0.12 * density) * scale;
  H *= 1.0 - 0.35 * shortP;
  float W = uBlade.y * (0.8 + 0.4 * rnd2) * (0.75 + 0.25 * scale);
  W *= 1.0 - 0.15 * shortP;
  if (broad > 0.5) { W *= 2.4; H *= 0.60; }
  if (spike > 0.5) { W *= 0.55; H *= 1.7; }
  if (fern > 0.5) { W *= 2.1; H *= 0.80; }
  if (litter > 0.5) { W *= 1.5; H *= 0.32; }
  #ifdef VEG_SHADOW_PASS
  // 影用: 葉身が影テクセル（8cm）より細いと影が消えるので、株の影の塊として太らせる
  W = max(W * 3.5, 0.038) * step(0.001, H);
  #endif
  float yaw = rnd2 * 6.2832 + k * 2.1;
  vec3 side = vec3(cos(yaw), 0.0, sin(yaw));
  vec3 bendDir = vec3(-side.z, 0.0, side.x);
  float t = position.y;
  // 葉は弓なりに反る。反りが強いほど上面が見えて明るく、シルエットも柔らかくなる
  float curl = (0.20 + 0.70 * flip_hash11(rb * 5.0 + 9.0)) * (broad > 0.5 ? 1.6 : 1.0);
  // 下草は大きく広がり、落ち葉（針葉のリター）はほぼ地面に寝る
  if (fern > 0.5) curl *= 1.8;
  if (litter > 0.5) curl = 1.2 + 1.1 * flip_hash11(rb * 9.0 + 2.0);
  vec2 wd = veg_windDir();
  float gust = veg_gust(root2);
  float windAmt = (0.03 + 0.05 * uWind.z) * gust;
  float flutter = sin(uTime * (2.2 + 2.0 * rnd) + rnd * 25.0 + dot(root2, wd) * 0.8) * (0.015 + 0.012 * uWind.z) * (0.5 + gust);
  vec3 lat = bendDir * (curl + flutter) + vec3(wd.x, 0.0, wd.y) * windAmt;
  // 反りが強いと縦の縮み項が効きすぎて葉が地面へ潜る。1.0 で頭打ちにする
  float latLen = min(length(lat), 1.0);
  float tt = t * t;
  float fm = veg_flipMask(root);
  float flipped = step(flip_hash12(cw * 0.53 + k * 3.19 + 2.0), fm) * step(0.001, fm);
  // 数式ビューでは 6 本に 1 本だけを線にする（白い針の塊にしない）
  float lineKeep = step(flip_hash12(cw * 1.91 + k * 5.31 + 4.0), 0.17);
  vec3 up = vec3(0.0, 1.0, 0.0);
  if (flipped > 0.5) {
    if (lineKeep < 0.5) { p = root; n = up; vGrass = vec4(t, rnd, 0.0, 1.0); vBlade = vec4(0.0); vVegWorld = p; return; }
    // 数式ビュー: 1本ずつが「向きと長さのベクトル」= 根元から先端への直線
    float lw = 0.005 + dist * 0.0013;
    p = root + side * (position.x * lw) + up * (H * t * (1.0 - 0.4 * latLen * latLen)) + lat * H * t;
    n = up;
  } else {
    // 根元は細く、中ほどで最も太く、先は尖る（帯ではなく葉身に見せる）
    float wTaper = broad > 0.5 ? (1.0 - 0.55 * tt)
      : (fern > 0.5 || litter > 0.5) ? (1.0 - 0.85 * tt)
      : (0.72 + 0.62 * t - 0.34 * tt) * (1.0 - 0.55 * tt * tt);
    p = root + side * (position.x * W * wTaper) + up * (H * t * (1.0 - 0.45 * latLen * latLen * tt)) + lat * H * tt;
    n = normalize(cross(side, up + lat * 2.0 * t));
    // 葉の断面は V 字。横位置で法線を倒す＝縦の照りが出る
    n = normalize(mix(n, up, 0.35) + side * position.x * 0.9);
  }
  // 乾いた株は 2 割以下。vm.b（乾き）は株ごとの抽選を通してから使う
  // 乾き: 全体に薄く（乾いた土地では地形も黄ばむので色を合わせる）＋ 14% の株ははっきり枯れる
  float dryClump = clamp(0.34 * smoothstep(0.32, 0.92, vm.b)
    + step(0.86, flip_hash11(rc * 41.0 + 7.0)) * smoothstep(0.30, 0.85, vm.b), 0.0, 1.0);
  vGrass = vec4(t, rnd, dryClump, flipped);
  vBlade = vec4(position.x * 2.0, kind, 1.0 - smoothstep(0.0, 0.22, t), rb);
  vVegWorld = p;
}
`;

export class Grass {
  meshes: THREE.Mesh[] = [];
  private cascadeIndex = new Map<THREE.Camera, number>();

  constructor(parent: THREE.Object3D, public env: Env, public lighting: Lighting, public q: QualitySettings, public vegmap: VegMap) {
    for (let i = 0; i < lighting.csm.lights.length; i++) this.cascadeIndex.set(lighting.csm.lights[i].shadow.camera, i);
    const dbg = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("dbg") ?? "") : "";
    const noShadow = dbg.includes("grassnoshadow");
    const rings = ringSpecs(q);
    for (const ring of rings) {
      const offsets = buildOffsets(ring);
      const geo = bladeGeometry(ring.segments, ring.blades, offsets);
      const uRing = { value: new THREE.Vector4(ring.cell, ring.rIn, ring.rOut, Math.min(ring.spread, ring.cell * 0.85)) };
      const uBlade = { value: new THREE.Vector4(ring.height, ring.width, ring.band, ring.dRef) };
      const uFloor = { value: ring.floor };
      const mat = this.buildMaterial(uRing, uBlade, uFloor);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER.MAIN_ONLY);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      const total = geo.instanceCount;
      if (ring.shadowFrac > 0 && !noShadow) {
        mesh.castShadow = true;
        mesh.customDepthMaterial = this.buildDepthMaterial(uRing, uBlade, uFloor);
        const shadowCount = Math.floor(total * ring.shadowFrac);
        mesh.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
          const idx = this.cascadeIndex.get(shadowCamera) ?? 0;
          geo.instanceCount = idx === 0 ? shadowCount : 0;
        };
        mesh.onAfterShadow = () => {
          geo.instanceCount = total;
        };
      }
      parent.add(mesh);
      this.meshes.push(mesh);
    }
  }

  private vertexInject(shader: THREE.WebGLProgramParametersWithUniforms, uRing: THREE.IUniform, uBlade: THREE.IUniform, uFloor: THREE.IUniform) {
    shader.uniforms.uRing = uRing;
    shader.uniforms.uBlade = uBlade;
    shader.uniforms.uFloor = uFloor;
    shader.uniforms.uVegMap = { value: this.vegmap.texture };
    shader.uniforms.uVegMapInfo = { value: this.vegmap.info };
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      "#include <common>",
      `#include <common>
      #include <flip_noise>
      #include <flip_height>
      ${VEG_VERT_COMMON}
      ${GRASS_PLACE}`,
      "grass vs common",
    );
  }

  private buildMaterial(uRing: THREE.IUniform, uBlade: THREE.IUniform, uFloor: THREE.IUniform) {
    const c = GRASS_COLORS;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        this.vertexInject(shader, uRing, uBlade, uFloor);
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <beginnormal_vertex>",
          `vec3 vegP; vec3 vegN; veg_grass(vegP, vegN);
          vec3 objectNormal = vegN;`,
          "grass vs normal",
        );
        shader.vertexShader = replaceOnce(shader.vertexShader, "#include <begin_vertex>", `vec3 transformed = vegP;`, "grass vs begin");
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          #include <flip_atmosphere>
          #include <flip_flip>
          varying vec4 vGrass;
          varying vec4 vBlade;
          varying vec3 vVegWorld;
          const vec3 GRASS_ROOT = vec3(${c.root.r}, ${c.root.g}, ${c.root.b});
          const vec3 GRASS_TIP = vec3(${c.tip.r}, ${c.tip.g}, ${c.tip.b});
          const vec3 GRASS_TIP2 = vec3(${c.tip2.r}, ${c.tip2.g}, ${c.tip2.b});
          const vec3 GRASS_DRY = vec3(${c.dry.r}, ${c.dry.g}, ${c.dry.b});
          const vec3 GRASS_LITTER = vec3(${c.litter.r}, ${c.litter.g}, ${c.litter.b});
          const vec3 GRASS_FERN = vec3(${c.fern.r}, ${c.fern.g}, ${c.fern.b});`,
          "grass fs common",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <map_fragment>",
          `{
            // MSAA は葉身より細い三角形で varying を範囲外へ外挿する。pow(負) が NaN になるので必ず clamp
            float t = clamp(vGrass.x, 0.0, 1.0), rnd = vGrass.y, dry = clamp(vGrass.z, 0.0, 1.0);
            vec3 tip = mix(GRASS_TIP, GRASS_TIP2, flip_hash11(rnd * 7.1));
            vec3 col = mix(GRASS_ROOT, tip, smoothstep(0.0, 0.55, t));
            col = mix(col, GRASS_DRY, dry * (0.15 + 0.48 * t));
            // 広葉は少し濃く、花穂は先が枯れ色
            if (vBlade.y > 3.5) {
              // 落ち葉（針葉のリター）: 茶色く、根元まで一様
              col = GRASS_LITTER * (0.75 + 0.5 * rnd) * (0.85 + 0.3 * flip_hash11(vBlade.w * 17.0));
            } else if (vBlade.y > 2.5) {
              // 下草（シダ・コケ）: 暗い青緑
              col = mix(GRASS_FERN * 0.55, GRASS_FERN, smoothstep(0.0, 0.6, t)) * (0.8 + 0.4 * rnd);
            } else if (vBlade.y > 1.5) col = mix(col, GRASS_DRY * 0.75, smoothstep(0.60, 0.95, t));
            else if (vBlade.y > 0.5) col *= vec3(0.62, 0.72, 0.55);
            col *= 0.9 + 0.2 * rnd;
            // 葉の質感: 縦筋（3本の稜）と、透ける縁の明るさ
            float ax = min(abs(vBlade.x), 1.0);
            float rib = 0.5 + 0.5 * cos(vBlade.x * 9.4);
            col *= 0.92 + 0.16 * rib;
            col *= 1.0 + 0.28 * smoothstep(0.74, 1.0, ax) * (1.0 - 0.75 * step(0.5, vBlade.y));
            // 根元は影に沈む（株の接地）
            col *= 1.0 - 0.46 * clamp(vBlade.z, 0.0, 1.0);
            diffuseColor.rgb = col;
          }`,
          "grass fs map",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <lights_fragment_begin>",
          `float vegT = clamp(vGrass.x, 0.0, 1.0);
          float vegTrans = 0.25 + 0.75 * vegT;
          float vegAO = (0.30 + 0.70 * pow(vegT, 0.7)) * (1.0 - 0.42 * clamp(vBlade.z, 0.0, 1.0));
          float vegSpec = vBlade.y > 2.5 ? 0.0 : 0.035;   // 落ち葉・下草はつやを出さない（白い点になる）
          float vegGloss = 14.0;
          float vegUpMix = 0.65;
          ${VEG_LIGHTS_FRAGMENT}`,
          "grass fs lights",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <fog_fragment>",
          `gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, vVegWorld);
          if (vGrass.w > 0.5) {
            vec3 fc = FLIP_LINE * (0.4 + 0.6 * vGrass.x) * 1.3;
            fc += FLIP_ACCENT * flip_edgeGlow(vVegWorld) * 1.5;
            gl_FragColor.rgb = flip_applyAerial(fc, vVegWorld) * 0.7 + fc * 0.3;
          }`,
          "grass fs fog",
        );
      },
      { csm: this.lighting, key: "veg_grass_v1" },
    );
    return mat;
  }

  private buildDepthMaterial(uRing: THREE.IUniform, uBlade: THREE.IUniform, uFloor: THREE.IUniform) {
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    mat.defines = { VEG_SHADOW_PASS: 1 };
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        this.vertexInject(shader, uRing, uBlade, uFloor);
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <begin_vertex>",
          `vec3 vegP; vec3 vegN; veg_grass(vegP, vegN);
          vec3 transformed = vegP;`,
          "grass depth vs begin",
        );
      },
      { key: "veg_grass_depth_v1" },
    );
    return mat;
  }

  update() {
    /* 配置はすべて GPU。CPU では何もしない */
  }
}
