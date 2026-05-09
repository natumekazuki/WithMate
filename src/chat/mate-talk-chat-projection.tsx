import { type CSSProperties, type RefObject } from "react";

import {
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterProfile,
  type Message,
} from "../app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../codex-sandbox-mode.js";
import { ChatHeaderHandle, type ChatSelectOption, type ChatWindowProps } from "./chat-window.js";
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

const noop = () => {};

function toConversationMessages(messages: MateTalkMessage[]): Message[] {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    text: message.text,
  }));
}

function buildMateCharacter(mateName: string): CharacterProfile {
  return {
    id: "mate-talk",
    name: mateName,
    iconPath: "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    updatedAt: "",
    themeColors: { ...DEFAULT_CHARACTER_THEME_COLORS },
    sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
  };
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
  const isSubmitDisabled = sending || input.trim() === "";
  const composerSendability = {
    primaryFeedback: feedback,
    secondaryFeedback: [] as string[],
    feedbackTone: feedback ? "helper" as const : null,
    shouldShowFeedback: feedback.trim().length > 0,
  };

  return {
    mode: "mate-talk",
    className: `mate-talk-chat-window${isHeaderExpanded ? "" : " session-page-header-collapsed"}`,
    style: themeStyle,
    isHeaderExpanded,
    headerProps: {
      taskTitle: "メイトーク",
      isEditingTitle: false,
      titleDraft: "メイトーク",
      isRunning: sending,
      showRenameButton: false,
      showAuditLogButton: false,
      showTerminalButton: false,
      showDeleteButton: false,
      workspaceActions: (
        <button className="drawer-toggle compact secondary" type="button" onClick={onClose}>
          閉じる
        </button>
      ),
      onToggleExpanded: onToggleHeaderExpanded,
      onOpenAuditLog: noop,
      onOpenTerminal: noop,
      onTitleDraftChange: noop,
      onTitleInputKeyDown: noop,
      onSaveTitle: noop,
      onCancelTitleEdit: noop,
      onStartTitleEdit: noop,
      onDeleteSession: noop,
    },
    messageColumnProps: {
      sessionId: "mate-talk",
      character: buildMateCharacter(mateName),
      messages: toConversationMessages(messages),
      expandedArtifacts: {},
      messageListRef,
      isRunning: sending,
      pendingRunIndicatorAnnouncement: `${mateName} の返信を待っています`,
      pendingRunIndicatorText: `${mateName} が返信を準備中`,
      liveApprovalRequest: null,
      approvalActionRequestId: null,
      liveElicitationRequest: null,
      elicitationActionRequestId: null,
      liveRunAssistantText: "",
      hasLiveRunAssistantText: false,
      liveRunErrorMessage: "",
      isMessageListFollowing: true,
      onMessageListScroll: noop,
      onToggleArtifact: noop,
      onOpenDiff: noop,
      onResolveLiveApproval: noop,
      onResolveLiveElicitation: noop,
      getChangedFilesEmptyText: () => "",
    },
    isActionDockExpanded: true,
    composerProps: {
      retryBanner: null,
      isRunning: false,
      composerBlocked: sending,
      canSelectCustomAgent: false,
      showAttachmentControls: false,
      showCustomAgentPicker: false,
      showSkillPicker: false,
      showAdditionalDirectoryControls: false,
      showExecutionModeControls: false,
      isAgentPickerOpen: false,
      isSkillPickerOpen: false,
      isAdditionalDirectoryListOpen: false,
      selectedCustomAgentLabel: "Agent",
      selectedCustomAgentTitle: "",
      additionalDirectoryCount: 0,
      canCollapseActionDock: false,
      showJumpToBottom: false,
      isCustomAgentListLoading: false,
      isSkillListLoading: false,
      customAgentItems: [],
      skillItems: [],
      attachmentItems: [],
      additionalDirectoryItems: [],
      workspacePathMatchItems: [],
      draft: input,
      placeholder: "今日はどうする？",
      composerTextareaRef,
      isComposerDisabled: sending,
      isSendDisabled: isSubmitDisabled,
      composerSendability,
      sendButtonTitle: isSubmitDisabled ? undefined : "メッセージを送信",
      isComposerBlockedFeedbackActive: false,
      approvalOptions: [{ value: DEFAULT_APPROVAL_MODE, label: DEFAULT_APPROVAL_MODE }],
      selectedApprovalMode: DEFAULT_APPROVAL_MODE,
      sandboxOptions: [],
      selectedCodexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
      modelOptions,
      selectedModel,
      selectedModelFallbackLabel,
      reasoningOptions,
      selectedReasoningEffort,
      onPickFile: noop,
      onPickFolder: noop,
      onPickImage: noop,
      onToggleAgentPicker: noop,
      onToggleSkillPicker: noop,
      onAddAdditionalDirectory: noop,
      onToggleAdditionalDirectoryList: noop,
      onCollapse: noop,
      onJumpToBottom: noop,
      onSelectCustomAgent: noop,
      onSelectSkill: noop,
      onRemoveAttachment: noop,
      onRemoveAdditionalDirectory: noop,
      onDraftChange: (value) => onChangeInput(value),
      onDraftFocus: noop,
      onDraftKeyDown: (event) => {
        if (!isSubmitDisabled && shouldSubmitMateTalkInputByKey(event)) {
          event.preventDefault();
          onSubmit();
        }
      },
      onDraftSelect: noop,
      onDraftCompositionStart: noop,
      onDraftCompositionEnd: noop,
      onSendOrCancel: onSubmit,
      onSelectWorkspacePathMatch: noop,
      onActivateWorkspacePathMatch: noop,
      onChangeApprovalMode: noop,
      onChangeCodexSandboxMode: noop,
      onChangeModel,
      onChangeReasoningEffort,
    },
    compactActionDockProps: {
      draft: input,
      actionDockCompactPreview: input.trim() || "下書きなし",
      attachmentCount: 0,
      isRunning: sending,
      isSendDisabled: isSubmitDisabled,
      showJumpToBottom: false,
      onExpand: noop,
      onJumpToBottom: noop,
      onSendOrCancel: onSubmit,
    },
    splitter: <div className="session-workbench-splitter mate-talk-splitter" aria-hidden="true" />,
    rightPane: (
      <aside
        className={`session-context-pane${isHeaderExpanded ? " session-context-pane-header-expanded" : ""}`}
        aria-label="メイトーク補助情報"
      >
        {!isHeaderExpanded ? <ChatHeaderHandle taskTitle="メイトーク" onClick={onToggleHeaderExpanded} /> : null}
      </aside>
    ),
  };
}
