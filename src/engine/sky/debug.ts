// 大気の項を 1 つずつ切る／掃くための調査用スイッチ（URL の ?dbg=…）。
//
// 批評ラウンド7 の「`dawn` の朝焼けが 43% 抜けた」を切り分けるために足した。
// **全部コンパイル時の `#define` なので、既定（?dbg= 無し）ではシェーダは 1 文字も変わらない。**
// CPU 側（cpu.ts の太陽の色・露出）と GPU 側（LUT・空・空気遠近）の両方に同じ値が効く。
//
//   ?dbg=skydry        … 吸湿成長を切る（湿った側の吸収を乾いた側と同じ＝ R6 のエアロゾルにする）
//   ?dbg=skyo3         … オゾンを Hillaire の基準値（×1.0）に戻す
//   ?dbg=skynofloor    … 空気遠近の透過率の下限 0.02 を外す
//   ?dbg=skyr6         … 上の 3 つを全部（= 批評R6 のときの大気）
//   ?dbg=skyr7         … 批評R7 のときの大気（湿度を hazeKm で読み、湿ると吸収が消える）＝退行の前後比較用
//   ?dbg=skyabs:0.95   … 乾いたエアロゾルの吸収係数を掃く（既定 ATMO_TUNE.absKDry）
//   ?dbg=skyabsw:0.22  … 湿ったエアロゾルの吸収係数を掃く（既定 ATMO_TUNE.absKWet。0.22 が R7）
//   ?dbg=skyo3k:1.0    … オゾンの倍率を掃く（既定 ATMO_TUNE.o3K）
//   ?dbg=skygrow:0.4   … 吸湿成長で増える灰色の散乱を掃く（既定 ATMO_TUNE.mieGrow）
//   ?dbg=skyms:1.0     … 多重散乱 LUT の強さ（既定 ATMO_TUNE.msK。Hillaire の Psi の倍率）
//   ?dbg=nosun         … 太陽・月の直射をゼロにする（地面を空の光だけで照らす）
//   ?dbg=noamb         … 半球光と環境マップをゼロにする（地面を直射だけで照らす）
// nosun / noamb は「地面の明るさのうち何 % が空から来ているか」を測るための対。
//
// 使い方: node tools/shoot.mjs x --url "/?shot=dawn&dbg=skydry"

/**
 * 本番の値。**GLSL の `#ifndef` の既定値（atmosphere.glsl.ts）と必ず同じにすること。**
 * 意味は atmosphere.glsl.ts の flip_atmoMedium() のコメントを見る。
 */
export const ATMO_TUNE = {
  /** 乾いたエアロゾルの吸収係数（吸収 Angstrom 指数 4 の量）。青を食って直射光を赤くする＝薄明の橙の源 */
  absKDry: 0.75,
  /**
   * 湿った（水の殻が付いた）エアロゾルの吸収係数。**乾いた側より大きい**（coating enhancement）。
   * 0.75 → 1.30 ＝ Eabs 1.7。R5 はここを 0.22（＝湿ると吸収が消える）にしていて、
   * `dawn`（mist）の朝焼けが 43% 抜けた（批評R7 の退行）
   */
  absKWet: 1.3,
  /** 吸湿成長で増える「水の殻」の散乱（灰色）。乾いた粒子の散乱 0.70 に対する量 */
  mieGrow: 0.0,
  /**
   * 多重散乱 LUT（Hillaire の Psi）の倍率。Psi は 2 次以降を「等方位相・無吸収」で積むので、
   * エアロゾルが多い大気では過大になる。1.0 だと地平線が灰色に濁って黄昏の橙が消える
   */
  msK: 0.5,
  /** オゾン（Chappuis 帯）の量。Hillaire の基準値に対する倍率 */
  o3K: 0.78,
  /** 空気遠近の透過率の下限（3km の山が空と同じ値の幽霊にならないように） */
  aerialFloor: 0.02,
};

function urlDbg(): Set<string> {
  if (typeof location === "undefined") return new Set();
  const q = new URLSearchParams(location.search).get("dbg") ?? "";
  return new Set(q.split(",").filter(Boolean));
}

const dbg = urlDbg();
const all = dbg.has("skyr6");
const r7 = dbg.has("skyr7");
/** `?dbg=skyabs:0.95` のような「名前:数」を読む。無ければ既定値 */
function num(key: string, def: number): number {
  for (const t of dbg) {
    if (t.startsWith(key + ":")) {
      const v = Number(t.slice(key.length + 1));
      if (Number.isFinite(v)) return v;
    }
  }
  return def;
}

const absKDry = num("skyabs", ATMO_TUNE.absKDry);

/** CPU 側（cpu.ts）が読む値。既定は ATMO_TUNE と同じ */
export const SKY_DBG = {
  absKDry,
  absKWet: num("skyabsw", all || dbg.has("skydry") ? absKDry : r7 ? 0.22 : ATMO_TUNE.absKWet),
  /** 1 = R7 の式（湿度を hazeKm で読む）。0 = いま（uFog で読む） */
  wetR7: r7 ? 1 : 0,
  mieGrow: num("skygrow", all || dbg.has("skydry") ? 0.0 : ATMO_TUNE.mieGrow),
  msK: num("skyms", ATMO_TUNE.msK),
  o3K: num("skyo3k", all || dbg.has("skyo3") ? 1.0 : ATMO_TUNE.o3K),
  aerialFloor: all || dbg.has("skynofloor") ? 0.0 : ATMO_TUNE.aerialFloor,
};

/** 光を片方だけにする（切り分け用。描画の式は変えず、光源の強さだけをゼロにする） */
export const SKY_LIGHT_DBG = { noSun: dbg.has("nosun"), noAmb: dbg.has("noamb") };

/** 既定から動いている項があるか（無ければ #define を 1 行も足さない） */
const CHANGED =
  (Object.keys(ATMO_TUNE) as (keyof typeof ATMO_TUNE)[]).some((k) => SKY_DBG[k] !== ATMO_TUNE[k]) || SKY_DBG.wetR7 !== 0;

/**
 * GLSL の先頭に足す `#define`。既定では**空文字**（＝シェーダは 1 文字も変わらない）。
 * `#ifndef` で包むので、チャンクが 2 回展開されても再定義の警告が出ない。
 */
export const SKY_DBG_PREFIX = !CHANGED
  ? ""
  : ([
        ["FLIP_ABSK_DRY", SKY_DBG.absKDry],
        ["FLIP_ABSK_WET", SKY_DBG.absKWet],
        ["FLIP_MIE_GROW", SKY_DBG.mieGrow],
        ["FLIP_WET_R7", SKY_DBG.wetR7],
        ["FLIP_MS", SKY_DBG.msK],
        ["FLIP_O3_K", SKY_DBG.o3K],
        ["FLIP_AERIAL_FLOOR", SKY_DBG.aerialFloor],
      ] as [string, number][])
        .map(([k, v]) => `#ifndef ${k}\n#define ${k} ${v.toFixed(4)}\n#endif\n`)
        .join("");
