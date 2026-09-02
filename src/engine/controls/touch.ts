// タッチ操作（携帯）。
//   左半分: 仮想スティック。触れた所が中心、ドラッグで方向、半径 60px で最大。
//           半径の 1.35 倍より外まで倒す、または「ダブルタップして押したまま」で走る。
//   右半分: ドラッグで見回し。離した速さに応じた慣性が付き、ゆっくり止まる。
//   二本指（ピンチ）は無視: スティック・見回しとも最初の 1 本だけを見る。
//   touch-action: none / -webkit-touch-callout: none / gesturestart の preventDefault で
//   iOS Safari のスクロール・ズーム・長押しメニューを出さない。
// UI は stick（中心・つまみの位置・押されているか）を読んで描く。座標は CSS px（viewport 基準）。
export type StickState = {
  active: boolean;
  /** 触れた所（スティックの中心、CSS px、viewport 座標） */
  cx: number;
  cy: number;
  /** つまみの位置（半径で丸めた後） */
  x: number;
  y: number;
  /** 正規化した入力 −1..1（dx: 右が正、dy: 上（画面の奥）が正） */
  dx: number;
  dy: number;
  /** 最大になる半径（CSS px） */
  radius: number;
  /** 半径の 1.35 倍より外まで倒している（走り） */
  overdrive: boolean;
  /** ダブルタップ長押しの走り */
  sprint: boolean;
};

export type LookTouchState = { active: boolean; x: number; y: number };

const TAP_MS = 250;
const TAP_MOVE = 12;
const DOUBLE_MS = 320;
const DOUBLE_DIST = 48;
const OVERDRIVE = 1.35;
const INERTIA_TAU = 0.3;
const INERTIA_MAX = 2200;

export class TouchInput {
  /** 一度でもタッチされた（UI がスティックなどを出す判断に使える） */
  used = false;
  stick: StickState = { active: false, cx: 0, cy: 0, x: 0, y: 0, dx: 0, dy: 0, radius: 60, overdrive: false, sprint: false };
  look: LookTouchState = { active: false, x: 0, y: 0 };
  private stickId = -1;
  private lookId = -1;
  private stickStartT = 0;
  private stickMoved = 0;
  private lastTapT = -1e9;
  private lastTapX = 0;
  private lastTapY = 0;
  private lookDx = 0;
  private lookDy = 0;
  private lookLastX = 0;
  private lookLastY = 0;
  private velX = 0;
  private velY = 0;
  private lastMoveT = 0;
  private inertiaX = 0;
  private inertiaY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    /** 操作が有効か（Controls.enabled）。入場前のタッチは無視する */
    private isEnabled: () => boolean,
  ) {
    const st = canvas.style as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string; webkitTapHighlightColor?: string };
    st.touchAction = "none";
    st.userSelect = "none";
    st.webkitUserSelect = "none";
    st.webkitTouchCallout = "none";
    st.webkitTapHighlightColor = "transparent";
    canvas.addEventListener("touchstart", this.onStart, { passive: false });
    canvas.addEventListener("touchmove", this.onMove, { passive: false });
    canvas.addEventListener("touchend", this.onEnd, { passive: false });
    canvas.addEventListener("touchcancel", this.onEnd, { passive: false });
    canvas.addEventListener("contextmenu", this.prevent);
    document.addEventListener("gesturestart", this.prevent, { passive: false });
    document.addEventListener("gesturechange", this.prevent, { passive: false });
  }

  /** 走り（ダブルタップ長押し／倒し切り） */
  get sprint() {
    return this.stick.active && (this.stick.sprint || this.stick.overdrive);
  }

  private prevent = (e: Event) => {
    e.preventDefault();
  };

  private onStart = (e: TouchEvent) => {
    e.preventDefault();
    if (!this.isEnabled()) return;
    this.used = true;
    const now = performance.now();
    const half = window.innerWidth * 0.5;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < half) {
        if (this.stickId >= 0) continue; // 二本目は無視
        const s = this.stick;
        this.stickId = t.identifier;
        s.active = true;
        s.cx = s.x = t.clientX;
        s.cy = s.y = t.clientY;
        s.dx = s.dy = 0;
        s.overdrive = false;
        s.sprint = now - this.lastTapT < DOUBLE_MS && Math.hypot(t.clientX - this.lastTapX, t.clientY - this.lastTapY) < DOUBLE_DIST;
        this.stickStartT = now;
        this.stickMoved = 0;
      } else {
        if (this.lookId >= 0) continue;
        this.lookId = t.identifier;
        this.look.active = true;
        this.look.x = this.lookLastX = t.clientX;
        this.look.y = this.lookLastY = t.clientY;
        this.velX = this.velY = 0;
        this.inertiaX = this.inertiaY = 0; // 触れたら慣性は止まる
        this.lastMoveT = now;
      }
    }
  };

  private onMove = (e: TouchEvent) => {
    e.preventDefault();
    if (!this.isEnabled()) return;
    const now = performance.now();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        const s = this.stick;
        const ox = t.clientX - s.cx, oy = t.clientY - s.cy;
        const d = Math.hypot(ox, oy);
        if (d > this.stickMoved) this.stickMoved = d;
        const r = s.radius;
        const cl = Math.min(d, r);
        const ux = d > 1e-6 ? ox / d : 0, uy = d > 1e-6 ? oy / d : 0;
        s.x = s.cx + ux * cl;
        s.y = s.cy + uy * cl;
        s.dx = (ux * cl) / r;
        s.dy = -(uy * cl) / r;
        s.overdrive = d > r * OVERDRIVE;
      } else if (t.identifier === this.lookId) {
        const ddx = t.clientX - this.lookLastX, ddy = t.clientY - this.lookLastY;
        this.lookDx += ddx;
        this.lookDy += ddy;
        const dtm = Math.max(4, now - this.lastMoveT);
        this.velX = 0.5 * this.velX + 0.5 * ((ddx / dtm) * 1000);
        this.velY = 0.5 * this.velY + 0.5 * ((ddy / dtm) * 1000);
        this.lastMoveT = now;
        this.lookLastX = this.look.x = t.clientX;
        this.lookLastY = this.look.y = t.clientY;
      }
    }
  };

  private onEnd = (e: TouchEvent) => {
    e.preventDefault();
    const now = performance.now();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        if (now - this.stickStartT < TAP_MS && this.stickMoved < TAP_MOVE) {
          this.lastTapT = now;
          this.lastTapX = t.clientX;
          this.lastTapY = t.clientY;
        }
        this.stickId = -1;
        const s = this.stick;
        s.active = false;
        s.dx = s.dy = 0;
        s.x = s.cx;
        s.y = s.cy;
        s.overdrive = false;
        s.sprint = false;
      } else if (t.identifier === this.lookId) {
        this.lookId = -1;
        this.look.active = false;
        // 直前（120ms 以内）まで動いていたら、その速さで慣性を付ける（止めてから離せば付かない）
        if (now - this.lastMoveT < 120) {
          const m = Math.hypot(this.velX, this.velY);
          const k = m > 120 ? Math.min(1, INERTIA_MAX / Math.max(m, 1e-6)) : 0;
          this.inertiaX = this.velX * k;
          this.inertiaY = this.velY * k;
        } else {
          this.inertiaX = this.inertiaY = 0;
        }
      }
    }
  };

  /** 見回しの移動量（CSS px）を取り出す。慣性の分も含む */
  consume(dt: number): { dx: number; dy: number } {
    let dx = this.lookDx, dy = this.lookDy;
    this.lookDx = this.lookDy = 0;
    if (this.inertiaX !== 0 || this.inertiaY !== 0) {
      dx += this.inertiaX * dt;
      dy += this.inertiaY * dt;
      const k = Math.exp(-dt / INERTIA_TAU);
      this.inertiaX *= k;
      this.inertiaY *= k;
      if (Math.hypot(this.inertiaX, this.inertiaY) < 12) this.inertiaX = this.inertiaY = 0;
    }
    return { dx, dy };
  }

  /** 触っている指を全部離した扱いにする */
  reset() {
    this.stickId = this.lookId = -1;
    const s = this.stick;
    s.active = false;
    s.dx = s.dy = 0;
    s.overdrive = s.sprint = false;
    this.look.active = false;
    this.lookDx = this.lookDy = 0;
    this.inertiaX = this.inertiaY = 0;
  }

  dispose() {
    const c = this.canvas;
    c.removeEventListener("touchstart", this.onStart);
    c.removeEventListener("touchmove", this.onMove);
    c.removeEventListener("touchend", this.onEnd);
    c.removeEventListener("touchcancel", this.onEnd);
    c.removeEventListener("contextmenu", this.prevent);
    document.removeEventListener("gesturestart", this.prevent);
    document.removeEventListener("gesturechange", this.prevent);
  }
}
