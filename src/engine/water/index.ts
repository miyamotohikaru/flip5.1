// 湖。
//   波     … wavesim.ts（FFT、2 カスケード）＋ 風の斑 ＋ 浅瀬の波 ＋ 雨の波紋
//   水面   … shaders.ts（屈折・水深・コースティクス・映り込み・GGX のギラつき・泡・裏返し）
//   岸     … shore.ts（濡れた砂の帯を画面空間のデカールで）
//   映り込み … 平面鏡（reflRT、ミップ付き。粗さでぼかす）。水中では「水面より上の世界」を広角で撮り直し、スネルの窓に使う
// メッシュはカメラ中心の極座標格子（近くは細かく、遠くは粗く。段差のない 1 枚）。
import * as THREE from "three";
import type { Env } from "../core/env";
import { LAYER, type Pipeline } from "../core/pipeline";
import { bindEnvUniforms } from "../core/patch";
import type { QualitySettings } from "../core/quality";
import { WORLD } from "../core/heightfield";
import { WaveSim } from "./wavesim";
import { WATER_VERT, WATER_FRAG } from "./shaders";
import { ShoreDecal } from "./shore";
import { GpuTimer } from "./gputimer";

/** カメラ中心の極座標格子。半径は等比で増える（近くほど細かい） */
function buildPolarGrid(nr: number, nt: number, rMin: number, rMax: number): THREE.BufferGeometry {
  const ratio = Math.pow(rMax / rMin, 1 / (nr - 1));
  const count = 1 + nr * nt;
  const pos = new Float32Array(count * 3);
  let k = 3;
  for (let i = 0; i < nr; i++) {
    const r = rMin * Math.pow(ratio, i);
    for (let j = 0; j < nt; j++) {
      const a = (j / nt) * Math.PI * 2;
      pos[k++] = Math.cos(a) * r;
      pos[k++] = 0;
      pos[k++] = Math.sin(a) * r;
    }
  }
  const idx: number[] = [];
  const ring = (i: number, j: number) => 1 + i * nt + (j % nt);
  for (let j = 0; j < nt; j++) idx.push(0, ring(0, j + 1), ring(0, j));
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < nt; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      idx.push(a, d, c, a, b, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax);
  return geo;
}

export class Water {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  reflRT: THREE.WebGLRenderTarget;
  sim: WaveSim;
  shore: ShoreDecal;
  timer: GpuTimer | null = null;
  /** 濡れた砂のデカールを使うか（地形側が岸の濡れを持ったら false に） */
  shoreDecalEnabled = true;
  /** 調査用: ?dbg=nowater で水を全部止める（負荷の差分を測る） */
  private disabled = typeof location !== "undefined" && /[?&]dbg=[^&]*nowater/.test(location.search);
  private reflCamera = new THREE.PerspectiveCamera();
  private textureMatrix = new THREE.Matrix4();
  private lastTime = -1;
  private camFwd = new THREE.Vector3();
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
    const tier = q.tier;
    const heavy = tier === "high" || tier === "ultra";
    const N = heavy ? 256 : 128;
    const L0 = heavy ? 64 : 48;
    const L1 = 7.3;
    const kSplit = (2 * Math.PI) / 1.25;
    this.sim = new WaveSim(N, [
      { size: L0, kLo: 0, kHi: kSplit },
      { size: L1, kLo: kSplit, kHi: 1e9 },
    ], true, 8);

    const nr = heavy ? 380 : 240, nt = heavy ? 256 : 160;
    const geo = buildPolarGrid(nr, nt, 0.35, 3000);
    const uniforms: Record<string, THREE.IUniform> = {
      tReflection: { value: null },
      tSceneColor: { value: null },
      tSceneDepth: { value: null },
      tDeriv0: { value: null },
      tDeriv1: { value: null },
      tDisp: { value: null },
      uReflMatrix: { value: this.textureMatrix },
      uViewProj: { value: new THREE.Matrix4() },
      uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uReflSize: { value: new THREE.Vector2(1, 1) },
      uTiles: { value: new THREE.Vector4(L0, L1, N, 2) },
      uWaveAmp: { value: new THREE.Vector4(1, 1, 1, 0.05) },
      uWaterA: { value: new THREE.Vector4(0, 5, 0, 1) },   // x: 映り込み RT が有効か（最初の描画までは解析的な空で代用）
      uWaterB: { value: new THREE.Vector4(0, 0.7, heavy ? 3 : 2, 1) },
      uExtinction: { value: new THREE.Vector3(0.42, 0.13, 0.085) },
      uDebug: { value: typeof location !== "undefined" ? Number((/[?&]wdbg=(\d+)/.exec(location.search) ?? [0, 0])[1]) : 0 },
      uScatterColor: { value: new THREE.Vector3(0.022, 0.115, 0.14) },
    };
    bindEnvUniforms(uniforms, env);
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: false,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = WORLD.lakeLevel;
    this.mesh.layers.set(LAYER.WATER);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    scene.add(this.mesh);

    this.reflRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    uniforms.tReflection.value = this.reflRT.texture;
    this.shore = new ShoreDecal(scene, env);

    const wantTimer = typeof location !== "undefined" && /[?&]wtime=1/.test(location.search);
    if (wantTimer) {
      this.mesh.onBeforeRender = () => this.timer?.begin("water");
      this.mesh.onAfterRender = () => this.timer?.end();
      this.shore.mesh.onBeforeRender = () => this.timer?.begin("shore");
      this.shore.mesh.onAfterRender = () => this.timer?.end();
    }
  }

  resize(width: number, height: number) {
    const s = this.q.reflectionScale;
    const rw = Math.max(1, Math.floor(width * s)), rh = Math.max(1, Math.floor(height * s));
    this.reflRT.setSize(rw, rh);
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
    (this.material.uniforms.uReflSize.value as THREE.Vector2).set(rw, rh);
  }

  /** 斜めニアクリップ。plane は視点座標系で、plane の表側だけを描く */
  private applyObliqueClip(cam: THREE.PerspectiveCamera, normalWorld: THREE.Vector3, pointWorld: THREE.Vector3) {
    const t = this.tmp;
    t.reflectorPlane.setFromNormalAndCoplanarPoint(normalWorld, pointWorld);
    t.reflectorPlane.applyMatrix4(cam.matrixWorldInverse);
    t.clipPlane.set(t.reflectorPlane.normal.x, t.reflectorPlane.normal.y, t.reflectorPlane.normal.z, t.reflectorPlane.constant);
    const p = cam.projectionMatrix;
    t.q.x = (Math.sign(t.clipPlane.x) + p.elements[8]) / p.elements[0];
    t.q.y = (Math.sign(t.clipPlane.y) + p.elements[9]) / p.elements[5];
    t.q.z = -1.0;
    t.q.w = (1.0 + p.elements[10]) / p.elements[14];
    t.clipPlane.multiplyScalar(2.0 / t.clipPlane.dot(t.q));
    p.elements[2] = t.clipPlane.x;
    p.elements[6] = t.clipPlane.y;
    p.elements[10] = t.clipPlane.z + 1.0 - 0.0001;
    p.elements[14] = t.clipPlane.w;
  }

  /**
   * 映り込み用 RT を描く。水上: 鏡像カメラで OPAQUE+SKY（水面と MAIN_ONLY は描かない）。
   * 水中: 同じカメラ位置から広角で「水面より上」だけを描き、スネルの窓の屈折先に使う。
   */
  renderReflection(pipeline: Pipeline, camera: THREE.PerspectiveCamera) {
    if (this.disabled) return;
    const t = this.tmp;
    const renderer = pipeline.renderer;
    const rc = this.reflCamera;
    t.reflectorWorldPosition.set(0, WORLD.lakeLevel, 0);
    t.cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    t.normal.set(0, 1, 0);
    const under = this.env.underwater > 0.5;
    if (!under) {
      t.rotationMatrix.identity();
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
      rc.position.copy(t.view);
      rc.up.set(0, 1, 0);
      rc.up.reflect(t.normal);
      rc.lookAt(t.target);
      rc.fov = camera.fov;
    } else {
      rc.position.copy(t.cameraWorldPosition);
      rc.up.set(0, 1, 0);
      rc.quaternion.copy(camera.quaternion);
      rc.fov = Math.min(camera.fov * 1.7, 150);
    }
    rc.far = camera.far;
    rc.near = camera.near;
    rc.aspect = camera.aspect;
    rc.updateProjectionMatrix();
    rc.updateMatrixWorld();
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(rc.projectionMatrix);
    this.textureMatrix.multiply(rc.matrixWorldInverse);
    // 水面より下は映さない（水中モードでも「上だけ」）
    this.applyObliqueClip(rc, t.normal, t.reflectorWorldPosition);

    rc.layers.set(LAYER.OPAQUE);
    rc.layers.enable(LAYER.SKY);
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.timer?.begin("reflection");
    renderer.setRenderTarget(this.reflRT);
    renderer.clear(true, true, false);
    renderer.render(this.scene, rc);
    this.timer?.end();
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(null);
    (this.material.uniforms.uWaterA.value as THREE.Vector4).x = 1;
  }

  update(pipeline: Pipeline, camera: THREE.PerspectiveCamera) {
    const env = this.env;
    const w = env.weather;
    if (!this.timer) {
      const wantTimer = typeof location !== "undefined" && /[?&]wtime=1/.test(location.search);
      this.timer = new GpuTimer(pipeline.renderer, wantTimer);
    }
    this.timer.poll();
    if (this.disabled) {
      this.mesh.visible = false;
      this.shore.mesh.visible = false;
      return;
    }

    // 水中かどうか（他モジュールが読む）
    const cam = env.cameraPos;
    env.underwater = THREE.MathUtils.clamp((WORLD.lakeLevel - cam.y) / 0.12, 0, 1);
    const under = env.underwater > 0.5;

    // 波
    this.sim.setWind(w.windDir, w.wind, w.storm);
    const dt = this.lastTime < 0 ? 0 : Math.max(env.time - this.lastTime, 0);
    this.lastTime = env.time;
    this.timer.begin("sim");
    this.sim.update(pipeline, env.time, dt);
    this.timer.end();

    const u = this.material.uniforms;
    u.tSceneColor.value = pipeline.copyRT.texture;
    u.tSceneDepth.value = pipeline.copyDepthRT.texture;
    u.tDeriv0.value = this.sim.derivTexture(0);
    u.tDeriv1.value = this.sim.derivTexture(1);
    u.tDisp.value = this.sim.dispRT.texture;
    const p = this.sim.params;
    (u.uWaveAmp.value as THREE.Vector4).set(1, 1, p.chop, p.hs);
    const A = u.uWaterA.value as THREE.Vector4;
    A.z = p.foamAmount;
    A.w = 1.0;
    A.y = 5;
    const B = u.uWaterB.value as THREE.Vector4;
    B.x = under ? 1 : 0;
    B.y = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    B.w = p.lambdaP;
    // 嵐は濁って暗い
    const storm = w.storm;
    (u.uExtinction.value as THREE.Vector3).set(0.42, 0.13, 0.085).multiplyScalar(1 + 0.8 * storm + 0.3 * w.rain);
    (u.uScatterColor.value as THREE.Vector3).set(0.022, 0.115, 0.14).lerp(new THREE.Vector3(0.03, 0.055, 0.055), storm * 0.7);

    camera.getWorldDirection(this.camFwd);
    (u.uCamFwd.value as THREE.Vector3).copy(this.camFwd);
    (u.uViewProj.value as THREE.Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // 水面はカメラの真下を中心に（極座標メッシュ）
    this.mesh.position.set(cam.x, WORLD.lakeLevel, cam.z);
    // 岸のデカール: 湖の近くにいるときだけ
    const nearLake = Math.hypot(cam.x, cam.z) < WORLD.lakeRadius + 500 && Math.abs(cam.y - WORLD.lakeLevel) < 120;
    this.shore.update(pipeline, this.camFwd, this.shoreDecalEnabled && nearLake && !under);
  }

  dispose() {
    this.sim.dispose();
    this.reflRT.dispose();
  }
}
