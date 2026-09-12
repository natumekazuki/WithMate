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
import type { SessionSidePane } from "./session-side-pane.js";
import type {
  ChatActionDockMode,
  ChatHeaderVisibility,
  ChatLayoutPriority,
} from "./chat/chat-layout-preference.js";

const SESSION_CONTEXT_RAIL_DEFAULT_WIDTH = 420;
const SESSION_FILE_EXPLORER_DEFAULT_WIDTH = 320;
const SESSION_LAYOUT_VIEWPORT_BREAKPOINT = 1400;
const SESSION_CONTEXT_RAIL_DRAG_THRESHOLD = 4;
const SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS = 100;
const SESSION_HORIZONTAL_SPLITTER_SIZE = 20;
const SESSION_HEADER_DOCK_DEFAULT_HEIGHT = 64;
const SESSION_ACTION_DOCK_DEFAULT_HEIGHT = 320;
const SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT = 54;
const SESSION_ACTION_DOCK_MIN_HEIGHT = 260;
const SESSION_ACTION_DOCK_MAX_HEIGHT_RATIO = 0.95;
const SESSION_CENTRAL_SURFACE_MIN_HEIGHT_RATIO = 0.05;
const SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT = 40;
const SESSION_MESSAGE_BOTTOM_EPSILON = 1;
const SESSION_MESSAGE_SCROLL_INTENT_SETTLE_MS = 180;

function scrollMessageListElementToBottom(messageListElement: HTMLDivElement): void {
  const bottomAnchor = messageListElement.querySelector<HTMLElement>(".message-list-bottom-anchor");
  if (bottomAnchor) {
    bottomAnchor.scrollIntoView({ block: "end" });
    return;
  }

  messageListElement.scrollTop = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight);
}

function clampSidePaneWidth(
  requestedWidth: number,
  workbenchWidth: number,
  oppositeWidth: number,
): number {
  const maxWidth = Math.max(
    0,
    workbenchWidth
      - Math.max(0, oppositeWidth)
      - SESSION_HORIZONTAL_SPLITTER_SIZE * 2,
  );
  return Math.min(maxWidth, Math.max(0, requestedWidth));
}

function isNarrowSessionLayoutViewport(): boolean {
  return window.innerWidth < SESSION_LAYOUT_VIEWPORT_BREAKPOINT;
}

function measureSidePaneAvailableSize(layout: HTMLElement): number {
  if (!isNarrowSessionLayoutViewport()) {
    return measureSessionHorizontalLayoutBounds(layout).width;
  }
  const header = layout.querySelector<HTMLElement>(".session-header-dock-slot");
  const headerHeight = header && !header.classList.contains("is-hidden")
    ? header.getBoundingClientRect().height : 0;
  const actionDockHeight = layout.querySelector<HTMLElement>(".session-action-dock-slot")?.getBoundingClientRect().height ?? 0;
  return Math.max(0, measureSessionVerticalDockLayoutBounds(layout).height
    - headerHeight - actionDockHeight - SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT);
}

export function useChatLayoutPresentation(input: {
  initialHeader: ChatHeaderVisibility | null;
  initialActionDock: ChatActionDockMode | null;
  initialPriority: ChatLayoutPriority | null;
  onHeaderChange?: (value: ChatHeaderVisibility) => void;
  onActionDockChange?: (value: ChatActionDockMode) => void;
  onPriorityChange?: (value: ChatLayoutPriority) => void;
}) {
  const initialHeaderExpanded = input.initialHeader === "visible";
  const initialActionDockExpanded = input.initialActionDock === "expanded";
  const initialPriority = input.initialPriority ?? "side-pane-first";
  const [isHeaderExpanded, setHeaderExpandedState] = useState(initialHeaderExpanded);
  const [isActionDockPinnedExpanded, setActionDockExpandedState] = useState(initialActionDockExpanded);
  const [layoutPriority, setLayoutPriorityState] = useState<ChatLayoutPriority>(initialPriority);
  const headerExpandedRef = useRef(initialHeaderExpanded);
  const actionDockExpandedRef = useRef(initialActionDockExpanded);
  const layoutPriorityRef = useRef(initialPriority);
  const headerInteractedRef = useRef(false);
  const actionDockInteractedRef = useRef(false);
  const priorityInteractedRef = useRef(false);
  const headerInitializedRef = useRef(input.initialHeader !== null);
  const actionDockInitializedRef = useRef(input.initialActionDock !== null);
  const priorityInitializedRef = useRef(input.initialPriority !== null);

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

  useEffect(() => {
    if (input.initialPriority === null || priorityInitializedRef.current) {
      return;
    }
    priorityInitializedRef.current = true;
    if (priorityInteractedRef.current) {
      return;
    }
    layoutPriorityRef.current = input.initialPriority;
    setLayoutPriorityState(input.initialPriority);
  }, [input.initialPriority]);

  const setIsHeaderExpanded = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(headerExpandedRef.current) : next;
    headerInteractedRef.current = true;
    if (headerExpandedRef.current === resolved) {
      return;
    }
    headerExpandedRef.current = resolved;
    setHeaderExpandedState(resolved);
    input.onHeaderChange?.(resolved ? "visible" : "hidden");
  }, [input.onHeaderChange]);

  const setLayoutPriority = useCallback((next: ChatLayoutPriority) => {
    const shouldPersistInitialSelection = !priorityInitializedRef.current;
    priorityInteractedRef.current = true;
    priorityInitializedRef.current = true;
    if (layoutPriorityRef.current === next) {
      if (shouldPersistInitialSelection) {
        input.onPriorityChange?.(next);
      }
      return;
    }
    layoutPriorityRef.current = next;
    setLayoutPriorityState(next);
    input.onPriorityChange?.(next);
  }, [input.onPriorityChange]);

  const setIsActionDockPinnedExpanded = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(actionDockExpandedRef.current) : next;
    actionDockInteractedRef.current = true;
    if (actionDockExpandedRef.current === resolved) {
      return;
    }
    actionDockExpandedRef.current = resolved;
    setActionDockExpandedState(resolved);
    input.onActionDockChange?.(resolved ? "expanded" : "compact");
    if (!resolved) {
      setLayoutPriority("side-pane-first");
    }
  }, [input.onActionDockChange, setLayoutPriority]);

  return {
    isHeaderExpanded,
    setIsHeaderExpanded,
    isActionDockPinnedExpanded,
    setIsActionDockPinnedExpanded,
    layoutPriority,
    setLayoutPriority,
  };
}

type SessionVerticalDockLayoutBounds = {
  top: number;
  bottom: number;
  height: number;
};

type SessionHorizontalLayoutBounds = {
  left: number;
  right: number;
  width: number;
};

function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readCssBorderPixelValue(width: string, style: string): number {
  return style === "none" || style === "hidden" ? 0 : readCssPixelValue(width);
}

export function measureSessionVerticalDockLayoutBounds(layout: HTMLElement): SessionVerticalDockLayoutBounds {
  const bounds = layout.getBoundingClientRect();
  const styles = window.getComputedStyle(layout);
  const contentTop = bounds.top
    + readCssBorderPixelValue(styles.borderTopWidth, styles.borderTopStyle)
    + readCssPixelValue(styles.paddingTop);
  const contentBottom = bounds.bottom
    - readCssBorderPixelValue(styles.borderBottomWidth, styles.borderBottomStyle)
    - readCssPixelValue(styles.paddingBottom);
  return {
    top: contentTop,
    bottom: contentBottom,
    height: Math.max(0, contentBottom - contentTop),
  };
}

export function measureSessionHorizontalLayoutBounds(layout: HTMLElement): SessionHorizontalLayoutBounds {
  const bounds = layout.getBoundingClientRect();
  const styles = window.getComputedStyle(layout);
  const contentLeft = bounds.left
    + readCssBorderPixelValue(styles.borderLeftWidth, styles.borderLeftStyle)
    + readCssPixelValue(styles.paddingLeft);
  const contentRight = bounds.right
    - readCssBorderPixelValue(styles.borderRightWidth, styles.borderRightStyle)
    - readCssPixelValue(styles.paddingRight);
  return {
    left: contentLeft,
    right: contentRight,
    width: Math.max(0, contentRight - contentLeft),
  };
}

export function clampSessionVerticalDockHeight(input: {
  requestedHeight: number;
  layoutHeight: number;
  minHeight: number;
  maxHeightRatio: number;
  oppositeDockHeight: number;
}): number {
  const ratioMax = input.layoutHeight * input.maxHeightRatio;
  const centralSurfaceMax = input.layoutHeight * (1 - SESSION_CENTRAL_SURFACE_MIN_HEIGHT_RATIO)
    - input.oppositeDockHeight
    - SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT;
  const maxHeight = Math.max(0, Math.min(ratioMax, centralSurfaceMax));
  const minHeight = Math.min(input.minHeight, maxHeight);
  return Math.min(maxHeight, Math.max(minHeight, input.requestedHeight));
}

export function useSessionVerticalDockResize(input: {
  ownerKey: string | null;
  isHeaderExpanded: boolean;
  isActionDockExpanded: boolean;
  onExpandActionDock?: () => void;
}) {
  const [actionDockHeight, setActionDockHeight] = useState(SESSION_ACTION_DOCK_DEFAULT_HEIGHT);
  const [actionDockCompactHeight, setActionDockCompactHeight] = useState(
    SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT,
  );
  const [isActionDockResizing, setIsActionDockResizing] = useState(false);
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
    const visibleHeaderHeight = input.isHeaderExpanded ? SESSION_HEADER_DOCK_DEFAULT_HEIGHT : 0;
    const nextActionDockHeight = clampSessionVerticalDockHeight({
      requestedHeight: actionDockHeightRef.current,
      layoutHeight,
      minHeight: Math.min(SESSION_ACTION_DOCK_MIN_HEIGHT, actionDockHeightRef.current),
      maxHeightRatio: SESSION_ACTION_DOCK_MAX_HEIGHT_RATIO,
      oppositeDockHeight: visibleHeaderHeight,
    });
    actionDockHeightRef.current = nextActionDockHeight;
    setActionDockHeight((current) => current === nextActionDockHeight ? current : nextActionDockHeight);
  }, [input.isActionDockExpanded, input.isHeaderExpanded]);

  useLayoutEffect(() => {
    clampDockHeights();
    window.addEventListener("resize", clampDockHeights);
    return () => window.removeEventListener("resize", clampDockHeights);
  }, [clampDockHeights, input.ownerKey]);

  useLayoutEffect(() => {
    if (input.isActionDockExpanded) {
      return;
    }

    const actionDock = actionDockRef.current?.querySelector<HTMLElement>(".session-action-dock");
    const compactContent = actionDock?.querySelector<HTMLElement>(".session-action-dock-compact-content");
    const compactRow = actionDock?.querySelector<HTMLElement>(".session-action-dock-compact-row");
    if (!actionDock || !compactContent || !compactRow) {
      return;
    }

    const syncCompactHeight = () => {
      const actionDockStyles = window.getComputedStyle(actionDock);
      const compactContentHeight = compactContent.scrollHeight
        + readCssPixelValue(actionDockStyles.borderTopWidth)
        + readCssPixelValue(actionDockStyles.borderBottomWidth);
      const nextHeight = Math.max(
        SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT,
        Math.ceil(compactContentHeight),
      );
      setActionDockCompactHeight((current) => current === nextHeight ? current : nextHeight);
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
        if (Math.abs(event.clientY - gesture.startY) < SESSION_CONTEXT_RAIL_DRAG_THRESHOLD) {
          return;
        }
        gesture.dragged = true;
        if (!input.isActionDockExpanded) {
          input.onExpandActionDock?.();
        }
      }

      const bounds = measureSessionVerticalDockLayoutBounds(layout);
      const oppositeHeight = input.isHeaderExpanded ? SESSION_HEADER_DOCK_DEFAULT_HEIGHT : 0;
      const nextHeight = clampSessionVerticalDockHeight({
        requestedHeight: gesture.startHeight + gesture.startY - event.clientY,
        layoutHeight: bounds.height,
        minHeight: Math.min(SESSION_ACTION_DOCK_MIN_HEIGHT, gesture.startHeight),
        maxHeightRatio: SESSION_ACTION_DOCK_MAX_HEIGHT_RATIO,
        oppositeDockHeight: oppositeHeight,
      });
      actionDockHeightRef.current = nextHeight;
      setActionDockHeight(nextHeight);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = pointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }
      if (gesture.dragged) {
        lastActionDockDragEndAtRef.current = Date.now();
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
  }, [input.isActionDockExpanded, input.isHeaderExpanded, input.onExpandActionDock, isActionDockResizing]);

  const handleStartActionDockResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !sessionDockLayoutRef.current) {
      return;
    }
    event.preventDefault();
    pointerGestureRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: input.isActionDockExpanded
        ? actionDockHeightRef.current
        : actionDockCompactHeight,
      dragged: false,
    };
    setIsActionDockResizing(true);
  }, [actionDockCompactHeight, input.isActionDockExpanded]);
  const handleHeaderSplitterClick = useCallback((toggle: () => void) => {
    toggle();
  }, []);
  const handleActionDockSplitterClick = useCallback((toggle: () => void) => {
    if (Date.now() - lastActionDockDragEndAtRef.current >= SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS) {
      toggle();
    }
  }, []);

  const sessionDockLayoutStyle = useMemo(() => ({
    ["--session-action-dock-height" as string]: `${actionDockHeight}px`,
    ["--session-action-dock-compact-height" as string]: `${actionDockCompactHeight}px`,
  }) as CSSProperties, [actionDockCompactHeight, actionDockHeight]);

  return {
    sessionDockLayoutRef,
    headerDockRef,
    actionDockRef,
    sessionDockLayoutStyle,
    isActionDockResizing,
    handleStartActionDockResize,
    handleHeaderSplitterClick,
    handleActionDockSplitterClick,
  };
}

export type UseSessionMessageListFollowingArgs = {
  ownerKey: string | null;
  scrollSignature: string;
  enabled?: boolean;
  bottomTolerance?: number;
  savedScrollState?: { scrollTop: number; isFollowing: boolean } | null;
  onScrollStateChange?: (state: { scrollTop: number; isFollowing: boolean }) => void;
};

export function useSessionMessageListFollowing({
  ownerKey,
  scrollSignature,
  enabled = true,
  bottomTolerance = SESSION_MESSAGE_BOTTOM_EPSILON,
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
  const shouldFollowMessageListAfterSendRef = useRef(false);
  const messageListScrollIntentTimerRef = useRef<number | null>(null);
  const messageListPointerIdRef = useRef<number | null>(null);
  const [isMessageListFollowing, setIsMessageListFollowing] = useState(true);

  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    const ownerWindow = messageListElement?.ownerDocument.defaultView;
    if (!enabled || !messageListElement || !ownerWindow) {
      return;
    }

    const clearScrollIntentTimer = () => {
      if (messageListScrollIntentTimerRef.current !== null) {
        ownerWindow.clearTimeout(messageListScrollIntentTimerRef.current);
        messageListScrollIntentTimerRef.current = null;
      }
    };
    const keepResumeIntentUntilScrollSettles = () => {
      canResumeMessageListFollowingRef.current = true;
      clearScrollIntentTimer();
      messageListScrollIntentTimerRef.current = ownerWindow.setTimeout(() => {
        canResumeMessageListFollowingRef.current = false;
        messageListScrollIntentTimerRef.current = null;
      }, SESSION_MESSAGE_SCROLL_INTENT_SETTLE_MS);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        shouldFollowMessageListAfterSendRef.current = false;
        canResumeMessageListFollowingRef.current = false;
        isMessageListFollowingRef.current = false;
        setIsMessageListFollowing(false);
        return;
      }
      if (event.deltaY > 0) {
        keepResumeIntentUntilScrollSettles();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      shouldFollowMessageListAfterSendRef.current = false;
      messageListPointerIdRef.current = event.pointerId;
      canResumeMessageListFollowingRef.current = true;
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (messageListPointerIdRef.current !== event.pointerId) {
        return;
      }
      messageListPointerIdRef.current = null;
      keepResumeIntentUntilScrollSettles();
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (messageListPointerIdRef.current !== event.pointerId) {
        return;
      }
      messageListPointerIdRef.current = null;
      canResumeMessageListFollowingRef.current = false;
      clearScrollIntentTimer();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof ownerWindow.HTMLElement
        && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])")
      ) {
        return;
      }
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        shouldFollowMessageListAfterSendRef.current = false;
        canResumeMessageListFollowingRef.current = false;
        isMessageListFollowingRef.current = false;
        setIsMessageListFollowing(false);
        return;
      }
      if (["ArrowDown", "PageDown", "End"].includes(event.key) || event.key === " ") {
        keepResumeIntentUntilScrollSettles();
      }
    };

    messageListElement.addEventListener("wheel", handleWheel, { passive: true });
    messageListElement.addEventListener("pointerdown", handlePointerDown, { passive: true });
    ownerWindow.addEventListener("pointerup", handlePointerEnd, { passive: true });
    ownerWindow.addEventListener("pointercancel", handlePointerCancel, { passive: true });
    messageListElement.addEventListener("keydown", handleKeyDown);
    return () => {
      messageListElement.removeEventListener("wheel", handleWheel);
      messageListElement.removeEventListener("pointerdown", handlePointerDown);
      ownerWindow.removeEventListener("pointerup", handlePointerEnd);
      ownerWindow.removeEventListener("pointercancel", handlePointerCancel);
      messageListElement.removeEventListener("keydown", handleKeyDown);
      clearScrollIntentTimer();
      shouldFollowMessageListAfterSendRef.current = false;
      canResumeMessageListFollowingRef.current = false;
      messageListPointerIdRef.current = null;
    };
  }, [enabled, ownerKey]);

  const scrollMessageListToBottom = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    scrollMessageListElementToBottom(messageListElement);
  }, []);

  const followMessageListLatest = useCallback(() => {
    canResumeMessageListFollowingRef.current = false;
    isMessageListFollowingRef.current = true;
    setIsMessageListFollowing(true);
    scrollMessageListToBottom();

    const ownerWindow = messageListRef.current?.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }
    ownerWindow.requestAnimationFrame(() => {
      if (isMessageListFollowingRef.current) {
        scrollMessageListToBottom();
      }
    });
  }, [scrollMessageListToBottom]);

  useLayoutEffect(() => {
    const currentSignature = scrollSignature;
    const wasSameOwner = messageListOwnerKeyRef.current === ownerKey;
    const hasSignatureChanged = messageListSignatureRef.current !== currentSignature;
    const wasEnabled = messageListEnabledRef.current;
    messageListEnabledRef.current = enabled;

    if (!enabled) {
      shouldFollowMessageListAfterSendRef.current = false;
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
      shouldFollowMessageListAfterSendRef.current = false;
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      isMessageListFollowingRef.current = restored.isFollowing;
      setIsMessageListFollowing(restored.isFollowing);
      if (restored.isFollowing) scrollMessageListToBottom();
      else messageListElement.scrollTop = restored.scrollTop;
      return;
    }

    if (!wasEnabled) {
      shouldFollowMessageListAfterSendRef.current = false;
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      followMessageListLatest();
      return;
    }

    if (!wasSameOwner) {
      shouldFollowMessageListAfterSendRef.current = false;
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      followMessageListLatest();
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    messageListSignatureRef.current = currentSignature;

    if (shouldFollowMessageListAfterSendRef.current) {
      shouldFollowMessageListAfterSendRef.current = false;
      followMessageListLatest();
      return;
    }

    if (isMessageListFollowingRef.current) {
      scrollMessageListToBottom();
    }
  }, [enabled, followMessageListLatest, ownerKey, scrollMessageListToBottom, scrollSignature]);

  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    const ownerWindow = messageListElement?.ownerDocument.defaultView;
    if (!enabled || !messageListElement || !ownerWindow?.ResizeObserver) {
      return;
    }

    const observer = new ownerWindow.ResizeObserver(() => {
      if (isMessageListFollowingRef.current) {
        scrollMessageListToBottom();
      }
    });
    observer.observe(messageListElement);
    const messageListContent = messageListElement.querySelector<HTMLElement>(".session-message-list-window");
    if (messageListContent) {
      observer.observe(messageListContent);
    }
    return () => observer.disconnect();
  }, [enabled, ownerKey, scrollMessageListToBottom, scrollSignature]);

  const handleMessageListScroll = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const currentScrollTop = messageListElement.scrollTop;
    const maxScrollTop = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight);
    const bottomGap = Math.max(0, maxScrollTop - currentScrollTop);
    const isAtBottom = bottomGap <= bottomTolerance;
    let nextFollowing = shouldFollowMessageListAfterSendRef.current;
    if (!nextFollowing && isAtBottom) {
      nextFollowing = isMessageListFollowingRef.current || canResumeMessageListFollowingRef.current;
    }
    isMessageListFollowingRef.current = nextFollowing;
    setIsMessageListFollowing((current) => current === nextFollowing ? current : nextFollowing);
    scrollStateChangeRef.current?.({ scrollTop: currentScrollTop, isFollowing: nextFollowing });
  }, [bottomTolerance]);

  useLayoutEffect(() => {
    const element = messageListRef.current;
    if (enabled && element) {
      scrollStateChangeRef.current?.({ scrollTop: element.scrollTop, isFollowing: isMessageListFollowingRef.current });
    }
  }, [enabled, ownerKey, isMessageListFollowing, scrollSignature]);

  const handleJumpToMessageListBottom = followMessageListLatest;
  const handleMessageListSend = useCallback((scrollToLatestOnSend: boolean) => {
    shouldFollowMessageListAfterSendRef.current = scrollToLatestOnSend;
    if (scrollToLatestOnSend) {
      followMessageListLatest();
    }
  }, [followMessageListLatest]);

  return {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
    handleMessageListSend,
    followMessageListLatest,
  };
}

export type UseSessionSidePanesArgs = {
  ownerKey: string | null;
  enabled?: boolean;
  filesPaneEnabled?: boolean;
  initialSidePane?: SessionSidePane | null;
  onSidePaneChange?: (sidePane: SessionSidePane) => void;
};

function resolveAvailableSidePane(sidePane: SessionSidePane, filesPaneEnabled: boolean): SessionSidePane {
  if (filesPaneEnabled || sidePane !== "files") {
    return sidePane === "both" && !filesPaneEnabled ? "context" : sidePane;
  }
  return "none";
}

export function useSessionSidePanes({
  ownerKey,
  enabled = true,
  filesPaneEnabled = true,
  initialSidePane = null,
  onSidePaneChange,
}: UseSessionSidePanesArgs) {
  const resolvedInitialSidePane = resolveAvailableSidePane(initialSidePane ?? "none", filesPaneEnabled);
  const initialContextVisible = resolvedInitialSidePane === "context" || resolvedInitialSidePane === "both";
  const initialFilesVisible = (resolvedInitialSidePane === "files" || resolvedInitialSidePane === "both") && filesPaneEnabled;
  const [contextRailWidth, setContextRailWidth] = useState(
    initialContextVisible ? SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0,
  );
  const [fileExplorerWidth, setFileExplorerWidth] = useState(
    initialFilesVisible ? SESSION_FILE_EXPLORER_DEFAULT_WIDTH : 0,
  );
  const [resizingSidePane, setResizingSidePane] = useState<Exclude<SessionSidePane, "none" | "both"> | null>(null);
  const sessionWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const contextRailWidthRef = useRef(initialContextVisible ? SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0);
  const fileExplorerWidthRef = useRef(initialFilesVisible ? SESSION_FILE_EXPLORER_DEFAULT_WIDTH : 0);
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

  const isContextRailVisible = contextRailWidth > 0;
  const isFilesPaneVisible = filesPaneEnabled && fileExplorerWidth > 0;
  const activeSidePane: SessionSidePane = isContextRailVisible
    ? isFilesPaneVisible ? "both" : "context"
    : isFilesPaneVisible ? "files" : "none";
  const reportedSidePaneRef = useRef<SessionSidePane>(activeSidePane);

  const notifySidePaneVisibility = useCallback((context: boolean, files: boolean) => {
    const nextSidePane = context ? files ? "both" : "context" : files ? "files" : "none";
    if (reportedSidePaneRef.current === nextSidePane) {
      return;
    }
    reportedSidePaneRef.current = nextSidePane;
    onSidePaneChange?.(nextSidePane);
  }, [onSidePaneChange]);

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

    const nextSidePane = resolveAvailableSidePane(initialSidePane, filesPaneEnabled);
    const nextContextVisible = nextSidePane === "context" || nextSidePane === "both";
    const nextFilesVisible = nextSidePane === "files" || nextSidePane === "both";
    const nextContextWidth = nextContextVisible ? contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0;
    const nextFilesWidth = nextFilesVisible && filesPaneEnabled
      ? fileExplorerWidthRef.current || SESSION_FILE_EXPLORER_DEFAULT_WIDTH
      : 0;
    contextRailWidthRef.current = nextContextWidth;
    fileExplorerWidthRef.current = nextFilesWidth;
    setContextRailWidth(nextContextWidth);
    setFileExplorerWidth(nextFilesWidth);
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

    const syncSidePaneWidths = () => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }
      const workbenchWidth = measureSidePaneAvailableSize(workbenchElement);
      if (workbenchWidth <= 0) {
        return;
      }
      const nextContextWidth = clampSidePaneWidth(
        contextRailWidthRef.current,
        workbenchWidth,
        fileExplorerWidthRef.current,
      );
      const nextFileExplorerWidth = clampSidePaneWidth(
        fileExplorerWidthRef.current,
        workbenchWidth,
        nextContextWidth,
      );
      contextRailWidthRef.current = nextContextWidth;
      fileExplorerWidthRef.current = nextFileExplorerWidth;
      setContextRailWidth((current) => (current === nextContextWidth ? current : nextContextWidth));
      setFileExplorerWidth((current) => (
        current === nextFileExplorerWidth ? current : nextFileExplorerWidth
      ));
    };

    syncSidePaneWidths();
    window.addEventListener("resize", syncSidePaneWidths);
    return () => window.removeEventListener("resize", syncSidePaneWidths);
  }, [enabled, ownerKey]);

  useEffect(() => {
    if (!enabled || resizingSidePane === null) {
      return;
    }

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
      const oppositeWidth = resizingSidePane === "files"
        ? contextRailWidthRef.current
        : fileExplorerWidthRef.current;
      const usableSize = measureSidePaneAvailableSize(workbenchElement);

      if (!gesture.dragged) {
        const pointerDelta = isNarrow ? event.clientY - gesture.startY : event.clientX - gesture.startX;
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
        oppositeWidth,
      );
      if (resizingSidePane === "files") {
        fileExplorerWidthRef.current = nextWidth;
        setFileExplorerWidth(nextWidth);
      } else {
        contextRailWidthRef.current = nextWidth;
        setContextRailWidth(nextWidth);
      }
      notifySidePaneVisibility(
        resizingSidePane === "context" ? nextWidth > 0 : contextRailWidthRef.current > 0,
        resizingSidePane === "files" ? nextWidth > 0 : fileExplorerWidthRef.current > 0,
      );
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = sidePanePointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }

      if (gesture.dragged) {
        lastSidePaneDragEndAtRef.current[resizingSidePane] = Date.now();
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
    document.body.style.cursor = isNarrowSessionLayoutViewport() ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [enabled, notifySidePaneVisibility, resizingSidePane]);

  const startSidePaneResize = useCallback((
    sidePane: Exclude<SessionSidePane, "none" | "both">,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const workbenchElement = sessionWorkbenchRef.current;
    if (
      !enabled
      || event.button !== 0
      || !workbenchElement
    ) {
      return;
    }

    event.preventDefault();
    sidePanePointerGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: sidePane === "files"
        ? fileExplorerWidthRef.current
        : contextRailWidthRef.current,
      dragged: false,
    };
    setResizingSidePane(sidePane);
  }, [enabled]);

  const handleStartContextRailResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => startSidePaneResize("context", event),
    [startSidePaneResize],
  );

  const handleStartFilesPaneResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => startSidePaneResize("files", event),
    [startSidePaneResize],
  );

  const handleKeyDownContextRailResize = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const isNarrow = isNarrowSessionLayoutViewport();
    const validKey = isNarrow
      ? event.key === "ArrowUp" || event.key === "ArrowDown"
      : event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!enabled || !validKey) {
      return;
    }
    event.preventDefault();
    const direction = isNarrow
      ? event.key === "ArrowUp" ? 1 : -1
      : event.key === "ArrowLeft" ? 1 : -1;
    const workbenchElement = sessionWorkbenchRef.current;
    if (!workbenchElement) {
      return;
    }
    const oppositeWidth = fileExplorerWidthRef.current;
    const availableSize = measureSidePaneAvailableSize(workbenchElement);
    hasInteractedWithSidePaneRef.current = true;
    const nextWidth = clampSidePaneWidth(
      contextRailWidthRef.current + direction * 10,
      availableSize,
      oppositeWidth,
    );
    contextRailWidthRef.current = nextWidth;
    setContextRailWidth(nextWidth);
    notifySidePaneVisibility(nextWidth > 0, fileExplorerWidthRef.current > 0);
  }, [enabled, filesPaneEnabled, notifySidePaneVisibility]);

  const handleKeyDownFilesPaneResize = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const isNarrow = isNarrowSessionLayoutViewport();
    const validKey = isNarrow
      ? event.key === "ArrowUp" || event.key === "ArrowDown"
      : event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!enabled || !filesPaneEnabled || !validKey) {
      return;
    }
    event.preventDefault();
    const direction = isNarrow
      ? event.key === "ArrowDown" ? 1 : -1
      : event.key === "ArrowRight" ? 1 : -1;
    const workbenchElement = sessionWorkbenchRef.current;
    if (!workbenchElement) {
      return;
    }
    const oppositeWidth = contextRailWidthRef.current;
    const availableSize = measureSidePaneAvailableSize(workbenchElement);
    hasInteractedWithSidePaneRef.current = true;
    const nextWidth = clampSidePaneWidth(
      fileExplorerWidthRef.current + direction * 10,
      availableSize,
      oppositeWidth,
    );
    fileExplorerWidthRef.current = nextWidth;
    setFileExplorerWidth(nextWidth);
    notifySidePaneVisibility(contextRailWidthRef.current > 0, nextWidth > 0);
  }, [enabled, filesPaneEnabled, notifySidePaneVisibility]);

  const handleCollapseContextRail = useCallback(() => {
    if (
      Date.now() - lastSidePaneDragEndAtRef.current.context
      < SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      return;
    }

    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    contextRailWidthRef.current = 0;
    setContextRailWidth(0);
    notifySidePaneVisibility(false, fileExplorerWidthRef.current > 0);
  }, [enabled, filesPaneEnabled, notifySidePaneVisibility]);

  const handleShowContextRail = useCallback(() => {
    if (!enabled || isContextRailVisible) {
      return;
    }
    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    const workbenchElement = sessionWorkbenchRef.current;
    if (!workbenchElement) return;
    const workbenchWidth = measureSidePaneAvailableSize(workbenchElement);
    const nextWidth = clampSidePaneWidth(
      contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH,
      workbenchWidth,
      fileExplorerWidthRef.current,
    );
    contextRailWidthRef.current = nextWidth;
    setContextRailWidth(nextWidth);
    notifySidePaneVisibility(nextWidth > 0, fileExplorerWidthRef.current > 0);
  }, [enabled, isContextRailVisible, notifySidePaneVisibility]);

  const handleCollapseFilesPane = useCallback(() => {
    if (!enabled || !filesPaneEnabled) {
      return;
    }

    if (
      Date.now() - lastSidePaneDragEndAtRef.current.files
      < SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      return;
    }

    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    fileExplorerWidthRef.current = 0;
    setFileExplorerWidth(0);
    notifySidePaneVisibility(contextRailWidthRef.current > 0, false);
  }, [enabled, filesPaneEnabled, notifySidePaneVisibility]);

  const sessionWorkbenchStyle = useMemo(
    () => ({
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
    handleCollapseContextRail,
    handleCollapseFilesPane,
  };
}
