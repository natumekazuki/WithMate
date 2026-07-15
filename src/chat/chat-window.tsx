import { memo, useMemo, useRef, type ComponentProps, type PointerEventHandler } from "react";

import {
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
  isActive?: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
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
  isActive = false,
  onPointerDown,
  ariaLabel = "会話と command pane の幅を調整",
  title = "左右の幅をドラッグで調整",
}: ChatWorkbenchSplitterProps) {
  if (!onPointerDown) {
    return <div className="session-workbench-splitter" aria-hidden="true" />;
  }

  return (
    <button
      className={`session-workbench-splitter${isActive ? " is-active" : ""}`}
      type="button"
      onPointerDown={onPointerDown}
      aria-label={ariaLabel}
      title={title}
    />
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
