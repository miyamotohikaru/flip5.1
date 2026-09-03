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
import { buildConifer, buildShadowProxy, makeTreeDepthMaterial, makeTreeMaterial, TREE_VARIANTS, type TreeGeo } from "./conifer";
import { ImpostorAtlas, impostorQuad, makeImpostorMaterial } from "./impostor";
import { forEachInRadius, scatterTrees, type Scatter } from "./placement";
import { makeNeedleAtlas } from "./textures";
import { stampTreeRoots, type VegMap } from "./vegmap";
import { VEG_VERT_COMMON } from "./shaders";

type Tier = { r0: number; r1: number; band: number; capNear: number; capMid: number; cell: number; impCell: number; chunk: number;
  /** 影だけ落とす遠景プロキシの半径と上限（r1 の外側 〜 shadowR） */
  shadowR: number; capShadow: number };
function tierSettings(q: QualitySettings): Tier {
  switch (q.tier) {
    case "low":
      return { r0: 22, r1: 62, band: 5, capNear: 90, capMid: 260, cell: 10, impCell: 128, chunk: 512, shadowR: 160, capShadow: 700 };
    case "mid":
      return { r0: 32, r1: 70, band: 7, capNear: 130, capMid: 300, cell: 10, impCell: 224, chunk: 768, shadowR: 200, capShadow: 430 };
    case "ultra":
      return { r0: 65, r1: 170, band: 10, capNear: 320, capMid: 1100, cell: 7.5, impCell: 256, chunk: 1024, shadowR: 330, capShadow: 2400 };
    default:
      return { r0: 44, r1: 104, band: 9, capNear: 220, capMid: 640, cell: 8, impCell: 256, chunk: 1024, shadowR: 280, capShadow: 820 };
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
  /** 影だけの遠景プロキシ（主パスでは count=0 なので描画されない） */
  shadowFar: THREE.InstancedMesh[] = [];
  chunks: THREE.InstancedMesh[] = [];
  /** チャンクの全インスタンス数と中心・半径（距離で間引くため） */
  private chunkInfo: { full: number; cx: number; cz: number; r: number }[] = [];
  private impFar = 1000;
  /** 1 = 映り込みカメラで描いている最中（LOD1 が 0m から受け持つ） */
  private uReflect: THREE.IUniform<number> = { value: 0 };
  atlas: ImpostorAtlas;
  tier: Tier;
  private lastBuild = new THREE.Vector3(1e9, 0, 1e9);
  private cascadeIndex = new Map<THREE.Camera, number>();
  private trigger: THREE.Mesh | null = null;
  /** 三角形の目安（LOD0/LOD1 の 1 本あたり） */
  stats = { trees: 0, near: 0, mid: 0, far: 0, lod0Tris: 0, lod1Tris: 0, proxyTris: 0 };

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
    const msaa = q.msaaSamples >= 4;
    // 影プロキシ用（色は書かない。影のパスでは three が深度マテリアルに差し替える）
    const shadowProxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.needle = makeNeedleAtlas(q.tier === "low" ? 192 : q.tier === "mid" ? 320 : 384);
    // 形
    for (const v of TREE_VARIANTS) this.geos.push({ lod0: buildConifer(v, 0), lod1: buildConifer(v, 1) });
    this.stats.lod0Tris = this.geos[0].lod0.tris;
    this.stats.lod1Tris = this.geos[0].lod1.tris;
    this.stats.proxyTris = 16;
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
      const mid = new THREE.InstancedMesh(g.lod1.geometry, makeTreeMaterial(env, lighting, this.needle, o1, msaa, this.uReflect), t.capMid);
      // 近景（LOD0）は湖の映り込みに出さない。1 本 1000 三角形が 2 回描かれるのは高すぎる。
      // 代わりに映り込みでは LOD1 が 0m から受け持つ（uReflect）
      near.layers.set(LAYER.MAIN_ONLY);
      mid.onBeforeRender = (_r, _s, camera) => {
        this.uReflect.value = camera === env.camera ? 0 : 1;
      };
      for (const m of [near, mid]) {
        m.count = 0;
        m.frustumCulled = false;
        m.receiveShadow = true;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.matrixAutoUpdate = false;
        parent.add(m);
      }
      // 影は「中景（LOD1）のリスト」だけが落とす。近景の LOD0 は形が細かいだけで影の輪郭は
      // ほぼ同じなので、影用に LOD1 を使うと三角形が 1/4 で済む。
      // そのため中景のリストは 0〜r1 の全部を持ち、影の深度マテリアルだけ LOD のフェードを無視する。
      near.castShadow = false;
      mid.castShadow = true;
      mid.customDepthMaterial = makeTreeDepthMaterial(env, this.needle, o1, true);
      let midCount = 0;
      mid.onBeforeShadow = (_r, _o, _c, cam) => {
        midCount = mid.count;
        // 近カスケードだけ「葉のアルファ付きの影」。遠カスケードは 16 三角形の円錐プロキシに任せる
        if ((this.cascadeIndex.get(cam) ?? 0) >= 1) mid.count = 0;
      };
      mid.onAfterShadow = () => {
        mid.count = midCount;
      };
      this.near.push(near);
      this.mid.push(mid);

      // 影だけの遠景プロキシ。count は既定 0（＝主パス・映り込みでは 1 本も描かれない）で、
      // 影のパスの間だけ onBeforeShadow で本数を入れる
      const proxy = new THREE.InstancedMesh(buildShadowProxy(TREE_VARIANTS[v], g.lod0.radius), shadowProxyMat, t.capShadow);
      proxy.count = 0;
      proxy.frustumCulled = false;
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      proxy.matrixAutoUpdate = false;
      let proxyN = 0;
      proxy.onBeforeShadow = (_r, _o, _c, cam) => {
        // 近カスケードは LOD1 が影を落とすので、遠カスケードだけ
        proxy.count = (this.cascadeIndex.get(cam) ?? 0) >= 1 ? proxyN : 0;
      };
      proxy.onAfterShadow = () => {
        proxy.count = 0;
      };
      Object.defineProperty(proxy.userData, "setCount", { value: (n: number) => (proxyN = n), writable: true });
      parent.add(proxy);
      this.shadowFar.push(proxy);
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
    // 遠景ビルボードの視程。品質段階の treeDistance は空気遠近のための値なので、
    // ここでは「木が 3px 未満になる距離」で頭打ちにする（1 本 2 三角形でも万単位で効く）
    const impFar = Math.min(q.treeDistance, q.tier === "low" ? 900 : q.tier === "mid" ? 1250 : 2100);
    const impMat = makeImpostorMaterial(env, lighting, this.atlas, { r1: t.r1, band: t.band, far: impFar, farBand: impFar * 0.12 }, msaa);
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
    this.impFar = impFar;
    for (const list of buckets) {
      if (list.length === 0) continue;
      // 距離で count を減らして間引くので、並びを決定的にばらけさせておく
      // （前から N 本だけ描いても、林の中で偏らないように）
      list.sort((a, b) => (Math.imul(a, 2654435761) >>> 8) - (Math.imul(b, 2654435761) >>> 8));
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
      this.chunkInfo.push({ full: list.length, cx: sphere.center.x, cz: sphere.center.z, r: sphere.radius });
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
    const dm = /litterdebug(\d)/.exec(dbg);
    const debug = dm ? Number(dm[1]) : 0;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: debug >= 2 ? THREE.NormalBlending : THREE.MultiplyBlending, premultipliedAlpha: debug < 2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
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
          vLit = vec3(length(position.xz), veg_flipMask(root), 1.0 - smoothstep(70.0, 100.0, dist));
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
            float a = (1.0 - smoothstep(0.18 + 0.5 * nz, 1.0, r)) * (0.65 + 0.35 * nz);
            // 幹の足元は落ち葉が厚く、接地の影で暗い（根元の継ぎ目を隠す）
            a = max(a, 1.0 - smoothstep(0.0, 0.34 + 0.1 * nz, r));
            a *= (1.0 - vLit.y) * vLit.z;
            vec3 tint = vec3(0.30, 0.235, 0.165);
            diffuseColor.rgb = mix(vec3(1.0), tint, a);
            diffuseColor.a = 1.0;
            #if defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 1
            diffuseColor = vec4(0.15, 0.15, 0.15, 1.0);
            #elif defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 2
            diffuseColor = vec4(1.0, 0.0, 0.0, 0.3);
            #elif defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 3
            diffuseColor = vec4(vec3(r), 1.0);
            #elif defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 4
            diffuseColor = vec4(vec3(vLit.y), 1.0);
            #elif defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 5
            diffuseColor = vec4(vec3(vLit.z), 1.0);
            #elif defined(VEG_LITTER_DEBUG) && VEG_LITTER_DEBUG == 6
            diffuseColor = vec4(vec3(nz), 1.0);
            #elif defined(VEG_LITTER_DEBUG)
            diffuseColor = vec4(vec3(a), 1.0);
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
    this.updateImpostorChunks(cam.x, cam.z);
    const dx = cam.x - this.lastBuild.x, dz = cam.z - this.lastBuild.z;
    if (dx * dx + dz * dz < 6 * 6) return;
    this.lastBuild.copy(cam);
    this.rebuildLists(cam.x, cam.z);
  }

  /**
   * 遠景のビルボードは 1 本 2 三角形でも本数が万単位になり、しかも映り込みでもう一度描かれる。
   * チャンク（512m）ごとに「視程の外なら描かない」「遠いチャンクは本数を減らす」で submit 自体を減らす。
   * 減らした分は表示側で少し大きくして密度を保つ（impostor.ts の uImp.z を見た拡大）。
   */
  private updateImpostorChunks(cx: number, cz: number) {
    if (!this.atlas.baked) return;
    const far = this.impFar;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i], info = this.chunkInfo[i];
      const d = Math.max(0, Math.hypot(info.cx - cx, info.cz - cz) - info.r);
      if (d > far) {
        c.visible = false;
        continue;
      }
      c.visible = true;
      const t = Math.min(1, Math.max(0, (d - far * 0.06) / (far * 0.55)));
      const frac = 1 - 0.85 * t * t * (3 - 2 * t);
      c.count = Math.max(1, Math.ceil(info.full * frac));
    }
  }

  private rebuildLists(cx: number, cz: number) {
    const t = this.tier;
    const sc = this.scatter;
    const V = TREE_VARIANTS.length;
    const nearList: number[][] = [], midList: number[][] = [], farList: number[][] = [];
    for (let v = 0; v < V; v++) {
      nearList.push([]);
      midList.push([]);
      farList.push([]);
    }
    const margin = 8;
    // 影は r1 の内側を LOD1 が、外側 shadowR までを円錐プロキシが受け持つ。
    // これが無いと 100m 先の林が影を落とさず、中景が「均一に明るい模型」に見える
    forEachInRadius(sc, cx, cz, t.shadowR, (i, d) => {
      const v = sc.v[i];
      if (d < t.r0 + margin) nearList[v].push(i);
      if (d < t.r1 + margin) midList[v].push(i); // 中景は近カスケードの影も受け持つので 0〜r1 の全部
      // 遠カスケードの影は円錐プロキシ。r0-band より外はすべてプロキシで落とす
      if (d > t.r0 - t.band) farList[v].push(i);
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
            const rad = (1.5 + 3.1 * sc.s[i]) * (0.8 + 0.4 * sc.seed[i]);
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
      // 影プロキシ: count は 0 のまま（影のパスでだけ本数が入る）
      const proxy = this.shadowFar[v];
      const fl = farList[v];
      if (fl.length > t.capShadow) {
        fl.sort((a, b) => Math.hypot(sc.x[a] - cx, sc.z[a] - cz) - Math.hypot(sc.x[b] - cx, sc.z[b] - cz));
        fl.length = t.capShadow;
      }
      for (let k = 0; k < fl.length; k++) {
        this.composeMatrix(fl[k], _m);
        proxy.setMatrixAt(k, _m);
      }
      proxy.instanceMatrix.needsUpdate = true;
      (proxy.userData.setCount as (n: number) => void)(fl.length);
      proxy.count = 0;
    }
    this.litter.count = litterN;
    this.litter.instanceMatrix.needsUpdate = true;
    this.stats.near = nearList.reduce((a, b) => a + b.length, 0);
    this.stats.mid = midList.reduce((a, b) => a + b.length, 0);
    this.stats.far = farList.reduce((a, b) => a + b.length, 0);
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
