import { useMemo, useState, type ReactNode } from "react";

import type { CharacterProfile } from "../../../src-shared/character/character-state.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { ChatWindowProps } from "../chat-window.js";
import { createExpandedArtifactToggleHandler } from "../session-shell-handlers.js";
import {
  buildLiveSessionMessageColumnProps,
} from "../chat-window-adapter.js";
import {
  buildLiveSessionCommonMessageColumnProps,
  type LiveSessionCommonMessageColumnInput,
} from "../live-session-projection.js";

export type SessionChatConversationFeatureInput = Omit<
  LiveSessionCommonMessageColumnInput,
  "sessionId" | "character" | "messages" | "isContentActive" | "expandedArtifacts" | "onToggleArtifact"
> & {
  sessionId: string;
  character: CharacterProfile;
  messages: Message[];
  mainContent?: ReactNode;
};

export type SessionChatConversationFeature = ChatWindowProps["messageColumnProps"];

/** Owns artifact expansion and projects messages and live requests for ChatWindow. */
export function useSessionChatConversationFeature() {
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const onToggleArtifact = useMemo(
    () => createExpandedArtifactToggleHandler({ setExpandedArtifacts }),
    [setExpandedArtifacts],
  );

  return {
    buildSurface(input: SessionChatConversationFeatureInput): SessionChatConversationFeature {
      return buildLiveSessionMessageColumnProps(
        buildLiveSessionCommonMessageColumnProps({
          ...input,
          expandedArtifacts,
          onToggleArtifact,
          isContentActive: input.mainContent === undefined,
        }),
      );
    },
  };
}
