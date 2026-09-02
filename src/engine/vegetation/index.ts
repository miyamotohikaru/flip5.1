// 植生。土台版は空。植生担当が草（GPU で配置・風・影）・針葉樹（LOD・インポスター）・岩・小石を作る。
// 契約:
//   - 地面の高さは GPU 側なら flip_height(xz)、CPU 側なら heightAt(x, z)
//   - 草・小石など細かいものは LAYER.MAIN_ONLY（映り込みには出さない）。木・岩は既定レイヤ
//   - 影は CSM: patchMaterial(mat, env, hook, { csm: lighting }) と mesh.castShadow / receiveShadow
//   - 風は env.uniforms.uWind（xy = 向き, z = m/s）。頂点シェーダで揺らす（customDepthMaterial にも同じ変位）
//   - 裏返し: flip_mask(worldPos) で骨組み（線）表示に切り替える
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import type { QualitySettings } from "../core/quality";

export class Vegetation {
  group = new THREE.Group();
  constructor(public scene: THREE.Scene, public env: Env, public lighting: Lighting, public q: QualitySettings) {
    scene.add(this.group);
  }
  update(_dt: number) {}
}
