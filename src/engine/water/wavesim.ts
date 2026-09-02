// 波のシミュレーション（Tessendorf の FFT 海洋を湖の寸法に合わせたもの）。全部 GPU、毎フレーム:
//   1. スペクトル h(k,t)  … 風速・風向からスペクトルを作る。乱数はハッシュ（決定的。同じ時刻・同じ風なら同じ波）
//   2. 逆 FFT             … Stockham 自動整列。基数 16（256=16×16）／基数 16→8（128=16×8）。横 2 パス＋縦 2 パス
//   3. 傾き・分散・泡      … 変位テクスチャの有限差分。ミップ付きで持つので、遠景では法線が自然にならされ、
//                          「ならされて消えた傾きの分散」がそのまま粗さ（GGX の α²）になる（LEAN mapping の考え方）
// 2 つのカスケード（大きい波 / さざ波）を 1 枚のアトラス（横に並べる）で一度に処理する。
import * as THREE from "three";
import { FS_VERT, type Pipeline } from "../core/pipeline";

export type CascadeDef = {
  /** タイルの一辺（m） */
  size: number;
  /** このカスケードが受け持つ波数の下限・上限（rad/m）。0 / 1e9 で開放 */
  kLo: number;
  kHi: number;
};

const SPECTRUM_FRAG = /* glsl */ `
#include <flip_noise>
uniform float uN;
uniform float uTilesN;
uniform vec4 uL;       // 各タイルの一辺（m）
uniform vec4 uBand0;   // (kLo, kHi) タイル0, (kLo, kHi) タイル1
uniform vec2 uWindDir;
uniform float uTime;
uniform float uAmp;    // スペクトルの振幅 A
uniform float uKp;     // ピーク波数
uniform float uDirPow; // 風向への集中
uniform float uKt;     // 裾を落とし始める波数
uniform float uSeed;
varying vec2 vUv;

// ガウス乱数 2 つ（Box–Muller）。格子点のハッシュから作る＝決定的
vec2 gauss(vec2 cell){
  float u1 = max(flip_hash12(cell + uSeed), 1e-6);
  float u2 = flip_hash12(cell + 17.31 + uSeed);
  float r = sqrt(-2.0 * log(u1));
  return r * vec2(cos(6.2831853 * u2), sin(6.2831853 * u2));
}
// 風波のスペクトル（Phillips 型にピーク波数を入れたもの）。帯域はカスケード間でなめらかに分ける
float spectrum(vec2 k, vec2 band){
  float kl = length(k);
  if (kl < 1e-5) return 0.0;
  float k2 = kl * kl;
  float s = uAmp * exp(-(uKp * uKp) / k2) / (k2 * k2);
  float c = dot(k / kl, uWindDir);
  s *= mix(0.03, 1.0, pow(max(c, 0.0), uDirPow));     // 風上へ向かう波は弱い
  s *= exp(-k2 * 0.0004);                              // 2cm 以下は表面張力で消える
  s *= inversesqrt(1.0 + k2 / (uKt * uKt));            // 短い波の裾は Phillips より早く落とす（湖の静けさ）
  float wl = band.x <= 0.0 ? 1.0 : smoothstep(band.x * 0.72, band.x * 1.28, kl);
  float wh = band.y >= 1e8 ? 1.0 : 1.0 - smoothstep(band.y * 0.72, band.y * 1.28, kl);
  return s * wl * wh;
}
vec2 h0(vec2 cell, vec2 k, vec2 band, float dk){
  return gauss(cell) * sqrt(spectrum(k, band) * 0.5) * dk;
}
void main(){
  vec2 px = floor(vUv * vec2(uN * uTilesN, uN));
  float tile = floor(px.x / uN);
  vec2 ij = vec2(px.x - tile * uN, px.y);
  float L = tile < 0.5 ? uL.x : uL.y;
  vec2 band = tile < 0.5 ? uBand0.xy : uBand0.zw;
  float dk = 6.2831853 / L;
  // 添字 0..N/2-1 が正、N/2..N-1 が負の波数（FFT の並びそのまま。符号反転の後処理が要らない）
  vec2 n = ij - uN * step(uN * 0.5, ij);
  vec2 k = n * dk;
  vec2 ijm = mod(uN - ij, uN);
  vec2 seed = vec2(tile * 977.0, tile * 131.0);
  vec2 a = h0(ij + seed, k, band, dk);
  vec2 b = h0(ijm + seed, -k, band, dk);
  float kl = length(k);
  float w = sqrt(9.81 * kl + 0.000074 * kl * kl * kl);   // 分散関係（重力＋表面張力）
  float ph = w * uTime;
  vec2 e = vec2(cos(ph), sin(ph));
  // h(k,t) = h0(k) e^{-iwt} + conj(h0(-k)) e^{+iwt}  … 風下へ進む
  vec2 h = vec2(a.x * e.x + a.y * e.y, a.y * e.x - a.x * e.y)
         + vec2(b.x * e.x + b.y * e.y, b.x * e.y - b.y * e.x);
  vec2 kn = kl > 1e-5 ? k / kl : vec2(0.0);
  if (kl < 1e-5) h = vec2(0.0);
  // 水平変位 D = i k̂ h（波頭へ寄る）。Dx + i·Dz を 1 つの複素数に詰める
  vec2 C = vec2(-kn.x * h.y - kn.y * h.x, kn.x * h.x - kn.y * h.y);
  gl_FragColor = vec4(C, h);
}
`;

const FFT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uN;
uniform float uNs;
uniform float uHorizontal;
uniform vec2 uSize;
varying vec2 vUv;
void main(){
  vec2 px = floor(vUv * uSize);
  float o, tileOff = 0.0;
  if (uHorizontal > 0.5) { float tile = floor(px.x / uN); tileOff = tile * uN; o = px.x - tileOff; }
  else { o = px.y; }
  float R = float(RADIX);
  float NsR = uNs * R;
  float r = mod(floor(o / uNs), R);
  float jm = mod(o, uNs);
  float j = floor(o / NsR) * uNs + jm;
  float stride = uN / R;
  float baseAngle = 6.2831853 * (jm / NsR + r / R);   // 逆変換（正の指数）
  vec4 acc = vec4(0.0);
  for (int q = 0; q < RADIX; q++){
    float idx = j + float(q) * stride;
    vec2 sp = (uHorizontal > 0.5) ? vec2(tileOff + idx, px.y) : vec2(px.x, idx);
    vec4 v = texture2D(tSrc, (sp + 0.5) / uSize);
    float ang = baseAngle * float(q);
    float c = cos(ang), s = sin(ang);
    acc.xy += vec2(v.x * c - v.y * s, v.x * s + v.y * c);
    acc.zw += vec2(v.z * c - v.w * s, v.z * s + v.w * c);
  }
  gl_FragColor = acc;
}
`;

const DERIV_FRAG = /* glsl */ `
uniform sampler2D tDisp;
uniform sampler2D tPrev;
uniform float uN;
uniform float uTilesN;
uniform float uTile;
uniform float uL;
uniform float uChop;
uniform float uFoamDecay;
uniform vec2 uFoam;   // x = ヤコビアンの閾値, y = 倍率
varying vec2 vUv;
vec4 fetch(vec2 ij){
  ij = mod(ij, uN);
  return texture2D(tDisp, (vec2(uTile * uN, 0.0) + ij + 0.5) / vec2(uN * uTilesN, uN));
}
void main(){
  vec2 ij = floor(vUv * uN);
  float inv = uN / (2.0 * uL);
  vec4 r = fetch(ij + vec2(1.0, 0.0)), l = fetch(ij - vec2(1.0, 0.0));
  vec4 u = fetch(ij + vec2(0.0, 1.0)), d = fetch(ij - vec2(0.0, 1.0));
  vec2 dDx = vec2(r.x - l.x, u.x - d.x) * inv * uChop;
  vec2 dDz = vec2(r.y - l.y, u.y - d.y) * inv * uChop;
  vec2 dDy = vec2(r.z - l.z, u.z - d.z) * inv;
  float sx = dDy.x / max(1.0 + dDx.x, 0.35);
  float sz = dDy.y / max(1.0 + dDz.y, 0.35);
  float J = (1.0 + dDx.x) * (1.0 + dDz.y) - dDx.y * dDz.x;
  float foamNow = clamp((uFoam.x - J) * uFoam.y, 0.0, 1.0);
  float prev = texture2D(tPrev, vUv).a;
  float foam = max(foamNow, prev * uFoamDecay);
  gl_FragColor = vec4(sx, sz, sx * sx + sz * sz, foam);
}
`;

type Pass = { radix: number; ns: number; horizontal: boolean };

export class WaveSim {
  readonly N: number;
  readonly cascades: CascadeDef[];
  /** 変位アトラス（RG = 水平変位 x,z、B = 高さ）。頂点シェーダが手動バイリニアで読む */
  dispRT: THREE.WebGLRenderTarget;
  private pingRT: THREE.WebGLRenderTarget;
  /** 傾き・分散・泡（カスケードごと、ミップ付き、繰り返し）。泡の持続のため 2 枚を交互に使う */
  private derivRTs: THREE.WebGLRenderTarget[][] = [];
  private derivIndex = 0;
  private specMat: THREE.ShaderMaterial;
  private fftMats = new Map<number, THREE.ShaderMaterial>();
  private derivMat: THREE.ShaderMaterial;
  private passes: Pass[] = [];
  private lastTime = -1;
  /** 波の見た目のパラメータ（風から毎フレーム決める） */
  params = { hs: 0.05, lambdaP: 1.0, chop: 1.0, foamAmount: 0 };

  constructor(N: number, cascades: CascadeDef[], floatOK: boolean, maxAniso: number) {
    this.N = N;
    this.cascades = cascades;
    const tilesN = cascades.length;
    const type = floatOK ? THREE.FloatType : THREE.HalfFloatType;
    const mk = () =>
      new THREE.WebGLRenderTarget(N * tilesN, N, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.dispRT = mk();
    this.pingRT = mk();
    for (let c = 0; c < tilesN; c++) {
      const pair: THREE.WebGLRenderTarget[] = [];
      for (let i = 0; i < 2; i++) {
        const rt = new THREE.WebGLRenderTarget(N, N, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.RepeatWrapping,
          wrapT: THREE.RepeatWrapping,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: true,
        });
        rt.texture.anisotropy = Math.min(8, maxAniso);
        pair.push(rt);
      }
      this.derivRTs.push(pair);
    }
    // FFT のパス構成（横→縦）。N = 256 は 16×16、128 は 16×8
    const radices: number[] = [];
    let rem = N;
    while (rem > 1) {
      const r = rem % 16 === 0 && rem >= 16 ? 16 : rem % 8 === 0 ? 8 : rem % 4 === 0 ? 4 : 2;
      radices.push(r);
      rem /= r;
    }
    for (const horizontal of [true, false]) {
      let ns = 1;
      for (const r of radices) {
        this.passes.push({ radix: r, ns, horizontal });
        ns *= r;
      }
    }
    for (const r of new Set(radices)) {
      this.fftMats.set(
        r,
        new THREE.ShaderMaterial({
          defines: { RADIX: r },
          uniforms: {
            tSrc: { value: null },
            uN: { value: N },
            uNs: { value: 1 },
            uHorizontal: { value: 1 },
            uSize: { value: new THREE.Vector2(N * tilesN, N) },
          },
          vertexShader: FS_VERT,
          fragmentShader: FFT_FRAG,
          depthTest: false,
          depthWrite: false,
        }),
      );
    }
    const c0 = cascades[0], c1 = cascades[1] ?? cascades[0];
    this.specMat = new THREE.ShaderMaterial({
      uniforms: {
        uN: { value: N },
        uTilesN: { value: tilesN },
        uL: { value: new THREE.Vector4(c0.size, c1.size, 1, 1) },
        uBand0: { value: new THREE.Vector4(c0.kLo, c0.kHi, c1.kLo, c1.kHi) },
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uTime: { value: 0 },
        uAmp: { value: 1e-4 },
        uKp: { value: 3 },
        uDirPow: { value: 3 },
        uKt: { value: 30 },
        uSeed: { value: 0.37 },
      },
      vertexShader: FS_VERT,
      fragmentShader: SPECTRUM_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.derivMat = new THREE.ShaderMaterial({
      uniforms: {
        tDisp: { value: null },
        tPrev: { value: null },
        uN: { value: N },
        uTilesN: { value: tilesN },
        uTile: { value: 0 },
        uL: { value: c0.size },
        uChop: { value: 1 },
        uFoamDecay: { value: 0.97 },
        uFoam: { value: new THREE.Vector2(0.88, 4.0) },
      },
      vertexShader: FS_VERT,
      fragmentShader: DERIV_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** 傾きテクスチャ（現在のもの） */
  derivTexture(c: number): THREE.Texture {
    return this.derivRTs[c][this.derivIndex].texture;
  }

  /**
   * 風から波の姿を決める。有義波高 Hs とピーク波長は湖のスケールに合わせて（物理より少し誇張）。
   * 返り値は水面シェーダも使う。
   */
  setWind(dir: THREE.Vector2, speed: number, storm: number) {
    const U = Math.max(speed, 0.3);
    const hs = 0.0025 + 0.0042 * U * U;                   // 2m/s: 2cm, 5m/s: 11cm, 11m/s: 51cm
    const lambdaP = 0.35 + 0.062 * U * U;                 // 2m/s: 0.6m, 5m/s: 1.9m, 11m/s: 7.9m
    const kp = (2 * Math.PI) / lambdaP;
    const amp = ((hs / 4) * (hs / 4) * kp * kp) / 2;
    const t = Math.min(Math.max((U - 3) / 7, 0), 1);
    this.params.hs = hs;
    this.params.lambdaP = lambdaP;
    this.params.chop = 0.75 + 0.55 * t * t;
    this.params.foamAmount = Math.min(Math.max((U - 6.5) / 4.5, 0), 1) * (0.6 + 0.4 * storm);
    const u = this.specMat.uniforms;
    (u.uWindDir.value as THREE.Vector2).copy(dir).normalize();
    u.uAmp.value = amp;
    u.uKp.value = kp;
    u.uDirPow.value = 2.0 + 0.45 * U;
    u.uKt.value = Math.max(3.0 * kp, 20);
  }

  /** 1 フレーム分。time が変わっていなければ（freeze）スペクトルは同じでも泡の持続だけ進める */
  update(pipeline: Pipeline, time: number, dt: number) {
    const N = this.N;
    const su = this.specMat.uniforms;
    su.uTime.value = time;
    pipeline.blit(this.specMat, this.pingRT);
    let src = this.pingRT, dst = this.dispRT;
    for (const p of this.passes) {
      const m = this.fftMats.get(p.radix)!;
      m.uniforms.tSrc.value = src.texture;
      m.uniforms.uNs.value = p.ns;
      m.uniforms.uHorizontal.value = p.horizontal ? 1 : 0;
      pipeline.blit(m, dst);
      const t = src; src = dst; dst = t;
    }
    // 最後に書いたのが src。dispRT に揃える（パス数が奇数なら入れ替える）
    if (src !== this.dispRT) {
      const t = this.dispRT; this.dispRT = this.pingRT; this.pingRT = t;
    }
    const next = 1 - this.derivIndex;
    const du = this.derivMat.uniforms;
    du.tDisp.value = this.dispRT.texture;
    du.uFoamDecay.value = Math.exp(-Math.max(dt, 0) / 3.5);
    du.uN.value = N;
    for (let c = 0; c < this.cascades.length; c++) {
      du.uTile.value = c;
      du.uL.value = this.cascades[c].size;
      du.uChop.value = this.params.chop;
      du.tPrev.value = this.derivRTs[c][this.derivIndex].texture;
      pipeline.blit(this.derivMat, this.derivRTs[c][next]);
    }
    this.derivIndex = next;
    this.lastTime = time;
  }

  dispose() {
    this.dispRT.dispose();
    this.pingRT.dispose();
    for (const pair of this.derivRTs) for (const rt of pair) rt.dispose();
  }
}
