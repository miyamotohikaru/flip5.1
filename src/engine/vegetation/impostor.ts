// 遠景の木＝インポスター。起動時に LOD0 の木を 8 方位 × 2 仰角で描いたアトラス（色 / 法線 / 骨組み）を
// 実行時に作り、1 本 2 三角形のビルボードに貼る。方位は隣り合う 2 コマを混ぜて回り込みの飛びを消す。
// 光は法線アトラスで実行時に当てる（CSM の影も受ける）。裏返しは骨組みアトラスに切り替わる。
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import { patchMaterial, replaceOnce } from "../core/patch";
import { TREE_FRAG_COLOR, TREE_VERT, type TreeGeo } from "./conifer";
import { VEG_FRAG_DITHER, VEG_LIGHTS_FRAGMENT, VEG_VERT_COMMON } from "./shaders";

export const IMP_AZ = 8;
export const IMP_ROWS = 2;
const IMP_ELEV = [0, (35 * Math.PI) / 180];

export type ImpostorFrame = { W: number; Hf: number; below: number };

export class ImpostorAtlas {
  albedo: THREE.WebGLRenderTarget;
  normal: THREE.WebGLRenderTarget;
  skeleton: THREE.WebGLRenderTarget;
  frames: ImpostorFrame[] = [];
  baked = false;
  cellW: number;
  cellH: number;

  constructor(public geos: TreeGeo[], cellH: number, public needle: THREE.Texture) {
    this.cellH = cellH;
    this.cellW = cellH / 2;
    const w = this.cellW * IMP_AZ * geos.length, h = cellH * IMP_ROWS;
    const mk = (mips: boolean) => {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        // ミップは要る（400m 先の木は 10px。無いとチラつく）。
        // ただしミップで平均されたアルファをそのままアルファテストに掛けると木が太って
        // 「ぼやけた矩形」になるので、表示側で 0.5 の等値線を保つように鋭くする（下の uAtlasCell）
        generateMipmaps: mips,
        minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
      rt.texture.anisotropy = 4;
      rt.texture.colorSpace = THREE.NoColorSpace;
      return rt;
    };
    this.albedo = mk(true);
    this.normal = mk(true);
    this.skeleton = mk(true);
    // 枠は「実際に置いた頂点」から決める。カードの伸ばし方を変えると枠からはみ出して、
    // 遠景の木が上と横を切られた矩形になる
    for (const g of geos) this.frames.push({ W: g.radius * 2.12, Hf: g.topY + g.H * 0.06, below: g.H * 0.04 });
  }

  /** 描く。主描画の途中（onBeforeRender）から呼ばれるので、状態を全部戻す。 */
  bake(renderer: THREE.WebGLRenderer) {
    if (this.baked) return;
    this.baked = true;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevViewport = new THREE.Vector4();
    renderer.getViewport(prevViewport);
    const prevScissor = new THREE.Vector4();
    renderer.getScissor(prevScissor);
    const prevScissorTest = renderer.getScissorTest();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;

    // setViewport / setScissor は CSS 画素で受け取り、内部で devicePixelRatio を掛ける。
    // 携帯（DPR 2〜3）では、そのまま渡すとコマが 2〜3 倍の大きさで焼かれて隣の段へはみ出し、
    // 木が「上を切った矩形」になっていた（携帯だけ木が黒い板になる原因）
    const pr = renderer.getPixelRatio();
    const scene = new THREE.Scene();
    const mat = makeBakeMaterial(this.needle);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    const meshes = this.geos.map((g) => {
      const m = new THREE.InstancedMesh(g.geometry, mat, 1);
      m.setMatrixAt(0, new THREE.Matrix4());
      m.frustumCulled = false;
      m.visible = false;
      scene.add(m);
      return m;
    });
    renderer.autoClear = false;
    // 透明画素の色は「縁ににじんでも目立たない色」で埋める（黒い縁取りを防ぐ）
    const clears: THREE.Color[] = [new THREE.Color(0.045, 0.085, 0.04), new THREE.Color(0.5, 0.5, 1.0), new THREE.Color(1, 1, 1)];
    const targets: [THREE.WebGLRenderTarget, number][] = [[this.albedo, 0], [this.normal, 1], [this.skeleton, 2]];
    for (const [rt, mode] of targets) {
      renderer.setRenderTarget(rt);
      renderer.setScissorTest(false);
      renderer.setClearColor(clears[mode], 0);
      renderer.clear(true, true, false);
      mat.uniforms.uMode.value = mode;
      mat.uniforms.uForceFlip.value = mode === 2 ? 1 : 0;
      for (let v = 0; v < this.geos.length; v++) {
        const g = this.geos[v];
        const fr = this.frames[v];
        meshes.forEach((m, i) => (m.visible = i === v));
        for (let row = 0; row < IMP_ROWS; row++) {
          const el = IMP_ELEV[row];
          for (let a = 0; a < IMP_AZ; a++) {
            const az = (a / IMP_AZ) * Math.PI * 2;
            const cx = (v * IMP_AZ + a) * this.cellW, cy = row * this.cellH;
            const center = new THREE.Vector3(0, g.H * 0.5, 0);
            const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
            cam.position.copy(center).addScaledVector(dir, 120);
            cam.up.set(0, 1, 0);
            cam.lookAt(center);
            // 根元がコマの下端に来るように（仰角があるときは根元の投影が上がる）
            const rootY = -g.H * 0.5 * Math.cos(el);
            cam.left = -fr.W / 2;
            cam.right = fr.W / 2;
            cam.bottom = rootY - fr.below;
            cam.top = cam.bottom + fr.Hf;
            cam.updateProjectionMatrix();
            cam.updateMatrixWorld();
            renderer.setViewport(cx / pr, cy / pr, this.cellW / pr, this.cellH / pr);
            renderer.setScissor(cx / pr, cy / pr, this.cellW / pr, this.cellH / pr);
            renderer.setScissorTest(true);
            renderer.render(scene, cam);
          }
        }
      }
    }
    // 後始末
    for (const m of meshes) m.geometry.dispose === undefined ? 0 : 0;
    mat.dispose();
    renderer.setScissorTest(prevScissorTest);
    renderer.setScissor(prevScissor);
    renderer.setViewport(prevViewport);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setRenderTarget(prevRT);
  }
}

/** 焼き込み用: 色 / 法線 / 骨組み を uMode で切り替える */
function makeBakeMaterial(needle: THREE.Texture): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    uMode: { value: 0 },
    uNeedle: { value: needle },
    uNeedleSize: { value: (needle.image as HTMLCanvasElement | undefined)?.width ?? 512 },
    uTreeH: { value: 1 },
    uLod: { value: new THREE.Vector4(1e6, 1e6, 1, 2) },
    uForceFlip: { value: 0 },
    uReflect: { value: 0 },
    uLineMin: { value: 0.20 },  // 骨組みを焼くときは太めに（縮小で線が消えて「白い粒」になるため）
    uTintMix: { value: 0 },   // 焼き込みは無彩の（個体の色味を掛けない）アルベド。色味は表示側で掛ける
    uCamPos: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector3(1, 0, 0) },
    uLakeLevel: { value: 0 },
    uFlipRadius: { value: 0 },
    uFlipCenter: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uFlip: { value: 0 },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    defines: { VEG_BAKE: 1 },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <flip_noise>
      ${VEG_VERT_COMMON}
      ${TREE_VERT}
      varying vec3 vBakeN;
      void main(){
        vec3 p; vec3 n; veg_tree(p, n);
        vBakeN = normalize(mat3(viewMatrix) * mat3(instanceMatrix) * n);
        gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <flip_noise>
      #include <flip_flip>
      ${TREE_FRAG_COLOR}
      uniform int uMode;
      varying vec3 vBakeN;
      void main(){
        if (uMode == 2) { gl_FragColor = vec4(1.0); return; }
        float relief;
        vec4 c = veg_treeAlbedo(relief);
        if (c.a < 0.45) discard;
        if (uMode == 0) {
          gl_FragColor = vec4(c.rgb * (0.7 + 0.3 * veg_treeAO()), 1.0);
        } else {
          vec3 nn = vBakeN * (gl_FrontFacing ? 1.0 : -1.0);
          vec3 n = vTree.z > 0.5 ? normalize(mix(nn, vConeN, 0.6)) : nn;
          gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
        }
      }`,
  });
}

export type ImpostorOpts = { r1: number; band: number; far: number; farBand: number };

/** ビルボードの材質。instanceMatrix から位置・大きさ・向きを取り、aVar で種類を選ぶ。 */
export function makeImpostorMaterial(env: Env, lighting: Lighting, atlas: ImpostorAtlas, o: ImpostorOpts, msaa: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 });
  // 遠景のビルボードでカバレッジ・ディザを使うと「網戸」になる
  mat.alphaToCoverage = false;
  void msaa;
  const frames = atlas.frames.map((f) => new THREE.Vector4(f.W, f.Hf, f.below, 0));
  while (frames.length < 4) frames.push(new THREE.Vector4(1, 1, 0, 0));
  patchMaterial(
    mat,
    env,
    (shader) => {
      shader.uniforms.uAtlasA = { value: atlas.albedo.texture };
      shader.uniforms.uAtlasN = { value: atlas.normal.texture };
      shader.uniforms.uAtlasS = { value: atlas.skeleton.texture };
      shader.uniforms.uFrames = { value: frames };
      shader.uniforms.uImp = { value: new THREE.Vector4(o.r1, o.band, o.far, o.farBand) };
      shader.uniforms.uAtlasN2 = { value: new THREE.Vector2(IMP_AZ, atlas.geos.length) };
      shader.uniforms.uAtlasCell = { value: new THREE.Vector2(atlas.cellW, atlas.cellH) };
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <common>",
        `#include <common>
        #include <flip_noise>
        ${VEG_VERT_COMMON}
        attribute float aVar;
        uniform vec4 uFrames[4];
        uniform vec4 uImp;
        varying vec4 vImp;      // コマ, 方位の混ぜ, 仰角の混ぜ, fade
        varying vec4 vImp2;     // uv.xy, 種類, 裏返し
        varying vec3 vVegWorld;
        varying vec3 vRight;
        varying vec3 vFace;
        varying float vSeed;`,
        "imp vs common",
      );
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <beginnormal_vertex>",
        `mat4 imp = instanceMatrix;
        vec3 root = imp[3].xyz;
        float scl = max(length(imp[1].xyz), 1e-4);
        float yaw = atan(imp[0].z, imp[0].x);
        float dist = distance(root.xz, uCamPos.xz);
        float seed = flip_hash12(floor(root.xz * 3.7 + 0.5));
        // メッシュ側と同じ「木ごとにばらけた切り替え距離」。画素ごとのディザ（網戸）を使わない
        float lodJit = flip_hash11(seed * 31.0 + 5.0);
        float fade = step(uImp.x - uImp.y * lodJit, dist) * step(dist, uImp.z - uImp.w * flip_hash11(seed * 17.0 + 2.0));
        // 間引きは CPU 側（チャンクごとの count）でやる。ここでは減った分だけ少し大きくして密度を保つ
        float thin = smoothstep(uImp.z * 0.12, uImp.z * 0.75, dist);
        scl *= 1.0 + 0.55 * thin;
        int vi = int(aVar + 0.5);
        vec4 fr = uFrames[vi];
        vec2 toCam2 = cameraPosition.xz - root.xz;
        float dc = max(length(toCam2), 1e-3);
        vec2 tc = toCam2 / dc;
        vec3 right = vec3(-tc.y, 0.0, tc.x);
        float W = fr.x * scl, Hh = fr.y * scl;
        vec2 wd = veg_windDir();
        float gust = veg_gust(root.xz);
        float sway = (0.004 + 0.010 * uWind.z) * gust * Hh * position.y * position.y;
        vec3 wp = root + right * (position.x * W) + vec3(0.0, position.y * Hh - fr.z * scl, 0.0) + vec3(wd.x, 0.0, wd.y) * sway;
        float az = atan(tc.y, tc.x) - yaw;
        float cellF = fract(az / 6.2831853) * ${IMP_AZ}.0;
        float c0 = floor(cellF);
        float el = atan(cameraPosition.y - (root.y + 0.5 * Hh), dc);
        float rowBlend = smoothstep(0.55, 1.05, el);
        float fm = veg_flipMask(root);
        float flipped = step(flip_hash11(seed * 13.0 + 0.5), fm) * step(0.001, fm);
        // 数式ビュー: 遠くの木を全部「骨組み」で描くと白い粒の雲になる。3 本に 1 本だけ残す
        if (flipped > 0.5 && flip_hash11(seed * 7.7 + 3.0) > 0.34) fade = 0.0;
        vImp = vec4(c0, cellF - c0, rowBlend, fade);
        vImp2 = vec4(position.x + 0.5, position.y, aVar, flipped);
        vVegWorld = wp;
        vRight = right;
        vFace = vec3(tc.x, 0.0, tc.y);
        vSeed = seed;
        vec3 objectNormal = vec3(0.0, 1.0, 0.0);`,
        "imp vs normal",
      );
      shader.vertexShader = replaceOnce(shader.vertexShader, "#include <begin_vertex>", `vec3 transformed = vec3(0.0);`, "imp vs begin");
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        "#include <project_vertex>",
        `vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;`,
        "imp vs project",
      );
      shader.vertexShader = replaceOnce(shader.vertexShader, "#include <worldpos_vertex>", `vec4 worldPosition = vec4(wp, 1.0);`, "imp vs worldpos");
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <common>",
        `#include <common>
        #include <flip_noise>
        #include <flip_height>
        #include <flip_atmosphere>
        #include <flip_flip>
        ${VEG_FRAG_DITHER}
        uniform sampler2D uAtlasA;
        uniform sampler2D uAtlasN;
        uniform sampler2D uAtlasS;
        uniform vec2 uAtlasN2;
        uniform vec2 uAtlasCell;
        varying vec4 vImp;
        varying vec4 vImp2;
        varying vec3 vVegWorld;
        varying vec3 vRight;
        varying vec3 vFace;
        varying float vSeed;
        vec2 veg_impUv(float c, float row){
          float col = vImp2.z * uAtlasN2.x + mod(c, uAtlasN2.x);
          return vec2((col + vImp2.x) / (uAtlasN2.x * uAtlasN2.y), (row + vImp2.y) / ${IMP_ROWS}.0);
        }
        // 4 コマを必ず引いて混ぜる。**条件分岐の中で texture2D を呼ばない**こと:
        // 分岐の中では導関数が未定義になり、GPU が最も粗いミップを選んで
        // 木が「50×90px のぼやけた矩形」に化ける（批評 R2 の 4 位の原因）
        // ミップで平均されたアルファを 0.5 の等値線まわりで鋭くする。
        // これをやらないと、縮小するほど木が太って最後はコマ全体が不透明な矩形になる
        float veg_impSharpen(float a){
          vec2 tx = fwidth(vImp2.xy) * uAtlasCell;
          float L = clamp(log2(max(max(tx.x, tx.y), 1.0)), 0.0, 5.0);
          return clamp((a - 0.5) * (1.0 + 1.3 * L) + 0.5, 0.0, 1.0);
        }
        vec4 veg_impSample(sampler2D t){
          vec2 u00 = veg_impUv(vImp.x, 0.0);
          vec2 u10 = veg_impUv(vImp.x + 1.0, 0.0);
          vec2 u01 = veg_impUv(vImp.x, 1.0);
          vec2 u11 = veg_impUv(vImp.x + 1.0, 1.0);
          vec4 s0 = mix(texture2D(t, u00), texture2D(t, u10), vImp.y);
          vec4 s1 = mix(texture2D(t, u01), texture2D(t, u11), vImp.y);
          return mix(s0, s1, vImp.z);
        }`,
        "imp fs common",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        if (vImp.w < fract(veg_ign(gl_FragCoord.xy) + vSeed)) discard;
        vec3 impN = vec3(0.0, 1.0, 0.0);`,
        "imp fs clip",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <map_fragment>",
        `{
          if (vImp2.w > 0.5) {
            vec4 sk = veg_impSample(uAtlasS);
            diffuseColor = vec4(FLIP_LINE * (0.35 + 0.65 * sk.a), veg_impSharpen(sk.a));
          } else {
            vec4 alb = veg_impSample(uAtlasA);
            alb.a = veg_impSharpen(alb.a);
            vec4 nrm = veg_impSample(uAtlasN);
            vec3 tint = mix(vec3(1.08, 1.0, 0.78), vec3(0.82, 1.0, 1.2), vSeed) * (0.8 + 0.4 * flip_hash11(vSeed * 3.0 + 0.2));
            diffuseColor = vec4(alb.rgb * tint, alb.a);
            vec3 nl = nrm.xyz * 2.0 - 1.0;
            impN = normalize(vRight * nl.x + vec3(0.0, 1.0, 0.0) * nl.y + vFace * nl.z);
          }
        }`,
        "imp fs map",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <normal_fragment_begin>",
        `float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
        vec3 normal = normalize((viewMatrix * vec4(impN, 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`,
        "imp fs normal",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <lights_fragment_begin>",
        `float vegTrans = 0.20;
        float vegAO = 1.0;
        float vegSpec = 0.0;
        float vegGloss = 18.0;
        float vegUpMix = 0.25;
        ${VEG_LIGHTS_FRAGMENT}`,
        "imp fs lights",
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <fog_fragment>",
        `gl_FragColor.rgb = flip_applyAerial(gl_FragColor.rgb, vVegWorld);
        if (vImp2.w > 0.5) {
          vec3 fc = FLIP_LINE * 1.0;
          fc += FLIP_ACCENT * flip_edgeGlow(vVegWorld) * 1.5;
          gl_FragColor.rgb = flip_applyAerial(fc, vVegWorld) * 0.7 + fc * 0.3;
        }`,
        "imp fs fog",
      );
    },
    { csm: lighting, key: "veg_impostor_v1" },
  );
  return mat;
}

/** ビルボード 1 枚（x: -0.5..0.5, y: 0..1） */
export function impostorQuad(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  return geo;
}

export { patchMaterial as _impPatch };
