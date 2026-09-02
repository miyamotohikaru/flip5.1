// 空。土台版: 解析的な空＋太陽の円盤＋星。空モジュール担当がここを物理ベース（大気散乱 LUT・体積雲）に置き換える。
// 契約:
//   - LAYER.SKY のフルスクリーン三角形として描く（深度 1.0、depthWrite なし）。映り込みカメラでも正しく描けること
//   - env.skyAmbient / env.groundAmbient を毎フレーム更新する（半球光の色）
//   - flip_atmosphere チャンク（空の色と空気遠近）はここが「本体」。overrideChunk で差し替えてよい
import * as THREE from "three";
import type { Env } from "../core/env";
import { LAYER } from "../core/pipeline";
import { bindEnvUniforms } from "../core/patch";
import { smoothstep } from "../core/noise";
import type { QualitySettings } from "../core/quality";

export class Sky {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private invProj = new THREE.Matrix4();

  constructor(public scene: THREE.Scene, public env: Env, public q: QualitySettings) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const uniforms: Record<string, THREE.IUniform> = {
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
    };
    bindEnvUniforms(uniforms, env);
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        uniform mat4 uInvProj; uniform mat4 uCamWorld;
        varying vec3 vDir;
        void main(){
          vec4 p = uInvProj * vec4(position.xy, 1.0, 1.0);
          vec3 viewDir = normalize(p.xyz / p.w);
          vDir = normalize((uCamWorld * vec4(viewDir, 0.0)).xyz);
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        #include <flip_noise>
        #include <flip_atmosphere>
        #include <flip_flip>
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          vec3 col = flip_skyColor(d);
          // 太陽の円盤
          float sunDot = dot(d, uSunDir);
          float disc = smoothstep(0.99955, 0.99975, sunDot);
          col += uSunColor * disc * 40.0 * step(0.0, uSunDir.y + 0.02);
          // 星（夜だけ）
          float night = smoothstep(0.02, -0.12, uSunDir.y);
          if (night > 0.0 && d.y > 0.0) {
            vec3 sd = d * 900.0;
            float h = flip_hash13(floor(sd));
            float star = smoothstep(0.985, 1.0, h) * pow(flip_hash13(floor(sd) + 3.1), 3.0);
            col += vec3(star) * 1.4 * night * smoothstep(0.0, 0.25, d.y);
          }
          // 月
          float moonDot = dot(d, uMoonDir);
          col += uMoonColor * 60.0 * smoothstep(0.9993, 0.9996, moonDot);
          // 簡易な雲（2D）。空担当が体積雲に置き換える
          if (d.y > 0.02) {
            vec2 cuv = d.xz / (d.y + 0.15) * 1.8 + uTime * 0.004 * uWindDummy();
            float cov = flip_fbm(cuv + vec2(uTime * 0.01), 5) * 0.5 + 0.5;
            float c = smoothstep(1.0 - uCloud * 0.9, 1.0 - uCloud * 0.9 + 0.35, cov);
            vec3 cloudCol = mix(vec3(0.95, 0.96, 1.0), vec3(0.35, 0.37, 0.42), uCloud * 0.6 + uStorm * 0.3) * (0.6 + 0.4 * max(uSunDir.y, 0.0));
            cloudCol *= 0.08 + 0.92 * smoothstep(-0.1, 0.2, uSunDir.y);
            col = mix(col, cloudCol, c * smoothstep(0.02, 0.15, d.y));
          }
          // 裏返し: 空は暗い紙に、太陽と天球の格子
          float fm = flip_mask(uCamPos + d * 5000.0);
          vec3 fcol = FLIP_BG * 2.0;
          float lat = flip_line(degrees(asin(clamp(d.y, -1.0, 1.0))) / 15.0, 0.03);
          float lon = flip_line(degrees(atan(d.z, d.x)) / 15.0, 0.03) * smoothstep(0.0, 0.2, 1.0 - abs(d.y));
          fcol += FLIP_LINE * 0.25 * max(lat, lon);
          fcol += FLIP_ACCENT * disc * 2.0;
          col = mix(col, fcol, fm);
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
    });
    // uWind は vec3 なので、ダミー関数で xy だけ使う
    this.material.fragmentShader = this.material.fragmentShader.replace(
      "#include <flip_flip>",
      "#include <flip_flip>\nuniform vec3 uWind;\nvec2 uWindDummy(){ return uWind.xy * uWind.z; }",
    );
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10000;
    this.mesh.layers.set(LAYER.SKY);
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      const cam = camera as THREE.PerspectiveCamera;
      this.invProj.copy(cam.projectionMatrix).invert();
      (this.material.uniforms.uInvProj.value as THREE.Matrix4).copy(this.invProj);
      (this.material.uniforms.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    };
    scene.add(this.mesh);
  }

  update() {
    // 半球光の色（GLSL の flip_skyColor と同じ考え方の CPU 近似）
    const env = this.env;
    const s = env.sunDir.y;
    const day = smoothstep(-0.08, 0.25, s);
    const zenith = new THREE.Color(0.004, 0.006, 0.014).lerp(new THREE.Color(0.12, 0.3, 0.72), day);
    const horizon = new THREE.Color(0.01, 0.014, 0.028).lerp(new THREE.Color(0.62, 0.74, 0.88), day);
    const grey = Math.min(0.9, env.weather.cloud * 0.7 + env.weather.storm * 0.6);
    const sky = zenith.lerp(horizon, 0.45);
    const lum = sky.r * 0.33 + sky.g * 0.33 + sky.b * 0.33;
    sky.lerp(new THREE.Color(lum * 0.9, lum * 0.95, lum), grey);
    env.skyAmbient.copy(sky).multiplyScalar(1.6);
    const ground = new THREE.Color(0.12, 0.1, 0.07).multiplyScalar(0.2 + 1.2 * day);
    env.groundAmbient.copy(ground);
  }
}
