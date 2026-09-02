// ポスト処理の小道具。フルスクリーン用マテリアル、RT の生成、GPU タイマー、共有 GLSL。
import * as THREE from "three";
import { FS_VERT } from "../core/pipeline";

/** フルスクリーン三角形用の ShaderMaterial（深度なし・ブレンドなし） */
export function fsMaterial(
  name: string,
  uniforms: Record<string, THREE.IUniform>,
  fragmentShader: string,
  defines: Record<string, string | number> = {},
): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name,
    uniforms,
    defines,
    vertexShader: FS_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  m.toneMapped = false;
  return m;
}

export type RTOptions = {
  type?: THREE.TextureDataType;
  format?: THREE.PixelFormat;
  filter?: THREE.MagnificationTextureFilter;
  wrap?: THREE.Wrapping;
};

/** 中間バッファ。深度なし・ミップなし。 */
export function makeRT(width: number, height: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: o.type ?? THREE.HalfFloatType,
    format: o.format ?? THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: (o.filter ?? THREE.LinearFilter) as THREE.MinificationTextureFilter,
    magFilter: o.filter ?? THREE.LinearFilter,
    wrapS: o.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: o.wrap ?? THREE.ClampToEdgeWrapping,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

/** 全パス共通の GLSL 断片 */
export const POST_COMMON = /* glsl */ `
#ifndef POST_COMMON_INCLUDED
#define POST_COMMON_INCLUDED
float post_luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// 画面座標の決定的ノイズ（Interleaved Gradient Noise, Jimenez 2014）
float post_ign(vec2 p){ return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }
float post_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// 非線形深度 → 視線方向の距離（m）
float post_linearDepth(float z, float near, float far){
  float ndc = z * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - ndc * (far - near));
}
#endif
`;

/**
 * EXT_disjoint_timer_query_webgl2 があれば、パスごとの GPU 時間を計る。
 * なければ何もしない（ms は NaN のまま）。
 */
export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: { name: string; q: WebGLQuery }[] = [];
  private active: { name: string; q: WebGLQuery } | null = null;
  private pool: WebGLQuery[] = [];
  /** 直近に読めたパスごとの ms */
  ms: Record<string, number> = {};
  /** ポスト全体の ms（直近） */
  total = NaN;
  enabled: boolean;

  constructor(renderer: THREE.WebGLRenderer, enabled: boolean) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = enabled ? (this.gl.getExtension("EXT_disjoint_timer_query_webgl2") as typeof this.ext) : null;
    this.enabled = !!this.ext;
  }

  begin(name: string) {
    if (!this.ext || this.active) return;
    const q = this.pool.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { name, q };
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** フレームの最後に呼ぶ。終わったクエリを回収して ms を更新する。 */
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    const done: Record<string, number> = {};
    const rest: typeof this.pending = [];
    let any = false;
    for (const p of this.pending) {
      const available = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (available) {
        if (!disjoint) {
          const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
          done[p.name] = (done[p.name] ?? 0) + ns / 1e6;
          any = true;
        }
        this.pool.push(p.q);
      } else rest.push(p);
    }
    this.pending = rest;
    if (any) {
      this.ms = done;
      let t = 0;
      for (const v of Object.values(done)) t += v;
      this.total = t;
    }
    // 溜まりすぎたら捨てる（GPU が止まっているとき）
    if (this.pending.length > 64) {
      for (const p of this.pending) gl.deleteQuery(p.q);
      this.pending = [];
    }
  }
}
