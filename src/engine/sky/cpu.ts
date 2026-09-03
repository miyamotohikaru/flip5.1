// CPU 側の大気（GLSL の flip_atmoMedium と同じ式）。太陽・月の地上での色と強さ、月の軌道、露出。
import * as THREE from "three";
import { Env } from "../core/env";

export const ATMO = {
  RG: 6360,
  RT: 6460,
  /** 大気の外での太陽の放射照度（シーン単位。地上の白い面が 1.5 前後の放射輝度になる） */
  sunE0: 6.0,
  /** 月の放射照度（太陽比。現実の 1/40 万は暗すぎるので AAA と同じく嘘をつく） */
  moonRatio: 1 / 190,
  moonTint: new THREE.Color(0.74, 0.83, 1.0),
} as const;

const tmpE = [0, 0, 0];
function extinction(h: number, haze: number, groundAlt: number) {
  const hr = Math.max(h, 0);
  const dR = Math.exp(-hr / 8), dM = Math.exp(-hr / 2.5);
  const dH = haze * Math.exp(-Math.max(h - groundAlt, 0) / 1.0);
  const dO = Math.max(0, 1 - Math.abs(hr - 25) / 15);
  // ミー（散乱＋吸収）。atmosphere.glsl.ts の flip_atmoMedium と同じ値にすること
  // 散乱は Angstrom 0.8（0.86/1.0/1.16）、吸収は AAE 4（0.43/1.0/2.44）
  const mS = 1.0e-2 * dM + dH * 0.70;
  const mA = 4.0e-3 * dM + dH * 0.75;
  tmpE[0] = 5.802e-3 * dR + mS * 0.86 + mA * 0.43 + 0.65e-3 * dO;
  tmpE[1] = 13.558e-3 * dR + mS * 1.0 + mA * 1.0 + 1.881e-3 * dO;
  tmpE[2] = 33.1e-3 * dR + mS * 1.16 + mA * 2.44 + 0.085e-3 * dO;
  return tmpE;
}

/** 惑星中心から r km の点で、天頂角 cos = mu の向きに大気の外まで抜ける透過率（地面を通る経路は海面密度で減衰） */
export function transmittance(r: number, mu: number, haze: number, groundAlt: number, out: THREE.Color): THREE.Color {
  const b = r * mu;
  const c = r * r - ATMO.RT * ATMO.RT;
  const disc = b * b - c;
  if (disc < 0) return out.setRGB(0, 0, 0);
  const tMax = -b + Math.sqrt(disc);
  if (tMax <= 0) return out.setRGB(1, 1, 1);
  const N = 48;
  const dt = tMax / N;
  const sx = Math.sqrt(Math.max(0, 1 - mu * mu));
  let o0 = 0, o1 = 0, o2 = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt;
    const px = sx * t, py = r + mu * t;
    const h = Math.hypot(px, py) - ATMO.RG;
    const e = extinction(h, haze, groundAlt);
    o0 += e[0] * dt; o1 += e[1] * dt; o2 += e[2] * dt;
  }
  return out.setRGB(Math.exp(-o0), Math.exp(-o1), Math.exp(-o2));
}

/** 月の向き。太陽の反対側（満月）を、見えやすいように北へ 75° 倒した軌道 */
export function moonDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
  Env.sunDirection((hour + 12) % 24, out);
  const a = (75 * Math.PI) / 180;
  const y = out.y * Math.cos(a) + out.z * Math.sin(a);
  const z = -out.y * Math.sin(a) + out.z * Math.cos(a);
  out.y = y;
  out.z = z;
  return out.normalize();
}

export const luminance = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
