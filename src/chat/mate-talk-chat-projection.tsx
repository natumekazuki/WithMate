import { type CSSProperties, type RefObject } from "react";

import { type ChatSelectOption, type ChatWindowProps } from "./chat-window.js";
import {
  buildTextChatWindowProps,
  type TextChatWindowMessage,
} from "./text-chat-projection.js";
import { shouldSubmitMateTalkInputByKey } from "./mate-talk-state.js";

export type MateTalkMessage = TextChatWindowMessage & {
  role: "user" | "mate";
};

export type MateTalkChatProjectionInput = {
  mateName: string;
  mateAvatarFilePath?: string;
  themeStyle?: CSSProperties;
  isHeaderExpanded: boolean;
  messages: MateTalkMessage[];
  input: string;
  modelOptions: ChatSelectOption[];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: ChatSelectOption[];
  selectedReasoningEffort: string;
  messageListRef: RefObject<HTMLDivElement | null>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  onChangeInput: (value: string) => void;
  onChangeModel: (model: string) => void;
  onChangeReasoningEffort: (reasoningEffort: string) => void;
  onSubmit: () => void;
  onToggleHeaderExpanded: () => void;
  sending: boolean;
  feedback: string;
  composerCapabilityProps?: Parameters<typeof buildTextChatWindowProps>[0]["composerCapabilityProps"];
};

export function buildMateTalkChatWindowProps({
  mateName,
  mateAvatarFilePath,
  themeStyle,
  isHeaderExpanded,
  messages,
  input,
  modelOptions,
  selectedModel,
  selectedModelFallbackLabel,
  reasoningOptions,
  selectedReasoningEffort,
  messageListRef,
  composerTextareaRef,
  onChangeInput,
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  onToggleHeaderExpanded,
  sending,
  feedback,
  composerCapabilityProps,
}: MateTalkChatProjectionInput): ChatWindowProps {
  return buildTextChatWindowProps({
    mode: "mate-talk",
    pageTitle: "メイトーク",
    characterId: "mate-talk",
    characterName: mateName,
    characterIconPath: mateAvatarFilePath,
    sessionId: "mate-talk",
    themeStyle,
    isHeaderExpanded,
    messages,
    draft: input,
    placeholder: "今日はどうする？",
    sendButtonTitleWhenEnabled: "メッセージを送信",
    modelOptions,
    selectedModel,
    selectedModelFallbackLabel,
    reasoningOptions,
    selectedReasoningEffort,
    pendingRunIndicatorAnnouncement: `${mateName} の返信を待っています`,
    pendingRunIndicatorText: `${mateName} が返信を準備中`,
    messageListRef,
    composerTextareaRef,
    onDraftChange: onChangeInput,
    onChangeModel,
    onChangeReasoningEffort,
    onSubmit,
    onToggleHeaderExpanded,
    isRunning: sending,
    feedback,
    submitOnKey: shouldSubmitMateTalkInputByKey,
    rightPaneHeaderTitle: "メイトーク",
    rightPaneAriaLabel: "補助情報",
    composerCapabilityProps,
  });
}
