// ジャイロ（DeviceOrientation）で見回す。
//   iOS 13+ は DeviceOrientationEvent.requestPermission() をユーザー操作の中で呼ぶ必要があるので、
//   UI のボタンから controls.enableGyro() を呼ぶ。
//   端末の向きを絶対角ではなく「前回からの差分」で足すので、タッチの見回しと喧嘩しない。
//   角度の組み立ては three.js の DeviceOrientationControls と同じ（画面の向きも考慮）。
import { Euler, Quaternion, Vector3 } from "three";

const DEG = Math.PI / 180;

function screenAngle(): number {
  const so = typeof screen !== "undefined" ? screen.orientation : undefined;
  if (so && typeof so.angle === "number") return so.angle;
  const w = window as unknown as { orientation?: number };
  return typeof w.orientation === "number" ? w.orientation : 0;
}

export class Gyro {
  enabled = false;
  private prevYaw: number | null = null;
  private prevPitch = 0;
  private dyaw = 0;
  private dpitch = 0;
  private q = new Quaternion();
  private q0 = new Quaternion();
  private q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // −90° about X（画面が前を向くように）
  private euler = new Euler();
  private zee = new Vector3(0, 0, 1);
  private fwd = new Vector3();

  get available() {
    return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
  }

  /** 許可を求めて有効にする。ユーザー操作（タップ）の中で呼ぶこと */
  async enable(): Promise<boolean> {
    if (!this.available) return false;
    const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> };
    if (typeof D.requestPermission === "function") {
      try {
        const r = await D.requestPermission();
        if (r !== "granted") return false;
      } catch {
        return false;
      }
    }
    if (!this.enabled) window.addEventListener("deviceorientation", this.onOrientation);
    this.enabled = true;
    this.prevYaw = null;
    return true;
  }

  disable() {
    if (this.enabled) window.removeEventListener("deviceorientation", this.onOrientation);
    this.enabled = false;
    this.prevYaw = null;
    this.dyaw = this.dpitch = 0;
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const alpha = e.alpha * DEG, beta = e.beta * DEG, gamma = e.gamma * DEG;
    const orient = screenAngle() * DEG;
    this.euler.set(beta, alpha, -gamma, "YXZ");
    this.q.setFromEuler(this.euler).multiply(this.q1).multiply(this.q0.setFromAxisAngle(this.zee, -orient));
    this.fwd.set(0, 0, -1).applyQuaternion(this.q);
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    const pitch = Math.asin(Math.min(1, Math.max(-1, this.fwd.y)));
    if (this.prevYaw !== null) {
      let dy = yaw - this.prevYaw;
      if (dy > Math.PI) dy -= 2 * Math.PI;
      else if (dy < -Math.PI) dy += 2 * Math.PI;
      // センサーの飛び（画面の向きが変わった瞬間など）は捨てる
      if (Math.abs(dy) < 0.6 && Math.abs(pitch - this.prevPitch) < 0.6) {
        this.dyaw += dy;
        this.dpitch += pitch - this.prevPitch;
      }
    }
    this.prevYaw = yaw;
    this.prevPitch = pitch;
  };

  /** 前回の consume からの回転差分（rad） */
  consume(): { yaw: number; pitch: number } {
    const r = { yaw: this.dyaw, pitch: this.dpitch };
    this.dyaw = this.dpitch = 0;
    return r;
  }
}
