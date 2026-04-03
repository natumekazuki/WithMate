export type ScreenPoint = {
  x: number;
  y: number;
};

export type ScreenWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CursorPlacementInput = {
  cursor: ScreenPoint;
  workArea: ScreenWorkArea;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
};

export const DEFAULT_WINDOW_CURSOR_OFFSET = 24;

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function resolveCursorAnchoredPosition(input: CursorPlacementInput): { x: number; y: number } {
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
