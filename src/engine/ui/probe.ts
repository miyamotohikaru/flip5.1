// 照準（画面中央）の先に何があるかを、地形の数式 heightAt() に対してレイを行進させて求める。
// 描画には一切触らない。UI（裏返しの数式パネル）が読むだけの純粋なロジック。
//
//   地形: レイが h(x,z) の下に潜った所を二分法で詰める
//   湖  : 先に y = 湖面 の平面に当たり、そこの地面が湖面より低ければ「湖」
//   空  : どちらにも当たらなければ「空」
import * as THREE from "three";
import type { Env } from "../core/env";
import { heightAt, normalAt, shoreRadius, WORLD } from "../core/heightfield";
import { fbm2, noise2, ridged2, smoothstep } from "../core/noise";

/** heightAt() を項ごとに分けたもの。sum は heightAt(x, z) と一致する（一致しなければ ok=false） */
export type TerrainTerms = {
  sd: number;
  rShore: number;
  depth: number;
  /** 0.8·s(−20,20,sd) */
  shoreStep: number;
  rise: number;
  /** hills·s(−40,60,sd) */
  hillsTerm: number;
  /** 2.2·fbm₃ */
  h3Term: number;
  mtn: number;
  /** ridged の生の値（0..1、1.55 乗の後） */
  m: number;
  mtnMask: number;
  sum: number;
  ok: boolean;
};

export type ProbeHit =
  | {
      kind: "terrain";
      x: number;
      y: number;
      z: number;
      dist: number;
      slopeDeg: number;
      terms: TerrainTerms;
      /** 裏返しの波がここまで来ているか（数式ビューになっているか） */
      flipped: boolean;
    }
  | {
      kind: "lake";
      x: number;
      y: number;
      z: number;
      dist: number;
      /** 水深（m）。湖面 − 地面 */
      depth: number;
      windSpeed: number;
      windDir: { x: number; y: number };
      time: number;
      flipped: boolean;
    }
  | {
      kind: "sky";
      elevDeg: number;
      azDeg: number;
      sunElevDeg: number;
      /** 視線方向 5 km の透過率（atmosphere.glsl.ts の flip_aerial と同じ式） */
      transmittance: number;
      sigma0: number;
      fog: number;
      hour: number;
      flipped: boolean;
    };

/** heightAt() と同じ計算を項に分けて返す。式を画面に出すためのもの。 */
export function terrainTerms(x: number, z: number): TerrainTerms {
  const d = Math.hypot(x, z);
  const rShore = shoreRadius(x, z);
  const sd = d - rShore;
  const depth = sd < 0 ? 34 * (1 - Math.exp(sd / 70)) : 0;
  const h2 = fbm2(x * 0.0031 + 3.1, z * 0.0031 - 1.7, 4);
  const h3 = fbm2(x * 0.021 - 8.2, z * 0.021 + 4.4, 3);
  const shoreMask = smoothstep(0, 900, sd);
  const hills = 26 * h2 * (0.12 + 0.88 * shoreMask);
  const wx = x + 380 * noise2(x * 0.00041 + 7.1, z * 0.00041 + 3.3);
  const wz = z + 380 * noise2(x * 0.00041 - 2.7, z * 0.00041 + 9.9);
  const m = Math.pow(ridged2(wx * 0.00072 + 0.5, wz * 0.00072 + 0.9, 5), 1.55);
  const mtnMask = Math.pow(smoothstep(420, 1500, sd), 1.4);
  const mtn = m * 660 * mtnMask;
  const rise = 0.032 * Math.max(sd, 0) * (1 - 0.5 * mtnMask);
  const shoreStep = 0.8 * smoothstep(-20, 20, sd);
  const hillsTerm = hills * smoothstep(-40, 60, sd);
  const h3Term = 2.2 * h3;
  const sum = -depth + shoreStep + rise + hillsTerm + h3Term + mtn;
  const ok = Math.abs(sum - heightAt(x, z)) < 1e-4;
  return { sd, rShore, depth, shoreStep, rise, hillsTerm, h3Term, mtn, m, mtnMask, sum, ok };
}

const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();

/** 視線方向 dist 先までの透過率（atmosphere.glsl.ts flip_aerial の解析積分と同じ） */
export function transmittanceAlong(camY: number, dirY: number, dist: number, fog: number): { T: number; sigma0: number } {
  const base = 0.00026 * (0.35 + 1.4 * fog);
  const falloff = 0.0035;
  const hc = camY, hp = camY + dirY * dist;
  const dh = hp - hc;
  const density = Math.abs(dh) < 0.5 ? base * Math.exp(-falloff * hc) : (base * (Math.exp(-falloff * hc) - Math.exp(-falloff * hp))) / (falloff * dh);
  return { T: Math.exp(-density * dist), sigma0: base };
}

/**
 * 照準の先を調べる。1 回あたり heightAt を最大 ~400 回呼ぶ（数百 µs）。毎フレームではなく間引いて呼ぶこと。
 */
export function probe(env: Env): ProbeHit {
  const cam = env.camera;
  const o = cam.position;
  const dir = _dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
  const flipOn = env.flip > 0.5 || env.flipTarget > 0.5;
  const flippedAt = (p: THREE.Vector3) => flipOn && p.distanceTo(env.flipCenter) < env.flipRadius;

  // 湖面の平面との交点（下向きに見ているときだけ）
  let tLake = Infinity;
  if (dir.y < -1e-4 && o.y > WORLD.lakeLevel) tLake = (WORLD.lakeLevel - o.y) / dir.y;

  const maxT = 7000;
  let t = 0.3;
  let prevT = 0;
  let hit = -1;
  for (let i = 0; i < 420 && t < maxT; i++) {
    if (t >= tLake) break;
    const px = o.x + dir.x * t, py = o.y + dir.y * t, pz = o.z + dir.z * t;
    const dh = py - heightAt(px, pz);
    if (dh < 0) {
      // prevT（上）と t（下）の間に地面がある。二分法で詰める
      let a = prevT, b = t;
      for (let k = 0; k < 10; k++) {
        const mid = 0.5 * (a + b);
        const my = o.y + dir.y * mid;
        if (my - heightAt(o.x + dir.x * mid, o.z + dir.z * mid) < 0) b = mid;
        else a = mid;
      }
      hit = 0.5 * (a + b);
      break;
    }
    prevT = t;
    // 地面から高いほど・遠いほど大股に。近い所は細かく
    t += Math.max(0.4, Math.min(dh * 0.7, 18 + t * 0.02));
  }

  if (hit < 0 && Number.isFinite(tLake) && tLake < maxT) {
    const p = _pos.set(o.x + dir.x * tLake, WORLD.lakeLevel, o.z + dir.z * tLake);
    // 水面のメッシュはカメラ周り ±1300m。そこの地面が湖面より低ければ水が見えている
    const inPlane = Math.abs(p.x - o.x) < 1300 && Math.abs(p.z - o.z) < 1300;
    const ground = heightAt(p.x, p.z);
    if (inPlane && ground < WORLD.lakeLevel) {
      const w = env.weather;
      return {
        kind: "lake",
        x: p.x,
        y: p.y,
        z: p.z,
        dist: tLake,
        depth: WORLD.lakeLevel - ground,
        windSpeed: w.wind,
        windDir: { x: w.windDir.x, y: w.windDir.y },
        time: env.time,
        flipped: flippedAt(p),
      };
    }
  }

  if (hit >= 0) {
    const p = _pos.set(o.x + dir.x * hit, 0, o.z + dir.z * hit);
    p.y = heightAt(p.x, p.z);
    const n = normalAt(p.x, p.z);
    return {
      kind: "terrain",
      x: p.x,
      y: p.y,
      z: p.z,
      dist: hit,
      slopeDeg: (Math.acos(Math.min(1, Math.max(-1, n.y))) * 180) / Math.PI,
      terms: terrainTerms(p.x, p.z),
      flipped: flippedAt(p),
    };
  }

  // 空。空シェーダは uCamPos + dir·5000 の位置で flip_mask を見る
  const far = _pos.copy(o).addScaledVector(dir, 5000);
  const elev = (Math.asin(Math.min(1, Math.max(-1, dir.y))) * 180) / Math.PI;
  // 方位: 北(−Z)=0°、東(+X)=90°
  const az = ((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360;
  const sunElev = (Math.asin(Math.min(1, Math.max(-1, env.sunDir.y))) * 180) / Math.PI;
  const { T, sigma0 } = transmittanceAlong(o.y, dir.y, 5000, env.weather.fog);
  return {
    kind: "sky",
    elevDeg: elev,
    azDeg: az,
    sunElevDeg: sunElev,
    transmittance: T,
    sigma0,
    fog: env.weather.fog,
    hour: env.hour,
    flipped: flippedAt(far),
  };
}
