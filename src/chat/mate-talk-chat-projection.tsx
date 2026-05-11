import { type CSSProperties, type RefObject } from "react";

import {
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterProfile,
  type Message,
} from "../app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../codex-sandbox-mode.js";
import {
  ChatRightPaneShell,
  ChatWorkbenchSplitter,
  type ChatSelectOption,
  type ChatWindowProps,
} from "./chat-window.js";
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

type MateTalkHeaderProps = ChatWindowProps["headerProps"];
type MateTalkMessageColumnProps = ChatWindowProps["messageColumnProps"];
type MateTalkComposerProps = ChatWindowProps["composerProps"];
type MateTalkCompactActionDockProps = ChatWindowProps["compactActionDockProps"];

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

function buildMateTalkHeaderProps({
  sending,
  onClose,
  onToggleHeaderExpanded,
}: Pick<MateTalkChatProjectionInput, "sending" | "onClose" | "onToggleHeaderExpanded">): MateTalkHeaderProps {
  return {
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
  };
}

function buildMateTalkMessageColumnProps({
  mateName,
  messages,
  messageListRef,
  sending,
}: Pick<MateTalkChatProjectionInput, "mateName" | "messages" | "messageListRef" | "sending">): MateTalkMessageColumnProps {
  return {
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
  };
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
  const isSubmitDisabled = sending || input.trim() === "";
  const composerSendability: MateTalkComposerProps["composerSendability"] = {
    primaryFeedback: feedback,
    secondaryFeedback: [],
    feedbackTone: feedback ? "helper" : null,
    shouldShowFeedback: feedback.trim().length > 0,
  };

  return {
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
  };
}

function buildMateTalkCompactActionDockProps({
  input,
  sending,
  onSubmit,
}: Pick<MateTalkChatProjectionInput, "input" | "sending" | "onSubmit">): MateTalkCompactActionDockProps {
  return {
    draft: input,
    actionDockCompactPreview: input.trim() || "下書きなし",
    attachmentCount: 0,
    isRunning: sending,
    isSendDisabled: sending || input.trim() === "",
    showJumpToBottom: false,
    onExpand: noop,
    onJumpToBottom: noop,
    onSendOrCancel: onSubmit,
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
  return {
    mode: "mate-talk",
    className: isHeaderExpanded ? "" : "session-page-header-collapsed",
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
