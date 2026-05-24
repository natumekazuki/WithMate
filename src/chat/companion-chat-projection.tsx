import type {
  CSSProperties,
  KeyboardEventHandler,
  PointerEventHandler,
  RefObject,
  UIEventHandler,
} from "react";

import type { CharacterProfile, DiffPreviewPayload, MessageArtifact } from "../app-state.js";
import type { CompanionSession } from "../companion-state.js";
import {
  SessionContextPane,
  SessionPaneErrorBoundary,
  type SessionActionDockCompactRowProps,
  type SessionAuditLogModalProps,
  type SessionComposerExpandedProps,
  type SessionContextPaneProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
} from "../session-components.js";
import type { ContextPaneTabKey } from "../session-ui-projection.js";
import { ChatSessionModals } from "./chat-session-modals.js";
import { ChatWorkbenchSplitter, type ChatWindowProps } from "./chat-window.js";
import {
  buildChatPageClassName,
  buildLiveSessionCompactActionDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionMessageColumnProps,
  buildLiveSessionSplitterProps,
} from "./chat-window-adapter.js";

export type CompanionChatProjectionInput = {
  session: CompanionSession;
  character: CharacterProfile;
  expandedArtifacts: Record<string, boolean>;
  themeStyle: CSSProperties | undefined;
  workbenchRef: RefObject<HTMLDivElement | null>;
  workbenchStyle: CSSProperties | undefined;
  isHeaderExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isRunning: boolean;
  isHeaderActionDisabled: boolean;
  messageListRef: RefObject<HTMLDivElement | null>;
  liveApprovalRequest: SessionMessageColumnProps["liveApprovalRequest"];
  approvalActionRequestId: string | null;
  liveElicitationRequest: SessionMessageColumnProps["liveElicitationRequest"];
  elicitationActionRequestId: string | null;
  liveRunAssistantText: string;
  liveRunErrorMessage: string;
  isMessageListFollowing: boolean;
  isActionDockExpanded: boolean;
  composerBlocked: boolean;
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
  isAdditionalDirectoryListOpen: boolean;
  selectedCustomAgentLabel: string;
  selectedCustomAgentTitle: string;
  canCollapseActionDock: boolean;
  isCustomAgentListLoading: boolean;
  isSkillListLoading: boolean;
  customAgentItems: SessionComposerExpandedProps["customAgentItems"];
  skillItems: SessionComposerExpandedProps["skillItems"];
  attachmentItems: SessionComposerExpandedProps["attachmentItems"];
  additionalDirectoryItems: SessionComposerExpandedProps["additionalDirectoryItems"];
  workspacePathMatchItems: SessionComposerExpandedProps["workspacePathMatchItems"];
  draft: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerExpandedProps["composerSendability"];
  sendButtonTitle: string | undefined;
  isComposerBlockedFeedbackActive: boolean;
  approvalOptions: SessionComposerExpandedProps["approvalOptions"];
  selectedApprovalMode: SessionComposerExpandedProps["selectedApprovalMode"];
  sandboxOptions: SessionComposerExpandedProps["sandboxOptions"];
  selectedCodexSandboxMode: SessionComposerExpandedProps["selectedCodexSandboxMode"];
  modelOptions: SessionComposerExpandedProps["modelOptions"];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: SessionComposerExpandedProps["reasoningOptions"];
  selectedReasoningEffort: string;
  actionDockCompactPreview: string;
  attachmentCount: number;
  isContextRailResizing: boolean;
  activeContextPaneTab: ContextPaneTabKey;
  availableContextPaneTabs: ContextPaneTabKey[];
  contextPaneProjection: SessionContextPaneProps["contextPaneProjection"];
  latestCommandView: SessionContextPaneProps["latestCommandView"];
  runningDetailsEntries: SessionContextPaneProps["runningDetailsEntries"];
  liveRunReasoningText: SessionContextPaneProps["liveRunReasoningText"];
  backgroundTasks: SessionContextPaneProps["backgroundTasks"];
  companionGroupMonitorEntries: SessionContextPaneProps["companionGroupMonitorEntries"];
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextPaneProps["selectedSessionContextTelemetry"];
  selectedSessionContextTelemetryProjection: SessionContextPaneProps["selectedSessionContextTelemetryProjection"];
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  auditLogsOpen: boolean;
  displayedSessionAuditLogs: SessionAuditLogModalProps["entries"];
  auditLogDetails: SessionAuditLogModalProps["details"];
  auditLogOperationDetails: SessionAuditLogModalProps["operationDetails"];
  auditLogsHasMore: boolean;
  auditLogsLoading: boolean;
  auditLogsTotal: number;
  auditLogsErrorMessage: string | null;
  toastMessage: string;
  toastTone: "error" | "success";
  onToggleHeaderExpanded: () => void;
  onToggleContextPaneHeaderExpanded: () => void;
  onOpenAuditLog: () => void;
  onOpenTerminal: () => void;
  onOpenSessionFilesTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onOpenWorktree: () => void;
  onOpenSessionFilesExplorer: () => void;
  onOpenMergeWindow: () => void;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: SessionMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"];
  onOpenInlinePath: (target: string) => void;
  onCopyMessageText: SessionMessageColumnProps["onCopyMessageText"];
  onQuoteMessageText: SessionMessageColumnProps["onQuoteMessageText"];
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
  onAddToSessionFiles: NonNullable<SessionComposerExpandedProps["onAddToSessionFiles"]>;
  onPickSessionFiles: NonNullable<SessionComposerExpandedProps["onPickSessionFiles"]>;
  onToggleAgentPicker: () => void;
  onToggleSkillPicker: () => void;
  onAddAdditionalDirectory: () => void;
  onToggleAdditionalDirectoryList: () => void;
  onCollapseActionDock: () => void;
  onJumpToMessageListBottom: () => void;
  onSelectCustomAgent: SessionComposerExpandedProps["onSelectCustomAgent"];
  onSelectSkill: SessionComposerExpandedProps["onSelectSkill"];
  onRemoveAttachment: SessionComposerExpandedProps["onRemoveAttachment"];
  onRemoveAdditionalDirectory: SessionComposerExpandedProps["onRemoveAdditionalDirectory"];
  onDraftChange: SessionComposerExpandedProps["onDraftChange"];
  onDraftFocus: () => void;
  onDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onDraftPaste: SessionComposerExpandedProps["onDraftPaste"];
  onDraftSelect: (selectionStart: number) => void;
  onDraftCompositionStart: () => void;
  onDraftCompositionEnd: () => void;
  onSendOrCancel: () => void;
  onExpandActionDock: () => void;
  onSelectWorkspacePathMatch: SessionComposerExpandedProps["onSelectWorkspacePathMatch"];
  onActivateWorkspacePathMatch: SessionComposerExpandedProps["onActivateWorkspacePathMatch"];
  onChangeApprovalMode: SessionComposerExpandedProps["onChangeApprovalMode"];
  onChangeCodexSandboxMode: SessionComposerExpandedProps["onChangeCodexSandboxMode"];
  onChangeModel: SessionComposerExpandedProps["onChangeModel"];
  onChangeReasoningEffort: SessionComposerExpandedProps["onChangeReasoningEffort"];
  onStartContextRailResize: PointerEventHandler<HTMLButtonElement>;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  onLoadMoreAuditLogs: () => void;
  onLoadAuditLogDetail: SessionAuditLogModalProps["onLoadDetail"];
  onLoadAuditLogOperationDetail: SessionAuditLogModalProps["onLoadOperationDetail"];
  onCloseAuditLog: () => void;
};

export function buildCompanionChatWindowProps(input: CompanionChatProjectionInput): ChatWindowProps {
  const headerProps: SessionHeaderProps = {
    taskTitle: input.session.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isRunning,
    showRenameButton: true,
    showAuditLogButton: true,
    showTerminalButton: true,
    showDeleteButton: false,
    onToggleExpanded: input.onToggleHeaderExpanded,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenTerminal,
    sessionFilesActions: (
      <>
        <button
          className="drawer-toggle compact secondary"
          type="button"
          onClick={input.onOpenSessionFilesExplorer}
          title="Open session files directory"
        >
          Explorer
        </button>
        <button
          className="drawer-toggle compact secondary"
          type="button"
          onClick={input.onOpenSessionFilesTerminal}
          title="Open terminal in session files directory"
        >
          Terminal
        </button>
      </>
    ),
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: () => {},
    workspaceActions: (
      <button
        className="drawer-toggle compact secondary"
        type="button"
        disabled={input.isHeaderActionDisabled}
        onClick={input.onOpenWorktree}
      >
        Explorer
      </button>
    ),
    actions: (
      <button
        className="drawer-toggle compact secondary"
        type="button"
        disabled={input.isHeaderActionDisabled || input.session.status !== "active"}
        onClick={input.onOpenMergeWindow}
      >
        Merge
      </button>
    ),
  };

  const messageColumnProps = buildLiveSessionMessageColumnProps({
    sessionId: input.session.id,
    character: input.character,
    messages: input.session.messages,
    expandedArtifacts: input.expandedArtifacts,
    messageListRef: input.messageListRef,
    isRunning: input.isRunning,
    liveApprovalRequest: input.liveApprovalRequest,
    approvalActionRequestId: input.approvalActionRequestId,
    liveElicitationRequest: input.liveElicitationRequest,
    elicitationActionRequestId: input.elicitationActionRequestId,
    liveRunAssistantText: input.liveRunAssistantText,
    hasLiveRunAssistantText: input.liveRunAssistantText.length > 0,
    liveRunErrorMessage: input.liveRunErrorMessage,
    isMessageListFollowing: input.isMessageListFollowing,
    onMessageListScroll: input.onMessageListScroll,
    onToggleArtifact: input.onToggleArtifact,
    onLoadArtifactDetail: input.onLoadArtifactDetail,
    onOpenDiff: input.onOpenDiff,
    onResolveLiveApproval: input.onResolveLiveApproval,
    onResolveLiveElicitation: input.onResolveLiveElicitation,
    onOpenPath: input.onOpenInlinePath,
    getChangedFilesEmptyText: () => "差分はまだないよ。",
    onCopyMessageText: input.onCopyMessageText,
    onQuoteMessageText: input.onQuoteMessageText,
  });

  const composerProps = buildLiveSessionComposerProps({
    retryBanner: null,
    isRunning: input.isRunning,
    pendingRunIndicatorAnnouncement: "Companion が実行中",
    pendingRunIndicatorText: "Companion が応答を生成中...",
    composerBlocked: input.composerBlocked,
    canSelectCustomAgent: input.session.provider === "copilot",
    showCustomAgentPicker: true,
    showSkillPicker: true,
    showAdditionalDirectoryControls: true,
    isAgentPickerOpen: input.isAgentPickerOpen,
    isSkillPickerOpen: input.isSkillPickerOpen,
    isAdditionalDirectoryListOpen: input.isAdditionalDirectoryListOpen,
    selectedCustomAgentLabel: input.selectedCustomAgentLabel,
    selectedCustomAgentTitle: input.selectedCustomAgentTitle,
    additionalDirectoryCount: (input.session.allowedAdditionalDirectories ?? []).length,
    canCollapseActionDock: input.canCollapseActionDock,
    showJumpToBottom: !input.isMessageListFollowing,
    isCustomAgentListLoading: input.isCustomAgentListLoading,
    isSkillListLoading: input.isSkillListLoading,
    customAgentItems: input.customAgentItems,
    skillItems: input.skillItems,
    attachmentItems: input.attachmentItems,
    additionalDirectoryItems: input.additionalDirectoryItems,
    workspacePathMatchItems: input.workspacePathMatchItems,
    draft: input.draft,
    composerTextareaRef: input.composerTextareaRef,
    isComposerDisabled: input.isComposerDisabled,
    isSendDisabled: input.isSendDisabled,
    composerSendability: input.composerSendability,
    sendButtonTitle: input.sendButtonTitle,
    isComposerBlockedFeedbackActive: input.isComposerBlockedFeedbackActive,
    approvalOptions: input.approvalOptions,
    selectedApprovalMode: input.selectedApprovalMode,
    sandboxOptions: input.sandboxOptions,
    selectedCodexSandboxMode: input.selectedCodexSandboxMode,
    modelOptions: input.modelOptions,
    selectedModel: input.selectedModel,
    selectedModelFallbackLabel: input.selectedModelFallbackLabel,
    reasoningOptions: input.reasoningOptions,
    selectedReasoningEffort: input.selectedReasoningEffort,
    onPickFile: input.onPickFile,
    onPickFolder: input.onPickFolder,
    onPickImage: input.onPickImage,
    onAddToSessionFiles: input.onAddToSessionFiles,
    onPickSessionFiles: input.onPickSessionFiles,
    onToggleAgentPicker: input.onToggleAgentPicker,
    onToggleSkillPicker: input.onToggleSkillPicker,
    onAddAdditionalDirectory: input.onAddAdditionalDirectory,
    onToggleAdditionalDirectoryList: input.onToggleAdditionalDirectoryList,
    onCollapse: input.onCollapseActionDock,
    onJumpToBottom: input.onJumpToMessageListBottom,
    onSelectCustomAgent: input.onSelectCustomAgent,
    onSelectSkill: input.onSelectSkill,
    onRemoveAttachment: input.onRemoveAttachment,
    onRemoveAdditionalDirectory: input.onRemoveAdditionalDirectory,
    onDraftChange: input.onDraftChange,
    onDraftFocus: input.onDraftFocus,
    onDraftKeyDown: input.onDraftKeyDown,
    onDraftPaste: input.onDraftPaste,
    onDraftSelect: input.onDraftSelect,
    onDraftCompositionStart: input.onDraftCompositionStart,
    onDraftCompositionEnd: input.onDraftCompositionEnd,
    onSendOrCancel: input.onSendOrCancel,
    onSelectWorkspacePathMatch: input.onSelectWorkspacePathMatch,
    onActivateWorkspacePathMatch: input.onActivateWorkspacePathMatch,
    onChangeApprovalMode: input.onChangeApprovalMode,
    onChangeCodexSandboxMode: input.onChangeCodexSandboxMode,
    onChangeModel: input.onChangeModel,
    onChangeReasoningEffort: input.onChangeReasoningEffort,
  });

  const compactActionDockProps = buildLiveSessionCompactActionDockProps({
    draft: input.draft,
    actionDockCompactPreview: input.actionDockCompactPreview,
    attachmentCount: input.attachmentCount,
    isRunning: input.isRunning,
    pendingRunIndicatorAnnouncement: "Companion が実行中",
    pendingRunIndicatorText: "Companion が応答を生成中...",
    isSendDisabled: input.isSendDisabled,
    showJumpToBottom: !input.isMessageListFollowing,
    sendButtonTitle: input.sendButtonTitle,
    onExpand: input.onExpandActionDock,
    onJumpToBottom: input.onJumpToMessageListBottom,
    onSendOrCancel: input.onSendOrCancel,
  });

  return {
    mode: "companion",
    className: buildChatPageClassName({
      baseClassName: "theme-accent",
      isHeaderExpanded: input.isHeaderExpanded,
    }),
    style: input.themeStyle,
    workbenchRef: input.workbenchRef,
    workbenchStyle: input.workbenchStyle,
    isHeaderExpanded: input.isHeaderExpanded,
    headerProps,
    messageColumnProps,
    isActionDockExpanded: input.isActionDockExpanded,
    composerProps,
    compactActionDockProps,
    splitter: (
      <ChatWorkbenchSplitter {...buildLiveSessionSplitterProps({
        isContextRailResizing: input.isContextRailResizing,
        onStartContextRailResize: input.onStartContextRailResize,
      })} />
    ),
    rightPane: (
      <SessionPaneErrorBoundary>
        <SessionContextPane
          taskTitle={input.session.taskTitle}
          isHeaderExpanded={input.isHeaderExpanded}
          activeContextPaneTab={input.activeContextPaneTab}
          availableContextPaneTabs={input.availableContextPaneTabs}
          contextPaneProjection={input.contextPaneProjection}
          latestCommandView={input.latestCommandView}
          runningDetailsEntries={input.runningDetailsEntries}
          liveRunReasoningText={input.liveRunReasoningText}
          backgroundTasks={input.backgroundTasks}
          companionGroupMonitorEntries={input.companionGroupMonitorEntries}
          selectedSessionLiveRunErrorMessage={input.liveRunErrorMessage}
          isSelectedSessionRunning={input.isRunning}
          isCopilotSession={input.isCopilotSession}
          selectedCopilotRemainingPercentLabel={input.selectedCopilotRemainingPercentLabel}
          selectedCopilotRemainingRequestsLabel={input.selectedCopilotRemainingRequestsLabel}
          selectedCopilotQuotaResetLabel={input.selectedCopilotQuotaResetLabel}
          selectedSessionContextTelemetry={input.selectedSessionContextTelemetry}
          selectedSessionContextTelemetryProjection={input.selectedSessionContextTelemetryProjection}
          contextEmptyText="context usage はまだありません。"
          onToggleHeaderExpanded={input.onToggleContextPaneHeaderExpanded}
          onCycleContextPaneTab={input.onCycleContextPaneTab}
          onOpenCompanionReview={input.onOpenCompanionReview}
        />
      </SessionPaneErrorBoundary>
    ),
    modals: (
      <ChatSessionModals {...input}>
        {input.toastMessage ? (
          <div className={`companion-session-toast ${input.toastTone}`}>
            {input.toastMessage}
          </div>
        ) : null}
      </ChatSessionModals>
    ),
  };
}
