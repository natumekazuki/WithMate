import {
  memo,
  useMemo,
  useRef,
  type ComponentProps,
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";

import {
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

export type ChatWindowProps = Omit<ChatScreenProps, "header" | "messageColumn" | "actionDock"> & {
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
  isHeaderExpanded: boolean;
  headerHandleTitle: string;
  ariaLabel: string;
  className?: string;
  onToggleHeaderExpanded: () => void;
};

export type ChatWorkbenchSplitterProps = {
  side?: "left" | "right";
  isActive?: boolean;
  isRightPaneVisible?: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onToggleRightPane?: MouseEventHandler<HTMLButtonElement>;
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
      header={isHeaderExpanded ? <SessionHeader {...headerProps} /> : null}
      messageColumn={<StableSessionMessageColumn {...messageColumnProps} />}
      actionDock={(
        <div className={`session-action-dock${isActionDockExpanded ? "" : " compact"}`}>
          {isActionDockExpanded ? (
            <SessionComposerExpanded {...composerProps} />
          ) : (
            <SessionActionDockCompactRow {...compactActionDockProps} />
          )}
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

export function ChatWorkbenchSplitter({
  side = "right",
  isActive = false,
  isRightPaneVisible = true,
  onPointerDown,
  onToggleRightPane,
  ariaLabel,
  title,
}: ChatWorkbenchSplitterProps) {
  if (!onPointerDown && !onToggleRightPane) {
    return <div className="session-workbench-splitter is-static" aria-hidden="true" />;
  }

  const paneLabel = side === "left" ? "左ペイン" : "右ペイン";
  const resolvedAriaLabel = ariaLabel
    ?? (
      onToggleRightPane
        ? (isRightPaneVisible ? `${paneLabel}を非表示` : `${paneLabel}を表示`)
        : "会話と command pane の幅を調整"
    );
  const resolvedTitle = title
    ?? (
      onToggleRightPane
        ? (
          isRightPaneVisible && onPointerDown
            ? "クリックで右ペインを非表示、広い画面ではドラッグで幅を調整"
            : "クリックで右ペインを表示"
        )
        : "左右の幅をドラッグで調整"
    );

  return (
    <button
      className={`session-workbench-splitter${isActive ? " is-active" : ""}${
        isRightPaneVisible ? "" : " is-collapsed"
      }`}
      type="button"
      onPointerDown={onPointerDown}
      onClick={onToggleRightPane}
      aria-label={resolvedAriaLabel}
      aria-controls={onToggleRightPane ? (side === "left" ? SESSION_LEFT_PANE_ID : SESSION_RIGHT_PANE_ID) : undefined}
      aria-expanded={onToggleRightPane ? isRightPaneVisible : undefined}
      title={resolvedTitle}
    >
      {onToggleRightPane ? (
        <span className="session-workbench-splitter-chevron" aria-hidden="true">
          {side === "left"
            ? (isRightPaneVisible ? "‹" : "›")
            : (isRightPaneVisible ? "›" : "‹")}
        </span>
      ) : null}
    </button>
  );
}

export function ChatRightPaneShell({
  isHeaderExpanded,
  headerHandleTitle,
  ariaLabel,
  className = "",
  onToggleHeaderExpanded,
}: ChatRightPaneShellProps) {
  return (
    <aside
      className={`session-context-pane${isHeaderExpanded ? " session-context-pane-header-expanded" : ""}${
        className ? ` ${className}` : ""
      }`}
      aria-label={ariaLabel}
    >
      {!isHeaderExpanded ? <ChatHeaderHandle taskTitle={headerHandleTitle} onClick={onToggleHeaderExpanded} /> : null}
    </aside>
  );
}
