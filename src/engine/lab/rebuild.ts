// 実験室のつまみ・シードを世界に効かせる係。
//
// 大事な約束（訪れる人の端末を重くしない）:
//   - **閉じているときは何もしない。** setInterval も rAF も持たない。呼ばれたときだけ動く
//   - uniform だけで効くもの（空・水・音・草）は即時。焼き直しは要らない
//   - 地形の焼き直しは Worker（controls/bake.ts）。**ドラッグ中は 256² だけ**、
//     1 回終わるまで次を投げない（最新の値だけ覚えて、終わったら投げ直す＝coalesce）
//   - 指を離してから本焼き（q.heightmapRes）。焼いている間も世界は止めない（前のハイトマップで描き続ける）
import * as THREE from "three";
import type { World } from "../world";
import { bakeHeightmapAsync } from "../controls/bake";
import { setTerrainTune } from "../core/height";
import { WORLD, startPosition, type Heightmap } from "../core/heightfield";
import { getSeed, setSeed } from "../core/seed";
import { Vegetation } from "../vegetation";
import { LAB, type LabKey, type LabValues } from "./store";
import { encodeLabParams, resetLabParams, LAB_BY_ID, type LabParam } from "./params";

/** ドラッグ中の粗焼き（4096m を 16m 刻み）。100ms 以内に焼ける */
const COARSE_RES = 256;

export type LabStatus = {
  /** 焼き直し中 */
  busy: boolean;
  /** 「地形を焼き直しています 42%」 */
  step: string;
  /** 0..1 */
  p: number;
};

type BakeKind = "coarse" | "full";

export class Lab {
  /** 焼き直しの進み具合（UI が読む）。閉じているときは呼ばれない */
  onStatus: ((s: LabStatus) => void) | null = null;
  /** 直近の焼き直しにかかった時間（ms）。報告・?stats=1 用 */
  timing = { coarse: 0, full: 0, veg: 0 };

  private pending: BakeKind | null = null;
  private running = false;
  /** 粗焼きで下げた解像度のままなら true（指を離したら本焼きに戻す） */
  private coarse = false;

  constructor(public world: World) {}

  // -------------------------------------------------------------- 即時に効くもの
  /** uniform だけで効くつまみを世界へ。毎フレームではなく、変わったときだけ呼ぶ */
  applyUniforms() {
    const u = this.world.env.uniforms;
    (u.uLabSky.value as THREE.Vector4).set(LAB.skyMie, LAB.skyRayleigh, LAB.skyOzone, 1);
    (u.uLabVeg.value as THREE.Vector4).set(LAB.vegGrass, 1, 1, 1);
  }

  /** スライダーが動いた。dragging = 指を置いたまま（＝粗焼きでよい） */
  changed(p: LabParam, dragging: boolean) {
    this.applyUniforms();
    if (p.rebake === "terrain") {
      setTerrainTune({ amp: LAB.terrainAmp, ridge: LAB.terrainRidge, erode: LAB.terrainErode });
      this.requestBake(dragging ? "coarse" : "full");
    } else if (p.rebake === "trees" && !dragging) {
      this.rebuildVegetation();
    }
    this.syncUrl();
  }

  /** つまみに値を入れて反映する（UI からも、調査用の JS `window.__flip.lab.set(...)` からも） */
  set(id: LabKey, v: number, dragging = false) {
    const p = LAB_BY_ID.get(id);
    if (!p) return;
    LAB[id] = Math.min(p.max, Math.max(p.min, v));
    this.changed(p, dragging);
  }

  /** いまのつまみ（読み取り用の写し） */
  values(): LabValues {
    return { ...LAB };
  }

  /** 「戻す」。既定値に戻して、必要なら焼き直す */
  reset() {
    const wasTerrain = LAB.terrainAmp !== 1 || LAB.terrainRidge !== 1 || LAB.terrainErode !== 1;
    const wasTrees = LAB.vegTree !== 1;
    resetLabParams();
    this.applyUniforms();
    if (wasTerrain) {
      setTerrainTune({ amp: 1, ridge: 1, erode: 1 });
      this.requestBake("full");
    } else if (wasTrees) {
      this.rebuildVegetation();
    }
    this.syncUrl();
  }

  // -------------------------------------------------------------- シード
  /** シードを変える。置換表 → ハイトマップ → 空・水 → 植生 → 立ち位置、の順で作り直す */
  async reseed(n: number) {
    setSeed(n);
    const w = this.world;
    w.sky.reseed();
    w.water.sim.reseed();
    this.syncUrl();
    await this.requestBake("full", true);
  }

  /** URL に今のシードとつまみを書く（共有できるように。履歴は増やさない） */
  syncUrl() {
    if (typeof location === "undefined" || typeof history === "undefined") return;
    try {
      const q = new URLSearchParams(location.search);
      const seed = getSeed();
      if (seed === 20271337) q.delete("seed");
      else q.set("seed", String(seed));
      const p = encodeLabParams();
      if (p) q.set("p", p);
      else q.delete("p");
      const s = q.toString();
      history.replaceState(null, "", s ? `${location.pathname}?${s}` : location.pathname);
    } catch {
      /* URL が書けなくても世界は動く */
    }
  }

  // -------------------------------------------------------------- 焼き直し
  /** 焼き直しを頼む。走っている間は「最新の 1 件」だけ覚えて、終わってから投げ直す */
  requestBake(kind: BakeKind, alsoMove = false): Promise<void> {
    // 本焼きは 250ms 待ってからまとめて 1 回（矢印キーの連打・離した直後の重なりを畳む）
    if (kind === "full" && !this.running) {
      if (alsoMove) this.moveWanted = true;
      window.clearTimeout(this.fullTimer);
      return new Promise<void>((resolve) => {
        this.fullTimer = window.setTimeout(() => {
          void this.runBake("full").then(resolve);
        }, 250);
      });
    }
    if (this.running) {
      // 本焼きの予約は粗焼きに負けない
      this.pending = this.pending === "full" || kind === "full" ? "full" : "coarse";
      if (alsoMove) this.moveWanted = true;
      return Promise.resolve();
    }
    if (alsoMove) this.moveWanted = true;
    return this.runBake(kind);
  }

  private moveWanted = false;
  private fullTimer = 0;

  private async runBake(kind: BakeKind): Promise<void> {
    this.running = true;
    const w = this.world;
    const res = kind === "coarse" ? COARSE_RES : w.q.heightmapRes;
    const t0 = performance.now();
    this.status(true, kind === "coarse" ? "地形を焼き直しています" : "地形の数式を計算しています", 0);
    try {
      const baked = await bakeHeightmapAsync(res, (p) => {
        if (kind === "full") this.status(true, `地形の数式を計算しています ${Math.round(p * 100)}%`, p * 0.8);
      });
      this.swapHeightmap(baked.heightmap);
      if (kind === "coarse") {
        this.coarse = true;
        this.timing.coarse = performance.now() - t0;
      } else {
        this.coarse = false;
        this.timing.full = performance.now() - t0;
        this.status(true, "山の陰と木を並べ直しています", 0.85);
        // 「並べ直しています」を出してから重い作り直しへ（画面が固まったように見えないように）
        await nextFrame();
        await nextFrame();
        this.rebakeTerrainAux();
        this.rebuildVegetation();
        if (this.moveWanted) {
          this.moveWanted = false;
          const s = startPosition();
          w.controls.setPose(s.x, s.z, undefined, s.yaw, 3);
          w.env.flipCenter.copy(w.controls.position);
        }
      }
    } catch (e) {
      console.warn("[lab] 焼き直しに失敗しました:", e);
    }
    this.running = false;
    this.status(false, "", 1);
    const next = this.pending;
    this.pending = null;
    if (next) await this.runBake(next);
  }

  /** ハイトマップを差し替える（テクスチャは共有 uniform なので、これだけで全モジュールに届く） */
  private swapHeightmap(hm: Heightmap) {
    const env = this.world.env;
    const old = env.heightmap;
    env.heightmap = hm;
    env.uniforms.uHeightmap.value = hm.texture;
    env.uniforms.uHeightParts.value = hm.parts;
    env.uniforms.uHeightmapInfo.value.set(WORLD.size, 1 / WORLD.size, hm.res, WORLD.maxHeight);
    if (old && old !== hm) {
      old.texture.dispose();
      old.parts.dispose();
    }
  }

  /** 地形の補助テクスチャ（法線・AO・地平角）を焼き直す。古いものは 2 フレーム後に捨てる */
  private rebakeTerrainAux() {
    const t = this.world.terrain;
    const old = t.bake;
    t.bake = null; // Terrain.ensureBaked() が次の描画で焼き直す
    if (!old) return;
    void nextFrame().then(nextFrame).then(() => {
      old.aux.dispose();
      old.horizonA.dispose();
      old.horizonB.dispose();
      old.field.dispose();
    });
  }

  /** 木・岩・草を並べ直す（地形が変わった／木の密度が変わった） */
  rebuildVegetation() {
    const w = this.world;
    const t0 = performance.now();
    const old = w.vegetation;
    w.scene.remove(old.group);
    w.vegetation = new Vegetation(w.scene, w.env, w.lighting, w.q);
    disposeVegetation(old);
    this.timing.veg = performance.now() - t0;
  }

  private status(busy: boolean, step: string, p: number) {
    this.onStatus?.({ busy, step, p });
  }

  /** 粗焼きのままか（UI が「本焼き待ち」を出すのに使う） */
  get isCoarse() {
    return this.coarse;
  }
  get isBusy() {
    return this.running;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** 古い植生の GPU 資源を捨てる（テクスチャが積み上がらないように） */
function disposeVegetation(v: Vegetation) {
  const seenMat = new Set<THREE.Material>();
  const seenGeo = new Set<THREE.BufferGeometry>();
  const killMat = (m: THREE.Material | THREE.Material[] | undefined) => {
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) {
      if (seenMat.has(mm)) continue;
      seenMat.add(mm);
      mm.dispose();
    }
  };
  v.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !seenGeo.has(m.geometry)) {
      seenGeo.add(m.geometry);
      m.geometry.dispose();
    }
    killMat(m.material);
    killMat(m.customDepthMaterial as THREE.Material | undefined);
    killMat(m.customDistanceMaterial as THREE.Material | undefined);
  });
  v.vegmap.texture.dispose();
  v.vegmap.shore.dispose();
  const trees = v.trees;
  if (trees) {
    trees.needle.dispose();
    trees.atlas.albedo.dispose();
    trees.atlas.normal.dispose();
    trees.atlas.skeleton.dispose();
  }
}
