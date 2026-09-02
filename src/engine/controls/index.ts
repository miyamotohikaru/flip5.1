// 一人称の操作。PointerLock（WASD/矢印＋マウス）とタッチ（左：移動スティック、右：ドラッグで見回し）。
// 地面の高さ（heightAt）に沿って歩く。操作担当が 端末別の負荷調整（動的解像度）・スプリント・慣性・
// 段差の当たり・水際の減速・バイブレーション・ゲームパッド などを作り込む。
import * as THREE from "three";
import type { Env } from "../core/env";
import { heightAt, WORLD } from "../core/heightfield";
import type { Audio } from "../audio";

export type Surface = "grass" | "rock" | "sand" | "water";

export class Controls {
  yaw = 0;
  pitch = 0;
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  eyeHeight = 1.68;
  speed = 3.4;
  sprint = 6.5;
  locked = false;
  enabled = false;
  touchActive = false;
  /** 歩行の位相（足音・頭の揺れ） */
  bobPhase = 0;
  bobAmount = 0;
  private keys = new Set<string>();
  private moveStick = new THREE.Vector2();
  private lookDelta = new THREE.Vector2();
  private touches = new Map<number, { x: number; y: number; sx: number; sy: number; role: "move" | "look" }>();
  private lastStep = 0;
  onStep?: (surface: Surface) => void;
  private dom: HTMLElement;

  constructor(public env: Env, public canvas: HTMLCanvasElement, public audio: Audio) {
    this.dom = canvas;
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.lookDelta.x += e.movementX;
      this.lookDelta.y += e.movementY;
    });
    canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", this.onTouchMove, { passive: false });
    canvas.addEventListener("touchend", this.onTouchEnd, { passive: false });
    canvas.addEventListener("touchcancel", this.onTouchEnd, { passive: false });
  }

  setPose(x: number, z: number, y: number | undefined, yawDeg: number, pitchDeg: number) {
    this.position.set(x, y ?? heightAt(x, z) + this.eyeHeight, z);
    this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.degToRad(pitchDeg);
    this.apply();
  }

  /** 入場。パソコンは PointerLock を要求（ユーザー操作の中で呼ぶこと） */
  enter() {
    this.enabled = true;
    if (!this.env.isMobile) {
      try {
        const p = this.canvas.requestPointerLock({ unadjustedMovement: true } as unknown as PointerLockOptions) as unknown;
        if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => this.canvas.requestPointerLock());
      } catch {
        this.canvas.requestPointerLock();
      }
    }
  }

  exit() {
    if (this.locked) document.exitPointerLock();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.type === "keydown") this.keys.add(e.code);
    else this.keys.delete(e.code);
  };

  private onTouchStart = (e: TouchEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.touchActive = true;
    for (const t of Array.from(e.changedTouches)) {
      const role = t.clientX < window.innerWidth * 0.45 ? "move" : "look";
      this.touches.set(t.identifier, { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, role });
    }
  };
  private onTouchMove = (e: TouchEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const s = this.touches.get(t.identifier);
      if (!s) continue;
      if (s.role === "look") {
        this.lookDelta.x += (t.clientX - s.x) * 2.2;
        this.lookDelta.y += (t.clientY - s.y) * 2.2;
      }
      s.x = t.clientX;
      s.y = t.clientY;
    }
  };
  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) this.touches.delete(t.identifier);
  };

  get moveInput(): THREE.Vector2 {
    const v = this.moveStick.set(0, 0);
    const k = this.keys;
    if (k.has("KeyW") || k.has("ArrowUp")) v.y += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) v.y -= 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) v.x -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) v.x += 1;
    for (const s of this.touches.values()) {
      if (s.role !== "move") continue;
      const dx = (s.x - s.sx) / 60, dy = -(s.y - s.sy) / 60;
      v.x += THREE.MathUtils.clamp(dx, -1, 1);
      v.y += THREE.MathUtils.clamp(dy, -1, 1);
    }
    if (v.lengthSq() > 1) v.normalize();
    return v;
  }

  get isSprinting() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  update(dt: number) {
    if (!this.enabled) {
      this.apply();
      return;
    }
    // 見回し
    const sens = 0.0022;
    this.yaw += this.lookDelta.x * sens;
    this.pitch -= this.lookDelta.y * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.45);
    this.lookDelta.set(0, 0);

    // 移動（yaw=0 で −Z を向く）
    const inp = this.moveInput;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const target = new THREE.Vector3().addScaledVector(fwd, inp.y).addScaledVector(right, inp.x);
    const spd = this.isSprinting ? this.sprint : this.speed;
    target.multiplyScalar(spd);
    const k = 1 - Math.exp(-dt * 9);
    this.velocity.x += (target.x - this.velocity.x) * k;
    this.velocity.z += (target.z - this.velocity.z) * k;
    let nx = this.position.x + this.velocity.x * dt;
    let nz = this.position.z + this.velocity.z * dt;
    // 歩ける範囲
    const r = Math.hypot(nx, nz);
    if (r > WORLD.walkRadius) {
      nx *= WORLD.walkRadius / r;
      nz *= WORLD.walkRadius / r;
    }
    // 急斜面は登れない
    const hNew = heightAt(nx, nz);
    const hOld = heightAt(this.position.x, this.position.z);
    const slope = (hNew - hOld) / Math.max(Math.hypot(nx - this.position.x, nz - this.position.z), 1e-4);
    if (slope > 1.1) {
      nx = this.position.x;
      nz = this.position.z;
    }
    this.position.x = nx;
    this.position.z = nz;
    // 水の中は水面下に沈みすぎない（浅瀬まで）
    const ground = Math.max(heightAt(nx, nz), WORLD.lakeLevel - 1.2);
    const targetY = ground + this.eyeHeight;
    this.position.y += (targetY - this.position.y) * (1 - Math.exp(-dt * 12));

    // 頭の揺れと足音
    const moving = this.velocity.length();
    const bobTarget = THREE.MathUtils.clamp(moving / this.speed, 0, 1.6);
    this.bobAmount += (bobTarget - this.bobAmount) * (1 - Math.exp(-dt * 6));
    const prevPhase = this.bobPhase;
    this.bobPhase += dt * (1.9 + moving * 0.55) * Math.PI * Math.min(this.bobAmount, 1) * 2;
    if (Math.floor(this.bobPhase / Math.PI) !== Math.floor(prevPhase / Math.PI) && this.bobAmount > 0.25) {
      const surface = this.surfaceAt(nx, nz);
      this.lastStep = this.env.time;
      this.onStep?.(surface);
      this.audio.footstep(surface);
    }
    this.apply();
  }

  surfaceAt(x: number, z: number): Surface {
    const h = heightAt(x, z);
    if (h < WORLD.lakeLevel + 0.05) return "water";
    if (h < WORLD.lakeLevel + 2.5) return "sand";
    const n = Math.abs(heightAt(x + 1, z) - h) + Math.abs(heightAt(x, z + 1) - h);
    return n > 0.5 ? "rock" : "grass";
  }

  private apply() {
    const cam = this.env.camera;
    const bob = Math.sin(this.bobPhase) * 0.035 * this.bobAmount;
    const sway = Math.sin(this.bobPhase * 0.5) * 0.012 * this.bobAmount;
    cam.position.set(this.position.x, this.position.y + bob, this.position.z);
    cam.rotation.set(0, 0, 0, "YXZ");
    cam.rotation.y = this.yaw;
    cam.rotation.x = this.pitch;
    cam.rotation.z = sway;
    cam.updateMatrixWorld();
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
  }
}
