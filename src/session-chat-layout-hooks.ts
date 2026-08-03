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
const SESSION_FILE_EXPLORER_DEFAULT_WIDTH = 320;
const SESSION_FILE_EXPLORER_MIN_WIDTH = 260;
const SESSION_SIDE_PANE_MAX_WIDTH_RATIO = 0.5;
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

function clampSidePaneWidth(requestedWidth: number, workbenchWidth: number, minWidth: number): number {
  const maxWidth = Math.max(minWidth, workbenchWidth * SESSION_SIDE_PANE_MAX_WIDTH_RATIO);
  return Math.min(maxWidth, Math.max(minWidth, requestedWidth));
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
  const messageListEnabledRef = useRef(enabled);
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
    const wasEnabled = messageListEnabledRef.current;
    messageListEnabledRef.current = enabled;

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

    if (!wasEnabled) {
      messageListOwnerKeyRef.current = ownerKey;
      messageListSignatureRef.current = currentSignature;
      setIsMessageListFollowing(true);
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
      const workbenchWidth = workbenchElement.getBoundingClientRect().width;
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
