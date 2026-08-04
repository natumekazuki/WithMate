import {
  memo,
  useMemo,
  useRef,
  type ComponentProps,
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";

import {
  SESSION_ACTION_DOCK_ID,
  SESSION_HEADER_DOCK_ID,
  SESSION_RIGHT_PANE_ID,
  SESSION_LEFT_PANE_ID,
  SessionActionDockCompactRow,
  SessionChatScreen,
  SessionComposerExpanded,
  SessionHeader,
  SessionHeaderHandle,
  SessionMessageColumn,
  type SessionActionDockCompactRowProps,
  type SessionComposerExpandedProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
  type SessionSelectOption,
} from "../session-components.js";

type ChatScreenProps = ComponentProps<typeof SessionChatScreen>;

export type ChatWindowProps = Omit<
  ChatScreenProps,
  "header" | "messageColumn" | "actionDock" | "isHeaderVisible"
> & {
  isHeaderExpanded: boolean;
  headerProps: SessionHeaderProps;
  messageColumnProps: SessionMessageColumnProps;
  isActionDockExpanded: boolean;
  composerProps: SessionComposerExpandedProps;
  compactActionDockProps: SessionActionDockCompactRowProps;
  mainContent?: ChatScreenProps["mainContent"];
};
export type ChatSelectOption = SessionSelectOption;
export type ChatHeaderHandleProps = ComponentProps<typeof SessionHeaderHandle>;

export type ChatWindowStatusScreenProps = {
  message: string;
  className?: string;
};

export type ChatRightPaneShellProps = {
  ariaLabel: string;
  className?: string;
};

export type ChatDockSplitterProps = {
  edge: "top" | "right" | "bottom" | "left";
  isActive?: boolean;
  isPanelExpanded?: boolean;
  canCollapse?: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onTogglePanel?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  title?: string;
};

type Callback = (...args: any[]) => any;

function useStableOptionalCallback<T extends Callback>(callback: T | undefined): T | undefined {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const hasCallback = callback !== undefined;

  return useMemo(
    () => hasCallback
      ? ((...args: Parameters<T>) => callbackRef.current?.(...args)) as T
      : undefined,
    [hasCallback],
  );
}

const MemoizedSessionMessageColumn = memo(SessionMessageColumn);

export function StableSessionMessageColumn(props: SessionMessageColumnProps) {
  const onMessageListScroll = useStableOptionalCallback(props.onMessageListScroll);
  const onToggleArtifact = useStableOptionalCallback(props.onToggleArtifact);
  const onLoadArtifactDetail = useStableOptionalCallback(props.onLoadArtifactDetail);
  const onOpenDiff = useStableOptionalCallback(props.onOpenDiff);
  const onResolveLiveApproval = useStableOptionalCallback(props.onResolveLiveApproval);
  const onResolveLiveElicitation = useStableOptionalCallback(props.onResolveLiveElicitation);
  const onOpenPath = useStableOptionalCallback(props.onOpenPath);
  const onCopyMessageText = useStableOptionalCallback(props.onCopyMessageText);
  const onQuoteMessageText = useStableOptionalCallback(props.onQuoteMessageText);

  return (
    <MemoizedSessionMessageColumn
      {...props}
      onMessageListScroll={onMessageListScroll!}
      onToggleArtifact={onToggleArtifact!}
      onLoadArtifactDetail={onLoadArtifactDetail}
      onOpenDiff={onOpenDiff!}
      onResolveLiveApproval={onResolveLiveApproval!}
      onResolveLiveElicitation={onResolveLiveElicitation!}
      onOpenPath={onOpenPath}
      getChangedFilesEmptyText={props.getChangedFilesEmptyText}
      onCopyMessageText={onCopyMessageText}
      onQuoteMessageText={onQuoteMessageText}
    />
  );
}

// Keep every conversation surface on one chat layout. Projection builders own
// the feature-specific props and content.
export function ChatWindow({
  isHeaderExpanded,
  headerProps,
  messageColumnProps,
  isActionDockExpanded,
  composerProps,
  compactActionDockProps,
  ...screenProps
}: ChatWindowProps) {
  return (
    <SessionChatScreen
      {...screenProps}
      header={<SessionHeader {...headerProps} />}
      isHeaderVisible={isHeaderExpanded}
      isActionDockExpanded={isActionDockExpanded}
      messageColumn={<StableSessionMessageColumn {...messageColumnProps} />}
      actionDock={(
        <div className={`session-action-dock${isActionDockExpanded ? "" : " compact"}`}>
          <div className="session-action-dock-expanded-content" hidden={!isActionDockExpanded}>
            <SessionComposerExpanded {...composerProps} />
          </div>
          <div hidden={isActionDockExpanded}>
            <SessionActionDockCompactRow {...compactActionDockProps} />
          </div>
        </div>
      )}
    />
  );
}

export function ChatHeaderHandle(props: ChatHeaderHandleProps) {
  return <SessionHeaderHandle {...props} />;
}

export function ChatWindowStatusScreen({ message, className = "" }: ChatWindowStatusScreenProps) {
  return (
    <main className={`page-shell session-page${className ? ` ${className}` : ""}`}>
      <section className="session-work-surface chat-panel" aria-live="polite">
        <p className="session-message-empty">{message}</p>
      </section>
    </main>
  );
}

export function ChatDockSplitter({
  edge,
  isActive = false,
  isPanelExpanded = true,
  canCollapse = true,
  onPointerDown,
  onTogglePanel,
  ariaLabel,
  title,
}: ChatDockSplitterProps) {
  const effectiveTogglePanel = isPanelExpanded && !canCollapse ? undefined : onTogglePanel;
  if (!onPointerDown && !onTogglePanel) {
    return <div className={`session-dock-splitter edge-${edge} is-static`} aria-hidden="true" />;
  }

  const panelLabel = edge === "top"
    ? "ヘッダー"
    : edge === "bottom"
      ? "ActionDock"
      : edge === "left"
        ? "左ペイン"
        : "右ペイン";
  const resolvedAriaLabel = ariaLabel
    ?? (
      effectiveTogglePanel
        ? (isPanelExpanded ? `${panelLabel}を折りたたむ` : `${panelLabel}を展開`)
        : `${panelLabel}のサイズを調整`
    );
  const resolvedTitle = title
    ?? (
      effectiveTogglePanel
        ? (
          isPanelExpanded
            ? (
              onPointerDown
                ? `クリックで${panelLabel}を折りたたみ、ドラッグでサイズを調整`
                : `クリックで${panelLabel}を折りたたみ`
            )
            : `クリックで${panelLabel}を展開`
        )
        : `${panelLabel}のサイズをドラッグで調整`
    );
  const controlledId = edge === "top"
    ? SESSION_HEADER_DOCK_ID
    : edge === "bottom"
      ? SESSION_ACTION_DOCK_ID
      : edge === "left"
        ? SESSION_LEFT_PANE_ID
        : SESSION_RIGHT_PANE_ID;
  const chevronDirection = edge === "top"
    ? (isPanelExpanded ? "up" : "down")
    : edge === "bottom"
      ? (isPanelExpanded ? "down" : "up")
      : edge === "left"
        ? (isPanelExpanded ? "left" : "right")
        : (isPanelExpanded ? "right" : "left");

  return (
    <button
      className={`session-dock-splitter edge-${edge}${!onPointerDown ? " is-toggle-only" : ""}${isActive ? " is-active" : ""}${
        isPanelExpanded ? "" : " is-collapsed"
      }`}
      type="button"
      onPointerDown={isPanelExpanded ? onPointerDown : undefined}
      onClick={effectiveTogglePanel}
      aria-label={resolvedAriaLabel}
      aria-controls={effectiveTogglePanel ? controlledId : undefined}
      aria-expanded={effectiveTogglePanel ? isPanelExpanded : undefined}
      title={resolvedTitle}
    >
      {effectiveTogglePanel ? (
        <span
          className={`session-dock-splitter-chevron direction-${chevronDirection}`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 12 12" focusable="false">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      ) : null}
    </button>
  );
}

export function ChatRightPaneShell({
  ariaLabel,
  className = "",
}: ChatRightPaneShellProps) {
  return (
    <aside
      className={`session-context-pane session-context-pane-header-expanded${
        className ? ` ${className}` : ""
      }`}
      aria-label={ariaLabel}
    />
  );
}
