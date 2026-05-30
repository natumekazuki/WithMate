export type ActionDockExpandState = {
  isActionDockPinnedExpanded: true;
  shouldFocusComposer: boolean;
};

export type ActionDockCollapseState = {
  isActionDockPinnedExpanded: false;
};

export function buildActionDockExpandState(options: { focusComposer?: boolean } = {}): ActionDockExpandState {
  return {
    isActionDockPinnedExpanded: true,
    shouldFocusComposer: !!options.focusComposer,
  };
}

export function buildActionDockCollapseState(canCollapse: boolean): ActionDockCollapseState | null {
  if (!canCollapse) {
    return null;
  }

  return {
    isActionDockPinnedExpanded: false,
  };
}
