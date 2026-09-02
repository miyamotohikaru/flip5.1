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
    this.lifecycle = new Lifecycle(world, () => this.perf.reset());
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
