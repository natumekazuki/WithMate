import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SessionSidePane } from "./session-side-pane.js";
import type {
  ChatActionDockMode,
  ChatHeaderVisibility,
  ChatLayoutPriority,
} from "./chat/chat-layout-preference.js";

const SESSION_CONTEXT_RAIL_DEFAULT_WIDTH = 420;
const SESSION_CONTEXT_RAIL_MIN_WIDTH = 360;
const SESSION_FILE_EXPLORER_DEFAULT_WIDTH = 320;
const SESSION_FILE_EXPLORER_MIN_WIDTH = 260;
const SESSION_SIDE_PANE_MAX_WIDTH_RATIO = 0.5;
const SESSION_LAYOUT_VIEWPORT_BREAKPOINT = 1400;
const SESSION_CONTEXT_RAIL_DRAG_THRESHOLD = 4;
const SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS = 100;
const SESSION_HEADER_DOCK_DEFAULT_HEIGHT = 64;
const SESSION_ACTION_DOCK_DEFAULT_HEIGHT = 320;
const SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT = 54;
const SESSION_ACTION_DOCK_MIN_HEIGHT = 260;
const SESSION_ACTION_DOCK_MAX_HEIGHT_RATIO = 0.4;
const SESSION_CENTRAL_SURFACE_MIN_HEIGHT = 280;
const SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT = 40;
const SESSION_MESSAGE_BOTTOM_EPSILON = 1;

function scrollMessageListElementToBottom(messageListElement: HTMLDivElement): void {
  const bottomAnchor = messageListElement.querySelector<HTMLElement>(".message-list-bottom-anchor");
  if (bottomAnchor) {
    bottomAnchor.scrollIntoView({ block: "end" });
    return;
  }

  messageListElement.scrollTop = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight);
}

function clampSidePaneWidth(requestedWidth: number, workbenchWidth: number, minWidth: number): number {
  const maxWidth = Math.max(minWidth, workbenchWidth * SESSION_SIDE_PANE_MAX_WIDTH_RATIO);
  return Math.min(maxWidth, Math.max(minWidth, requestedWidth));
}

function isNarrowSessionLayoutViewport(): boolean {
  return window.innerWidth < SESSION_LAYOUT_VIEWPORT_BREAKPOINT;
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

export function measureSessionVerticalDockLayoutBounds(layout: HTMLElement): SessionVerticalDockLayoutBounds {
  const bounds = layout.getBoundingClientRect();
  const styles = window.getComputedStyle(layout);
  const contentTop = bounds.top
    + readCssPixelValue(styles.borderTopWidth)
    + readCssPixelValue(styles.paddingTop);
  const contentBottom = bounds.bottom
    - readCssPixelValue(styles.borderBottomWidth)
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
    + readCssPixelValue(styles.borderLeftWidth)
    + readCssPixelValue(styles.paddingLeft);
  const contentRight = bounds.right
    - readCssPixelValue(styles.borderRightWidth)
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
  const centralSurfaceMax = input.layoutHeight
    - input.oppositeDockHeight
    - SESSION_CENTRAL_SURFACE_MIN_HEIGHT
    - SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT;
  const maxHeight = Math.max(0, Math.min(ratioMax, centralSurfaceMax));
  const minHeight = Math.min(input.minHeight, maxHeight);
  return Math.min(maxHeight, Math.max(minHeight, input.requestedHeight));
}

export function useSessionVerticalDockResize(input: {
  ownerKey: string | null;
  isHeaderExpanded: boolean;
  isActionDockExpanded: boolean;
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
      minHeight: SESSION_ACTION_DOCK_MIN_HEIGHT,
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
      }

      const bounds = measureSessionVerticalDockLayoutBounds(layout);
      const oppositeHeight = input.isHeaderExpanded ? SESSION_HEADER_DOCK_DEFAULT_HEIGHT : 0;
      const nextHeight = clampSessionVerticalDockHeight({
        requestedHeight: bounds.bottom - event.clientY,
        layoutHeight: bounds.height,
        minHeight: SESSION_ACTION_DOCK_MIN_HEIGHT,
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
      pointerGestureRef.current = { pointerId: null, startY: 0, dragged: false };
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
  }, [input.isHeaderExpanded, isActionDockResizing]);

  const handleStartActionDockResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!input.isActionDockExpanded || event.button !== 0 || !sessionDockLayoutRef.current) {
      return;
    }
    event.preventDefault();
    pointerGestureRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      dragged: false,
    };
    setIsActionDockResizing(true);
  }, [input.isActionDockExpanded]);
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
  bottomThreshold?: number;
};

export function useSessionMessageListFollowing({
  ownerKey,
  scrollSignature,
  enabled = true,
  bottomThreshold = 80,
}: UseSessionMessageListFollowingArgs) {
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageListSignatureRef = useRef("");
  const messageListOwnerKeyRef = useRef<string | null>(null);
  const messageListEnabledRef = useRef(enabled);
  const previousMessageListScrollTopRef = useRef<number | null>(null);
  const [isMessageListFollowing, setIsMessageListFollowing] = useState(true);

  const scrollMessageListToBottom = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    scrollMessageListElementToBottom(messageListElement);
    previousMessageListScrollTopRef.current = Math.max(
      0,
      messageListElement.scrollHeight - messageListElement.clientHeight,
    );
  }, []);

  useLayoutEffect(() => {
    const currentSignature = scrollSignature;
    const wasSameOwner = messageListOwnerKeyRef.current === ownerKey;
    const hasSignatureChanged = messageListSignatureRef.current !== currentSignature;
    const wasEnabled = messageListEnabledRef.current;
    messageListEnabledRef.current = enabled;

    if (!enabled) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      previousMessageListScrollTopRef.current = null;
      return;
    }

    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      previousMessageListScrollTopRef.current = null;
      return;
    }

    if (!wasEnabled) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      previousMessageListScrollTopRef.current = messageListElement.scrollTop;
      setIsMessageListFollowing(true);
      return;
    }

    if (!wasSameOwner) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      setIsMessageListFollowing(true);
      scrollMessageListToBottom();
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    messageListSignatureRef.current = currentSignature;

    if (isMessageListFollowing) {
      scrollMessageListToBottom();
    }
  }, [enabled, isMessageListFollowing, ownerKey, scrollMessageListToBottom, scrollSignature]);

  const handleMessageListScroll = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const currentScrollTop = messageListElement.scrollTop;
    const maxScrollTop = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight);
    const previousScrollTop = previousMessageListScrollTopRef.current ?? maxScrollTop;
    previousMessageListScrollTopRef.current = currentScrollTop;
    const bottomGap = Math.max(0, maxScrollTop - currentScrollTop);
    const isScrollingUp = currentScrollTop < previousScrollTop;
    const isAtBottom = bottomGap <= SESSION_MESSAGE_BOTTOM_EPSILON;
    const nextFollowing = isAtBottom || (!isScrollingUp && bottomGap <= bottomThreshold);

    setIsMessageListFollowing((current) => (current === nextFollowing ? current : nextFollowing));
  }, [bottomThreshold]);

  const handleJumpToMessageListBottom = useCallback(() => {
    setIsMessageListFollowing(true);
    scrollMessageListToBottom();
    window.requestAnimationFrame(scrollMessageListToBottom);
  }, [scrollMessageListToBottom]);

  return {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
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
  return sidePane === "files" && !filesPaneEnabled ? "none" : sidePane;
}

export function useSessionSidePanes({
  ownerKey,
  enabled = true,
  filesPaneEnabled = true,
  initialSidePane = null,
  onSidePaneChange,
}: UseSessionSidePanesArgs) {
  const resolvedInitialSidePane = resolveAvailableSidePane(initialSidePane ?? "none", filesPaneEnabled);
  const [contextRailWidth, setContextRailWidth] = useState(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);
  const [fileExplorerWidth, setFileExplorerWidth] = useState(SESSION_FILE_EXPLORER_DEFAULT_WIDTH);
  const [activeSidePane, setActiveSidePane] = useState<SessionSidePane>(resolvedInitialSidePane);
  const [resizingSidePane, setResizingSidePane] = useState<Exclude<SessionSidePane, "none"> | null>(null);
  const sessionWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const contextRailWidthRef = useRef(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);
  const fileExplorerWidthRef = useRef(SESSION_FILE_EXPLORER_DEFAULT_WIDTH);
  const activeSidePaneRef = useRef<SessionSidePane>(resolvedInitialSidePane);
  const hasResolvedInitialSidePaneRef = useRef(initialSidePane !== null);
  const hasInteractedWithSidePaneRef = useRef(false);
  const sidePanePointerGestureRef = useRef({
    pointerId: null as number | null,
    startX: 0,
    dragged: false,
  });
  const lastSidePaneDragEndAtRef = useRef({ context: 0, files: 0 });

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
    activeSidePaneRef.current = nextSidePane;
    setActiveSidePane(nextSidePane);
  }, [filesPaneEnabled, initialSidePane]);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    const syncSidePaneWidths = () => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }
      const workbenchWidth = measureSessionHorizontalLayoutBounds(workbenchElement).width;
      const nextContextWidth = clampSidePaneWidth(
        contextRailWidthRef.current,
        workbenchWidth,
        SESSION_CONTEXT_RAIL_MIN_WIDTH,
      );
      const nextFileExplorerWidth = clampSidePaneWidth(
        fileExplorerWidthRef.current,
        workbenchWidth,
        SESSION_FILE_EXPLORER_MIN_WIDTH,
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
    if (!enabled || resizingSidePane === null || activeSidePane !== resizingSidePane) {
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

      const bounds = measureSessionHorizontalLayoutBounds(workbenchElement);
      if (isNarrowSessionLayoutViewport()) {
        return;
      }

      if (!gesture.dragged) {
        if (Math.abs(event.clientX - gesture.startX) < SESSION_CONTEXT_RAIL_DRAG_THRESHOLD) {
          return;
        }
        gesture.dragged = true;
      }

      const requestedWidth = resizingSidePane === "files"
        ? event.clientX - bounds.left
        : bounds.right - event.clientX;
      const minWidth = resizingSidePane === "files"
        ? SESSION_FILE_EXPLORER_MIN_WIDTH
        : SESSION_CONTEXT_RAIL_MIN_WIDTH;
      const nextWidth = clampSidePaneWidth(requestedWidth, bounds.width, minWidth);
      if (resizingSidePane === "files") {
        fileExplorerWidthRef.current = nextWidth;
        setFileExplorerWidth(nextWidth);
      } else {
        contextRailWidthRef.current = nextWidth;
        setContextRailWidth(nextWidth);
      }
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
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [activeSidePane, enabled, resizingSidePane]);

  const startSidePaneResize = useCallback((
    sidePane: Exclude<SessionSidePane, "none">,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const workbenchElement = sessionWorkbenchRef.current;
    if (
      !enabled
      || activeSidePane !== sidePane
      || event.button !== 0
      || !workbenchElement
      || isNarrowSessionLayoutViewport()
    ) {
      return;
    }

    event.preventDefault();
    sidePanePointerGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      dragged: false,
    };
    setResizingSidePane(sidePane);
  }, [activeSidePane, enabled]);

  const handleStartContextRailResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => startSidePaneResize("context", event),
    [startSidePaneResize],
  );

  const handleStartFilesPaneResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => startSidePaneResize("files", event),
    [startSidePaneResize],
  );

  const handleToggleContextRailVisibility = useCallback(() => {
    if (
      Date.now() - lastSidePaneDragEndAtRef.current.context
      < SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      return;
    }

    setResizingSidePane(null);
    hasInteractedWithSidePaneRef.current = true;
    const nextSidePane = activeSidePaneRef.current === "context" ? "none" : "context";
    activeSidePaneRef.current = nextSidePane;
    setActiveSidePane(nextSidePane);
    onSidePaneChange?.(nextSidePane);
  }, [onSidePaneChange]);

  const handleToggleFilesPaneVisibility = useCallback(() => {
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
    const nextSidePane = activeSidePaneRef.current === "files" ? "none" : "files";
    activeSidePaneRef.current = nextSidePane;
    setActiveSidePane(nextSidePane);
    onSidePaneChange?.(nextSidePane);
  }, [enabled, filesPaneEnabled, onSidePaneChange]);

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
    isContextRailVisible: activeSidePane === "context",
    isFilesPaneVisible: activeSidePane === "files",
    isContextRailResizing: resizingSidePane === "context",
    isFilesPaneResizing: resizingSidePane === "files",
    handleStartContextRailResize,
    handleStartFilesPaneResize,
    handleToggleContextRailVisibility,
    handleToggleFilesPaneVisibility,
  };
}
