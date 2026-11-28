/** 展開操作で保存するピン留め状態と、入力欄へフォーカスを移すかを表す。 */
export type ActionDockExpandState = {
  isActionDockPinnedExpanded: true;
  shouldFocusComposer: boolean;
};

/** 折りたたみ操作で手動の展開ピン留めを解除する状態。 */
export type ActionDockCollapseState = {
  isActionDockPinnedExpanded: false;
};

/** 手動のピン留めと強制展開の要因を合わせた、描画・折りたたみ制御用の状態。 */
export type ActionDockRuntimeState = {
  shouldForceActionDockExpanded: boolean;
  isActionDockExpanded: boolean;
  canCollapseActionDock: boolean;
};

/** 展開を強制する理由が一つでもあれば、ピン留めに関係なく展開して折りたたみを禁止する。 */
export function buildActionDockRuntimeState(input: {
  isActionDockPinnedExpanded: boolean;
  forceReasons: readonly boolean[];
}): ActionDockRuntimeState {
  const shouldForceActionDockExpanded = input.forceReasons.some(Boolean);

  return {
    shouldForceActionDockExpanded,
    isActionDockExpanded:
      input.isActionDockPinnedExpanded || shouldForceActionDockExpanded,
    canCollapseActionDock: !shouldForceActionDockExpanded,
  };
}

/** 手動展開をピン留めし、明示された場合だけ入力欄へのフォーカス移動を要求する。 */
export function buildActionDockExpandState(
  options: { focusComposer?: boolean } = {},
): ActionDockExpandState {
  return {
    isActionDockPinnedExpanded: true,
    shouldFocusComposer: !!options.focusComposer,
  };
}

/** ドックを展開したとき、ターンが実行中でなければ入力欄へフォーカスを移せる。 */
export function shouldFocusComposerForActionDockExpand(input: {
  isRunning: boolean;
}): boolean {
  return !input.isRunning;
}

/** 折りたたみが許される場合はピン留め解除を返し、強制展開中は変更しないよう null を返す。 */
export function buildActionDockCollapseState(
  canCollapse: boolean,
): ActionDockCollapseState | null {
  if (!canCollapse) {
    return null;
  }

  return {
    isActionDockPinnedExpanded: false,
  };
}
