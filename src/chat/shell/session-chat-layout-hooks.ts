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
import { normalizeSessionSidePane, type SessionSidePane } from "../../../src-shared/settings/session-side-pane.js";
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
const SESSION_TERMINAL_DOCK_DEFAULT_HEIGHT = 240;
const SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT = 60;
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
  paneMinimum: number,
  centralMinimum: number,
): number {
  const maxWidth = Math.max(
    0,
    workbenchWidth
      - Math.max(0, oppositeWidth)
      - Math.max(0, centralMinimum)
      - SESSION_HORIZONTAL_SPLITTER_SIZE * 2,
  );
  return Math.min(maxWidth, Math.max(0, Math.max(paneMinimum, requestedWidth)));
}

function isNarrowSessionLayoutViewport(): boolean {
  return window.innerWidth < SESSION_LAYOUT_VIEWPORT_BREAKPOINT;
}

function readSessionRegionMinimum(layout: HTMLElement, selector: string, property: string): number {
  const element = layout.querySelector<HTMLElement>(selector);
  if (!element) {
    return 0;
  }
  const value = Number.parseFloat(window.getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function measureVisibleHeaderDockHeight(layout: HTMLElement, isHeaderExpanded: boolean): number {
  if (!isHeaderExpanded) {
    return 0;
  }
  return layout.querySelector<HTMLElement>(".session-header-dock-slot")?.getBoundingClientRect().height
    ?? SESSION_HEADER_DOCK_DEFAULT_HEIGHT;
}

function measureNarrowSideTracks(layout: HTMLElement, includeSidePane = true): number {
  if (!isNarrowSessionLayoutViewport()) return 0;
  const styles = window.getComputedStyle(layout);
  const sideHeight = includeSidePane
    ? (layout.classList.contains("is-left-pane-visible")
      ? readCssPixelValue(styles.getPropertyValue("--session-file-explorer-width")) || SESSION_FILE_EXPLORER_DEFAULT_WIDTH : 0)
      + (layout.classList.contains("is-right-pane-visible")
        ? readCssPixelValue(styles.getPropertyValue("--session-context-rail-width")) || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0)
    : 0;
  return sideHeight + 2 * (readCssPixelValue(styles.getPropertyValue("--session-dock-splitter-size")) || 20);
}

function measureSidePaneAvailableSize(layout: HTMLElement): number {
  if (!isNarrowSessionLayoutViewport()) {
    return measureSessionHorizontalLayoutBounds(layout).width;
  }
  const header = layout.querySelector<HTMLElement>(".session-header-dock-slot");
  const headerHeight = header && !header.classList.contains("is-hidden")
    ? header.getBoundingClientRect().height : 0;
  const actionDockHeight = layout.querySelector<HTMLElement>(".session-action-dock-slot")?.getBoundingClientRect().height ?? 0;
  const terminalDockHeight = layout.querySelector<HTMLElement>(".session-terminal-dock-slot")?.getBoundingClientRect().height ?? 0;
  return Math.max(0, measureSessionVerticalDockLayoutBounds(layout).height
    - headerHeight - actionDockHeight - terminalDockHeight - SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT);
}

function measureSidePaneMinimums(layout: HTMLElement, sidePane: "files" | "context") {
  const isNarrow = isNarrowSessionLayoutViewport();
  const paneSelector = sidePane === "files" ? ".session-left-pane-slot" : ".session-right-pane-slot";
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

export function useChatLayoutPresentation(input: {
  initialHeader: ChatHeaderVisibility | null;
  initialActionDock: ChatActionDockMode | null;
  onHeaderChange?: (value: ChatHeaderVisibility) => void;
  onActionDockChange?: (value: ChatActionDockMode) => void;
}) {
  const initialHeaderExpanded = input.initialHeader === "visible";
  const initialActionDockExpanded = input.initialActionDock === "expanded";
  const [isHeaderExpanded, setHeaderExpandedState] = useState(initialHeaderExpanded);
  const [isActionDockPinnedExpanded, setActionDockExpandedState] = useState(initialActionDockExpanded);
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

  const setIsActionDockPinnedExpanded = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(actionDockExpandedRef.current) : next;
    actionDockInteractedRef.current = true;
    actionDockIntentRevisionRef.current += 1;
    if (actionDockExpandedRef.current === resolved) {
      return;
    }
    actionDockExpandedRef.current = resolved;
    setActionDockExpandedState(resolved);
    input.onActionDockChange?.(resolved ? "expanded" : "compact");
  }, [input.onActionDockChange]);

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
  oppositeDockHeight: number;
}): number {
  const maxHeight = Math.max(0, input.layoutHeight - input.oppositeDockHeight
    - SESSION_VERTICAL_SPLITTER_TOTAL_HEIGHT);
  const minHeight = Math.min(input.minHeight, maxHeight);
  return Math.min(maxHeight, Math.max(minHeight, input.requestedHeight));
}

export function allocateSessionVerticalDockHeights(input: {
  availableHeight: number;
  actionRequested: number;
  actionMinimum: number;
  terminalRequested: number;
  terminalMinimum: number;
  preferTerminal: boolean;
}): { action: number; terminal: number } {
  const available = Math.max(0, input.availableHeight);
  const firstMinimum = input.preferTerminal ? input.terminalMinimum : input.actionMinimum;
  const secondMinimum = input.preferTerminal ? input.actionMinimum : input.terminalMinimum;
  const firstRequested = input.preferTerminal ? input.terminalRequested : input.actionRequested;
  const secondRequested = input.preferTerminal ? input.actionRequested : input.terminalRequested;
  const first = Math.min(Math.max(0, available - secondMinimum), Math.max(firstMinimum, firstRequested));
  const second = Math.min(Math.max(0, available - first), Math.max(secondMinimum, secondRequested));
  return input.preferTerminal ? { action: second, terminal: first } : { action: first, terminal: second };
}

export function useSessionVerticalDockResize(input: {
  ownerKey: string | null;
  isHeaderExpanded: boolean;
  isActionDockExpanded: boolean;
  isTerminalDockExpanded?: boolean;
  sidePaneLayoutKey?: string;
}) {
  const [actionDockHeight, setActionDockHeight] = useState(SESSION_ACTION_DOCK_DEFAULT_HEIGHT);
  const [terminalDockHeight, setTerminalDockHeight] = useState(SESSION_TERMINAL_DOCK_DEFAULT_HEIGHT);
  const [actionDockCompactHeight, setActionDockCompactHeight] = useState(
    SESSION_ACTION_DOCK_COMPACT_DEFAULT_HEIGHT,
  );
  const [isActionDockResizing, setIsActionDockResizing] = useState(false);
  const [isTerminalDockResizing, setIsTerminalDockResizing] = useState(false);
  const [isSidePaneBudgetCollapsed, setIsSidePaneBudgetCollapsed] = useState(false);
  const isSidePaneBudgetCollapsedRef = useRef(false);
  const sessionDockLayoutRef = useRef<HTMLDivElement | null>(null);
  const headerDockRef = useRef<HTMLDivElement | null>(null);
  const actionDockRef = useRef<HTMLDivElement | null>(null);
  const terminalDockRef = useRef<HTMLDivElement | null>(null);
  const actionDockHeightRef = useRef(SESSION_ACTION_DOCK_DEFAULT_HEIGHT);
  const terminalDockHeightRef = useRef(SESSION_TERMINAL_DOCK_DEFAULT_HEIGHT);
  const previousExpandedRef = useRef({ action: input.isActionDockExpanded, terminal: !!input.isTerminalDockExpanded });
  const pointerGestureRef = useRef({
    pointerId: null as number | null,
    startY: 0,
    startHeight: SESSION_ACTION_DOCK_DEFAULT_HEIGHT,
    dragged: false,
  });
  const lastActionDockDragEndAtRef = useRef(0);
  const terminalPointerGestureRef = useRef({ pointerId: null as number | null, startY: 0, startHeight: SESSION_TERMINAL_DOCK_DEFAULT_HEIGHT, dragged: false });
  const lastTerminalDockDragEndAtRef = useRef(0);

  useEffect(() => {
    actionDockHeightRef.current = actionDockHeight;
  }, [actionDockHeight]);

  useEffect(() => {
    terminalDockHeightRef.current = terminalDockHeight;
  }, [terminalDockHeight]);

  const clampDockHeights = useCallback(() => {
    const layout = sessionDockLayoutRef.current;
    if (!layout) {
      return;
    }

    const layoutHeight = measureSessionVerticalDockLayoutBounds(layout).height;
    if (layoutHeight <= 0) {
      return;
    }
    const visibleHeaderHeight = measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded);
    const splitterHeight = readSessionRegionMinimum(layout, ".session-chat-layout", "--session-dock-splitter-size") || 20;
    const actionMinimum = input.isActionDockExpanded
      ? readSessionRegionMinimum(layout, ".session-action-dock-slot", "--session-region-min-height")
      : actionDockCompactHeight;
    const terminalMinimum = input.isTerminalDockExpanded
      ? readSessionRegionMinimum(layout, ".session-terminal-dock-slot", "--session-region-min-height")
      : 0;
    const availableWithSide = Math.max(0, layoutHeight - visibleHeaderHeight - splitterHeight * 3 - measureNarrowSideTracks(layout));
    const collapseSide = isNarrowSessionLayoutViewport() && availableWithSide < actionMinimum + terminalMinimum;
    isSidePaneBudgetCollapsedRef.current = collapseSide;
    setIsSidePaneBudgetCollapsed(collapseSide);
    const totalAvailable = collapseSide
      ? Math.max(0, layoutHeight - visibleHeaderHeight - splitterHeight * 3 - measureNarrowSideTracks(layout, false))
      : availableWithSide;
    const actionRequested = input.isActionDockExpanded ? actionDockHeightRef.current : actionDockCompactHeight;
    const terminalRequested = input.isTerminalDockExpanded ? terminalDockHeightRef.current : 0;
    const previous = previousExpandedRef.current;
    const preferTerminal = !!input.isTerminalDockExpanded && !previous.terminal;
    previousExpandedRef.current = { action: input.isActionDockExpanded, terminal: !!input.isTerminalDockExpanded };
    const firstTerminal = preferTerminal || (!!input.isTerminalDockExpanded && !input.isActionDockExpanded);
    const { action: nextActionDockHeight, terminal: nextTerminalDockHeight } = allocateSessionVerticalDockHeights({
      availableHeight: totalAvailable,
      actionRequested,
      actionMinimum,
      terminalRequested,
      terminalMinimum,
      preferTerminal: firstTerminal,
    });
    if (input.isActionDockExpanded) {
      actionDockHeightRef.current = nextActionDockHeight;
      setActionDockHeight((current) => current === nextActionDockHeight ? current : nextActionDockHeight);
    }
    if (input.isTerminalDockExpanded) {
      terminalDockHeightRef.current = nextTerminalDockHeight;
      setTerminalDockHeight((current) => current === nextTerminalDockHeight ? current : nextTerminalDockHeight);
    }
  }, [actionDockCompactHeight, input.isActionDockExpanded, input.isHeaderExpanded, input.isTerminalDockExpanded, input.sidePaneLayoutKey]);

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
      const oppositeHeight = measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded)
        + measureNarrowSideTracks(layout, !isSidePaneBudgetCollapsedRef.current)
        + (input.isTerminalDockExpanded ? terminalDockHeightRef.current : 0);
      const nextHeight = clampSessionVerticalDockHeight({
        requestedHeight: gesture.startHeight + gesture.startY - event.clientY,
        layoutHeight: bounds.height,
        minHeight: readSessionRegionMinimum(layout, ".session-action-dock-slot", "--session-region-min-height"),
        oppositeDockHeight: oppositeHeight,
      });
      actionDockHeightRef.current = nextHeight;
      layout.style.setProperty("--session-action-dock-height", `${nextHeight}px`);
    };

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
  }, [input.isActionDockExpanded, input.isHeaderExpanded, input.isTerminalDockExpanded, isActionDockResizing]);

  useEffect(() => {
    if (!isTerminalDockResizing) return;
    const handleMove = (event: PointerEvent) => {
      const gesture = terminalPointerGestureRef.current;
      const layout = sessionDockLayoutRef.current;
      if (gesture.pointerId !== event.pointerId || !layout) return;
      if (!gesture.dragged && Math.abs(event.clientY - gesture.startY) < SESSION_CONTEXT_RAIL_DRAG_THRESHOLD) return;
      gesture.dragged = true;
      const next = clampSessionVerticalDockHeight({
        requestedHeight: gesture.startHeight + gesture.startY - event.clientY,
        layoutHeight: measureSessionVerticalDockLayoutBounds(layout).height,
        minHeight: readSessionRegionMinimum(layout, ".session-terminal-dock-slot", "--session-region-min-height"),
        oppositeDockHeight: measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded)
          + measureNarrowSideTracks(layout, !isSidePaneBudgetCollapsedRef.current)
          + (input.isActionDockExpanded ? actionDockHeightRef.current : actionDockCompactHeight),
      });
      terminalDockHeightRef.current = next;
      layout.style.setProperty("--session-terminal-dock-height", `${next}px`);
    };
    const handleEnd = (event: PointerEvent) => {
      if (terminalPointerGestureRef.current.pointerId !== event.pointerId) return;
      if (terminalPointerGestureRef.current.dragged) {
        lastTerminalDockDragEndAtRef.current = Date.now();
        setTerminalDockHeight(terminalDockHeightRef.current);
      }
      terminalPointerGestureRef.current.pointerId = null;
      setIsTerminalDockResizing(false);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [actionDockCompactHeight, input.isActionDockExpanded, input.isHeaderExpanded, isTerminalDockResizing]);

  const handleStartActionDockResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !sessionDockLayoutRef.current || !input.isActionDockExpanded) {
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
  }, [input.isActionDockExpanded]);
  const handleHeaderSplitterClick = useCallback((toggle: () => void) => {
    toggle();
  }, []);
  const handleActionDockSplitterClick = useCallback((toggle: () => void) => {
    if (Date.now() - lastActionDockDragEndAtRef.current >= SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS) {
      toggle();
    }
  }, []);
  const handleStartTerminalDockResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !sessionDockLayoutRef.current || !input.isTerminalDockExpanded) return;
    event.preventDefault();
    terminalPointerGestureRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: terminalDockHeightRef.current, dragged: false };
    setIsTerminalDockResizing(true);
  }, [input.isTerminalDockExpanded]);
  const handleTerminalDockSplitterClick = useCallback((toggle: () => void) => {
    if (Date.now() - lastTerminalDockDragEndAtRef.current >= SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS) toggle();
  }, []);
  const handleTerminalDockKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!input.isTerminalDockExpanded || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const layout = sessionDockLayoutRef.current;
    if (!layout) return;
    event.preventDefault();
    const next = clampSessionVerticalDockHeight({
      requestedHeight: terminalDockHeightRef.current + (event.key === "ArrowUp" ? 20 : -20),
      layoutHeight: measureSessionVerticalDockLayoutBounds(layout).height,
      minHeight: readSessionRegionMinimum(layout, ".session-terminal-dock-slot", "--session-region-min-height"),
      oppositeDockHeight: measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded)
        + measureNarrowSideTracks(layout, !isSidePaneBudgetCollapsedRef.current)
        + (input.isActionDockExpanded ? actionDockHeightRef.current : actionDockCompactHeight),
    });
    terminalDockHeightRef.current = next;
    setTerminalDockHeight(next);
  }, [actionDockCompactHeight, input.isActionDockExpanded, input.isHeaderExpanded, input.isTerminalDockExpanded]);
  const handleActionDockKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!input.isActionDockExpanded || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const layout = sessionDockLayoutRef.current;
    if (!layout) return;
    event.preventDefault();
    const next = clampSessionVerticalDockHeight({
      requestedHeight: actionDockHeightRef.current + (event.key === "ArrowUp" ? 20 : -20),
      layoutHeight: measureSessionVerticalDockLayoutBounds(layout).height,
      minHeight: readSessionRegionMinimum(layout, ".session-action-dock-slot", "--session-region-min-height"),
      oppositeDockHeight: measureVisibleHeaderDockHeight(layout, input.isHeaderExpanded)
        + measureNarrowSideTracks(layout, !isSidePaneBudgetCollapsedRef.current)
        + (input.isTerminalDockExpanded ? terminalDockHeightRef.current : 0),
    });
    actionDockHeightRef.current = next;
    setActionDockHeight(next);
  }, [input.isActionDockExpanded, input.isHeaderExpanded, input.isTerminalDockExpanded]);

  const sessionDockLayoutStyle = useMemo(() => ({
    ["--session-action-dock-height" as string]: `${actionDockHeight}px`,
    ["--session-terminal-dock-height" as string]: `${terminalDockHeight}px`,
    ["--session-action-dock-compact-height" as string]: `${actionDockCompactHeight}px`,
  }) as CSSProperties, [actionDockCompactHeight, actionDockHeight, terminalDockHeight]);

  return {
    sessionDockLayoutRef,
    headerDockRef,
    actionDockRef,
    terminalDockRef,
    sessionDockLayoutStyle,
    isActionDockResizing,
    isTerminalDockResizing,
    isSidePaneBudgetCollapsed,
    handleStartActionDockResize,
    handleHeaderSplitterClick,
    handleActionDockSplitterClick,
    handleStartTerminalDockResize,
    handleTerminalDockSplitterClick,
    handleTerminalDockKeyDown,
    handleActionDockKeyDown,
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
  }, [enabled, ownerKey, scrollMessageListToBottom]);

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
  sidePane = normalizeSessionSidePane(sidePane);
  if (filesPaneEnabled || sidePane !== "files") {
    return sidePane;
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
  const requestedInitialSidePane = initialSidePane as string | null;
  const resolvedInitialSidePane = resolveAvailableSidePane(
    normalizeSessionSidePane(requestedInitialSidePane),
    filesPaneEnabled,
  );
  const initialContextVisible = resolvedInitialSidePane === "context";
  const initialFilesVisible = resolvedInitialSidePane === "files" && filesPaneEnabled;
  const [contextRailWidth, setContextRailWidth] = useState(
    initialContextVisible ? SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : 0,
  );
  const [fileExplorerWidth, setFileExplorerWidth] = useState(
    initialFilesVisible ? SESSION_FILE_EXPLORER_DEFAULT_WIDTH : 0,
  );
  const [activeSidePane, setActiveSidePane] = useState<SessionSidePane>(resolvedInitialSidePane);
  const [resizingSidePane, setResizingSidePane] = useState<Exclude<SessionSidePane, "none"> | null>(null);
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

  const activeSidePaneRef = useRef<SessionSidePane>(resolvedInitialSidePane);
  const isContextRailVisible = activeSidePane === "context";
  const isFilesPaneVisible = filesPaneEnabled && activeSidePane === "files";
  const reportedSidePaneRef = useRef<SessionSidePane>(activeSidePane);

  const notifySidePaneVisibility = useCallback((context: boolean, files: boolean) => {
    const nextSidePane = context ? "context" : files ? "files" : "none";
    activeSidePaneRef.current = nextSidePane;
    setActiveSidePane(nextSidePane);
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

    const nextSidePane = resolveAvailableSidePane(
      normalizeSessionSidePane(initialSidePane),
      filesPaneEnabled,
    );
    const nextContextVisible = nextSidePane === "context";
    const nextFilesVisible = nextSidePane === "files";
    const nextContextWidth = nextContextVisible ? contextRailWidthRef.current || SESSION_CONTEXT_RAIL_DEFAULT_WIDTH : contextRailWidthRef.current;
    const nextFilesWidth = nextFilesVisible && filesPaneEnabled
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

    const syncSidePaneWidths = () => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }
      if (workbenchElement.classList.contains("is-side-pane-budget-collapsed")) {
        return;
      }
      const workbenchWidth = measureSidePaneAvailableSize(workbenchElement);
      if (workbenchWidth <= 0) {
        return;
      }
      const contextMinimums = measureSidePaneMinimums(workbenchElement, "context");
      const filesMinimums = measureSidePaneMinimums(workbenchElement, "files");
      const nextContextWidth = clampSidePaneWidth(
        contextRailWidthRef.current,
        workbenchWidth,
        activeSidePaneRef.current === "files" ? fileExplorerWidthRef.current : 0,
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
      const usableSize = measureSidePaneAvailableSize(workbenchElement);
      const minimums = measureSidePaneMinimums(workbenchElement, resizingSidePane);

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
        0,
        minimums.paneMinimum,
        minimums.centralMinimum,
      );
      if (resizingSidePane === "files") {
        fileExplorerWidthRef.current = nextWidth;
        workbenchElement.style.setProperty("--session-file-explorer-width", `${nextWidth}px`);
      } else {
        contextRailWidthRef.current = nextWidth;
        workbenchElement.style.setProperty("--session-context-rail-width", `${nextWidth}px`);
      }
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = sidePanePointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }

      if (gesture.dragged) {
        lastSidePaneDragEndAtRef.current[resizingSidePane] = Date.now();
        if (resizingSidePane === "files") setFileExplorerWidth(fileExplorerWidthRef.current);
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
    document.body.style.cursor = isNarrowSessionLayoutViewport() ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [enabled, resizingSidePane]);

  const startSidePaneResize = useCallback((
    sidePane: Exclude<SessionSidePane, "none">,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const workbenchElement = sessionWorkbenchRef.current;
    if (
      !enabled
      || event.button !== 0
      || !workbenchElement
      || activeSidePaneRef.current !== sidePane
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
    if (!enabled || !isContextRailVisible || !validKey) {
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
  }, [enabled, isContextRailVisible, notifySidePaneVisibility]);

  const handleKeyDownFilesPaneResize = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const isNarrow = isNarrowSessionLayoutViewport();
    const validKey = isNarrow
      ? event.key === "ArrowUp" || event.key === "ArrowDown"
      : event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!enabled || !filesPaneEnabled || !isFilesPaneVisible || !validKey) {
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
  }, [enabled, filesPaneEnabled, isFilesPaneVisible, notifySidePaneVisibility]);

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
    const minimums = workbenchElement ? measureSidePaneMinimums(workbenchElement, "context") : { paneMinimum: 0, centralMinimum: 0 };
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
      Date.now() - lastSidePaneDragEndAtRef.current.files
      < SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
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
    const minimums = workbenchElement ? measureSidePaneMinimums(workbenchElement, "files") : { paneMinimum: 0, centralMinimum: 0 };
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
  }, [enabled, filesPaneEnabled, handleCollapseFilesPane, notifySidePaneVisibility]);

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
    handleToggleContextRailVisibility,
    handleToggleFilesPaneVisibility,
  };
}
