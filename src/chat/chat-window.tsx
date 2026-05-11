import { type ComponentProps } from "react";

import {
  SessionActionDockCompactRow,
  SessionChatScreen,
  SessionComposerExpanded,
  SessionHeader,
  SessionHeaderHandle,
  SessionMessageColumn,
  type SessionActionDockCompactRowProps,
  type SessionChatScreenProps,
  type SessionComposerExpandedProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
  type SessionSelectOption,
} from "../session-components.js";

export type ChatWindowProps = Omit<SessionChatScreenProps, "header" | "messageColumn" | "actionDock"> & {
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
      messageColumn={<SessionMessageColumn {...messageColumnProps} />}
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
