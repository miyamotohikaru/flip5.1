// 地形。土台版: GPU クリップマップ（同心の環を4種の穴ずれで持つ）＋ 斜度・標高で塗り分ける材質。
// 地形担当は材質（岩肌・草・雪・砂・濡れ・トライプラナー・ディテール法線）と裏返し表現を作り込む。
// 高さ関数（core/heightfield.ts の heightAt）は凍結。形を変えると他モジュールの配置が狂う。
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { patchMaterial, replaceOnce } from "../core/patch";
import type { QualitySettings } from "../core/quality";

type Level = { size: number; step: number; meshes: THREE.Mesh[]; uStep: THREE.IUniform<number> };

const LEVELS = [
  { size: 256, step: 2 },
  { size: 512, step: 4 },
  { size: 1024, step: 8 },
  { size: 2048, step: 16 },
  { size: 4096, step: 32 },
  { size: 8192, step: 64 },
];

/** 環（穴あき格子）。ox/oz は穴のずれ（セル単位 0/1）。level0 は穴なし。 */
function buildRing(size: number, step: number, hole: boolean, ox: number, oz: number): THREE.BufferGeometry {
  const n = size / step; // セル数
  const verts = (n + 1) * (n + 1);
  const pos = new Float32Array(verts * 3);
  const edge = new Float32Array(verts * 2);
  const uv = new Float32Array(verts * 2);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i;
      pos[k * 3] = i * step - size / 2;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = j * step - size / 2;
      uv[k * 2] = i / n;
      uv[k * 2 + 1] = j / n;
      const onEdgeX = i === 0 || i === n;
      const onEdgeZ = j === 0 || j === n;
      if (onEdgeX && (j & 1) === 1 && !onEdgeZ) {
        edge[k * 2] = 0;
        edge[k * 2 + 1] = 1;
      } else if (onEdgeZ && (i & 1) === 1 && !onEdgeX) {
        edge[k * 2] = 1;
        edge[k * 2 + 1] = 0;
      }
    }
  }
  const idx: number[] = [];
  const h0 = n / 4 + ox, h1 = (3 * n) / 4 + ox;
  const g0 = n / 4 + oz, g1 = (3 * n) / 4 + oz;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (hole && i >= h0 && i < h1 && j >= g0 && j < g1) continue;
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // 対角を交互に（クロスの目立ちを減らす）
      if (((i + j) & 1) === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, d, b, a, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("aEdge", new THREE.BufferAttribute(edge, 2));
  geo.setIndex(idx);
  // バウンディングは高さ分を足して手で持つ（フラスタムカリング用）
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 300, 0), size * 0.75 + 900);
  return geo;
}

export class Terrain {
  group = new THREE.Group();
  material: THREE.MeshStandardMaterial;
  private levels: Level[] = [];

  constructor(public scene: THREE.Scene, public env: Env, public lighting: Lighting, public q: QualitySettings) {
    this.material = this.buildMaterial();
    for (let L = 0; L < LEVELS.length; L++) {
      const { size, step } = LEVELS[L];
      const uStep = { value: step };
      const meshes: THREE.Mesh[] = [];
      const variants = L === 0 ? 1 : 4;
      for (let v = 0; v < variants; v++) {
        const geo = buildRing(size, step, L > 0, v & 1, v >> 1);
        // レベルごとに uStep を変えたいので材質を複製（プログラムは共有される）
        const mat = this.material.clone();
        mat.onBeforeCompile = this.material.onBeforeCompile;
        mat.customProgramCacheKey = this.material.customProgramCacheKey;
        const prevHook = mat.onBeforeCompile;
        mat.onBeforeCompile = (shader, r) => {
          prevHook(shader, r);
          shader.uniforms.uStep = uStep;
        };
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.castShadow = L <= 2;
        mesh.visible = v === 0;
        mesh.frustumCulled = true;
        meshes.push(mesh);
        this.group.add(mesh);
      }
      this.levels.push({ size, step, meshes, uStep });
    }
    scene.add(this.group);
  }

  private buildMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        shader.uniforms.uStep = { value: 2 };
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <common>",
          `#include <common>
          #include <flip_height>
          uniform float uStep;
          attribute vec2 aEdge;
          varying vec3 vFlipWorld;`,
          "terrain vs common",
        );
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <begin_vertex>",
          `vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz;
          float h = flip_height(wxz);
          if (aEdge.x != 0.0 || aEdge.y != 0.0) {
            h = 0.5 * (flip_height(wxz - aEdge * uStep) + flip_height(wxz + aEdge * uStep));
          }
          vec3 transformed = vec3(position.x, h, position.z);
          vFlipWorld = vec3(wxz.x, h, wxz.y);`,
          "terrain vs begin_vertex",
        );
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <beginnormal_vertex>",
          `vec3 objectNormal = flip_terrainNormal((modelMatrix * vec4(position, 1.0)).xz, max(uStep, 2.0));`,
          "terrain vs normal",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          #include <flip_height>
          #include <flip_atmosphere>
          #include <flip_flip>
          uniform float uWetness;
          varying vec3 vFlipWorld;`,
          "terrain fs common",
        );
        // 法線: ハイトマップから画素ごとに。近くはディテールノイズを足す（map_fragment より前で計算しておく）
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          float camDist = distance(vFlipWorld, uCamPos);
          vec3 wN = flip_terrainNormal(vFlipWorld.xz, 1.0 + camDist * 0.004);
          {
            float detailAmt = (1.0 - smoothstep(20.0, 160.0, camDist)) * 0.35;
            vec2 dxz = vFlipWorld.xz * 0.9;
            float e = 0.05;
            float d0 = flip_fbm(dxz, 3), dx = flip_fbm(dxz + vec2(e, 0.0), 3), dz = flip_fbm(dxz + vec2(0.0, e), 3);
            vec3 detail = normalize(vec3((d0 - dx) / e, 1.0, (d0 - dz) / e) * vec3(0.4, 1.0, 0.4));
            wN = normalize(mix(wN, normalize(wN + detail * 0.6), detailAmt));
          }`,
          "terrain fs clipping",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <normal_fragment_begin>",
          `float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
          vec3 normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;`,
          "terrain fs normal",
        );
        // 塗り分け
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <map_fragment>",
          `{
            float slope = 1.0 - wN.y; // 0 = 平ら
            float hgt = vFlipWorld.y;
            float nz = flip_fbm(vFlipWorld.xz * 0.02, 3);
            float nz2 = flip_fbm(vFlipWorld.xz * 0.35 + 7.0, 3);
            vec3 grass = mix(vec3(0.16, 0.27, 0.08), vec3(0.32, 0.40, 0.12), nz2 * 0.5 + 0.5);
            vec3 dryGrass = vec3(0.40, 0.36, 0.16);
            vec3 rock = mix(vec3(0.30, 0.28, 0.26), vec3(0.42, 0.38, 0.33), nz2 * 0.5 + 0.5);
            vec3 dirt = vec3(0.28, 0.21, 0.14);
            vec3 snow = vec3(0.90, 0.92, 0.96);
            vec3 sand = vec3(0.52, 0.47, 0.36);
            vec3 col = mix(grass, dryGrass, smoothstep(0.2, 0.7, nz * 0.5 + 0.5) * 0.6);
            col = mix(col, dirt, smoothstep(0.12, 0.3, slope));
            col = mix(col, rock, smoothstep(0.28, 0.5, slope));
            col = mix(col, sand, 1.0 - smoothstep(0.4, 3.5, hgt));
            float snowLine = 430.0 + 60.0 * nz;
            col = mix(col, snow, smoothstep(snowLine, snowLine + 60.0, hgt) * (1.0 - smoothstep(0.35, 0.7, slope)));
            col = mix(col, col * 0.55, uWetness * 0.8);
            diffuseColor.rgb *= col;
          }`,
          "terrain fs map",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.45, uWetness * 0.8);`,
          "terrain fs roughness",
        );
        // 空気遠近＋裏返し
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <fog_fragment>",
          `gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, vFlipWorld);
          {
            float fm = flip_mask(vFlipWorld);
            if (fm > 0.0) {
              vec3 fc = FLIP_BG;
              float contour = flip_line(vFlipWorld.y / 5.0, 0.035) * 0.7 + flip_line(vFlipWorld.y / 25.0, 0.06);
              fc += FLIP_LINE * contour * 0.9;
              fc += FLIP_LINE * 0.18 * flip_grid(vFlipWorld.xz, 10.0);
              fc += FLIP_ACCENT * flip_edgeGlow(vFlipWorld) * 1.5;
              fc = flip_applyAerial(fc, vFlipWorld) * 0.7 + fc * 0.3;
              gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, fm);
            }
          }`,
          "terrain fs fog",
        );
      },
      { csm: this.lighting, key: "flip_terrain_v0" },
    );
    return mat;
  }

  update() {
    const cam = this.env.cameraPos;
    for (let L = 0; L < this.levels.length; L++) {
      const lv = this.levels[L];
      const snap = 2 * lv.step;
      const sx = Math.floor(cam.x / snap) * snap;
      const sz = Math.floor(cam.z / snap) * snap;
      let variant = 0;
      if (L > 0) {
        const fine = this.levels[L - 1];
        const fsnap = 2 * fine.step;
        const fx = Math.floor(cam.x / fsnap) * fsnap;
        const fz = Math.floor(cam.z / fsnap) * fsnap;
        const ox = Math.round((fx - sx) / lv.step);
        const oz = Math.round((fz - sz) / lv.step);
        variant = (ox & 1) | ((oz & 1) << 1);
      }
      for (let v = 0; v < lv.meshes.length; v++) {
        const m = lv.meshes[v];
        m.visible = v === variant;
        m.position.set(sx, 0, sz);
      }
    }
  }
}
