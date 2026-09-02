// 操作担当（controls/）が Controls に生やす予定の、UI が読む口。
// まだ無ければ UI は黙って描かない（ここに書いた形で生えれば、そのまま動く）。
import type { Controls } from "../controls";

/** 携帯の仮想スティックの状態。UI はこれを読んで円を描くだけ（入力の解釈は controls 側） */
export type StickState = {
  /** 触れている間 true */
  active: boolean;
  /** スティックの中心（CSS px、画面座標）。浮動式なら触れた位置 */
  x: number;
  y: number;
  /** 傾き −1..1（右・下が正） */
  dx: number;
  dy: number;
  /** 見た目の半径（CSS px） */
  radius: number;
};

export type ControlsExtras = {
  stick?: StickState;
  /** ジャイロ（iOS は許可ダイアログ込み）。true で ON になったことを返す */
  enableGyro?: () => Promise<boolean> | boolean;
  disableGyro?: () => void;
  gyroEnabled?: boolean;
};

export function extras(controls: Controls | null | undefined): ControlsExtras {
  return (controls ?? {}) as unknown as ControlsExtras;
}
