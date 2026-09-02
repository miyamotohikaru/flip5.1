// 地形の「正体」= heightAt()。three に依存しない純粋な数式だけを置く。
// Web Worker（controls/bake.worker.ts）からも import するので、ここに DOM や three を持ち込まないこと。
// 外からは従来どおり core/heightfield から import できる（heightfield.ts が再輸出する）。
//
// 座標系: three.js 準拠（Y up、単位はメートル）。原点は湖の中心。
// プレイヤーは +Z 側（南岸）から -Z（北）を向いて始まり、湖の向こうに山脈を見る。
// 太陽は +X（東）から昇り、+Z（南・背中側）を通って -X（西）へ沈む。
import { fbm2, noise2, ridged2, smoothstep } from "./noise";

export const WORLD = {
  /** ハイトマップが覆う一辺（m）。これより外は霧の向こう。 */
  size: 4096,
  half: 2048,
  /** 湖面の高さ（m） */
  lakeLevel: 0,
  /** 湖のおおよその半径（m）。岸線は角度でうねる。 */
  lakeRadius: 330,
  /** 想定する最高標高（m）。テクスチャの正規化に使う */
  maxHeight: 800,
  /** プレイヤーが歩ける半径（m）。これより外は霧で見せない */
  walkRadius: 1500,
} as const;

/** 岸線の半径（角度でうねらせる）。 */
export function shoreRadius(x: number, z: number): number {
  const a = Math.atan2(z, x);
  const ca = Math.cos(a), sa = Math.sin(a);
  return (
    WORLD.lakeRadius +
    70 * noise2(ca * 1.7 + 5.2, sa * 1.7 + 5.2) +
    26 * noise2(ca * 4.1 + 1.3, sa * 4.1 + 9.1)
  );
}

/**
 * 地形の高さ（m）。決定的・連続・どこでも呼べる。
 * 湖 → 岸の草地 → 針葉樹の斜面 → 岩 → 雪の稜線、という一つの谷。
 */
export function heightAt(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const sd = d - shoreRadius(x, z); // 岸線からの符号付き距離（負が湖）

  // 湖底: 岸からなだらかに深くなる椀
  const depth = sd < 0 ? 34 * (1 - Math.exp(sd / 70)) : 0;

  // 中景の丘（岸辺では小さく、離れるほど大きく）
  const h2 = fbm2(x * 0.0031 + 3.1, z * 0.0031 - 1.7, 4);
  const h3 = fbm2(x * 0.021 - 8.2, z * 0.021 + 4.4, 3);
  const shoreMask = smoothstep(0, 900, sd);
  const hills = 26 * h2 * (0.12 + 0.88 * shoreMask);

  // 遠景の山脈: ドメインワープした尾根ノイズ
  const wx = x + 380 * noise2(x * 0.00041 + 7.1, z * 0.00041 + 3.3);
  const wz = z + 380 * noise2(x * 0.00041 - 2.7, z * 0.00041 + 9.9);
  let m = ridged2(wx * 0.00072 + 0.5, wz * 0.00072 + 0.9, 5);
  m = Math.pow(m, 1.55);
  const mtnMask = Math.pow(smoothstep(420, 1500, sd), 1.4);
  const mtn = m * 660 * mtnMask;

  // 岸からのゆるい上り
  const rise = 0.032 * Math.max(sd, 0) * (1 - 0.5 * mtnMask);

  return (
    -depth +
    0.8 * smoothstep(-20, 20, sd) +
    rise +
    hills * smoothstep(-40, 60, sd) +
    2.2 * h3 +
    mtn
  );
}

/**
 * heightAt() を行 j0..j1（j1 は含まない）だけ焼く。Worker で分担して焼くための部品。
 * data の行 (j − dataRow0) に書く（部分配列に焼くときは dataRow0 = j0）。戻り値はその範囲の最小・最大。
 */
export function bakeHeightRows(data: Float32Array, res: number, j0: number, j1: number, dataRow0 = 0): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let j = j0; j < j1; j++) {
    const z = (j / res - 0.5) * WORLD.size;
    const row = (j - dataRow0) * res;
    for (let i = 0; i < res; i++) {
      const x = (i / res - 0.5) * WORLD.size;
      const h = heightAt(x, z);
      data[row + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { min, max };
}

/** 開始地点: 南岸の草地。湖越しに北の山脈を見る。 */
export function startPosition(): { x: number; z: number; yaw: number } {
  // 岸線から +18m ほど陸側
  const a = Math.PI / 2; // +Z
  const r = shoreRadius(Math.cos(a) * 10, Math.sin(a) * 10) + 18;
  return { x: 0, z: r, yaw: 0 };
}
