import { type CSSProperties, type ReactNode, type RefObject } from "react";

import {
  ChatRightPaneShell,
  ChatDockSplitter,
  type ChatSelectOption,
  type ChatWindowProps,
} from "./chat-window.js";
import {
  createHiddenControlsTextChatComposerProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  createStaticTextConversationMessageColumnProps,
  type StaticTextChatComposerCapabilityProps,
} from "./chat-window-adapter.js";

export type TextChatWindowMessage = {
  id: string;
  role: string;
  text: string;
};

export type TextChatWindowProjectionInput = {
  mode: ChatWindowProps["mode"];
  pageTitle: string;
  pageTitleDraft?: string;
  characterId: string;
  characterName: string;
  characterIconPath?: string;
  sessionId: string;
  themeStyle?: CSSProperties;
  isHeaderExpanded: boolean;
  messages: TextChatWindowMessage[];
  draft: string;
  placeholder?: string;
  sendButtonTitleWhenEnabled?: string;
  modelOptions: ChatSelectOption[];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: ChatSelectOption[];
  selectedReasoningEffort: string;
  pendingRunIndicatorAnnouncement?: string;
  pendingRunIndicatorText?: string;
  messageListRef: RefObject<HTMLDivElement | null>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onCopyMessageText?: ChatWindowProps["messageColumnProps"]["onCopyMessageText"];
  onQuoteMessageText?: ChatWindowProps["messageColumnProps"]["onQuoteMessageText"];
  onChangeModel: (model: string) => void;
  onChangeReasoningEffort: (reasoningEffort: string) => void;
  onSubmit: () => void;
  onToggleHeaderExpanded: () => void;
  isRunning: boolean;
  feedback: string;
  headerWorkspaceActions?: ReactNode;
  headerSessionFilesActions?: ReactNode;
  isActionDockExpanded?: boolean;
  onToggleActionDock?: () => void;
  rightPaneHeaderTitle?: string;
  rightPaneAriaLabel?: string;
  rightPaneClassName?: string;
  composerCapabilityProps?: StaticTextChatComposerCapabilityProps;
};

export function buildTextChatWindowProps({
  mode,
  pageTitle,
  pageTitleDraft,
  characterId,
  characterName,
  characterIconPath,
  sessionId,
  themeStyle,
  isHeaderExpanded,
  messages,
  draft,
  placeholder,
  sendButtonTitleWhenEnabled,
  modelOptions,
  selectedModel,
  selectedModelFallbackLabel,
  reasoningOptions,
  selectedReasoningEffort,
  pendingRunIndicatorAnnouncement,
  pendingRunIndicatorText,
  messageListRef,
  composerTextareaRef,
  onDraftChange,
  onCopyMessageText,
  onQuoteMessageText,
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  onToggleHeaderExpanded,
  isRunning,
  feedback,
  headerWorkspaceActions,
  headerSessionFilesActions,
  isActionDockExpanded = true,
  onToggleActionDock,
  rightPaneHeaderTitle = pageTitle,
  rightPaneAriaLabel = "補助情報",
  rightPaneClassName,
  composerCapabilityProps,
}: TextChatWindowProjectionInput): ChatWindowProps {
  return {
    mode,
    className: "",
    style: themeStyle,
    layoutPriority: "side-pane-first",
    isHeaderExpanded,
    headerProps: createStaticChatHeaderProps({
      taskTitle: pageTitle,
      titleDraft: pageTitleDraft ?? pageTitle,
      isRunning,
      workspaceActions: headerWorkspaceActions,
      sessionFilesActions: headerSessionFilesActions,
    }),
    messageColumnProps: createStaticTextConversationMessageColumnProps({
      sessionId,
      characterId,
      characterName,
      characterIconPath,
      messages,
      messageListRef,
      isRunning,
      onCopyMessageText,
      onQuoteMessageText,
    }),
    isActionDockExpanded,
    composerProps: createHiddenControlsTextChatComposerProps({
      draft,
      placeholder,
      composerTextareaRef,
      isRunning,
      pendingRunIndicatorAnnouncement,
      pendingRunIndicatorText,
      feedback,
      sendButtonTitleWhenEnabled,
      modelOptions,
      selectedModel,
      selectedModelFallbackLabel,
      reasoningOptions,
      selectedReasoningEffort,
      onDraftChange,
      onSendOrCancel: onSubmit,
      onChangeModel,
      onChangeReasoningEffort,
      ...composerCapabilityProps,
    }),
    compactActionDockProps: createStaticTextChatCompactActionDockProps({
      pendingRunIndicatorAnnouncement,
      pendingRunIndicatorText,
      onExpand: onToggleActionDock,
    }),
    headerSplitter: (
      <ChatDockSplitter
        edge="top"
        isPanelExpanded={isHeaderExpanded}
        onTogglePanel={onToggleHeaderExpanded}
      />
    ),
    actionDockSplitter: (
      <ChatDockSplitter
        edge="bottom"
        isPanelExpanded={isActionDockExpanded}
        onTogglePanel={onToggleActionDock}
      />
    ),
    splitter: <ChatDockSplitter edge="right" />,
    rightPane: (
      <ChatRightPaneShell
        ariaLabel={rightPaneAriaLabel}
        className={rightPaneClassName}
      />
    ),
  };
}
