// World と操作・性能・堅牢性の配線をここに集める（world.ts の差分を小さく保つため）。
//   world.build() の最後で new Runtime(world)、world.frame() の最後で runtime.frame(t0, ms)、
//   world.dispose() で runtime.dispose()。
import type { World } from "../world";
import { detectDevice, type DeviceInfo } from "../core/quality";
import { PerformanceMonitor } from "./performance";
import { Lifecycle } from "./lifecycle";

export class Runtime {
  perf: PerformanceMonitor;
  lifecycle: Lifecycle;
  device: DeviceInfo;

  constructor(public world: World) {
    this.device = detectDevice(world.renderer.getContext());
    const fixedTier = world.params.tier !== undefined;
    this.perf = new PerformanceMonitor(
      world.q,
      world.env.tier,
      {
        setScale: (s) => {
          world.renderScale = s;
          world.resize();
        },
        onTier: (tier, reason) => world.emit("tier", { tier, reason }),
      },
      { calibrate: this.device.uncertain && !fixedTier, persist: !fixedTier },
    );
    // 定点撮影（時間停止）では解像度を動かさない（撮るたびに絵が変わらないように）
    if (world.params.freeze || world.params.shot) this.perf.active = false;
    // 復帰直後はシェーダの作り直しで重いので、コンテキスト復帰は 3 秒、タブ復帰は 1 秒待ってから判断する
    this.lifecycle = new Lifecycle(world, (reason) => this.perf.reset(performance.now(), reason === "restored" ? 3000 : 1000));
    const c = world.controls;
    c.onExit = () => world.emit("exit");
    c.onFlip = () => world.toggleFlip();
    c.onPhoto = () => world.emit("photo");
    c.onProjectionChange = () => world.lighting.resize();
  }

  /** 毎フレーム world.frame() の最後で呼ぶ（t0 = フレーム開始、cpuMs = CPU 側の所要時間） */
  frame(t0: number, cpuMs: number) {
    this.perf.frame(t0, cpuMs);
    const s = this.world.stats;
    s.fps = this.perf.fps;
    s.renderScale = this.perf.renderScale;
    s.tierNext = this.perf.tierNext;
  }

  dispose() {
    this.lifecycle.dispose();
  }
}
