import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import {
  ChatRightPaneShell,
  ChatWorkbenchSplitter,
  type ChatSelectOption,
  type ChatWindowProps,
} from "./chat-window.js";
import {
  buildChatPageClassName,
  createHiddenControlsTextChatComposerProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  createStaticTextConversationMessageColumnProps,
  isStaticChatSendDisabled,
} from "./chat-window-adapter.js";

export type StaticChatWindowMessage = {
  id: string;
  role: string;
  text: string;
};

export type StaticChatWindowVariantInput = {
  mode: ChatWindowProps["mode"];
  pageTitle: string;
  pageTitleDraft?: string;
  characterId: string;
  characterName: string;
  sessionId: string;
  themeStyle?: CSSProperties;
  isHeaderExpanded: boolean;
  messages: StaticChatWindowMessage[];
  draft: string;
  placeholder?: string;
  sendButtonTitleWhenEnabled?: string;
  modelOptions: ChatSelectOption[];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: ChatSelectOption[];
  selectedReasoningEffort: string;
  pendingRunIndicatorAnnouncement: string;
  pendingRunIndicatorText: string;
  messageListRef: RefObject<HTMLDivElement | null>;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onChangeModel: (model: string) => void;
  onChangeReasoningEffort: (reasoningEffort: string) => void;
  onSubmit: () => void;
  onToggleHeaderExpanded: () => void;
  isRunning: boolean;
  feedback: string;
  submitOnKey?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  headerWorkspaceActions?: ReactNode;
  isActionDockExpanded?: boolean;
  rightPaneHeaderTitle?: string;
  rightPaneAriaLabel?: string;
  rightPaneClassName?: string;
};

export function buildStaticChatWindowVariantProps({
  mode,
  pageTitle,
  pageTitleDraft,
  characterId,
  characterName,
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
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  onToggleHeaderExpanded,
  isRunning,
  feedback,
  submitOnKey,
  headerWorkspaceActions,
  isActionDockExpanded = true,
  rightPaneHeaderTitle = pageTitle,
  rightPaneAriaLabel = "補助情報",
  rightPaneClassName,
}: StaticChatWindowVariantInput): ChatWindowProps {
  const isSendDisabled = isStaticChatSendDisabled({ draft, isRunning });

  return {
    mode,
    className: buildChatPageClassName({ isHeaderExpanded }),
    style: themeStyle,
    isHeaderExpanded,
    headerProps: createStaticChatHeaderProps({
      taskTitle: pageTitle,
      titleDraft: pageTitleDraft ?? pageTitle,
      isRunning,
      workspaceActions: headerWorkspaceActions,
      onToggleExpanded: onToggleHeaderExpanded,
    }),
    messageColumnProps: createStaticTextConversationMessageColumnProps({
      sessionId,
      characterId,
      characterName,
      messages,
      messageListRef,
      isRunning,
      pendingRunIndicatorAnnouncement,
      pendingRunIndicatorText,
    }),
    isActionDockExpanded,
    composerProps: createHiddenControlsTextChatComposerProps({
      draft,
      placeholder,
      composerTextareaRef,
      isRunning,
      feedback,
      sendButtonTitleWhenEnabled,
      modelOptions,
      selectedModel,
      selectedModelFallbackLabel,
      reasoningOptions,
      selectedReasoningEffort,
      onDraftChange,
      onDraftKeyDown: (event) => {
        if (!isSendDisabled && submitOnKey?.(event)) {
          event.preventDefault();
          onSubmit();
        }
      },
      onSendOrCancel: onSubmit,
      onChangeModel,
      onChangeReasoningEffort,
    }),
    compactActionDockProps: createStaticTextChatCompactActionDockProps({
      draft,
      isRunning,
      onSendOrCancel: onSubmit,
    }),
    splitter: <ChatWorkbenchSplitter />,
    rightPane: (
      <ChatRightPaneShell
        isHeaderExpanded={isHeaderExpanded}
        headerHandleTitle={rightPaneHeaderTitle}
        ariaLabel={rightPaneAriaLabel}
        className={rightPaneClassName}
        onToggleHeaderExpanded={onToggleHeaderExpanded}
      />
    ),
  };
}
