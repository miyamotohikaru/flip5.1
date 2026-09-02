// 地表霧のむら（半解像度レイマーチ → 深度を見て拡大合成）＋ 雨のヴェール ＋ 稲光の暫定ライティング。
//   - 密度: 湖面からの高さで薄くなる層 × 谷筋（地形が低いところ）に溜まる × 地面を這う × 3D ノイズのむら（風で流れる）
//   - 光: 太陽の前方散乱（HG）で太陽側が明るい・半球光・月・稲光
//   - 合成: rgb = 散乱光（premultiplied）, a = 1 - 透過率。水面の後（TRANSPARENT）に描くので水にも掛かる
//   - 稲光の暫定ライティング（flashMesh）: 空担当・地形担当が uLightning を読むまでの間、地面と空を一瞬明るくする
import * as THREE from "three";
import { LAYER } from "../core/pipeline";
import { WX_COMMON, WX_FS_VERT } from "./glsl";
import type { Weather } from "./index";

/** 空担当・地形担当が uLightning を読むようになったら false にする（二重に明るくなるのを防ぐ） */
export const INTERIM_FLASH_LIGHTING = true;

const MARCH_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
#include <flip_atmosphere>
#include <flip_flip>
${WX_COMMON}
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uLightning;
uniform vec3 uLightningPos;
uniform float uWxSteps;
varying vec2 vUv;
varying vec3 vRay;

float wx_noise3(vec3 p){ return 0.7 * flip_vnoise(p) + 0.3 * flip_vnoise(p.xz * 3.1 + 7.3 + p.y * 0.7); }

// 霧の密度（0..1 相当）。湖面すれすれの薄い層（場所ごとに厚さの違う「塊」）＋谷底＋斜面を這う霧＋細かいむら
float mistDensity(vec3 p){
  float th = flip_height(p.xz);
  float hL = p.y - uWxLake;
  float hag = p.y - th;
  // 低周波の「霧の塊」で層の厚さ（スケール高さ）が場所ごとに変わる → たなびく帯と切れ目
  vec2 q2 = (p.xz + uWxFogDrift.xz * 0.6) * 0.012;
  float bank = flip_vnoise(q2) * 0.7 + flip_vnoise(q2 * 2.3 + 5.0) * 0.3;
  float Hs = uWxFog.y * (0.35 + 2.4 * bank * bank);
  float layer = exp(-max(hL, 0.0) / Hs) * smoothstep(60.0, 0.0, th - uWxLake);
  float creep = exp(-max(hag, 0.0) / (uWxFog.y * 0.8)) * smoothstep(200.0, 15.0, th - uWxLake) * 0.22;
  float base = max(layer, creep) * step(-1.0, hag);
  // 細かいむら: 横に長く、縦に薄い「たなびき」。コントラストを強く（濃い塊と切れ目）
  vec3 q = (p + uWxFogDrift) * vec3(0.045, 0.3, 0.045);
  float n = wx_noise3(q);
  n = smoothstep(0.42, 0.78, n);
  // 湖面すれすれ（〜70cm）の濃い「たなびき」: 風向きに引き伸ばした 2D ノイズで筋状に
  vec2 wd = normalize(uWxFogDrift.xz + vec2(1e-3, 0.0));
  vec2 pw = vec2(dot(p.xz, wd), dot(p.xz, vec2(-wd.y, wd.x)));
  vec2 pn = vec2(pw.x * 0.03, pw.y * 0.11) + uWxFogDrift.xz * 0.05;
  float n2 = 0.7 * flip_vnoise(pn) + 0.3 * flip_vnoise(pn * 3.7 + 11.0);
  float wisp = exp(-max(hL, 0.0) / 1.0) * smoothstep(0.42, 0.62, n2) * smoothstep(3.0, -0.5, th - uWxLake) * step(-1.0, hag);
  return base * (0.08 + 0.92 * n) + wisp * 4.0;
}

// 1歩ぶんの散乱光。skyH = その視線の地平近くの空の色（霧は空の色で光る: 曇りなら灰、夜明けなら薄紅）
vec3 stepLight(vec3 p, vec3 rd, vec3 skyH){
  float sunUp = smoothstep(-0.06, 0.04, uSunDir.y);
  float cs = dot(rd, uSunDir);
  vec3 sun = uSunColor * (wx_phaseHG(cs, 0.6) * 0.75 + 0.06) * sunUp;
  vec3 amb = mix(uSkyAmbient * 0.6, skyH, 0.65) + uGroundAmbient * 0.15;
  vec3 moon = uMoonColor * (wx_phaseHG(dot(rd, uMoonDir), 0.5) * 0.7 + 0.1) * 2.0;
  vec3 lp = uLightningPos + vec3(0.0, uWxCloudBase * 0.45, 0.0);
  float dl = distance(p, lp);
  vec3 flash = vec3(0.8, 0.86, 1.0) * uLightning * 0.25 / (1.0 + dl * dl * 1e-5);
  return sun + amb + moon + flash;
}

void main(){
  vec2 uvFull = (floor(gl_FragCoord.xy) * 2.0 + 0.5) / uWxResolution;
  float lin = texture2D(tWxDepth, uvFull).r;
  float rayLen = length(vRay);
  vec3 rd = vRay / rayLen;
  vec3 ro = uCamPos;
  float tEnd = lin * rayLen;
  float mist = uWxFog.x;
  float T = 1.0;
  vec3 L = vec3(0.0);
  float odTotal = 0.0;
  vec3 skyH = flip_skyColor(normalize(vec3(rd.x, max(rd.y, 0.015), rd.z)));
  if (mist > 1e-4) {
    float top = uWxFog.z, bottom = uWxLake - 4.0;
    float t0 = 0.0, t1 = tEnd;
    if (abs(rd.y) > 1e-4) {
      float ta = (top - ro.y) / rd.y;
      float tb = (bottom - ro.y) / rd.y;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
      // 水面より下には霧が無い（深度は水底なので、水面で打ち切る）
      if (ro.y > uWxLake && rd.y < 0.0) t1 = min(t1, (uWxLake - ro.y) / rd.y);
    } else if (ro.y > top || ro.y < bottom) {
      t1 = t0;
    }
    if (ro.y < uWxLake) t1 = t0;
    if (t1 > t0) {
      float marchEnd = min(t1, t0 + 380.0);
      // 霧が薄いときは段数を減らす（雨・嵐の中の薄い地表霧に全段は要らない）
      float N = ceil(uWxSteps * clamp(mist * 2.5 + 0.2, 0.35, 1.0));
      float dither = flip_hash12(gl_FragCoord.xy + 0.37);
      float k = mist * WX_FOG_K;
      float span = marchEnd - t0;
      float prevT = t0;
      for (int i = 0; i < 24; i++) {
        if (float(i) >= N) break;
        float f1 = (float(i) + 1.0) / N;
        float tNext = t0 + span * f1 * f1;
        float fm = (float(i) + dither) / N;
        float t = t0 + span * fm * fm;
        float dt = tNext - prevT;
        prevT = tNext;
        vec3 p = ro + rd * t;
        float od = mistDensity(p) * k * dt;
        float Ti = exp(-od);
        L += stepLight(p, rd, skyH) * (1.0 - Ti) * T;
        T *= Ti;
        odTotal += od;
        if (T < 0.004) break;
      }
      if (t1 > marchEnd && T > 0.004) {
        float odt = wx_fogOD(ro + rd * marchEnd, ro + rd * t1) * 0.7;
        float Tt = exp(-odt);
        L += stepLight(ro + rd * (marchEnd + 40.0), rd, skyH) * (1.0 - Tt) * T;
        T *= Tt;
        odTotal += odt;
      }
    }
  }
  // 雨のヴェール: 遠くほど雨粒の層で白む。うっすら縦に流れるむら（雨の幕）
  if (uWxFog.w > 1e-7) {
    float dV = min(tEnd, 6000.0);
    vec3 ps = ro + rd * min(tEnd, 140.0);
    float sheet = 0.75 + 0.5 * flip_vnoise(vec3(ps.x * 0.035, ps.y * 0.01 - uTime * 2.2, ps.z * 0.035));
    float odv = wx_veilOD(dV) * sheet;
    float Tv = exp(-odv);
    // 稲光は稲妻の方向の雨のカーテンだけを強く照らす（一様に足すと空全体が白飛びする）
    vec3 toBolt = normalize(uLightningPos + vec3(0.0, uWxCloudBase * 0.5, 0.0) - ro);
    float flashDir = 0.03 + 0.2 * pow(max(dot(rd, toBolt), 0.0), 6.0);
    // 遠くの物は「その仰角の空の色」へ溶ける（空より明るくならない）
    vec3 vcol = skyH * 0.92 + uSkyAmbient * 0.06 + uGroundAmbient * 0.04 + vec3(0.8, 0.86, 1.0) * uLightning * flashDir;
    L += vcol * (1.0 - Tv) * T;
    T *= Tv;
    odTotal += odv;
  }
  // 裏返し: 密度の等値線（板の上に）
  vec3 pm = ro + rd * min(tEnd, 200.0);
  float fmask = flip_mask(pm);
  if (fmask > 0.0) {
    float iso = flip_line(odTotal * 5.0, 0.06);
    vec3 mc = (FLIP_LINE * iso * 0.9 + FLIP_BG * 0.6) * (1.0 - T);
    L = mix(L, mc, fmask);
  }
  gl_FragColor = vec4(L, T);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${WX_COMMON}
uniform sampler2D tWxFog;
uniform vec2 uWxFogRes;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  vec2 fc = gl_FragCoord.xy;
  float myD = texture2D(tWxDepth, fc / uWxResolution).r;
  vec2 hp = fc * 0.5 - 0.5;
  vec2 b = floor(hp);
  vec2 f = hp - b;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 n = clamp(b + vec2(float(i), float(j)), vec2(0.0), uWxFogRes - 1.0);
      float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float d = texture2D(tWxDepth, (n * 2.0 + 0.5) / uWxResolution).r;
      float dw = 1.0 / (0.02 + abs(d - myD) / max(myD, 1.0) * 8.0);
      float w = bw * dw + 1e-4;
      acc += texture2D(tWxFog, (n + 0.5) / uWxFogRes) * w;
      wsum += w;
    }
  }
  vec4 fog = acc / wsum;
  gl_FragColor = vec4(fog.rgb, 1.0 - fog.a);
}
`;

const FLASH_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
${WX_COMMON}
uniform vec3 uCamPos;
uniform float uLightning;
uniform vec3 uLightningPos;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  float lin = texture2D(tWxDepth, gl_FragCoord.xy / uWxResolution).r;
  vec3 rd = normalize(vRay);
  vec3 p = uCamPos + vRay * lin;
  vec3 lp = uLightningPos + vec3(0.0, uWxCloudBase * 0.4, 0.0);
  float b;
  if (lin > 8500.0) {
    vec3 toL = normalize(lp - uCamPos);
    b = 0.15 + 1.6 * pow(max(dot(rd, toL), 0.0), 8.0);
  } else {
    vec3 N = flip_terrainNormal(p.xz, 2.5);
    vec3 toL = lp - p;
    float d = length(toL);
    toL /= d;
    float ndl = max(dot(N, toL), 0.0);
    float att = 1.0 / (1.0 + d * d / (650.0 * 650.0));
    b = ndl * att * 2.2 + 0.12;
  }
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * b * uLightning, 1.0);
}
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

export class GroundFog {
  rt: THREE.WebGLRenderTarget;
  marchMat: THREE.ShaderMaterial;
  compMat: THREE.ShaderMaterial;
  flashMat: THREE.ShaderMaterial;
  compMesh: THREE.Mesh;
  flashMesh: THREE.Mesh;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private marchMesh: THREE.Mesh;
  private rtW = 0;
  private rtH = 0;
  /** この霧を描くか（量がゼロなら丸ごと飛ばす） */
  active = false;

  constructor(public w: Weather) {
    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.marchMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ uWxSteps: { value: w.counts.fogSteps } }),
      vertexShader: WX_FS_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.marchMesh = new THREE.Mesh(fullscreenTriangle(), this.marchMat);
    this.marchMesh.frustumCulled = false;
    this.fsScene.add(this.marchMesh);

    this.compMat = new THREE.ShaderMaterial({
      uniforms: w.bind({ tWxFog: { value: this.rt.texture }, uWxFogRes: { value: new THREE.Vector2(2, 2) } }),
      vertexShader: WX_FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
    });
    this.compMesh = new THREE.Mesh(fullscreenTriangle(), this.compMat);
    this.compMesh.frustumCulled = false;
    this.compMesh.layers.set(LAYER.TRANSPARENT);
    this.compMesh.renderOrder = 10;
    this.compMesh.castShadow = false;
    this.compMesh.name = "weather.fog";
    this.compMesh.onBeforeRender = (renderer, _scene, camera) => this.march(renderer, camera as THREE.PerspectiveCamera);
    w.group.add(this.compMesh);

    this.flashMat = new THREE.ShaderMaterial({
      uniforms: w.bind({}),
      vertexShader: WX_FS_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.flashMesh = new THREE.Mesh(fullscreenTriangle(), this.flashMat);
    this.flashMesh.frustumCulled = false;
    this.flashMesh.layers.set(LAYER.TRANSPARENT);
    this.flashMesh.renderOrder = 20;
    this.flashMesh.castShadow = false;
    this.flashMesh.name = "weather.flash";
    this.flashMesh.visible = false;
    // 稲光の暫定ライティングはカメラ行列が要る（compMesh が描かれないフレームもあるので自前で更新）
    this.flashMesh.onBeforeRender = (_r, _s, camera) => this.updateCamera(camera as THREE.PerspectiveCamera);
    w.group.add(this.flashMesh);
  }

  private updateCamera(camera: THREE.PerspectiveCamera) {
    const wx = this.w.wx;
    wx.uWxInvProj.value.copy(camera.projectionMatrix).invert();
    wx.uWxCamWorld.value.copy(camera.matrixWorld);
  }

  /** 半解像度で霧を積分（compMesh の描画直前に呼ばれる。Reflector と同じ入れ子描画） */
  private march(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) {
    this.updateCamera(camera);
    const p = this.w.pipeline;
    const fw = Math.max(1, Math.floor((p?.width ?? 2) / 2));
    const fh = Math.max(1, Math.floor((p?.height ?? 2) / 2));
    if (fw !== this.rtW || fh !== this.rtH) {
      this.rtW = fw;
      this.rtH = fh;
      this.rt.setSize(fw, fh);
      (this.compMat.uniforms.uWxFogRes.value as THREE.Vector2).set(fw, fh);
    }
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.fsScene, this.fsCam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadow;
  }

  update() {
    const w = this.w;
    const fog = w.wx.uWxFog.value;
    const flash = w.env.lightning.flash;
    this.active = fog.x > 0.002 || fog.w > 1e-7;
    this.compMesh.visible = this.active;
    this.flashMesh.visible = INTERIM_FLASH_LIGHTING && flash > 0.004;
  }
}
