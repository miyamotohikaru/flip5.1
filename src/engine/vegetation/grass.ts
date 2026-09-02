// 草。GPU 配置: インスタンス ID → カメラ周りの格子セル（距離順に並べた表）→ hash で位置・向き・高さ・色。
// 3 つの環（近: 3本の株×3段 / 中: 1本×2段 / 遠: 1本×1段）を相補的にクロスフェードして、
// 近くは密に、遠くは地形の草色に溶ける。風は uWind と突風ノイズ。影は落とす（近い環だけ、第1カスケードだけ）。
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
  root: new THREE.Color(0.07, 0.115, 0.035),
  tip: new THREE.Color(0.30, 0.42, 0.115),
  tip2: new THREE.Color(0.36, 0.43, 0.15),
  dry: new THREE.Color(0.47, 0.40, 0.18),
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
  /** 影を落とすインスタンスの割合（距離順なので手前から） */
  shadowFrac: number;
};

function ringSpecs(q: QualitySettings): Ring[] {
  const R = q.grassRadius;
  const rA = R * 0.16, rB = R * 0.45, rC = R;
  const N = q.grassCount * 0.5;
  const kB = 1.4, kC = 2.8;
  const K = 5 * Math.PI * rA * rA + (2 * Math.PI * (rB * rB - rA * rA)) / (kB * kB) + (Math.PI * (rC * rC - rB * rB)) / (kC * kC);
  const csA = Math.sqrt(K / N);
  const segA = q.tier === "low" ? 2 : 3;
  return [
    { cell: csA, rIn: 0, rOut: rA, band: 2.5, blades: 5, segments: segA, height: 0.42, width: 0.034, shadowFrac: 1 },
    { cell: csA * kB, rIn: rA, rOut: rB, band: 2.5, blades: 2, segments: 2, height: 0.42, width: 0.045, shadowFrac: 0 },
    { cell: csA * kC, rIn: rB, rOut: rC, band: 10, blades: 1, segments: 1, height: 0.4, width: 0.06, shadowFrac: 0 },
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
uniform vec4 uBlade;  // x = 高さ(m), y = 幅(m), z = フェード帯(m), w = 未使用
uniform sampler2D uVegMap;
uniform vec4 uVegMapInfo;
attribute vec2 aCell;
varying vec4 vGrass;   // t, rnd, 乾き, 裏返し
varying vec3 vVegWorld;
void veg_grass(out vec3 p, out vec3 n){
  float cs = uRing.x;
  vec2 camCell = floor(uCamPos.xz / cs);
  vec2 cell = camCell + aCell;
  vec2 cw = mod(cell, 8192.0);
  float k = position.z;
  vec2 hj = flip_hash22(cw * 0.731 + 11.0);
  vec2 root2 = (cell + hj) * cs;
  if (k > 0.5) root2 += (flip_hash22(cw * 1.37 + k * 3.1) - 0.5) * uRing.w;
  float h = flip_height(root2);
  vec3 root = vec3(root2.x, h, root2.y);
  float dist = distance(root2, uCamPos.xz);
  vec3 tn = flip_terrainNormal(root2, 0.9);
  vec4 vm = texture2D(uVegMap, root2 * uVegMapInfo.y + 0.5);
  float density = vm.r;
  density *= 1.0 - smoothstep(0.42, 0.72, 1.0 - tn.y);
  density *= smoothstep(uLakeLevel + 0.22, uLakeLevel + 0.8, h);
  density *= 1.0 - smoothstep(380.0, 420.0, h);
  // 細かい斑（同じセルの株は同じ斑）
  density *= 0.7 + 0.6 * flip_vnoise(root2 * 0.35 + 3.0);
  float band = uBlade.z;
  float ringFade = smoothstep(uRing.y - band, uRing.y + band * 0.3, dist) * (1.0 - smoothstep(uRing.z - band, uRing.z + band * 0.3, dist));
  float hh = flip_hash12(cw * 2.17 + 5.0 + k * 0.37);
  float scale = smoothstep(0.0, 0.12, density * ringFade - hh);
  float rnd = flip_hash12(cw * 3.3 + k * 7.7 + 1.0);
  float rnd2 = flip_hash11(rnd * 91.7 + 3.0);
  float H = uBlade.x * (0.55 + 0.8 * rnd) * (0.65 + 0.35 * density) * scale;
  float W = uBlade.y * (0.75 + 0.5 * rnd2) * (0.5 + 0.5 * scale);
  float yaw = rnd2 * 6.2832 + k * 2.1;
  vec3 side = vec3(cos(yaw), 0.0, sin(yaw));
  vec3 bendDir = vec3(-side.z, 0.0, side.x);
  float t = position.y;
  float curl = 0.1 + 0.5 * flip_hash11(rnd * 5.0 + 9.0);
  vec2 wd = veg_windDir();
  float gust = veg_gust(root2);
  float windAmt = (0.03 + 0.05 * uWind.z) * gust;
  float flutter = sin(uTime * (2.2 + 2.0 * rnd) + rnd * 25.0 + dot(root2, wd) * 0.8) * (0.015 + 0.012 * uWind.z) * (0.5 + gust);
  vec3 lat = bendDir * (curl + flutter) + vec3(wd.x, 0.0, wd.y) * windAmt;
  float latLen = length(lat);
  float tt = t * t;
  float fm = veg_flipMask(root);
  float flipped = step(flip_hash12(cw * 0.53 + 2.0), fm) * step(0.001, fm);
  vec3 up = vec3(0.0, 1.0, 0.0);
  if (flipped > 0.5) {
    // 数式ビュー: 1本ずつが「向きと長さのベクトル」= 根元から先端への直線
    float lw = 0.008 + dist * 0.0025;
    p = root + side * (position.x * lw) + up * (H * t * (1.0 - 0.4 * latLen * latLen)) + lat * H * t;
    n = up;
  } else {
    float wTaper = 1.0 - 0.7 * tt;
    p = root + side * (position.x * W * wTaper) + up * (H * t * (1.0 - 0.45 * latLen * latLen * tt)) + lat * H * tt;
    n = normalize(cross(side, up + lat * 2.0 * t));
    n = normalize(mix(n, up, 0.45) + side * position.x * 0.4);
  }
  vGrass = vec4(t, rnd, vm.b, flipped);
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
      const uRing = { value: new THREE.Vector4(ring.cell, ring.rIn, ring.rOut, ring.cell * 0.9) };
      const uBlade = { value: new THREE.Vector4(ring.height, ring.width, ring.band, 0) };
      const mat = this.buildMaterial(uRing, uBlade);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER.MAIN_ONLY);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      const total = geo.instanceCount;
      if (ring.shadowFrac > 0 && !noShadow) {
        mesh.castShadow = true;
        mesh.customDepthMaterial = this.buildDepthMaterial(uRing, uBlade);
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

  private vertexInject(shader: THREE.WebGLProgramParametersWithUniforms, uRing: THREE.IUniform, uBlade: THREE.IUniform) {
    shader.uniforms.uRing = uRing;
    shader.uniforms.uBlade = uBlade;
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

  private buildMaterial(uRing: THREE.IUniform, uBlade: THREE.IUniform) {
    const c = GRASS_COLORS;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        this.vertexInject(shader, uRing, uBlade);
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
          varying vec3 vVegWorld;
          const vec3 GRASS_ROOT = vec3(${c.root.r}, ${c.root.g}, ${c.root.b});
          const vec3 GRASS_TIP = vec3(${c.tip.r}, ${c.tip.g}, ${c.tip.b});
          const vec3 GRASS_TIP2 = vec3(${c.tip2.r}, ${c.tip2.g}, ${c.tip2.b});
          const vec3 GRASS_DRY = vec3(${c.dry.r}, ${c.dry.g}, ${c.dry.b});`,
          "grass fs common",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <map_fragment>",
          `{
            float t = vGrass.x, rnd = vGrass.y, dry = vGrass.z;
            vec3 tip = mix(GRASS_TIP, GRASS_TIP2, flip_hash11(rnd * 7.1));
            vec3 col = mix(GRASS_ROOT, tip, smoothstep(0.0, 0.8, t));
            col = mix(col, GRASS_DRY, dry * dry * (0.35 + 0.65 * t));
            col *= 0.82 + 0.36 * rnd;
            diffuseColor.rgb = col;
          }`,
          "grass fs map",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <lights_fragment_begin>",
          `float vegTrans = 0.3 + 0.7 * vGrass.x;
          float vegAO = 0.3 + 0.7 * vGrass.x;
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

  private buildDepthMaterial(uRing: THREE.IUniform, uBlade: THREE.IUniform) {
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        this.vertexInject(shader, uRing, uBlade);
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
