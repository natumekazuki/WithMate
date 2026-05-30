export type ActionDockExpandState = {
  isActionDockPinnedExpanded: true;
  shouldFocusComposer: boolean;
};

export type ActionDockCollapseState = {
  isActionDockPinnedExpanded: false;
};

export type ActionDockRuntimeState = {
  shouldForceActionDockExpanded: boolean;
  isActionDockExpanded: boolean;
  canCollapseActionDock: boolean;
};

export function buildActionDockRuntimeState(input: {
  isActionDockPinnedExpanded: boolean;
  forceReasons: readonly boolean[];
}): ActionDockRuntimeState {
  const shouldForceActionDockExpanded = input.forceReasons.some(Boolean);

  return {
    shouldForceActionDockExpanded,
    isActionDockExpanded: input.isActionDockPinnedExpanded || shouldForceActionDockExpanded,
    canCollapseActionDock: !shouldForceActionDockExpanded,
  };
}

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
