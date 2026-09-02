// 描画の順番と中間バッファ。
//   1. renderOpaque   … 不透明物＋空 → sceneRT（HDR, MSAA, 深度テクスチャ）
//   2. copyScene      … sceneRT → copyRT（色）/ copyDepthRT（線形深度）。水の屈折・水深用
//   3. renderTransparent … 水・雨など → sceneRT に上描き（クリアしない）
//   4. post.render    … sceneRT → 画面（ポスト処理はここ）
import * as THREE from "three";
import type { QualitySettings } from "./quality";

export const LAYER = {
  /** 不透明（既定） */
  OPAQUE: 0,
  /** 水面。copyScene の後に描く */
  WATER: 1,
  /** 雨・粒子など半透明。水の後に描く */
  TRANSPARENT: 2,
  /** 空。不透明の最後に描く */
  SKY: 3,
  /** 映り込みには出さないもの（草・小石・粒子）。主カメラと影カメラだけが見る */
  MAIN_ONLY: 5,
} as const;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class Pipeline {
  sceneRT: THREE.WebGLRenderTarget;
  copyRT: THREE.WebGLRenderTarget;
  copyDepthRT: THREE.WebGLRenderTarget;
  width = 1;
  height = 1;
  /** 画面のピクセル解像度（renderScale 適用前） */
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsMesh: THREE.Mesh;
  private copyMat: THREE.ShaderMaterial;
  private depthMat: THREE.ShaderMaterial;
  floatDepth: boolean;

  constructor(public renderer: THREE.WebGLRenderer, public scene: THREE.Scene, public q: QualitySettings) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.floatDepth = !!gl.getExtension("EXT_color_buffer_float");
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    depthTexture.format = THREE.DepthFormat;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: q.msaaSamples,
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.copyRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.copyDepthRT = new THREE.WebGLRenderTarget(1, 1, {
      type: this.floatDepth ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RedFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    // フルスクリーン三角形
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.depthMat = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 9000 } },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDepth; uniform float uNear; uniform float uFar; varying vec2 vUv;
        void main(){
          float z = texture2D(tDepth, vUv).r;
          float ndc = z * 2.0 - 1.0;
          float lin = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
          gl_FragColor = vec4(lin, 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.fsMesh = new THREE.Mesh(geo, this.copyMat);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);
  }

  /** 描画バッファの実サイズ（renderScale 適用後） */
  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneRT.setSize(this.width, this.height);
    this.copyRT.setSize(this.width, this.height);
    this.copyDepthRT.setSize(this.width, this.height);
  }

  renderOpaque(camera: THREE.Camera) {
    const r = this.renderer;
    camera.layers.set(LAYER.OPAQUE);
    camera.layers.enable(LAYER.SKY);
    camera.layers.enable(LAYER.MAIN_ONLY);
    r.setRenderTarget(this.sceneRT);
    r.autoClear = true;
    r.clear(true, true, true);
    r.render(this.scene, camera);
  }

  copyScene(camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    this.fsMesh.material = this.copyMat;
    this.copyMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    r.setRenderTarget(this.copyRT);
    r.render(this.fsScene, this.fsCam);
    this.fsMesh.material = this.depthMat;
    this.depthMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
    this.depthMat.uniforms.uNear.value = camera.near;
    this.depthMat.uniforms.uFar.value = camera.far;
    r.setRenderTarget(this.copyDepthRT);
    r.render(this.fsScene, this.fsCam);
  }

  renderTransparent(camera: THREE.Camera) {
    const r = this.renderer;
    camera.layers.set(LAYER.WATER);
    camera.layers.enable(LAYER.TRANSPARENT);
    r.setRenderTarget(this.sceneRT);
    r.autoClear = false;
    r.render(this.scene, camera);
    r.autoClear = true;
    camera.layers.enableAll();
  }

  /** フルスクリーン描画のためのユーティリティ（ポスト処理で使う） */
  blit(material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.fsMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  dispose() {
    this.sceneRT.dispose();
    this.copyRT.dispose();
    this.copyDepthRT.dispose();
  }
}

export { FS_VERT };
