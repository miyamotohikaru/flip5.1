// 堅牢性: WebGL コンテキストの喪失／復帰、タブが隠れたときの停止、向きの変更。
//   webglcontextlost     → 描画を止めて world.emit("contextlost")（UI は「復帰を待っています」を出せる）
//   webglcontextrestored → three.js が GL を作り直すので、RT のサイズを合わせて再開し world.emit("contextrestored")
//                          （それでも絵が戻らないときのために、UI は再読み込みの案内を出してよい）
//   visibilitychange     → 隠れたら rAF を止める（電池・熱）。戻ったら平均をやり直して再開
//   orientationchange    → 少し遅れて resize（古い iOS は resize が先に来ないことがある）
import type { World } from "../world";

export class Lifecycle {
  contextLost = false;
  private orientationTimer = 0;

  constructor(
    private world: World,
    private onResume?: () => void,
  ) {
    const canvas = world.canvas;
    canvas.addEventListener("webglcontextlost", this.onLost, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored, false);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("orientationchange", this.onOrientation);
  }

  private onLost = (e: Event) => {
    e.preventDefault(); // 復帰の機会を残す
    this.contextLost = true;
    this.world.stop();
    this.world.controls?.releaseAll();
    this.world.emit("contextlost");
  };

  private onRestored = () => {
    this.contextLost = false;
    const w = this.world;
    if (!w.ready) return;
    w.resize();
    this.onResume?.();
    if (!document.hidden) w.start();
    w.emit("contextrestored");
  };

  private onVisibility = () => {
    const w = this.world;
    if (document.hidden) {
      w.stop();
      w.controls?.releaseAll();
    } else if (w.ready && !this.contextLost) {
      this.onResume?.();
      w.start();
    }
  };

  private onOrientation = () => {
    clearTimeout(this.orientationTimer);
    this.orientationTimer = window.setTimeout(() => {
      if (this.world.ready) this.world.resize();
    }, 300);
  };

  dispose() {
    const canvas = this.world.canvas;
    canvas.removeEventListener("webglcontextlost", this.onLost, false);
    canvas.removeEventListener("webglcontextrestored", this.onRestored, false);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("orientationchange", this.onOrientation);
    clearTimeout(this.orientationTimer);
  }
}
