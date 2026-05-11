import { type CSSProperties, type RefObject } from "react";

import {
  ChatRightPaneShell,
  ChatWorkbenchSplitter,
  type ChatSelectOption,
  type ChatWindowProps,
} from "./chat-window.js";
import {
  buildChatPageClassName,
  createStaticChatCharacterProfile,
  createStaticChatComposerSendability,
  createHiddenControlsChatComposerProps,
  createIdleChatMessageColumnProps,
  createStaticChatCompactActionDockProps,
  createStaticChatHeaderProps,
  isStaticChatSendDisabled,
  toConversationMessages,
} from "./chat-window-adapter.js";
import { shouldSubmitMateTalkInputByKey } from "./mate-talk-state.js";

export type MateTalkMessage = {
  id: string;
  role: "user" | "mate";
  text: string;
};

export type MateTalkChatProjectionInput = {
  mateName: string;
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
  onClose: () => void;
  onToggleHeaderExpanded: () => void;
  sending: boolean;
  feedback: string;
};

type MateTalkHeaderProps = ChatWindowProps["headerProps"];
type MateTalkMessageColumnProps = ChatWindowProps["messageColumnProps"];
type MateTalkComposerProps = ChatWindowProps["composerProps"];
type MateTalkCompactActionDockProps = ChatWindowProps["compactActionDockProps"];

function buildMateTalkHeaderProps({
  sending,
  onClose,
  onToggleHeaderExpanded,
}: Pick<MateTalkChatProjectionInput, "sending" | "onClose" | "onToggleHeaderExpanded">): MateTalkHeaderProps {
  return createStaticChatHeaderProps({
    taskTitle: "メイトーク",
    titleDraft: "メイトーク",
    isRunning: sending,
    workspaceActions: (
      <button className="drawer-toggle compact secondary" type="button" onClick={onClose}>
        閉じる
      </button>
    ),
    onToggleExpanded: onToggleHeaderExpanded,
  });
}

function buildMateTalkMessageColumnProps({
  mateName,
  messages,
  messageListRef,
  sending,
}: Pick<MateTalkChatProjectionInput, "mateName" | "messages" | "messageListRef" | "sending">): MateTalkMessageColumnProps {
  return createIdleChatMessageColumnProps({
    sessionId: "mate-talk",
    character: createStaticChatCharacterProfile({ id: "mate-talk", name: mateName }),
    messages: toConversationMessages(messages),
    messageListRef,
    isRunning: sending,
    pendingRunIndicatorAnnouncement: `${mateName} の返信を待っています`,
    pendingRunIndicatorText: `${mateName} が返信を準備中`,
  });
}

function buildMateTalkComposerProps({
  input,
  modelOptions,
  selectedModel,
  selectedModelFallbackLabel,
  reasoningOptions,
  selectedReasoningEffort,
  composerTextareaRef,
  onChangeInput,
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  sending,
  feedback,
}: Pick<
  MateTalkChatProjectionInput,
  | "input"
  | "modelOptions"
  | "selectedModel"
  | "selectedModelFallbackLabel"
  | "reasoningOptions"
  | "selectedReasoningEffort"
  | "composerTextareaRef"
  | "onChangeInput"
  | "onChangeModel"
  | "onChangeReasoningEffort"
  | "onSubmit"
  | "sending"
  | "feedback"
>): MateTalkComposerProps {
  const isSubmitDisabled = isStaticChatSendDisabled({ draft: input, isRunning: sending });

  return createHiddenControlsChatComposerProps({
    composerBlocked: sending,
    draft: input,
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isComposerDisabled: sending,
    isSendDisabled: isSubmitDisabled,
    composerSendability: createStaticChatComposerSendability(feedback),
    sendButtonTitle: isSubmitDisabled ? undefined : "メッセージを送信",
    modelOptions,
    selectedModel,
    selectedModelFallbackLabel,
    reasoningOptions,
    selectedReasoningEffort,
    onDraftChange: (value) => onChangeInput(value),
    onDraftKeyDown: (event) => {
      if (!isSubmitDisabled && shouldSubmitMateTalkInputByKey(event)) {
        event.preventDefault();
        onSubmit();
      }
    },
    onSendOrCancel: onSubmit,
    onChangeModel,
    onChangeReasoningEffort,
  });
}

function buildMateTalkCompactActionDockProps({
  input,
  sending,
  onSubmit,
}: Pick<MateTalkChatProjectionInput, "input" | "sending" | "onSubmit">): MateTalkCompactActionDockProps {
  const isSubmitDisabled = isStaticChatSendDisabled({ draft: input, isRunning: sending });

  return createStaticChatCompactActionDockProps({
    draft: input,
    actionDockCompactPreview: input.trim() || "下書きなし",
    isRunning: sending,
    isSendDisabled: isSubmitDisabled,
    onSendOrCancel: onSubmit,
  });
}

export function buildMateTalkChatWindowProps({
  mateName,
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
  onClose,
  onToggleHeaderExpanded,
  sending,
  feedback,
}: MateTalkChatProjectionInput): ChatWindowProps {
  return {
    mode: "mate-talk",
    className: buildChatPageClassName({ isHeaderExpanded }),
    style: themeStyle,
    isHeaderExpanded,
    headerProps: buildMateTalkHeaderProps({ sending, onClose, onToggleHeaderExpanded }),
    messageColumnProps: buildMateTalkMessageColumnProps({ mateName, messages, messageListRef, sending }),
    isActionDockExpanded: true,
    composerProps: buildMateTalkComposerProps({
      input,
      modelOptions,
      selectedModel,
      selectedModelFallbackLabel,
      reasoningOptions,
      selectedReasoningEffort,
      composerTextareaRef,
      onChangeInput,
      onChangeModel,
      onChangeReasoningEffort,
      onSubmit,
      sending,
      feedback,
    }),
    compactActionDockProps: buildMateTalkCompactActionDockProps({ input, sending, onSubmit }),
    splitter: <ChatWorkbenchSplitter />,
    rightPane: (
      <ChatRightPaneShell
        isHeaderExpanded={isHeaderExpanded}
        headerHandleTitle="メイトーク"
        ariaLabel="補助情報"
        onToggleHeaderExpanded={onToggleHeaderExpanded}
      />
    ),
  };
}
