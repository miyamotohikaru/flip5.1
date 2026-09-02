// 一人称の操作の本体。キーボード＋マウス（PointerLock）／タッチ（仮想スティック＋ドラッグ見回し）／
// ゲームパッド／ジャイロ を 1 つの「歩き」にまとめ、地形（heightAt）に沿って歩く。
//   手触り: 押して 0.15s で最高速、離して 0.25s で停止（直線的な加減速。指数関数の「ふわっ」を避ける）。
//   走り（Shift / RT / スティック倒し切り）で視野角が 6° 広がる。
//   頭の揺れ: 歩幅に合わせた上下（歩ごとに沈む）＋左右の 8 の字＋わずかなロール。走りで大きく、止まると滑らかに収束。
//   斜面: 登りは遅く（5°→35° で最大 60% 減）、35° を超えると登れず滑る。下りは少し速い。
//   水際: 湖面 +0.3m の濡れた砂から減速し、深さ 0.45m（足首〜すね）より深くは進めない。
//   マウス感度は DPI・画面倍率に依存しない（生のカウント × sensitivity）。視線のピッチは ±85°。
//   Esc などでポインタロックが外れたら onExit（world が "exit" を emit する）。
// UI が読むもの: stick（仮想スティックの中心・つまみ・押されているか）、lookTouch、sprinting、gyroEnabled、gamepadConnected。
import * as THREE from "three";
import type { Env } from "../core/env";
import { heightAt, WORLD } from "../core/heightfield";
import { clamp, smoothstep } from "../core/noise";
import type { Audio } from "../audio";
import { KeyboardMouse } from "./input";
import { TouchInput, type StickState, type LookTouchState } from "./touch";
import { GamepadInput } from "./gamepad";
import { Gyro } from "./gyro";

export type Surface = "grass" | "rock" | "sand" | "water";
export type { StickState, LookTouchState };

const DEG = Math.PI / 180;
const TAN35 = Math.tan(35 * DEG);
const PITCH_LIMIT = 85 * DEG;
/** これより深い水には入れない（m） */
const MAX_DEPTH = 0.45;
/** 斜面の勾配を測る幅（m） */
const GRAD_EPS = 0.6;

const wrapAngle = (a: number) => {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};

export class Controls {
  yaw = 0;
  pitch = 0;
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  eyeHeight = 1.68;
  /** 歩く速さ（m/s） */
  speed = 3.8;
  /** 走る速さ（m/s） */
  sprint = 6.6;
  /** 押してから最高速までの秒数／離してから止まるまでの秒数 */
  accelTime = 0.15;
  decelTime = 0.25;
  /** マウス感度（rad／カウント。0.06°）。画面倍率に依存しない。800dpi で 1 回転 ≈ 7.5 インチ */
  sensitivity = 0.00105;
  /** タッチの見回し感度（rad／CSS px） */
  touchSensitivity = 0.0045;
  /** ゲームパッド右スティックの回転速度（rad/s、水平／垂直） */
  padYawRate = 2.6;
  padPitchRate = 1.7;
  invertY = false;
  /** 走りで広がる視野角（度） */
  sprintFovBoost = 6;
  /** 通常の視野角（度）。写真モードなどで変えたいときはここを変える */
  baseFov: number;
  /** いまの視野角（度） */
  fov: number;
  locked = false;
  enabled = false;
  /** いま走っている */
  sprinting = false;
  /** 歩行の位相（足音・頭の揺れ）。π ごとに 1 歩 */
  bobPhase = 0;
  bobAmount = 0;
  /** いまの足元 */
  surface: Surface = "grass";
  /** 進行方向の斜度（度、上りが正）／水深（m、湖面より下が正）／急斜面を滑っている */
  slopeDeg = 0;
  waterDepth = 0;
  sliding = false;
  onStep?: (surface: Surface) => void;
  /** ポインタロックが外れた（Esc）。world が "exit" を emit する */
  onExit?: () => void;
  /** ゲームパッド A */
  onFlip?: () => void;
  /** ゲームパッド Y */
  onPhoto?: () => void;
  /** 視野角を変えた（CSM のフラスタムを更新してもらう） */
  onProjectionChange?: () => void;
  /** 仮想スティックの状態（UI が描く）。同じオブジェクトを毎フレーム書き換える */
  readonly stick: StickState;
  /** 見回しのタッチ（UI が印を出したければ） */
  readonly lookTouch: LookTouchState;
  private km: KeyboardMouse;
  private touch: TouchInput;
  private pad = new GamepadInput();
  private gyro = new Gyro();
  private moveStick = new THREE.Vector2();
  private releaseSpeed = 0;
  private sprintT = 0;
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private wish = new THREE.Vector3();

  constructor(public env: Env, public canvas: HTMLCanvasElement, public audio: Audio) {
    this.baseFov = env.camera.fov;
    this.fov = this.baseFov;
    this.km = new KeyboardMouse(canvas);
    this.km.onLockChange = (locked, programmatic) => {
      this.locked = locked;
      if (!locked && !programmatic && this.enabled && !this.env.isMobile) {
        // Esc などでロックが外れた → 入口へ
        this.enabled = false;
        this.releaseAll();
        this.onExit?.();
      }
    };
    this.km.onClick = () => {
      // ロックが外れたまま画面を触ったら、また入る
      if (!this.env.isMobile && !this.locked) this.enter();
    };
    this.touch = new TouchInput(canvas, () => this.enabled);
    this.stick = this.touch.stick;
    this.lookTouch = this.touch.look;
  }

  /** 一度でもタッチ操作された */
  get touchActive() {
    return this.touch.used;
  }
  get gyroEnabled() {
    return this.gyro.enabled;
  }
  get gyroAvailable() {
    return this.gyro.available;
  }
  get gamepadConnected() {
    return this.pad.state.connected;
  }
  /** 押されているキー（e.code）。計測ツールが状態を注入するのにも使う */
  get keys() {
    return this.km.keys;
  }
  get isSprinting() {
    return this.sprinting;
  }
  /** unadjustedMovement が効いているか */
  get rawMouse() {
    return this.km.unadjusted;
  }

  /** ジャイロで見回す（iOS は許可ダイアログが出るので、UI のボタン＝ユーザー操作の中で呼ぶ） */
  enableGyro(): Promise<boolean> {
    return this.gyro.enable();
  }
  disableGyro() {
    this.gyro.disable();
  }

  /** キーの状態を外から入れる（計測ツール用） */
  setKey(code: string, down: boolean) {
    if (down) this.km.keys.add(code);
    else this.km.keys.delete(code);
  }
  /** マウスの移動量（カウント）を外から足す（計測ツール・自動歩行用） */
  addLook(dx: number, dy: number) {
    this.km.dx += dx;
    this.km.dy += dy;
  }

  setPose(x: number, z: number, y: number | undefined, yawDeg: number, pitchDeg: number) {
    this.position.set(x, y ?? heightAt(x, z) + this.eyeHeight, z);
    this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.degToRad(pitchDeg);
    this.velocity.set(0, 0, 0);
    this.bobAmount = 0;
    this.apply();
  }

  /** 入場。パソコンは PointerLock を要求（ユーザー操作の中で呼ぶこと） */
  enter() {
    this.enabled = true;
    if (!this.env.isMobile) this.km.requestLock();
  }

  exit() {
    this.enabled = false;
    this.releaseAll();
    this.km.releaseLock();
  }

  /** キー・タッチを全部離した扱いにする（タブ切替・ロック解除など） */
  releaseAll() {
    this.km.releaseAll();
    this.touch.reset();
    this.sprinting = false;
  }

  /** 移動入力（x: 右、y: 前、長さ ≤ 1）。キーボード＋仮想スティック＋ゲームパッド */
  get moveInput(): THREE.Vector2 {
    const v = this.moveStick.set(0, 0);
    const k = this.km.keys;
    if (k.has("KeyW") || k.has("ArrowUp")) v.y += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) v.y -= 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) v.x -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) v.x += 1;
    const s = this.touch.stick;
    if (s.active) {
      v.x += s.dx;
      v.y += s.dy;
    }
    const g = this.pad.state;
    if (g.connected) {
      v.x += g.move.x;
      v.y += g.move.y;
    }
    if (v.lengthSq() > 1) v.normalize();
    return v;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.1);
    const active = this.enabled;
    const gp = this.pad.poll(dt);
    if (active) {
      if (gp.flip) this.onFlip?.();
      if (gp.photo) this.onPhoto?.();
    }

    // --- 見回し ---
    const m = this.km.consume();
    const tl = this.touch.consume(dt);
    const g = this.gyro.consume();
    if (active) {
      const inv = this.invertY ? -1 : 1;
      const dyaw = -(m.dx * this.sensitivity) - tl.dx * this.touchSensitivity - gp.look.x * this.padYawRate * dt + g.yaw;
      const dpitch = (-(m.dy * this.sensitivity) - tl.dy * this.touchSensitivity - gp.look.y * this.padPitchRate * dt) * inv + g.pitch;
      this.yaw = wrapAngle(this.yaw + dyaw);
      this.pitch = clamp(this.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
    }

    // --- 移動の入力 ---
    const inp = active ? this.moveInput : this.moveStick.set(0, 0);
    const yaw = this.yaw;
    const fwd = this.fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const wish = this.wish.set(0, 0, 0).addScaledVector(fwd, inp.y).addScaledVector(right, inp.x);
    let wishLen = wish.length();
    const k = this.km.keys;
    const wantSprint = active && (k.has("ShiftLeft") || k.has("ShiftRight") || this.touch.sprint || gp.sprint) && inp.y > 0.25;
    this.sprinting = wantSprint && wishLen > 0.1;
    // 走りはスティックの倒し具合に関係なく全速（向きだけスティックから）
    if (this.sprinting && wishLen < 1) {
      wish.multiplyScalar(1 / wishLen);
      wishLen = 1;
    }

    // --- 足元の地形 ---
    const px = this.position.x, pz = this.position.z;
    const h0 = heightAt(px, pz);
    const gx = (heightAt(px + GRAD_EPS, pz) - heightAt(px - GRAD_EPS, pz)) / (2 * GRAD_EPS);
    const gz = (heightAt(px, pz + GRAD_EPS) - heightAt(px, pz - GRAD_EPS)) / (2 * GRAD_EPS);
    const gmag = Math.hypot(gx, gz);
    const steep = gmag > TAN35;
    this.waterDepth = WORLD.lakeLevel - h0;

    // --- 目標速度（斜面と水で減速） ---
    const spd = this.sprinting ? this.sprint : this.speed;
    let slopeFactor = 1, s = 0;
    if (wishLen > 1e-4) {
      s = (gx * wish.x + gz * wish.z) / wishLen; // 進行方向 1m あたりの上り（tan）
      slopeFactor = s > 0 ? 1 - 0.6 * smoothstep(0.09, TAN35, s) : 1 + 0.18 * smoothstep(0.09, 0.58, -s);
      if (steep && s > 0) {
        // 急斜面: 登る成分を消す（等高線に沿ってしか動けない）
        const nx = gx / gmag, nz = gz / gmag;
        const up = wish.x * nx + wish.z * nz;
        wish.x -= nx * up;
        wish.z -= nz * up;
      }
    }
    this.slopeDeg = Math.atan(s) / DEG;
    const waterFactor = 1 - 0.55 * smoothstep(-0.3, MAX_DEPTH, this.waterDepth);
    const tx = wish.x * spd * slopeFactor * waterFactor;
    const tz = wish.z * spd * slopeFactor * waterFactor;
    const tLen = Math.hypot(tx, tz);

    // --- 加減速（直線的。押して accelTime、離して decelTime） ---
    const v = this.velocity;
    const curLen = Math.hypot(v.x, v.z);
    if (tLen > 1e-4) this.releaseSpeed = Math.max(tLen, curLen);
    const dvx = tx - v.x, dvz = tz - v.z;
    const dLen = Math.hypot(dvx, dvz);
    if (dLen > 1e-6) {
      const rate = tLen > 1e-4 ? Math.max(tLen, this.speed) / this.accelTime : Math.max(this.releaseSpeed, this.speed) / this.decelTime;
      const kk = Math.min(1, (rate * dt) / dLen);
      v.x += dvx * kk;
      v.z += dvz * kk;
    }
    if (Math.hypot(v.x, v.z) < 1e-3 && tLen < 1e-4) v.x = v.z = 0;

    // --- 急斜面では滑り落ちる ---
    let slideX = 0, slideZ = 0;
    this.sliding = false;
    if (steep) {
      const kk = 1.6 * smoothstep(TAN35, TAN35 + 0.4, gmag);
      slideX = (-gx / gmag) * kk;
      slideZ = (-gz / gmag) * kk;
      this.sliding = kk > 0.05;
    }

    // --- 位置の更新（登れない斜面・深い水・歩ける範囲で止め、境界に沿って滑る） ---
    const mx = (v.x + slideX) * dt, mz = (v.z + slideZ) * dt;
    const blocked = this.tryMove(mx, mz);
    if (blocked.x) v.x = 0;
    if (blocked.z) v.z = 0;

    // --- 目線の高さ（地面に追従。小さな段差は滑らかに） ---
    const ground = Math.max(heightAt(this.position.x, this.position.z), WORLD.lakeLevel - MAX_DEPTH);
    const targetY = ground + this.eyeHeight;
    this.position.y += (targetY - this.position.y) * (1 - Math.exp(-dt * 22));

    // --- 頭の揺れ・視野角・足音 ---
    const speedH = Math.hypot(v.x, v.z);
    const moveT = clamp(speedH / this.speed, 0, 1);
    const sprintNow = clamp((speedH - this.speed) / (this.sprint - this.speed), 0, 1);
    this.sprintT += (sprintNow - this.sprintT) * (1 - Math.exp(-dt * 6));
    const bobTarget = speedH > 0.3 ? moveT : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * (1 - Math.exp(-dt * (bobTarget > this.bobAmount ? 7 : 6)));
    if (speedH > 0.3) {
      const stepsPerSec = THREE.MathUtils.lerp(1.85, 2.9, sprintNow) * clamp(speedH / this.speed, 0.4, 1);
      const prev = this.bobPhase;
      this.bobPhase += dt * Math.PI * stepsPerSec;
      if (Math.floor(this.bobPhase / Math.PI) !== Math.floor(prev / Math.PI) && this.bobAmount > 0.3) {
        this.surface = this.surfaceAt(this.position.x, this.position.z);
        this.onStep?.(this.surface);
        this.audio.footstep(this.surface);
      }
    }
    const fovTarget = this.baseFov + this.sprintFovBoost * this.sprintT;
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-dt * 8));
    this.apply();
  }

  /** 位置を (mx, mz) だけ動かそうとする。ぶつかったら軸ごとに試して境界に沿わせる。戻り値は止められた軸 */
  private tryMove(mx: number, mz: number): { x: boolean; z: boolean } {
    const p = this.position;
    const x0 = p.x, z0 = p.z;
    if (this.canStand(x0 + mx, z0 + mz, mx, mz)) {
      this.place(x0 + mx, z0 + mz);
      return { x: false, z: false };
    }
    if (Math.abs(mx) > 1e-9 && this.canStand(x0 + mx, z0, mx, 0)) {
      this.place(x0 + mx, z0);
      return { x: false, z: true };
    }
    if (Math.abs(mz) > 1e-9 && this.canStand(x0, z0 + mz, 0, mz)) {
      this.place(x0, z0 + mz);
      return { x: true, z: false };
    }
    return { x: true, z: true };
  }

  private place(x: number, z: number) {
    // 歩ける範囲（円）に押し戻す
    const r = Math.hypot(x, z);
    if (r > WORLD.walkRadius) {
      x *= WORLD.walkRadius / r;
      z *= WORLD.walkRadius / r;
    }
    this.position.x = x;
    this.position.z = z;
  }

  /** (nx, nz) に立てるか。深い水と、移動方向に 35° を超える上りはだめ */
  private canStand(nx: number, nz: number, dx: number, dz: number): boolean {
    const r = Math.hypot(nx, nz);
    if (r > WORLD.walkRadius) {
      nx *= WORLD.walkRadius / r;
      nz *= WORLD.walkRadius / r;
    }
    const h = heightAt(nx, nz);
    if (h < WORLD.lakeLevel - MAX_DEPTH) return false;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) {
      const rise = (h - heightAt(nx - dx, nz - dz)) / dl;
      if (rise > TAN35) return false;
    }
    return true;
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
    const A = this.bobAmount, st = this.sprintT, phi = this.bobPhase;
    // 歩ごとに沈む上下（0..−amp）と、2 歩で 1 往復する左右（8 の字）＋わずかなロールと頷き
    const vertAmp = 0.032 + 0.036 * st;
    const latAmp = 0.016 + 0.018 * st;
    const bobY = (-Math.cos(2 * phi) - 1) * 0.5 * vertAmp * A;
    const bobX = Math.sin(phi) * latAmp * A;
    const roll = Math.sin(phi) * (0.35 + 0.6 * st) * DEG * A;
    const nod = -Math.cos(2 * phi) * 0.12 * DEG * A;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    cam.position.set(this.position.x + rx * bobX, this.position.y + bobY, this.position.z + rz * bobX);
    cam.rotation.set(this.pitch + nod, this.yaw, roll, "YXZ");
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
      this.onProjectionChange?.();
    }
    cam.updateMatrixWorld();
  }

  dispose() {
    this.km.dispose();
    this.touch.dispose();
    this.gyro.disable();
  }
}
