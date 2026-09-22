import type { ReactNode } from "react";

import type { CharacterProfile } from "../../../src-shared/character/character-state.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { ChatWindowProps } from "../chat-window.js";
import {
  buildLiveSessionMessageColumnProps,
} from "../chat-window-adapter.js";
import {
  buildLiveSessionCommonMessageColumnProps,
  type LiveSessionCommonMessageColumnInput,
} from "../live-session-projection.js";

export type SessionChatConversationFeatureInput = Omit<
  LiveSessionCommonMessageColumnInput,
  "sessionId" | "character" | "messages" | "isContentActive"
> & {
  sessionId: string;
  character: CharacterProfile;
  messages: Message[];
  mainContent?: ReactNode;
};

export type SessionChatConversationFeature = ChatWindowProps["messageColumnProps"];

/** The conversation owner projects messages and live requests for ChatWindow. */
export function buildSessionChatConversationFeature(
  input: SessionChatConversationFeatureInput,
): SessionChatConversationFeature {
  return buildLiveSessionMessageColumnProps(
    buildLiveSessionCommonMessageColumnProps({
      ...input,
      isContentActive: input.mainContent === undefined,
    }),
  );
}
