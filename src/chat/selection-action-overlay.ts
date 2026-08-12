import type { CSSProperties } from "react";

type Rect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

export type SelectionActionOverlayPositionInput = {
  anchorRect: Rect;
  actionDockRect?: Rect | null;
  overlayRect: Rect;
  sourceRect: Rect;
  toolbarRect: Pick<Rect, "height" | "width">;
  padding?: number;
};

export function resolveSelectionActionOverlayPosition(
  input: SelectionActionOverlayPositionInput,
): CSSProperties | null {
  const padding = input.padding ?? 8;
  const boundaryLeft = Math.max(input.overlayRect.left, input.sourceRect.left);
  const boundaryRight = Math.min(input.overlayRect.right, input.sourceRect.right);
  const boundaryTop = Math.max(input.overlayRect.top, input.sourceRect.top);
  let boundaryBottom = Math.min(input.overlayRect.bottom, input.sourceRect.bottom);

  const dockOverlapsHorizontally = !!input.actionDockRect
    && input.actionDockRect.left < boundaryRight
    && input.actionDockRect.right > boundaryLeft;
  if (dockOverlapsHorizontally && input.actionDockRect) {
    boundaryBottom = Math.min(boundaryBottom, input.actionDockRect.top);
  }

  const availableWidth = boundaryRight - boundaryLeft - padding * 2;
  const availableHeight = boundaryBottom - boundaryTop - padding * 2;
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null;
  }

  const toolbarWidth = Math.min(input.toolbarRect.width || 112, availableWidth);
  const toolbarHeight = Math.min(input.toolbarRect.height || 32, availableHeight);
  const preferredLeft = input.anchorRect.left + (input.anchorRect.width - toolbarWidth) / 2;
  const aboveTop = input.anchorRect.top - toolbarHeight - padding;
  const belowTop = input.anchorRect.bottom + padding;
  const top = aboveTop >= boundaryTop + padding
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
