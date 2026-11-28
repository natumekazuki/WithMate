import type { CSSProperties } from "react";

/** 選択操作バーの配置計算に必要な境界と寸法。 */
type Rect = Pick<
  DOMRect,
  "bottom" | "height" | "left" | "right" | "top" | "width"
>;

/** 選択箇所、表示領域、操作ドック、ツールバーの計測値と余白。 */
export type SelectionActionOverlayPositionInput = {
  anchorRect: Rect;
  actionDockRect?: Rect | null;
  overlayRect: Rect;
  sourceRect: Rect;
  toolbarRect: Pick<Rect, "height" | "width">;
  padding?: number;
};

/** 選択箇所の上側を優先しつつ、表示領域の重なりと操作ドックで制限された範囲に操作バーを収める。 */
export function resolveSelectionActionOverlayPosition(
  input: SelectionActionOverlayPositionInput,
): CSSProperties | null {
  const padding = input.padding ?? 8;
  const boundaryLeft = Math.max(input.overlayRect.left, input.sourceRect.left);
  const boundaryRight = Math.min(
    input.overlayRect.right,
    input.sourceRect.right,
  );
  const boundaryTop = Math.max(input.overlayRect.top, input.sourceRect.top);
  let boundaryBottom = Math.min(
    input.overlayRect.bottom,
    input.sourceRect.bottom,
  );

  const dockOverlapsHorizontally =
    !!input.actionDockRect &&
    input.actionDockRect.left < boundaryRight &&
    input.actionDockRect.right > boundaryLeft;
  if (dockOverlapsHorizontally && input.actionDockRect) {
    boundaryBottom = Math.min(boundaryBottom, input.actionDockRect.top);
  }

  const availableWidth = boundaryRight - boundaryLeft - padding * 2;
  const availableHeight = boundaryBottom - boundaryTop - padding * 2;
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null;
  }

  const toolbarWidth = Math.min(input.toolbarRect.width || 112, availableWidth);
  const toolbarHeight = Math.min(
    input.toolbarRect.height || 32,
    availableHeight,
  );
  const preferredLeft =
    input.anchorRect.left + (input.anchorRect.width - toolbarWidth) / 2;
  const aboveTop = input.anchorRect.top - toolbarHeight - padding;
  const belowTop = input.anchorRect.bottom + padding;
  const top =
    aboveTop >= boundaryTop + padding
      ? aboveTop
      : belowTop + toolbarHeight <= boundaryBottom - padding
        ? belowTop
        : Math.min(
            boundaryBottom - toolbarHeight - padding,
            Math.max(boundaryTop + padding, aboveTop),
          );
  const left = Math.min(
    boundaryRight - toolbarWidth - padding,
    Math.max(boundaryLeft + padding, preferredLeft),
  );

  return {
    left,
    maxWidth: availableWidth,
    top,
  };
}
