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

const SESSION_CONTEXT_RAIL_DEFAULT_WIDTH = 420;
const SESSION_CONTEXT_RAIL_MIN_WIDTH = 360;
const SESSION_CONTEXT_RAIL_MAX_WIDTH = 620;
const SESSION_CONVERSATION_MIN_WIDTH = 760;
const SESSION_LAYOUT_BREAKPOINT = 1400;

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

export type UseSessionContextRailArgs = {
  ownerKey: string | null;
  enabled?: boolean;
};

export function useSessionContextRail({
  ownerKey,
  enabled = true,
}: UseSessionContextRailArgs) {
  const [contextRailWidth, setContextRailWidth] = useState(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);
  const [isContextRailResizing, setIsContextRailResizing] = useState(false);
  const sessionWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const contextRailWidthRef = useRef(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);

  useEffect(() => {
    contextRailWidthRef.current = contextRailWidth;
  }, [contextRailWidth]);

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
    if (!enabled || !isContextRailResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }

      const bounds = workbenchElement.getBoundingClientRect();
      if (bounds.width < SESSION_LAYOUT_BREAKPOINT) {
        return;
      }

      const requestedWidth = bounds.right - event.clientX;
      const nextWidth = clampContextRailWidth(requestedWidth, bounds.width);
      contextRailWidthRef.current = nextWidth;
      setContextRailWidth(nextWidth);
    };

    const handlePointerEnd = () => {
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
  }, [enabled, isContextRailResizing]);

  const handleStartContextRailResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    setIsContextRailResizing(true);
  }, []);

  const sessionWorkbenchStyle = useMemo(
    () => ({
      ["--session-context-rail-width" as string]: `${contextRailWidth}px`,
    }) as CSSProperties,
    [contextRailWidth],
  );

  return {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailResizing,
    handleStartContextRailResize,
  };
}
