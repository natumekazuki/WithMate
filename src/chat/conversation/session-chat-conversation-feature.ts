import { useMemo, useState } from "react";

import type { CharacterProfile } from "../../../src-shared/character/character-state.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { ChatWindowProps } from "../chat-window.js";
import { createExpandedArtifactToggleHandler } from "../session-shell-handlers.js";
import { buildLiveSessionMessageColumnProps } from "../chat-window-adapter.js";
import {
  buildLiveSessionCommonMessageColumnProps,
  type LiveSessionCommonMessageColumnInput,
} from "../live-session-projection.js";

/** メッセージ列の共通入力に、対象セッションと会話の可視状態を加えた入力。 */
export type SessionChatConversationFeatureInput = Omit<
  LiveSessionCommonMessageColumnInput,
  | "sessionId"
  | "character"
  | "messages"
  | "isContentActive"
  | "expandedArtifacts"
  | "onToggleArtifact"
> & {
  sessionId: string;
  character: CharacterProfile;
  messages: Message[];
  isConversationVisible: boolean;
};

/** ChatWindow に渡す会話列の表示と操作の契約。 */
export type SessionChatConversationFeature =
  ChatWindowProps["messageColumnProps"];

/** 成果物の展開状態を管理し、メッセージと実行中のリクエストを ChatWindow 用に変換する。 */
export function useSessionChatConversationFeature() {
  const [expandedArtifacts, setExpandedArtifacts] = useState<
    Record<string, boolean>
  >({});
  const onToggleArtifact = useMemo(
    () => createExpandedArtifactToggleHandler({ setExpandedArtifacts }),
    [setExpandedArtifacts],
  );

  return {
    /** 現在の成果物の展開状態と可視状態を、会話列の表示入力に反映する。 */
    buildSurface(
      input: SessionChatConversationFeatureInput,
    ): SessionChatConversationFeature {
      const { isConversationVisible, ...messageColumnInput } = input;
      return buildLiveSessionMessageColumnProps(
        buildLiveSessionCommonMessageColumnProps({
          ...messageColumnInput,
          expandedArtifacts,
          onToggleArtifact,
          isContentActive: isConversationVisible,
        }),
      );
    },
  };
}
