// 地形。GPU クリップマップ（同心の環 7 段）＋ 実行時 GLSL で作る材質（草・土・岩・ガレ・雪・砂・濡れ）＋ 裏返し。
//   - 高さは flip_height（ハイトマップ）だけ。環の外縁は LOD モーフで粗いレベルの補間値へ寄せる（割れ目なし）
//   - 影: customDepthMaterial に同じ変位を入れて CSM に落とす。影の質（PCF 半径・normalBias・bias）は core/lighting.ts が決める
//   - 起動時に法線・AO・cavity・8方位の地平角を GPU で焼き（bake.ts）、env.uniforms に載せる（他モジュールも読める）
//   - 材質の GLSL は glsl.ts
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { patchMaterial, replaceOnce } from "../core/patch";
import type { QualitySettings } from "../core/quality";
import { bakeTerrainAux, type TerrainBake } from "./bake";
import {
  injectTerrainShadow,
  TERRAIN_FRAG_AO,
  TERRAIN_FRAG_FOG,
  TERRAIN_FRAG_MATERIAL,
  TERRAIN_FRAG_NORMAL,
  TERRAIN_FRAG_PARS,
  TERRAIN_VERT_HEIGHT,
  TERRAIN_VERT_NORMAL,
  TERRAIN_VERT_PARS,
} from "./glsl";

type Level = {
  size: number;
  step: number;
  meshes: THREE.Mesh[];
  uStep: THREE.IUniform<number>;
  uHalf: THREE.IUniform<number>;
};

/** 環の設定: n = 一辺のセル数（4 の倍数、n/2 が偶数）。size = n × step */
function levelDefs(q: QualitySettings): { n: number; step: number }[] {
  const n = q.tier === "high" || q.tier === "ultra" ? 96 : 64;
  return [2, 4, 8, 16, 32, 64, 128].map((step) => ({ n, step }));
}

/** 環（穴あき格子）。ox/oz は穴のずれ（セル単位 0/1）。level0 は穴なし。 */
function buildRing(n: number, step: number, hole: boolean, ox: number, oz: number): THREE.BufferGeometry {
  const size = n * step;
  const verts = (n + 1) * (n + 1);
  const pos = new Float32Array(verts * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i;
      pos[k * 3] = i * step - size / 2;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = j * step - size / 2;
    }
  }
  const idx: number[] = [];
  const h0 = n / 4 + ox, h1 = (3 * n) / 4 + ox;
  const g0 = n / 4 + oz, g1 = (3 * n) / 4 + oz;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (hole && i >= h0 && i < h1 && j >= g0 && j < g1) continue;
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // 対角を交互に。頂点シェーダの LOD モーフはこの規則（(i+j) の偶奇）を前提にしている
      if (((i + j) & 1) === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, d, b, a, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // バウンディングは高さ分を足して手で持つ（フラスタムカリング用）
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 300, 0), size * 0.75 + 900);
  return geo;
}

export class Terrain {
  group = new THREE.Group();
  material: THREE.MeshStandardMaterial;
  depthMaterial: THREE.MeshDepthMaterial;
  bake: TerrainBake | null = null;
  private levels: Level[] = [];
  private uDetail: THREE.IUniform<number>;
  private uDebug: THREE.IUniform<number>;
  private uReflect: THREE.IUniform<number> = { value: 0 };
  private uField: THREE.IUniform<THREE.Texture | null> = { value: null };
  private baking = false;

  constructor(public scene: THREE.Scene, public env: Env, public lighting: Lighting, public q: QualitySettings) {
    env.uniforms.uHeightParts.value = env.heightmap.parts;
    this.uDetail = { value: q.tier === "ultra" || q.tier === "high" ? 1 : q.tier === "mid" ? 0.55 : 0.25 };
    // 調査用 ?tdbg（1 太陽の見え方 2 AO 3 法線 4 cavity 5 地平角 6 山の影なし 7 林床/土/ガレ 8 地色 9 細部なし 12 砂/土/ガレ）
    const dbg = typeof location !== "undefined" ? Number(new URLSearchParams(location.search).get("tdbg") ?? 0) : 0;
    this.uDebug = { value: Number.isFinite(dbg) ? dbg : 0 };
    this.material = this.buildMaterial();
    this.depthMaterial = this.buildDepthMaterial();
    const defs = levelDefs(q);
    for (let L = 0; L < defs.length; L++) {
      const { n, step } = defs[L];
      const size = n * step;
      const uStep = { value: step };
      const uHalf = { value: size / 2 };
      const meshes: THREE.Mesh[] = [];
      const variants = L === 0 ? 1 : 4;
      for (let v = 0; v < variants; v++) {
        const geo = buildRing(n, step, L > 0, v & 1, v >> 1);
        const mesh = new THREE.Mesh(geo, this.cloneWithLevel(this.material, uStep, uHalf));
        mesh.customDepthMaterial = this.cloneWithLevel(this.depthMaterial, uStep, uHalf);
        mesh.receiveShadow = true;
        mesh.castShadow = L <= 2;
        mesh.visible = v === 0;
        mesh.frustumCulled = true;
        mesh.onBeforeRender = (renderer, _scene, camera) => {
          this.ensureBaked(renderer);
          // 映り込みカメラ（水の鏡像）では細部を省く。材質はレベルごとに別なので描画ごとに uniform が送られる
          this.uReflect.value = camera === this.env.camera ? 0 : 1;
        };
        meshes.push(mesh);
        this.group.add(mesh);
      }
      this.levels.push({ size, step, meshes, uStep, uHalf });
    }
    scene.add(this.group);
  }

  /** レベルごとに uStep / uHalf を変えたいので材質を複製する（プログラムはキーで共有される）。 */
  private cloneWithLevel<M extends THREE.Material>(src: M, uStep: THREE.IUniform<number>, uHalf: THREE.IUniform<number>): M {
    const m = src.clone() as M;
    // Material.clone() は defines を写さない。CSM の setupMaterial が付けた USE_CSM / CSM_CASCADES / CSM_FADE を
    // 落とすと影の経路がコンパイルされず、太陽が「影なしの平行光」の経路に回ってしまう
    m.defines = { ...(src.defines ?? {}) };
    const prev = src.onBeforeCompile;
    m.onBeforeCompile = (shader, r) => {
      prev.call(src, shader, r);
      shader.uniforms.uStep = uStep;
      shader.uniforms.uHalf = uHalf;
    };
    m.customProgramCacheKey = src.customProgramCacheKey;
    m.needsUpdate = true;
    return m;
  }

  /** 最初の描画の直前に補助テクスチャを焼く（renderer はここでしか手に入らない）。 */
  private ensureBaked(renderer: THREE.WebGLRenderer) {
    if (this.bake || this.baking) return;
    this.baking = true;
    const res = this.env.heightmap.res;
    const mobile = this.q.tier === "low" || this.q.tier === "mid";
    // 地平角マップ: 影担当が木・草の「山の影」にも使う。
    //   ・解像度は 1024²（4m/texel）のまま。1536² も試したが、テクスチャが 8MB → 18MB になって
    //     キャッシュに乗らず、地形の GPU 時間が +0.6ms 増えた。山の影の半影は 1km 先で 9m なので
    //     4m/texel の粗さは物理的に妥当で、上げる価値が費用に見合わない
    //   ・射程は 40 歩 2.5km → 44 歩 4.9km に伸ばした（世界は 4km 四方。実行時のコストは増えない）
    const b = bakeTerrainAux(renderer, this.env, res, 1024, mobile ? 28 : 44, mobile ? 1.27 : 1.18);
    this.bake = b;
    const u = this.env.uniforms;
    u.uTerrainAux.value = b.aux.texture;
    u.uTerrainHorizonA.value = b.horizonA.texture;
    u.uTerrainHorizonB.value = b.horizonB.texture;
    this.uField.value = b.field.texture;
    this.baking = false;
  }

  private buildMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        shader.uniforms.uStep = { value: 2 };
        shader.uniforms.uHalf = { value: 96 };
        shader.uniforms.uDetail = this.uDetail;
        shader.uniforms.uTerrainDebug = this.uDebug;
        shader.uniforms.uReflect = this.uReflect;
        shader.uniforms.uTerrainField = this.uField;
        let vs = shader.vertexShader;
        vs = replaceOnce(vs, "#include <common>", `#include <common>\n${TERRAIN_VERT_PARS}`, "terrain vs common");
        vs = replaceOnce(vs, "#include <begin_vertex>", TERRAIN_VERT_HEIGHT, "terrain vs begin_vertex");
        vs = replaceOnce(vs, "#include <beginnormal_vertex>", TERRAIN_VERT_NORMAL, "terrain vs normal");
        shader.vertexShader = vs;
        let fs = shader.fragmentShader;
        fs = replaceOnce(fs, "#include <common>", `#include <common>\n${TERRAIN_FRAG_PARS}`, "terrain fs common");
        fs = replaceOnce(fs, "#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${TERRAIN_FRAG_MATERIAL}`, "terrain fs material");
        fs = replaceOnce(fs, "#include <map_fragment>", "diffuseColor.rgb *= tCol;", "terrain fs map");
        fs = replaceOnce(fs, "#include <roughnessmap_fragment>", "float roughnessFactor = tRough;", "terrain fs roughness");
        fs = replaceOnce(fs, "#include <normal_fragment_begin>", TERRAIN_FRAG_NORMAL, "terrain fs normal");
        fs = replaceOnce(
          fs,
          "#include <lights_fragment_begin>",
          injectTerrainShadow((THREE.ShaderChunk as unknown as Record<string, string>).lights_fragment_begin),
          "terrain fs lights",
        );
        fs = replaceOnce(fs, "#include <aomap_fragment>", TERRAIN_FRAG_AO, "terrain fs ao");
        fs = replaceOnce(fs, "#include <fog_fragment>", TERRAIN_FRAG_FOG, "terrain fs fog");
        shader.fragmentShader = fs;
      },
      { csm: this.lighting, key: "flip_terrain_v1" },
    );
    return mat;
  }

  /** 影のキャスター用: 同じ変位（モーフ込み）を入れた深度材質。 */
  private buildDepthMaterial() {
    const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        shader.uniforms.uStep = { value: 2 };
        shader.uniforms.uHalf = { value: 96 };
        let vs = shader.vertexShader;
        vs = replaceOnce(vs, "#include <common>", `#include <common>\n${TERRAIN_VERT_PARS}`, "terrain depth vs common");
        vs = replaceOnce(vs, "#include <begin_vertex>", TERRAIN_VERT_HEIGHT, "terrain depth vs begin_vertex");
        shader.vertexShader = vs;
      },
      { key: "flip_terrain_depth_v1" },
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
    // 影の normalBias / bias / PCF 半径は core/lighting.ts が持つ（ここでは触らない）。
  }
}
