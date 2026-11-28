import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  normalizeSessionSidePane,
  type SessionSidePane,
} from "../../../src-shared/settings/session-side-pane.js";
import type {
  ChatActionDockMode,
  ChatHeaderVisibility,
} from "../../../src-shared/settings/chat-layout-preference.js";

const SESSION_CONTEXT_RAIL_DEFAULT_WIDTH = 420;
const SESSION_FILE_EXPLORER_DEFAULT_WIDTH = 320;
const SESSION_LAYOUT_VIEWPORT_BREAKPOINT = 1400;
const SESSION_CONTEXT_RAIL_DRAG_THRESHOLD = 4;
const SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS = 100;
const SESSION_HORIZONTAL_SPLITTER_SIZE = 20;
const SESSION_HEADER_DOCK_DEFAULT_HEIGHT = 48;
const SESSION_ACTION_DOCK_DEFAULT_HEIGHT = 296;
const SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT = 48;
const SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT = 40;
const SESSION_MESSAGE_BOTTOM_EPSILON = 1;
const SESSION_MESSAGE_RESUME_DISTANCE = 24;
const SESSION_MESSAGE_SCROLL_INTENT_SETTLE_MS = 180;

/** 末尾に十分近ければ動かさず、アンカーが存在しない場合はスクロール量を直接合わせる。 */
function scrollMessageListElementToBottom(
  messageListElement: HTMLDivElement,
): void {
  const end = Math.max(
    0,
    messageListElement.scrollHeight - messageListElement.clientHeight,
  );
  if (
    Math.abs(end - messageListElement.scrollTop) <=
    SESSION_MESSAGE_BOTTOM_EPSILON
  )
    return;
  const bottomAnchor = messageListElement.querySelector<HTMLElement>(
    ".message-list-bottom-anchor",
  );
  if (bottomAnchor) {
    bottomAnchor.scrollIntoView({ block: "end" });
    return;
  }

  messageListElement.scrollTop = Math.max(
    0,
    messageListElement.scrollHeight - messageListElement.clientHeight,
  );
}

/** 中央領域・反対側のペイン・区切りの寸法を確保し、残る範囲にペインを収める。 */
function clampSidePaneWidth(
  requestedWidth: number,
  workbenchWidth: number,
  oppositeWidth: number,
  paneMinimum: number,
  centralMinimum: number,
): number {
  const maxWidth = Math.max(
    0,
    workbenchWidth -
      Math.max(0, oppositeWidth) -
      Math.max(0, centralMinimum) -
      SESSION_HORIZONTAL_SPLITTER_SIZE * 2,
  );
  return Math.min(maxWidth, Math.max(0, Math.max(paneMinimum, requestedWidth)));
}

/** 左右ペインを横ではなく縦に配置する幅かどうかを判定する。 */
function isNarrowSessionLayoutViewport(): boolean {
  return window.innerWidth < SESSION_LAYOUT_VIEWPORT_BREAKPOINT;
}

/** 領域の最小寸法を CSS から読み、要素や有効な指定がなければゼロとする。 */
function readSessionRegionMinimum(
  layout: HTMLElement,
  selector: string,
  property: string,
): number {
  const element = layout.querySelector<HTMLElement>(selector);
  if (!element) {
    return 0;
  }
  const value = Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue(property),
  );
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** 展開中のヘッダーが占める高さを測り、未描画なら既定の高さを使う。 */
function measureVisibleHeaderDockHeight(
  layout: HTMLElement,
  isHeaderExpanded: boolean,
): number {
  if (!isHeaderExpanded) {
    return 0;
  }
  return (
    layout
      .querySelector<HTMLElement>(".session-header-dock-slot")
      ?.getBoundingClientRect().height ?? SESSION_HEADER_DOCK_DEFAULT_HEIGHT
  );
}

/** 狭い画面で縦積みになるペインと二つの区切りの占有高を求める。 */
function measureNarrowSideTracks(
  layout: HTMLElement,
  includeSidePane = true,
): number {
  if (!isNarrowSessionLayoutViewport()) return 0;
  const styles = window.getComputedStyle(layout);
  const sideHeight = includeSidePane
    ? (layout.classList.contains("is-left-pane-visible")
        ? readCssPixelValue(
            styles.getPropertyValue("--session-file-explorer-width"),
          ) || SESSION_FILE_EXPLORER_DEFAULT_WIDTH
        : 0) +
      (layout.classList.contains("is-right-pane-visible")
        ? readCssPixelValue(
            styles.getPropertyValue("--session-context-rail-width"),
          ) || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH
        : 0)
    : 0;
  return (
    sideHeight +
    2 *
      (readCssPixelValue(
        styles.getPropertyValue("--session-dock-splitter-size"),
      ) || 20)
  );
}

/** 広い画面では内容幅、狭い画面では上下のドックと区切りを除いた高さを使う。 */
function measureSidePaneAvailableSize(layout: HTMLElement): number {
  if (!isNarrowSessionLayoutViewport()) {
    return measureSessionHorizontalLayoutBounds(layout).width;
  }
  const header = layout.querySelector<HTMLElement>(".session-header-dock-slot");
  const headerHeight =
    header && !header.classList.contains("is-hidden")
      ? header.getBoundingClientRect().height
      : 0;
  const actionDockHeight =
    layout
      .querySelector<HTMLElement>(".session-action-dock-slot")
      ?.getBoundingClientRect().height ?? 0;
  return Math.max(
    0,
    measureSessionVerticalDockLayoutBounds(layout).height -
      headerHeight -
      actionDockHeight -
      SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT,
  );
}

/** 現在のレイアウト軸に沿ったペインと中央領域の最小寸法を読み取る。 */
function measureSidePaneMinimums(
  layout: HTMLElement,
  sidePane: "files" | "context",
) {
  const isNarrow = isNarrowSessionLayoutViewport();
  const paneSelector =
    sidePane === "files"
      ? ".session-left-pane-slot"
      : ".session-right-pane-slot";
  const paneMinimum = readSessionRegionMinimum(
    layout,
    paneSelector,
    isNarrow ? "--session-region-min-height" : "--session-region-min-width",
  );
  const centralMinimum = readSessionRegionMinimum(
    layout,
    ".session-message-stack",
    isNarrow ? "--session-region-min-height" : "--session-region-min-width",
  );
  return { paneMinimum, centralMinimum };
}

/** ヘッダーとドックを独立して開閉し、先に操作された項目を遅い初期設定で上書きしない。 */
export function useChatLayoutPresentation(input: {
  initialHeader: ChatHeaderVisibility | null;
  initialActionDock: ChatActionDockMode | null;
  onHeaderChange?: (value: ChatHeaderVisibility) => void;
  onActionDockChange?: (value: ChatActionDockMode) => void;
}) {
  const initialHeaderExpanded = input.initialHeader === "visible";
  const initialActionDockExpanded = input.initialActionDock === "expanded";
  const [isHeaderExpanded, setHeaderExpandedState] = useState(
    initialHeaderExpanded,
  );
  const [isActionDockPinnedExpanded, setActionDockExpandedState] = useState(
    initialActionDockExpanded,
  );
  const headerExpandedRef = useRef(initialHeaderExpanded);
  const actionDockExpandedRef = useRef(initialActionDockExpanded);
  const actionDockIntentRevisionRef = useRef(0);
  const headerInteractedRef = useRef(false);
  const actionDockInteractedRef = useRef(false);
  const headerInitializedRef = useRef(input.initialHeader !== null);
  const actionDockInitializedRef = useRef(input.initialActionDock !== null);

  useEffect(() => {
    if (input.initialHeader === null || headerInitializedRef.current) {
      return;
    }
    headerInitializedRef.current = true;
    if (headerInteractedRef.current) {
      return;
    }
    const expanded = input.initialHeader === "visible";
    headerExpandedRef.current = expanded;
    setHeaderExpandedState(expanded);
  }, [input.initialHeader]);

  useEffect(() => {
    if (input.initialActionDock === null || actionDockInitializedRef.current) {
      return;
    }
    actionDockInitializedRef.current = true;
    if (actionDockInteractedRef.current) {
      return;
    }
    const expanded = input.initialActionDock === "expanded";
    actionDockExpandedRef.current = expanded;
    setActionDockExpandedState(expanded);
  }, [input.initialActionDock]);

  const setIsHeaderExpanded = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const resolved =
        typeof next === "function" ? next(headerExpandedRef.current) : next;
      headerInteractedRef.current = true;
      if (headerExpandedRef.current === resolved) {
        return;
      }
      headerExpandedRef.current = resolved;
      setHeaderExpandedState(resolved);
      input.onHeaderChange?.(resolved ? "visible" : "hidden");
    },
    [input.onHeaderChange],
  );

  const setIsActionDockPinnedExpanded = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const resolved =
        typeof next === "function" ? next(actionDockExpandedRef.current) : next;
      actionDockInteractedRef.current = true;
      actionDockIntentRevisionRef.current += 1;
      if (actionDockExpandedRef.current === resolved) {
        return;
      }
      actionDockExpandedRef.current = resolved;
      setActionDockExpandedState(resolved);
      input.onActionDockChange?.(resolved ? "expanded" : "compact");
    },
    [input.onActionDockChange],
  );

  const captureActionDockIntent = useCallback(() => {
    const revision = actionDockIntentRevisionRef.current;
    return () => actionDockIntentRevisionRef.current === revision;
  }, []);

  return {
    isHeaderExpanded,
    setIsHeaderExpanded,
    isActionDockPinnedExpanded,
    setIsActionDockPinnedExpanded,
    captureActionDockIntent,
  };
}

/** 上下のドックが使える内容領域の境界と高さ。 */
type SessionVerticalDockLayoutBounds = {
  top: number;
  bottom: number;
  height: number;
};

/** 左右のペインが使える内容領域の境界と幅。 */
type SessionHorizontalLayoutBounds = {
  left: number;
  right: number;
  width: number;
};

/** 計算済み CSS の数値部を読み、有限の値がなければゼロとする。 */
function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 表示されない罫線は内容領域の寸法を消費しないものとして扱う。 */
function readCssBorderPixelValue(width: string, style: string): number {
  return style === "none" || style === "hidden" ? 0 : readCssPixelValue(width);
}

/** 外枠から上下の罫線と余白を除き、ドックの高さ調整に用いる範囲を測る。 */
export function measureSessionVerticalDockLayoutBounds(
  layout: HTMLElement,
): SessionVerticalDockLayoutBounds {
  const bounds = layout.getBoundingClientRect();
  const styles = window.getComputedStyle(layout);
  const contentTop =
    bounds.top +
    readCssBorderPixelValue(styles.borderTopWidth, styles.borderTopStyle) +
    readCssPixelValue(styles.paddingTop);
  const contentBottom =
    bounds.bottom -
    readCssBorderPixelValue(
      styles.borderBottomWidth,
      styles.borderBottomStyle,
    ) -
    readCssPixelValue(styles.paddingBottom);
  return {
    top: contentTop,
    bottom: contentBottom,
    height: Math.max(0, contentBottom - contentTop),
  };
}

/** 外枠から左右の罫線と余白を除き、ペインの幅調整に用いる範囲を測る。 */
export function measureSessionHorizontalLayoutBounds(
  layout: HTMLElement,
): SessionHorizontalLayoutBounds {
  const bounds = layout.getBoundingClientRect();
  const styles = window.getComputedStyle(layout);
  const contentLeft =
    bounds.left +
    readCssBorderPixelValue(styles.borderLeftWidth, styles.borderLeftStyle) +
    readCssPixelValue(styles.paddingLeft);
  const contentRight =
    bounds.right -
    readCssBorderPixelValue(styles.borderRightWidth, styles.borderRightStyle) -
    readCssPixelValue(styles.paddingRight);
  return {
    left: contentLeft,
    right: contentRight,
    width: Math.max(0, contentRight - contentLeft),
  };
}

/** 反対側の占有高と区切り分を確保し、残りが最小高より少なければ残りを優先する。 */
export function clampSessionVerticalDockHeight(input: {
  requestedHeight: number;
  layoutHeight: number;
  minHeight: number;
  oppositeDockHeight: number;
}): number {
  const maxHeight = Math.max(
    0,
    input.layoutHeight -
      input.oppositeDockHeight -
      SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT,
  );
  const minHeight = Math.min(input.minHeight, maxHeight);
  return Math.min(maxHeight, Math.max(minHeight, input.requestedHeight));
}

/** ドックの展開時・簡易表示時の高さを管理し、狭い画面で不足する場合は左右ペインを畳む。 */
export function useSessionVerticalDockResize(input: {
  ownerKey: string | null;
  isHeaderExpanded: boolean;
  isActionDockExpanded: boolean;
  sidePaneLayoutKey?: string;
}) {
  const [actionDockHeight, setActionDockHeight] = useState(
    SESSION_ACTION_DOCK_DEFAULT_HEIGHT,
  );
  const [actionDockCompactHeight, setActionDockCompactHeight] = useState(
    SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT,
  );
  const [isActionDockResizing, setIsActionDockResizing] = useState(false);
  const [isSidePaneBudgetCollapsed, setIsSidePaneBudgetCollapsed] =
    useState(false);
  const isSidePaneBudgetCollapsedRef = useRef(false);
  const sessionDockLayoutRef = useRef<HTMLDivElement | null>(null);
  const headerDockRef = useRef<HTMLDivElement | null>(null);
  const actionDockRef = useRef<HTMLDivElement | null>(null);
  const actionDockHeightRef = useRef(SESSION_ACTION_DOCK_DEFAULT_HEIGHT);
  const pointerGestureRef = useRef({
    pointerId: null as number | null,
    startY: 0,
    startHeight: SESSION_ACTION_DOCK_DEFAULT_HEIGHT,
    dragged: false,
  });
  const lastActionDockDragEndAtRef = useRef(0);

  useEffect(() => {
    actionDockHeightRef.current = actionDockHeight;
  }, [actionDockHeight]);

  const clampDockHeights = useCallback(() => {
    const layout = sessionDockLayoutRef.current;
    if (!layout) {
      return;
    }

    const layoutHeight = measureSessionVerticalDockLayoutBounds(layout).height;
    if (layoutHeight <= 0) {
      return;
    }
    const visibleHeaderHeight = measureVisibleHeaderDockHeight(
      layout,
      input.isHeaderExpanded,
    );
    const splitterHeight =
      readSessionRegionMinimum(
        layout,
        ".session-chat-layout",
        "--session-dock-splitter-size",
      ) || 20;
    const actionMinimum = input.isActionDockExpanded
      ? readSessionRegionMinimum(
          layout,
          ".session-action-dock-slot",
          "--session-region-min-height",
        )
      : actionDockCompactHeight;
    const availableWithSide = Math.max(
      0,
      layoutHeight -
        visibleHeaderHeight -
        splitterHeight * 2 -
        measureNarrowSideTracks(layout),
    );
    const collapseSide =
      isNarrowSessionLayoutViewport() && availableWithSide < actionMinimum;
    isSidePaneBudgetCollapsedRef.current = collapseSide;
    setIsSidePaneBudgetCollapsed(collapseSide);
    const totalAvailable = collapseSide
      ? Math.max(
          0,
          layoutHeight -
            visibleHeaderHeight -
            splitterHeight * 2 -
            measureNarrowSideTracks(layout, false),
        )
      : availableWithSide;
    const actionRequested = input.isActionDockExpanded
      ? actionDockHeightRef.current
      : actionDockCompactHeight;
    const nextActionDockHeight = Math.min(
      totalAvailable,
      Math.max(actionMinimum, actionRequested),
    );
    if (input.isActionDockExpanded) {
      actionDockHeightRef.current = nextActionDockHeight;
      setActionDockHeight((current) =>
        current === nextActionDockHeight ? current : nextActionDockHeight,
      );
    }
  }, [
    actionDockCompactHeight,
    input.isActionDockExpanded,
    input.isHeaderExpanded,
    input.sidePaneLayoutKey,
  ]);

  useLayoutEffect(() => {
    clampDockHeights();
    window.addEventListener("resize", clampDockHeights);
    return () => window.removeEventListener("resize", clampDockHeights);
  }, [clampDockHeights, input.ownerKey]);

  useLayoutEffect(() => {
    if (input.isActionDockExpanded) {
      return;
    }

    const actionDock = actionDockRef.current?.querySelector<HTMLElement>(
      ".session-action-dock",
    );
    const compactContent = actionDock?.querySelector<HTMLElement>(
      ".session-action-dock-compact-content",
    );
    const compactRow = actionDock?.querySelector<HTMLElement>(
      ".session-action-dock-compact-row",
    );
    if (!actionDock || !compactContent || !compactRow) {
      return;
    }

    /** 簡易表示の中身と罫線を測り、既定高を下限として行の高さを同期する。 */
    const syncCompactHeight = () => {
      const actionDockStyles = window.getComputedStyle(actionDock);
      const compactContentHeight =
        compactContent.scrollHeight +
        readCssPixelValue(actionDockStyles.borderTopWidth) +
        readCssPixelValue(actionDockStyles.borderBottomWidth);
      const nextHeight = Math.max(
        SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT,
        Math.ceil(compactContentHeight),
      );
      setActionDockCompactHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };

    syncCompactHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(syncCompactHeight);
    observer.observe(compactRow);
    return () => observer.disconnect();
  }, [input.isActionDockExpanded, input.ownerKey]);

  useEffect(() => {
    if (!isActionDockResizing) {
      return;
    }

    /** ドラッグの閾値を超えたら、残りの高さに収まる寸法を CSS へ直接反映する。 */
    const handlePointerMove = (event: PointerEvent) => {
      const gesture = pointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }
      const layout = sessionDockLayoutRef.current;
      if (!layout) {
        return;
      }
      if (!gesture.dragged) {
        if (
          Math.abs(event.clientY - gesture.startY) <
          SESSION_CONTEXT_RAIL_DRAG_THRESHOLD
        ) {
          return;
        }
        gesture.dragged = true;
      }

      const bounds = measureSessionVerticalDockLayoutBounds(layout);
      const oppositeHeight =
        measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded) +
        measureNarrowSideTracks(layout, !isSidePaneBudgetCollapsedRef.current);
      const nextHeight = clampSessionVerticalDockHeight({
        requestedHeight: gesture.startHeight + gesture.startY - event.clientY,
        layoutHeight: bounds.height,
        minHeight: readSessionRegionMinimum(
          layout,
          ".session-action-dock-slot",
          "--session-region-min-height",
        ),
        oppositeDockHeight: oppositeHeight,
      });
      actionDockHeightRef.current = nextHeight;
      layout.style.setProperty(
        "--session-action-dock-height",
        `${nextHeight}px`,
      );
    };

    /** 同じポインターの終了時に高さを確定し、直後のクリックが開閉しないよう時刻を保存する。 */
    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = pointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }
      if (gesture.dragged) {
        lastActionDockDragEndAtRef.current = Date.now();
        setActionDockHeight(actionDockHeightRef.current);
      }
      pointerGestureRef.current = {
        pointerId: null,
        startY: 0,
        startHeight: SESSION_ACTION_DOCK_DEFAULT_HEIGHT,
        dragged: false,
      };
      setIsActionDockResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [
    input.isActionDockExpanded,
    input.isHeaderExpanded,
    isActionDockResizing,
  ]);

  const handleStartActionDockResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (
        event.button !== 0 ||
        !sessionDockLayoutRef.current ||
        !input.isActionDockExpanded
      ) {
        return;
      }
      event.preventDefault();
      pointerGestureRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: actionDockHeightRef.current,
        dragged: false,
      };
      setIsActionDockResizing(true);
    },
    [input.isActionDockExpanded],
  );
  const handleHeaderSplitterClick = useCallback((toggle: () => void) => {
    toggle();
  }, []);
  const handleActionDockSplitterClick = useCallback((toggle: () => void) => {
    if (
      Date.now() - lastActionDockDragEndAtRef.current >=
      SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      toggle();
    }
  }, []);
  const handleActionDockKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        !input.isActionDockExpanded ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      )
        return;
      const layout = sessionDockLayoutRef.current;
      if (!layout) return;
      event.preventDefault();
      const next = clampSessionVerticalDockHeight({
        requestedHeight:
          actionDockHeightRef.current + (event.key === "ArrowUp" ? 20 : -20),
        layoutHeight: measureSessionVerticalDockLayoutBounds(layout).height,
        minHeight: readSessionRegionMinimum(
          layout,
          ".session-action-dock-slot",
          "--session-region-min-height",
        ),
        oppositeDockHeight:
          measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded) +
          measureNarrowSideTracks(
            layout,
            !isSidePaneBudgetCollapsedRef.current,
          ),
      });
      actionDockHeightRef.current = next;
      setActionDockHeight(next);
    },
    [input.isActionDockExpanded, input.isHeaderExpanded],
  );

  const sessionDockLayoutStyle = useMemo(
    () =>
      ({
        ["--session-action-dock-height" as string]: `${actionDockHeight}px`,
        ["--session-action-dock-compact-height" as string]: `${actionDockCompactHeight}px`,
      }) as CSSProperties,
    [actionDockCompactHeight, actionDockHeight],
  );

  return {
    sessionDockLayoutRef,
    headerDockRef,
    actionDockRef,
    sessionDockLayoutStyle,
    isActionDockResizing,
    isSidePaneBudgetCollapsed,
    handleStartActionDockResize,
    handleHeaderSplitterClick,
    handleActionDockSplitterClick,
    handleActionDockKeyDown,
  };
}

/** 会話の表示対象と内容変更を識別し、スクロール位置を保存・復元するための入力。 */
export type UseSessionMessageListFollowingArgs = {
  ownerKey: string | null;
  scrollSignature: string;
  enabled?: boolean;
  bottomTolerance?: number;
  savedScrollState?: { scrollTop: number; isFollowing: boolean } | null;
  onScrollStateChange?: (state: {
    scrollTop: number;
    isFollowing: boolean;
  }) => void;
};

/** 手動のスクロール意図をレイアウト補正と分け、会話ごとの末尾追従を管理する。 */
export function useSessionMessageListFollowing({
  ownerKey,
  scrollSignature,
  enabled = true,
  bottomTolerance = SESSION_MESSAGE_RESUME_DISTANCE,
  savedScrollState,
  onScrollStateChange,
}: UseSessionMessageListFollowingArgs) {
  const scrollStateChangeRef = useRef(onScrollStateChange);
  scrollStateChangeRef.current = onScrollStateChange;
  const savedScrollStateRef = useRef(savedScrollState);
  savedScrollStateRef.current = savedScrollState;
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageListSignatureRef = useRef("");
  const messageListOwnerKeyRef = useRef<string | null>(null);
  const messageListEnabledRef = useRef(enabled);
  const isMessageListFollowingRef = useRef(true);
  const canResumeMessageListFollowingRef = useRef(false);
  const intentRevisionRef = useRef(0);
  const correctionFrameRef = useRef<number | null>(null);
  const cancelSendEntranceRef = useRef<(() => void) | null>(null);
  const sendMotionRef = useRef<{
    startedAt: number | null;
    duration: number;
    remaining: number;
    fraction: number;
    contentHeight: number;
  } | null>(null);
  const messageListScrollIntentTimerRef = useRef<number | null>(null);
  const messageListPointerIdRef = useRef<number | null>(null);
  const pointerScrollTopRef = useRef(0);
  const [isMessageListFollowing, setIsMessageListFollowing] = useState(true);
  const displayedFollowing =
    messageListOwnerKeyRef.current !== ownerKey ||
    !messageListEnabledRef.current
      ? (savedScrollState?.isFollowing ?? true)
      : isMessageListFollowing;

  const cancelCorrection = useCallback(() => {
    cancelSendEntranceRef.current?.();
    sendMotionRef.current = null;
    if (correctionFrameRef.current !== null) {
      messageListRef.current?.ownerDocument.defaultView?.cancelAnimationFrame(
        correctionFrameRef.current,
      );
      correctionFrameRef.current = null;
    }
  }, []);
  const pauseMessageListFollowing = useCallback(() => {
    ++intentRevisionRef.current;
    canResumeMessageListFollowingRef.current = false;
    isMessageListFollowingRef.current = false;
    setIsMessageListFollowing(false);
    cancelCorrection();
  }, [cancelCorrection]);

  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    const ownerWindow = messageListElement?.ownerDocument.defaultView;
    if (!enabled || !messageListElement || !ownerWindow) {
      return;
    }

    /** 手動スクロールの再開許可を失効させる予約を取り消す。 */
    const clearScrollIntentTimer = () => {
      if (messageListScrollIntentTimerRef.current !== null) {
        ownerWindow.clearTimeout(messageListScrollIntentTimerRef.current);
        messageListScrollIntentTimerRef.current = null;
      }
    };
    /** 末尾方向の操作を短時間だけ記憶し、慣性スクロール中も追従再開を許可する。 */
    const keepResumeIntentUntilScrollSettles = () => {
      canResumeMessageListFollowingRef.current = true;
      clearScrollIntentTimer();
      messageListScrollIntentTimerRef.current = ownerWindow.setTimeout(() => {
        canResumeMessageListFollowingRef.current = false;
        messageListScrollIntentTimerRef.current = null;
      }, SESSION_MESSAGE_SCROLL_INTENT_SETTLE_MS);
    };
    /** 入力欄や対象方向に動ける入れ子のスクロール領域では、会話の追従状態を変えない。 */
    const isInternalScroll = (
      target: EventTarget | null,
      direction: number,
    ) => {
      if (!(target instanceof ownerWindow.HTMLElement)) return false;
      if (
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      )
        return true;
      for (
        let child: HTMLElement | null = target;
        child && child !== messageListElement;
        child = child.parentElement
      ) {
        if (
          !/(auto|scroll)/.test(ownerWindow.getComputedStyle(child).overflowY)
        )
          continue;
        const end = child.scrollHeight - child.clientHeight;
        if (
          end > 0 &&
          (direction < 0
            ? child.scrollTop > 0
            : child.scrollTop < end - SESSION_MESSAGE_BOTTOM_EPSILON)
        )
          return true;
      }
      return false;
    };
    /** 縦方向のホイール操作だけを読み、上なら追従を止め、下なら末尾での再開を許可する。 */
    const handleWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.deltaY === 0 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        isInternalScroll(event.target, event.deltaY)
      )
        return;
      if (event.deltaY < 0) {
        pauseMessageListFollowing();
        return;
      }
      if (event.deltaY > 0) {
        if (sendMotionRef.current) pauseMessageListFollowing();
        keepResumeIntentUntilScrollSettles();
      }
    };
    let touchY: number | null = null;
    let touchTarget: EventTarget | null = null;
    /** タッチ開始位置か、会話列のスクロールバーを押した時点の位置を記録する。 */
    const handlePointerDown = (event: PointerEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.pointerType === "touch") {
        touchY = event.clientY;
        touchTarget = event.target;
        return;
      }
      const rect = messageListElement.getBoundingClientRect();
      const scrollbarWidth = Math.max(
        16,
        messageListElement.offsetWidth - messageListElement.clientWidth,
      );
      if (
        event.target !== messageListElement ||
        event.clientX < rect.right - scrollbarWidth
      )
        return;
      if (sendMotionRef.current) pauseMessageListFollowing();
      ++intentRevisionRef.current;
      messageListPointerIdRef.current = event.pointerId;
      pointerScrollTopRef.current = messageListElement.scrollTop;
    };
    /** タッチ移動の有効な縦方向の差分から、追従の中断または再開の意図を判定する。 */
    const handlePointerMove = (event: PointerEvent) => {
      if (touchY === null || event.pointerType !== "touch") return;
      const delta = touchY - event.clientY;
      touchY = event.clientY;
      if (Math.abs(delta) < 1 || isInternalScroll(touchTarget, delta)) return;
      if (delta < 0) pauseMessageListFollowing();
      else {
        if (sendMotionRef.current) pauseMessageListFollowing();
        keepResumeIntentUntilScrollSettles();
      }
    };
    /** ポインターの追跡を終え、末尾方向の操作が継続中なら再開許可を短時間保つ。 */
    const handlePointerEnd = (event: PointerEvent) => {
      touchY = null;
      touchTarget = null;
      if (messageListPointerIdRef.current !== event.pointerId) {
        return;
      }
      messageListPointerIdRef.current = null;
      if (canResumeMessageListFollowingRef.current)
        keepResumeIntentUntilScrollSettles();
    };
    /** 追跡中のスクロールバー操作が取り消されたら、追従再開の許可も解除する。 */
    const handlePointerCancel = (event: PointerEvent) => {
      touchY = null;
      touchTarget = null;
      if (messageListPointerIdRef.current !== event.pointerId) {
        return;
      }
      messageListPointerIdRef.current = null;
      canResumeMessageListFollowingRef.current = false;
      clearScrollIntentTimer();
    };
    /** 入力やボタン操作を除いた会話のスクロールキーを、追従の中断・再開意図に変換する。 */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof ownerWindow.HTMLElement &&
        (target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) ||
          (event.key === " " && target.closest("button")))
      ) {
        return;
      }
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        if (isInternalScroll(target, -1)) return;
        pauseMessageListFollowing();
        return;
      }
      if (
        ["ArrowDown", "PageDown", "End"].includes(event.key) ||
        event.key === " "
      ) {
        if (isInternalScroll(target, 1)) return;
        if (sendMotionRef.current) pauseMessageListFollowing();
        keepResumeIntentUntilScrollSettles();
      }
    };

    messageListElement.addEventListener("wheel", handleWheel, {
      passive: true,
    });
    messageListElement.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });
    ownerWindow.addEventListener("pointerup", handlePointerEnd, {
      passive: true,
    });
    ownerWindow.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    ownerWindow.addEventListener("pointercancel", handlePointerCancel, {
      passive: true,
    });
    messageListElement.addEventListener("keydown", handleKeyDown);
    return () => {
      messageListElement.removeEventListener("wheel", handleWheel);
      messageListElement.removeEventListener("pointerdown", handlePointerDown);
      ownerWindow.removeEventListener("pointerup", handlePointerEnd);
      ownerWindow.removeEventListener("pointermove", handlePointerMove);
      ownerWindow.removeEventListener("pointercancel", handlePointerCancel);
      messageListElement.removeEventListener("keydown", handleKeyDown);
      clearScrollIntentTimer();
      ++intentRevisionRef.current;
      cancelCorrection();
      canResumeMessageListFollowingRef.current = false;
      messageListPointerIdRef.current = null;
    };
  }, [enabled, ownerKey, pauseMessageListFollowing, cancelCorrection]);

  const scrollMessageListToBottom = useCallback((timestamp?: number) => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const motion = sendMotionRef.current;
    if (
      motion &&
      !messageListElement.ownerDocument.defaultView?.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches
    ) {
      const height = messageListElement.scrollHeight;
      motion.remaining += height - motion.contentHeight;
      motion.contentHeight = height;
      if (timestamp !== undefined) {
        motion.startedAt ??= timestamp;
        const progress = Math.min(
          1,
          Math.max(0, (timestamp - motion.startedAt) / motion.duration),
        );
        // --session-dock-motion-easing の cubic-bezier(1/3, 1, 2/3, 1) に合わせる。
        const fraction = (1 - progress) ** 3;
        motion.remaining *= fraction / motion.fraction;
        motion.fraction = fraction;
        if (progress === 1) sendMotionRef.current = null;
      }
      messageListElement.scrollTop = Math.max(
        0,
        height - messageListElement.clientHeight - motion.remaining,
      );
      return;
    }
    sendMotionRef.current = null;
    scrollMessageListElementToBottom(messageListElement);
  }, []);

  /** 同じフレームへの追従補正を重複登録せず、描画に同期させる。 */
  const scheduleCorrection = useCallback(() => {
    const ownerWindow = messageListRef.current?.ownerDocument.defaultView;
    if (!ownerWindow || correctionFrameRef.current !== null) return;
    /** 次の描画で追従を補正し、送信後のスクロール演出が残っている間だけ続ける。 */
    const correct = (timestamp: number) => {
      correctionFrameRef.current = null;
      if (messageListEnabledRef.current && isMessageListFollowingRef.current) {
        scrollMessageListToBottom(timestamp);
        if (sendMotionRef.current)
          correctionFrameRef.current =
            ownerWindow.requestAnimationFrame(correct);
      }
    };
    correctionFrameRef.current = ownerWindow.requestAnimationFrame(correct);
  }, [scrollMessageListToBottom]);

  const followMessageListLatest = useCallback(() => {
    canResumeMessageListFollowingRef.current = false;
    isMessageListFollowingRef.current = true;
    setIsMessageListFollowing(true);
    scrollMessageListToBottom();

    scheduleCorrection();
  }, [scrollMessageListToBottom, scheduleCorrection]);

  useLayoutEffect(() => {
    const currentSignature = scrollSignature;
    const wasSameOwner = messageListOwnerKeyRef.current === ownerKey;
    const hasSignatureChanged =
      messageListSignatureRef.current !== currentSignature;
    const wasEnabled = messageListEnabledRef.current;
    messageListEnabledRef.current = enabled;

    if (!enabled) {
      cancelCorrection();
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      return;
    }

    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      return;
    }

    const restored = savedScrollStateRef.current;
    if ((!wasEnabled || !wasSameOwner) && restored) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      isMessageListFollowingRef.current = restored.isFollowing;
      setIsMessageListFollowing(restored.isFollowing);
      if (restored.isFollowing) scrollMessageListToBottom();
      else messageListElement.scrollTop = restored.scrollTop;
      return;
    }

    if (!wasEnabled) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      followMessageListLatest();
      return;
    }

    if (!wasSameOwner) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      followMessageListLatest();
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    messageListSignatureRef.current = currentSignature;

    if (isMessageListFollowingRef.current) {
      scheduleCorrection();
    }
  }, [
    enabled,
    followMessageListLatest,
    ownerKey,
    scrollMessageListToBottom,
    scrollSignature,
    scheduleCorrection,
    cancelCorrection,
  ]);

  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    const ownerWindow = messageListElement?.ownerDocument.defaultView;
    if (!enabled || !messageListElement || !ownerWindow?.ResizeObserver) {
      return;
    }

    const observer = new ownerWindow.ResizeObserver((entries) => {
      if (isMessageListFollowingRef.current) {
        // 通常のドックのサイズ変更も、表示範囲と同じ描画タイミングで反映する。
        if (
          sendMotionRef.current ||
          entries.some((entry) => entry.target === messageListElement)
        ) {
          scrollMessageListToBottom();
        }
        scheduleCorrection();
      }
    });
    observer.observe(messageListElement);
    let observedContent: HTMLElement | null = null;
    /** 仮想一覧の内容要素が差し替わったら、寸法監視の対象を付け替える。 */
    const observeContent = () => {
      const content = messageListElement.querySelector<HTMLElement>(
        ".session-message-list-window",
      );
      if (content === observedContent) return;
      if (observedContent) observer.unobserve(observedContent);
      observedContent = content;
      if (content) observer.observe(content);
    };
    observeContent();
    const mutationObserver = new ownerWindow.MutationObserver(observeContent);
    mutationObserver.observe(messageListElement, { childList: true });
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [enabled, ownerKey, scheduleCorrection, scrollMessageListToBottom]);

  const handleMessageListScroll = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const currentScrollTop = messageListElement.scrollTop;
    const maxScrollTop = Math.max(
      0,
      messageListElement.scrollHeight - messageListElement.clientHeight,
    );
    const bottomGap = Math.max(0, maxScrollTop - currentScrollTop);
    const isAtBottom = bottomGap <= bottomTolerance;
    if (messageListPointerIdRef.current !== null) {
      const delta = currentScrollTop - pointerScrollTopRef.current;
      pointerScrollTopRef.current = currentScrollTop;
      if (delta < 0) pauseMessageListFollowing();
      else if (delta > 0) canResumeMessageListFollowingRef.current = true;
    }
    const nextFollowing =
      isMessageListFollowingRef.current ||
      (isAtBottom && canResumeMessageListFollowingRef.current);
    isMessageListFollowingRef.current = nextFollowing;
    setIsMessageListFollowing((current) =>
      current === nextFollowing ? current : nextFollowing,
    );
    scrollStateChangeRef.current?.({
      scrollTop: currentScrollTop,
      isFollowing: nextFollowing,
    });
    if (nextFollowing) scheduleCorrection();
  }, [bottomTolerance, pauseMessageListFollowing, scheduleCorrection]);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (enabled && element) {
      scrollStateChangeRef.current?.({
        scrollTop: element.scrollTop,
        isFollowing: isMessageListFollowingRef.current,
      });
    }
  }, [enabled, ownerKey, isMessageListFollowing, scrollSignature]);

  /** 末尾移動ボタンは位置を合わせるだけでなく、以降の自動追従も有効にする。 */
  const handleJumpToMessageListBottom = followMessageListLatest;
  /** 送信直前の位置を捕捉し、会話と手動操作の意図が変わっていなければ受付後に一度だけ適用する。 */
  const captureMessageListSend = useCallback(
    (scrollToLatestOnSend: boolean, onAccepted = followMessageListLatest) => {
      const revision = intentRevisionRef.current;
      const owner = messageListOwnerKeyRef.current;
      const element = messageListRef.current;
      const scrollTop = element?.scrollTop ?? 0;
      const messageCount = Number(element?.dataset.messageCount);
      let consumed = false;
      return () => {
        if (consumed) return;
        consumed = true;
        if (
          revision !== intentRevisionRef.current ||
          owner !== messageListOwnerKeyRef.current
        )
          return;
        const view = element?.ownerDocument.defaultView;
        const cssDuration =
          element &&
          view
            ?.getComputedStyle(element)
            .getPropertyValue("--session-dock-motion-duration")
            .trim();
        const duration = cssDuration
          ? Number.parseFloat(cssDuration) *
            (cssDuration.endsWith("ms") ? 1 : 1000)
          : 0;
        const motionEnabled =
          element &&
          view &&
          duration > 0 &&
          !view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        cancelSendEntranceRef.current?.();
        if (motionEnabled) {
          if (scrollToLatestOnSend || isMessageListFollowingRef.current) {
            sendMotionRef.current = {
              startedAt: null,
              duration,
              fraction: 1,
              contentHeight: element.scrollHeight,
              remaining:
                Math.max(0, element.scrollHeight - element.clientHeight) -
                scrollTop,
            };
          }
          // 仮想リストで遅れてマウントされた行も含め、この送信で末尾に追加された行だけを登場演出の対象にする。
          const pendingRows = new Set<number>();
          for (
            let index = messageCount;
            index < Number(element.dataset.messageCount);
            index++
          )
            pendingRows.add(index);
          if (pendingRows.size) {
            /** 対象行の監視と期限タイマーを解除し、別の送信が設置した解除処理は残す。 */
            const stopObserving = () => {
              observer.disconnect();
              view.clearTimeout(timeout);
              if (cancelSendEntranceRef.current === stopObserving)
                cancelSendEntranceRef.current = null;
            };
            /** 送信で増えた行のうち、実際に描画されたものだけを一度ずつ表示演出する。 */
            const revealMountedRows = () => {
              if (
                view.matchMedia?.("(prefers-reduced-motion: reduce)").matches
              ) {
                stopObserving();
                return;
              }
              for (const row of element.querySelectorAll<HTMLElement>(
                ".session-message-virtual-row",
              )) {
                const index = Number(row.dataset.index);
                const message = row.querySelector<HTMLElement>(".message-row");
                if (!pendingRows.has(index) || !message) continue;
                pendingRows.delete(index);
                message.animate?.([{ opacity: 0 }, { opacity: 1 }], {
                  duration: duration * 0.6,
                  easing: "ease-out",
                });
              }
              if (!pendingRows.size) stopObserving();
            };
            const observer = new view.MutationObserver(revealMountedRows);
            const timeout = view.setTimeout(stopObserving, duration);
            cancelSendEntranceRef.current = stopObserving;
            observer.observe(element, { childList: true, subtree: true });
            revealMountedRows();
          }
        }
        if (scrollToLatestOnSend) onAccepted();
        else if (sendMotionRef.current) scheduleCorrection();
      };
    },
    [followMessageListLatest, scheduleCorrection],
  );

  return {
    messageListRef,
    isMessageListFollowing: displayedFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
    captureMessageListSend,
    pauseMessageListFollowing,
    followMessageListLatest,
  };
}

/** ペイン操作を有効にする条件と、最初に表示する側および変更通知を渡す。 */
export type UseSessionSidePanesArgs = {
  ownerKey: string | null;
  enabled?: boolean;
  filesPaneEnabled?: boolean;
  initialSidePane?: SessionSidePane | null;
  onSidePaneChange?: (sidePane: SessionSidePane) => void;
};

/** ファイルペインを提供しない画面では、保存されたファイルペイン選択を非表示にする。 */
function resolveAvailableSidePane(
  sidePane: SessionSidePane,
  filesPaneEnabled: boolean,
): SessionSidePane {
  sidePane = normalizeSessionSidePane(sidePane);
  if (filesPaneEnabled || sidePane !== "files") {
    return sidePane;
  }
  return "none";
}

/** ファイルとコンテキストのペインを排他的に表示し、画面幅に応じた軸でサイズ変更する。 */
export function useSessionSidePanes({
  ownerKey,
  enabled = true,
  filesPaneEnabled = true,
  initialSidePane = null,
  onSidePaneChange,
}: UseSessionSidePanesArgs) {
  const requestedInitialSidePane = initialSidePane as string | null;
  const resolvedInitialSidePane = resolveAvailableSidePane(
    normalizeSessionSidePane(requestedInitialSidePane),
    filesPaneEnabled,
  );
  const initialContextVisible = resolvedInitialSidePane === "context";
  const initialFilesVisible =
    resolvedInitialSidePane === "files" && filesPaneEnabled;
  const [contextRailWidth, setContextRailWidth] = useState(
    initialContextVisible ? SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0,
  );
  const [fileExplorerWidth, setFileExplorerWidth] = useState(
    initialFilesVisible ? SESSION_FILE_EXPLORER_DEFAULT_WIDTH : 0,
  );
  const [activeSidePane, setActiveSidePane] = useState<SessionSidePane>(
    resolvedInitialSidePane,
  );
  const [resizingSidePane, setResizingSidePane] = useState<Exclude<
    SessionSidePane,
    "none"
  > | null>(null);
  const sessionWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const contextRailWidthRef = useRef(
    initialContextVisible ? SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0,
  );
  const fileExplorerWidthRef = useRef(
    initialFilesVisible ? SESSION_FILE_EXPLORER_DEFAULT_WIDTH : 0,
  );
  const hasResolvedInitialSidePaneRef = useRef(initialSidePane !== null);
  const hasInteractedWithSidePaneRef = useRef(false);
  const sidePanePointerGestureRef = useRef({
    pointerId: null as number | null,
    startX: 0,
    startY: 0,
    startWidth: 0,
    dragged: false,
  });
  const lastSidePaneDragEndAtRef = useRef({ context: 0, files: 0 });

  const activeSidePaneRef = useRef<SessionSidePane>(resolvedInitialSidePane);
  const isContextRailVisible = activeSidePane === "context";
  const isFilesPaneVisible = filesPaneEnabled && activeSidePane === "files";
  const reportedSidePaneRef = useRef<SessionSidePane>(activeSidePane);

  const notifySidePaneVisibility = useCallback(
    (context: boolean, files: boolean) => {
      const nextSidePane = context ? "context" : files ? "files" : "none";
      activeSidePaneRef.current = nextSidePane;
      setActiveSidePane(nextSidePane);
      if (reportedSidePaneRef.current === nextSidePane) {
        return;
      }
      reportedSidePaneRef.current = nextSidePane;
      onSidePaneChange?.(nextSidePane);
    },
    [onSidePaneChange],
  );

  useEffect(() => {
    contextRailWidthRef.current = contextRailWidth;
  }, [contextRailWidth]);

  useEffect(() => {
    fileExplorerWidthRef.current = fileExplorerWidth;
  }, [fileExplorerWidth]);

  useEffect(() => {
    if (initialSidePane === null || hasResolvedInitialSidePaneRef.current) {
      return;
    }

    hasResolvedInitialSidePaneRef.current = true;
    if (hasInteractedWithSidePaneRef.current) {
      return;
    }

    const nextSidePane = resolveAvailableSidePane(
      normalizeSessionSidePane(initialSidePane),
      filesPaneEnabled,
    );
    const nextContextVisible = nextSidePane === "context";
    const nextFilesVisible = nextSidePane === "files";
    const nextContextWidth = nextContextVisible
      ? contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH
      : contextRailWidthRef.current;
    const nextFilesWidth =
      nextFilesVisible && filesPaneEnabled
        ? fileExplorerWidthRef.current || SESSION_FILE_EXPLORER_DEFAULT_WIDTH
        : fileExplorerWidthRef.current;
    contextRailWidthRef.current = nextContextWidth;
    fileExplorerWidthRef.current = nextFilesWidth;
    setContextRailWidth(nextContextWidth);
    setFileExplorerWidth(nextFilesWidth);
    activeSidePaneRef.current = nextSidePane;
    setActiveSidePane(nextSidePane);
    reportedSidePaneRef.current = nextSidePane;
  }, [filesPaneEnabled, initialSidePane, notifySidePaneVisibility]);

  useEffect(() => {
    if (filesPaneEnabled || fileExplorerWidthRef.current === 0) {
      return;
    }
    fileExplorerWidthRef.current = 0;
    setFileExplorerWidth(0);
  }, [filesPaneEnabled]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    /** ペインが寸法不足で畳まれていないとき、ウィンドウに収まるよう両側の保存寸法を補正する。 */
    const syncSidePaneWidths = () => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }
      if (
        workbenchElement.classList.contains("is-side-pane-budget-collapsed")
      ) {
        return;
      }
      const workbenchWidth = measureSidePaneAvailableSize(workbenchElement);
      if (workbenchWidth <= 0) {
        return;
      }
      const contextMinimums = measureSidePaneMinimums(
        workbenchElement,
        "context",
      );
      const filesMinimums = measureSidePaneMinimums(workbenchElement, "files");
      const nextContextWidth = clampSidePaneWidth(
        contextRailWidthRef.current,
        workbenchWidth,
        activeSidePaneRef.current === "files"
          ? fileExplorerWidthRef.current
          : 0,
        contextMinimums.paneMinimum,
        contextMinimums.centralMinimum,
      );
      const nextFileExplorerWidth = clampSidePaneWidth(
        fileExplorerWidthRef.current,
        workbenchWidth,
        activeSidePaneRef.current === "context" ? nextContextWidth : 0,
        filesMinimums.paneMinimum,
        filesMinimums.centralMinimum,
      );
      contextRailWidthRef.current = nextContextWidth;
      fileExplorerWidthRef.current = nextFileExplorerWidth;
      setContextRailWidth((current) =>
        current === nextContextWidth ? current : nextContextWidth,
      );
      setFileExplorerWidth((current) =>
        current === nextFileExplorerWidth ? current : nextFileExplorerWidth,
      );
    };

    syncSidePaneWidths();
    window.addEventListener("resize", syncSidePaneWidths);
    return () => window.removeEventListener("resize", syncSidePaneWidths);
  }, [enabled, ownerKey]);

  useEffect(() => {
    if (!enabled || resizingSidePane === null) {
      return;
    }

    /** ドラッグで動いた実際の軸とペイン側から増減量を求め、表示寸法に直接反映する。 */
    const handlePointerMove = (event: PointerEvent) => {
      const gesture = sidePanePointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }

      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }

      const isNarrow = isNarrowSessionLayoutViewport();
      const usableSize = measureSidePaneAvailableSize(workbenchElement);
      const minimums = measureSidePaneMinimums(
        workbenchElement,
        resizingSidePane,
      );

      if (!gesture.dragged) {
        const pointerDelta = isNarrow
          ? event.clientY - gesture.startY
          : event.clientX - gesture.startX;
        if (Math.abs(pointerDelta) < SESSION_CONTEXT_RAIL_DRAG_THRESHOLD) {
          return;
        }
        gesture.dragged = true;
        hasInteractedWithSidePaneRef.current = true;
      }

      const requestedWidth = isNarrow
        ? resizingSidePane === "files"
          ? gesture.startWidth + event.clientY - gesture.startY
          : gesture.startWidth + gesture.startY - event.clientY
        : resizingSidePane === "files"
          ? gesture.startWidth + event.clientX - gesture.startX
          : gesture.startWidth + gesture.startX - event.clientX;
      const nextWidth = clampSidePaneWidth(
        requestedWidth,
        usableSize,
        0,
        minimums.paneMinimum,
        minimums.centralMinimum,
      );
      if (resizingSidePane === "files") {
        fileExplorerWidthRef.current = nextWidth;
        workbenchElement.style.setProperty(
          "--session-file-explorer-width",
          `${nextWidth}px`,
        );
      } else {
        contextRailWidthRef.current = nextWidth;
        workbenchElement.style.setProperty(
          "--session-context-rail-width",
          `${nextWidth}px`,
        );
      }
    };

    /** 最終寸法を状態に反映し、当該ペインのドラッグ直後の開閉を抑止する。 */
    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = sidePanePointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }

      if (gesture.dragged) {
        lastSidePaneDragEndAtRef.current[resizingSidePane] = Date.now();
        if (resizingSidePane === "files")
          setFileExplorerWidth(fileExplorerWidthRef.current);
        else setContextRailWidth(contextRailWidthRef.current);
      }
      gesture.pointerId = null;
      gesture.dragged = false;
      setResizingSidePane(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = isNarrowSessionLayoutViewport()
      ? "row-resize"
      : "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [enabled, resizingSidePane]);

  const startSidePaneResize = useCallback(
    (
      sidePane: Exclude<SessionSidePane, "none">,
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (
        !enabled ||
        event.button !== 0 ||
        !workbenchElement ||
        activeSidePaneRef.current !== sidePane
      ) {
        return;
      }

      event.preventDefault();
      sidePanePointerGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth:
          sidePane === "files"
            ? fileExplorerWidthRef.current
            : contextRailWidthRef.current,
        dragged: false,
      };
      setResizingSidePane(sidePane);
    },
    [enabled],
  );

  const handleStartContextRailResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) =>
      startSidePaneResize("context", event),
    [startSidePaneResize],
  );

  const handleStartFilesPaneResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) =>
      startSidePaneResize("files", event),
    [startSidePaneResize],
  );

  const handleKeyDownContextRailResize = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const isNarrow = isNarrowSessionLayoutViewport();
      const validKey = isNarrow
        ? event.key === "ArrowUp" || event.key === "ArrowDown"
        : event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (!enabled || !isContextRailVisible || !validKey) {
        return;
      }
      event.preventDefault();
      const direction = isNarrow
        ? event.key === "ArrowUp"
          ? 1
          : -1
        : event.key === "ArrowLeft"
          ? 1
          : -1;
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }
      const availableSize = measureSidePaneAvailableSize(workbenchElement);
      const minimums = measureSidePaneMinimums(workbenchElement, "context");
      hasInteractedWithSidePaneRef.current = true;
      const nextWidth = clampSidePaneWidth(
        contextRailWidthRef.current + direction * 10,
        availableSize,
        0,
        minimums.paneMinimum,
        minimums.centralMinimum,
      );
      contextRailWidthRef.current = nextWidth;
      setContextRailWidth(nextWidth);
      notifySidePaneVisibility(true, false);
    },
    [enabled, isContextRailVisible, notifySidePaneVisibility],
  );

  const handleKeyDownFilesPaneResize = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const isNarrow = isNarrowSessionLayoutViewport();
      const validKey = isNarrow
        ? event.key === "ArrowUp" || event.key === "ArrowDown"
        : event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (!enabled || !filesPaneEnabled || !isFilesPaneVisible || !validKey) {
        return;
      }
      event.preventDefault();
      const direction = isNarrow
        ? event.key === "ArrowDown"
          ? 1
          : -1
        : event.key === "ArrowRight"
          ? 1
          : -1;
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }
      const availableSize = measureSidePaneAvailableSize(workbenchElement);
      const minimums = measureSidePaneMinimums(workbenchElement, "files");
      hasInteractedWithSidePaneRef.current = true;
      const nextWidth = clampSidePaneWidth(
        fileExplorerWidthRef.current + direction * 10,
        availableSize,
        0,
        minimums.paneMinimum,
        minimums.centralMinimum,
      );
      fileExplorerWidthRef.current = nextWidth;
      setFileExplorerWidth(nextWidth);
      notifySidePaneVisibility(false, true);
    },
    [enabled, filesPaneEnabled, isFilesPaneVisible, notifySidePaneVisibility],
  );

  const handleCollapseContextRail = useCallback(() => {
    if (
      Date.now() - lastSidePaneDragEndAtRef.current.context <
      SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      return;
    }

    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    contextRailWidthRef.current = 0;
    setContextRailWidth(0);
    notifySidePaneVisibility(false, false);
  }, [enabled, filesPaneEnabled, notifySidePaneVisibility]);

  const handleToggleContextRailVisibility = useCallback(() => {
    if (!enabled) return;
    if (activeSidePaneRef.current === "context") {
      handleCollapseContextRail();
      return;
    }
    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    const workbenchElement = sessionWorkbenchRef.current;
    const minimums = workbenchElement
      ? measureSidePaneMinimums(workbenchElement, "context")
      : { paneMinimum: 0, centralMinimum: 0 };
    const width = workbenchElement
      ? clampSidePaneWidth(
          contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH,
          measureSidePaneAvailableSize(workbenchElement),
          0,
          minimums.paneMinimum,
          minimums.centralMinimum,
        )
      : contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH;
    contextRailWidthRef.current = width;
    setContextRailWidth(width);
    fileExplorerWidthRef.current = 0;
    setFileExplorerWidth(0);
    notifySidePaneVisibility(true, false);
  }, [enabled, handleCollapseContextRail, notifySidePaneVisibility]);

  const handleShowContextRail = useCallback(() => {
    if (!enabled || isContextRailVisible) {
      return;
    }
    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    const workbenchElement = sessionWorkbenchRef.current;
    if (!workbenchElement) return;
    const workbenchWidth = measureSidePaneAvailableSize(workbenchElement);
    const minimums = measureSidePaneMinimums(workbenchElement, "context");
    const nextWidth = clampSidePaneWidth(
      contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH,
      workbenchWidth,
      0,
      minimums.paneMinimum,
      minimums.centralMinimum,
    );
    contextRailWidthRef.current = nextWidth;
    setContextRailWidth(nextWidth);
    fileExplorerWidthRef.current = 0;
    setFileExplorerWidth(0);
    notifySidePaneVisibility(true, false);
  }, [enabled, isContextRailVisible, notifySidePaneVisibility]);

  const handleCollapseFilesPane = useCallback(() => {
    if (!enabled || !filesPaneEnabled) {
      return;
    }

    if (
      Date.now() - lastSidePaneDragEndAtRef.current.files <
      SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      return;
    }

    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    fileExplorerWidthRef.current = 0;
    setFileExplorerWidth(0);
    notifySidePaneVisibility(false, false);
  }, [enabled, filesPaneEnabled, notifySidePaneVisibility]);

  const handleToggleFilesPaneVisibility = useCallback(() => {
    if (!enabled || !filesPaneEnabled) return;
    if (activeSidePaneRef.current === "files") {
      handleCollapseFilesPane();
      return;
    }
    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    const workbenchElement = sessionWorkbenchRef.current;
    const minimums = workbenchElement
      ? measureSidePaneMinimums(workbenchElement, "files")
      : { paneMinimum: 0, centralMinimum: 0 };
    const width = workbenchElement
      ? clampSidePaneWidth(
          fileExplorerWidthRef.current || SESSION_FILE_EXPLORER_DEFAULT_WIDTH,
          measureSidePaneAvailableSize(workbenchElement),
          0,
          minimums.paneMinimum,
          minimums.centralMinimum,
        )
      : fileExplorerWidthRef.current || SESSION_FILE_EXPLORER_DEFAULT_WIDTH;
    fileExplorerWidthRef.current = width;
    setFileExplorerWidth(width);
    contextRailWidthRef.current = 0;
    setContextRailWidth(0);
    notifySidePaneVisibility(false, true);
  }, [
    enabled,
    filesPaneEnabled,
    handleCollapseFilesPane,
    notifySidePaneVisibility,
  ]);

  const sessionWorkbenchStyle = useMemo(
    () =>
      ({
        ["--session-context-rail-width" as string]: `${contextRailWidth}px`,
        ["--session-file-explorer-width" as string]: `${fileExplorerWidth}px`,
      }) as CSSProperties,
    [contextRailWidth, fileExplorerWidth],
  );

  return {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    activeSidePane,
    isContextRailVisible,
    isFilesPaneVisible,
    isContextRailResizing: resizingSidePane === "context",
    isFilesPaneResizing: resizingSidePane === "files",
    handleStartContextRailResize,
    handleStartFilesPaneResize,
    handleKeyDownContextRailResize,
    handleKeyDownFilesPaneResize,
    handleShowContextRail,
    handleToggleContextRailVisibility,
    handleToggleFilesPaneVisibility,
  };
}
