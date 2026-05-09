import { type ComponentProps } from "react";

import {
  SessionChatWindow,
  SessionHeaderHandle,
  type SessionSelectOption,
} from "../session-components.js";

export type ChatWindowProps = ComponentProps<typeof SessionChatWindow>;
export type ChatSelectOption = SessionSelectOption;

// Keep every conversation surface on one chat layout. Feature-specific behavior
// belongs in adapters that build these props, not in separate chat screens.
export function ChatWindow(props: ChatWindowProps) {
  return <SessionChatWindow {...props} />;
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
