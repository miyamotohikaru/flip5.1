// 湖。土台版: 平面鏡の映り込み＋屈折（シーンのコピー）＋水深による吸収＋Gerstner波＋岸の泡。
// 水担当は波（FFT など）・泡・雨の波紋・裏返し表現・端末別の負荷調整を作り込む。
import * as THREE from "three";
import type { Env } from "../core/env";
import { LAYER, type Pipeline } from "../core/pipeline";
import { bindEnvUniforms } from "../core/patch";
import type { QualitySettings } from "../core/quality";
import { WORLD } from "../core/heightfield";

const WATER_VERT = /* glsl */ `
#include <flip_noise>
uniform float uTime;
uniform vec3 uWind;
uniform mat4 uReflMatrix;
varying vec3 vWorld;
varying vec4 vReflCoord;
varying vec3 vWaveN;
// 3つの Gerstner 波
vec3 gerstner(vec2 xz, vec2 dir, float amp, float wl, float speed, float t, inout vec3 n){
  float k = 6.28318 / wl;
  float f = k * (dot(dir, xz) - speed * t);
  float q = 0.6;
  vec3 d = vec3(q * amp * dir.x * cos(f), amp * sin(f), q * amp * dir.y * cos(f));
  n += vec3(-dir.x * k * amp * cos(f), -q * k * amp * sin(f), -dir.y * k * amp * cos(f));
  return d;
}
void main(){
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  float w = clamp(uWind.z / 8.0, 0.15, 1.5);
  vec2 wd = normalize(uWind.xy + vec2(0.001, 0.0));
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 d = vec3(0.0);
  d += gerstner(world.xz, wd, 0.06 * w, 9.0, 3.0, uTime, n);
  d += gerstner(world.xz, normalize(wd + vec2(0.6, -0.4)), 0.035 * w, 4.2, 2.2, uTime, n);
  d += gerstner(world.xz, normalize(wd + vec2(-0.5, 0.7)), 0.02 * w, 2.1, 1.6, uTime, n);
  world += d;
  vWorld = world;
  vWaveN = normalize(n);
  vReflCoord = uReflMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const WATER_FRAG = /* glsl */ `
#include <flip_noise>
#include <flip_atmosphere>
#include <flip_flip>
uniform sampler2D tReflection;
uniform sampler2D tSceneColor;
uniform sampler2D tSceneDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uRain;
uniform vec3 uWind;
varying vec3 vWorld;
varying vec4 vReflCoord;
varying vec3 vWaveN;

vec3 waveNormal(vec2 xz, float dist){
  // 細かい波紋（風で速く）
  float t = uTime;
  vec2 wd = normalize(uWind.xy + vec2(0.001, 0.0));
  float sp = 0.4 + uWind.z * 0.12;
  float e = 0.08;
  vec2 p1 = xz * 0.9 + wd * t * sp;
  vec2 p2 = xz * 2.3 - wd.yx * t * sp * 0.7 + 13.0;
  float n0 = flip_gnoise(p1) * 0.6 + flip_gnoise(p2) * 0.4;
  float nx = flip_gnoise(p1 + vec2(e, 0.0)) * 0.6 + flip_gnoise(p2 + vec2(e, 0.0) * 2.3) * 0.4;
  float nz = flip_gnoise(p1 + vec2(0.0, e)) * 0.6 + flip_gnoise(p2 + vec2(0.0, e) * 2.3) * 0.4;
  float amp = 0.05 * (0.3 + clamp(uWind.z / 8.0, 0.0, 1.5));
  amp *= 1.0 - smoothstep(60.0, 700.0, dist) * 0.8;
  vec3 n = normalize(vec3((n0 - nx) / e * amp, 1.0, (n0 - nz) / e * amp));
  return normalize(vWaveN * 0.5 + n);
}

float linearDepth(float z){
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

void main(){
  vec3 V = normalize(uCamPos - vWorld);
  float dist = distance(uCamPos, vWorld);
  vec3 N = waveNormal(vWorld.xz, dist);
  vec2 screenUv = gl_FragCoord.xy / uResolution;

  // 水深（コピーした線形深度 − この画素の線形深度）
  float sceneLin = texture2D(tSceneDepth, screenUv).r;
  float fragLin = linearDepth(gl_FragCoord.z);
  float depthDiff = max(sceneLin - fragLin, 0.0);
  // 視線方向の距離差 → 垂直方向の水深に近づける
  float waterDepth = depthDiff * max(V.y, 0.08);

  // 屈折
  float distortAmt = clamp(waterDepth * 0.5, 0.0, 1.0) * 0.02;
  vec2 rUv = screenUv + N.xz * distortAmt;
  float rLin = texture2D(tSceneDepth, rUv).r;
  if (rLin < fragLin) rUv = screenUv; // 水面より手前の物が滲まないように
  vec3 refr = texture2D(tSceneColor, rUv).rgb;
  vec3 absorb = vec3(0.35, 0.12, 0.06);
  vec3 deepCol = vec3(0.012, 0.045, 0.06) * (uSkyAmbient_dummy());
  vec3 water = mix(refr * exp(-absorb * waterDepth * 1.2), deepCol, 1.0 - exp(-waterDepth * 0.12));

  // 反射
  vec3 rc = vReflCoord.xyz / vReflCoord.w;
  vec2 reflUv = rc.xy + N.xz * 0.06 * (1.0 - smoothstep(0.0, 400.0, dist));
  vec3 refl = texture2D(tReflection, clamp(reflUv, 0.001, 0.999)).rgb;

  // フレネル
  float NdotV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  F = mix(F, 1.0, 0.0);
  vec3 col = mix(water, refl, F);

  // 太陽のハイライト
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 900.0) * 3.0 + pow(max(dot(N, H), 0.0), 60.0) * 0.06;
  col += uSunColor * spec * step(0.0, uSunDir.y);
  // 月
  vec3 Hm = normalize(V + uMoonDir);
  col += uMoonColor * pow(max(dot(N, Hm), 0.0), 600.0) * 30.0;

  // 岸の泡
  float foam = (1.0 - smoothstep(0.0, 0.7, waterDepth)) * (0.5 + 0.5 * flip_gnoise(vWorld.xz * 3.0 + uTime * 0.3));
  col = mix(col, vec3(0.8), foam * 0.35 * (0.3 + 0.7 * max(uSunDir.y, 0.05)));

  col = flip_applyAerial(col, vWorld);

  // 裏返し: 水面は波の関数を等高線で
  float fm = flip_mask(vWorld);
  if (fm > 0.0) {
    vec3 fc = FLIP_BG * 1.5;
    float ring = flip_line((vWorld.y - 0.0) * 12.0 + N.x * 4.0, 0.05);
    fc += FLIP_LINE * 0.6 * ring + FLIP_LINE * 0.12 * flip_grid(vWorld.xz, 5.0);
    fc += FLIP_ACCENT * flip_edgeGlow(vWorld) * 1.5;
    col = mix(col, fc, fm);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Water {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  reflRT: THREE.WebGLRenderTarget;
  private reflCamera = new THREE.PerspectiveCamera();
  private textureMatrix = new THREE.Matrix4();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private tmp = {
    reflectorPlane: new THREE.Plane(),
    normal: new THREE.Vector3(),
    reflectorWorldPosition: new THREE.Vector3(),
    cameraWorldPosition: new THREE.Vector3(),
    rotationMatrix: new THREE.Matrix4(),
    lookAtPosition: new THREE.Vector3(0, 0, -1),
    clipPlane: new THREE.Vector4(),
    view: new THREE.Vector3(),
    target: new THREE.Vector3(),
    q: new THREE.Vector4(),
  };

  constructor(public scene: THREE.Scene, public env: Env, public q: QualitySettings) {
    const size = 2600;
    const geo = new THREE.PlaneGeometry(size, size, 220, 220);
    geo.rotateX(-Math.PI / 2);
    const uniforms: Record<string, THREE.IUniform> = {
      tReflection: { value: null },
      tSceneColor: { value: null },
      tSceneDepth: { value: null },
      uReflMatrix: { value: this.textureMatrix },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 9000 },
    };
    bindEnvUniforms(uniforms, env);
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG.replace(
        "#include <flip_flip>",
        "#include <flip_flip>\nuniform vec3 uSkyAmbient;\nvec3 uSkyAmbient_dummy(){ return vec3(1.0) + uSkyAmbient * 0.0; }",
      ),
      transparent: false,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = WORLD.lakeLevel;
    this.mesh.layers.set(LAYER.WATER);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.reflRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    uniforms.tReflection.value = this.reflRT.texture;
  }

  resize(width: number, height: number) {
    const s = this.q.reflectionScale;
    this.reflRT.setSize(Math.max(1, Math.floor(width * s)), Math.max(1, Math.floor(height * s)));
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  /** 鏡像カメラでシーンを映り込み用 RT に描く（水面は描かない・草などは省く）。 */
  renderReflection(pipeline: Pipeline, camera: THREE.PerspectiveCamera) {
    const t = this.tmp;
    const renderer = pipeline.renderer;
    // three.js の Reflector と同じ手順
    t.reflectorWorldPosition.set(0, WORLD.lakeLevel, 0);
    t.cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    if (t.cameraWorldPosition.y < WORLD.lakeLevel) return;
    t.rotationMatrix.identity();
    t.normal.set(0, 1, 0);
    t.view.subVectors(t.reflectorWorldPosition, t.cameraWorldPosition);
    t.view.reflect(t.normal).negate();
    t.view.add(t.reflectorWorldPosition);
    t.rotationMatrix.extractRotation(camera.matrixWorld);
    t.lookAtPosition.set(0, 0, -1);
    t.lookAtPosition.applyMatrix4(t.rotationMatrix);
    t.lookAtPosition.add(t.cameraWorldPosition);
    t.target.subVectors(t.reflectorWorldPosition, t.lookAtPosition);
    t.target.reflect(t.normal).negate();
    t.target.add(t.reflectorWorldPosition);
    const rc = this.reflCamera;
    rc.position.copy(t.view);
    rc.up.set(0, 1, 0);
    rc.up.reflect(t.normal);
    rc.lookAt(t.target);
    rc.far = camera.far;
    rc.near = camera.near;
    rc.fov = camera.fov;
    rc.aspect = camera.aspect;
    rc.updateProjectionMatrix();
    rc.updateMatrixWorld();
    // テクスチャ行列
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(rc.projectionMatrix);
    this.textureMatrix.multiply(rc.matrixWorldInverse);
    // 斜めニアクリップ（水面より下を映さない）
    t.reflectorPlane.setFromNormalAndCoplanarPoint(t.normal, t.reflectorWorldPosition);
    t.reflectorPlane.applyMatrix4(rc.matrixWorldInverse);
    t.clipPlane.set(t.reflectorPlane.normal.x, t.reflectorPlane.normal.y, t.reflectorPlane.normal.z, t.reflectorPlane.constant);
    const projectionMatrix = rc.projectionMatrix;
    t.q.x = (Math.sign(t.clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    t.q.y = (Math.sign(t.clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    t.q.z = -1.0;
    t.q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
    t.clipPlane.multiplyScalar(2.0 / t.clipPlane.dot(t.q));
    projectionMatrix.elements[2] = t.clipPlane.x;
    projectionMatrix.elements[6] = t.clipPlane.y;
    projectionMatrix.elements[10] = t.clipPlane.z + 1.0 - 0.0001;
    projectionMatrix.elements[14] = t.clipPlane.w;

    rc.layers.set(LAYER.OPAQUE);
    rc.layers.enable(LAYER.SKY);
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.reflRT);
    renderer.clear(true, true, false);
    renderer.render(this.scene, rc);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(null);
  }

  update(pipeline: Pipeline, camera: THREE.PerspectiveCamera) {
    const u = this.material.uniforms;
    u.tSceneColor.value = pipeline.copyRT.texture;
    u.tSceneDepth.value = pipeline.copyDepthRT.texture;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    // 水面はカメラの xz に追従（無限に見せる）
    const cam = this.env.cameraPos;
    this.mesh.position.set(Math.round(cam.x / 20) * 20, WORLD.lakeLevel, Math.round(cam.z / 20) * 20);
  }
}
