// 岸の「濡れた砂の帯」。地形そのものは触らず、画面空間のデカールとして描く:
// コピーした線形深度から世界座標を戻し、湖面のすぐ上（0〜40cm）の地面を暗く・少し艶ありに。
// 寄せ波に合わせて濡れ線が上下し、引いた直後の縁に泡の名残の線が出る。
// LAYER.WATER で水面より先に描く（renderOrder = -10）。ブレンドは out = src.rgb + dst * src.a。
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
  if (h < -0.05 || h > 0.9) discard;
  // 寄せ波で濡れ線が上下する（水面シェーダの浅瀬の波と同じ位相）
  float depthA = uLakeLevel - flip_height(world.xz);
  float sd = 70.0 * log(max(1.0 - max(depthA, 0.0) / 34.0, 0.02));
  float wind = uWind.z;
  float ph = sd * (6.2831853 / 9.0) - 1.9 * uTime + flip_gnoise(world.xz * 0.04 + 2.0) * 1.6;
  float swash = 0.5 + 0.5 * cos(ph);
  float energy = 0.04 + 0.22 * smoothstep(1.0, 10.0, wind);
  float n = flip_gnoise(world.xz * 0.35) * 0.5 + flip_gnoise(world.xz * 1.7 + 9.0) * 0.25;
  float line = 0.03 + energy * (0.3 + 0.7 * swash) + n * 0.04;
  float wet = 1.0 - smoothstep(line, line + 0.12 + energy * 0.6, h);
  wet *= smoothstep(-0.05, 0.02, h);
  float farFade = 1.0 - smoothstep(120.0, 400.0, lin);
  wet *= 0.4 + 0.6 * farFade;
  // 濡れの暗さ。雨で全体が濡れているときは差が小さい
  float dark = mix(0.55, 0.82, uWetness);
  float mult = mix(1.0, dark, wet);
  // 濡れた砂は空を少し映す（視線が浅いほど）
  vec3 tn = flip_terrainNormal(world.xz, 1.5);
  vec3 V = normalize(uCamPos - world);
  float NdotV = max(dot(tn, V), 0.0);
  float fres = pow(1.0 - NdotV, 4.0);
  vec3 sheen = uSkyAmbient * 0.045 * fres * wet;
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(tn, H), 0.0), 180.0) * 0.06 * wet * step(0.0, uSunDir.y);
  sheen += uSunColor * spec;
  // 引き波の縁の泡の名残
  float rim = smoothstep(line - 0.015, line, h) * (1.0 - smoothstep(line, line + 0.03, h));
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
