// 植生。草（GPU 配置・風・影）、針葉樹（LOD・インポスター・風）、岩・小石、裏返し表現。
// 契約:
//   - 地面の高さは GPU 側なら flip_height(xz)、CPU 側なら heightAt / sampleHeightmap（同じハイトマップ）
//   - 草・小石など細かいものは LAYER.MAIN_ONLY（映り込みには出さない）。木・岩は既定レイヤ
//   - 影は CSM: patchMaterial(mat, env, hook, { csm: lighting }) と mesh.castShadow / receiveShadow
//   - 風は env.uniforms.uWind（xy = 向き, z = m/s）。頂点シェーダで揺らす（customDepthMaterial にも同じ変位）
//   - 裏返し: flip_mask(worldPos) で骨組み（線）表示に切り替える
// デバッグ: ?dbg=noveg / nograss / notrees / norocks
import * as THREE from "three";
import type { Env } from "../core/env";
import type { Lighting } from "../core/lighting";
import type { QualitySettings } from "../core/quality";
import { heightAt } from "../core/heightfield";
import { bakeVegMap, type VegMap } from "./vegmap";
import { Grass } from "./grass";

export class Vegetation {
  group = new THREE.Group();
  vegmap: VegMap;
  grass: Grass | null = null;

  constructor(public scene: THREE.Scene, public env: Env, public lighting: Lighting, public q: QualitySettings) {
    scene.add(this.group);
    const dbg = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("dbg") ?? "") : "";
    const off = (k: string) => dbg.includes("noveg") || dbg.includes(k);
    const t0 = performance.now();
    this.vegmap = bakeVegMap(env.heightmap, q.tier === "low" ? 384 : 512);
    const t1 = performance.now();
    if (!off("nograss")) this.grass = new Grass(this.group, env, lighting, q, this.vegmap);
    if (dbg.includes("vegtime")) console.info(`[vegetation] vegmap ${(t1 - t0).toFixed(0)}ms`);
    if (dbg.includes("shadowtest")) {
      // 影の動作確認用の柱（調査用）
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 8, 1.5), new THREE.MeshStandardMaterial({ color: 0x884422 }));
      box.position.set(3, heightAt(3, 364) + 4, 364);
      box.castShadow = true;
      box.receiveShadow = true;
      this.group.add(box);
    }
  }

  update(_dt: number) {
    this.grass?.update();
  }
}
