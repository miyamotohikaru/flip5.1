// 岸の「寄せ波が今しがた覆ったところ」。地形そのものは触らず、画面空間のデカールとして描く:
// コピーした線形深度から世界座標を戻し、湖面のすぐ上の地面に、波の位相で上下する濡れ線を出す。
// LAYER.WATER で水面より先に描く（renderOrder = -10）。ブレンドは out = src.rgb + dst * src.a。
//
// **濡れた砂の「地の暗さ」は地形側が持つ**（terrain/glsl.ts の wetBand。濡れ→湿り→乾きの 3 段、
// 上端を λ1.8m と λ6m で振り、岸線からの距離でも減衰させ、距離でミップ相当に消す）。
// ここが同じものをもう一度掛けていたので、水際に幅 3〜5px の暗い線が一周していた
// （批評R7 noon。地形の帯は 1〜2m の高さでぼやけるが、こちらは 24cm の高さで固く切れるため、
//  浅い角度では常に数画素の硬い縁になる ＝「湖に縁取りをした」画）。2026-09-04 に切り分け:
//   ?dbg=noshore でこのデカールだけ止めると、(1100,480)-(1500,580) の
//   「岸線から 1〜5px の輝度 ÷ 14〜26px の輝度」が 0.887 → 0.961 に戻った。
// そこで **地の暗さは地形に任せ、ここは「時間で動く分」だけ**にした（下の dark は 1.0 に近い）。
import * as THREE from "three";
import type { Env } from "../core/env";
import { LAYER, type Pipeline } from "../core/pipeline";
import { bindEnvUniforms } from "../core/patch";

const VERT = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  vUv = uv;
  vec4 p = uInvProj * vec4(position.xy, 1.0, 1.0);
  vec3 viewDir = p.xyz / p.w;
  vRay = (uCamWorld * vec4(viewDir, 0.0)).xyz;   // 世界のレイ（view z = -1 に正規化していない）
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_height>
#include <flip_flip>
uniform sampler2D tSceneDepth;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uWind;
uniform float uLakeLevel;
uniform float uWetness;
uniform float uRain;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  float lin = texture2D(tSceneDepth, vUv).r;
  if (lin > 600.0) discard;
  vec3 ray = vRay;
  float cosV = dot(normalize(ray), uCamFwd);
  vec3 world = uCamPos + normalize(ray) * (lin / max(cosV, 0.05));
  float h = world.y - uLakeLevel;
  if (h < -0.05 || h > 1.8) discard;
  // 寄せ波で濡れ線が上下する（水面シェーダの浅瀬の波と同じ位相）
  float depthA = uLakeLevel - flip_height(world.xz);
  float sd = 70.0 * log(max(1.0 - max(depthA, 0.0) / 34.0, 0.02));
  float wind = uWind.z;
  float ph = sd * (6.2831853 / 9.0) - 1.9 * uTime + flip_gnoise(world.xz * 0.04 + 2.0) * 1.6;
  float swash = 0.5 + 0.5 * cos(ph);
  float energy = 0.05 + 0.30 * smoothstep(1.0, 10.0, wind);
  float n = flip_gnoise(world.xz * 0.35) * 0.5 + flip_gnoise(world.xz * 1.7 + 9.0) * 0.25;
  // 「いま波が来ている高さ」。地形の wetTop（0.34 ＋ λ1.8m/λ6m のノイズ）と同じ桁にして、
  // 帯の幅を場所ごとに散らす（一定幅だと、どんなに薄くても縁取りに見える）
  float line = 0.06 + energy * (0.35 + 0.65 * swash) + n * 0.13;
  // 上へは 0.5〜2m かけて抜く。24cm で切っていたので浅い角度では常に数画素の硬い縁だった
  float wet = 1.0 - smoothstep(line, line + 0.50 + energy * 1.7, h);
  // 下の縁。水際で 1 画素の段にならないよう 30cm かけて立ち上げる
  // （いちばん濃いのは水際そのものではなく、波が引いた少し上 ＝ 実際の swash zone）
  wet *= smoothstep(-0.05, 0.30, h);
  float farFade = 1.0 - smoothstep(120.0, 400.0, lin);
  wet *= 0.4 + 0.6 * farFade;
  // 濡れの「地の暗さ」は地形が持つ（冒頭のコメント）。ここは寄せ波で今しがた濡れた分だけ。
  // 0.55（45% 暗く）は地形の帯の上に重なって幅 3〜5px の縁取りになっていた
  float dark = mix(0.93, 0.98, uWetness);
  float mult = mix(1.0, dark, wet * (0.35 + 0.65 * swash));
  // 濡れた砂は空を少し映す（視線が浅いほど）
  vec3 tn = flip_terrainNormal(world.xz, 1.5);
  vec3 V = normalize(uCamPos - world);
  float NdotV = max(dot(tn, V), 0.0);
  float fres = pow(1.0 - NdotV, 4.0);
  // 濡れた砂は水膜が空を映すので、乾いた砂より青みが乗って赤みが落ちる。
  // かすめる角度だけでなく真下を見たときも少し乗る（地形の砂のアルベドが暖色なので、
  // 暗くするだけだと帯が赤紫のかぶりに見える）
  // 暗くするのをやめた分、艶も控えめに（前は暗さと釣り合わせるために強く乗せていた）
  vec3 sheen = uSkyAmbient * (0.018 + 0.055 * fres) * wet;
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(tn, H), 0.0), 180.0) * 0.06 * wet * step(0.0, uSunDir.y);
  sheen += uSunColor * spec;
  // 引き波の縁の泡の名残
  // 4.5cm の高さで切ると浅い角度で 1 画素の線になるので、15cm に広げてぼかす
  float rim = smoothstep(line - 0.06, line, h) * (1.0 - smoothstep(line, line + 0.09, h));
  float rimN = flip_vnoise(world.xz * 9.0 + vec2(uTime * 0.3, 0.0));
  vec3 foam = (uSkyAmbient * 0.9 + uSunColor * max(uSunDir.y, 0.0) * 0.6) / 3.14159 * rim * smoothstep(0.45, 0.75, rimN) * 0.4 * (0.3 + 0.7 * swash) * smoothstep(1.0, 6.0, wind) * (1.0 - smoothstep(40.0, 120.0, lin));
  // 裏返しでは消す（地形が線になるので）
  float fm = flip_mask(world);
  mult = mix(mult, 1.0, fm);
  sheen = mix(sheen + foam, vec3(0.0), fm);
  gl_FragColor = vec4(sheen, mult);
}
`;

export class ShoreDecal {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private invProj = new THREE.Matrix4();

  constructor(scene: THREE.Scene, env: Env) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const uniforms: Record<string, THREE.IUniform> = {
      tSceneDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    };
    bindEnvUniforms(uniforms, env);
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.layers.set(LAYER.WATER);
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      const cam = camera as THREE.PerspectiveCamera;
      this.invProj.copy(cam.projectionMatrix).invert();
      (this.material.uniforms.uInvProj.value as THREE.Matrix4).copy(this.invProj);
      (this.material.uniforms.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    };
    scene.add(this.mesh);
  }

  update(pipeline: Pipeline, camFwd: THREE.Vector3, visible: boolean) {
    this.material.uniforms.tSceneDepth.value = pipeline.copyDepthRT.texture;
    (this.material.uniforms.uCamFwd.value as THREE.Vector3).copy(camFwd);
    this.mesh.visible = visible;
  }
}
