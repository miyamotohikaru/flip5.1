// 岩と小石。
//   岩: ノイズで削ったイコサ球（数種）。CPU で配置（placement.ts）。近くは高解像度の動的リスト、
//       遠くは 512m チャンクの低解像度。地面に半分埋める。材質はトライプラナー風の層理ノイズ＋苔（北側・谷側）
//   小石: GPU 配置（草と同じ格子）。岸辺の帯（湖面 +0.05〜+1.8m）に、MAIN_ONLY
//   裏返し: ワイヤーフレーム（重心座標）
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { LAYER } from "../core/pipeline";
import { patchMaterial, replaceOnce } from "../core/patch";
import type { QualitySettings } from "../core/quality";
import { WORLD, sampleHeightmap as sampleHeightmapLocal } from "../core/heightfield";
import { fbm2, hash2 } from "../core/noise";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { forEachInRadius, scatterRocks, type Scatter } from "./placement";
import type { VegMap } from "./vegmap";
import { VEG_FRAG_DITHER, VEG_VERT_COMMON } from "./shaders";

const ROCK_VARIANTS = 4;

/** ノイズで削ったイコサ球。重心座標付き（非インデックス）。 */
export function buildRock(seed: number, detail: number): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, detail);
  const pos = base.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // 個体の潰れ方向と「割れ面」
  const sx = 0.85 + 0.5 * hash2(seed, 1, 9), sy = 0.55 + 0.35 * hash2(seed, 2, 9), sz = 0.85 + 0.5 * hash2(seed, 3, 9);
  const planes: THREE.Vector4[] = [];
  const nPlanes = 2 + Math.floor(hash2(seed, 4, 9) * 3);
  for (let i = 0; i < nPlanes; i++) {
    const n = new THREE.Vector3(hash2(seed, 10 + i, 9) - 0.5, hash2(seed, 20 + i, 9) - 0.5, hash2(seed, 30 + i, 9) - 0.5).normalize();
    planes.push(new THREE.Vector4(n.x, n.y, n.z, 0.55 + 0.35 * hash2(seed, 40 + i, 9)));
  }
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = fbm2(v.x * 1.6 + seed * 3.1, v.z * 1.6 + v.y * 1.1 - seed * 1.7, 3);
    const n2 = fbm2(v.y * 4.0 + seed, v.x * 4.0 - v.z * 3.0 + seed * 2.0, 2);
    let r = 1 + 0.28 * n1 + 0.08 * n2;
    v.multiplyScalar(r);
    // 割れ面で削る
    for (const p of planes) {
      const d = v.x * p.x + v.y * p.y + v.z * p.z;
      if (d > p.w) v.addScaledVector(new THREE.Vector3(p.x, p.y, p.z), -(d - p.w) * 0.85);
    }
    v.x *= sx;
    v.y *= sy;
    v.z *= sz;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  // 頂点を共有させて滑らかな法線に（細部はフラグメントのノイズ法線で）
  const merged = mergeVertices(base, 1e-4);
  merged.computeVertexNormals();
  const geo = merged.toNonIndexed();
  merged.dispose();
  const count = geo.getAttribute("position").count;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 3) {
    bary.set([1, 0, 0], i * 3);
    bary.set([0, 1, 0], (i + 1) * 3);
    bary.set([0, 0, 1], (i + 2) * 3);
  }
  geo.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
  geo.computeBoundingSphere();
  base.dispose();
  return geo;
}

const ROCK_VERT = /* glsl */ `
attribute vec3 aBary;
uniform vec4 uRockLod; // x = 近景の外径, y = 帯, z = 遠景の外径, w = モード(0 近, 1 遠)
varying vec3 vBary;
varying vec3 vVegWorld;
varying vec3 vRockN;
varying vec4 vRock; // fade, 裏返し, seed, scale
void veg_rock(out vec3 p, out vec3 n){
  mat4 im = instanceMatrix;
  vec3 root = im[3].xyz;
  float scl = max(length(im[1].xyz), 1e-4);
  float dist = distance(root.xz, uCamPos.xz);
  float fade = 1.0;
  if (uRockLod.w < 0.5) fade = 1.0 - smoothstep(uRockLod.x - uRockLod.y, uRockLod.x, dist);
  else fade = smoothstep(uRockLod.x - uRockLod.y, uRockLod.x, dist) * (1.0 - smoothstep(uRockLod.z * 0.85, uRockLod.z, dist));
  float seed = flip_hash12(floor(root.xz * 2.3 + 0.5));
  float fm = veg_flipMask(root);
  float flipped = step(flip_hash11(seed * 7.0 + 0.3), fm) * step(0.001, fm);
  p = position;
  n = normal;
  vBary = aBary;
  vRock = vec4(fade, flipped, seed, scl);
  vVegWorld = (im * vec4(p, 1.0)).xyz;
  vRockN = normalize(mat3(im) * n);
}
`;

const ROCK_FRAG = /* glsl */ `
varying vec3 vBary;
varying vec3 vVegWorld;
varying vec3 vRockN;
varying vec4 vRock;
// 岩肌: 層理（world y の縞）＋ 粒状ノイズ ＋ 苔（上向き・北側/谷側・湿り）
vec3 veg_rockColor(out float relief, out float moss){
  vec3 w = vVegWorld;
  float strata = flip_vnoise(vec3(w.x * 0.35, w.y * 2.6 + flip_vnoise(w * 0.8) * 1.5, w.z * 0.35));
  float grain = flip_vfbm(w.xz * 6.0 + w.y * 3.0, 3);
  float grain2 = flip_vnoise(w * 25.0);
  relief = strata * 0.5 + grain * 0.35 + grain2 * 0.15;
  vec3 dark = vec3(0.075, 0.07, 0.068);
  vec3 light = vec3(0.30, 0.28, 0.255);
  vec3 warm = vec3(0.30, 0.23, 0.17);
  vec3 c = mix(dark, light, smoothstep(0.2, 0.85, relief));
  c = mix(c, warm, 0.4 * smoothstep(0.5, 0.8, strata) * vRock.z);
  // 割れ目の暗さ（縞の谷）
  c *= 0.6 + 0.4 * smoothstep(0.15, 0.45, strata);
  // 地衣類の斑
  float lichen = smoothstep(0.6, 0.75, flip_vnoise(w * 3.0 + vRock.z * 9.0));
  c = mix(c, vec3(0.40, 0.43, 0.30), lichen * 0.55);
  // 苔: 上を向く面、北側（-z）と谷側（原点向き）、標高が低いほど、湿りで増える
  vec3 toValley = normalize(vec3(-w.x, 0.0, -w.z) + vec3(1e-3));
  float side = 0.5 + 0.35 * dot(vRockN, vec3(0.0, 0.0, -1.0)) + 0.25 * dot(vRockN, toValley);
  float up = smoothstep(0.1, 0.7, vRockN.y);
  float mossN = flip_vfbm(w.xz * 1.7 + w.y * 0.7, 3);
  moss = smoothstep(0.28, 0.7, up * side * (0.7 + 0.8 * mossN) * (1.0 - smoothstep(150.0, 450.0, w.y)) * (0.85 + 0.5 * uWetness));
  c = mix(c, vec3(0.10, 0.17, 0.05) * (0.8 + 0.5 * grain), moss);
  return c;
}
`;

type Tier = { nearR: number; farR: number; band: number; capNear: number; cell: number; pebbles: number; pebbleR: number };
function tierSettings(q: QualitySettings): Tier {
  switch (q.tier) {
    case "low":
      return { nearR: 50, farR: 400, band: 10, capNear: 120, cell: 16, pebbles: 700, pebbleR: 18 };
    case "mid":
      return { nearR: 70, farR: 600, band: 12, capNear: 160, cell: 14, pebbles: 1400, pebbleR: 24 };
    case "ultra":
      return { nearR: 130, farR: 1200, band: 20, capNear: 300, cell: 12, pebbles: 3200, pebbleR: 40 };
    default:
      return { nearR: 95, farR: 900, band: 14, capNear: 220, cell: 12, pebbles: 2400, pebbleR: 32 };
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Rocks {
  scatter: Scatter;
  near: THREE.InstancedMesh[] = [];
  far: THREE.InstancedMesh[] = [];
  pebbles: THREE.Mesh;
  tier: Tier;
  private lastBuild = new THREE.Vector3(1e9, 0, 1e9);
  private cascadeIndex = new Map<THREE.Camera, number>();
  /** 調査用: ?dbg=rocktest でカメラの前に岩を並べる */
  private rockTest = false;
  stats = { rocks: 0, near: 0 };

  constructor(parent: THREE.Object3D, public env: Env, public lighting: Lighting, public q: QualitySettings, public vegmap: VegMap) {
    const t = (this.tier = tierSettings(q));
    for (let i = 0; i < lighting.csm.lights.length; i++) this.cascadeIndex.set(lighting.csm.lights[i].shadow.camera, i);
    const dbg = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("dbg") ?? "") : "";
    this.rockTest = dbg.includes("rocktest");
    this.scatter = scatterRocks(env.heightmap, vegmap, t.cell, ROCK_VARIANTS);
    this.stats.rocks = this.scatter.count;
    const geosHi = Array.from({ length: ROCK_VARIANTS }, (_, i) => buildRock(i + 1, 2));
    const geoLo = buildRock(1, 0);
    const matNear = this.buildMaterial(new THREE.Vector4(t.nearR, t.band, t.farR, 0));
    const matFar = this.buildMaterial(new THREE.Vector4(t.nearR, t.band, t.farR, 1));

    // 近景: 動的リスト（種類ごと）
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const m = new THREE.InstancedMesh(geosHi[v], matNear, t.capNear);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.matrixAutoUpdate = false;
      let saved = 0;
      m.onBeforeShadow = (_r, _o, _c, cam) => {
        saved = m.count;
        if ((this.cascadeIndex.get(cam) ?? 0) >= 2) m.count = 0;
      };
      m.onAfterShadow = () => {
        m.count = saved;
      };
      parent.add(m);
      this.near.push(m);
    }
    // 遠景: 1024m チャンクに 1 メッシュ（形は 1 種。遠いので向きの違いだけで十分）
    const chunk = 1024;
    const n = Math.ceil(WORLD.size / chunk);
    const sc = this.scatter;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < sc.count; i++) {
      if (sc.s[i] < 1.2) continue; // 小さい岩は遠くでは見えない
      const cx = Math.min(n - 1, Math.floor((sc.x[i] + WORLD.half) / chunk));
      const cz = Math.min(n - 1, Math.floor((sc.z[i] + WORLD.half) / chunk));
      const key = cx * n + cz;
      let a = buckets.get(key);
      if (!a) buckets.set(key, (a = []));
      a.push(i);
    }
    for (const [, list] of buckets) {
      const m = new THREE.InstancedMesh(geoLo, matFar, list.length);
      const box = new THREE.Box3();
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        this.composeMatrix(i, _m);
        m.setMatrixAt(k, _m);
        box.expandByPoint(_p.set(sc.x[i], sc.y[i], sc.z[i]));
      }
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      sphere.radius += 6;
      m.boundingSphere = sphere;
      m.frustumCulled = true;
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      parent.add(m);
      this.far.push(m);
    }

    // 小石（GPU 配置）
    this.pebbles = this.buildPebbles(t);
    parent.add(this.pebbles);
  }

  private composeMatrix(i: number, out: THREE.Matrix4) {
    const sc = this.scatter;
    _e.set(sc.tiltX[i], sc.yaw[i], sc.tiltZ[i], "YXZ");
    _q.setFromEuler(_e);
    _p.set(sc.x[i], sc.y[i], sc.z[i]);
    _s.setScalar(sc.s[i]);
    out.compose(_p, _q, _s);
  }

  private buildMaterial(lod: THREE.Vector4) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        shader.uniforms.uRockLod = { value: lod };
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          ${VEG_VERT_COMMON}
          ${ROCK_VERT}`,
          "rock vs common",
        );
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <beginnormal_vertex>",
          `vec3 vegP; vec3 vegN; veg_rock(vegP, vegN);
          vec3 objectNormal = vegN;`,
          "rock vs normal",
        );
        shader.vertexShader = replaceOnce(shader.vertexShader, "#include <begin_vertex>", `vec3 transformed = vegP;`, "rock vs begin");
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          #include <flip_atmosphere>
          #include <flip_flip>
          uniform float uWetness;
          ${VEG_FRAG_DITHER}
          ${ROCK_FRAG}`,
          "rock fs common",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          if (vRock.x < veg_ign(gl_FragCoord.xy)) discard;
          float vegRelief = 0.0;
          float vegMoss = 0.0;`,
          "rock fs clip",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <map_fragment>",
          `diffuseColor.rgb = veg_rockColor(vegRelief, vegMoss);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6, uWetness * 0.7);`,
          "rock fs map",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.5, uWetness * 0.7);
          roughnessFactor = mix(roughnessFactor, 0.98, vegMoss);`,
          "rock fs rough",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          {
            vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
            vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
            float det = dot(sx, R1);
            float bs = 0.09 * (1.0 - 0.7 * vegMoss);
            vec3 grad = sign(det) * (dFdx(vegRelief) * bs * R1 + dFdy(vegRelief) * bs * R2);
            normal = normalize(abs(det) * normal - grad);
          }`,
          "rock fs normal",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <fog_fragment>",
          `gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, vVegWorld);
          if (vRock.y > 0.5) {
            // ワイヤーフレーム: 重心座標の縁
            vec3 d = fwidth(vBary);
            vec3 e = smoothstep(vec3(0.0), d * 1.5, vBary);
            float wire = 1.0 - min(min(e.x, e.y), e.z);
            vec3 fc = FLIP_BG + FLIP_LINE * wire * 0.9;
            fc += FLIP_ACCENT * flip_edgeGlow(vVegWorld) * 1.5;
            gl_FragColor.rgb = flip_applyAerial(fc, vVegWorld) * 0.7 + fc * 0.3;
          }`,
          "rock fs fog",
        );
      },
      { csm: this.lighting, key: `veg_rock_v1_${lod.w}` },
    );
    return mat;
  }

  /** 小石: 岸辺の帯に GPU 配置。20 面のイコサ球を hash で潰す。 */
  private buildPebbles(t: Tier): THREE.Mesh {
    const base = new THREE.IcosahedronGeometry(1, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("normal", base.getAttribute("normal"));
    geo.setAttribute("uv", base.getAttribute("uv"));
    // カメラの周りの格子（距離順）
    const R = t.pebbleR;
    const cs = Math.sqrt((Math.PI * R * R) / t.pebbles);
    const n = Math.ceil(R / cs);
    const list: { x: number; z: number; d: number }[] = [];
    for (let z = -n; z <= n; z++) {
      for (let x = -n; x <= n; x++) {
        const d = Math.hypot((x + 0.5) * cs, (z + 0.5) * cs);
        if (d <= R + cs) list.push({ x, z, d });
      }
    }
    list.sort((a, b) => a.d - b.d);
    const off = new Float32Array(list.length * 2);
    for (let i = 0; i < list.length; i++) {
      off[i * 2] = list[i].x;
      off[i * 2 + 1] = list[i].z;
    }
    geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(off, 2));
    geo.instanceCount = list.length;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        shader.uniforms.uPebble = { value: new THREE.Vector4(cs, R, 0, 0) };
        shader.uniforms.uVegMap = { value: this.vegmap.texture };
        shader.uniforms.uVegMapInfo = { value: this.vegmap.info };
        shader.uniforms.uShore = { value: this.vegmap.shore };
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          #include <flip_height>
          ${VEG_VERT_COMMON}
          uniform vec4 uPebble;
          uniform sampler2D uVegMap;
          uniform sampler2D uShore;
          uniform vec4 uVegMapInfo;
          attribute vec2 aCell;
          varying vec3 vVegWorld;
          varying vec4 vPeb; // seed, 裏返し, 湿り, fade`,
          "pebble vs common",
        );
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <beginnormal_vertex>",
          `float cs = uPebble.x;
          vec2 camCell = floor(uCamPos.xz / cs);
          vec2 cell = camCell + aCell;
          vec2 cw = mod(cell, 8192.0);
          vec2 hj = flip_hash22(cw * 0.61 + 3.0);
          vec2 root2 = (cell + hj) * cs;
          float h = flip_height(root2);
          vec3 tn = flip_terrainNormal(root2, 0.6);
          float dist = distance(root2, uCamPos.xz);
          // 岸線のすぐそば（水際ほど密）に多く、内陸はガレ場だけ。水中と急斜面には無い
          float shore = texture2D(uShore, root2 * uVegMapInfo.y + 0.5).r;
          shore = shore * shore * step(uLakeLevel + 0.01, h);
          float inland = 0.05 * texture2D(uVegMap, root2 * uVegMapInfo.y + 0.5).a;
          float density = (shore * (0.55 + 0.45 * flip_vnoise(root2 * 0.3)) + inland) * (1.0 - smoothstep(0.3, 0.6, 1.0 - tn.y));
          density *= 1.0 - smoothstep(uPebble.y * 0.75, uPebble.y, dist);
          float hh = flip_hash12(cw * 1.91 + 7.0);
          float alive = smoothstep(0.0, 0.08, density - hh);
          float seed = flip_hash12(cw * 3.7 + 1.0);
          // 大きさ: 小さいものが多く、まれに大きい。水際ほど小さい
          float size = (0.02 + 0.13 * pow(flip_hash11(seed * 3.0), 2.6)) * (0.7 + 0.5 * (1.0 - shore)) * alive;
          vec3 sq = vec3(0.75 + 0.6 * flip_hash11(seed * 5.0), 0.4 + 0.5 * flip_hash11(seed * 7.0), 0.75 + 0.6 * flip_hash11(seed * 11.0));
          float yaw = seed * 6.2832;
          float tiltA = (flip_hash11(seed * 17.0) - 0.5) * 0.7;
          mat3 rotY = mat3(cos(yaw), 0.0, -sin(yaw), 0.0, 1.0, 0.0, sin(yaw), 0.0, cos(yaw));
          mat3 rotX = mat3(1.0, 0.0, 0.0, 0.0, cos(tiltA), sin(tiltA), 0.0, -sin(tiltA), cos(tiltA));
          mat3 rot = rotY * rotX;
          vec3 lp = rot * (position * sq) * size;
          // 少し埋める
          vec3 wp = vec3(root2.x, h + size * sq.y * 0.35, root2.y) + lp;
          // 地面の傾きに沿わせる（法線で回す簡易版: 上向きベクトルを地形法線へ）
          vec3 objectNormal = normalize(rot * (normal / sq));
          float fm = veg_flipMask(vec3(root2.x, h, root2.y));
          float flipped = step(flip_hash11(seed * 13.0), fm) * step(0.001, fm);
          vPeb = vec4(seed, flipped, smoothstep(uLakeLevel + 0.6, uLakeLevel + 0.1, h), alive);
          vVegWorld = wp;`,
          "pebble vs normal",
        );
        shader.vertexShader = replaceOnce(shader.vertexShader, "#include <begin_vertex>", `vec3 transformed = wp;`, "pebble vs begin");
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          #include <flip_atmosphere>
          #include <flip_flip>
          uniform float uWetness;
          varying vec3 vVegWorld;
          varying vec4 vPeb;`,
          "pebble fs common",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <map_fragment>",
          `{
            float s = vPeb.x;
            vec3 grey = mix(vec3(0.30, 0.29, 0.27), vec3(0.55, 0.52, 0.47), flip_hash11(s * 3.0));
            vec3 warm = vec3(0.46, 0.36, 0.27);
            vec3 c = mix(grey, warm, step(0.7, flip_hash11(s * 9.0)) * 0.6);
            float speck = flip_vnoise(vVegWorld * 40.0);
            c *= 0.85 + 0.3 * speck;
            float wet = max(vPeb.z, uWetness);
            c = mix(c, c * 0.55, wet * 0.8);
            diffuseColor.rgb = c;
          }`,
          "pebble fs map",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.35, max(vPeb.z, uWetness) * 0.8);`,
          "pebble fs rough",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <fog_fragment>",
          `gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, vVegWorld);
          if (vPeb.y > 0.5) {
            vec3 fc = FLIP_BG + FLIP_LINE * 0.7;
            fc += FLIP_ACCENT * flip_edgeGlow(vVegWorld) * 1.5;
            gl_FragColor.rgb = flip_applyAerial(fc, vVegWorld) * 0.7 + fc * 0.3;
          }`,
          "pebble fs fog",
        );
      },
      { csm: this.lighting, key: "veg_pebble_v1" },
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER.MAIN_ONLY);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  update() {
    const cam = this.env.cameraPos;
    const dx = cam.x - this.lastBuild.x, dz = cam.z - this.lastBuild.z;
    if (dx * dx + dz * dz < 8 * 8) return;
    this.lastBuild.copy(cam);
    const t = this.tier;
    const sc = this.scatter;
    const lists: number[][] = Array.from({ length: ROCK_VARIANTS }, () => []);
    forEachInRadius(sc, cam.x, cam.z, t.nearR + 10, (i) => lists[sc.v[i]].push(i));
    let total = 0;
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const list = lists[v];
      const mesh = this.near[v];
      if (list.length > t.capNear) {
        list.sort((a, b) => Math.hypot(sc.x[a] - cam.x, sc.z[a] - cam.z) - Math.hypot(sc.x[b] - cam.x, sc.z[b] - cam.z));
        list.length = t.capNear;
      }
      for (let k = 0; k < list.length; k++) {
        this.composeMatrix(list[k], _m);
        mesh.setMatrixAt(k, _m);
      }
      mesh.count = list.length;
      if (this.rockTest) {
        // カメラの前 6〜14m に、種類ごとに大きさ違いで並べる（調査用）
        const yaw = this.env.camera.rotation.y;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        for (let k = 0; k < 3 && mesh.count < t.capNear; k++) {
          const sSize = [0.6, 1.4, 2.6][k];
          const side = (v - 1.5) * 2.2 + (k - 1) * 0.6;
          const dist = 7 + k * 3.5;
          const x = cam.x + fx * dist - fz * side, z = cam.z + fz * dist + fx * side;
          _e.set(0.2 * v, v * 1.3 + k, 0.1 * k, "YXZ");
          _q.setFromEuler(_e);
          const hm = this.env.heightmap;
          const ground = hm ? sampleHeightmapLocal(hm, x, z) : 0;
          _p.set(x, ground - sSize * 0.3, z);
          _s.setScalar(sSize);
          _m.compose(_p, _q, _s);
          mesh.setMatrixAt(mesh.count++, _m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      total += list.length;
    }
    this.stats.near = total;
  }
}
