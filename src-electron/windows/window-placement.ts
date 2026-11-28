/** ディスプレイの配置を含めた画面座標系上の一点。 */
export type ScreenPoint = {
  x: number;
  y: number;
};

/** ウィンドウの表示に使えるディスプレイの作業領域。 */
export type ScreenWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** カーソルを基準にウィンドウの左上を決めるための寸法とオフセット。 */
export type CursorPlacementInput = {
  cursor: ScreenPoint;
  workArea: ScreenWorkArea;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
};

/** 軸ごとのオフセットが未指定の場合にカーソルから離す距離。 */
export const DEFAULT_WINDOW_CURSOR_OFFSET = 24;

/** 座標を作業領域のこの軸で許容される範囲に収める。 */
function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** カーソルを起点に配置し、作業領域をはみ出す軸は補正する。領域より大きい軸は領域の原点にそろえる。 */
export function resolveCursorAnchoredPosition(input: CursorPlacementInput): {
  x: number;
  y: number;
} {
  const { cursor, workArea, width, height } = input;
  const offsetX = input.offsetX ?? DEFAULT_WINDOW_CURSOR_OFFSET;
  const offsetY = input.offsetY ?? DEFAULT_WINDOW_CURSOR_OFFSET;

  const maxX = workArea.x + Math.max(workArea.width - width, 0);
  const maxY = workArea.y + Math.max(workArea.height - height, 0);

  return {
    x: clamp(cursor.x + offsetX, workArea.x, maxX),
    y: clamp(cursor.y + offsetY, workArea.y, maxY),
  };
}
