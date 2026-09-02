// マテリアルに「共有 uniforms」「CSM の影」「自前の GLSL 差し替え」をまとめて仕込む。
// MeshStandardMaterial の onBeforeCompile を安全に連結するための唯一の入口。
import * as THREE from "three";
import type { Env } from "./env";
import type { Lighting } from "./lighting";

export type ShaderParams = THREE.WebGLProgramParametersWithUniforms;
export type ShaderHook = (shader: ShaderParams) => void;

let patchSerial = 0;

export type PatchOptions = {
  /** CSM の影を受ける（地形・木・岩など。ShaderMaterial には効かない） */
  csm?: Lighting | null;
  /** プログラムキャッシュのキー。同じ差し替えを複数マテリアルで使うなら同じ文字列にする */
  key?: string;
};

/**
 * material.onBeforeCompile に env.uniforms の参照共有と hook を仕込む。
 * hook の中では shader.vertexShader / fragmentShader を文字列置換してよい。
 */
export function patchMaterial<M extends THREE.Material>(material: M, env: Env, hook: ShaderHook, opts: PatchOptions = {}): M {
  const key = opts.key ?? `flip_patch_${patchSerial++}`;
  let csmHook: ShaderHook | null = null;
  if (opts.csm && "isMeshStandardMaterial" in material) {
    opts.csm.csm.setupMaterial(material);
    csmHook = material.onBeforeCompile as unknown as ShaderHook;
  }
  material.onBeforeCompile = (shader) => {
    csmHook?.(shader);
    bindEnvUniforms(shader.uniforms, env);
    hook(shader);
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}

/** env.uniforms を同じ参照で流し込む（ShaderMaterial の uniforms にもそのまま使える）。 */
export function bindEnvUniforms(target: Record<string, THREE.IUniform>, env: Env) {
  for (const [k, v] of Object.entries(env.uniforms)) target[k] = v as THREE.IUniform;
  return target;
}

/** 文字列置換のヘルパ。見つからなければ落とす（黙って壊れない）。 */
export function replaceOnce(src: string, needle: string, replacement: string, label = ""): string {
  if (!src.includes(needle)) throw new Error(`[patch] '${needle}' が見つからない ${label}`);
  return src.replace(needle, replacement);
}
