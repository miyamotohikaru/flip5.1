// ポスト処理。土台版: 露出→トーンマップ(AgX)→ビネット の1パス。
// ポスト担当が ブルーム／ゴッドレイ／SMAA／AO／被写界深度／色調／粒子ノイズ／写真モードの高解像度書き出し を作る。
// 契約:
//   - 入力は pipeline.sceneRT（HDR 線形）。出力は画面（null）または指定 RT
//   - トーンマップは renderer.toneMapping（AgX）と #include <tonemapping_fragment> で掛かる。線形の RT へ描くときは掛からない
//   - renderToTarget(target) で写真モード用に任意解像度へ出せること
import * as THREE from "three";
import type { Env } from "../core/env";
import { FS_VERT, type Pipeline } from "../core/pipeline";
import type { QualitySettings } from "../core/quality";

export class Post {
  final: THREE.ShaderMaterial;
  constructor(public env: Env, public q: QualitySettings) {
    this.final = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1 },
        uVignette: { value: 0.35 },
        uFlip: { value: 0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uExposure; uniform float uVignette; uniform float uFlip;
        varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
          vec2 d = vUv - 0.5;
          float v = 1.0 - uVignette * smoothstep(0.25, 0.95, dot(d, d) * 2.2);
          c *= v;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
  }

  render(pipeline: Pipeline, target: THREE.WebGLRenderTarget | null = null) {
    this.final.uniforms.tDiffuse.value = pipeline.sceneRT.texture;
    this.final.uniforms.uExposure.value = this.env.exposure;
    this.final.uniforms.uFlip.value = this.env.flip;
    pipeline.blit(this.final, target);
  }

  resize(_w: number, _h: number) {}
}
