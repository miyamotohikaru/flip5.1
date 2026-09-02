// ハイトマップを Web Worker で焼く（起動時間）。
// bakeHeightmap(2048) はメインスレッドを 1 秒以上止めるので、行を hardwareConcurrency に応じて
// 1〜4 個の Worker に分け、Float32Array を transfer で受け取って DataTexture に組み立てる。
// Worker が作れない／失敗した／時間切れのときはメインスレッドで焼く（結果は同じ）。
import { bakeHeightmap, heightmapFromData, type Heightmap } from "../core/heightfield";

export type BakeMode = "worker" | "sync";
export type BakeResult = { heightmap: Heightmap; ms: number; mode: BakeMode; workers: number };

type WorkerMsg =
  | { type: "progress"; rows: number }
  | { type: "done"; data: Float32Array; parts: Uint16Array; j0: number; j1: number; min: number; max: number };

/** 全体の時間切れ（低速端末の 2048² でも数秒） */
const TIMEOUT_MS = 30000;
/** 最初の便り（progress）が来るまでの時間切れ。Worker の読み込みに失敗すると onerror が来ないことがあるため */
const FIRST_MSG_MS = 6000;

export function bakeWorkerCount(): number {
  if (typeof Worker === "undefined") return 0;
  const hc = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, hc - 1));
}

/** 進み具合 p は 0..1（焼けた行数の割合） */
export async function bakeHeightmapAsync(res: number, onProgress?: (p: number) => void): Promise<BakeResult> {
  const t0 = performance.now();
  const n = bakeWorkerCount();
  if (n > 0) {
    try {
      const heightmap = await bakeInWorkers(res, n, onProgress);
      return { heightmap, ms: performance.now() - t0, mode: "worker", workers: n };
    } catch (err) {
      console.warn("[bake] Worker で焼けなかったのでメインスレッドで焼きます:", err);
    }
  }
  // 「計算中」の表示を一度描かせてから止める
  await new Promise((r) => setTimeout(r, 30));
  const heightmap = bakeHeightmap(res, onProgress);
  return { heightmap, ms: performance.now() - t0, mode: "sync", workers: 0 };
}

function bakeInWorkers(res: number, n: number, onProgress?: (p: number) => void): Promise<Heightmap> {
  return new Promise<Heightmap>((resolve, reject) => {
    const data = new Float32Array(res * res);
    const parts = new Uint16Array(res * res * 4);
    const rowsPer = Math.ceil(res / n);
    const workers: Worker[] = [];
    let finished = false;
    let doneCount = 0, doneRows = 0;
    let min = Infinity, max = -Infinity;
    let gotAny = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(firstTimer);
      for (const w of workers) w.terminate();
    };
    const fail = (err: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => fail(new Error(`bake worker timeout (${TIMEOUT_MS}ms)`)), TIMEOUT_MS);
    const firstTimer = setTimeout(() => {
      if (!gotAny) fail(new Error(`bake worker did not respond (${FIRST_MSG_MS}ms)`));
    }, FIRST_MSG_MS);

    for (let k = 0; k < n; k++) {
      const j0 = k * rowsPer, j1 = Math.min(res, j0 + rowsPer);
      if (j0 >= j1) continue;
      let w: Worker;
      try {
        // Turbopack / webpack はこの形（静的な URL）を見て Worker のバンドルを作る
        w = new Worker(new URL("./bake.worker.ts", import.meta.url));
      } catch (e) {
        fail(e);
        return;
      }
      workers.push(w);
      w.onerror = (e) => fail(e.error ?? new Error(e.message || "bake worker error"));
      w.onmessageerror = () => fail(new Error("bake worker message error"));
      w.onmessage = (e: MessageEvent<WorkerMsg>) => {
        const m = e.data;
        if (!m || finished) return;
        gotAny = true;
        if (m.type === "progress") {
          doneRows += m.rows;
          onProgress?.(Math.min(1, doneRows / res));
        } else if (m.type === "done") {
          data.set(m.data, m.j0 * res);
          parts.set(m.parts, m.j0 * res * 4);
          if (m.min < min) min = m.min;
          if (m.max > max) max = m.max;
          doneCount++;
          if (doneCount === workers.length) {
            finished = true;
            cleanup();
            resolve(heightmapFromData(data, res, min, max, parts));
          }
        }
      };
      w.postMessage({ res, j0, j1 });
    }
    if (workers.length === 0) fail(new Error("no bake workers"));
  });
}
