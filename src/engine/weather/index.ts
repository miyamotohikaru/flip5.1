// 天気の表現。土台版は空。天気担当が雨（筋・しぶき・水面の波紋）・霧のむら・稲光・花粉・蛍などを作る。
// 契約:
//   - 状態は env.weather（cloud / rain / fog / wind / wetness / storm）。ここでは状態を作らず、見た目だけを担当
//   - 雨など半透明は LAYER.TRANSPARENT（水面の後に描かれる）
//   - 稲光は env.sunColor / lighting に短時間の加算で表現してよい（env.uniforms.uStorm を使う）
//   - 裏返し: 粒子は座標の点（ドット）として見せる
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import type { QualitySettings } from "../core/quality";

export class Weather {
  group = new THREE.Group();
  constructor(public scene: THREE.Scene, public env: Env, public lighting: Lighting, public q: QualitySettings) {
    scene.add(this.group);
  }
  update(_dt: number) {}
}
