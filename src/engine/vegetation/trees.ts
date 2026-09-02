// 針葉樹の林。配置は CPU（placement.ts）。描画は
//   近景 LOD0: カメラの周り r0 の木を 1 リスト（種類ごとに InstancedMesh）。カメラが動いたら組み直す
//   中景 LOD1: r0〜r1。同じく動的リスト
//   遠景 LOD2: 1024m チャンクごとの静的 InstancedMesh（インポスター）。視錐台カリング
// LOD の切り替えは距離の帯でディザのクロスフェード（ポップしない）。影は LOD0/LOD1 だけ。
// 根元には針葉の落ち葉の円（乗算の decal）を敷いて、幹と地面の継ぎ目を隠す。
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { LAYER } from "../core/pipeline";
import { patchMaterial, replaceOnce } from "../core/patch";
import type { QualitySettings } from "../core/quality";
import { WORLD } from "../core/heightfield";
import { buildConifer, makeTreeDepthMaterial, makeTreeMaterial, TREE_VARIANTS, type TreeGeo } from "./conifer";
import { ImpostorAtlas, impostorQuad, makeImpostorMaterial } from "./impostor";
import { forEachInRadius, scatterTrees, type Scatter } from "./placement";
import { makeNeedleAtlas } from "./textures";
import { stampTreeRoots, type VegMap } from "./vegmap";
import { VEG_VERT_COMMON } from "./shaders";

type Tier = { r0: number; r1: number; band: number; capNear: number; capMid: number; cell: number; impCell: number; chunk: number };
function tierSettings(q: QualitySettings): Tier {
  switch (q.tier) {
    case "low":
      return { r0: 28, r1: 95, band: 8, capNear: 120, capMid: 350, cell: 10, impCell: 128, chunk: 1024 };
    case "mid":
      return { r0: 40, r1: 130, band: 10, capNear: 180, capMid: 600, cell: 9, impCell: 192, chunk: 1024 };
    case "ultra":
      return { r0: 80, r1: 240, band: 14, capNear: 400, capMid: 1600, cell: 7.5, impCell: 256, chunk: 1024 };
    default:
      return { r0: 55, r1: 150, band: 12, capNear: 300, capMid: 1200, cell: 8, impCell: 256, chunk: 1024 };
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Trees {
  scatter: Scatter;
  needle: THREE.Texture;
  geos: { lod0: TreeGeo; lod1: TreeGeo }[] = [];
  near: THREE.InstancedMesh[] = [];
  mid: THREE.InstancedMesh[] = [];
  litter: THREE.InstancedMesh;
  chunks: THREE.InstancedMesh[] = [];
  atlas: ImpostorAtlas;
  tier: Tier;
  private lastBuild = new THREE.Vector3(1e9, 0, 1e9);
  private cascadeIndex = new Map<THREE.Camera, number>();
  private trigger: THREE.Mesh | null = null;
  /** 三角形の目安（LOD0/LOD1 の 1 本あたり） */
  stats = { trees: 0, near: 0, mid: 0, lod0Tris: 0, lod1Tris: 0 };

  constructor(parent: THREE.Object3D, public env: Env, public lighting: Lighting, public q: QualitySettings, public vegmap: VegMap) {
    const t = (this.tier = tierSettings(q));
    const dbg = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("dbg") ?? "") : "";
    // 調査用: ?dbg=imponly で全部インポスターにする（近景と見比べる）
    if (dbg.includes("imponly")) {
      t.r0 = 0;
      t.r1 = 0;
      t.band = 0.001;
    }
    for (let i = 0; i < lighting.csm.lights.length; i++) this.cascadeIndex.set(lighting.csm.lights[i].shadow.camera, i);
    const msaa = q.msaaSamples > 0;
    this.needle = makeNeedleAtlas(q.tier === "low" ? 192 : 256);
    // 形
    for (const v of TREE_VARIANTS) this.geos.push({ lod0: buildConifer(v, 0), lod1: buildConifer(v, 1) });
    this.stats.lod0Tris = this.geos[0].lod0.tris;
    this.stats.lod1Tris = this.geos[0].lod1.tris;
    // 配置
    this.scatter = scatterTrees(env.heightmap, vegmap, t.cell, TREE_VARIANTS.length);
    this.stats.trees = this.scatter.count;
    stampTreeRoots(vegmap, this.scatter.x, this.scatter.z, this.scatter.count, 0.5);

    // 近景・中景の動的リスト
    for (let v = 0; v < TREE_VARIANTS.length; v++) {
      const g = this.geos[v];
      const o0 = { lod: 0 as const, H: g.lod0.H, r0: t.r0, r1: t.r1, band: t.band };
      const o1 = { lod: 1 as const, H: g.lod1.H, r0: t.r0, r1: t.r1, band: t.band };
      const near = new THREE.InstancedMesh(g.lod0.geometry, makeTreeMaterial(env, lighting, this.needle, o0, msaa), t.capNear);
      const mid = new THREE.InstancedMesh(g.lod1.geometry, makeTreeMaterial(env, lighting, this.needle, o1, msaa), t.capMid);
      for (const [m, o] of [[near, o0], [mid, o1]] as const) {
        m.count = 0;
        m.frustumCulled = false;
        m.castShadow = true;
        m.receiveShadow = true;
        m.customDepthMaterial = makeTreeDepthMaterial(env, this.needle, o);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.matrixAutoUpdate = false;
        parent.add(m);
      }
      // 影: 近景は第1・第2カスケード、中景は第2・第3カスケードだけ
      let nearCount = 0, midCount = 0;
      near.onBeforeShadow = (_r, _o, _c, cam) => {
        nearCount = near.count;
        if ((this.cascadeIndex.get(cam) ?? 0) >= 2) near.count = 0;
      };
      near.onAfterShadow = () => {
        near.count = nearCount;
      };
      mid.onBeforeShadow = (_r, _o, _c, cam) => {
        midCount = mid.count;
        if ((this.cascadeIndex.get(cam) ?? 1) === 0) mid.count = 0;
      };
      mid.onAfterShadow = () => {
        mid.count = midCount;
      };
      this.near.push(near);
      this.mid.push(mid);
    }

    // 落ち葉の円（近景の木だけ）
    this.litter = new THREE.InstancedMesh(litterDisc(), this.litterMaterial(), t.capNear * TREE_VARIANTS.length);
    this.litter.count = 0;
    this.litter.frustumCulled = false;
    this.litter.layers.set(LAYER.MAIN_ONLY);
    this.litter.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.litter.matrixAutoUpdate = false;
    this.litter.renderOrder = 5;
    parent.add(this.litter);

    // 遠景: インポスター（チャンク）
    this.atlas = new ImpostorAtlas(this.geos.map((g) => g.lod0), t.impCell, this.needle);
    const impMat = makeImpostorMaterial(env, lighting, this.atlas, { r1: t.r1, band: t.band, far: q.treeDistance, farBand: q.treeDistance * 0.12 }, msaa);
    const quad = impostorQuad();
    const n = Math.ceil(WORLD.size / t.chunk);
    const sc = this.scatter;
    const buckets: number[][] = [];
    for (let i = 0; i < n * n; i++) buckets.push([]);
    for (let i = 0; i < sc.count; i++) {
      const cx = Math.min(n - 1, Math.floor((sc.x[i] + WORLD.half) / t.chunk));
      const cz = Math.min(n - 1, Math.floor((sc.z[i] + WORLD.half) / t.chunk));
      buckets[cx * n + cz].push(i);
    }
    for (const list of buckets) {
      if (list.length === 0) continue;
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = quad.index;
      geo.setAttribute("position", quad.getAttribute("position"));
      geo.setAttribute("normal", quad.getAttribute("normal"));
      geo.setAttribute("uv", quad.getAttribute("uv"));
      const vars = new Float32Array(list.length);
      const mesh = new THREE.InstancedMesh(geo, impMat, list.length);
      const box = new THREE.Box3();
      let maxH = 0;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        this.composeMatrix(i, _m);
        mesh.setMatrixAt(k, _m);
        vars[k] = sc.v[i];
        _p.set(sc.x[i], sc.y[i], sc.z[i]);
        box.expandByPoint(_p);
        maxH = Math.max(maxH, this.geos[sc.v[i]].lod0.H * sc.s[i]);
      }
      geo.setAttribute("aVar", new THREE.InstancedBufferAttribute(vars, 1));
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      sphere.radius += maxH;
      mesh.boundingSphere = sphere;
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false; // アトラスが焼けてから
      parent.add(mesh);
      this.chunks.push(mesh);
    }

    // アトラスを焼く引き金（描画の中で renderer を得る）
    const trig = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, -1e4, 0, 0, -1e4, 0, 0, -1e4, 0], 3)), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    trig.frustumCulled = false;
    trig.onBeforeRender = (renderer) => {
      if (this.atlas.baked) return;
      this.atlas.bake(renderer);
      for (const c of this.chunks) c.visible = true;
      this.trigger?.removeFromParent();
      this.trigger = null;
    };
    parent.add(trig);
    this.trigger = trig;
  }

  private composeMatrix(i: number, out: THREE.Matrix4) {
    const sc = this.scatter;
    _e.set(sc.tiltX[i], sc.yaw[i], sc.tiltZ[i], "YXZ");
    _q.setFromEuler(_e);
    _p.set(sc.x[i], sc.y[i], sc.z[i]);
    _s.setScalar(sc.s[i]);
    out.compose(_p, _q, _s);
  }

  /** 落ち葉の円: 地面に沿う乗算 decal */
  private litterMaterial() {
    const dbg = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("dbg") ?? "") : "";
    const debug = dbg.includes("litterdebug2") ? 2 : dbg.includes("litterdebug") ? 1 : 0;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: debug === 2 ? THREE.NormalBlending : THREE.MultiplyBlending, premultipliedAlpha: debug !== 2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    if (debug) mat.defines = { VEG_LITTER_DEBUG: debug };
    patchMaterial(
      mat,
      this.env,
      (shader) => {
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          #include <flip_height>
          ${VEG_VERT_COMMON}
          varying vec3 vLit;
          varying vec2 vLitUv;`,
          "litter vs common",
        );
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <begin_vertex>",
          `mat4 lim = instanceMatrix;
          vec3 root = lim[3].xyz;
          float rad = length(lim[0].xyz);
          vec2 wxz = root.xz + position.xz * rad;
          float h = flip_height(wxz) + 0.07;
          vec3 wp = vec3(wxz.x, h, wxz.y);
          float dist = distance(root.xz, uCamPos.xz);
          vLit = vec3(length(position.xz), veg_flipMask(root), 1.0 - smoothstep(60.0, 90.0, dist));
          vLitUv = wxz * 0.7;
          vec3 transformed = wp;`,
          "litter vs begin",
        );
        shader.vertexShader = replaceOnce(
          shader.vertexShader,
          "#include <project_vertex>",
          `vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;`,
          "litter vs project",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <common>",
          `#include <common>
          #include <flip_noise>
          varying vec3 vLit;
          varying vec2 vLitUv;`,
          "litter fs common",
        );
        shader.fragmentShader = replaceOnce(
          shader.fragmentShader,
          "#include <map_fragment>",
          `{
            float r = vLit.x;
            float nz = flip_vnoise(vLitUv);
            float a = (1.0 - smoothstep(0.2 + 0.45 * nz, 1.0, r)) * (0.7 + 0.3 * nz) * (1.0 - vLit.y) * vLit.z;
            vec3 tint = vec3(0.40, 0.32, 0.24);
            diffuseColor.rgb = mix(vec3(1.0), tint, a);
            diffuseColor.a = 1.0;
            #if defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 1
            diffuseColor = vec4(0.15, 0.15, 0.15, 1.0);
            #elif defined(VEG_LITTER_DEBUG)
            diffuseColor = vec4(1.0, 0.0, 0.0, 0.3);
            #endif
          }`,
          "litter fs map",
        );
      },
      { key: "veg_litter_v1" },
    );
    return mat;
  }

  update() {
    const cam = this.env.cameraPos;
    const dx = cam.x - this.lastBuild.x, dz = cam.z - this.lastBuild.z;
    if (dx * dx + dz * dz < 6 * 6) return;
    this.lastBuild.copy(cam);
    this.rebuildLists(cam.x, cam.z);
  }

  private rebuildLists(cx: number, cz: number) {
    const t = this.tier;
    const sc = this.scatter;
    const V = TREE_VARIANTS.length;
    const nearList: number[][] = [], midList: number[][] = [];
    for (let v = 0; v < V; v++) {
      nearList.push([]);
      midList.push([]);
    }
    const margin = 8;
    forEachInRadius(sc, cx, cz, t.r1 + margin, (i, d) => {
      const v = sc.v[i];
      if (d < t.r0 + margin) nearList[v].push(i);
      if (d > t.r0 - t.band - margin) midList[v].push(i);
    });
    let litterN = 0;
    for (let v = 0; v < V; v++) {
      const fill = (mesh: THREE.InstancedMesh, list: number[], cap: number, litter: boolean) => {
        if (list.length > cap) {
          list.sort((a, b) => Math.hypot(sc.x[a] - cx, sc.z[a] - cz) - Math.hypot(sc.x[b] - cx, sc.z[b] - cz));
          list.length = cap;
        }
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          this.composeMatrix(i, _m);
          mesh.setMatrixAt(k, _m);
          if (litter && litterN < this.litter.instanceMatrix.count) {
            const rad = (0.9 + 1.6 * sc.s[i]) * (0.8 + 0.4 * sc.seed[i]);
            _m.makeScale(rad, 1, rad);
            _m.setPosition(sc.x[i], sc.y[i], sc.z[i]);
            this.litter.setMatrixAt(litterN++, _m);
          }
        }
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
      };
      fill(this.near[v], nearList[v], t.capNear, true);
      fill(this.mid[v], midList[v], t.capMid, false);
    }
    this.litter.count = litterN;
    this.litter.instanceMatrix.needsUpdate = true;
    this.stats.near = nearList.reduce((a, b) => a + b.length, 0);
    this.stats.mid = midList.reduce((a, b) => a + b.length, 0);
  }
}

/** 落ち葉の円（半径 1、中心 + 3 重の 14 角形。地面に沿うように細かく） */
function litterDisc(): THREE.BufferGeometry {
  const n = 14, rings = 3;
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let k = 1; k <= rings; k++) {
    const rr = k / rings;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    }
  }
  const at = (k: number, i: number) => 1 + (k - 1) * n + (i % n);
  for (let i = 0; i < n; i++) idx.push(0, at(1, i + 1), at(1, i));
  for (let k = 1; k < rings; k++) {
    for (let i = 0; i < n; i++) {
      const a = at(k, i), b = at(k, i + 1), c = at(k + 1, i), d = at(k + 1, i + 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}
