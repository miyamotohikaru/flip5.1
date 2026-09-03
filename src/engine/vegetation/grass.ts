// 草。GPU 配置: インスタンス ID → カメラ周りの格子セル（距離順に並べた表）→ hash で位置・向き・高さ・色。
// 1 インスタンス = 1 株。4 つの環（0-4.5m / 4.5-14m / 14-38m / 38m-）が相補的にクロスフェードし、
// さらに環の中でも (dRef/dist)^1.4 で間引いて、画面上の密度を距離によらず一定に保つ（環の継ぎ目が消える）。
// **段（segments）は三角形の単価**。近い環だけ 2 段にして、中景・遠景は 1 段（1 葉 = 1 三角形）にすることで
// 同じ三角形の予算で本数を 2 倍にしている（「刈った芝に黒い雑草」を「連続した芝」にするのは本数）。
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
  /** 遠景で溶け込ませる先（地形の草色そのもの）。ここへ寄せないと黒い点の散らばりに見える */
  far: new THREE.Color(0.058, 0.125, 0.032),
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
  /** ここより遠い株は (dRef/dist)^thinPow で間引く（画面上の密度を一定に保つ） */
  dRef: number;
  /** 間引きの指数。環の外径での密度が次の環の密度と一致するように決める（継ぎ目を消す） */
  thinPow: number;
  /** 森の床（下草・落ち葉）をこの環でどれだけ出すか 0..1 */
  floor: number;
  /** 影を落とすインスタンスの割合（距離順なので手前から） */
  shadowFrac: number;
};

// 葉身の実寸（m）。本物のイネ科は 3〜8mm。環が遠いほど少しだけ太くする（画素より細いと消えるため）
const RING_W = [0.010, 0.016, 0.029, 0.042];
// 葉の長さの基準（m）。個体は 0.4〜1.4 倍
const RING_H = [0.34, 0.34, 0.32, 0.29];
// 株の広がり（m）
const RING_SPREAD = [0.10, 0.16, 0.26, 0.40];
// 環の外径（m）。いちばん外は q.grassRadius
const RING_R = [4.5, 14, 38];
// 株あたりの葉数と段数（段数 = 三角形の単価。1 段 = 1 葉 1 三角形）
const RING_BLADES = [5, 4, 3, 3];

/** 近い環から順の「葉の本数 / m²」。品質段階で決める。ここが密度の唯一のつまみ。 */
function ringDensity(tier: string): number[] {
  switch (tier) {
    case "low": return [110, 26, 8, 1.0];
    case "mid": return [140, 34, 11, 1.2];
    case "ultra": return [320, 115, 38, 1.8];
    default: return [250, 88, 27, 0.9];
  }
}

/**
 * 環の設計。葉が細い（1cm）ぶん、近くは「濃く」ないと芝生に見えない。
 * 画面に占める面積は距離の 2 乗で小さくなるので、環の中でも (dRef/dist)^1.4 で間引き、
 * 隣り合う環の境目で密度が連続するように dRef を決めてある。
 */
function ringSpecs(q: QualitySettings): Ring[] {
  const R = Math.max(q.grassRadius, RING_R[2] + 6);
  const dens = ringDensity(q.tier);
  // 携帯は描画呼び出しを 1 つでも減らしたいので、いちばん外の 2 環をまとめて 3 環にする
  const small = q.tier === "low";
  const rings = small ? 3 : 4;
  const rOut = small ? [RING_R[0], RING_R[1], R] : [RING_R[0], RING_R[1], RING_R[2], R];
  const rIn = [0, RING_R[0], RING_R[1], RING_R[2]];
  const band = small ? [1.6, 2.4, 8.0] : [1.6, 2.4, 4.0, 10.0];
  // 間引きの基準距離: 環の内径のあたりから 1/d^1.4 で薄くする（境目で密度がつながる）
  const dRef = [2.6, 5.0, 14, 38];
  // 各環の外径で密度が次の環と一致するような指数（環の境目に段差を出さない）
  const thinPow: number[] = [];
  for (let i = 0; i < 4; i++) {
    const dNext = i + 1 < dens.length ? dens[i + 1] : dens[i] * 0.17;
    const rEnd = i < rOut.length ? rOut[i] : R;
    const ratio = Math.max(1e-3, dNext / dens[i]);
    const k = Math.min(0.999, dRef[i] / Math.max(rEnd, dRef[i] + 0.1));
    thinPow.push(Math.min(2.4, Math.max(1.0, Math.log(ratio) / Math.log(k))));
  }
  const segments = [q.tier === "low" ? 1 : 2, 1, 1, 1];
  const floor = [1.0, 1.0, 0.9, 0.7];
  const shadowFrac = [0.25, 0, 0, 0];
  const out: Ring[] = [];
  for (let i = 0; i < rings; i++) {
    const cell = Math.sqrt(RING_BLADES[i] / dens[i]);
    out.push({
      cell, rIn: rIn[i], rOut: rOut[i], band: band[i],
      blades: RING_BLADES[i], segments: segments[i],
      height: RING_H[i], width: RING_W[i], spread: Math.min(RING_SPREAD[i], cell * 0.85),
      dRef: dRef[i], thinPow: thinPow[i], floor: floor[i], shadowFrac: shadowFrac[i],
    });
  }
  return out;
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
uniform vec2 uFloor;  // x = 森の床（下草・落ち葉）をこの環で出す割合 0..1, y = 間引きの指数
uniform vec4 uLabVeg;  // 実験室のつまみ。x = 草の密度の倍率（既定 1）
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
  // 水面下・水際には 1 本も生やさない。植生マップは 8m/texel なので岸ぎわで水中へ漏れる。
  // 葉ごとに実際の地形の高さを見て、湖面より低ければその場で畳む
  if (h < uLakeLevel + 0.30) {
    p = root; n = vec3(0.0, 1.0, 0.0);
    vGrass = vec4(0.0); vBlade = vec4(0.0); vVegWorld = root;
    return;
  }
  float dist = distance(root2, uCamPos.xz);
  vec3 tn = flip_terrainNormal(root2, 0.9);
  vec4 vm = texture2D(uVegMap, root2 * uVegMapInfo.y + 0.5);
  // 森の床: 草が薄いところ（vm.r）でも林（vm.g）が濃ければ下草と落ち葉を生やす。
  // これが無いと森の地面が「ぼやけた緑一色」になる
  float floorD = smoothstep(0.12, 0.34, vm.g) * (0.62 + 0.38 * vm.g) * uFloor.x;
  // 裸の土（岩でも雪でもない斜面）にも、短い草をまばらに生やす。
  // これが無いと傾いた土の面が「無地の絵の具」に見える（批評 R3 の 5 位）
  float slope = 1.0 - tn.y;
  float dirtD = (1.0 - vm.a) * smoothstep(0.03, 0.16, slope) * 0.95 * uFloor.x;
  float onFloor = step(vm.r * 0.8 + 0.03, floorD);
  float onDirt = step(max(vm.r * 0.9, floorD) + 0.02, dirtD);
  // 植生マップの草地は 0.5 前後。そのまま確率に使うと草原でも半分しか生えず「刈った芝」に見える。
  // 生える／生えないの境目だけ残して、草地の中では満杯にする
  float density = max(max(smoothstep(0.03, 0.52, vm.r), floorD), dirtD);
  density *= 1.0 - smoothstep(0.52, 0.82, slope);
  density *= smoothstep(uLakeLevel + 0.30, uLakeLevel + 0.75, h);
  density *= 1.0 - smoothstep(380.0, 420.0, h);
  // 細かい斑（同じセルの株は同じ斑）
  density *= 0.84 + 0.32 * flip_vnoise(root2 * 0.35 + 3.0);
  // 画面での密度を保つ間引き: 遠いほど 1/d² で減らす。環の内側は密、外側は疎になり継ぎ目が消える
  density *= clamp(pow(uBlade.w / max(dist, 0.5), uFloor.y), 0.0, 1.0);
  density *= uLabVeg.x; // 実験室の「草の密度」（既定 1）
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
  float shortP = smoothstep(0.58, 0.26, pch);
  // 株の種類: 4% は広葉の雑草、1.2% は花穂
  float kindR = flip_hash11(rc * 53.0 + 11.0);
  float broad = step(0.96, kindR) * (1.0 - onFloor);
  float spike = step(0.952, kindR) * (1.0 - broad) * (1.0 - onFloor);
  // 床は 45% がシダ・コケの下草、55% が落ち葉（地面に寝た短い葉）
  float fern = onFloor * step(0.55, kindR);
  float litter = onFloor * (1.0 - step(0.55, kindR));
  float kind = broad + spike * 2.0 + fern * 3.0 + litter * 4.0;
  float H = uBlade.x * (0.4 + 1.0 * rnd) * (0.88 + 0.12 * density) * scale;
  H *= 1.0 - 0.26 * shortP;
  float W = uBlade.y * (0.8 + 0.4 * rnd2) * (0.75 + 0.25 * scale);
  W *= 1.0 - 0.10 * shortP;
  if (broad > 0.5) { W *= 2.4; H *= 0.60; }
  if (spike > 0.5) { W *= 0.55; H *= 1.7; }
  if (fern > 0.5) { W *= 1.5; H *= 0.95; }
  if (litter > 0.5) { W *= 1.25; H *= 0.34; }
  // 土の斜面の草は短い（丈 0.5 倍）。斜面にすがりつく低い草
  if (onDirt > 0.5) { H *= 0.6; W *= 1.0; }
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
  float lineKeep = step(flip_hash12(cw * 1.91 + k * 5.31 + 4.0), 0.10);
  vec3 up = vec3(0.0, 1.0, 0.0);
  if (flipped > 0.5) {
    if (lineKeep < 0.5) { p = root; n = up; vGrass = vec4(t, rnd, 0.0, 1.0); vBlade = vec4(0.0); vVegWorld = p; return; }
    // 数式ビュー: 1本ずつが「風のベクトル」。向きを揃えないと全方向のひっかき傷に見える。
    // 長さは実際の草の 1/3、太さの向きは画面に正対させる（どの線も同じ太さで読める）
    float lw = 0.005 + dist * 0.0013;
    vec3 toCam = uCamPos - root;
    vec3 sideV = normalize(cross(up, toCam) + vec3(1e-5, 0.0, 0.0));
    vec3 lean = vec3(wd.x, 0.0, wd.y) * (0.30 + 0.45 * gust);
    float HL = H * 0.34;
    p = root + sideV * (position.x * lw) + up * (HL * t) + lean * HL * t;
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
      const uFloor = { value: new THREE.Vector2(ring.floor, ring.thinPow) };
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
        #include <flip_height>
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
          const vec3 GRASS_FERN = vec3(${c.fern.r}, ${c.fern.g}, ${c.fern.b});
          const vec3 GRASS_FAR = vec3(${c.far.r}, ${c.far.g}, ${c.far.b});`,  // uCamPos は flip_atmosphere が宣言済み
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
            // 遠くの葉は地形の草色へ溶かす。1 本ずつが黒い点として読めるのを防ぐ
            float vd = distance(vVegWorld.xz, uCamPos.xz);
            vec3 farCol = mix(GRASS_FAR, GRASS_DRY * 0.6, clamp(dry * 1.3, 0.0, 1.0));
            if (vBlade.y > 2.5) farCol = mix(farCol, col, 0.5);
            col = mix(col, farCol, 0.85 * smoothstep(18.0, 62.0, vd));
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
