// 自動露出と自動ピント。
//   計測: ブルームの最小段（1/64）を 1 画素で読み切り、「やや下寄り・空を軽く」の log 平均輝度を出す。
//         同時に画面中央の深度から焦点距離（m）を出す
//   追従: 1×1 の RT をピンポンして、時定数付きで寄せる（明→暗はゆっくり、暗→明は速く）
//   CPU へは数フレームに 1 回だけ非同期で読み戻す（被写界深度のパスを飛ばす判断と stats 用）
import * as THREE from "three";
import type { Pipeline } from "../core/pipeline";
import { fsMaterial, makeRT, POST_COMMON } from "./pass";

const MEASURE_FRAG = /* glsl */ `
${POST_COMMON}
uniform sampler2D tLum;
uniform vec2 uLumSize;
uniform sampler2D tDepth;
uniform vec2 uDepthTexel;
uniform float uNear;
uniform float uFar;
void main(){
  // 輝度: 中央に重み
  float sum = 0.0, tw = 0.0;
  for (int y = 0; y < 40; y++) {
    if (float(y) >= uLumSize.y) break;
    for (int x = 0; x < 72; x++) {
      if (float(x) >= uLumSize.x) break;
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / uLumSize;
      // 風景写真の測光にならう: 重みの中心をやや下（地面側）へ寄せ、空の重みを落とす。
      // 空は明るくて面積が広いので、素直に平均すると地面が沈む。
      // 黄昏・夜明け・森・尾根（空が明るく地面が暗い画）で 1〜2 段の差になる。
      vec2 d = (uv - vec2(0.5, 0.40)) * vec2(1.0, 0.75);
      float w = exp(-dot(d, d) * 4.0) + 0.10;
      w *= mix(1.0, 0.45, smoothstep(0.55, 0.85, uv.y));
      float l = post_luma(texture2D(tLum, uv).rgb);
      sum += log2(max(l, 1e-5)) * w;
      tw += w;
    }
  }
  float logLum = sum / tw;
  // 焦点: 中央の 5×5（3px 間隔）の対数平均距離
  float fs = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float z = texture2D(tDepth, vec2(0.5) + vec2(float(i), float(j)) * uDepthTexel * 3.0).r;
      fs += log2(post_linearDepth(z, uNear, uFar));
    }
  }
  float focus = exp2(fs / 25.0);
  gl_FragColor = vec4(logLum, focus, 0.0, 1.0);
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tNow;
uniform float uDt;
uniform float uSnap;
void main(){
  vec4 p = texture2D(tPrev, vec2(0.5));
  vec4 n = texture2D(tNow, vec2(0.5));
  // 露出: 明るくなる方向は速く（3/s）、暗くなる方向はゆっくり（1.2/s）
  float rate = n.x > p.x ? 1.2 : 3.0;
  float kl = 1.0 - exp(-uDt * rate);
  float kf = 1.0 - exp(-uDt * 5.0);
  float lum = mix(p.x, n.x, kl);
  float focus = exp2(mix(log2(max(p.y, 0.05)), log2(max(n.y, 0.05)), kf));
  if (uSnap > 0.5) { lum = n.x; focus = n.y; }
  gl_FragColor = vec4(lum, focus, 0.0, 1.0);
}
`;

export class Exposure {
  measureRT: THREE.WebGLRenderTarget;
  adaptA: THREE.WebGLRenderTarget;
  adaptB: THREE.WebGLRenderTarget;
  private measureMat: THREE.ShaderMaterial;
  private adaptMat: THREE.ShaderMaterial;
  /** 追従後の値が入っている RT（合成パスが読む） */
  texture: THREE.Texture;
  /** CPU に読み戻した値（数フレーム遅れ） */
  avgLum = 0.18;
  focus = 5;
  private frames = 0;
  private reading = false;
  private readBuf: Float32Array | Uint16Array;
  private useFloat: boolean;

  constructor(renderer: THREE.WebGLRenderer, floatOk: boolean) {
    this.useFloat = floatOk;
    const type = floatOk ? THREE.FloatType : THREE.HalfFloatType;
    this.measureRT = makeRT(1, 1, { type, filter: THREE.NearestFilter });
    this.adaptA = makeRT(1, 1, { type, filter: THREE.NearestFilter });
    this.adaptB = makeRT(1, 1, { type, filter: THREE.NearestFilter });
    this.readBuf = floatOk ? new Float32Array(4) : new Uint16Array(4);
    this.measureMat = fsMaterial(
      "exposure_measure",
      {
        tLum: { value: null },
        uLumSize: { value: new THREE.Vector2(1, 1) },
        tDepth: { value: null },
        uDepthTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 9000 },
      },
      MEASURE_FRAG,
    );
    this.adaptMat = fsMaterial("exposure_adapt", { tPrev: { value: null }, tNow: { value: null }, uDt: { value: 0 }, uSnap: { value: 1 } }, ADAPT_FRAG);
    this.texture = this.adaptA.texture;
    void renderer;
  }

  /** 撮影ごとに呼ぶと次のフレームで即座に値を合わせる（写真モード・リサイズ後） */
  snap() {
    this.frames = 0;
  }

  render(pipeline: Pipeline, lumTex: THREE.Texture, lumW: number, lumH: number, depth: THREE.Texture, fullW: number, fullH: number, camera: THREE.PerspectiveCamera, dt: number) {
    const mm = this.measureMat, am = this.adaptMat;
    mm.uniforms.tLum.value = lumTex;
    (mm.uniforms.uLumSize.value as THREE.Vector2).set(lumW, lumH);
    mm.uniforms.tDepth.value = depth;
    (mm.uniforms.uDepthTexel.value as THREE.Vector2).set(1 / fullW, 1 / fullH);
    mm.uniforms.uNear.value = camera.near;
    mm.uniforms.uFar.value = camera.far;
    pipeline.blit(mm, this.measureRT);
    const prev = this.frames % 2 === 0 ? this.adaptA : this.adaptB;
    const next = this.frames % 2 === 0 ? this.adaptB : this.adaptA;
    am.uniforms.tPrev.value = prev.texture;
    am.uniforms.tNow.value = this.measureRT.texture;
    am.uniforms.uDt.value = Math.min(dt, 0.1);
    am.uniforms.uSnap.value = this.frames < 3 ? 1 : 0;
    pipeline.blit(am, next);
    this.texture = next.texture;
    this.frames++;
    // CPU へ読み戻し（8 フレームに 1 回、非同期）
    if (this.useFloat && !this.reading && this.frames % 8 === 0) {
      this.reading = true;
      const buf = this.readBuf as Float32Array;
      pipeline.renderer
        .readRenderTargetPixelsAsync(next, 0, 0, 1, 1, buf)
        .then(() => {
          if (Number.isFinite(buf[0])) this.avgLum = Math.pow(2, buf[0]);
          if (Number.isFinite(buf[1]) && buf[1] > 0) this.focus = buf[1];
        })
        .catch(() => {})
        .finally(() => {
          this.reading = false;
        });
    }
  }

  dispose() {
    this.measureRT.dispose();
    this.adaptA.dispose();
    this.adaptB.dispose();
    this.measureMat.dispose();
    this.adaptMat.dispose();
  }
}
