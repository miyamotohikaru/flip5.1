// ハイトマップを焼く Web Worker。heightAt() の呼び出し（2048² で 1 秒超）をメインスレッドから外す。
// 複数の Worker に行を分けて渡し、結果の Float32Array を transfer で受け取る（bake.ts）。
//   受信: { res, j0, j1 }                                行 j0..j1（j1 は含まない）を焼く
//   送信: { type: "progress", rows }                     焼けた行数（何度か）
//         { type: "done", data, j0, j1, min, max }       data は (j1−j0)×res の Float32Array（transfer）
// three は import しない（Turbopack は client 向けに typeof window を定数化するので、Worker で three を読むと落ちる）。
import { bakeHeightRows } from "../core/height";

type Req = { res: number; j0: number; j1: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { res, j0, j1 } = e.data;
  const data = new Float32Array(Math.max(0, j1 - j0) * res);
  let min = Infinity, max = -Infinity;
  const step = 32;
  for (let j = j0; j < j1; j += step) {
    const je = Math.min(j1, j + step);
    const r = bakeHeightRows(data, res, j, je, j0);
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
    ctx.postMessage({ type: "progress", rows: je - j });
  }
  ctx.postMessage({ type: "done", data, j0, j1, min, max }, [data.buffer]);
};
