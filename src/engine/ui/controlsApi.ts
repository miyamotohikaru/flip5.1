// 操作担当（controls/）が Controls に生やす予定の、UI が読む口。
// まだ無ければ UI は黙って描かない（ここに書いた形で生えれば、そのまま動く）。
import type { Controls } from "../controls";

/**
 * 携帯の仮想スティックの状態。UI はこれを読んで円を描くだけ（入力の解釈は controls 側）。
 * **一度も触られていない間は active が false**（x/y は 0 のまま）なので、UI は active を見て出し入れする。
 */
export type StickState = {
  /** 触れている間 true。触る前は false */
  active: boolean;
  /** つまみの位置（CSS px、画面座標）。浮動式なので触れた所が中心 */
  x: number;
  y: number;
  /** 傾き −1..1。dx は右が正、**dy は上（前進）が正**（CSS の Y とは逆） */
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
