import { type CSSProperties, type RefObject } from "react";

import { type ChatSelectOption, type ChatWindowProps } from "./chat-window.js";
import {
  buildStaticTextChatComposerCapabilityProps,
  staticTextChatRuntimeComposerCapabilityDefaults,
  type StaticTextChatComposerCapabilityProps,
} from "./chat-window-adapter.js";
import {
  buildTextChatWindowProps,
  type TextChatWindowMessage,
} from "./text-chat-projection.js";
import { shouldSubmitMateTalkInputByKey } from "./mate-talk-state.js";
import { createSessionFilesActions } from "./session-files-actions.js";

export type MateTalkMessage = TextChatWindowMessage & {
  role: "user" | "mate";
};

export type MateTalkChatProjectionInput = {
  mateName: string;
  mateAvatarFilePath?: string;
  themeStyle?: CSSProperties;
  isHeaderExpanded: boolean;
  isActionDockExpanded: boolean;
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
  onCopyMessageText?: ChatWindowProps["messageColumnProps"]["onCopyMessageText"];
  onQuoteMessageText?: ChatWindowProps["messageColumnProps"]["onQuoteMessageText"];
  onChangeModel: (model: string) => void;
  onChangeReasoningEffort: (reasoningEffort: string) => void;
  onSubmit: () => void;
  onToggleHeaderExpanded: () => void;
  onOpenSessionFilesExplorer: () => void;
  onOpenSessionFilesTerminal: () => void;
  onCollapseActionDock: () => void;
  onExpandActionDock: () => void;
  sending: boolean;
  feedback: string;
  composerCapabilityProps?: StaticTextChatComposerCapabilityProps;
};

export function buildMateTalkChatWindowProps({
  mateName,
  mateAvatarFilePath,
  themeStyle,
  isHeaderExpanded,
  isActionDockExpanded,
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
  onCopyMessageText,
  onQuoteMessageText,
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  onToggleHeaderExpanded,
  onOpenSessionFilesExplorer,
  onOpenSessionFilesTerminal,
  onCollapseActionDock,
  onExpandActionDock,
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
    isActionDockExpanded,
    onExpandActionDock,
    messages,
    draft: input,
    placeholder: "今日はどうする？",
    sendButtonTitleWhenEnabled: "メッセージを送信",
    modelOptions,
    selectedModel,
    selectedModelFallbackLabel,
    reasoningOptions,
    selectedReasoningEffort,
    messageListRef,
    composerTextareaRef,
    onDraftChange: onChangeInput,
    onCopyMessageText,
    onQuoteMessageText,
    onChangeModel,
    onChangeReasoningEffort,
    onSubmit,
    onToggleHeaderExpanded,
    headerSessionFilesActions: createSessionFilesActions({
      onOpenExplorer: onOpenSessionFilesExplorer,
      onOpenTerminal: onOpenSessionFilesTerminal,
    }),
    isRunning: sending,
    feedback,
    submitOnKey: shouldSubmitMateTalkInputByKey,
    rightPaneHeaderTitle: "メイトーク",
    rightPaneAriaLabel: "補助情報",
    composerCapabilityProps: buildStaticTextChatComposerCapabilityProps({
      ...composerCapabilityProps,
      ...staticTextChatRuntimeComposerCapabilityDefaults,
      showCustomAgentPicker: false,
      showSkillPicker: false,
      canCollapseActionDock: true,
      onCollapse: onCollapseActionDock,
    }),
  });
}
