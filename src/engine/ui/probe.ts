// 照準（画面中央）の先に何があるかを、地形の数式 heightAt() に対してレイを行進させて求める。
// 描画には一切触らない。UI（裏返しの数式パネル）が読むだけの純粋なロジック。
//
//   地形: レイが h(x,z) の下に潜った所を二分法で詰める
//   湖  : 先に y = 湖面 の平面に当たり、そこの地面が湖面より低ければ「湖」
//   空  : どちらにも当たらなければ「空」
//
// 出す値は「いま本当に走っているコード」と同じ式で出す。地形は core/height.ts の heightPartsAt()、
// 空は sky/atmosphere.glsl.ts の媒質・位相関数、湖は water/wavesim.ts のスペクトルの係数。
import * as THREE from "three";
import type { Env } from "../core/env";
import { heightAt, heightPartsAt, normalAt, shoreRadius, WORLD } from "../core/heightfield";

/** heightAt() の3成分（core/height.ts が返すもの）。sum は heightAt(x, z) に一致する */
export type TerrainTerms = {
  /** 岸線からの符号付き距離（負が湖） */
  sd: number;
  rShore: number;
  /** 湖底＋岸の土手＋ゆるい上り＋侵食の丘＋沢筋 */
  base: number;
  /** 山脈（ridged fbm × 方角ごとの高さ × マスク） */
  mtn: number;
  /** 細かい起伏（3 オクターブ） */
  fine: number;
  sum: number;
};

/** 大気の媒質（sky/atmosphere.glsl.ts の flip_atmoMedium と同じ）。単位は 1/km */
export type AtmoTerms = {
  /** 散乱角 θ（視線と太陽のなす角、度） */
  thetaDeg: number;
  /** レイリー位相 P_R(θ) */
  phaseR: number;
  /** ミー位相 P_M(θ, g=0.76) */
  phaseM: number;
  /** 視線方向 5 km の透過率（RGB） */
  T: [number, number, number];
  /** 地表のレイリー散乱係数（RGB、1/km） */
  sigmaR: [number, number, number];
  /** 地表のミー散乱係数（1/km。靄込み） */
  sigmaM: number;
  /** 靄の密度（uSkyParams.z） */
  haze: number;
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
      atmo: AtmoTerms;
      fog: number;
      hour: number;
      flipped: boolean;
    };

/** heightAt() の 3 成分を取り出す。式を画面に出すためのもの（値は heightAt と必ず一致する） */
export function terrainTerms(x: number, z: number): TerrainTerms {
  const p = heightPartsAt(x, z);
  return { sd: p.shore, rShore: shoreRadius(x, z), base: p.base, mtn: p.mtn, fine: p.fine, sum: p.h };
}

// ---------------------------------------------------------------------------
// 大気（sky/atmosphere.glsl.ts の flip_atmoMedium / flip_phaseR / flip_phaseMie の CPU 版）
// ---------------------------------------------------------------------------
const RAYLEIGH: [number, number, number] = [5.802e-3, 13.558e-3, 33.1e-3];
const OZONE: [number, number, number] = [0.65e-3 * 0.75, 1.881e-3 * 0.75, 0.085e-3 * 0.75];
const MIE_G = 0.76;

/** 海抜 h(km) の消散係数（RGB、1/km）と散乱係数。groundAlt は world y=0 の海抜(km) */
function medium(h: number, haze: number, groundAlt: number): { ext: [number, number, number]; mieS: number } {
  const hr = Math.max(h, 0);
  const dR = Math.exp(-hr / 8);
  const dM = Math.exp(-hr / 2.5);
  const dH = haze * Math.exp(-Math.max(h - groundAlt, 0) / 1.0);
  const dO = Math.max(0, 1 - Math.abs(hr - 25) / 15);
  const mS = 3.2e-3 * dM + dH * 0.9;
  const mA = 0.35e-3 * dM + dH * 0.1;
  const ext: [number, number, number] = [
    RAYLEIGH[0] * dR + mS + mA + OZONE[0] * dO,
    RAYLEIGH[1] * dR + mS + mA + OZONE[1] * dO,
    RAYLEIGH[2] * dR + mS + mA + OZONE[2] * dO,
  ];
  return { ext, mieS: mS };
}

export function phaseRayleigh(c: number): number {
  return 0.0596831 * (1 + c * c);
}
/** Cornette–Shanks */
export function phaseMie(c: number, g = MIE_G): number {
  const g2 = g * g;
  return (0.119366 * (1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5));
}

/** 視線方向 distKm の透過率を、シェーダと同じ媒質で数値積分する */
function transmittance(camYkm: number, dirY: number, distKm: number, haze: number, groundAlt: number): [number, number, number] {
  const N = 16;
  const dt = distKm / N;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < N; i++) {
    const s = (i + 0.5) * dt;
    const { ext } = medium(camYkm + dirY * s, haze, groundAlt);
    a += ext[0] * dt;
    b += ext[1] * dt;
    c += ext[2] * dt;
  }
  return [Math.exp(-a), Math.exp(-b), Math.exp(-c)];
}

const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();

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
  const sp = env.uniforms.uSkyParams.value as THREE.Vector4;
  const haze = sp.z, groundAlt = sp.w;
  const c = Math.min(1, Math.max(-1, dir.dot(env.sunDir)));
  const camYkm = groundAlt + o.y / 1000;
  const g0 = medium(camYkm, haze, groundAlt);
  return {
    kind: "sky",
    elevDeg: elev,
    azDeg: az,
    sunElevDeg: sunElev,
    atmo: {
      thetaDeg: (Math.acos(c) * 180) / Math.PI,
      phaseR: phaseRayleigh(c),
      phaseM: phaseMie(c),
      T: transmittance(camYkm, dir.y, 5, haze, groundAlt),
      sigmaR: [RAYLEIGH[0] * Math.exp(-camYkm / 8), RAYLEIGH[1] * Math.exp(-camYkm / 8), RAYLEIGH[2] * Math.exp(-camYkm / 8)],
      sigmaM: g0.mieS,
      haze,
    },
    fog: env.weather.fog,
    hour: env.hour,
    flipped: flippedAt(far),
  };
}
