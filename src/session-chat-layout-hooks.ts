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

const SESSION_CONTEXT_RAIL_DEFAULT_WIDTH = 420;
const SESSION_CONTEXT_RAIL_MIN_WIDTH = 360;
const SESSION_CONTEXT_RAIL_MAX_WIDTH = 620;
const SESSION_CONVERSATION_MIN_WIDTH = 760;
const SESSION_LAYOUT_VIEWPORT_BREAKPOINT = 1400;
const SESSION_CONTEXT_RAIL_DRAG_THRESHOLD = 4;
const SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS = 100;

function scrollMessageListElementToBottom(messageListElement: HTMLDivElement): void {
  const bottomAnchor = messageListElement.querySelector<HTMLElement>(".message-list-bottom-anchor");
  if (bottomAnchor) {
    bottomAnchor.scrollIntoView({ block: "end" });
    return;
  }

  messageListElement.scrollTop = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight);
}

function clampContextRailWidth(requestedWidth: number, workbenchWidth: number): number {
  const maxWidth = Math.min(
    SESSION_CONTEXT_RAIL_MAX_WIDTH,
    Math.max(SESSION_CONTEXT_RAIL_MIN_WIDTH, workbenchWidth - SESSION_CONVERSATION_MIN_WIDTH),
  );

  return Math.min(maxWidth, Math.max(SESSION_CONTEXT_RAIL_MIN_WIDTH, requestedWidth));
}

function isNarrowSessionLayoutViewport(): boolean {
  return window.innerWidth < SESSION_LAYOUT_VIEWPORT_BREAKPOINT;
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
  const [isMessageListFollowing, setIsMessageListFollowing] = useState(true);

  const scrollMessageListToBottom = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    scrollMessageListElementToBottom(messageListElement);
  }, []);

  useLayoutEffect(() => {
    const currentSignature = scrollSignature;
    const wasSameOwner = messageListOwnerKeyRef.current === ownerKey;
    const hasSignatureChanged = messageListSignatureRef.current !== currentSignature;

    if (!enabled) {
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

    if (!wasSameOwner) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      setIsMessageListFollowing(true);
      scrollMessageListElementToBottom(messageListElement);
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    messageListSignatureRef.current = currentSignature;

    if (isMessageListFollowing) {
      scrollMessageListElementToBottom(messageListElement);
    }
  }, [enabled, isMessageListFollowing, ownerKey, scrollSignature]);

  const handleMessageListScroll = useCallback(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const bottomGap = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight - messageListElement.scrollTop);
    const nextFollowing = bottomGap <= bottomThreshold;

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
  const [activeSidePane, setActiveSidePane] = useState<SessionSidePane>(resolvedInitialSidePane);
  const [isContextRailResizing, setIsContextRailResizing] = useState(false);
  const sessionWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const contextRailWidthRef = useRef(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);
  const activeSidePaneRef = useRef<SessionSidePane>(resolvedInitialSidePane);
  const hasResolvedInitialSidePaneRef = useRef(initialSidePane !== null);
  const hasInteractedWithSidePaneRef = useRef(false);
  const contextRailPointerGestureRef = useRef({
    pointerId: null as number | null,
    startX: 0,
    dragged: false,
  });
  const lastContextRailDragEndAtRef = useRef(0);

  useEffect(() => {
    contextRailWidthRef.current = contextRailWidth;
  }, [contextRailWidth]);

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

    const syncContextRailWidth = () => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }

      const nextWidth = clampContextRailWidth(
        contextRailWidthRef.current,
        workbenchElement.getBoundingClientRect().width,
      );
      contextRailWidthRef.current = nextWidth;
      setContextRailWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    syncContextRailWidth();
    window.addEventListener("resize", syncContextRailWidth);
    return () => window.removeEventListener("resize", syncContextRailWidth);
  }, [enabled, ownerKey]);

  useEffect(() => {
    if (!enabled || activeSidePane !== "context" || !isContextRailResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = contextRailPointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }

      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }

      const bounds = workbenchElement.getBoundingClientRect();
      if (isNarrowSessionLayoutViewport()) {
        return;
      }

      if (!gesture.dragged) {
        if (Math.abs(event.clientX - gesture.startX) < SESSION_CONTEXT_RAIL_DRAG_THRESHOLD) {
          return;
        }
        gesture.dragged = true;
      }

      const requestedWidth = bounds.right - event.clientX;
      const nextWidth = clampContextRailWidth(requestedWidth, bounds.width);
      contextRailWidthRef.current = nextWidth;
      setContextRailWidth(nextWidth);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = contextRailPointerGestureRef.current;
      if (gesture.pointerId !== event.pointerId) {
        return;
      }

      if (gesture.dragged) {
        lastContextRailDragEndAtRef.current = Date.now();
      }
      gesture.pointerId = null;
      gesture.dragged = false;
      setIsContextRailResizing(false);
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
  }, [activeSidePane, enabled, isContextRailResizing]);

  const handleStartContextRailResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const workbenchElement = sessionWorkbenchRef.current;
    if (
      !enabled
      || activeSidePane !== "context"
      || event.button !== 0
      || !workbenchElement
      || isNarrowSessionLayoutViewport()
    ) {
      return;
    }

    event.preventDefault();
    contextRailPointerGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      dragged: false,
    };
    setIsContextRailResizing(true);
  }, [activeSidePane, enabled]);

  const handleToggleContextRailVisibility = useCallback(() => {
    if (
      Date.now() - lastContextRailDragEndAtRef.current
      < SESSION_CONTEXT_RAIL_DRAG_CLICK_SUPPRESSION_MS
    ) {
      return;
    }

    setIsContextRailResizing(false);
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

    setIsContextRailResizing(false);
    hasInteractedWithSidePaneRef.current = true;
    const nextSidePane = activeSidePaneRef.current === "files" ? "none" : "files";
    activeSidePaneRef.current = nextSidePane;
    setActiveSidePane(nextSidePane);
    onSidePaneChange?.(nextSidePane);
  }, [enabled, filesPaneEnabled, onSidePaneChange]);

  const sessionWorkbenchStyle = useMemo(
    () => ({
      ["--session-context-rail-width" as string]: `${contextRailWidth}px`,
    }) as CSSProperties,
    [contextRailWidth],
  );

  return {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    activeSidePane,
    isContextRailVisible: activeSidePane === "context",
    isFilesPaneVisible: activeSidePane === "files",
    isContextRailResizing,
    handleStartContextRailResize,
    handleToggleContextRailVisibility,
    handleToggleFilesPaneVisibility,
  };
}
