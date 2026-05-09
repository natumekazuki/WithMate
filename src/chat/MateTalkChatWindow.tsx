import { useRef, type CSSProperties } from "react";

import {
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterProfile,
  type Message,
} from "../app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../codex-sandbox-mode.js";
import {
  SessionChatWindow,
  SessionHeaderHandle,
  type SessionSelectOption,
} from "../session-components.js";
import { shouldSubmitMateTalkInputByKey } from "./mate-talk-state.js";

export type MateTalkChatWindowProps = {
  mateName: string;
  themeStyle?: CSSProperties;
  isHeaderExpanded: boolean;
  messages: Array<{ id: string; role: "user" | "mate"; text: string }>;
  input: string;
  modelOptions: SessionSelectOption[];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: SessionSelectOption[];
  selectedReasoningEffort: string;
  onChangeInput: (value: string) => void;
  onChangeModel: (model: string) => void;
  onChangeReasoningEffort: (reasoningEffort: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onToggleHeaderExpanded: () => void;
  sending?: boolean;
  feedback: string;
};

export function MateTalkChatWindow({
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
  onChangeInput,
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  onClose,
  onToggleHeaderExpanded,
  sending = false,
  feedback,
}: MateTalkChatWindowProps) {
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isSubmitDisabled = sending || input.trim() === "";
  const conversationMessages: Message[] = messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    text: message.text,
  }));
  const mateCharacter: CharacterProfile = {
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
  const composerSendability = {
    primaryFeedback: feedback,
    secondaryFeedback: [] as string[],
    feedbackTone: feedback ? "helper" as const : null,
    shouldShowFeedback: feedback.trim().length > 0,
  };

  return (
    <SessionChatWindow
      mode="mate-talk"
      className={`mate-talk-chat-window${isHeaderExpanded ? "" : " session-page-header-collapsed"}`}
      style={themeStyle}
      isHeaderExpanded={isHeaderExpanded}
      headerProps={{
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
        onOpenAuditLog: () => {},
        onOpenTerminal: () => {},
        onTitleDraftChange: () => {},
        onTitleInputKeyDown: () => {},
        onSaveTitle: () => {},
        onCancelTitleEdit: () => {},
        onStartTitleEdit: () => {},
        onDeleteSession: () => {},
      }}
      messageColumnProps={{
        sessionId: "mate-talk",
        character: mateCharacter,
        messages: conversationMessages,
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
        onMessageListScroll: () => {},
        onToggleArtifact: () => {},
        onOpenDiff: () => {},
        onResolveLiveApproval: () => {},
        onResolveLiveElicitation: () => {},
        getChangedFilesEmptyText: () => "",
      }}
      isActionDockExpanded={true}
      composerProps={{
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
        onPickFile: () => {},
        onPickFolder: () => {},
        onPickImage: () => {},
        onToggleAgentPicker: () => {},
        onToggleSkillPicker: () => {},
        onAddAdditionalDirectory: () => {},
        onToggleAdditionalDirectoryList: () => {},
        onCollapse: () => {},
        onJumpToBottom: () => {},
        onSelectCustomAgent: () => {},
        onSelectSkill: () => {},
        onRemoveAttachment: () => {},
        onRemoveAdditionalDirectory: () => {},
        onDraftChange: (value) => onChangeInput(value),
        onDraftFocus: () => {},
        onDraftKeyDown: (event) => {
          if (!isSubmitDisabled && shouldSubmitMateTalkInputByKey(event)) {
            event.preventDefault();
            onSubmit();
          }
        },
        onDraftSelect: () => {},
        onDraftCompositionStart: () => {},
        onDraftCompositionEnd: () => {},
        onSendOrCancel: onSubmit,
        onSelectWorkspacePathMatch: () => {},
        onActivateWorkspacePathMatch: () => {},
        onChangeApprovalMode: () => {},
        onChangeCodexSandboxMode: () => {},
        onChangeModel,
        onChangeReasoningEffort,
      }}
      compactActionDockProps={{
        draft: input,
        actionDockCompactPreview: input.trim() || "下書きなし",
        attachmentCount: 0,
        isRunning: sending,
        isSendDisabled: isSubmitDisabled,
        showJumpToBottom: false,
        onExpand: () => {},
        onJumpToBottom: () => {},
        onSendOrCancel: onSubmit,
      }}
      splitter={<div className="session-workbench-splitter mate-talk-splitter" aria-hidden="true" />}
      rightPane={(
        <aside
          className={`session-context-pane${isHeaderExpanded ? " session-context-pane-header-expanded" : ""}`}
          aria-label="メイトーク補助情報"
        >
          {!isHeaderExpanded ? <SessionHeaderHandle taskTitle="メイトーク" onClick={onToggleHeaderExpanded} /> : null}
        </aside>
      )}
    />
  );
}
