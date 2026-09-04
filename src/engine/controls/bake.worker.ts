// ハイトマップを焼く Web Worker。heightAt() の呼び出し（2048² で 1 秒超）をメインスレッドから外す。
// 複数の Worker に行を分けて渡し、結果の Float32Array を transfer で受け取る（bake.ts）。
//   受信: { res, j0, j1, seed, tune }                    行 j0..j1（j1 は含まない）を焼く。
//         seed / tune はメインスレッドと同じ世界を焼くために毎回渡す（Worker は URL の ?seed= を見られない）
//   送信: { type: "progress", rows }                     焼けた行数（何度か）
//         { type: "done", data, parts, j0, j1, min, max } data は (j1−j0)×res の Float32Array、parts は ×4 の Uint16Array（transfer）
// three は import しない（Turbopack は client 向けに typeof window を定数化するので、Worker で three を読むと落ちる）。
import { bakeHeightRows, setTerrainTune, type TerrainTune } from "../core/height";
import { setSeed } from "../core/seed";

type Req = { res: number; j0: number; j1: number; seed: number; tune: TerrainTune };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { res, j0, j1, seed, tune } = e.data;
  setSeed(seed);
  setTerrainTune(tune);
  const rows = Math.max(0, j1 - j0);
  const data = new Float32Array(rows * res);
  const parts = new Uint16Array(rows * res * 4);
  let min = Infinity, max = -Infinity;
  const step = 32;
  for (let j = j0; j < j1; j += step) {
    const je = Math.min(j1, j + step);
    const r = bakeHeightRows(data, res, j, je, j0, parts);
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
    ctx.postMessage({ type: "progress", rows: je - j });
  }
  ctx.postMessage({ type: "done", data, parts, j0, j1, min, max }, [data.buffer, parts.buffer]);
};
