import { type CSSProperties, type KeyboardEvent, type RefObject } from "react";

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
  isInputImeComposing?: () => boolean;
  isRunning: boolean;
  feedback: string;
  composerCapabilityProps?: StaticTextChatComposerCapabilityProps;
};

export function buildMateTalkComposerCapabilityProps({
  composerCapabilityProps,
  onCollapseActionDock,
}: {
  composerCapabilityProps?: StaticTextChatComposerCapabilityProps;
  onCollapseActionDock: () => void;
}): StaticTextChatComposerCapabilityProps {
  return buildStaticTextChatComposerCapabilityProps({
    ...composerCapabilityProps,
    ...staticTextChatRuntimeComposerCapabilityDefaults,
    showCustomAgentPicker: false,
    showSkillPicker: false,
    canCollapseActionDock: true,
    onCollapse: onCollapseActionDock,
  });
}

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
  isInputImeComposing,
  isRunning,
  feedback,
  composerCapabilityProps,
}: MateTalkChatProjectionInput): ChatWindowProps {
  const shouldSubmitOnKey = (event: KeyboardEvent<HTMLTextAreaElement>) =>
    shouldSubmitMateTalkInputByKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing || isInputImeComposing?.() === true,
    });

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
    isRunning,
    feedback,
    submitOnKey: shouldSubmitOnKey,
    rightPaneHeaderTitle: "メイトーク",
    rightPaneAriaLabel: "補助情報",
    composerCapabilityProps: buildMateTalkComposerCapabilityProps({
      composerCapabilityProps,
      onCollapseActionDock,
    }),
  });
}
