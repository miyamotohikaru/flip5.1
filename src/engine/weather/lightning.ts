// 稲光。決定的だが不規則な間隔（スロット × ハッシュ）で落ち、env.lightning.flash を 0→1→減衰（複数ストロークでちらつく）。
//   - 稲妻の形は CPU で生成（中点変位＋分岐）。カメラ向きのリボンで描く（芯＝白、周り＝青い光）。数フレームで上から伸びる
//   - 雲の中で光る面（上端の大きな柔らかい光）
//   - 地面・空の一瞬の明るさは fog.ts の暫定ライティング（uLightning を空・地形が読むようになったら不要）
//   - 音担当は env.lightning.strikeIndex の変化と position で雷鳴を鳴らす（距離で遅らせる）
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { hash2 } from "../core/noise";
import { heightAt } from "../core/heightfield";
import { WX_COMMON } from "./glsl";
import type { Weather } from "./index";

/** 落雷スロットの長さ（秒）。1スロットに最大1回 */
const SLOT = 3.4;
/** 稲妻の最大線分数 */
const MAX_SEG = 640;

type Strike = {
  slot: number;
  ts: number;
  strokes: { delay: number; amp: number; tau: number }[];
};

/** スロット k に落雷があるか・いつか（決定的） */
function strikeOf(k: number, storm: number): Strike | null {
  if (storm < 0.5) return null;
  const p = 0.8 * Math.min(1, (storm - 0.5) / 0.4 + 0.2);
  const forced = k === 0; // 開始直後（定点撮影の t=0 でも稲妻が見える）
  if (!forced && hash2(k, 11) > p) return null;
  // 定点撮影（freeze で t=0）でも「伸びきった稲妻＋強い閃光」が写るよう、最初の1回だけ 22ms 前に落とす
  const offset = forced ? -0.022 : hash2(k, 23) * SLOT * 0.85;
  const n = 1 + Math.floor(hash2(k, 31) * 3);
  const strokes: Strike["strokes"] = [];
  let d = 0;
  for (let j = 0; j < n; j++) {
    if (j > 0) d += 0.07 + 0.14 * hash2(k, 41 + j);
    strokes.push({ delay: d, amp: j === 0 ? 1 : 0.45 + 0.4 * hash2(k, 51 + j), tau: 0.045 + 0.05 * hash2(k, 61 + j) });
  }
  return { slot: k, ts: k * SLOT + offset, strokes };
}

function envelope(s: Strike, age: number): number {
  let f = 0;
  for (const st of s.strokes) {
    const x = age - st.delay;
    if (x < 0) continue;
    const attack = Math.min(1, x / 0.004);
    f += st.amp * attack * Math.exp(-x / st.tau);
  }
  return Math.min(1, f);
}

type Seg = { a: THREE.Vector3; b: THREE.Vector3; w: number; o0: number; o1: number };

/** 中点変位＋分岐で稲妻の線分を作る。order は上端 0 → 地面 1（伸びる演出用） */
function buildBolt(seed: number, top: THREE.Vector3, bottom: THREE.Vector3): Seg[] {
  let s = 0;
  const rnd = () => hash2(s++, seed * 7919 + 13);
  const segs: Seg[] = [];
  const channel = (from: THREE.Vector3, to: THREE.Vector3, levels: number, width: number, o0: number, o1: number, jitter: number, depth: number) => {
    let pts = [from.clone(), to.clone()];
    for (let l = 0; l < levels; l++) {
      const next: THREE.Vector3[] = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const len = a.distanceTo(b);
        const dir = b.clone().sub(a).normalize();
        const tmp = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const u = new THREE.Vector3().crossVectors(dir, tmp).normalize();
        const v = new THREE.Vector3().crossVectors(dir, u).normalize();
        const ang = rnd() * Math.PI * 2;
        const mag = (rnd() - 0.5) * 2 * len * jitter;
        mid.addScaledVector(u, Math.cos(ang) * mag).addScaledVector(v, Math.sin(ang) * mag);
        next.push(mid, b);
      }
      pts = next;
    }
    const n = pts.length - 1;
    for (let i = 0; i < n; i++) {
      segs.push({ a: pts[i], b: pts[i + 1], w: width, o0: o0 + ((o1 - o0) * i) / n, o1: o0 + ((o1 - o0) * (i + 1)) / n });
      // 分岐
      if (depth < 2 && i > 1 && i < n - 2 && rnd() < (depth === 0 ? 0.16 : 0.08)) {
        const p = pts[i + 1];
        const mainDir = bottom.clone().sub(p).normalize();
        const tmp = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.3, rnd() - 0.5).normalize();
        const bdir = mainDir.clone().multiplyScalar(0.55).addScaledVector(tmp, 0.75).normalize();
        const remain = p.distanceTo(bottom);
        const blen = Math.min(remain * (0.06 + 0.16 * rnd()), 140);
        const end = p.clone().addScaledVector(bdir, blen);
        const oo = o0 + ((o1 - o0) * (i + 1)) / n;
        channel(p, end, 3, width * (depth === 0 ? 0.45 : 0.3), oo, oo + 0.25, 0.22, depth + 1);
      }
    }
  };
  channel(top, bottom, 7, 1, 0, 1, 0.3, 0);
  return segs.slice(0, MAX_SEG);
}

const BOLT_VERT = /* glsl */ `
${WX_COMMON}
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aCorner;
attribute float aWidth;
attribute float aOrder;
uniform vec3 uCamPos;
uniform float uBoltAge;
varying float vX;
varying float vVis;
varying vec3 vWorld;
varying float vW;
void main(){
  vec3 p = mix(aA, aB, aCorner.y);
  vec3 seg = normalize(aB - aA);
  vec3 vdir = normalize(p - uCamPos);
  vec3 side = normalize(cross(seg, vdir));
  float dist = distance(p, uCamPos);
  float halfW = dist * uWxPixel * 9.0 * mix(0.5, 1.0, aWidth);
  p += side * aCorner.x * halfW;
  // 上から順に伸びる（先端 = リーダー）。20ms で地面に達する（閃光のピークには伸びきっている）
  float grow = 1.0 - smoothstep(uBoltAge / 0.02, uBoltAge / 0.02 + 0.04, aOrder);
  vX = aCorner.x;
  vVis = grow;
  vWorld = p;
  vW = aWidth;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const BOLT_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform float uBoltFlash;
varying float vX;
varying float vVis;
varying vec3 vWorld;
varying float vW;
void main(){
  float x = abs(vX);
  // 細い白熱の芯（〜1.5px）＋ 青白い広い光（〜9px）。枝は細く暗く。
  // 広い光を強くしすぎるとリボンの四角がそのまま白い塊として見える
  float core = exp(-x * x * 90.0);
  float glow = exp(-x * 5.0) * 0.010 + exp(-x * 1.8) * 0.0025;
  float i = (core * 4.0 + glow * 6.0) * mix(0.35, 1.0, vW) * uBoltFlash * vVis;
  vec3 col = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.98, 1.0), core) * i;
  vec4 aer = flip_aerial(vWorld);
  col *= aer.a;
  col *= exp(-wx_veilOD(distance(uCamPos, vWorld)) * 0.6);
  float fm = flip_mask(vWorld);
  col = mix(col, FLIP_ACCENT * (core * 3.0 + glow * 2.0) * vVis * uBoltFlash, fm);
  gl_FragColor = vec4(col, 0.0);
}
`;

const GLOW_VERT = /* glsl */ `
${WX_COMMON}
uniform vec3 uCamPos;
uniform vec3 uGlowPos;
uniform float uGlowSize;
varying vec2 vQ;
varying vec3 vWorld;
void main(){
  vec3 right = wx_camRight(viewMatrix);
  vec3 up = wx_camUp(viewMatrix);
  vec3 p = uGlowPos + (right * position.x + up * position.y) * uGlowSize;
  vQ = position.xy;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform float uBoltFlash;
uniform vec3 uSkyAmbient;
varying vec2 vQ;
varying vec3 vWorld;
void main(){
  float r = length(vQ) * 2.0;
  // 雲の中の発光は狭く（広いと空全体が白く飛んで雲の構造が消える）
  float g = exp(-r * r * 7.0) * (1.0 - smoothstep(0.6, 1.0, r));
  // 雲の中で光る: むらのある柔らかい面（2オクターブ。のっぺりした円盤にしない）
  float n = 0.5 + 0.75 * flip_vnoise(vec3(vQ * 5.0, uTime * 2.2)) * (0.65 + 0.5 * flip_vnoise(vec3(vQ * 13.0, uTime * 3.5)));
  vec3 dv = vWorld - uCamPos;
  float dc = length(dv);
  // 落雷までの距離で減衰し、その向きの空の 2 倍（= 合計3倍）を上限にする
  float att = 1.0 / (1.0 + dc * dc / (500.0 * 500.0));
  vec3 col = vec3(0.78, 0.84, 1.0) * g * n * uBoltFlash * 1.6 * att;
  // uSkyAmbient*0.64 = 雲を含む空の代表輝度。その2倍（= 合計3倍）で頭を打つ。
  // min で切ると上限に張り付いた平らな円盤（= 空に浮かぶ白い玉）になるので、柔らかく圧縮する
  vec3 cap = uSkyAmbient * 1.28 + 0.004;
  col = col / (1.0 + col / max(cap, 1e-4));
  col *= flip_aerial(vWorld).a;
  float fm = flip_mask(vWorld);
  col = mix(col, FLIP_ACCENT * g * 0.35 * uBoltFlash, fm);
  gl_FragColor = vec4(col, 0.0);
}
`;

export class LightningFx {
  bolt: THREE.Mesh;
  glow: THREE.Mesh;
  boltMat: THREE.ShaderMaterial;
  glowMat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private aA: THREE.BufferAttribute;
  private aB: THREE.BufferAttribute;
  private aWidth: THREE.BufferAttribute;
  private aOrder: THREE.BufferAttribute;
  private strikeSlot = -1;
  private segCount = 0;
  private top = new THREE.Vector3();

  constructor(public w: Weather) {
    this.geo = new THREE.BufferGeometry();
    const n = MAX_SEG;
    this.aA = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3);
    this.aB = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3);
    this.aWidth = new THREE.BufferAttribute(new Float32Array(n * 4), 1);
    this.aOrder = new THREE.BufferAttribute(new Float32Array(n * 4), 1);
    const corner = new Float32Array(n * 4 * 2);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      corner.set([-1, 0, 1, 0, 1, 1, -1, 1], i * 8);
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    this.aA.setUsage(THREE.DynamicDrawUsage);
    this.aB.setUsage(THREE.DynamicDrawUsage);
    this.aWidth.setUsage(THREE.DynamicDrawUsage);
    this.aOrder.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aA", this.aA);
    this.geo.setAttribute("aB", this.aB);
    this.geo.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
    this.geo.setAttribute("aWidth", this.aWidth);
    this.geo.setAttribute("aOrder", this.aOrder);
    // position は使わないが three が要求する
    this.geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.boltMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ uBoltAge: { value: 0 }, uBoltFlash: { value: 0 } }),
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    });
    this.bolt = new THREE.Mesh(this.geo, this.boltMat);
    this.bolt.frustumCulled = false;
    this.bolt.layers.set(LAYER.TRANSPARENT);
    this.bolt.renderOrder = 30;
    this.bolt.castShadow = false;
    this.bolt.visible = false;
    this.bolt.name = "weather.bolt";
    w.group.add(this.bolt);

    const gq = new THREE.BufferGeometry();
    gq.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    gq.setIndex([0, 1, 2, 0, 2, 3]);
    gq.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ uBoltFlash: { value: 0 }, uGlowPos: { value: new THREE.Vector3() }, uGlowSize: { value: 500 } }),
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    });
    this.glow = new THREE.Mesh(gq, this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.layers.set(LAYER.TRANSPARENT);
    this.glow.renderOrder = 29;
    this.glow.castShadow = false;
    this.glow.visible = false;
    this.glow.name = "weather.cloudglow";
    w.group.add(this.glow);
  }

  private newStrike(s: Strike) {
    const env = this.w.env;
    const cam = env.camera;
    // カメラの向きの前方 ±26° のどこか、450〜1350m 先
    const yaw = cam.rotation.y;
    const az = yaw + (hash2(s.slot, 61) - 0.5) * 0.9;
    const dist = 450 + 900 * hash2(s.slot, 71);
    const x = cam.position.x - Math.sin(az) * dist;
    const z = cam.position.z - Math.cos(az) * dist;
    const y = heightAt(x, z);
    const L = env.lightning;
    L.position.set(x, y, z);
    L.lastStrikeTime = s.ts;
    L.strikeIndex = s.slot;
    const cloud = L.cloudHeight || 700;
    this.top.set(x + (hash2(s.slot, 81) - 0.5) * 120, cloud + hash2(s.slot, 91) * 120, z + (hash2(s.slot, 101) - 0.5) * 120);
    const segs = buildBolt(s.slot + 1, this.top, L.position);
    const aA = this.aA.array as Float32Array;
    const aB = this.aB.array as Float32Array;
    const aW = this.aWidth.array as Float32Array;
    const aO = this.aOrder.array as Float32Array;
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        aA[v * 3] = sg.a.x; aA[v * 3 + 1] = sg.a.y; aA[v * 3 + 2] = sg.a.z;
        aB[v * 3] = sg.b.x; aB[v * 3 + 1] = sg.b.y; aB[v * 3 + 2] = sg.b.z;
        aW[v] = sg.w;
        aO[v] = c >= 2 ? sg.o1 : sg.o0;
      }
    }
    this.segCount = segs.length;
    this.aA.needsUpdate = true;
    this.aB.needsUpdate = true;
    this.aWidth.needsUpdate = true;
    this.aOrder.needsUpdate = true;
    this.geo.setDrawRange(0, this.segCount * 6);
    (this.glowMat.uniforms.uGlowPos.value as THREE.Vector3).copy(this.top).addScaledVector(new THREE.Vector3(0, 1, 0), 60);
    this.glowMat.uniforms.uGlowSize.value = 420 + 200 * hash2(s.slot, 111);
    this.strikeSlot = s.slot;
  }

  update(_dt: number) {
    const env = this.w.env;
    const t = env.time;
    const storm = env.weather.storm;
    const kNow = Math.floor(t / SLOT);
    let flash = 0;
    let active: Strike | null = null;
    for (const k of [kNow - 1, kNow]) {
      if (k < 0) continue;
      const s = strikeOf(k, storm);
      if (!s) continue;
      const age = t - s.ts;
      if (age < 0) continue;
      flash += envelope(s, age);
      if (age < 0.8 && (!active || s.ts > active.ts)) active = s;
    }
    flash = Math.min(1, flash);
    env.lightning.flash = flash;
    env.uniforms.uLightning.value = flash;
    if (active && active.slot !== this.strikeSlot) this.newStrike(active);
    env.uniforms.uLightningPos.value.copy(env.lightning.position);

    const show = !!active && flash > 0.01;
    this.bolt.visible = show;
    this.glow.visible = show;
    if (active) {
      const age = t - active.ts;
      this.boltMat.uniforms.uBoltAge.value = age;
      this.boltMat.uniforms.uBoltFlash.value = flash;
      this.glowMat.uniforms.uBoltFlash.value = flash;
    }
  }
}
