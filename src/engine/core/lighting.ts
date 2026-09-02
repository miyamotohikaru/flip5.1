// 太陽（CSM のカスケード影）・半球光・月光。env を毎フレーム反映する。
import * as THREE from "three";
import { CSM } from "three/examples/jsm/csm/CSM.js";
import type { Env } from "./env";
import type { QualitySettings } from "./quality";
import { LAYER } from "./pipeline";

export class Lighting {
  csm: CSM;
  hemi: THREE.HemisphereLight;
  moon: THREE.DirectionalLight;
  private tmp = new THREE.Vector3();

  constructor(public scene: THREE.Scene, public env: Env, q: QualitySettings) {
    this.csm = new CSM({
      maxFar: q.shadowMaxFar,
      cascades: q.shadowCascades,
      mode: "practical",
      parent: scene,
      shadowMapSize: q.shadowMapSize,
      lightDirection: new THREE.Vector3(-0.3, -1, -0.2).normalize(),
      lightIntensity: 3,
      camera: env.camera,
      shadowBias: -0.00015,
      lightMargin: 250,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) {
      l.shadow.normalBias = 0.05;
      l.shadow.camera.layers.enable(LAYER.MAIN_ONLY);
      l.shadow.camera.layers.enable(LAYER.TRANSPARENT);
      l.castShadow = true;
    }
    this.hemi = new THREE.HemisphereLight(0x8fb4e6, 0x4a3a2a, 0.6);
    scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x9fb2ff, 0);
    scene.add(this.moon);
    scene.add(this.moon.target);
  }

  update() {
    const env = this.env;
    const sunUp = env.sunDir.y > -0.02;
    this.csm.lightDirection.copy(env.sunDir).multiplyScalar(-1).normalize();
    for (const l of this.csm.lights) {
      l.intensity = sunUp ? env.sunIntensity : 0;
      l.color.copy(env.sunColor);
    }
    this.csm.update();
    this.hemi.color.copy(env.skyAmbient);
    this.hemi.groundColor.copy(env.groundAmbient);
    this.hemi.intensity = 1.0;
    this.moon.position.copy(this.tmp.copy(env.moonDir).multiplyScalar(500)).add(env.cameraPos);
    this.moon.target.position.copy(env.cameraPos);
    this.moon.intensity = env.moonIntensity * 4;
    this.moon.color.copy(env.moonColor).multiplyScalar(1 / Math.max(env.moonIntensity, 1e-3)).multiplyScalar(env.moonIntensity > 0 ? 1 : 0);
  }

  resize() {
    this.csm.updateFrustums();
  }
}
