// GPU 時間の計測（EXT_disjoint_timer_query_webgl2）。`?wtime=1` のときだけ動かす調査用。
// 同時に走らせられるのは 1 区間だけなので、区間は直列に並べる。
import type * as THREE from "three";

type Pending = { q: WebGLQuery; name: string };

export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private active: Pending | null = null;
  private pending: Pending[] = [];
  /** 区間ごとの平滑化した ms */
  results: Record<string, number> = {};
  enabled: boolean;

  constructor(renderer: THREE.WebGLRenderer, enabled: boolean) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.enabled = enabled;
    this.ext = enabled ? (this.gl.getExtension("EXT_disjoint_timer_query_webgl2") as typeof this.ext) : null;
    if (enabled && !this.ext) this.enabled = false;
  }

  begin(name: string) {
    if (!this.enabled || !this.ext || this.active) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, name };
  }

  end() {
    if (!this.active || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** 毎フレーム 1 回。終わった計測を回収する */
  poll() {
    if (!this.enabled || !this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      const ready = gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!ready) break;
      if (!disjoint) {
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
        const ms = ns / 1e6;
        const prev = this.results[p.name];
        this.results[p.name] = prev === undefined ? ms : prev * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(p.q);
      this.pending.shift();
    }
  }
}
