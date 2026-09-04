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
    // コマの中に**透明の余白**を残す（横 8%・上 8%）。余白が無いと、ミップの段で
    // となりのコマ（別の方位・上の段の根元＝不透明な幹）がにじみ、
    // 木の真ん中に幹色のひし形が出たり、ビルボードの上端に横線の点線が出る（批評 R6 の 2 位・新規 3 番）
    for (const g of geos) this.frames.push({ W: g.radius * 2.32, Hf: g.topY + g.H * 0.085, below: g.H * 0.04 });
  }

  /**
   * アルファの**内側の穴だけ**を塞ぐ（モルフォロジーのクロージング: 膨張 3 回 → 収縮 2 回）。
   * 膨張だけだと輪郭ごと太って、150m の木が「緑のマインクラフト」になる（批評 R6 の 2 位）。
   * 収縮で輪郭を戻すと、**外形はそのまま・枝と枝の 1〜2px の隙間だけが埋まる**。
   * 元の RT に書き戻すので、テクスチャ参照は変わらない。
   */
  private dilateAlpha(renderer: THREE.WebGLRenderer, targets: THREE.WebGLRenderTarget[]) {
    const w = targets[0].width, h = targets[0].height;
    const tmp = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    tmp.texture.colorSpace = THREE.NoColorSpace;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
        uCells: { value: new THREE.Vector2(IMP_AZ * this.geos.length, IMP_ROWS) },
        uErode: { value: 0 },
      },
      vertexShader: DILATE_SHADER.vertexShader,
      fragmentShader: DILATE_SHADER.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene();
    sc.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w / renderer.getPixelRatio(), h / renderer.getPixelRatio());
    // 膨張 4 回 → 収縮 3 回。差し引き 1px だけ外形が太り、内側の 3px までの穴が埋まる。
    // 膨張だけを 2 回かけると孤立した針が 5x5 のブロックに育つ（批評 R6 の 2 位）ので、
    // 必ず収縮で戻すこと
    const passes: number[] = [0, 0, 0, 0, 1, 1, 1];
    for (const rt of targets) {
      for (const erode of passes) {
        mat.uniforms.uErode.value = erode;
        mat.uniforms.uTex.value = rt.texture;
        renderer.setRenderTarget(tmp);
        renderer.render(sc, cam);
        mat.uniforms.uTex.value = tmp.texture;
        renderer.setRenderTarget(rt);
        renderer.render(sc, cam);
      }
    }
    mat.uniforms.uErode.value = 0;
    tmp.dispose();
    mat.dispose();
    quad.geometry.dispose();
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
    // 法線の透明画素は「上向き」で埋める。(0,0,1)＝カメラ正面で埋めると、
    // 輪郭のにじんだ画素だけ太陽が当たらず、樹冠の縁に真っ黒な四角い塊が並ぶ
    // （批評 R6 の 2 位「十字形のブロックの塊」）
    const clears: THREE.Color[] = [new THREE.Color(0.045, 0.085, 0.04), new THREE.Color(0.5, 1.0, 0.5), new THREE.Color(1, 1, 1)];
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
    // アルファの穴埋め（膨張）。焼いた樹冠には枝と枝の 1〜3px の隙間が残り、
    // 明るい空を背にすると「白いピンホール」として点々と読める。
    // 3x3 で最もアルファの高いテクセルを取る＝輪郭を 1px 太らせつつ内側の穴を塞ぐ。
    // 250px のコマで 1px なので輪郭はほぼ変わらない
    this.dilateAlpha(renderer, [this.albedo, this.normal, this.skeleton]);

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

const DILATE_SHADER = {
  vertexShader: /* glsl */ `
    varying vec2 vUvD;
    void main(){ vUvD = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uTex;
    uniform vec2 uTexel;
    uniform vec2 uCells;   // アトラスの列数・行数
    uniform float uErode;  // 0 = 膨張（3x3 の最大） / 1 = 収縮（3x3 の最小）
    varying vec2 vUvD;
    void main(){
      // **コマの外へはみ出して読まない**。隣のコマ（別の方位・別の仰角の木）の
      // アルファを取り込むと、コマの境目に水平な板や「金床」の形ができる
      vec2 cs = 1.0 / uCells;
      vec2 ci = floor(vUvD * uCells);
      vec2 lo = ci * cs + 0.5 * uTexel;
      vec2 hi = (ci + 1.0) * cs - 0.5 * uTexel;
      vec4 c0 = texture2D(uTex, vUvD);
      vec4 best = c0;
      float mn = c0.a;
      // **条件分岐の中で texture2D を呼ばない**（導関数が未定義になる）
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 uv = clamp(vUvD + vec2(float(i), float(j)) * uTexel, lo, hi);
          vec4 s = texture2D(uTex, uv);
          if (s.a > best.a) best = s;
          mn = min(mn, s.a);
        }
      }
      // 収縮では色は動かさない（透明画素の色を引き込むと縁が濁る）。アルファだけ下げる
      gl_FragColor = uErode > 0.5 ? vec4(c0.rgb, mn) : best;
    }`,
};

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
          // 葉のカードは裏から見ても法線を下に向けない。裏面で反すと真上の太陽が当たらず、
          // 焼いたコマの樹冠に**真っ黒な四角いカード**が点々と並ぶ（批評 R6 の 2 位）。
          // 本物の針葉は薄くて光を透かすので、裏から見ても「上から照らされた」明るさになる
          if (vTree.z > 0.5 && vTree.z < 1.5) nn.y = abs(nn.y);
          // 焼き込みの法線は**円錐の法線を強く**混ぜる（0.6 → 0.85）。カードごとの法線を残すと、
          // 太陽と反対を向いたカードだけが空の色だけで照らされ、樹冠に灰青の四角い塊が並ぶ
          vec3 n = vTree.z > 0.5 ? normalize(mix(nn, vConeN, 0.85)) : nn;
          gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
        }
      }`,
  });
}

export type ImpostorOpts = { r1: number; band: number; far: number; farBand: number };

/** ビルボードの材質。instanceMatrix から位置・大きさ・向きを取り、aVar で種類を選ぶ。 */
export function makeImpostorMaterial(env: Env, lighting: Lighting, atlas: ImpostorAtlas, o: ImpostorOpts, msaa: boolean): THREE.MeshStandardMaterial {
  // 遠景のしきい値は 0.5 ではなく 0.34。1〜2px の隙間が「白い点」として残らない
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.34 });
  // 2km の木は 6px しかない。アルファテストだけだと「描く／描かない」の 2 値なので、
  // 樹冠の被覆 3 割の板がまるごと不透明な矩形になり、空にうっすらした膜と点線ができる
  // （批評 R6 の「1〜3km は胡椒」「空を横切る 1px の点線」の正体）。
  // 4x MSAA のカバレッジに落とすと、被覆 3 割は 1/4 の被覆として空と混ざる
  mat.alphaToCoverage = msaa;
  // three の alphatest_fragment は ALPHA_TO_COVERAGE でも `smoothstep(alphaTest, alphaTest+fwidth(a), a)`
  // ＝ ほぼ 2 値に戻してしまう（ミップで平均されたアルファは画素間でなだらかなので fwidth が小さい）。
  // 被覆率をカバレッジへ渡すために、このチャンクは自前のものに差し替える（下の "imp fs alphatest"）。
  // MSAA が無い段（low / mid）は画面ディザで確率的に間引く
  mat.defines = { ...(mat.defines ?? {}), VEG_IMP_A2C: msaa ? 1 : 0 };
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
        varying float vSeed;
        varying float vImpFar;
`,
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
        scl *= 1.0 + 0.30 * thin;
        // 遠景の度合い。0 = 近景（r0 のすぐ外）/ 1 = 視程の端
        vImpFar = smoothstep(uImp.z * 0.22, uImp.z * 0.85, dist);
        int vi = int(aVar + 0.5);
        vec4 fr = uFrames[vi];
        vec2 toCam2 = cameraPosition.xz - root.xz;
        float dc = max(length(toCam2), 1e-3);
        vec2 tc = toCam2 / dc;
        vec3 right = vec3(-tc.y, 0.0, tc.x);
        // 幅だけ木ごとに ±22% 振る。同じ輪郭が等間隔に並ぶと「胡椒の粒」に見える
        float W = fr.x * scl * (0.70 + 0.66 * flip_hash11(seed * 23.0 + 9.0));
        float Hh = fr.y * scl;
        // 遠いほど横に広げて、隣の木と輪郭がつながった「林の塊」にする（1 本ずつ立てない）
        W *= 1.0 + 1.15 * vImpFar;
        vec2 wd = veg_windDir();
        float gust = veg_gust(root.xz);
        float sway = (0.004 + 0.010 * uWind.z) * gust * Hh * position.y * position.y;
        vec3 wp = root + right * (position.x * W) + vec3(0.0, position.y * Hh - fr.z * scl, 0.0) + vec3(wd.x, 0.0, wd.y) * sway;
        float az = atan(tc.y, tc.x) - yaw;
        float cellF = fract(az / 6.2831853) * ${IMP_AZ}.0;
        float c0 = floor(cellF);
        float el = atan(cameraPosition.y - (root.y + 0.5 * Hh), dc);
        float rowBlend = 0.0;
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
        varying float vImpFar;
        vec2 veg_impUv(float c, float row){
          float col = vImp2.z * uAtlasN2.x + mod(c, uAtlasN2.x);
          // コマの縁から 2% 内側までしか引かない（余白の中で止める）
          float uu = clamp(vImp2.x, 0.020, 0.980);
          float vv = clamp(vImp2.y, 0.004, 0.972);
          return vec2((col + uu) / (uAtlasN2.x * uAtlasN2.y), (row + vv) / ${IMP_ROWS}.0);
        }
        // 4 コマを必ず引いて混ぜる。**条件分岐の中で texture2D を呼ばない**こと:
        // 分岐の中では導関数が未定義になり、GPU が最も粗いミップを選んで
        // 木が「50×90px のぼやけた矩形」に化ける（批評 R2 の 4 位の原因）
        // アトラスのミップは**被覆率そのもの**（焼いたアルファは 2 値なので、単純平均＝被覆率）。
        //
        // 原寸（L=0）では 2 値なので 0.5 の等値線で鋭くしてよい。
        // **縮小したら鋭くしてはいけない。** 鋭くすると、樹冠の薄い縁（＝下ほど広がる裾、
        // 尖った梢、張り出した枝）が全部しきい値を割って消え、残るのは幹まわりの濃い芯だけになる。
        // それが 400m〜1.5km の木を「頭が平らで、上から下まで同じ幅で、等間隔に並んだ緑の杭」に
        // 変えていた（統合担当の 1 位／批評R7 の 7 番「明るい緑の角棒」）。
        // 縮小したぶんは被覆率のままアルファ→カバレッジに渡す。被覆 3 割の樹冠は
        // 「3 割の濃さの塊」として空や地形と混ざり、隣の木と輪郭がつながって林の塊になる。
        float veg_impCoverage(float a){
          vec2 tx = fwidth(vImp2.xy) * uAtlasCell;
          // 4 段（コマの 1/16）まで見る。ここを 2.5 段で止めると、遠景で L が飽和して
          // 「鋭くする」側が効きっぱなしになる
          float L = clamp(log2(max(max(tx.x, tx.y), 1.0)), 0.0, 4.0);
          float sharp = smoothstep(0.42, 0.58, a);
          // 焼いた樹冠はカードの隙間が多く、被覆率がそのままだと遠景の木が背景に溶けて
          // 「幽霊」になる。本物の針葉樹の樹冠は奥行きがあって 8〜9 割の光を止めるので、
          // 「重なった層」として被覆率を持ち上げる（1-(1-a)^n）。**縁の薄いところは薄いまま**なので
          // 細り・尖った梢は消えない
          float cov = 1.0 - pow(1.0 - a, 3.0);
          // L=0.7（1.6 テクセル/画素）から L=2（4 テクセル/画素）にかけて被覆率へ渡す
          return mix(sharp, cov, smoothstep(0.7, 2.0, L));
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
            diffuseColor = vec4(FLIP_LINE * (0.35 + 0.65 * sk.a), veg_impCoverage(sk.a));
          } else {
            vec4 alb = veg_impSample(uAtlasA);
            alb.a = veg_impCoverage(alb.a);
            vec4 nrm = veg_impSample(uAtlasN);
            vec3 tint = mix(vec3(1.08, 1.0, 0.78), vec3(0.82, 1.0, 1.2), vSeed) * (0.8 + 0.4 * flip_hash11(vSeed * 3.0 + 0.2));
            // 遠景の林は「上から陽の当たる樹冠の塊」。ただし**地形より明るくしない**。
            // 明るくすると遠いほど目立って「緑のクレヨンで引いた線」になる（批評R7 の 7 番②）
            diffuseColor = vec4(alb.rgb * tint * (1.0 - 0.10 * vImpFar), alb.a);
            vec3 nl = nrm.xyz * 2.0 - 1.0;
            impN = normalize(vRight * nl.x + vec3(0.0, 1.0, 0.0) * nl.y + vFace * nl.z);
          }
        }`,
        "imp fs map",
      );
      // three の alphatest_fragment を外して、被覆率をそのままカバレッジに渡す。
      // これが無いと 400m 以遠の樹冠が「濃い芯だけ残った緑の杭」になる
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        "#include <alphatest_fragment>",
        `#if VEG_IMP_A2C
        // アルファ→カバレッジ（4x MSAA）。被覆 0.3 の樹冠は 0.3 の濃さで背景と混ざる
        if (diffuseColor.a < 0.03) discard;
        #else
        // MSAA が無い段は画面ディザで確率的に間引く（2 値のしきい値だと輪郭が痩せる）
        if (diffuseColor.a < 0.03 + 0.94 * veg_ign(gl_FragCoord.xy + vec2(vSeed * 37.0))) discard;
        diffuseColor.a = 1.0;
        #endif`,
        "imp fs alphatest",
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
        `// 遠景の樹冠は「上から照らされた塊」。透過を上げて日陰側が真っ黒にならないようにする
        float vegTrans = 0.42;
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
