// GLSL チャンクの登録。エンジン起動時に1回呼ぶ。
// これで全ての ShaderMaterial / onBeforeCompile から `#include <flip_xxx>` が使える。
import * as THREE from "three";
import { FLIP_NOISE } from "./glsl/noise.glsl";
import { FLIP_HEIGHT } from "./glsl/height.glsl";
import { FLIP_ATMOSPHERE } from "./glsl/atmosphere.glsl";
import { FLIP_FLIP } from "./glsl/flip.glsl";

let registered = false;
export function registerChunks() {
  if (registered) return;
  registered = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.flip_noise = FLIP_NOISE;
  chunks.flip_height = FLIP_HEIGHT;
  chunks.flip_atmosphere = FLIP_ATMOSPHERE;
  chunks.flip_flip = FLIP_FLIP;
}

/** 差し替え用: 空モジュールなどが実装を入れ替えるときに使う。 */
export function overrideChunk(name: "flip_atmosphere" | "flip_flip" | "flip_noise" | "flip_height", src: string) {
  (THREE.ShaderChunk as unknown as Record<string, string>)[name] = src;
}
