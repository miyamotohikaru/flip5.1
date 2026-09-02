// 世界の組み立てと毎フレームの手順。UI（React）からはこの World だけを触る。
import * as THREE from "three";
import { Env, type WeatherPresetName } from "./core/env";
import { registerChunks } from "./core/chunks";
import { bakeHeightmap, heightAt, startPosition } from "./core/heightfield";
import { detectTier, isMobileDevice, QUALITY, type QualitySettings } from "./core/quality";
import { parseParams, type Params } from "./core/params";
import { Pipeline } from "./core/pipeline";
import { Lighting } from "./core/lighting";
import { Sky } from "./sky";
import { Terrain } from "./terrain";
import { Water } from "./water";
import { Vegetation } from "./vegetation";
import { Weather } from "./weather";
import { Post } from "./post";
import { Audio } from "./audio";
import { Controls } from "./controls";

export type WorldEvent = "ready" | "progress" | "frame" | "enter" | "exit" | "flip";
type Listener = (payload?: unknown) => void;

export type Stats = { fps: number; frameMs: number; tier: string; drawCalls: number; triangles: number; width: number; height: number };

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  env = new Env();
  q: QualitySettings;
  params: Params;
  pipeline!: Pipeline;
  lighting!: Lighting;
  sky!: Sky;
  terrain!: Terrain;
  water!: Water;
  vegetation!: Vegetation;
  weather!: Weather;
  post!: Post;
  audio: Audio;
  controls!: Controls;
  ready = false;
  running = false;
  private listeners = new Map<WorldEvent, Set<Listener>>();
  private lastT = 0;
  private raf = 0;
  private frameTimes: number[] = [];
  stats: Stats = { fps: 0, frameMs: 0, tier: "high", drawCalls: 0, triangles: 0, width: 0, height: 0 };

  constructor(public canvas: HTMLCanvasElement) {
    registerChunks();
    this.params = parseParams(typeof location !== "undefined" ? location.search : "");
    this.env.isMobile = isMobileDevice();
    const tier = this.params.tier ?? detectTier();
    this.env.tier = tier;
    this.q = QUALITY[tier];
    this.stats.tier = tier;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.autoClear = true;
    this.audio = new Audio(this.env);
    if (this.params.freeze) this.env.freeze = true;
    if (this.params.hour !== undefined) this.env.hour = this.params.hour;
    if (this.params.weather) {
      this.env.setWeather(this.params.weather);
      this.env.weather = { ...this.env.weather, ...this.env.weatherTarget };
    }
    if (this.params.flip !== undefined) {
      this.env.flipTarget = this.params.flip;
      this.env.flip = this.params.flip;
    }
  }

  on(ev: WorldEvent, fn: Listener) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
    return () => this.listeners.get(ev)?.delete(fn);
  }
  private emit(ev: WorldEvent, payload?: unknown) {
    this.listeners.get(ev)?.forEach((fn) => fn(payload));
  }

  /** 生成（ハイトマップの焼き込みなど）。進み具合を progress で知らせる */
  async build() {
    const env = this.env;
    this.emit("progress", { step: "地形の数式を計算しています", p: 0 });
    await new Promise((r) => setTimeout(r, 30));
    const hm = bakeHeightmap(this.q.heightmapRes);
    env.heightmap = hm;
    env.uniforms.uHeightmap.value = hm.texture;
    env.uniforms.uHeightmapInfo.value.set(4096, 1 / 4096, hm.res, 800);
    this.emit("progress", { step: "光と空気を用意しています", p: 0.5 });
    await new Promise((r) => setTimeout(r, 10));

    this.pipeline = new Pipeline(this.renderer, this.scene, this.q);
    this.lighting = new Lighting(this.scene, env, this.q);
    this.sky = new Sky(this.scene, env, this.q);
    this.terrain = new Terrain(this.scene, env, this.lighting, this.q);
    this.water = new Water(this.scene, env, this.q);
    this.vegetation = new Vegetation(this.scene, env, this.lighting, this.q);
    this.weather = new Weather(this.scene, env, this.lighting, this.q);
    this.post = new Post(env, this.q);
    this.controls = new Controls(env, this.canvas, this.audio);

    const start = startPosition();
    const p = this.params;
    if (p.pos) this.controls.setPose(p.pos[0], p.pos[1], p.pos[2], p.look?.[0] ?? 0, p.look?.[1] ?? 0);
    else this.controls.setPose(start.x, start.z, undefined, start.yaw, 3);
    if (p.flipRadius !== undefined) env.flipRadius = p.flipRadius;
    env.flipCenter.copy(this.controls.position);

    this.emit("progress", { step: "描画を始めます", p: 0.9 });
    this.resize();
    window.addEventListener("resize", this.resize);
    // シェーダのコンパイルを先に済ませる
    this.renderer.compile(this.scene, env.camera);
    this.ready = true;
    this.emit("ready");
    this.start();
    if (p.auto) this.enter(false);
  }

  resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.q.maxPixelRatio) * this.q.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const pw = Math.floor(w * pr), ph = Math.floor(h * pr);
    this.env.camera.aspect = w / h;
    this.env.camera.updateProjectionMatrix();
    this.pipeline.resize(pw, ph);
    this.water.resize(pw, ph);
    this.post.resize(pw, ph);
    this.lighting.resize();
    this.stats.width = pw;
    this.stats.height = ph;
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** 入場（ユーザー操作の中で呼ぶ）。 */
  enter(withPointerLock = true) {
    this.audio.start();
    if (withPointerLock) this.controls.enter();
    else this.controls.enabled = true;
    this.emit("enter");
  }

  exit() {
    this.controls.exit();
    this.emit("exit");
  }

  toggleFlip() {
    const env = this.env;
    env.flipTarget = env.flipTarget > 0.5 ? 0 : 1;
    if (env.flipTarget > 0.5) env.flipCenter.copy(this.controls.position);
    this.audio.flipWave(env.flipTarget > 0.5);
    this.emit("flip", env.flipTarget);
  }

  setHour(h: number) {
    this.env.hour = ((h % 24) + 24) % 24;
  }
  setWeather(w: WeatherPresetName) {
    this.env.setWeather(w);
  }

  /** 写真: 現在の画面をそのまま PNG に */
  async takePhoto(): Promise<Blob | null> {
    this.frame();
    this.audio.shutter();
    return new Promise((resolve) => this.canvas.toBlob((b) => resolve(b), "image/png"));
  }

  frame() {
    const t0 = performance.now();
    const dt = Math.min((t0 - this.lastT) / 1000, 0.1);
    this.lastT = t0;
    const env = this.env;
    const cam = env.camera;
    this.controls.update(dt);
    env.cameraPos.copy(cam.position);
    env.update(dt);
    this.sky.update(dt); // 太陽の色・露出・半球光を上書きしてよい
    env.syncUniforms();
    this.lighting.update();
    this.terrain.update();
    this.vegetation.update(dt);
    this.weather.update(dt);
    this.audio.update(dt);
    this.water.update(this.pipeline, cam);

    const r = this.renderer;
    r.info.reset();
    const dbg = this.params.dbg;
    this.pipeline.renderOpaque(cam);
    if (!dbg.includes("noref")) this.water.renderReflection(this.pipeline, cam);
    if (!dbg.includes("nocopy")) this.pipeline.copyScene(cam);
    if (!dbg.includes("notrans")) this.pipeline.renderTransparent(cam);
    if (!dbg.includes("nopost")) this.post.render(this.pipeline, null);
    r.setRenderTarget(null);

    const ms = performance.now() - t0;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.stats.frameMs = avg;
    this.stats.fps = dt > 0 ? 1 / dt : 0;
    this.stats.drawCalls = r.info.render.calls;
    this.stats.triangles = r.info.render.triangles;
    this.emit("frame", this.stats);
  }

  groundHeight(x: number, z: number) {
    return heightAt(x, z);
  }

  dispose() {
    this.stop();
    window.removeEventListener("resize", this.resize);
    this.controls.dispose();
    this.pipeline.dispose();
    this.renderer.dispose();
  }
}

declare global {
  interface Window {
    __flip?: World;
  }
}
