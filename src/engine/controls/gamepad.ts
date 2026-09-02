// ゲームパッド（標準マッピング）。左スティック移動・右スティック視線・RT（または L3）走り・A 裏返し・Y 写真。
// 毎フレーム poll() で navigator.getGamepads() を読む（イベントは使わない）。
//   - 円形のデッドゾーン（0.16〜0.18）と、視線は 1.6 乗の応答曲線＋倒し切りで少し加速（CoD 風）
//   - flip / photo は「押した瞬間」だけ true
export type GamepadState = {
  connected: boolean;
  id: string;
  /** 移動 −1..1（x: 右、y: 前） */
  move: { x: number; y: number };
  /** 視線 −1..1 相当（x: 右、y: 下。応答曲線・加速込み） */
  look: { x: number; y: number };
  sprint: boolean;
  flip: boolean;
  photo: boolean;
};

function deadzone(x: number, y: number, dz: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class GamepadInput {
  state: GamepadState = { connected: false, id: "", move: { x: 0, y: 0 }, look: { x: 0, y: 0 }, sprint: false, flip: false, photo: false };
  private prevFlip = false;
  private prevPhoto = false;
  private fullT = 0;

  poll(dt: number): GamepadState {
    const s = this.state;
    s.flip = s.photo = false;
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      s.connected = false;
      return s;
    }
    let gp: Gamepad | null = null;
    try {
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const g = pads[i];
        if (g && g.connected) {
          gp = g;
          if (g.mapping === "standard") break;
        }
      }
    } catch {
      gp = null;
    }
    if (!gp) {
      s.connected = false;
      s.move.x = s.move.y = s.look.x = s.look.y = 0;
      s.sprint = false;
      this.prevFlip = this.prevPhoto = false;
      this.fullT = 0;
      return s;
    }
    s.connected = true;
    s.id = gp.id;
    const ax = gp.axes;
    const [mx, my] = deadzone(ax[0] ?? 0, ax[1] ?? 0, 0.18);
    s.move.x = mx;
    s.move.y = -my; // 上が前
    const [lx, ly] = deadzone(ax[2] ?? 0, ax[3] ?? 0, 0.16);
    const mag = Math.hypot(lx, ly);
    this.fullT = mag > 0.95 ? this.fullT + dt : 0;
    const accel = 1 + 0.6 * smoothstep(0.25, 0.9, this.fullT);
    const k = mag > 1e-6 ? (Math.pow(mag, 1.6) * accel) / mag : 0;
    s.look.x = lx * k;
    s.look.y = ly * k;
    const b = gp.buttons;
    const pressed = (i: number) => {
      const bt = b[i];
      return !!bt && (bt.pressed || bt.value > 0.35);
    };
    s.sprint = pressed(7) || pressed(10);
    const flip = pressed(0), photo = pressed(3);
    s.flip = flip && !this.prevFlip;
    s.photo = photo && !this.prevPhoto;
    this.prevFlip = flip;
    this.prevPhoto = photo;
    return s;
  }
}
