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

// Keep every conversation surface on one chat layout. Feature-specific behavior
// belongs in adapters that build these props, not in separate chat screens.
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

export function ChatHeaderHandle(props: ComponentProps<typeof SessionHeaderHandle>) {
  return <SessionHeaderHandle {...props} />;
}

export {
  ChatWindow as SessionChatWindow,
  ChatHeaderHandle as SessionHeaderHandle,
  type ChatWindowProps as SessionChatWindowProps,
  type ChatSelectOption as SessionSelectOption,
};
