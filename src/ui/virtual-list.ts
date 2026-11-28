/** 件数と推定行高に、スクロール位置・表示領域・余分に描画する行数を合わせた入力。 */
export type VirtualListWindowInput = {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
  estimatedItemHeight: number;
  overscan: number;
};

/** 描画範囲を半開区間で示し、範囲外の行の高さを上下の余白として保持する。 */
export type VirtualListWindow = {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
  visibleCount: number;
};

/** 計算した行インデックスを指定した範囲内に収める。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** スクロール位置を、その位置を含む推定行の先頭へ切り下げる。 */
export function quantizeVirtualListScrollTop(
  scrollTop: number,
  estimatedItemHeight: number,
): number {
  const safeScrollTop = Math.max(0, scrollTop);
  const safeEstimatedItemHeight = Math.max(1, estimatedItemHeight);
  return (
    Math.floor(safeScrollTop / safeEstimatedItemHeight) *
    safeEstimatedItemHeight
  );
}

/** 先頭行の見切れと余分な描画行を含む範囲を求め、リスト外にはみ出さないようにする。 */
export function calculateVirtualListWindow(
  input: VirtualListWindowInput,
): VirtualListWindow {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const estimatedItemHeight = Math.max(1, input.estimatedItemHeight);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscan));
  const totalHeight = itemCount * estimatedItemHeight;

  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
      visibleCount: 0,
    };
  }

  const scrollTop = Math.max(0, input.scrollTop);
  const firstVisibleIndex = clamp(
    Math.floor(scrollTop / estimatedItemHeight),
    0,
    itemCount - 1,
  );
  const scrollOffset = scrollTop % estimatedItemHeight;
  const visibleCount = Math.max(
    1,
    Math.ceil((scrollOffset + viewportHeight) / estimatedItemHeight),
  );
  const startIndex = clamp(firstVisibleIndex - overscan, 0, itemCount);
  const endIndex = clamp(
    firstVisibleIndex + visibleCount + overscan,
    startIndex,
    itemCount,
  );

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * estimatedItemHeight,
    paddingBottom: Math.max(0, totalHeight - endIndex * estimatedItemHeight),
    totalHeight,
    visibleCount: endIndex - startIndex,
  };
}
