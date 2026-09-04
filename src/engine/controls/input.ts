// キーボードとマウス。見回す方法は 2 つある。
//   1. ドラッグ（既定）… 画面を押したまま動かすと見回す。カーソルは消えないので、
//      HUD のボタンもブラウザのタブも普通に触れる。Google ストリートビューと同じ「掴んで回す」向き。
//   2. マウス固定（PointerLock、任意）… HUD の「マウス固定」で切り替える。カーソルが消えて
//      FPS のように動かせるが、Esc を押すまでボタンを触れなくなるので既定にはしない。
//   - キーは e.code（配列に依存しない）。ウィンドウがフォーカスを失ったら全部離す（押しっぱなし事故を防ぐ）
//   - マウスは unadjustedMovement（OS の加速を外した生のカウント）を要求し、対応しなければ通常の PointerLock
//   - movementX/Y は画面倍率（devicePixelRatio）に依存しないので、そのまま感度を掛ける
//   - Esc などでロックが外れたら onLockChange(false, programmatic=false) → Controls が onExit を呼ぶ
export class KeyboardMouse {
  keys = new Set<string>();
  locked = false;
  /** unadjustedMovement が効いている */
  unadjusted = false;
  /** 未消費のマウス移動量（カウント） */
  dx = 0;
  dy = 0;
  onLockChange?: (locked: boolean, programmatic: boolean) => void;
  onLockError?: () => void;
  onClick?: () => void;
  /** ドラッグの開始・終了（カーソルの形を変えるため UI が使う） */
  onDragChange?: (dragging: boolean) => void;
  /** ドラッグで見回している最中 */
  dragging = false;
  /** ドラッグ1pxあたりの倍率（マウス固定より大きく振る） */
  dragScale = 2.6;
  /** ドラッグは「世界を掴んで回す」向き（ストリートビューと同じ）。false で FPS と同じ向き */
  dragGrab = true;
  private dragId = -1;
  private dragX = 0;
  private dragY = 0;
  private suppressNext = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.releaseAll);
    document.addEventListener("pointerlockchange", this.onLockChangeEv);
    document.addEventListener("pointerlockerror", this.onLockErrorEv);
    document.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("click", this.onClickEv);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  requestLock() {
    const c = this.canvas;
    if (document.pointerLockElement === c) return;
    const plain = () => {
      try {
        const r = c.requestPointerLock() as unknown as Promise<void> | undefined;
        if (r && typeof r.catch === "function") r.catch(() => this.onLockError?.());
      } catch {
        this.onLockError?.();
      }
    };
    try {
      const req = c.requestPointerLock as unknown as (o?: { unadjustedMovement: boolean }) => Promise<void> | undefined;
      const p = req.call(c, { unadjustedMovement: true });
      if (p && typeof p.then === "function") {
        p.then(
          () => {
            this.unadjusted = true;
          },
          () => {
            // unadjustedMovement 非対応（NotSupportedError）なら通常のロック
            this.unadjusted = false;
            plain();
          },
        );
      }
    } catch {
      plain();
    }
  }

  /** プログラムからロックを外す（onLockChange には programmatic=true で伝わる） */
  releaseLock() {
    if (document.pointerLockElement === this.canvas) {
      this.suppressNext = true;
      document.exitPointerLock();
    }
  }

  consume(): { dx: number; dy: number } {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = this.dy = 0;
    return r;
  }

  releaseAll = () => {
    this.keys.clear();
  };

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (t as HTMLInputElement).type;
      return !(type === "range" || type === "checkbox" || type === "radio" || type === "button");
    }
    return !!t.isContentEditable;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || this.isTyping(e)) return;
    if (e.metaKey || e.ctrlKey) return; // ブラウザのショートカットは邪魔しない
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.dx += e.movementX;
    this.dy += e.movementY;
  };
  private onLockChangeEv = () => {
    const locked = document.pointerLockElement === this.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    const programmatic = this.suppressNext;
    this.suppressNext = false;
    if (!locked) this.dx = this.dy = 0;
    this.onLockChange?.(locked, programmatic);
  };
  private onLockErrorEv = () => {
    this.onLockError?.();
  };
  private onClickEv = () => {
    this.onClick?.();
  };
  private onPointerDown = (e: PointerEvent) => {
    // マウス固定中とタッチ（TouchInput が担当）は対象外。左ボタンだけ
    if (this.locked || e.pointerType === "touch" || e.button !== 0) return;
    this.dragging = true;
    this.dragId = e.pointerId;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくても window のイベントで拾える */
    }
    this.onDragChange?.(true);
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || e.pointerId !== this.dragId) return;
    // movementX は環境によって 0 のことがあるので、前の位置との差から出す
    const mx = e.clientX - this.dragX;
    const my = e.clientY - this.dragY;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    const k = (this.dragGrab ? -1 : 1) * this.dragScale;
    this.dx += mx * k;
    this.dy += my * k;
  };
  private onPointerUp = (e: PointerEvent) => {
    if (!this.dragging || e.pointerId !== this.dragId) return;
    this.dragging = false;
    this.dragId = -1;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* 既に外れている */
    }
    this.onDragChange?.(false);
  };

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.releaseAll);
    document.removeEventListener("pointerlockchange", this.onLockChangeEv);
    document.removeEventListener("pointerlockerror", this.onLockErrorEv);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("click", this.onClickEv);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }
}
